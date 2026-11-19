/**
 * Read-only adapter for the public skills.sh catalogue.
 *
 * The documented `/api/v1` endpoints require Vercel OIDC; the website's own search endpoint and
 * server-rendered skill pages are public. Network access stays in the main process so the MCP window
 * renderer keeps `default-src 'none'`, and we can impose a timeout and response-size cap.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
  readonly fetchJsonImpl?: (url: string, timeoutMs: number) => Promise<unknown>
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

export interface SkillInstallResult {
  readonly directory: string
  readonly name: string
  readonly files: number
  readonly sourceId: string
  readonly repository: string
  readonly path: string
  readonly branch: string
  /** Empty when GitHub did not return a commit; the UI then treats the version as unknown. */
  readonly commit: string
  readonly version?: string
}

interface GithubTreeEntry {
  readonly path: string
  readonly type: string
  readonly mode?: string
  readonly size?: number
}

const MAX_INSTALL_FILES = 500
const MAX_INSTALL_BYTES = 8 * 1024 * 1024
const MAX_INSTALL_FILE_BYTES = 1024 * 1024
const MAX_JSON_BYTES = 8 * 1024 * 1024

function githubHeaders(): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': `dsh-desktop/${process.env['npm_package_version'] ?? 'dev'} (+${SKILL_MARKET_ORIGIN})`,
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: githubHeaders() })
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${String(response.status)}。`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_JSON_BYTES) throw new Error('GitHub 响应过大。')
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchBytes(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: githubHeaders() })
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${String(response.status)}。`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_INSTALL_FILE_BYTES) throw new Error('技能文件过大。')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_INSTALL_FILE_BYTES) throw new Error('技能文件过大。')
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

function skillNameFromMarkdown(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)
  if (match === null) return ''
  const name = /^name\s*:\s*["']?([^"'\r\n]+)["']?\s*$/mu.exec(match[1] ?? '')
  return name?.[1]?.trim() ?? ''
}

function skillVersionFromMarkdown(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)
  if (match === null) return undefined
  const version = /^version\s*:\s*["']?([^"'\r\n]+)["']?\s*$/mu.exec(match[1] ?? '')
  const value = version?.[1]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** Latest commit touching one directory; one GitHub API call per Skill check. */
export async function latestSkillCommit(
  repository: string,
  path: string,
  branch: string,
  options: SkillMarketOptions = {},
): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('无效的 Skill 仓库。')
  if (path === '' || path.split('/').includes('..')) throw new Error('无效的 Skill 目录。')
  const url = new URL(`/repos/${repository}/commits`, 'https://api.github.com')
  url.searchParams.set('path', path)
  url.searchParams.set('sha', branch)
  url.searchParams.set('per_page', '1')
  const payload = await (options.fetchJsonImpl ?? fetchJson)(url.toString(), 15_000)
  const list = Array.isArray(payload) ? payload : []
  const first = list[0]
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return ''
  return typeof (first as Record<string, unknown>)['sha'] === 'string' ? String((first as Record<string, unknown>)['sha']) : ''
}

function candidateDirectories(paths: readonly GithubTreeEntry[], skillId: string): string[] {
  const dirs: string[] = []
  for (const entry of paths) {
    if (entry.type !== 'blob' || entry.path !== `${entry.path.split('/').slice(0, -1).join('/')}/SKILL.md`) continue
    const dir = entry.path.slice(0, -'/SKILL.md'.length)
    if (dir === '' || dir.split('/').includes('..')) continue
    dirs.push(dir)
  }
  const score = (dir: string): number => {
    const base = dir.split('/').pop() ?? ''
    if (base === skillId) return 0
    if (dir.split('/').includes(skillId)) return 1
    if (base.toLowerCase() === skillId.toLowerCase()) return 2
    return 3
  }
  return [...new Set(dirs)].sort((left, right) => score(left) - score(right) || left.length - right.length)
}

/**
 * Download one Skill directory from GitHub. Nothing is written outside `directory`, symlinks and
 * submodules are rejected, and the returned path is a temporary directory the caller owns.
 * The caller imports it through the shell library (which copies), publishes a junction, and removes
 * the temporary directory.
 */
