// The official telegram plugin against updates (docs/operations.md 「官方
// plugin 的自動更新與快取檢查」): every worker's settings turn the official
// marketplace's auto-update off (its source still the official GitHub
// repository, or Claude Code stops the whole marketplace as an untrusted
// source); deploy/install.sh plugin records the fingerprint of what it put in
// the cache; router/pluginguard.ts compares the cache with it (install path in
// installed_plugins.json, files, other version folders, the .orphaned_at
// marker), tells the owner at a worker's hello when the problems change and
// daily whenever there are any, and changes no file; config pluginCheckAt.
// install.sh plugin also fills the router's own marketplace (managed mode,
// docs/managed-channel.md) with its fingerprint; its check is in managed.test.ts.
// Every test uses a temporary home, plugins root and stateDir.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderSettings } from '../settings'
import { loadConfig, parseDailyAt, pluginCheckAtOrOff } from '../config'
import {
  PLUGIN_ID, FINGERPRINT_FILE, MARKETPLACE_FINGERPRINT_FILE, checkMarketplace, fingerprintDir, writeFingerprint, readFingerprint, checkPluginCache,
  formatProblems, createPluginGuard, nextDailyAt, scheduleDaily, pluginsRoot,
} from '../pluginguard'

const REPO = join(import.meta.dir, '..', '..')
const TEMPLATES = join(REPO, 'templates')
const ROLES = readdirSync(join(TEMPLATES, 'roles')).map(f => f.replace(/\.json$/, ''))
let dir: string, root: string, state: string, cache: string, versions: string

const OFFICIAL = {
  'claude-plugins-official': {
    source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
    autoUpdate: false,
  },
}

function installed(paths: string[], extra: Record<string, unknown> = {}) {
  const entries = paths.map((p, i) => ({ scope: i === 0 ? 'user' : 'local', installPath: p, version: p.split('/').at(-1), ...(i ? { projectPath: '/somewhere' } : {}) }))
  writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: entries, ...extra } }))
}

