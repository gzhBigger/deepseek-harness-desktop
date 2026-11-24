/**
 * The adapters' tests. The interesting ones are the two that could silently rot: `fetchJson`'s
 * non-2xx contract (a registry 404 must not look like an empty catalog) and `runPnpm` against the
 * **real** bundled runtime — the path the shell proved by hand, re-proved here on every run.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  MarketService,
  fetchJson,
  readProfileManifest,
  runPnpm,
  specSource,
  compareVersions,
  writeProfileManifest,
} from './market-service.ts'
import { appendMarketLog, readMarketLog } from './market-log.ts'

/** A `fetch` double: fixed status/body, and it records the request. */
function fakeFetch(status: number, body: unknown, statusText = '') {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const impl = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: () => Promise.resolve(body),
    } as Response)
  }
  return { calls, impl: impl as unknown as typeof fetch }
}

test('fetchJson returns parsed JSON and identifies itself to the registry', async () => {
  const fetcher = fakeFetch(200, { objects: [] })
  assert.deepEqual(await fetchJson('https://registry.npmjs.org/-/v1/search?text=x', { fetchImpl: fetcher.impl }), { objects: [] })
  assert.match(fetcher.calls[0]?.headers['user-agent'] ?? '', /dsh-desktop-market/u)
})

test('an HTTP error is an error, never an empty result', async () => {
  const fetcher = fakeFetch(429, {}, 'Too Many Requests')
  await assert.rejects(fetchJson('https://registry.npmjs.org/x', { fetchImpl: fetcher.impl }), /registry 429 Too Many Requests/u)
})

test('a request that outlives its timeout is aborted', async () => {
  const hanging = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
  })) as unknown as typeof fetch
  await assert.rejects(fetchJson('https://registry.npmjs.org/slow', { fetchImpl: hanging, timeoutMs: 30 }), /aborted/u)
})

test('the profile manifest round-trips, and a broken file reads as empty instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-profile-'))
  assert.deepEqual(readProfileManifest(dir), {}, 'no package.json yet')
  writeProfileManifest(dir, { name: 'dsh-profile-dsh-desktop', dependencies: { a: '1' }, dsh: { profile: { bundles: ['a'] } } })
  assert.deepEqual(readProfileManifest(dir).dependencies, { a: '1' })
  assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /\n$/u, 'trailing newline, like every other file we write')
  writeFileSync(join(dir, 'package.json'), '{ not json', 'utf8')
  assert.deepEqual(readProfileManifest(dir), {})
})

test('a runtime without pnpm reports an actionable failure instead of throwing', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-market-profile-'))
  const service = new MarketService({ profileDir, runtimeRoot: join(profileDir, 'no-runtime'), appExecutable: 'C:\\app\\DSH Desktop.exe' })
  const result = await service.install('dsh-git-panel', '0.1.20')
  assert.equal(result.ok, false)
  assert.equal(result.failure?.message, '随包运行时不可用')
  assert.match(result.output, /pnpm\.cjs/u)
  assert.match(result.failure?.hint ?? '', /重新安装/u)
})

test('安装过程把 pnpm 的进度翻译成人话推给窗口，并以 done 收尾', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'market-progress-'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'probe-profile', private: true }))
  // 自造一个「看起来可用」的运行时：`#act` 在起进程前要求 pnpm.cjs 存在，而这条测试注入的是假
  // runner，所以文件只需要存在。用仓库里的真实运行时会让测试在没跑过 prepare-runtime 的 CI 上失败
  // （2026-11-02 的 CI 正是这样红的）。
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'market-runtime-'))
  mkdirSync(join(runtimeRoot, 'node_modules', 'pnpm', 'bin'), { recursive: true })
  writeFileSync(join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '')
  mkdirSync(join(runtimeRoot, 'bin'), { recursive: true })
  writeFileSync(join(runtimeRoot, 'bin', 'node.exe'), '')
  const events: { readonly phase: string; readonly detail: string; readonly elapsedMs: number }[] = []
  const service = new MarketService({
    profileDir,
    runtimeRoot,
    appExecutable: 'x',
    runPnpmImpl: async (_args, _environment, onLine) => {
      onLine?.('Progress: resolved 3, reused 1, downloaded 2, added 0')
      onLine?.('Progress: resolved 3, reused 2, downloaded 1, added 1')
      onLine?.('Done in 1.2s')
      return { code: 0, output: 'Done in 1.2s' }
    },
  })
  const result = await service.install('dsh-progress-probe', '1.0.0', event => events.push(event))
  assert.equal(result.ok, true)
  // 第一帧必须是 starting：pnpm 起来之前有约一秒的空白，用户需要知道"已经在做了"。
  assert.equal(events[0]?.phase, 'starting')
  assert.ok(events.some(event => event.phase === 'download'), '下载阶段应被翻译出来')
  assert.ok(events.some(event => event.phase === 'link'), '链接阶段应被翻译出来')
  assert.equal(events.at(-1)?.phase, 'done')
  assert.ok((events.at(-1)?.elapsedMs ?? -1) >= 0)
  assert.match(events.at(-1)?.detail ?? '', /完成/u)
})
test('installed() lists what the profile declares', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-profile-'))
  writeProfileManifest(dir, { dependencies: { 'dsh-cost-meter': '^1.8.26', '@scope/other': 'link:../x' } })
  const service = new MarketService({ profileDir: dir, runtimeRoot: dir, appExecutable: 'x' })
  assert.deepEqual(service.installed(), [
    { name: 'dsh-cost-meter', spec: '^1.8.26' },
    { name: '@scope/other', spec: 'link:../x' },
  ])
})