export async function downloadSkillFromGithub(id: string, options: SkillMarketOptions = {}): Promise<SkillInstallResult> {
  const clean = cleanId(id)
  if (clean === undefined) throw new Error('无效的 Skill 标识。')
  const [owner, repo, skillId] = clean.split('/') as [string, string, string]
  const meta = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, 15_000)
  const record = typeof meta === 'object' && meta !== null ? meta as Record<string, unknown> : {}
  const branch = typeof record['default_branch'] === 'string' && record['default_branch'] !== '' ? record['default_branch'] : 'main'
  const treePayload = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, 20_000)
  const treeRecord = typeof treePayload === 'object' && treePayload !== null ? treePayload as Record<string, unknown> : {}
  const entries = Array.isArray(treeRecord['tree']) ? treeRecord['tree'] : []
  const blobs: GithubTreeEntry[] = []
  for (const item of entries) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    if (typeof entry['path'] !== 'string' || typeof entry['type'] !== 'string') continue
    blobs.push({
      path: entry['path'],
      type: entry['type'],
      ...(typeof entry['mode'] === 'string' ? { mode: entry['mode'] } : {}),
      ...(typeof entry['size'] === 'number' ? { size: entry['size'] } : {}),
    })
  }
  const candidates = candidateDirectories(blobs, skillId)
  if (candidates.length === 0) throw new Error('GitHub 仓库里没有找到 SKILL.md。')
  let chosen = ''
  let chosenName = skillId
  let chosenText = ''
  for (const dir of candidates.slice(0, 12)) {
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${dir.split('/').map(encodeURIComponent).join('/')}/SKILL.md`
    const text = (await fetchBytes(raw, 15_000)).toString('utf8')
    const name = skillNameFromMarkdown(text)
    if (name !== '' && (name === skillId || name.toLowerCase() === skillId.toLowerCase())) {
      chosen = dir
      chosenName = name
      chosenText = text
      break
    }
    if (chosen === '') {
      chosen = dir
      chosenName = name !== '' ? name : skillId
      chosenText = text
    }
  }
  if (chosen === '') throw new Error('GitHub 仓库里没有找到可安装的 Skill。')
  let commit = ''
  try {
    commit = await latestSkillCommit(`${owner}/${repo}`, chosen, branch, options)
  } catch {
    // Version checks are an enhancement: a missing GitHub commit must not block installation.
  }
  const version = skillVersionFromMarkdown(chosenText)
  const prefix = `${chosen}/`
  const files = blobs.filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).split('/').includes('..'))
  if (files.length === 0) throw new Error('技能目录为空。')
  if (files.length > MAX_INSTALL_FILES) throw new Error(`技能文件过多（${String(files.length)}），已拒绝。`)
  let total = 0
  for (const file of files) {
    if (file.mode === '120000') throw new Error('技能目录包含符号链接，已拒绝。')
    const size = Number(file.size) || 0
    if (size > MAX_INSTALL_FILE_BYTES) throw new Error(`技能文件过大：${file.path}`)
    total += size
  }
  if (total > MAX_INSTALL_BYTES) throw new Error('技能目录过大，已拒绝。')

  const directory = join(tmpdir(), `dsh-skill-${randomUUID().slice(0, 12)}`)
  let downloaded = 0
  try {
    for (const file of files) {
      const relative = file.path.slice(prefix.length)
      if (relative === '' || relative.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        throw new Error('技能目录包含非法路径，已拒绝。')
      }
      const destination = join(directory, relative)
      const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${file.path.split('/').map(encodeURIComponent).join('/')}`
      const bytes = await fetchBytes(raw, 20_000)
      downloaded += bytes.byteLength
      if (downloaded > MAX_INSTALL_BYTES) throw new Error('技能目录过大，已拒绝。')
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes)
    }
    if (!existsSync(join(directory, 'SKILL.md'))) throw new Error('下载结果缺少 SKILL.md。')
    return {
      directory,
      name: chosenName,
      files: files.length,
      sourceId: clean,
      repository: `${owner}/${repo}`,
      path: chosen,
      branch,
      commit,
      ...(version === undefined ? {} : { version }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
