/**
 * 插件 README 的抓取、解析与图片内联（主进程侧）。
 *
 * 为什么返回**节点树**而不是 HTML 字符串：市场窗口的 CSP 是 `default-src 'none'`，页面自己不能
 * 联网，README 与图片都得由这里取回；而 README 是任意作者写的不可信输入。把解析结果做成只含
 * 白名单标签与纯文本的数据结构，渲染端用 `createElement` 还原，就不存在「把别人的 HTML 塞进
 * 页面」这条路径——市场页也因此保持「不出现 innerHTML」的既有约束。
 *
 * 图片：只接受 https 且主机不是内网的地址（{@link isPublicHttpUrl}），取回后转成 data URL
 * （窗口的 CSP 允许 `img-src data:`）；取不到或超限就降级成一句替代文字。
 */
import { isIP } from 'node:net'

/** README 文本上限：再大就不是 README，是仓库快照。 */
export const MAX_README_BYTES = 512 * 1024
/** 单张图片上限。 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
/** 一次预览最多内联多少张图。 */
export const MAX_IMAGES = 12
/** 一次预览内联图片的总上限。 */
export const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024
/** 网络超时。 */
const FETCH_TIMEOUT_MS = 12_000

const USER_AGENT = 'dsh-desktop-market/1.0'

/** README 从哪里来，让界面能如实说一句。 */
export type ReadmeSource = 'github' | 'npm'

/** 渲染端允许还原的标签；集合之外的一律丢弃。 */
export const README_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'strong', 'em', 'del', 'hr', 'br', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'span', 'div',
] as const

/** 一个纯文本节点。 */
export interface ReadmeText {
  readonly text: string
}

/** 一个白名单元素节点。`src` 只有在变成 data URL 之后才会出现。 */
export interface ReadmeElement {
  readonly tag: string
  readonly children?: readonly ReadmeNode[]
  readonly href?: string
  readonly src?: string
  readonly alt?: string
  readonly language?: string
  readonly className?: string
  readonly align?: 'left' | 'center' | 'right'
  readonly width?: string
  readonly height?: string
  readonly colspan?: string
  readonly rowspan?: string
  readonly open?: boolean
}

export type ReadmeNode = ReadmeText | ReadmeElement

export interface ReadmeResult {
  readonly ok: true
  readonly nodes: readonly ReadmeNode[]
  readonly source: ReadmeSource
  readonly url: string
  readonly images: number
  readonly bytes: number
  readonly truncated: boolean
}

export interface ReadmeFailure {
  readonly ok: false
  readonly reason: string
}

export interface ReadmeRequest {
  readonly name: string
  /** 目录条目里的源码地址（GitHub 仓库或 release 地址）。 */
  readonly url?: string
  /** profile 里的依赖 spec；`github:owner/repo` 能补上 url 缺失的情况。 */
  readonly spec?: string
  readonly version?: string
}

/** 注入点，测试里替换掉全部网络。 */
export interface ReadmeDeps {
  readonly fetchImpl?: typeof fetch
  /** 覆盖超时（测试用）。 */
  readonly timeoutMs?: number
}

const textNode = (text: string): ReadmeNode => ({ text })

/** GitHub 仓库地址 → owner/repo，其它地址返回 undefined。 */
export function parseGithubRepo(raw: string | undefined): { owner: string; repo: string } | undefined {
  if (raw === undefined) return undefined
  const text = raw.trim()
  const direct = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#.*)?$/u.exec(text)
  if (direct !== null) return { owner: direct[1] ?? '', repo: (direct[2] ?? '').replace(/\.git$/u, '') }
  if (!/^https?:\/\//iu.test(text)) return undefined
  try {
    const url = new URL(text)
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined
    const [owner = '', repoRaw = ''] = url.pathname.split('/').filter(Boolean)
    if (owner === '' || repoRaw === '') return undefined
    return { owner, repo: repoRaw.replace(/\.git$/u, '') }
  } catch {
    return undefined
  }
}

/** 只允许 https、且主机不是内网/回环的地址（README 里的图片经常指向奇怪的地方）。 */
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (host.endsWith('.internal') || host.endsWith('.home.arpa')) return false
  const kind = isIP(host)
  if (kind === 4) {
    const octets = host.split('.').map(part => Number(part))
    const [a = 0, b = 0] = octets
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    return true
  }
  if (kind === 6) {
    if (host === '::1' || host === '::') return false
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false
    return true
  }
  return true
}

