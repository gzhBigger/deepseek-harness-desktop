/**
 * The market's adapters: the two places where our own code meets the outside world.
 *
 * Everything above this file is pure and injected (`market-catalog.ts`, `market-install.ts`); this is
 * where a real `fetch` and a real child process appear, and where the profile's `package.json` is
 * actually read and written. Keeping that boundary in one small file is what makes the rest testable
 * without a network, pnpm or a profile.
 *
 * The child process is deliberately **not** launched through a shell: `node.exe <pnpm.cjs> <args>`
 * with `shell: false` means no `cmd.exe`, so no console window and no path-quoting hazard — and now
 * that a real console-subsystem node ships with the runtime, the grandchildren keep inheriting the
 * invisible console instead of allocating a new one.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { packumentUrl, searchMarketPackages, type MarketSearchResult } from './market-catalog.ts'
import { countByCategory, fetchCatalog, filterByCategory, searchCatalog, sortCatalog, type Catalog, type CatalogSort } from './market-catalog-source.ts'
import { indexTitle, parseIndexCatalog } from './market-index-source.ts'
import {
  COMMUNITY_SOURCE,
  COMMUNITY_SOURCE_ID,
  allSources,
  emptyStoredSources,
  normalizeSourceUrl,
  readStoredSources,
  sourceCachePath,
  sourceFallbackTitle,
  sourceId,
  writeStoredSources,
  type MarketSource,
  type StoredMarketSources,
} from './market-sources.ts'
import { inspectGithubPlugin } from './market-github.ts'
import type { MarketProgressEvent, MarketSearchRequest } from './market-ipc.ts'
import { readPluginReadme, type ReadmeFailure, type ReadmeRequest, type ReadmeResult } from './market-readme.ts'
import { appendMarketLog, marketLogPath, readMarketLog, type MarketLogEntry } from './market-log.ts'
import { diagnoseConflicts, readConflictWorld, type ConflictFinding, type StoreFacts } from './market-conflict.ts'
import {
  describeProgress,
  runMarketAction,
  resolveMarketRuntime,
  type MarketAction,
  type MarketActionResult,
  type MarketInstallOptions,
  type ProfileManifest,
} from './market-install.ts'

/** Defaults that keep one slow registry from freezing the window. */
export const FETCH_TIMEOUT_MS = 20_000
/** pnpm can legitimately take minutes on a cold store; the action UI stays cancellable. */
export const PNPM_TIMEOUT_MS = 15 * 60_000
/** Registry requests must identify themselves; npm blocks anonymous-looking bulk traffic. */
export const USER_AGENT = 'dsh-desktop-market/1.0 (+https://github.com/gzhBigger/deepseek-harness-desktop)'
/** How long a parsed source stays fresh in memory/on disk. */
export const CATALOG_TTL_MS = 10 * 60 * 1000

/** A JSON GET that fails loudly instead of returning `undefined` on an HTTP error. */
export type JsonFetcher = (url: string) => Promise<unknown>

/** 进度回调：每次 pnpm 输出被翻译成一句人话就调一次。 */
export type ProgressSink = (event: MarketProgressEvent) => void

/**
 * Fetch JSON with a timeout and an explicit failure for non-2xx.
 *
 * @param url - Registry URL.
 * @param options - Timeout, identity, and an injectable `fetch` for tests.
 */
export async function fetchJson(
  url: string,
  options: { readonly timeoutMs?: number; readonly fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await doFetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: controller.signal })
    if (!response.ok) throw new Error(`registry ${String(response.status)} ${response.statusText}`.trim())
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** What one pnpm run produced. */
export interface PnpmRunResult {
  readonly code: number | null
  readonly output: string
}

/**
 * Run pnpm's JavaScript entry on a node executable and collect its output.
 *
 * stdout and stderr are merged on purpose: pnpm reports failures on both, and a diagnostics pane that
 * shows only half of the story is worse than none. `shell: false` keeps `cmd.exe` (and therefore any
 * console window) out of the picture entirely.
 *
 * @param options - Executables, working directory, args and timeout.
 */
