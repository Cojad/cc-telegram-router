// README 「Requirements」 and the package files: what the docs say the repo needs is what it uses.
import { test, expect } from 'bun:test'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const json = (p: string) => JSON.parse(read(p))

test('root package.json: no v1 bin or start pointing at a missing server.ts; test runs router/test only', () => {
  const pkg = json('package.json')
  expect(pkg.bin).toBeUndefined()
  expect(pkg.scripts.start).toBeUndefined()
  expect(pkg.scripts.test).toBe('bun test router/test')
  expect(existsSync(join(ROOT, 'server.ts'))).toBe(false)
})

test('Bun 1.4.2 or later: README says so, both package files declare engines.bun >=1.4.2', () => {
  expect(json('package.json').engines).toEqual({ bun: '>=1.4.2' })
  expect(json('plugin/package.json').engines).toEqual({ bun: '>=1.4.2' })
  expect(read('README.md')).toMatch(/\n\| \[Bun\]\(https:\/\/bun\.sh\) \| 1\.4\.2 以上/)
})

test('plugin/package.json has the same version as the repo, the latest release in CHANGELOG', () => {
  const version = json('package.json').version
  expect(json('plugin/package.json').version).toBe(version)
  expect(read('CHANGELOG.md')).toContain(`## [${version}] - `)
})

test('the report scripts run on python3, never a bare python (README: python3 3.7+, not python2)', () => {
  const files = readdirSync(join(ROOT, 'scripts'))
  for (const f of files.filter(f => f.endsWith('.py'))) expect(read(`scripts/${f}`).split('\n')[0]).toBe('#!/usr/bin/env python3')
  for (const f of files.filter(f => f.endsWith('.sh'))) {
    const s = read(`scripts/${f}`)
    expect(s).not.toMatch(/\bpython(?!3)\b/)
  }
  expect(read('scripts/tg-usage-report.sh')).toContain('python3 "$HERE/usage_report.py"')
  expect(read('scripts/tg-status-report.sh')).toContain('python3 -c')
  expect(read('router/relay.ts')).toContain('python3 "$0" "$1"') // tg-context-chart.py
  expect(read('README.md')).toMatch(/\n\| python3 \| 3\.7 以上[^\n]*python2/)
})

test('curl, jq and matplotlib are recommended, the classifier key is per feature; the repo\'s own code and scripts use no curl or jq', () => {
  const readme = read('README.md')
  const recommended = readme.slice(readme.indexOf('強烈建議:'), readme.indexOf('依功能需要:'))
  const perFeature = readme.slice(readme.indexOf('依功能需要:'), readme.indexOf('不需要:'))
  expect(recommended).toMatch(/\n\| curl \|/)
  expect(recommended).toMatch(/\n\| jq \|/)
  expect(recommended).toMatch(/\n\| matplotlib [^\n]*純文字/)
  expect(perFeature).toMatch(/\n\| OpenRouter 或其他分類器的 API key \|/)
  expect(perFeature).toMatch(/\n\| 特權技能需要的工具/)
  const sources = [
    ...readdirSync(join(ROOT, 'scripts')).map(f => `scripts/${f}`),
    'deploy/install.sh',
    ...readdirSync(join(ROOT, 'hooks')).filter(f => f.endsWith('.ts')).map(f => `hooks/${f}`),
    ...readdirSync(join(ROOT, 'router')).filter(f => f.endsWith('.ts')).map(f => `router/${f}`),
  ]
  for (const f of sources) expect(`${f}: ${read(f)}`).not.toMatch(/(^|[\s'"`(|;&])(curl|jq)\s/m)
})