function deployFake() {
  mkdirSync(join(cache, '.claude-plugin'), { recursive: true })
  mkdirSync(join(cache, 'skills', 'doc'), { recursive: true })
  writeFileSync(join(cache, 'server.js'), 'console.log("v2")\n')
  writeFileSync(join(cache, '.mcp.json'), '{}\n')
  writeFileSync(join(cache, '.claude-plugin', 'plugin.json'), '{"name":"telegram","version":"0.0.7"}\n')
  writeFileSync(join(cache, 'skills', 'doc', 'SKILL.md'), '# doc\n')
  writeFileSync(join(cache, '.deployed-version'), 'v2\n')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pluginguard-'))
  root = join(dir, 'plugins')
  state = join(dir, 'state')
  versions = join(root, 'cache', 'claude-plugins-official', 'telegram')
  cache = join(versions, '0.0.7')
  mkdirSync(cache, { recursive: true })
  deployFake()
  installed([cache, cache])
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// --- the worker settings ----------------------------------------------------

test('every role\'s worker settings keep the official marketplace from auto-updating, from its official GitHub source, and still enable the plugin', () => {
  const base = JSON.parse(readFileSync(join(TEMPLATES, 'base-settings.json'), 'utf8'))
  expect(base.extraKnownMarketplaces).toEqual(OFFICIAL)
  for (const role of ROLES) {
    const s = renderSettings(TEMPLATES, role, { folder: '/h/c', autoCompactWindow: 1, hooksDir: '/h/hooks', hidden: ['/h'] }) as any
    expect(s.extraKnownMarketplaces).toEqual(OFFICIAL)
    expect(s.enabledPlugins).toEqual({ [PLUGIN_ID]: true })
  }
  // no role template redefines the marketplace (the whole entry of the higher file would win)
  for (const role of ROLES) expect(JSON.parse(readFileSync(join(TEMPLATES, 'roles', `${role}.json`), 'utf8')).extraKnownMarketplaces).toBeUndefined()
})

// --- fingerprint ------------------------------------------------------------

test('fingerprint: every file by relative path and sha256, symlinks by target, Claude Code\'s markers left out', () => {
  mkdirSync(join(cache, '.in_use'))
  writeFileSync(join(cache, '.in_use', '1234'), '')
  writeFileSync(join(cache, '.orphaned_at'), '1')
  symlinkSync('server.js', join(cache, 'link.js'))
  const fp = fingerprintDir(cache)
  expect(Object.keys(fp).sort()).toEqual(['.claude-plugin/plugin.json', '.deployed-version', '.mcp.json', 'link.js', 'server.js', 'skills/doc/SKILL.md'])
  expect(fp['server.js']).toBe(new Bun.CryptoHasher('sha256').update('console.log("v2")\n').digest('hex'))
  expect(fp['link.js']).toBe('link:server.js')
  const rec = writeFingerprint(state, cache, new Date('2026-10-18T05:00:00Z'))
  expect(readFingerprint(state)).toEqual(rec)
  expect(rec).toEqual({ installPath: cache, files: fp, recordedAt: '2026-10-18T05:00:00.000Z' })
})

test('pluginsRoot: CLAUDE_CODE_PLUGIN_CACHE_DIR, else ~/.claude/plugins', () => {
  expect(pluginsRoot({}, '/home/u')).toBe('/home/u/.claude/plugins')
  expect(pluginsRoot({ CLAUDE_CODE_PLUGIN_CACHE_DIR: '/p' }, '/home/u')).toBe('/p')
})

// --- the check --------------------------------------------------------------

test('check: as deployed, nothing; Claude Code\'s own markers in use do not count', () => {
  writeFingerprint(state, cache)
  mkdirSync(join(cache, '.in_use'))
  writeFileSync(join(cache, '.in_use', '99'), '')
  expect(checkPluginCache(state, root)).toEqual([])
})

test('check: no fingerprint recorded', () => {
  expect(checkPluginCache(state, root)).toEqual([{ kind: 'no-fingerprint', detail: `沒有部署紀錄 (${join(state, FINGERPRINT_FILE)}): 這版之後還沒跑過 deploy/install.sh plugin` }])
})

test('check: an official update to a new version folder (install path, other version, old folder orphaned)', () => {
  writeFingerprint(state, cache)
  const next = join(versions, '0.0.8')
  mkdirSync(next)
  writeFileSync(join(next, 'server.ts'), 'official')
  writeFileSync(join(cache, '.orphaned_at'), String(Date.now()))
  installed([next, cache])
  const p = checkPluginCache(state, root)
  expect(p.map(x => x.kind)).toEqual(['install-path', 'orphaned', 'other-versions'])
  expect(p[0]!.detail).toBe(`installed_plugins.json 的 ${PLUGIN_ID} 指向部署以外的資料夾: ${next} (user, version 0.0.8)`)
  expect(p[1]!.detail).toBe(`${cache} 被 Claude Code 標記為舊版 (.orphaned_at), 14 天後會被刪除`)
  expect(p[2]!.detail).toBe(`${versions} 底下出現其他版本資料夾: 0.0.8`)
})

test('check: files changed, added and removed in place (an update into the same folder, or a hand edit)', () => {
  writeFingerprint(state, cache)
  writeFileSync(join(cache, 'server.js'), 'official')
  writeFileSync(join(cache, 'server.ts'), 'official')
  rmSync(join(cache, 'skills'), { recursive: true })
  expect(checkPluginCache(state, root)).toEqual([{ kind: 'files', detail: `${cache} 的檔案跟部署時不同 (內容改變: server.js; 多出: server.ts; 少了: skills/doc/SKILL.md)` }])
})

test('check: the deployed folder is gone, the plugin is not installed, installed_plugins.json unreadable', () => {
  writeFingerprint(state, cache)
  rmSync(cache, { recursive: true })
  installed([])
  expect(checkPluginCache(state, root)).toEqual([
    { kind: 'not-installed', detail: `installed_plugins.json 裡沒有 ${PLUGIN_ID}` },
    { kind: 'missing-folder', detail: `部署的資料夾 ${cache} 不見了` },
  ])
  writeFileSync(join(root, 'installed_plugins.json'), '{oops')
  const p = checkPluginCache(state, root)
  expect(p[0]!.kind).toBe('not-installed')
  expect(p[0]!.detail).toStartWith(`讀不到 ${join(root, 'installed_plugins.json')}: `)
})

test('the owner\'s notice names each problem and what to do, and says nothing was changed', () => {
  writeFingerprint(state, cache)
  writeFileSync(join(cache, 'server.js'), 'official')
  expect(formatProblems(checkPluginCache(state, root))).toBe([
    '⚠️ 官方 telegram plugin 的快取跟部署時不同, worker 可能沒在用我們的 plugin v2:',
    `• ${cache} 的檔案跟部署時不同 (內容改變: server.js)`,
    '可能是官方更新或手動 `claude plugin update` 蓋掉了. router 不會自動改檔; 請確認後重新執行 deploy/install.sh plugin, 再 /router session rotate all.',
  ].join('\n'))
})

// --- the guard: when the owner is told --------------------------------------

test('guard: hello tells once per new set of problems, daily tells whenever there are any, back to normal and no fingerprint only log, nothing is changed', async () => {
  const told: string[] = [], logs: string[] = []
  const g = createPluginGuard({ stateDir: state, root, notify: t => { told.push(t) }, log: m => logs.push(m) })
  // nothing recorded yet: a log line once, no notice
  g.check('hello'); g.check('hello')
  expect(told).toEqual([])
  expect(logs.filter(l => l.includes('沒有部署紀錄'))).toHaveLength(1)
  writeFingerprint(state, cache)
  g.check('hello')
  expect(told).toEqual([])
  const before = readFileSync(join(root, 'installed_plugins.json'), 'utf8')
  writeFileSync(join(cache, 'server.js'), 'official')
  g.check('hello'); g.check('hello')
  await Bun.sleep(0)
  expect(told).toHaveLength(1)
  g.check('daily')
  await Bun.sleep(0)
  expect(told).toHaveLength(2)
  mkdirSync(join(versions, '0.0.8'))
  g.check('hello')
  await Bun.sleep(0)
  expect(told).toHaveLength(3)
  expect(told[2]).toContain('0.0.8')
  // the guard only reads
  expect(readFileSync(join(cache, 'server.js'), 'utf8')).toBe('official')
  expect(readFileSync(join(root, 'installed_plugins.json'), 'utf8')).toBe(before)
  expect(existsSync(join(versions, '0.0.8'))).toBe(true)
  // redeployed
  rmSync(join(versions, '0.0.8'), { recursive: true })
  writeFileSync(join(cache, 'server.js'), 'console.log("v2")\n')
  g.check('hello')
  expect(logs.at(-1)).toBe('plugin guard (hello): the official plugin cache is as deployed again')
  writeFileSync(join(cache, 'server.js'), 'official')
  g.check('hello')
  await Bun.sleep(0)
  expect(told).toHaveLength(4)
})

test('guard: a notice that fails (even synchronously) is logged, the check goes on', async () => {
  const logs: string[] = []
  writeFingerprint(state, cache)
  writeFileSync(join(cache, 'server.js'), 'official')
  const g = createPluginGuard({ stateDir: state, root, notify: () => { throw new Error('no bot') }, log: m => logs.push(m) })
  expect(g.check('daily').map(p => p.kind)).toEqual(['files'])
  await Bun.sleep(0)
  expect(logs.at(-1)).toBe('plugin guard notice: Error: no bot')
})

// --- daily time and config --------------------------------------------------

test('daily: the next pluginCheckAt in GMT+8, strictly after now; the timer runs it every day', () => {
  // 2026-10-18 09:06:59 GMT+8
  const t0 = Date.parse('2026-10-18T09:06:59+08:00')
  expect(nextDailyAt(t0, '09:07')).toBe(Date.parse('2026-10-18T09:07:00+08:00'))
  expect(nextDailyAt(Date.parse('2026-10-18T09:07:00+08:00'), '09:07')).toBe(Date.parse('2026-10-19T09:07:00+08:00'))
  // across the date line of the other clock: 07:30 GMT+8 is still the previous day elsewhere
  expect(nextDailyAt(Date.parse('2026-10-18T07:30:00+08:00'), '09:07')).toBe(Date.parse('2026-10-18T09:07:00+08:00'))
  let now = t0
  const timers: { fn: () => void; at: number }[] = []
  let runs = 0
  const s = scheduleDaily('09:07', () => { runs++ }, { now: () => now, setTimer: (fn, ms) => { timers.push({ fn, at: now + ms }); return {} } })
  expect(s.next()).toBe(Date.parse('2026-10-18T09:07:00+08:00'))
  now = timers[0]!.at; timers[0]!.fn()
  expect(runs).toBe(1)
  expect(s.next()).toBe(Date.parse('2026-10-19T09:07:00+08:00'))
  s.stop()
  now = timers[1]!.at; timers[1]!.fn()
  expect(runs).toBe(1)
})

test('config pluginCheckAt: missing is 09:07, "off" or false turns the daily check off, a wrong value turns it off with a warning', () => {
  expect(parseDailyAt(undefined, 'pluginCheckAt', '09:07')).toBe('09:07')
  expect(() => parseDailyAt('7:5', 'pluginCheckAt', '09:07')).toThrow('pluginCheckAt 要是 "HH:MM" (GMT+8) 或 "off", 收到 "7:5"')
  expect(parseDailyAt('7:05', 'pluginCheckAt', '09:07')).toBe('07:05')
  expect(parseDailyAt('off', 'pluginCheckAt', '09:07')).toBeNull()
  expect(parseDailyAt(false, 'pluginCheckAt', '09:07')).toBeNull()
  const warnings: string[] = []
  expect(pluginCheckAtOrOff('25:00', warnings)).toBeNull()
  expect(warnings).toEqual(['pluginCheckAt 要是 "HH:MM" (GMT+8) 或 "off", 收到 "25:00"; 官方 plugin 快取的每日檢查已關閉'])
  const cfgPath = join(dir, 'config.json')
  writeFileSync(cfgPath, JSON.stringify({ bots: [{ name: 'cc', token: '1:x' }] }))
  expect(loadConfig(cfgPath).pluginCheckAt).toBe('09:07')
  writeFileSync(cfgPath, JSON.stringify({ bots: [{ name: 'cc', token: '1:x' }], pluginCheckAt: 'off' }))
  expect(loadConfig(cfgPath).pluginCheckAt).toBeNull()
})

// --- deploy/install.sh plugin -----------------------------------------------

test('install.sh plugin: deploys into the official cache folder and the router\'s marketplace (managed mode) and records both fingerprints in the stateDir, which the checks then agree with', async () => {
  const home = join(dir, 'home')
  const target = join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.7')
  mkdirSync(target, { recursive: true })
  mkdirSync(join(target, '.in_use'))
  const st = join(dir, 'router-state')
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, CC_ROUTER_STATE: st }
  delete env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  const p = Bun.spawn(['bash', join(REPO, 'deploy', 'install.sh'), 'plugin'], { env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()]
  expect(await p.exited, err).toBe(0)
  expect(out).toContain(`plugin -> ${target}`)
  const fp = readFingerprint(st)!
  expect(fp.installPath).toBe(target)
  expect(Object.keys(fp.files)).toContain('server.js')
  expect(Object.keys(fp.files)).toContain('.claude-plugin/plugin.json')
  expect(Object.keys(fp.files).some(f => f.startsWith('.in_use'))).toBe(false)
  expect(out).toContain(`plugin fingerprint: ${Object.keys(fp.files).length} files -> ${join(st, FINGERPRINT_FILE)}`)
  const plugins = join(home, '.claude', 'plugins')
  writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: target, version: '0.0.7' }] } }))
  expect(checkPluginCache(st, plugins)).toEqual([])
  // the router's own marketplace (docs/managed-channel.md): the same files under <stateDir>/marketplace/telegram, its own fingerprint
  const market = join(st, 'marketplace')
  expect(out).toContain(`plugin -> ${join(market, 'telegram')}`)
  expect(JSON.parse(readFileSync(join(market, '.claude-plugin', 'marketplace.json'), 'utf8'))).toEqual({ name: 'cc-telegram-router', owner: { name: 'cc-telegram-router' }, plugins: [{ name: 'telegram', source: './telegram', description: 'Telegram channel of cc-telegram-router' }] })
  const { '.deployed-version': _v, ...same } = fp.files // the cache's own marker of what install.sh put there
  expect(fingerprintDir(join(market, 'telegram'))).toEqual(same)
  expect(readFingerprint(st, MARKETPLACE_FINGERPRINT_FILE)!.installPath).toBe(join(market, 'telegram'))
  expect(checkMarketplace(st, join(market, 'telegram'))).toEqual([])
  // without a known state dir the plugin still deploys, the fingerprint is skipped with a hint
  const env2 = { ...env }
  delete env2.CC_ROUTER_STATE
  const p2 = Bun.spawn(['bash', join(REPO, 'deploy', 'install.sh'), 'plugin'], { env: env2, stdout: 'pipe', stderr: 'pipe' })
  const err2 = await new Response(p2.stderr).text()
  expect(await p2.exited).toBe(0)
  expect(err2.trim()).toBe('沒有安裝位置 (CC_ROUTER_STATE 或位置檔), 沒部署 router 的商店也沒記下 plugin 指紋: 裝好 router 後再跑一次 install.sh plugin')
}, 60000)