/** 取一段文本，带超时与字节上限。 */
async function fetchText(url: string, deps: ReadmeDeps, limit = MAX_README_BYTES): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, deps.timeoutMs ?? FETCH_TIMEOUT_MS)
  try {
    const response = await doFetch(url, {
      headers: { accept: 'text/plain, text/markdown;q=0.9, */*;q=0.5', 'user-agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    return buffer.subarray(0, limit).toString('utf8')
  } finally {
    clearTimeout(timer)
  }
}

/** 取一张图片，返回 data URL；失败返回 undefined（渲染时降级成替代文字）。 */
async function fetchImageDataUrl(url: string, deps: ReadmeDeps): Promise<{ dataUrl: string; bytes: number } | undefined> {
  if (!isPublicHttpUrl(url)) return undefined
  const doFetch = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, deps.timeoutMs ?? FETCH_TIMEOUT_MS)
  try {
    const response = await doFetch(url, {
      headers: { accept: 'image/*', 'user-agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) return undefined
    const type = (response.headers.get('content-type') ?? '').split(';')[0] ?? ''
    if (!/^image\/(png|jpe?g|gif|webp|svg\+xml|avif)$/u.test(type)) return undefined
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return undefined
    return { dataUrl: `data:${type};base64,${buffer.toString('base64')}`, bytes: buffer.byteLength }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** 把相对地址解析成绝对地址；解析不了就返回 undefined（该链接只保留文字）。 */
function resolveLink(raw: string, base: string | undefined): string | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  if (/^https?:\/\//iu.test(text)) return text
  if (text.startsWith('#') || text.startsWith('mailto:')) return text
  if (base === undefined) return undefined
  try {
    return new URL(text, base).toString()
  } catch {
    return undefined
  }
}

/** 行内元素解析出的片段：文本、强调、链接、代码、图片。 */
type InlinePiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'emphasis'; readonly tag: 'strong' | 'em' | 'del'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }
  | { readonly kind: 'image'; readonly src: string; readonly alt: string }

/**
 * 行内解析：先按优先级把代码、图片、链接摘出来，剩下的纯文本再处理强调。
 *
 * 全部是字符串匹配 + 纯数据；没有任何一步把输入当 HTML 解释。
 */
function parseInline(text: string, base: string | undefined): InlinePiece[] {
  const pieces: InlinePiece[] = []
  let rest = text
  let guard = 0
  const take = (match: RegExpExecArray, piece: InlinePiece): void => {
    if (match.index > 0) pieces.push({ kind: 'text', text: rest.slice(0, match.index) })
    pieces.push(piece)
    rest = rest.slice(match.index + match[0].length)
  }

  while (rest !== '' && guard < 500) {
    guard += 1
    const code = /`([^`]+)`/u.exec(rest)
    const image = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/u.exec(rest)
    const link = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/u.exec(rest)
    const candidates: { index: number; run: () => void }[] = []
    if (code !== null) {
      candidates.push({
        index: code.index,
        run: () => take(code, { kind: 'code', text: code[1] ?? '' }),
      })
    }
    if (image !== null) {
      candidates.push({
        index: image.index,
        run: () => {
          const source = resolveLink(image[2] ?? '', base)
          const alt = image[1] ?? ''
          if (source !== undefined && /^https?:\/\//iu.test(source)) take(image, { kind: 'image', src: source, alt })
          else take(image, { kind: 'text', text: alt })
        },
      })
    }
    if (link !== null) {
      candidates.push({
        index: link.index,
        run: () => {
          const href = resolveLink(link[2] ?? '', base)
          const label = link[1] ?? ''
          if (href === undefined) take(link, { kind: 'text', text: label })
          else if (!/^https?:\/\//iu.test(href) && !href.startsWith('#') && !href.startsWith('mailto:')) {
            take(link, { kind: 'text', text: label })
          } else take(link, { kind: 'link', text: label, href })
        },
      })
    }
    candidates.sort((left, right) => left.index - right.index)
    const first = candidates[0]
    if (first === undefined) break
    first.run()
  }
  if (rest !== '') pieces.push({ kind: 'text', text: rest })

  // 纯文本片段里的强调（不处理跨片段的组合，README 里极少见）。
  const emphasised: InlinePiece[] = []
  for (const piece of pieces) {
    if (piece.kind !== 'text') {
      emphasised.push(piece)
      continue
    }
    const pattern = /(\*\*|__)(.+?)\1|~~(.+?)~~|(^|[^*\w])\*([^*\n]+)\*|(^|[^\w])_([^_\n]+)_/gu
    let cursor = 0
    let found: RegExpExecArray | null
    while ((found = pattern.exec(piece.text)) !== null) {
      if (found.index > cursor) emphasised.push({ kind: 'text', text: piece.text.slice(cursor, found.index) })
      if (found[2] !== undefined) emphasised.push({ kind: 'emphasis', tag: 'strong', text: found[2] })
      else if (found[3] !== undefined) emphasised.push({ kind: 'emphasis', tag: 'del', text: found[3] })
      else if (found[5] !== undefined) emphasised.push({ kind: 'emphasis', tag: 'em', text: found[5] })
      else if (found[7] !== undefined) emphasised.push({ kind: 'emphasis', tag: 'em', text: found[7] })
      cursor = found.index + found[0].length
      if (found[0] === '') break
    }
    if (cursor < piece.text.length) emphasised.push({ kind: 'text', text: piece.text.slice(cursor) })
  }
  return emphasised
}

/** 常量的 HTML 实体；不追求完整实体表，README 里出现的就是这几种。 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10_ffff ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10_ffff ? String.fromCodePoint(code) : whole
    }
    switch (body.toLowerCase()) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      case 'nbsp': return '\u00a0'
      case 'mdash': return '—'
      case 'ndash': return '–'
      case 'hellip': return '…'
      case 'middot': return '·'
      default: return whole
    }
  })
}

/** 自闭合标签。 */
const HTML_VOID = new Set(['br', 'hr', 'img', 'wbr', 'source'])
/** 整段丢弃（连内容一起）的标签：它们要么是脚本，要么在 README 里只会变成一片空白。 */
const HTML_DROP = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript',
  'link', 'meta', 'form', 'input', 'button', 'video', 'audio', 'canvas', 'map', 'area', 'base',
])
/** 老式/缩写标签 → 我们认识的等价物。 */
const HTML_ALIAS: Readonly<Record<string, string>> = { b: 'strong', i: 'em', s: 'del', strike: 'del' }
/** 允许出现在输出里的标签。 */
const HTML_ALLOWED = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'strong', 'em', 'del', 'hr', 'br', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'span', 'details', 'summary', 'figure', 'figcaption', 'kbd', 'sub', 'sup', 'wbr',
])

/** 任何形状的标签：属性里允许出现 `>`（引号内），所以不能简单用 `[^>]*`。 */
const HTML_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/gu

const normaliseTag = (name: string): string => {
  const lower = name.toLowerCase()
  return HTML_ALIAS[lower] ?? lower
}

/**
 * 图片地址：只接受 https、README 自带的位图 data URL，以及能按 base 解析成 https 的相对路径。
 * `data:image/svg+xml` 一律拒绝——svg 能带脚本语义，不值得为少数徽章赌一次。
 */
function resolveImageSrc(value: string, base: string | undefined): string | undefined {
  const text = value.trim()
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,/iu.test(text)) return text
  if (/^https:\/\//iu.test(text)) return text
  if (/^[a-z][a-z0-9+.-]*:/iu.test(text) || text.startsWith('//')) return undefined
  const resolved = resolveLink(text, base)
  return resolved !== undefined && /^https:\/\//iu.test(resolved) ? resolved : undefined
}

/** 只要这几个属性；其余（`class`、`style`、`on*`、`id`…）一律不进节点树。 */
function htmlAttributes(raw: string, base: string | undefined): Partial<ReadmeElement> {
  const extra: {
    href?: string
    src?: string
    alt?: string
    align?: 'left' | 'center' | 'right'
    width?: string
    height?: string
    colspan?: string
    rowspan?: string
    open?: boolean
  } = {}
  for (const match of raw.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gu)) {
    const name = (match[1] ?? '').toLowerCase()
    // 属性值里混进来的实体先解开，`&amp;` 在 URL 里很常见。
    const value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
    if (name === 'href') {
      const href = value.startsWith('#') || value.startsWith('mailto:') ? value : resolveLink(value, base)
      if (href !== undefined && /^(https?:\/\/|mailto:|#)/iu.test(href)) extra.href = href
    } else if (name === 'src') {
      const src = resolveImageSrc(value, base)
      if (src !== undefined) extra.src = src
    } else if (name === 'alt') extra.alt = value.slice(0, 300)
    else if (name === 'align' && /^(left|center|right)$/iu.test(value)) extra.align = value.toLowerCase() as 'left' | 'center' | 'right'
    else if ((name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan')) {
      const numeric = Number(value)
      if (Number.isInteger(numeric) && numeric > 0 && numeric <= 2000) extra[name] = String(numeric)
    } else if (name === 'open') extra.open = true
  }
  return extra
}

/**
 * 把一小段 HTML 解析成同一套白名单节点。
 *
 * 为什么需要它：README 里 `<p align="center">` + `<img>`、`<details><summary>`、`<br>` 到处都是，
 * 把它们当纯文本显示会让预览看起来"坏了"。这里不是浏览器：没有 DOM、没有 innerHTML，
 * 只有「标签 → 节点」和「其余一律按文字」两条规则——未知标签原样保留成文字（所以 `<https://…>`
 * 这种自动链接不会丢），`script`/`style` 这类整段丢弃。
 */
/** 这些标签内部的文本可以再走一遍 markdown：`<details>` 展开里放表格、列表是常见写法。 */
const HTML_BLOCK_CONTAINER = new Set(['details', 'div', 'blockquote', 'li', 'td', 'th', 'figure'])

const looksLikeMarkdown = (text: string): boolean =>
  /(^|\n)\s*(\||#{1,6}\s|[-*+]\s|\d+\.\s|```|> )/u.test(text)

export function htmlNodes(source: string, depth = 0, base?: string): ReadmeNode[] {
  const root: ReadmeNode[] = []
  const stack: { readonly tag: string; readonly element: ReadmeElement; readonly children: ReadmeNode[] }[] = []
  const target = (): ReadmeNode[] => stack.at(-1)?.children ?? root
  let cursor = 0

  const append = (node: ReadmeNode): void => { target().push(node) }
  const appendText = (text: string): void => {
    if (text === '') return
    const decoded = decodeEntities(text)
    if (decoded.trim() === '') return
    // `<details>`、`<div>` 里经常夹着 markdown（表格、列表）。块级容器里的段落交给渲染器再走一遍，
    // 只做一层，避免异常输入互相递归。
    const parent = stack.at(-1)?.tag
    if (depth < 2 && parent !== undefined && HTML_BLOCK_CONTAINER.has(parent) && looksLikeMarkdown(decoded)) {
      const nested = renderMarkdown(decoded.trim(), { htmlDepth: depth + 1, ...(base === undefined ? {} : { base }) })
      for (const node of nested) append(node)
      return
    }
    append(textNode(decoded))
  }

  while (cursor < source.length) {
    HTML_TAG.lastIndex = cursor
    const match = HTML_TAG.exec(source)
    if (match === null) {
      appendText(source.slice(cursor))
      break
    }
    if (match.index > cursor) appendText(source.slice(cursor, match.index))
    const rawTag = match[0]
    const closing = match[1] === '/'
    const name = normaliseTag(match[2] ?? '')
    const attributes = match[3] ?? ''
    const selfClosing = /\/\s*$/u.test(attributes)
    const after = match.index + rawTag.length
    cursor = after

    if (HTML_DROP.has(name)) {
      if (closing || selfClosing) continue
      // 丢掉整段内容：按同名标签的深度跳过。
      let depth = 1
      while (cursor < source.length) {
        HTML_TAG.lastIndex = cursor
        const inner = HTML_TAG.exec(source)
        if (inner === null) break
        cursor = inner.index + inner[0].length
        if (normaliseTag(inner[2] ?? '') !== name) continue
        if (inner[1] === '/') depth -= 1
        else if (!/\/\s*$/u.test(inner[3] ?? '')) depth += 1
        if (depth <= 0) break
      }
      continue
    }

    if (!HTML_ALLOWED.has(name)) {
      // 不认识的标签：原样当文字，避免把 `<T>`、`<https://…>` 吞掉。
      appendText(rawTag)
      continue
    }

    if (closing) {
      const at = stack.map(entry => entry.tag).lastIndexOf(name)
      if (at >= 0) stack.length = at
      continue
    }

    if (HTML_VOID.has(name) || selfClosing) {
      append({ tag: name, ...htmlAttributes(attributes, base) })
      continue
    }

    const children: ReadmeNode[] = []
    const element: ReadmeElement = { tag: name, ...htmlAttributes(attributes, base), children }
    append(element)
    stack.push({ tag: name, element, children })
  }

  return root
}

/** 行内文本里是否可能藏着 HTML 标签（要连标签名一起看，别把数学里的 `<x>` 当标签）。 */
function containsHtml(text: string): boolean {
  return /<\/?([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])/u.test(text)
}

/** 行内片段 → 节点。图片先保留远程地址，内联阶段再替换成 data URL。 */
function inlineNodes(text: string, base: string | undefined): ReadmeNode[] {
  const nodes: ReadmeNode[] = []
  for (const piece of parseInline(text, base)) {
    if (piece.kind === 'text' && containsHtml(piece.text)) {
      const parsed = htmlNodes(piece.text, 0, base)
      // 只有真的解析出元素才采用；否则（例如 `<T>`）保留原来的纯文本。
      if (parsed.some(node => !('text' in node))) {
        nodes.push(...parsed)
        continue
      }
    }
    switch (piece.kind) {
      case 'text': nodes.push(textNode(decodeEntities(piece.text))); break
      case 'code': nodes.push({ tag: 'code', children: [textNode(piece.text)] }); break
      case 'emphasis': nodes.push({ tag: piece.tag, children: [textNode(piece.text)] }); break
      case 'link': nodes.push({ tag: 'a', href: piece.href, children: [textNode(piece.text)] }); break
      case 'image': nodes.push({ tag: 'img', src: piece.src, alt: piece.alt }); break
    }
  }
  return nodes
}

/** 表格：`| a | b |` 加一行分隔线才成立。 */
function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/u.test(line)
}

const splitRow = (line: string): string[] =>
  line.replace(/^\s*\|/u, '').replace(/\|\s*$/u, '').split('|').map(cell => cell.trim())

/**
 * 渲染一个足够 README 用的 Markdown 子集：标题、段落、列表（含嵌套）、引用、代码块、表格、
 * 分割线，行内强调/代码/链接/图片。输出只有白名单标签，不存在 HTML 透传。
 */
export function renderMarkdown(markdown: string, options: { readonly base?: string; readonly htmlDepth?: number } = {}): readonly ReadmeNode[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const blocks: ReadmeNode[] = []
  let index = 0
  const base = options.base

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') { index += 1; continue }

    // HTML 块：从 `<p align="center">`、`<div>`、`<details>` 这类行开始，按同名标签的深度吃到闭合。
    const htmlStart = /^ {0,3}<([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])/u.exec(line)
    if (htmlStart !== null) {
      const name = normaliseTag(htmlStart[1] ?? '')
      if (HTML_DROP.has(name) || HTML_ALLOWED.has(name)) {
        const block: string[] = []
        let depth = 0
        let cursor = index
        const single = HTML_VOID.has(name) || /\/>\s*$/u.test(line)
        while (cursor < lines.length && cursor - index < 500) {
          const current = lines[cursor] ?? ''
          block.push(current)
          depth += (current.match(new RegExp(`<${name}(?=[\\s/>])`, 'giu')) ?? []).length
          depth -= (current.match(new RegExp(`</${name}\\s*>`, 'giu')) ?? []).length
          cursor += 1
          if (single || depth <= 0) break
          // 未闭合的块遇到标题就收手，别把后面的 markdown 一起吞掉。
          if (/^#{1,6}\s/u.test(current)) break
        }
        const nodes = htmlNodes(block.join('\n'), options.htmlDepth ?? 0, options.base)
        if (HTML_DROP.has(name) || nodes.length > 0) { blocks.push(...nodes); index = cursor; continue }
      }
    }

    const fence = /^\s*(```+|~~~+)\s*([\w.+#-]*)\s*$/u.exec(line)
    if (fence !== null) {
      const marker = (fence[1] ?? '```').slice(0, 3)
      const language = fence[2] ?? ''
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith(marker)) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push({
        tag: 'pre',
        children: [{ tag: 'code', ...(language === '' ? {} : { language }), children: [textNode(body.join('\n'))] }],
      })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      const level = (heading[1] ?? '#').length
      blocks.push({ tag: `h${String(level)}`, children: inlineNodes((heading[2] ?? '').trim(), base) })
      index += 1
      continue
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/u.test(line)) {
      blocks.push({ tag: 'hr' })
      index += 1
      continue
    }

    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1] ?? '')) {
      const header = splitRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim() !== '') {
        rows.push(splitRow(lines[index] ?? ''))
        index += 1
      }
      blocks.push({
        tag: 'table',
        children: [
          { tag: 'thead', children: [{ tag: 'tr', children: header.map(cell => ({ tag: 'th', children: inlineNodes(cell, base) })) }] },
          {
            tag: 'tbody',
            children: rows.map(row => ({
              tag: 'tr',
              children: header.map((_cell, column) => ({ tag: 'td', children: inlineNodes(row[column] ?? '', base) })),
            })),
          },
        ],
      })
      continue
    }

    if (/^\s*>/u.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^\s*>/u.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s*>\s?/u, ''))
        index += 1
      }
      blocks.push({ tag: 'blockquote', children: body.map(item => ({ tag: 'p', children: inlineNodes(item, base) })) })
      continue
    }

    const bullet = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(line)
    if (bullet !== null) {
      const ordered = /^\d/u.test(bullet[2] ?? '')
      const items: { indent: number; text: string }[] = []
      while (index < lines.length) {
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(lines[index] ?? '')
        if (match === null) break
        items.push({ indent: Math.floor((match[1] ?? '').length / 2), text: match[3] ?? '' })
        index += 1
      }
      const renderList = (from: number, depth: number): { nodes: ReadmeNode[]; next: number } => {
        const own: ReadmeNode[] = []
        let cursor = from
        while (cursor < items.length) {
          const item = items[cursor]
          if (item === undefined || item.indent < depth) break
          if (item.indent > depth) {
            const nested = renderList(cursor, item.indent)
            const last = own.at(-1)
            if (last !== undefined && !('text' in last) && last.tag === 'li') {
              own[own.length - 1] = { tag: 'li', children: [...(last.children ?? []), { tag: ordered ? 'ol' : 'ul', children: nested.nodes }] }
            }
            cursor = nested.next
            continue
          }
          own.push({ tag: 'li', children: inlineNodes(item.text, base) })
          cursor += 1
        }
        return { nodes: own, next: cursor }
      }
      blocks.push({ tag: ordered ? 'ol' : 'ul', children: renderList(0, 0).nodes })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (current.trim() === '') break
      if (/^(#{1,6})\s+/u.test(current) || /^\s*```/u.test(current) || /^\s*>/u.test(current) || /^(\s*)([-*+]|\d+[.)])\s+/u.test(current)) break
      paragraph.push(current.trim())
      index += 1
    }
    if (paragraph.length > 0) {
      blocks.push({ tag: 'p', children: inlineNodes(paragraph.join(' '), base) })
      continue
    }
    index += 1
  }

  return blocks
}

