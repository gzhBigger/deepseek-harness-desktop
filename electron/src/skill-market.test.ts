import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseSkillDetail, readSkillDetail, searchSkillMarket } from './skill-market.ts'

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