/** The prepared runtime in this checkout; skipped on a fresh clone where it has not been built. */
const runtimeRoot = fileURLToPath(new URL('../runtime/dsh', import.meta.url))
const bundledNode = join(runtimeRoot, 'bin', 'node.exe')
const pnpmEntry = join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')

test('the real bundled runtime runs pnpm with no shell and no window', { skip: !existsSyncSafe(bundledNode) ? 'runtime not prepared' : false }, async () => {
  const result = await runPnpm({
    nodeExecutable: bundledNode,
    pnpmEntry,
    args: ['--version'],
    cwd: runtimeRoot,
    environment: marketEnvironment(),
    timeoutMs: 120_000,
  })
  assert.equal(result.code, 0, result.output)
  // pnpm 11 prints a "the pnpm field is ignored" warning on checkout manifests; the version
  // itself is the line this test is about, so drop warning lines before matching.
  const version = result.output.split(/\r?\n/).filter(line => !line.startsWith('[WARN]')).join('\n').trim()
  assert.match(version, /^\d+\.\d+\.\d+/u)
})

test('a node executable that does not exist is reported, not thrown', async () => {
  const result = await runPnpm({
    nodeExecutable: join(runtimeRoot, 'bin', 'definitely-missing.exe'),
    pnpmEntry,
    args: ['--version'],
    cwd: runtimeRoot,
    environment: marketEnvironment(),
    timeoutMs: 30_000,
  })
  assert.equal(result.code, null)
  assert.match(result.output, /ENOENT/u)
})

function existsSyncSafe(path: string): boolean {
  try {
    return readFileSync(path) !== undefined
  } catch {
    return false
  }
}

/** A copy of the environment with our own variables removed, as a fresh child would see it. */
function marketEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_')))
}

// Keep mkdirSync referenced: the temp helpers above create nested paths in some environments.
void mkdirSync

test('the window page request reaches the registry as offset and size', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-market-profile-'))
  const urls: string[] = []
  const service = new MarketService({
    profileDir,
    runtimeRoot: profileDir,
    appExecutable: 'x',
    // A transport double: record what would be fetched, and answer with an empty registry page so the
    // call returns quickly. What matters here is the URL, not the payload.
    fetchJsonImpl: (url: string) => {
      urls.push(url)
      return Promise.resolve({ objects: [] })
    },
  })
  const result = await service.search({ query: 'dsh', from: 40, pageSize: 20, sort: 'name', clientOnly: true })
  assert.equal(result.packages.length, 0)
  // Two different knobs, deliberately: `from` is the registry offset the window asked for, and
  // `size` is how many *candidates* we confirm per registry page (the admitted page size is a
  // separate, smaller number, because most candidates are not plugins).
  assert.match(urls[0] ?? '', /from=40/u)
  assert.match(urls[0] ?? '', /size=\d+/u)
  assert.match(urls[0] ?? '', /text=dsh/u)
})

