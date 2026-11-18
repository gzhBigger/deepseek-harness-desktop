/**
 * Official plugin indexes: `format: 1` JSON files served from any static host.
 *
 * The community catalog is one big, opinionated document. An official index is the opposite shape:
 * a publisher chooses which plugins to list, each entry carries its own versions and install source,
 * and the file is usually small. This module turns that document into the same `Catalog` the window
 * already knows, so the UI does not need a second rendering path.
 *
 * The index is external input. Format-level mistakes reject the whole file (a half-understood index
 * would show plugins whose install instructions we guessed); a single malformed plugin or version is
 * skipped.
 */

import type { Catalog, CatalogCategory, CatalogEntry } from './market-catalog-source.ts'

/** Text that may be a plain string or an official `{ en, zh }` object. */
type Localized = string | { readonly en?: unknown; readonly zh?: unknown; readonly [key: string]: unknown }

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** One display string: Chinese first, then English, then any other language. */
function displayText(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value)
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  return text(record.zh) ?? text(record.en) ?? Object.values(record).map(text).find(item => item !== undefined)
}

/** A description in the shape the existing cards understand. */
function bilingual(value: unknown): { readonly en?: string; readonly zh?: string } | undefined {
  if (typeof value === 'string') {
    const one = text(value)
    return one === undefined ? undefined : { zh: one }
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const en = text(record.en)
  const zh = text(record.zh)
  if (en === undefined && zh === undefined) return undefined
  return { ...(en === undefined ? {} : { en }), ...(zh === undefined ? {} : { zh }) }
}

/** Resolve an index-relative URL; anything that is not http(s) is not rendered. */
function httpUrl(base: string, value: unknown): string | undefined {
  const raw = text(value)
  if (raw === undefined) return undefined
  try {
    const resolved = new URL(raw, base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : undefined
  } catch {
    return undefined
  }
}

/** Counts are decoration; a missing or malformed one is zero, never a reason to reject. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Read a declared category vocabulary. Official indexes use `{ id: { title } }`. */
function readCategories(value: unknown): readonly CatalogCategory[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const out: CatalogCategory[] = []
  for (const [id, label] of Object.entries(value as Record<string, unknown>)) {
    if (id === '') continue
    const title = label !== null && typeof label === 'object' ? (label as Record<string, unknown>).title : label
    const en = typeof label === 'object' && label !== null ? text((label as Record<string, unknown>).en) : undefined
    const zh = typeof label === 'object' && label !== null ? text((label as Record<string, unknown>).zh) : undefined
    const readable = displayText(title) ?? displayText(label)
    out.push({
      id,
      ...(en !== undefined ? { en } : readable === undefined ? {} : { en: readable }),
      ...(zh === undefined ? {} : { zh }),
    })
  }
  return out
}

/** Compare two SemVer strings without pulling a dependency into the shell. */
function compareVersions(left: string, right: string): number {
  const parse = (value: string): { readonly core: readonly number[]; readonly pre: string } => {
    const [head, pre = ''] = value.split('-', 2)
    return { core: (head ?? '').split('.').map(part => Number.parseInt(part, 10) || 0), pre }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const diff = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (diff !== 0) return diff
  }
  // A release outranks any prerelease with the same core.
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre.localeCompare(b.pre)
}

/** One version we can install, after validating its source. */
interface IndexVersion {
  readonly version: string
  readonly timestamp: number
  readonly source: 'npm' | 'git'
  readonly registry?: string
  readonly gitUrl?: string
  readonly commit?: string
  readonly directory?: string
}

function readVersion(value: unknown): IndexVersion | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const version = text(record.version)
  if (version === undefined) return undefined
  const timestamp = typeof record.publishTimestamp === 'number' && Number.isFinite(record.publishTimestamp) ? record.publishTimestamp : 0
  const rawSource = record.source
  if (rawSource === null || typeof rawSource !== 'object') return undefined
  const source = rawSource as Record<string, unknown>
  if (source.type === 'npm') {
    return {
      version,
      timestamp,
      source: 'npm',
      ...(text(source.registry) === undefined ? {} : { registry: text(source.registry) as string }),
    }
  }
  if (source.type === 'git') {
    const gitUrl = text(source.url)
    const commit = text(source.commit)
    if (gitUrl === undefined || commit === undefined || !/^[0-9a-f]{40}$/iu.test(commit)) return undefined
    return {
      version,
      timestamp,
      source: 'git',
      gitUrl,
      commit,
      ...(text(source.path) === undefined ? {} : { directory: text(source.path) as string }),
    }
  }
  return undefined
}

/** The highest stable version; a prerelease wins only when the plugin has no stable one. */
function recommendedVersion(versions: readonly IndexVersion[]): IndexVersion | undefined {
  if (versions.length === 0) return undefined
  const ordered = [...versions].sort((left, right) => {
    const stableLeft = left.version.includes('-') ? 0 : 1
    const stableRight = right.version.includes('-') ? 0 : 1
    if (stableLeft !== stableRight) return stableRight - stableLeft
    const byVersion = compareVersions(right.version, left.version)
    return byVersion === 0 ? right.timestamp - left.timestamp : byVersion
  })
  return ordered[0]
}

/** Build the pnpm spec for a Git index version. */
function gitSpec(version: IndexVersion): string {
  const url = version.gitUrl ?? ''
  const base = url.endsWith('.git') ? url : `${url}.git`
  const commit = version.commit ?? ''
  return `git+${base}#${commit}${version.directory === undefined ? '' : `&path:/${version.directory}`}`
}

/**
 * Parse one official index.
 *
 * @param document - Parsed JSON.
 * @param sourceUrl - The index's own address, used to resolve relative icons.
 * @throws When the document is not an official `format: 1` index.
 */
export function parseIndexCatalog(document: unknown, sourceUrl: string): Catalog {
  if (document === null || typeof document !== 'object') throw new Error('插件索引不是 JSON 对象')
  const record = document as Record<string, unknown>
  if (record.format !== 1) throw new Error('插件索引 format 必须为 1')
  if (!Array.isArray(record.plugins)) throw new Error('插件索引缺少 plugins 数组')

  const categories = readCategories(record.metadata !== null && typeof record.metadata === 'object'
    ? (record.metadata as Record<string, unknown>).categories
    : undefined)
  const seenCategories = new Set(categories.map(category => category.id))
  const entries: CatalogEntry[] = []
  const seenNames = new Set<string>()

  for (const raw of record.plugins) {
    if (raw === null || typeof raw !== 'object') continue
    const plugin = raw as Record<string, unknown>
    const name = text(plugin.name)
    if (name === undefined || seenNames.has(name)) continue
    const rawVersions = Array.isArray(plugin.versions) ? plugin.versions : []
    const versions = rawVersions.map(readVersion).filter((version): version is IndexVersion => version !== undefined)
    const chosen = recommendedVersion(versions)
    if (chosen === undefined) continue
    seenNames.add(name)

    const metadata = plugin.metadata !== null && typeof plugin.metadata === 'object'
      ? plugin.metadata as Record<string, unknown>
      : {}
    const category = text(metadata.category)
    const sortKeys = metadata.sortKeys !== null && typeof metadata.sortKeys === 'object'
      ? metadata.sortKeys as Record<string, unknown>
      : {}
    const homepage = httpUrl(sourceUrl, plugin.homepage)
    const repository = plugin.repository !== null && typeof plugin.repository === 'object'
      ? plugin.repository as Record<string, unknown>
      : {}
    const repositoryUrl = httpUrl(sourceUrl, repository.url)
    const icon = httpUrl(sourceUrl, plugin.icon)
    const install = chosen.source === 'git' ? gitSpec(chosen) : undefined

    entries.push({
      name,
      stars: count(sortKeys.github_stars),
      downloads: count(sortKeys.npm_weekly_downloads),
      capabilities: [],
      ...(text(plugin.author) === undefined ? {} : { author: text(plugin.author) as string }),
      ...(displayText(plugin.title) === undefined ? {} : { title: displayText(plugin.title) as string }),
      ...(homepage === undefined ? {} : { page: homepage }),
      ...(repositoryUrl === undefined ? {} : { url: repositoryUrl }),
      ...(icon === undefined ? {} : { icon }),
      ...(category === undefined ? {} : { category }),
      ...(bilingual(plugin.description) === undefined ? {} : { description: bilingual(plugin.description) as { en?: string; zh?: string } }),
      ...(chosen.source === 'npm' ? { npm: name } : {}),
      ...(install === undefined ? {} : { install, spec: install }),
      version: chosen.version,
      ...(chosen.timestamp <= 0 ? {} : { added: new Date(chosen.timestamp * 1000).toISOString() }),
    })
    if (category !== undefined) seenCategories.add(category)
  }

  return {
    categories: [
      ...categories,
      ...[...seenCategories]
        .filter(id => !categories.some(category => category.id === id))
        .map(id => ({ id })),
    ],
    entries,
  }
}

/** A source name for the selector, read from the index title when it has one. */
export function indexTitle(document: unknown, fallback: string): string {
  if (document === null || typeof document !== 'object') return fallback
  const title = (document as Record<string, unknown>).title
  return displayText(title) ?? fallback
}

/** Localized text for a source's own display name. */
export function readLocalized(value: unknown): string | undefined {
  return displayText(value as Localized)
}
