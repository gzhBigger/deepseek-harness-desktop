/**
 * The market's sources: one built-in community catalog, plus any official plugin index the user adds.
 *
 * The built-in source is deliberately not written to disk: a file that could accidentally drop it
 * would turn "add a market" into "replace the only market". Custom sources are user preferences, so
 * they live next to the cache, not in the profile's package.json.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CATALOG_URL } from './market-catalog-source.ts'

/** The built-in community catalog. */
export const COMMUNITY_SOURCE_ID = 'community'

/** One source shown in the selector. */
export interface MarketSource {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly kind: 'community' | 'index'
  readonly builtin: boolean
  readonly addedAt?: string
}

/** What the sources file stores. Built-in sources are implicit. */
export interface StoredMarketSources {
  readonly custom: readonly {
    readonly id: string
    readonly url: string
    readonly title: string
    readonly addedAt: string
  }[]
  readonly selected: string
}

/** The only source every installation starts with. */
export const COMMUNITY_SOURCE: MarketSource = {
  id: COMMUNITY_SOURCE_ID,
  title: '社区目录',
  url: CATALOG_URL,
  kind: 'community',
  builtin: true,
}

/** A fresh state: only the built-in source. */
export function emptyStoredSources(): StoredMarketSources {
  return { custom: [], selected: COMMUNITY_SOURCE_ID }
}

/** Validate one source URL exactly as the official index UI does. */
export function normalizeSourceUrl(input: string): string {
  const raw = input.trim()
  if (raw === '') throw new Error('请输入插件索引地址')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('地址不是有效的 URL（示例：https://example.com/dsh/index.json）')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('地址必须以 http:// 或 https:// 开头')
  if (url.username !== '' || url.password !== '') throw new Error('地址不能包含用户名或密码')
  if (url.hash !== '') throw new Error('地址不能包含 #fragment')
  return url.href
}

/** Stable id for a source URL; the same URL added twice selects the existing source. */
export function sourceId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12)
}

/** A readable fallback label before the index's own title is known. */
export function sourceFallbackTitle(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '插件索引'
  }
}

/** Read the sources file; a broken file falls back to the built-in source instead of bricking the market. */
export function readStoredSources(file: string): StoredMarketSources {
  if (!existsSync(file)) return emptyStoredSources()
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return emptyStoredSources()
    const record = parsed as Record<string, unknown>
    const custom: StoredMarketSources['custom'][number][] = []
    const seen = new Set<string>()
    if (Array.isArray(record.custom)) {
      for (const item of record.custom) {
        if (item === null || typeof item !== 'object') continue
        const one = item as Record<string, unknown>
        const url = typeof one.url === 'string' ? one.url : ''
        if (url === '') continue
        let normal: string
        try {
          normal = normalizeSourceUrl(url)
        } catch {
          continue
        }
        const id = typeof one.id === 'string' && one.id !== '' ? one.id : sourceId(normal)
        if (seen.has(id)) continue
        seen.add(id)
        custom.push({
          id,
          url: normal,
          title: typeof one.title === 'string' && one.title !== '' ? one.title : sourceFallbackTitle(normal),
          addedAt: typeof one.addedAt === 'string' && one.addedAt !== '' ? one.addedAt : new Date(0).toISOString(),
        })
      }
    }
    const selected = typeof record.selected === 'string' && (record.selected === COMMUNITY_SOURCE_ID || seen.has(record.selected))
      ? record.selected
      : COMMUNITY_SOURCE_ID
    return { custom, selected }
  } catch {
    return emptyStoredSources()
  }
}

/** Write atomically: the market may be closed while a fetch is in flight, and a half file loses sources. */
export function writeStoredSources(file: string, state: StoredMarketSources): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/** All sources, built-in first. */
export function allSources(state: StoredMarketSources): readonly MarketSource[] {
  return [
    COMMUNITY_SOURCE,
    ...state.custom.map(source => ({
      id: source.id,
      title: source.title,
      url: source.url,
      kind: 'index' as const,
      builtin: false,
      addedAt: source.addedAt,
    })),
  ]
}

/** The cache path for one source. */
export function sourceCachePath(dir: string, id: string): string {
  return join(dir, 'market-cache', `${id}.json`)
}
