import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isPublicHttpUrl,
  parseGithubRepo,
  readPluginReadme,
  renderMarkdown,
  type ReadmeNode,
} from './market-readme.ts'

/** 深度优先收集某一类节点。 */
function collect(nodes: readonly ReadmeNode[], tag: string): { node: Extract<ReadmeNode, { tag: string }>; text: string }[] {
  const found: { node: Extract<ReadmeNode, { tag: string }>; text: string }[] = []
  const textOf = (list: readonly ReadmeNode[]): string =>
    list.map(node => ('text' in node ? node.text : textOf(node.children ?? []))).join('')
  const walk = (list: readonly ReadmeNode[]): void => {
    for (const node of list) {
      if ('text' in node) continue
      if (node.tag === tag) found.push({ node, text: textOf(node.children ?? []) })
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(nodes)
  return found
}

const allText = (nodes: readonly ReadmeNode[]): string =>
  nodes.map(node => ('text' in node ? node.text : allText(node.children ?? []))).join('')

test('markdown：标题、列表、代码块与表格都变成结构节点，标签之外没有 HTML', () => {
  const nodes = renderMarkdown([
    '# 标题',
    '',
    '正文 **加粗** 与 `inline <code>`。',
    '',
    '- 一',
    '- 二',
    '',
    '```js',
    'if (a < b) alert("x")',
    '```',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n'))

  assert.equal(collect(nodes, 'h1')[0]?.text, '标题')
  assert.equal(collect(nodes, 'strong')[0]?.text, '加粗')
  assert.equal(collect(nodes, 'code')[0]?.text, 'inline <code>')
  assert.deepEqual(collect(nodes, 'li').map(item => item.text), ['一', '二'])
  const pre = collect(nodes, 'pre')[0]
  assert.equal(pre?.text, 'if (a < b) alert("x")')
  const code = collect(nodes, 'pre')[0]?.node.children?.[0]
  assert.equal(code !== undefined && 'text' in code ? '' : code?.language, 'js')
  assert.deepEqual(collect(nodes, 'th').map(item => item.text), ['a', 'b'])
  assert.deepEqual(collect(nodes, 'td').map(item => item.text), ['1', '2'])
})

test('markdown：原始 HTML 只会变成文字，不会变成节点', () => {
  const nodes = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
  assert.equal(collect(nodes, 'script').length, 0)
  assert.equal(collect(nodes, 'img').length, 0)
  assert.match(allText(nodes), /<script>alert\(1\)<\/script>/u)
  assert.match(allText(nodes), /<img src=x onerror=alert\(1\)>/u)
})

test('markdown：相对链接按 base 解析，非 http(s) 链接只留文字', () => {
  const nodes = renderMarkdown('[文档](docs/guide.md) [坏链](javascript:alert(1))', {
    base: 'https://raw.githubusercontent.com/o/r/HEAD/',
  })
  const links = collect(nodes, 'a')
  assert.equal(links.length, 1)
  assert.equal(links[0]?.node.href, 'https://raw.githubusercontent.com/o/r/HEAD/docs/guide.md')
  assert.match(allText(nodes), /坏链/u)
})

test('markdown：图片按 base 解析，远程地址先保留给内联阶段', () => {
  const nodes = renderMarkdown('![截图](images/a.png)', { base: 'https://raw.githubusercontent.com/o/r/HEAD/' })
  const images = collect(nodes, 'img')
  assert.equal(images.length, 1)
  assert.equal(images[0]?.node.src, 'https://raw.githubusercontent.com/o/r/HEAD/images/a.png')
  assert.equal(images[0]?.node.alt, '截图')
})

test('图片地址只接受公网 https：localhost / 私网 / http 一律拒绝', () => {
  assert.equal(isPublicHttpUrl('https://example.com/a.png'), true)
  assert.equal(isPublicHttpUrl('https://raw.githubusercontent.com/o/r/HEAD/a.png'), true)
  assert.equal(isPublicHttpUrl('http://example.com/a.png'), false)
  assert.equal(isPublicHttpUrl('https://localhost/a.png'), false)
  assert.equal(isPublicHttpUrl('https://127.0.0.1/a.png'), false)
  assert.equal(isPublicHttpUrl('https://192.168.1.10/a.png'), false)
  assert.equal(isPublicHttpUrl('https://172.20.0.1/a.png'), false)
  assert.equal(isPublicHttpUrl('https://169.254.169.254/latest/meta-data'), false)
  assert.equal(isPublicHttpUrl('file:///etc/passwd'), false)
})

test('仓库地址解析：https 与 github: 两种写法，非 GitHub 返回 undefined', () => {
  assert.deepEqual(parseGithubRepo('https://github.com/o/r'), { owner: 'o', repo: 'r' })
  assert.deepEqual(parseGithubRepo('https://github.com/o/r.git'), { owner: 'o', repo: 'r' })
  assert.deepEqual(parseGithubRepo('github:o/r#main'), { owner: 'o', repo: 'r' })
  assert.equal(parseGithubRepo('https://gitlab.com/o/r'), undefined)
  assert.equal(parseGithubRepo(undefined), undefined)
})

/** 一个按 URL 路由的假 fetch，记录请求过的地址。 */
function fakeFetch(routes: Record<string, { body: string; type?: string } | number>): { impl: typeof fetch; seen: string[] } {
  const seen: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    seen.push(url)
    const route = routes[url]
    if (route === undefined) return new Response('not found', { status: 404 })
    if (typeof route === 'number') return new Response('', { status: route })
    return new Response(route.body, { status: 200, headers: { 'content-type': route.type ?? 'text/plain' } })
  }) as typeof fetch
  return { impl, seen }
}

test('readPluginReadme：从 GitHub 读 README，并把图片内联成 data URL', async () => {
  const fetchMock = fakeFetch({
    'https://raw.githubusercontent.com/o/r/HEAD/README.md': { body: '# R\n\n![shot](images/a.png)' },
    'https://raw.githubusercontent.com/o/r/HEAD/images/a.png': { body: 'PNGDATA', type: 'image/png' },
  })
  const result = await readPluginReadme({ name: 'p', url: 'https://github.com/o/r' }, { fetchImpl: fetchMock.impl })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.source, 'github')
  assert.equal(result.images, 1)
  const images = collect(result.nodes, 'img')
  assert.equal(images.length, 1)
  assert.match(images[0]?.node.src ?? '', /^data:image\/png;base64,/u)
})

test('readPluginReadme：找不到 README 时给出可读的失败原因', async () => {
  const fetchMock = fakeFetch({})
  const result = await readPluginReadme({ name: '@scope/none' }, { fetchImpl: fetchMock.impl })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /没有找到/u)
})

test('readPluginReadme：没有仓库时退回 npm 的 readme 字段', async () => {
  const fetchMock = fakeFetch({
    'https://registry.npmjs.org/plain-pkg/1.2.3': { body: JSON.stringify({ readme: '# npm readme\n\nhi' }) },
  })
  const result = await readPluginReadme({ name: 'plain-pkg', version: '1.2.3' }, { fetchImpl: fetchMock.impl })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.source, 'npm')
  assert.equal(collect(result.nodes, 'h1')[0]?.text, 'npm readme')
})

test('readPluginReadme：图片取不到时降级成文字，不让预览报错', async () => {
  const fetchMock = fakeFetch({
    'https://raw.githubusercontent.com/o/r/HEAD/README.md': { body: '![broken](images/missing.png)' },
  })
  const result = await readPluginReadme({ name: 'p', url: 'github:o/r' }, { fetchImpl: fetchMock.impl })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.images, 0)
  assert.match(allText(result.nodes), /\[图片：broken\]/u)
})