test('a registry spec is comparable, a checkout or a git revision is not', () => {
  for (const spec of ['1.2.3', '^1.2.3', '~0.11.4', '>=2.0.0', 'v1.0.0']) assert.equal(specSource(spec), 'registry', spec)
  for (const spec of ['link:../x', 'file:./y', 'github:owner/repo', 'git+https://example.invalid/r.git', 'workspace:*', '']) assert.equal(specSource(spec), 'other', spec)
})

test('version comparison reads the way a user reads versions', () => {
  assert.equal(compareVersions('1.2.10', '1.2.3'), 1)
  assert.equal(compareVersions('1.2.3', '1.2.10'), -1)
  assert.equal(compareVersions('1.2.0', '1.2'), 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2.3', '1.2.3-beta.1'), 1, 'a release beats its prerelease')
  assert.equal(compareVersions('1.2.3-beta.1', '1.2.3'), -1)
})

test('the action log round-trips and survives a truncated line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-log-'))
  appendMarketLog(dir, { at: '2026-10-15T00:00:00.000Z', action: 'install', name: 'dsh-cost-meter', spec: 'dsh-cost-meter@1.8.26', ok: true, code: 0, output: 'Done in 2s' })
  appendMarketLog(dir, { at: '2026-10-15T00:01:00.000Z', action: 'install', name: 'nope', spec: 'nope@9.9.9', ok: false, code: 1, kind: 'not-found', message: 'registry 上没有这个包', output: 'ERR_PNPM_FETCH_404' })
  const entries = readMarketLog(dir, 10)
  assert.equal(entries.length, 2)
  assert.equal(entries[1]?.kind, 'not-found')
  assert.match(entries[1]?.output ?? '', /ERR_PNPM_FETCH_404/u)
  // A crash mid-write leaves a partial line; the log must still be readable.
  writeFileSync(join(dir, 'market.log'), '{"at":"2026-10-15T00:02:00.000Z"' + String.fromCharCode(10), { flag: 'a' })
  assert.equal(readMarketLog(dir, 10).length, 2)
})

test('checkUpdates compares registry versions and refuses to guess for checkouts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-profile-'))
  writeProfileManifest(dir, { dependencies: { 'dsh-cost-meter': '^1.8.26', 'dsh-plugin-kit': 'link:D:/x' } })
  const service = new MarketService({
    profileDir: dir,
    runtimeRoot: dir,
    appExecutable: 'x',
    fetchJsonImpl: url => Promise.resolve(url.includes('dsh-cost-meter') ? { 'dist-tags': { latest: '1.9.0' } } : { 'dist-tags': { latest: '1.0.2' } }),
  })
  const statuses = await service.checkUpdates()
  const meter = statuses.find(entry => entry.name === 'dsh-cost-meter')
  assert.equal(meter?.current, '1.8.26')
  assert.equal(meter?.latest, '1.9.0')
  assert.equal(meter?.hasUpdate, true)
  const kit = statuses.find(entry => entry.name === 'dsh-plugin-kit')
  assert.equal(kit?.source, 'other')
  assert.equal(kit?.hasUpdate, false)
  assert.match(kit?.reason ?? '', /无法比较/u)
})
test('a custom index is validated before it is saved, cached, and selected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-sources-'))
  const stateDir = join(dir, '.market')
  const index = {
    format: 1,
    title: { zh: '团队市场' },
    plugins: [{
      name: 'dsh-team-tool',
      title: { zh: '团队工具' },
      repository: { url: 'https://github.com/team/dsh-team-tool' },
      versions: [{ version: '1.2.3', publishTimestamp: 1700000000, source: { type: 'npm' } }],
    }],
  }
  let calls = 0
  const service = new MarketService({
    profileDir: dir,
    runtimeRoot: dir,
    appExecutable: 'x',
    stateDir,
    fetchJsonImpl: url => {
      calls += 1
      assert.match(url, /team\.example/u)
      if (url.includes('broken')) return Promise.resolve({ format: 2, plugins: [] })
      return Promise.resolve(index)
    },
  })

  const added = await service.addSource('https://team.example/plugins.json')
  assert.equal(added.ok, true)
  assert.equal(added.items?.length, 1, 'only the source the user added')
  assert.equal(added.selected, added.items?.[0]?.id)
  assert.equal(service.sources().items[0]?.title, '团队市场')
  assert.equal(existsSync(join(stateDir, 'sources.json')), true)
  assert.equal(existsSync(join(stateDir, 'market-cache', `${String(added.selected)}.json`)), true)
  assert.equal(calls, 1)

  const browsed = await service.browse({ source: String(added.selected) })
  assert.equal(browsed.source.title, '团队市场')
  assert.equal(browsed.total, 1)
  assert.equal((browsed.entries[0] as { name?: string } | undefined)?.name, 'dsh-team-tool')
  assert.equal(calls, 1, 'the second view is served from the cache')

  const removed = service.removeSource(String(added.selected))
  assert.equal(removed.ok, true)
  assert.equal(removed.items?.length, 0)
  assert.equal(removed.selected, '')
  assert.equal(existsSync(join(stateDir, 'market-cache', `${String(added.selected)}.json`)), false)

  const rejected = await service.addSource('https://team.example/broken.json')
  assert.equal(rejected.ok, false)
  assert.match(rejected.reason ?? '', /format/u)
  assert.equal(service.sources().items.length, 0, 'a broken index is never saved')
})

