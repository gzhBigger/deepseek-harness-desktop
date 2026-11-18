/**
 * Official plugin index parsing. The index is external input: a wrong guess here would install a
 * plugin the publisher never listed, so these tests pin the two source kinds (npm and Git) and the
 * "skip one bad entry, never half-render it" rule.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { indexTitle, parseIndexCatalog } from './market-index-source.ts'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

test('an official index turns npm and Git versions into installable cards', () => {
  const catalog = parseIndexCatalog({
    format: 1,
    title: { en: 'Team plugins', zh: '团队插件' },
    metadata: {
      categories: {
        tools: { title: { en: 'Tools', zh: '工具' } },
      },
    },
    plugins: [
      {
        name: 'dsh-plugin-npm',
        title: { zh: 'npm 插件' },
        description: { en: 'From npm', zh: '来自 npm' },
        icon: 'icons/npm.svg',
        author: 'Jane',
        homepage: 'https://example.com/npm',
        repository: { url: 'https://github.com/jane/dsh-plugin-npm' },
        metadata: { category: 'tools', sortKeys: { github_stars: 12, npm_weekly_downloads: 34 } },
        versions: [
          { version: '1.0.0', publishTimestamp: 1700000000, source: { type: 'npm' } },
          { version: '2.0.0', publishTimestamp: 1700000100, source: { type: 'npm' } },
          { version: '3.0.0-beta.1', publishTimestamp: 1700000200, source: { type: 'npm' } },
        ],
      },
      {
        name: 'dsh-plugin-git',
        repository: { url: 'https://github.com/jane/dsh-plugin-git' },
        versions: [
          {
            version: '0.4.0',
            publishTimestamp: 1700000300,
            source: { type: 'git', url: 'https://github.com/jane/dsh-plugin-git', commit: COMMIT, path: 'packages/plugin' },
          },
        ],
      },
    ],
  }, 'https://example.com/dsh/index.json')

  assert.equal(indexTitle({ title: { en: 'Team plugins', zh: '团队插件' } }, 'fallback'), '团队插件')
  assert.deepEqual(catalog.categories.map(category => category.id), ['tools'])
  assert.equal(catalog.entries.length, 2)

  const npm = catalog.entries[0]
  assert.equal(npm?.name, 'dsh-plugin-npm')
  assert.equal(npm?.npm, 'dsh-plugin-npm')
  assert.equal(npm?.version, '2.0.0', 'stable 2.0.0 outranks 3.0.0-beta.1')
  assert.equal(npm?.spec, undefined)
  assert.equal(npm?.title, 'npm 插件')
  assert.equal(npm?.author, 'Jane')
  assert.equal(npm?.icon, 'https://example.com/dsh/icons/npm.svg')
  assert.equal(npm?.stars, 12)
  assert.equal(npm?.downloads, 34)
  assert.equal(npm?.description?.zh, '来自 npm')

  const git = catalog.entries[1]
  assert.equal(git?.name, 'dsh-plugin-git')
  assert.equal(git?.npm, undefined)
  assert.equal(git?.version, '0.4.0')
  assert.equal(git?.spec, `git+https://github.com/jane/dsh-plugin-git.git#${COMMIT}&path:/packages/plugin`)
  assert.equal(git?.install, git?.spec)
})

test('a malformed version is skipped; a malformed document is rejected', () => {
  const catalog = parseIndexCatalog({
    format: 1,
    plugins: [
      {
        name: 'dsh-plugin-bad',
        versions: [
          { version: '1.0.0', source: { type: 'npm' } },
          { version: '1.0.0', source: { type: 'git', url: 'https://github.com/x/y' } },
          { version: '1.0.0', source: { type: 'git', url: 'https://github.com/x/y', commit: 'not-a-commit' } },
        ],
      },
      { name: 'dsh-plugin-no-versions', versions: [] },
    ],
  }, 'https://example.com/index.json')

  assert.equal(catalog.entries.length, 1)
  assert.equal(catalog.entries[0]?.name, 'dsh-plugin-bad')
  assert.equal(catalog.entries[0]?.npm, 'dsh-plugin-bad')

  assert.throws(() => parseIndexCatalog({ format: 2, plugins: [] }, 'https://example.com/index.json'), /format/u)
  assert.throws(() => parseIndexCatalog({ format: 1 }, 'https://example.com/index.json'), /plugins/u)
})
