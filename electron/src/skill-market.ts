/**
 * Read-only adapter for the public skills.sh catalogue.
 *
 * The documented `/api/v1` endpoints require Vercel OIDC; the website's own search endpoint and
 * server-rendered skill pages are public. Network access stays in the main process so the MCP window
 * renderer keeps `default-src 'none'`, and we can impose a timeout and response-size cap.
 */

export const SKILL_MARKET_ORIGIN = 'https://www.skills.sh'
const SEARCH_TIMEOUT_MS = 15_000
const DETAIL_TIMEOUT_MS = 15_000
const MAX_BYTES = 2 * 1024 * 1024
const ID_PATH = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/

export interface SkillMarketHit {
  readonly id: string
  readonly source: string
  readonly skillId: string
  readonly name: string
  readonly installs: number
  readonly url: string
}

export interface SkillMarketSearch {
  readonly query: string
  readonly count: number
  readonly skills: readonly SkillMarketHit[]
}

export interface SkillMarketDetail {
  readonly id: string
  readonly name: string
  readonly source: string
  readonly skillId: string
  readonly description: string
  readonly installCommand: string
  readonly repository: string
  readonly installs: string
  readonly stars: string
  readonly url: string
}

export interface SkillMarketOptions {
  readonly limit?: number
  readonly fetchTextImpl?: (url: string, timeoutMs: number) => Promise<string>
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function htmlText(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function firstMatch(source: string, pattern: RegExp): string | undefined {
  return pattern.exec(source)?.[1]
}

function metricAfter(source: string, label: string): string {
  const at = source.indexOf(label)
  if (at < 0) return ''
  const tail = source.slice(at, at + 1200)
  return firstMatch(tail, />([0-9][0-9.,]*\s*[KMB]?)</i)?.trim() ?? ''
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'user-agent': `dsh-desktop/${process.env['npm_package_version'] ?? 'dev'} (+${SKILL_MARKET_ORIGIN})`,
      },
    })
    if (!response.ok) throw new Error(`skills.sh 返回 HTTP ${String(response.status)}。`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_BYTES) throw new Error('skills.sh 响应过大。')
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('skills.sh 响应过大。')
    return text
  } finally {
    clearTimeout(timer)
  }
}

function cleanId(value: unknown): string | undefined {
  const id = String(value ?? '').trim()
  if (!ID_PATH.test(id)) return undefined
  const parts = id.split('/')
  if (parts.length !== 3 || parts.some((part) => part === '' || part === '.' || part === '..')) return undefined
  return id
}

export async function searchSkillMarket(query: string, options: SkillMarketOptions = {}): Promise<SkillMarketSearch> {
  const q = String(query ?? '').trim()
  if (q.length < 2) throw new Error('搜索词至少需要 2 个字符。')
  if (q.length > 80) throw new Error('搜索词过长。')
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 40))
  const url = new URL('/api/search', SKILL_MARKET_ORIGIN)
  url.searchParams.set('q', q)
  url.searchParams.set('limit', String(limit))
  const text = await (options.fetchTextImpl ?? fetchText)(url.toString(), SEARCH_TIMEOUT_MS)
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('skills.sh 搜索返回了非 JSON 数据。')
  }
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const raw = Array.isArray(record['skills']) ? record['skills'] : []
  const skills: SkillMarketHit[] = []
  for (const item of raw.slice(0, limit)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const id = cleanId(entry['id'])
    if (id === undefined) continue
    const parts = id.split('/')
    skills.push({
      id,
      source: typeof entry['source'] === 'string' ? entry['source'] : parts.slice(0, 2).join('/'),
      skillId: typeof entry['skillId'] === 'string' ? entry['skillId'] : parts[2] ?? '',
      name: typeof entry['name'] === 'string' ? entry['name'] : parts[2] ?? '',
      installs: Number(entry['installs']) || 0,
      url: `${SKILL_MARKET_ORIGIN}/${id}`,
    })
  }
  return { query: q, count: Number(record['count']) || skills.length, skills }
}

export function parseSkillDetail(html: string, id: string): SkillMarketDetail {
  const clean = cleanId(id)
  if (clean === undefined) throw new Error('无效的 Skill 标识。')
  const parts = clean.split('/')
  const source = parts.slice(0, 2).join('/')
  const skillId = parts[2] ?? ''
  const title = htmlText(firstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ?? '') || skillId
  const description = decodeEntities(firstMatch(html, /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) ?? '')
    || decodeEntities(firstMatch(html, /<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i) ?? '')
  const plain = htmlText(html)
  const installCommand = firstMatch(plain, /(npx\s+skills\s+add\s+\S+\s+--skill\s+\S+)/i) ?? ''
  const repository = firstMatch(html, /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i) ?? source
  return {
    id: clean,
    name: title,
    source,
    skillId,
    description: description.trim(),
    installCommand,
    repository,
    installs: metricAfter(html, 'Installs'),
    stars: metricAfter(html, 'GitHub Stars'),
    url: `${SKILL_MARKET_ORIGIN}/${clean}`,
  }
}

export async function readSkillDetail(id: string, options: SkillMarketOptions = {}): Promise<SkillMarketDetail> {
  const clean = cleanId(id)
  if (clean === undefined) throw new Error('无效的 Skill 标识。')
  const html = await (options.fetchTextImpl ?? fetchText)(`${SKILL_MARKET_ORIGIN}/${clean}`, DETAIL_TIMEOUT_MS)
  return parseSkillDetail(html, clean)
}