export function runPnpm(
  options: {
    readonly nodeExecutable: string
    readonly pnpmEntry: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly environment: NodeJS.ProcessEnv
    readonly timeoutMs?: number
    readonly appBinary?: boolean
    /** 每读到一行就回调（进度条用）。行尾的 `\r` 已去掉，空行不回调。 */
    readonly onLine?: (line: string) => void
  },
): Promise<PnpmRunResult> {
  return new Promise(resolve => {
    const child = spawn(options.nodeExecutable, [options.pnpmEntry, ...options.args], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let pending = ''
    const emitLines = (text: string): void => {
      pending += text
      const parts = pending.split(/\r?\n/u)
      pending = parts.pop() ?? ''
      for (const line of parts) {
        const trimmed = line.trim()
        if (trimmed !== '') options.onLine?.(trimmed)
      }
    }
    const append = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      output += text
      // Keep the tail bounded: a pathological install can print megabytes, and the UI shows the end.
      if (output.length > 256 * 1024) output = output.slice(-192 * 1024)
      if (options.onLine !== undefined) emitLines(text)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => {
      append(Buffer.from(`\n[market] 超时 ${String(options.timeoutMs ?? PNPM_TIMEOUT_MS)} ms，已终止 pnpm\n`))
      child.kill()
    }, options.timeoutMs ?? PNPM_TIMEOUT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: null, output: `${output}\n[market] ${error.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (options.onLine !== undefined && pending.trim() !== '') options.onLine(pending.trim())
      resolve({ code, output })
    })
  })
}

/** Read the profile manifest, tolerating a missing or broken file. */
export function readProfileManifest(profileDir: string): ProfileManifest {
  const path = join(profileDir, 'package.json')
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed as ProfileManifest : {}
  } catch {
    return {}
  }
}

/**
 * Write the profile manifest atomically.
 *
 * The harness reads this file at boot: a truncated write (crash, power loss) would leave a profile
 * that cannot start, so the new content lands under a temporary name and is renamed into place.
 *
 * @param profileDir - The profile directory.
 * @param manifest - Manifest to persist.
 */
export function writeProfileManifest(profileDir: string, manifest: ProfileManifest): void {
  const path = join(profileDir, 'package.json')
  const temporary = `${path}.market.tmp`
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/** Everything the market window needs from the shell. */
export interface MarketServiceOptions {
  /** Profile whose `package.json`/`node_modules` actions apply to. */
  readonly profileDir: string
  /** Prepared runtime root (`resources/…/dsh`), for the bundled node and pnpm. */
  readonly runtimeRoot: string
  /** The app binary, used only when the runtime has no bundled node. */
  readonly appExecutable: string
  /** Injected for tests. */
  readonly fetchJsonImpl?: JsonFetcher
  /** Injected for tests: README 与图片的抓取。 */
  readonly readmeFetchImpl?: typeof fetch
  /** Injected for tests. */
  readonly runPnpmImpl?: MarketInstallOptions['runPnpm']
  /** Progress/log sink (the window's activity line). */
  readonly log?: (line: string) => void
  /** Directory for the action log (the shell's log directory); omit to keep no file log. */
  readonly logDir?: string
  /** Where source preferences and their parsed caches live; defaults under the profile. */
  readonly stateDir?: string
}

/**
 * 已安装插件的**实际**版本：读 profile 里 `node_modules/<name>/package.json`。
 *
 * 不解析 `dependencies` 的 spec：那里可能是 `^1.2.0`、`github:owner/repo` 或本地路径，用户要知道的
 * 是「我装的是哪个版本」，只有落盘的 manifest 说得准。读不到就当未知（新装未落盘、包被删了）。
 */
function installedVersion(profileDir: string, name: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * The market, as the window sees it: search, install, update, uninstall.
 *
 * A thin coordinator on purpose — each layer below it owns one decision (what may be offered; what
 * pnpm is asked to do; how the profile changes), so this class only has to sequence them and turn
 * "the runtime is not where we expected" into an actionable result rather than a crash.
 */
export class MarketService {
  readonly #options: MarketServiceOptions
  /**
   * Parsed catalogs by source id, kept in memory for a short while.
   *
   * A hit is returned before any network request, so reopening the window or switching back to a
   * source shows its previous list instantly; an expired hit is returned as `stale` and refreshed in
   * the background by the window.
   */
  #catalogCache = new Map<string, { readonly at: number; readonly catalog: Catalog }>()
  /** Sources with a stale-while-revalidate fetch in flight, so one slow publisher is fetched once. */
  #refreshing = new Set<string>()
  /** Source preferences, loaded lazily from `stateDir`. */
  #sources: StoredMarketSources | undefined
  /** README 预览缓存：同一次会话里反复打开同一个插件不该重复抓取。 */
  #readmeCache = new Map<string, { readonly at: number; readonly value: ReadmeResult | ReadmeFailure }>()

  constructor(options: MarketServiceOptions) {
    this.#options = options
  }

  /** Where the actions run, for display and for error messages. */
  get profileDir(): string {
    return this.#options.profileDir
  }

  /**
   * Search one page of the catalog.
   *
   * The registry is walked (and its noise filtered) by `searchMarketPackages`; this only forwards the
   * window's page/filter choices, because the window owns what the user asked for. The whole thing is
   * bounded by a deadline: an interactive search must always settle, or the window stays disabled and
   * the search looks broken — which is exactly how it was reported.
   */
  search(request: MarketSearchRequest): Promise<MarketSearchResult> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    return withDeadline(searchMarketPackages(request.query, {
      getJson,
      from: request.from ?? 0,
      limit: request.pageSize ?? 20,
      // Interactive budget: 30 candidates per registry page and at most two pages. A search is a
      // fallback path (the catalog is the main one), and every extra candidate is another request the
      // user waits for with the button disabled.
      candidates: 30,
      fillPages: 2,
      sort: request.sort ?? 'relevance',
      // `exactOptionalPropertyTypes` is on, so an absent filter must be an absent key.
      ...(request.clientOnly === true ? { filter: { clientOnly: true } } : {}),
    }), SEARCH_DEADLINE_MS, 'registry 查询超时（网络慢，或 registry 不可达）')
  }

  /** Where source preferences and caches live. */
  get stateDir(): string {
    return this.#options.stateDir ?? join(this.#options.profileDir, '.market')
  }

  /** Current sources, built-in first, and which one the window is showing. */
  sources(): { readonly items: readonly MarketSource[]; readonly selected: string } {
    const state = this.#sourceState()
    return { items: allSources(state), selected: state.selected }
  }

  /**
   * Add one official index after reading and validating it.
   *
   * The window cannot validate the index itself (no network), and saving a URL before its first fetch
   * would make a typo look exactly like an empty market. Fetching here means "add" either succeeds
   * with a usable source or fails with the publisher's actual error.
   */
  async addSource(input: string): Promise<{
    readonly ok: boolean
    readonly reason?: string
    readonly items?: readonly MarketSource[]
    readonly selected?: string
  }> {
    let url: string
    try {
      url = normalizeSourceUrl(input)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    const state = this.#sourceState()
    const existing = state.custom.find(source => source.url === url)
    if (existing !== undefined) {
      this.#select(existing.id)
      return { ok: true, ...this.sources() }
    }
    const getJson = this.#options.fetchJsonImpl ?? (target => fetchJson(target))
    try {
      const document = await getJson(url)
      const catalog = parseIndexCatalog(document, url)
      const id = sourceId(url)
      const custom = [
        ...state.custom,
        {
          id,
          url,
          title: indexTitle(document, sourceFallbackTitle(url)),
          addedAt: new Date().toISOString(),
        },
      ]
      this.#sources = { custom, selected: id }
      this.#writeSources()
      this.#writeCache(id, catalog)
      this.#catalogCache.set(id, { at: Date.now(), catalog })
      return { ok: true, ...this.sources() }
    } catch (error) {
      return { ok: false, reason: `读取索引失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** Remove one custom source. The built-in community catalog cannot be removed. */
  removeSource(id: string): { readonly ok: boolean; readonly reason?: string; readonly items?: readonly MarketSource[]; readonly selected?: string } {
    if (id === COMMUNITY_SOURCE_ID) return { ok: false, reason: '社区目录是内置市场，不能移除' }
    const state = this.#sourceState()
    if (!state.custom.some(source => source.id === id)) return { ok: false, reason: '没有这个市场源' }
    const custom = state.custom.filter(source => source.id !== id)
    const selected = state.selected === id ? COMMUNITY_SOURCE_ID : state.selected
    this.#sources = { custom, selected }
    this.#writeSources()
    try {
      rmSync(sourceCachePath(this.stateDir, id), { force: true })
    } catch {
      // A cache we cannot delete only wastes space; the source itself is gone.
    }
    this.#catalogCache.delete(id)
    return { ok: true, ...this.sources() }
  }

  /**
   * The browsable catalog: a cached source is returned before the network, so opening the window is
   * immediate after the first successful load. `refresh` bypasses both caches on purpose.
   */
  async browse(request: {
    readonly source?: string
    readonly query?: string
    readonly category?: string
    readonly sort?: CatalogSort
    readonly page?: number
    readonly pageSize?: number
    /** Ignore cached copies and refetch (the window's "reload" button). */
    readonly refresh?: boolean
  } = {}): Promise<{
    readonly source: { readonly id: string; readonly title: string; readonly kind: 'community' | 'index' }
    readonly stale?: boolean
    readonly warning?: string
    readonly categories: readonly { readonly id: string; readonly en?: string; readonly zh?: string }[]
    /** Entries per category over the whole catalog (a chip's number must not depend on the page). */
    readonly categoryCounts: Readonly<Record<string, number>>
    readonly updated?: string
    readonly total: number
    readonly page: number
    readonly pageSize: number
    readonly entries: readonly unknown[]
    readonly installed: readonly string[]
  }> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    const source = this.#sourceById(request.source)
    this.#select(source.id)
    const loaded = await this.#catalog(source, getJson, request.refresh === true)
    const catalog = loaded.catalog
    const filtered = searchCatalog(filterByCategory(catalog.entries, request.category), request.query ?? '')
    const sorted = sortCatalog(filtered, request.sort ?? 'stars')
    const pageSize = Math.min(120, Math.max(1, Math.trunc(request.pageSize ?? 40)))
    const page = Math.max(0, Math.trunc(request.page ?? 0))
    const start = page * pageSize
    return {
      source: { id: source.id, title: source.title, kind: source.kind },
      ...(loaded.stale ? { stale: true } : {}),
      ...(loaded.warning === undefined ? {} : { warning: loaded.warning }),
      categories: catalog.categories,
      categoryCounts: countByCategory(catalog.entries),
      ...(catalog.updated === undefined ? {} : { updated: catalog.updated }),
      total: sorted.length,
      page,
      pageSize,
      entries: sorted.slice(start, start + pageSize),
      installed: this.installed().map(entry => entry.name),
    }
  }

  /** Fetch one source, falling back to its disk cache when the publisher is unreachable. */
  async #catalog(source: MarketSource, getJson: JsonFetcher, refresh: boolean): Promise<{ catalog: Catalog; stale: boolean; warning?: string }> {
    const memory = this.#catalogCache.get(source.id)
    if (!refresh && memory !== undefined) {
      const stale = Date.now() - memory.at >= CATALOG_TTL_MS
      if (stale) void this.#refreshSource(source, getJson)
      return { catalog: memory.catalog, stale }
    }
    if (!refresh) {
      const disk = this.#readCache(source.id)
      if (disk !== undefined) {
        this.#catalogCache.set(source.id, disk)
        const stale = Date.now() - disk.at >= CATALOG_TTL_MS
        if (stale) void this.#refreshSource(source, getJson)
        return { catalog: disk.catalog, stale }
      }
    }
    try {
      const catalog = await this.#fetchSource(source, getJson)
      this.#catalogCache.set(source.id, { at: Date.now(), catalog })
      this.#writeCache(source.id, catalog)
      return { catalog, stale: false }
    } catch (error) {
      const fallback = this.#readCache(source.id)
      if (fallback !== undefined) {
        this.#catalogCache.set(source.id, fallback)
        const reason = error instanceof Error ? error.message : String(error)
        this.#options.log?.(`插件市场：刷新 ${source.title} 失败，使用缓存（${reason}）`)
        return { catalog: fallback.catalog, stale: true, warning: `刷新失败，显示的是缓存：${reason}` }
      }
      throw error
    }
  }

  async #fetchSource(source: MarketSource, getJson: JsonFetcher): Promise<Catalog> {
    return source.kind === 'community'
      ? await fetchCatalog(getJson)
      : parseIndexCatalog(await getJson(source.url), source.url)
  }

  /** Refresh one stale source in the background; failures leave the cached copy in place. */
  async #refreshSource(source: MarketSource, getJson: JsonFetcher): Promise<void> {
    if (this.#refreshing.has(source.id)) return
    this.#refreshing.add(source.id)
    try {
      const catalog = await this.#fetchSource(source, getJson)
      // The user may remove the source while its refresh is in flight; do not resurrect its cache.
      if (!this.#sourceState().custom.some(item => item.id === source.id)) return
      this.#catalogCache.set(source.id, { at: Date.now(), catalog })
      this.#writeCache(source.id, catalog)
    } catch (error) {
      this.#options.log?.(`插件市场：后台刷新 ${source.title} 失败（${error instanceof Error ? error.message : String(error)}）`)
    } finally {
      this.#refreshing.delete(source.id)
    }
  }

  #sourceState(): StoredMarketSources {
    if (this.#sources === undefined) {
      try {
        this.#sources = readStoredSources(this.#sourcesFile())
      } catch {
        this.#sources = emptyStoredSources()
      }
      // A custom source that vanished from the file while its id was still selected is not a source.
      if (this.#sources.selected !== COMMUNITY_SOURCE_ID && !this.#sources.custom.some(source => source.id === this.#sources?.selected)) {
        this.#sources = { ...this.#sources, selected: COMMUNITY_SOURCE_ID }
      }
    }
    return this.#sources
  }

  #sourceById(id: string | undefined): MarketSource {
    const state = this.#sourceState()
    return allSources(state).find(source => source.id === id) ?? COMMUNITY_SOURCE
  }

  #select(id: string): void {
    const state = this.#sourceState()
    if (state.selected === id) return
    if (id !== COMMUNITY_SOURCE_ID && !state.custom.some(source => source.id === id)) return
    this.#sources = { ...state, selected: id }
    this.#writeSources()
  }

  #sourcesFile(): string {
    return join(this.stateDir, 'sources.json')
  }

  #writeSources(): void {
    if (this.#sources === undefined) return
    try {
      writeStoredSources(this.#sourcesFile(), this.#sources)
    } catch (error) {
      this.#options.log?.(`插件市场：保存市场源失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  #readCache(id: string): { readonly at: number; readonly catalog: Catalog } | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(sourceCachePath(this.stateDir, id), 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return undefined
      const record = parsed as Record<string, unknown>
      const at = typeof record.at === 'number' ? record.at : 0
      const catalog = record.catalog
      if (catalog === null || typeof catalog !== 'object' || !Array.isArray((catalog as { entries?: unknown }).entries)) return undefined
      return { at, catalog: catalog as Catalog }
    } catch {
      return undefined
    }
  }

  #writeCache(id: string, catalog: Catalog): void {
    const path = sourceCachePath(this.stateDir, id)
    try {
      mkdirSync(join(this.stateDir, 'market-cache'), { recursive: true })
      const temporary = `${path}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ at: Date.now(), catalog })}\n`, 'utf8')
      renameSync(temporary, path)
    } catch (error) {
      this.#options.log?.(`插件市场：写缓存失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  /** Install an exact version. */
  install(name: string, version: string, onProgress?: ProgressSink): Promise<MarketActionResult> {
    return this.#act('install', name, version, undefined, onProgress)
  }

  /** Install an exact pnpm spec (official Git indexes carry a commit and optional subdirectory). */
  installSpec(name: string, spec: string, onProgress?: ProgressSink): Promise<MarketActionResult> {
    return this.#act('install', name, undefined, spec, onProgress)
  }

  /** Move a plugin to an exact version. */
  update(name: string, version: string, onProgress?: ProgressSink): Promise<MarketActionResult> {
    return this.#act('update', name, version, undefined, onProgress)
  }

  /** Remove a plugin and unregister its bundle. */
  uninstall(name: string, onProgress?: ProgressSink): Promise<MarketActionResult> {
    return this.#act('uninstall', name, undefined, undefined, onProgress)
  }

  /**
   * Install a plugin straight from GitHub — the case where it is in neither the catalog's npm mapping
   * nor the registry.
   *
   * The repository's own manifest is read and vetted **before** anything touches the profile. That
   * ordering is the point: a package that declares no `dsh` cannot be registered as a bundle, and
   * installing it first only to remove it afterwards would change the profile in between. The name
   * that gets registered is the one the repository declares (`portable-dsh-multi-agent`, not the
   * catalog's `portable-dsh-multi-agent-plugin`), because that is the name the harness looks up.
   *
   * @param input - `owner/repo`, a repository URL, or a release tarball URL (optionally with a ref).
   */
  async installFromGithub(input: string, onProgress?: ProgressSink): Promise<MarketActionResult> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    const inspected = await inspectGithubPlugin(getJson, input)
    if ('reason' in inspected) {
      return {
        ok: false,
        action: 'install',
        name: input,
        spec: input,
        code: null,
        output: inspected.reason,
        failure: {
          kind: inspected.kind,
          message: inspected.reason,
          hint: '示例：owner/repo、https://github.com/owner/repo，或仓库发布页里的 .tgz 地址',
        },
        bundleRegistered: false,
      }
    }
    const { source, name, spec, scripts } = inspected.plugin
    this.#options.log?.(`从 GitHub 安装 ${source.owner}/${source.repo} → ${name}${scripts.length === 0 ? '' : `（会执行安装脚本：${scripts.join('、')}）`}`)
    return this.#act('install', name, undefined, spec, onProgress)
  }

  /** Read a GitHub source without installing it: what the window shows before the user commits. */
  async inspectGithub(input: string): Promise<{ readonly ok: boolean; readonly name?: string; readonly version?: string; readonly spec?: string; readonly scripts?: readonly string[]; readonly reason?: string }> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    const inspected = await inspectGithubPlugin(getJson, input)
    if ('reason' in inspected) return { ok: false, reason: inspected.reason }
    return {
      ok: true,
      name: inspected.plugin.name,
      ...(inspected.plugin.version === undefined ? {} : { version: inspected.plugin.version }),
      spec: inspected.plugin.spec,
      scripts: inspected.plugin.scripts,
    }
  }

  /** Plugin names the profile currently declares, in the window's list order. */
  installed(): readonly { readonly name: string; readonly spec: string; readonly version?: string }[] {
    const dependencies = readProfileManifest(this.#options.profileDir).dependencies ?? {}
    return Object.entries(dependencies).map(([name, spec]) => {
      const version = installedVersion(this.#options.profileDir, name)
      // `exactOptionalPropertyTypes` 下不能把 undefined 写进可选字段。
      return version === undefined ? { name, spec } : { name, spec, version }
    })
  }

  /**
   * 一个插件的 README：抓取、解析成节点树、图片内联，交给预览对话框渲染。
   *
   * 结果按 `名字@版本 + 来源` 缓存 10 分钟：同一插件反复打开、以及列表与已安装视图各点一次，
   * 都不该重复打 GitHub/npm。
   */
  async readme(request: ReadmeRequest): Promise<ReadmeResult | ReadmeFailure> {
    const key = `${request.name}@${request.version ?? ''}|${request.url ?? ''}|${request.spec ?? ''}`
    const cached = this.#readmeCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < 10 * 60 * 1000) return cached.value
    const value = await readPluginReadme(request, {
      ...(this.#options.readmeFetchImpl === undefined ? {} : { fetchImpl: this.#options.readmeFetchImpl }),
    })
    this.#readmeCache.set(key, { at: Date.now(), value })
    return value
  }

  async #act(action: MarketAction, name: string, version?: string, spec?: string, onProgress?: ProgressSink): Promise<MarketActionResult> {
    const { profileDir, runtimeRoot, appExecutable } = this.#options
    const started = Date.now()
    const tick = (phase: MarketProgressEvent['phase'], detail: string): void => {
      onProgress?.({ action, name, phase, detail, elapsedMs: Date.now() - started })
    }
    tick('starting', action === "uninstall" ? `正在卸载 ${name}…` : `正在准备 pnpm（${name}）…`)
    // pnpm runs with `cwd` = the profile, and a spawn whose `cwd` does not exist fails with ENOENT
    // **naming the executable** — a message that reads like "the runtime is missing" while the real
    // problem is an empty profile directory (fresh `DSH_HOME`, or a first run before seeding). Creating
    // it first costs nothing and removes the whole class of confusion.
    try {
      mkdirSync(profileDir, { recursive: true })
    } catch {
      // A profile we cannot create will fail below with pnpm's own error, which is the useful one.
    }
    const runtime = resolveMarketRuntime(runtimeRoot, appExecutable)
    if (runtime === undefined) {
      return {
        ok: false,
        action,
        name,
        spec: name,
        code: null,
        output: `随包运行时里找不到 pnpm 的入口：${join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')}`,
        failure: { kind: 'unknown', message: '随包运行时不可用', hint: '重新安装 DSH Desktop，或在诊断信息里查看运行时路径' },
        bundleRegistered: false,
      }
    }
    this.#options.log?.(`${action} ${spec ?? name}${version === undefined || spec !== undefined ? '' : `@${version}`}（${runtime.appBinary ? '应用二进制' : '随包 node'}）`)
    const run = this.#options.runPnpmImpl ?? ((args, environment, onLine) => runPnpm({
      nodeExecutable: runtime.nodeExecutable,
      pnpmEntry: runtime.pnpmEntry,
      args,
      cwd: profileDir,
      environment,
      appBinary: runtime.appBinary,
      ...(onLine === undefined ? {} : { onLine }),
    }))
    const result = await runMarketAction(action, name, {
      profileDir,
      nodeExecutable: runtime.nodeExecutable,
      pnpmEntry: runtime.pnpmEntry,
      appBinary: runtime.appBinary,
      readManifest: () => readProfileManifest(profileDir),
      writeManifest: manifest => { writeProfileManifest(profileDir, manifest) },
      runPnpm: run,
      onOutput: line => {
        const parsed = describeProgress(line)
        if (parsed !== undefined) tick(parsed.phase, parsed.detail)
      },
    }, version, spec)
    tick(result.ok ? 'done' : 'failed', result.ok
      ? `完成，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`
      : (result.failure?.message ?? "安装失败"))
    // Recorded even when it succeeded: "it worked yesterday" is only checkable if successes are logged.
    this.#record({
      at: new Date().toISOString(),
      action,
      name,
      spec: result.spec,
      ok: result.ok,
      code: result.code,
      ms: Date.now() - started,
      ...(result.failure === undefined ? {} : { kind: result.failure.kind, message: result.failure.message }),
      ...(result.output === '' ? {} : { output: result.output }),
    })
    return result
  }

  /** The tail of the action log, newest last (the window shows this). */
  log(limit = 50): readonly MarketLogEntry[] {
    const dir = this.#options.logDir
    return dir === undefined ? [] : readMarketLog(dir, limit)
  }

  /** Where the action log lives, for the window to show (empty when file logging is off). */
  logPath(): string {
    const dir = this.#options.logDir
    return dir === undefined ? '' : marketLogPath(dir)
  }

  /**
   * Compare every installed plugin against the registry.
   *
   * Only registry specs can be compared: a `link:`/`file:` dependency is the user own checkout and a
   * `github:` one carries no version at all. Those are reported as "cannot compare" rather than
   * silently looking up to date — a wrong "up to date" is worse than an honest "unknown".
   */
  async checkUpdates(): Promise<readonly MarketUpdateStatus[]> {
    const getJson = this.#options.fetchJsonImpl ?? (url => fetchJson(url))
    // One plugin per registry request; do them together so the installed view does not spend
    // N × the fetch timeout waiting for the slowest registry before it can render anything.
    return await Promise.all(this.installed().map(async (entry): Promise<MarketUpdateStatus> => {
      const source = specSource(entry.spec)
      if (source !== 'registry') {
        return { name: entry.name, current: entry.spec, hasUpdate: false, source, reason: '不是 registry 版本，无法比较' }
      }
      const current = stripRangePrefix(entry.spec)
      try {
        const document = await getJson(packumentUrl(entry.name))
        const latest = latestVersion(document)
        return {
          name: entry.name,
          current,
          ...(latest === undefined ? {} : { latest }),
          hasUpdate: latest !== undefined && compareVersions(latest, current) > 0,
          source: 'registry',
        }
      } catch (error) {
        return { name: entry.name, current, hasUpdate: false, source: 'registry', reason: error instanceof Error ? error.message : String(error) }
      }
    }))
  }

  /**
   * Diagnose this profile: contradictions provable from local files.
   *
   * The store comparison is the interesting one — it is the same mismatch the shell relinks at startup,
   * so seeing it here means the relink did not take effect (or the app has not been restarted since).
   */
  diagnose(): readonly ConflictFinding[] {
    const store = readStoreFacts(this.#options.runtimeRoot, this.#options.profileDir)
    return diagnoseConflicts(readConflictWorld(this.#options.profileDir, { store }))
  }
  /** Append one entry to the action log, if file logging is configured. */
  #record(entry: MarketLogEntry): void {
    const dir = this.#options.logDir
    if (dir === undefined) return
    appendMarketLog(dir, entry)
  }
}
/** How one installed plugin compares to the registry. */
export interface MarketUpdateStatus {
  readonly name: string
  /** What the profile declares (`^1.2.3`, a version, or a link/git spec). */
  readonly current: string
  /** Latest version the registry reports, when it could be determined. */
  readonly latest?: string
  readonly hasUpdate: boolean
  /** `registry` can be compared; anything else cannot. */
  readonly source: 'registry' | 'other'
  /** Why it could not be compared, or what went wrong while checking. */
  readonly reason?: string
}

/**
 * Classify a dependency spec by whether a registry version can be compared against it.
 *
 * A registry spec is a version or a version range (`1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`).
 * `link:`/`file:` point at a checkout and `github:`/`git+…` at a revision: neither has a "latest"
 * to compare with, and pretending they are up to date would be a lie the user cannot see through.
 */
export function specSource(spec: string): 'registry' | 'other' {
  const trimmed = spec.trim()
  if (trimmed === '') return 'other'
  if (/^(link|file|portal|workspace|git|git\+|https?):/iu.test(trimmed)) return 'other'
  const rest = stripRangePrefix(trimmed)
  const first = rest.slice(0, 1)
  return first >= '0' && first <= '9' ? 'registry' : 'other'
}

/**
 * Drop the range decoration a version spec may carry, so the first digit is where a version starts.
 *
 * Written as a scan rather than a character-class regex on purpose: this file is edited by scripts as
 * often as by hand, and a `\\d`/`\\s` that survives one escaping layer too many silently turns a
 * working classifier into "everything is incomparable".
 *
 * @param spec - A dependency spec such as `^1.2.3`, `>=2.0.0` or `v1.0.0`.
 * @returns The spec without leading `^ ~ > < = v` and spaces.
 */
export function stripRangePrefix(spec: string): string {
  const decoration = '^~><=vV '
  let index = 0
  while (index < spec.length && decoration.includes(spec.slice(index, index + 1))) index += 1
  return spec.slice(index)
}

/**
 * Compare two versions the way a user reads them: numerically, release over prerelease.
 *
 * Deliberately small — this only decides whether to *offer* an update, and a wrong "yes" costs one
 * click, while a wrong "no" is the failure mode worth avoiding. Build metadata is ignored (as in
 * semver) and a missing part counts as zero (`1.2` == `1.2.0`).
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core = '', pre = ''] = value.trim().replace(/^v/u, '').split('-', 2)
    const parts = core.split('.').map(part => Number.parseInt(part, 10))
    return { parts: [0, 1, 2].map(index => Number.isFinite(parts[index]) ? (parts[index] as number) : 0), pre }
  }
  const a = parse(left); const b = parse(right)
  for (let index = 0; index < 3; index++) {
    if (a.parts[index] !== b.parts[index]) return (a.parts[index] as number) > (b.parts[index] as number) ? 1 : -1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre.localeCompare(b.pre)
}

/** The version a packument calls latest, if it says so. */
function latestVersion(document: unknown): string | undefined {
  if (document === null || typeof document !== 'object') return undefined
  const latest = (document as { 'dist-tags'?: { latest?: unknown } })[ 'dist-tags' ]?.latest
  return typeof latest === 'string' && latest !== '' ? latest : undefined
}
/**
 * How long an interactive registry search may take before it is reported as a failure.
 *
 * Bounded on purpose: the window disables its button while a search is in flight, so a search that
 * never settles leaves the whole view stuck. A deadline turns that into an ordinary, explainable
 * failure the user can retry.
 */
const SEARCH_DEADLINE_MS = 25_000

/** Resolve with `work`, or reject with `message` once `ms` have passed. */
function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message)) }, ms)
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/**
 * Read the two store facts a mismatch needs, each best-effort.
 *
 * `modulesMajor` comes from the profile's `node_modules/.modules.yaml` (pnpm writes the store it used);
 * `pnpmMajor` from the bundled pnpm's own version. Either missing means "cannot tell", and the
 * diagnosis must then stay silent rather than guess.
 */
function readStoreFacts(runtimeRoot: string, profileDir: string): StoreFacts {
  let modulesMajor: string | undefined
  try {
    const match = /store\/v(\d+)/u.exec(readFileSync(join(profileDir, 'node_modules', '.modules.yaml'), 'utf8'))
    if (match?.[1] !== undefined) modulesMajor = match[1]
  } catch {
    // No modules file yet: nothing to compare against.
  }
  let pnpmMajor: string | undefined
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(runtimeRoot, 'node_modules', 'pnpm', 'package.json'), 'utf8'))
    const version = (manifest as { version?: unknown }).version
    if (typeof version === 'string' && version !== '') pnpmMajor = version.split('.')[0]
  } catch {
    // Bundled pnpm's version unreadable: skip the comparison.
  }
  return {
    ...(modulesMajor === undefined ? {} : { modulesMajor }),
    ...(pnpmMajor === undefined ? {} : { pnpmMajor }),
  }
}
