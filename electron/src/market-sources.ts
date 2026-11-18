/**
 * The market's sources: official plugin indexes the user adds.
 *
 * There is deliberately no built-in catalog. A market that starts with a source of its own silently
 * turns "add a market" into "replace the only market", and it would fetch that source on every open
 * even when the user only wanted their own index. The list lives next to the cache, not in the
 * profile's package.json.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One source shown in the selector. */
export interface MarketSource {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly kind: 'index'
  readonly addedAt?: string
}

/** What the sources file stores. */
export interface StoredMarketSources {
  readonly custom: readonly {
    readonly id: string
    readonly url: string
    readonly title: string
    readonly addedAt: string
  }[]
  readonly selected: string
}

/** A fresh state: no market until the user adds one. */
export function emptyStoredSources(): StoredMarketSources {
  return { custom: [], selected: '' }
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

/** Read the sources file; a broken file falls back to "no sources" instead of bricking the market. */
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
    const requested = typeof record.selected === 'string' ? record.selected : ''
    const selected = requested !== '' && seen.has(requested) ? requested : (custom[0]?.id ?? '')
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

/** All user-added sources, in the order they were added. */
export function allSources(state: StoredMarketSources): readonly MarketSource[] {
  return state.custom.map(source => ({
    id: source.id,
    title: source.title,
    url: source.url,
    kind: 'index' as const,
    addedAt: source.addedAt,
  }))
}

/** The cache path for one source. */
export function sourceCachePath(dir: string, id: string): string {
  return join(dir, 'market-cache', `${id}.json`)
}
