// The test areas in areas.ts (docs/testing.md 「測試分區」): every test file
// belongs to an area, nothing listed there is missing, the section lists
// the same areas and std, and 「測試檔對照」 has a row for every test file.
// Part of std.

import { test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { AREAS, RUN_ALL, STD, STD_ONLY } from './areas'

const ROOT = join(import.meta.dir, '..', '..')
const testFiles = readdirSync(import.meta.dir).filter(f => f.endsWith('.test.ts')).sort()

test('every test file under router/test belongs to at least one area', () => {
  const listed = new Set(AREAS.flatMap(a => a.tests))
  expect(testFiles.filter(f => !listed.has(f))).toEqual([])
})

test('areas and std name only test files that exist; area names are unique', () => {
  const names = AREAS.map(a => a.name)
  expect(new Set(names).size).toBe(names.length)
  for (const a of AREAS) expect(a.tests.filter(f => !testFiles.includes(f))).toEqual([])
  expect(STD.map(e => e.file).filter(f => !testFiles.includes(f))).toEqual([])
})

test('every path glob in areas, RUN_ALL and STD_ONLY matches a file in the repo', () => {
  const repoFiles = [...new Bun.Glob('**').scanSync({ cwd: ROOT, dot: true })].filter(f => !f.startsWith('node_modules/') && !f.startsWith('.git/'))
  const globs = [...AREAS.flatMap(a => a.paths), ...RUN_ALL, ...STD_ONLY]
  expect(globs.filter(g => !repoFiles.some(f => new Bun.Glob(g).match(f)))).toEqual([])
})

test('docs/testing.md 「各區」 and 「std 套組」 list the same areas, test files and std files', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'testing.md'), 'utf8')
  const section = (h: string) => doc.slice(doc.indexOf(`### ${h}\n`), doc.indexOf('\n### ', doc.indexOf(`### ${h}\n`) + 1))
  const rows = section('各區').split('\n').filter(l => l.startsWith('| `'))
  expect(rows.map(r => r.split('`')[1])).toEqual(AREAS.map(a => a.name))
  for (const a of AREAS) {
    const cell = rows.find(r => r.startsWith(`| \`${a.name}\` |`))!.split(' | ')[2]!
    expect(cell.split(', ').sort()).toEqual(a.tests.map(f => f.replace('.test.ts', '')).sort())
  }
  const std = section('std 套組').split('\n').filter(l => l.startsWith('| `')).map(r => r.split('`')[1])
  expect(std).toEqual(STD.map(e => e.file))
})

test('docs/testing.md 「測試檔對照」 has a row for every test file under router/test', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'testing.md'), 'utf8')
  const start = doc.indexOf('\n## 測試檔對照\n')
  const table = doc.slice(start, doc.indexOf('\n## ', start + 1))
  const listed = new Set(table.split('\n').filter(l => l.startsWith('| `')).flatMap(l => [...l.split(' | ')[0]!.matchAll(/`router\/test\/([^`]+\.test\.ts)`/g)].map(m => m[1]!)))
  expect(testFiles.filter(f => !listed.has(f))).toEqual([])
})
