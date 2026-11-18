/**
 * Source preferences: a URL becomes a stable id, the built-in source is never persisted away, and a
 * half-written preferences file must not brick the market.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  COMMUNITY_SOURCE,
  COMMUNITY_SOURCE_ID,
  allSources,
  emptyStoredSources,
  normalizeSourceUrl,
  readStoredSources,
  sourceCachePath,
  sourceFallbackTitle,
  sourceId,
  writeStoredSources,
} from './market-sources.ts'

test('source URLs are validated and fingerprinted', () => {
  assert.equal(normalizeSourceUrl(' https://example.com/plugins.json '), 'https://example.com/plugins.json')
  assert.equal(normalizeSourceUrl('http://example.com/plugins.json'), 'http://example.com/plugins.json')
  assert.throws(() => normalizeSourceUrl('ftp://example.com/plugins.json'), /http/u)
  assert.throws(() => normalizeSourceUrl('https://user:pass@example.com/plugins.json'), /用户名/u)
  assert.throws(() => normalizeSourceUrl('https://example.com/plugins.json#frag'), /fragment/u)
  assert.equal(sourceId('https://example.com/plugins.json'), sourceId('https://example.com/plugins.json'))
  assert.notEqual(sourceId('https://example.com/a.json'), sourceId('https://example.com/b.json'))
  assert.equal(sourceFallbackTitle('https://example.com/plugins.json'), 'example.com')
  assert.equal(sourceCachePath('/tmp/market', 'abc'), join('/tmp/market', 'market-cache', 'abc.json'))
})

test('the built-in source is always present and cannot be written away', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-sources-'))
  const file = join(dir, 'sources.json')
  assert.deepEqual(readStoredSources(file), emptyStoredSources())
  const state = {
    custom: [{ id: sourceId('https://example.com/a.json'), url: 'https://example.com/a.json', title: 'A', addedAt: '2026-01-01T00:00:00.000Z' }],
    selected: sourceId('https://example.com/a.json'),
  }
  writeStoredSources(file, state)
  assert.deepEqual(readStoredSources(file), state)
  assert.equal(allSources(readStoredSources(file))[0]?.id, COMMUNITY_SOURCE_ID)
  assert.equal(allSources(readStoredSources(file))[0]?.title, COMMUNITY_SOURCE.title)
  assert.match(readFileSync(file, 'utf8'), /\n$/u)

  writeFileSync(file, '{ not json', 'utf8')
  assert.deepEqual(readStoredSources(file), emptyStoredSources(), 'a broken file falls back to the built-in source')
})

test('a selected id that is no longer in custom falls back to the community source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-market-sources-'))
  const file = join(dir, 'sources.json')
  writeFileSync(file, JSON.stringify({ custom: [], selected: 'gone' }), 'utf8')
  assert.equal(readStoredSources(file).selected, COMMUNITY_SOURCE_ID)
})