/** 收集树里的图片节点索引，供内联阶段替换。 */
function collectImages(nodes: readonly ReadmeNode[]): { node: ReadmeElement; path: number[] }[] {
  const found: { node: ReadmeElement; path: number[] }[] = []
  const walk = (list: readonly ReadmeNode[], path: number[]): void => {
    list.forEach((node, index) => {
      if ('text' in node) return
      if (node.tag === 'img') found.push({ node, path: [...path, index] })
      if (node.children !== undefined) walk(node.children, [...path, index])
    })
  }
  walk(nodes, [])
  return found
}

/** 把路径上的节点替换成新节点，返回新的树。 */
function replaceAt(nodes: readonly ReadmeNode[], path: readonly number[], replacement: ReadmeNode): readonly ReadmeNode[] {
  const [head, ...rest] = path
  if (head === undefined) return nodes
  return nodes.map((node, index) => {
    if (index !== head) return node
    if (rest.length === 0) return replacement
    if ('text' in node || node.children === undefined) return node
    return { ...node, children: replaceAt(node.children, rest, replacement) }
  })
}

const README_CANDIDATES = ['README.md', 'readme.md', 'README.markdown', 'Readme.md']

/** GitHub 上按常见文件名依次找 README。 */
async function fetchGithubReadme(owner: string, repo: string, deps: ReadmeDeps): Promise<{ markdown: string; source: ReadmeSource; url: string } | undefined> {
  for (const file of README_CANDIDATES) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${file}`
    try {
      return { markdown: await fetchText(url, deps), source: 'github', url }
    } catch {
      // 试下一个名字
    }
  }
  return undefined
}

/** npm 的 packument 里带着 latest 的 readme（有些包没有）。 */
async function fetchNpmReadme(name: string, version: string | undefined, deps: ReadmeDeps): Promise<{ markdown: string; source: ReadmeSource; url: string } | undefined> {
  const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
  const urls = [
    version === undefined ? `https://registry.npmjs.org/${encoded}` : `https://registry.npmjs.org/${encoded}/${encodeURIComponent(version)}`,
    `https://registry.npmjs.org/${encoded}`,
  ]
  for (const url of urls) {
    try {
      const document: unknown = JSON.parse(await fetchText(url, deps))
      const readme = typeof document === 'object' && document !== null ? (document as Record<string, unknown>).readme : undefined
      if (typeof readme === 'string' && readme.trim() !== '') return { markdown: readme, source: 'npm', url }
    } catch {
      // 继续下一个来源
    }
  }
  return undefined
}

