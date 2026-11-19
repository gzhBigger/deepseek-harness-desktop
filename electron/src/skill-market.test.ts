import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { downloadSkillFromGithub, parseSkillDetail, readSkillDetail, searchSkillMarket } from './skill-market.ts'

const page = `<!doctype html><html><head>
<meta name="description" content="Build reliable React interfaces." />
</head><body>
<h1>React Best Practices</h1>
<a href="https://github.com/vercel-labs/agent-skills">Repository</a>
<div>Installs</div><div>911,662</div>
<div>GitHub Stars</div><div>34,500</div>
<pre>npx skills add https://github.com/vercel-labs/agent-skills --skill react-best-practices</pre>
</body></html>`

test('parses the stable fields from a skills.sh detail page', () => {
  const detail = parseSkillDetail(page, 'vercel-labs/agent-skills/react-best-practices')
  assert.equal(detail.name, 'React Best Practices')
  assert.equal(detail.description, 'Build reliable React interfaces.')
  assert.equal(detail.repository, 'vercel-labs/agent-skills')
  assert.equal(detail.installCommand, 'npx skills add https://github.com/vercel-labs/agent-skills --skill react-best-practices')
  assert.equal(detail.installs, '911,662')
  assert.equal(detail.stars, '34,500')
  assert.equal(detail.url, 'https://www.skills.sh/vercel-labs/agent-skills/react-best-practices')
})

test('rejects ids that can escape the skill path', () => {
  for (const id of ['', 'owner/repo', 'owner/../repo/skill', 'owner/repo/../SKILL', 'owner/repo/skill/extra']) {
    assert.throws(() => parseSkillDetail(page, id), /无效的 Skill 标识/u)
  }
})

test('search keeps good rows and drops malformed ids', async () => {
  const result = await searchSkillMarket('react', {
    fetchTextImpl: async (url) => {
      assert.match(url, /\/api\/search\?/u)
      return JSON.stringify({
        count: 3,
        skills: [
          { id: 'vercel-labs/agent-skills/react-best-practices', name: 'React Best Practices', installs: 42 },
          { id: 'owner/../bad', name: 'bad' },
          { id: 'owner/repo/skill', source: 'owner/repo', skillId: 'skill', name: 'Skill', installs: '7' },
        ],
      })
    },
  })
  assert.equal(result.query, 'react')
  assert.deepEqual(result.skills.map((skill) => skill.id), [
    'vercel-labs/agent-skills/react-best-practices',
    'owner/repo/skill',
  ])
  assert.equal(result.skills[0]?.installs, 42)
  assert.equal(result.skills[1]?.installs, 7)
})

test('search rejects short queries before touching the network', async () => {
  await assert.rejects(() => searchSkillMarket('r'), /至少需要 2 个字符/u)
})

test('readSkillDetail uses the public page and parses it', async () => {
  const detail = await readSkillDetail('vercel-labs/agent-skills/react-best-practices', {
    fetchTextImpl: async (url) => {
      assert.equal(url, 'https://www.skills.sh/vercel-labs/agent-skills/react-best-practices')
      return page
    },
  })
  assert.equal(detail.name, 'React Best Practices')
  assert.equal(detail.installCommand.includes('--skill react-best-practices'), true)
})


test('downloadSkillFromGithub picks the SKILL.md directory and rejects symlinks', async () => {
  const original = globalThis.fetch
  const make = (body: string | Uint8Array, contentType = 'application/json') => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => JSON.parse(body as string),
    arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body.buffer),
  }) as unknown as Response
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://api.github.com/repos/acme/demo') return make(JSON.stringify({ default_branch: 'main' }))
    if (url.includes('/git/trees/main?recursive=1')) {
      return make(JSON.stringify({ tree: [
        { path: 'skills/demo/SKILL.md', type: 'blob', mode: '100644', size: 60 },
        { path: 'skills/demo/scripts/run.sh', type: 'blob', mode: '100644', size: 10 },
        { path: 'README.md', type: 'blob', mode: '100644', size: 10 },
      ] }))
    }
    if (url.endsWith('skills/demo/SKILL.md')) return make('---\nname: demo\ndescription: test\n---\n', 'text/plain')
    if (url.endsWith('skills/demo/scripts/run.sh')) return make('echo hi\n', 'text/plain')
    throw new Error(`unexpected ${url}`)
  }) as typeof fetch
  try {
    const result = await downloadSkillFromGithub('acme/demo/demo')
    assert.equal(result.name, 'demo')
    assert.equal(result.files, 2)
    assert.equal(readFileSync(join(result.directory, 'SKILL.md'), 'utf8').includes('name: demo'), true)
    assert.equal(readFileSync(join(result.directory, 'scripts', 'run.sh'), 'utf8'), 'echo hi\n')
    await rm(result.directory, { recursive: true, force: true })
    assert.equal(calls.some((url) => url.includes('raw.githubusercontent.com')), true)
  } finally {
    globalThis.fetch = original
  }

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url === 'https://api.github.com/repos/acme/demo') return make(JSON.stringify({ default_branch: 'main' }))
    if (url.includes('/git/trees/main?recursive=1')) {
      return make(JSON.stringify({ tree: [
        { path: 'skills/demo/SKILL.md', type: 'blob', mode: '100644', size: 60 },
        { path: 'skills/demo/link', type: 'blob', mode: '120000', size: 10 },
      ] }))
    }
    if (url.endsWith('skills/demo/SKILL.md')) return make('---\nname: demo\n---\n', 'text/plain')
    throw new Error(`unexpected ${url}`)
  }) as typeof fetch
  try {
    await assert.rejects(() => downloadSkillFromGithub('acme/demo/demo'), /符号链接/u)
  } finally {
    globalThis.fetch = original
  }
})
