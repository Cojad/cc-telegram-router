// test:changed's decision (router/test/tiers.ts, docs/testing.md 「test:changed
// 的判斷方式」): a shared core file or one the areas do not cover runs the
// whole suite as bun run test:full (full.ts, in parallel, with its log, junit
// and file list); otherwise std and the areas touched, never the whole suite.

import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { decideChanged, FULL } from './tiers'

const ROOT = join(import.meta.dir, '..', '..')

test('the whole suite is bun run test:full: the same script package.json runs', () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts
  expect(scripts['test:full']).toBe(`bun ${FULL.argv.join(' ')}`)
  expect(FULL.argv).toEqual(['router/test/full.ts'])
})

test('a shared core file or one the areas do not cover: the whole suite, as test:full only', () => {
  for (const f of ['router/main.ts', 'router/db.ts', 'package.json', 'not/covered.ts']) {
    const d = decideChanged(['docs/testing.md', f])
    expect([f, d.runs]).toEqual([f, [FULL]])
    expect(d.lines.at(-1)).toStartWith('\n決定: 跑全套 (bun run test:full), 原因: ')
  }
  expect(decideChanged(['not/covered.ts']).lines).toContain('  not/covered.ts -> 全套 (對照檔沒有涵蓋)')
})

test('docs only or an area\'s file: std and the areas touched with bun test, never the whole suite', () => {
  const docs = decideChanged(['docs/testing.md'])
  expect(docs.runs[0]!.label).toBe('std')
  expect(docs.lines.at(-1)).toBe('\n決定: std (沒有受影響的區)')
  const area = decideChanged(['router/reactions.ts'])
  expect(area.lines.at(-1)).toContain('reactions (表情回應)')
  expect(area.runs.at(-1)).toEqual({ label: '區', argv: ['test', './router/test/reactions.test.ts', './router/test/e2e-reactions.test.ts'] })
  for (const r of [...docs.runs, ...area.runs]) expect(r.argv[0]).toBe('test')
  expect([...docs.runs, ...area.runs]).not.toContainEqual(FULL)
})