test('the rich community catalog is accepted as a source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-rich-'))
  const service = new MarketService({
    profileDir: dir,
    runtimeRoot: dir,
    appExecutable: 'x',
    stateDir: join(dir, '.market'),
    fetchJsonImpl: () => Promise.resolve({
      name: 'awesome-dsh-plugin',
      plugins: [
        {
          name: 'dsh-rich',
          owner: 'acme',
          stars: 42,
          downloads: 1234,
          npm: 'dsh-rich',
          added: '2026-11-20',
        },
      ],
    }),
  })

  const added = await service.addSource('https://awesome-dsh-plugin.com/plugins.json')
  assert.equal(added.ok, true)
  const browsed = await service.browse({ source: String(added.selected), sort: 'stars' })
  assert.equal(browsed.total, 1)
  assert.equal((browsed.entries[0] as { stars?: number } | undefined)?.stars, 42)
  assert.equal(browsed.source.title, 'awesome-dsh-plugin')
})

test('a source without star counts falls back to newest and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-no-stars-'))
  const service = new MarketService({
    profileDir: dir,
    runtimeRoot: dir,
    appExecutable: 'x',
    stateDir: join(dir, '.market'),
    fetchJsonImpl: () => Promise.resolve({
      format: 1,
      title: { zh: '无统计源' },
      plugins: [
        {
          name: 'dsh-old',
          versions: [{ version: '1.0.0', publishTimestamp: 1700000000, source: { type: 'npm' } }],
          metadata: { sortKeys: {} },
        },
        {
          name: 'dsh-new',
          versions: [{ version: '1.0.0', publishTimestamp: 1800000000, source: { type: 'npm' } }],
          metadata: { sortKeys: {} },
        },
      ],
    }),
  })
  const added = await service.addSource('https://no-stars.example/index.json')
  const browsed = await service.browse({ source: String(added.selected), sort: 'stars' })
  assert.deepEqual(browsed.entries.map(entry => (entry as { name?: string }).name), ['dsh-new', 'dsh-old'])
  assert.match(browsed.notice ?? '', /没有 Star 数据/u)
})

test('a failed refresh falls back to the cached index instead of emptying the market', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-stale-'))
  const stateDir = join(dir, '.market')
  let fail = false
  const service = new MarketService({
    profileDir: dir,
    runtimeRoot: dir,
    appExecutable: 'x',
    stateDir,
    fetchJsonImpl: () => {
      if (fail) return Promise.reject(new Error('offline'))
      return Promise.resolve({
        format: 1,
        title: { zh: '本地索引' },
        plugins: [{
          name: 'dsh-local',
          versions: [{ version: '1.0.0', source: { type: 'npm' } }],
        }],
      })
    },
  })
  const added = await service.addSource('https://local.example/index.json')
  assert.equal(added.ok, true)
  fail = true
  const refreshed = await service.browse({ source: String(added.selected), refresh: true })
  assert.equal(refreshed.stale, true)
  assert.equal(refreshed.entries.length, 1)
  assert.match(refreshed.warning ?? '', /offline/u)
})

test('browsing before adding a source fails clearly instead of falling back to a built-in catalog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-empty-'))
  const service = new MarketService({
    profileDir: dir,
    runtimeRoot: dir,
    appExecutable: 'x',
    stateDir: join(dir, '.market'),
  })
  assert.deepEqual(service.sources(), { items: [], selected: '' })
  await assert.rejects(() => service.browse(), /还没有添加市场源/u)
})
