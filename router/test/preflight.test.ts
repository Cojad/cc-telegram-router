// deploy/install.sh's checks before every job and the systemd unit's PATH
// (README How to install, docs/operations.md 「部署」「疑難排解」,
// deploy/preflight.ts). Versions: bun against package.json's engines (read
// from there, not a second copy), claude against the tested version (older:
// a warning only, README says the same version). The repo's packages:
// node_modules missing or at another version than bun.lock is out of step,
// bun install --frozen-lockfile puts it right (a real run in a copy of the
// repo, from bun's cache), a failing install stops. install.sh: no bun on
// PATH stops with how to install it; a copy without node_modules gets its
// packages installed before the job; the unit's PATH gets bun's and
// claude's folders in front when they are elsewhere, and a second run
// updates it. Nothing here touches the real user's systemd: HOME is a
// temporary folder and systemctl a fake that records its arguments.

import { afterAll, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { TESTED_CLAUDE, bunRange, checkBun, checkClaude, checkDeps, depsOutOfStep, modulePath, olderThan } from '../../deploy/preflight'

const REPO = join(import.meta.dir, '..', '..')
const dir = mkdtempSync(join(tmpdir(), 'cctr-preflight-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A copy of what install.sh and preflight need from the repo, without node_modules. */
function repoCopy(name: string): string {
  const r = join(dir, name)
  mkdirSync(join(r, 'deploy'), { recursive: true })
  for (const f of ['package.json', 'bun.lock', 'deploy/preflight.ts', 'deploy/install.sh', 'deploy/cc-telegram-router.service']) cpSync(join(REPO, f), join(r, f))
  return r
}

test('versions: olderThan part by part; bun against package.json\'s engines; claude older than the tested one only warns, missing stops', () => {
  expect(olderThan('1.4.1', '1.4.2')).toBe(true)
  expect(olderThan('1.4.2', '1.4.2')).toBe(false)
  expect(olderThan('1.10.0', '1.9.9')).toBe(false)
  expect(olderThan('2.1.99', '2.1.302')).toBe(true)
  expect(olderThan('1.5.0-canary.1', '1.4.2')).toBe(false)
  const range = bunRange(REPO)!
  expect(range).toBe(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).engines.bun)
  expect(checkBun(REPO, '1.4.3', '/opt/bun').ok).toBe(true)
  expect(checkBun(REPO, '1.4.2', '/opt/bun').ok).toBe(false) // its spawnSync can spin forever (CHANGELOG 2.31.0)
  expect(checkBun(REPO, '1.5.0', '/opt/bun').lines).toEqual([`bun: /opt/bun (1.5.0, 需要 ${range})`])
  const old = checkBun(REPO, '1.3.9', '/opt/bun')
  expect(old.ok).toBe(false)
  expect(old.lines[0]).toBe(`bun 1.3.9 (/opt/bun) 太舊: package.json 的 engines 要 ${range}. 更新: bun upgrade (或照 https://bun.sh 重新安裝)`)
  expect(checkClaude('/opt/claude', `${TESTED_CLAUDE} (Claude Code)`)).toEqual({ ok: true, lines: [`claude: /opt/claude (${TESTED_CLAUDE})`] })
  const older = checkClaude('/opt/claude', '2.1.100 (Claude Code)')
  expect(older.ok).toBe(true)
  expect(older.lines[1]).toContain(`⚠️ claude 2.1.100 比開發與測試用的 ${TESTED_CLAUDE} 舊`)
  expect(checkClaude(null, null).ok).toBe(false)
  expect(checkClaude('/opt/claude', 'odd').lines[0]).toContain('版本讀不到')
  // README states the same tested versions
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
  expect(readme).toContain(`開發與測試用 ${TESTED_CLAUDE}`)
  expect(readme).toContain(`${range.replace('>=', '')} 以上`)
})

test('packages: where a lock key lives; node_modules missing or another version is out of step; bun install --frozen-lockfile puts it right; a failing install stops', () => {
  expect(modulePath('/r', 'grammy')).toBe('/r/node_modules/grammy')
  expect(modulePath('/r', '@grammyjs/types')).toBe('/r/node_modules/@grammyjs/types')
  expect(modulePath('/r', 'ajv-formats/ajv')).toBe('/r/node_modules/ajv-formats/node_modules/ajv')
  expect(modulePath('/r', '@a/b/@c/d')).toBe('/r/node_modules/@a/b/node_modules/@c/d')
  expect(depsOutOfStep(REPO)).toEqual([])
  const r = repoCopy('deps')
  expect(depsOutOfStep(r)).toEqual(['node_modules'])
  const failed = checkDeps(r, () => 1)
  expect(failed.ok).toBe(false)
  expect(failed.lines[0]).toBe('相依套件沒有裝好 (node_modules): 正在執行 bun install --frozen-lockfile')
  expect(failed.lines[1]).toContain('bun install --frozen-lockfile 失敗 (結束碼 1)')
  expect(failed.lines[1]).toContain('不要用沒鎖版本的 bun install')
  const done = checkDeps(r)
  expect(done.ok, done.lines.join('\n')).toBe(true)
  expect(done.lines.at(-1)).toBe('相依套件: 已安裝, 跟 bun.lock 一致')
  expect(depsOutOfStep(r)).toEqual([])
  // another version than the lock's
  const pj = join(r, 'node_modules', 'grammy', 'package.json')
  // a new file, not a write through it: node_modules files are hard links into bun's own cache
  const text = readFileSync(pj, 'utf8')
  rmSync(pj)
  writeFileSync(pj, text.replace(/"version":\s*"[^"]+"/, '"version": "0.0.1"'))
  expect(depsOutOfStep(r)).toEqual([expect.stringMatching(/^grammy \(要 [\d.]+, 裝的是 0\.0\.1\)$/)])
  expect(checkDeps(r).ok).toBe(true)
  expect(depsOutOfStep(r)).toEqual([])
}, 60000)

// --- install.sh ---------------------------------------------------------------
const home = join(dir, 'home')
mkdirSync(home, { recursive: true })
const bin = join(dir, 'bin')
mkdirSync(bin)
// a claude that says its version, and a systemctl that only records
writeFileSync(join(bin, 'claude'), `#!/bin/bash\necho "${TESTED_CLAUDE} (Claude Code)"\n`)
writeFileSync(join(bin, 'systemctl'), `#!/bin/bash\necho "$*" >> "${dir}/systemctl.log"\n`)
for (const f of ['claude', 'systemctl']) chmodSync(join(bin, f), 0o755)
const bunDir = dirname(process.execPath)
const env = (path: string, extra: Record<string, string> = {}) => {
  const e: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, XDG_RUNTIME_DIR: home, PATH: path }
  delete e.CC_ROUTER_STATE
  return { ...e, ...extra }
}
const sh = async (script: string, job: string, e: Record<string, string>) => {
  const p = Bun.spawn(['bash', script, job], { env: e, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}

test('install.sh: no bun on PATH stops before any job and says how to install it (~/.bun/bin)', async () => {
  for (const job of ['router', 'plugin', 'unit', 'setup', 'all']) {
    const r = await sh(join(REPO, 'deploy', 'install.sh'), job, env(`${bin}:/usr/bin:/bin`))
    expect(r.code).toBe(1)
    expect(r.err.trim()).toBe('找不到 bun (command -v bun 沒有結果): 先照 https://bun.sh 的官方安裝程式安裝 bun 1.4.3 以上 (它放在 ~/.bun/bin), 開新的 shell 或把 ~/.bun/bin 加進 PATH 後重跑')
  }
  expect(existsSync(join(home, '.config'))).toBe(false)
})

test('install.sh: a repo without node_modules gets bun install --frozen-lockfile first (said so), then the job runs; no claude stops', async () => {
  const r = repoCopy('fresh')
  const run = await sh(join(r, 'deploy', 'install.sh'), 'unit', env(`${bin}:${bunDir}:/usr/bin:/bin`))
  expect(run.out).toContain('相依套件沒有裝好 (node_modules): 正在執行 bun install --frozen-lockfile')
  expect(run.out).toContain('相依套件: 已安裝, 跟 bun.lock 一致')
  expect(run.out).toContain(`claude: ${join(bin, 'claude')} (${TESTED_CLAUDE})`)
  expect(existsSync(join(r, 'node_modules', 'grammy'))).toBe(true)
  // the job itself ran: unit asks where to install
  expect(run.code).toBe(1)
  expect(run.err).toContain('沒有指定安裝位置')
  const noClaude = mkdtempSync(join(dir, 'nc-'))
  const nc = await sh(join(r, 'deploy', 'install.sh'), 'unit', env(`${noClaude}:${bunDir}:/usr/bin:/bin`))
  expect(nc.code).toBe(1)
  expect(nc.err).toContain('找不到 claude (Claude Code CLI)')
  expect(nc.err).toContain('前置檢查沒過')
}, 60000)

test('install.sh unit: bun\'s and claude\'s folders go in front of the unit\'s PATH when elsewhere; a second run updates the installed unit', async () => {
  const state = join(dir, 'state')
  mkdirSync(state)
  const cbin = join(dir, 'claude-home', 'bin')
  mkdirSync(cbin, { recursive: true })
  cpSync(join(bin, 'claude'), join(cbin, 'claude'))
  writeFileSync(join(state, 'config.json'), JSON.stringify({ bots: [{ name: 'cc', token: 'x' }], claudeBin: join(cbin, 'claude') }))
  const unit = join(home, '.config', 'systemd', 'user', 'cc-telegram-router.service')
  const base = `${home}/.local/bin:${home}/bin:/usr/local/bin:/usr/bin:/bin`
  const first = await sh(join(REPO, 'deploy', 'install.sh'), 'unit', env(`${bin}:${bunDir}:/usr/bin:/bin`, { CC_ROUTER_STATE: state }))
  expect(first.code, first.err).toBe(0)
  expect(readFileSync(unit, 'utf8')).toContain(`Environment=PATH=${bunDir}:${cbin}:${base}\n`)
  expect(readFileSync(unit, 'utf8')).toContain(`ExecStart=${state}/cctr\n`)
  expect(readFileSync(join(dir, 'systemctl.log'), 'utf8')).toContain('--user daemon-reload')
  // claudeBin by name: the claude on PATH; already in the list: not added twice
  writeFileSync(join(state, 'config.json'), JSON.stringify({ bots: [{ name: 'cc', token: 'x' }], claudeBin: 'claude' }))
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  cpSync(join(bin, 'claude'), join(home, '.local', 'bin', 'claude'))
  const second = await sh(join(REPO, 'deploy', 'install.sh'), 'unit', env(`${home}/.local/bin:${bin}:${bunDir}:/usr/bin:/bin`, { CC_ROUTER_STATE: state }))
  expect(second.code, second.err).toBe(0)
  expect(readFileSync(unit, 'utf8')).toContain(`Environment=PATH=${bunDir}:${base}\n`)
  expect(second.out).toContain(`(PATH=${bunDir}:${base})`)
}, 60000)