/**
 * 抓 README、解析成节点树，并把图片内联成 data URL。
 *
 * 顺序：目录/依赖里能解析出 GitHub 仓库就先读仓库；否则退回 npm 的 readme 字段。
 */
export async function readPluginReadme(request: ReadmeRequest, deps: ReadmeDeps = {}): Promise<ReadmeResult | ReadmeFailure> {
  const repo = parseGithubRepo(request.url) ?? parseGithubRepo(request.spec)
  const fromGithub = repo === undefined ? undefined : await fetchGithubReadme(repo.owner, repo.repo, deps)
  const found = fromGithub ?? (await fetchNpmReadme(request.name, request.version, deps))
  if (found === undefined) return { ok: false, reason: '没有找到这个插件的 README（仓库和 npm 上都没有）' }

  const base = repo === undefined ? undefined : `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/`
  let nodes = renderMarkdown(found.markdown, base === undefined ? {} : { base })

  let used = 0
  let inlined = 0
  for (const { node, path } of collectImages(nodes)) {
    const source = node.src
    // README 里自带的 data URL 不用再抓，也不能当成远程地址去 fetch。
    if (source !== undefined && source.startsWith('data:image/')) continue
    if (inlined >= MAX_IMAGES || used >= MAX_TOTAL_IMAGE_BYTES) {
      nodes = replaceAt(nodes, path, { tag: 'span', className: 'md-image-missing', children: [textNode(`[图片：${node.alt === undefined || node.alt === '' ? '未内联' : node.alt}]`)] })
      continue
    }
    const data = source === undefined ? undefined : await fetchImageDataUrl(source, deps)
    if (data === undefined || used + data.bytes > MAX_TOTAL_IMAGE_BYTES) {
      const label = node.alt === undefined || node.alt === '' ? (source ?? '图片') : node.alt
      nodes = replaceAt(nodes, path, { tag: 'span', className: 'md-image-missing', children: [textNode(`[图片：${label}]`)] })
      continue
    }
    used += data.bytes
    inlined += 1
    nodes = replaceAt(nodes, path, { tag: 'img', src: data.dataUrl, alt: node.alt ?? '' })
  }

  const bytes = Buffer.byteLength(found.markdown, 'utf8')
  return {
    ok: true,
    nodes,
    source: found.source,
    url: found.url,
    images: inlined,
    bytes,
    truncated: bytes >= MAX_README_BYTES,
  }
}
