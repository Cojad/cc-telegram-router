// Why workers fail, module level (docs/operations.md 「疑難排解」「cli doctor」,
// router/diagnose.ts, router/doctor.ts, router/supervisor.ts): folder trust
// from ~/.claude.json (self, a folder above, a git repo's root, never the
// user's home) and writing it (backup, that one key only, same mode, read
// back, overwritten by another process); the plugin's MCP log (newest file,
// the reason, tool errors and noise left out, tokens masked); the cause and
// fix of a failed wake; waking again later (1, 2, 5, 10, 30 minutes, the
// owner told once per cause, recovery told, restart releases); the
// supervisor holding back and not waiting for a plugin when claude --bg
// refused (alongside its job flag check, router/jobs.ts); StopFailure's API errors with their fixes; the model against
// autoCompactWindow; the doctor report (every check, no token); /router
// status with each worker's trouble and /router doctor. Every ~/.claude.json
// here is a temporary file. End to end: e2e-diagnose.test.ts.

import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { apiAdvice, backoffMs, createWakeTracker, grantTrust, latestPluginLog, modelWindow, modelWindowNotes, pluginFailure, pluginLogDir, projectSlug, readProjects, trustFix, trustOf, wakeCause } from '../diagnose'
import { doctorReport } from '../doctor'
import { createSupervisor, type RunResult } from '../supervisor'
import { writeFingerprint } from '../pluginguard'
import { writeLocator, locatorPath } from '../../shared/locate'
import { renderStatus } from '../commands'
import { blockedWhy, listJobs, workerStateNote, TURN_END_NOTE } from '../jobs'
import type { Conversation } from '../db'

const dir = mkdtempSync(join(tmpdir(), 'cctr-diagnose-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const TOKEN = `123456:${'S'.repeat(35)}`

test('trust: the folder itself or one above; a git repo by its root; the user\'s home never; only the flags are read', () => {
  const home = join(dir, 'u'), cc = join(home, 'cc'), conv = join(cc, 'bot1', 'dm-5')
  const repo = join(cc, 'bot1', 'group-7')
  mkdirSync(conv, { recursive: true }); mkdirSync(join(repo, '.git'), { recursive: true })
  expect(trustOf({ [cc]: { hasTrustDialogAccepted: true } }, conv, home)).toEqual({ trusted: true, key: cc, why: 'parent' })
  expect(trustOf({ [cc]: { hasTrustDialogAccepted: true } }, cc, home)).toEqual({ trusted: true, key: cc, why: 'self' })
  expect(trustOf({}, conv, home)).toEqual({ trusted: false, key: conv, why: 'none' })
  // a repo inside a trusted folder is not covered: its root decides
  expect(trustOf({ [cc]: { hasTrustDialogAccepted: true } }, repo, home)).toEqual({ trusted: false, key: repo, why: 'repo' })
  expect(trustOf({ [repo]: { hasTrustDialogAccepted: true } }, join(repo), home).trusted).toBe(true)
  // the home's own flag does not count, nor does it cover what is under it
  expect(trustOf({ [home]: { hasTrustDialogAccepted: true } }, home, home)).toEqual({ trusted: false, key: home, why: 'home' })
  expect(trustOf({ [home]: { hasTrustDialogAccepted: true } }, conv, home).trusted).toBe(false)
  const cj = join(dir, 'claude.json')
  writeFileSync(cj, JSON.stringify({ oauthAccount: { emailAddress: 'x@example.com' }, projects: { [cc]: { hasTrustDialogAccepted: true, mcpServers: { a: { env: { KEY: 'secret' } } } }, [repo]: {} } }))
  expect(readProjects(cj)).toEqual({ [cc]: { hasTrustDialogAccepted: true }, [repo]: { hasTrustDialogAccepted: false } })
  expect(readProjects(join(dir, 'none.json'))).toBeNull()
  expect(trustFix(cc, { trusted: false, key: cc, why: 'none' })).toBe(`在 router 的使用者下互動執行一次: cd ${cc} && claude, 在資料夾信任確認框選接受, 然後 /exit`)
  expect(trustFix(home, { trusted: false, key: home, why: 'home' })).toContain('是使用者的家目錄')
})

test('grantTrust: backup first, only that key changes, the file keeps its mode, read back; overwritten by another process is told; a missing or broken file is left alone', async () => {
  const cj = join(dir, 'grant.json')
  const before = { numStartups: 3, oauthAccount: { emailAddress: 'x@example.com' }, projects: { '/a': { allowedTools: ['Bash'], hasTrustDialogAccepted: false }, '/b': { lastCost: 1 } } }
  writeFileSync(cj, JSON.stringify(before))
  chmodSync(cj, 0o664)
  const waited: number[] = []
  const r = await grantTrust(cj, '/a', { now: new Date('2026-10-18T05:30:00Z'), wait: async ms => { waited.push(ms) } })
  expect(r).toEqual({ ok: true, backup: `${cj}.cc-router-backup-20261018-133000` })
  expect(JSON.parse(readFileSync(r.backup!, 'utf8'))).toEqual(before)
  expect(statSync(r.backup!).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(cj, 'utf8'))).toEqual({ ...before, projects: { ...before.projects, '/a': { allowedTools: ['Bash'], hasTrustDialogAccepted: true } } })
  expect(statSync(cj).mode & 0o777).toBe(0o664)
  expect(waited).toEqual([3000])
  expect(readdirSync(dir).filter(f => f.includes('cc-router-tmp'))).toEqual([])
  // a key that is not there yet
  expect((await grantTrust(cj, '/new', { wait: async () => {} })).ok).toBe(true)
  expect(readProjects(cj)!['/new']).toEqual({ hasTrustDialogAccepted: true })
  // another Claude Code writes its old copy back while we wait
  const lost = await grantTrust(cj, '/c', { now: new Date('2026-10-18T05:31:00Z'), wait: async () => { writeFileSync(cj, JSON.stringify(before)) } })
  expect(lost.ok).toBe(false)
  expect(lost.why).toBe('寫入後被其他 Claude Code 程序蓋掉了')
  expect((await grantTrust(join(dir, 'missing.json'), '/a')).why).toContain('不存在')
  writeFileSync(join(dir, 'broken.json'), '{not json')
  const broken = await grantTrust(join(dir, 'broken.json'), '/a', { now: new Date('2026-10-18T05:32:00Z') })
  expect(broken.ok).toBe(false)
  expect(readFileSync(join(dir, 'broken.json'), 'utf8')).toBe('{not json')
})

test('the plugin\'s log: Claude Code\'s folder name, the newest file (and not an older one), the reason; tool errors and noise left out; tokens masked', () => {
  expect(projectSlug('/srv/cc/bot123/dm-555')).toBe('-srv-cc-bot123-dm-555')
  expect(projectSlug('/tmp/a_b.c')).toBe('-tmp-a-b-c')
  const home = join(dir, 'h1'), folder = '/srv/cc/bot123/dm-555'
  const logs = pluginLogDir(folder, home)
  expect(logs).toBe(join(home, '.cache', 'claude-cli-nodejs', '-srv-cc-bot123-dm-555', 'mcp-logs-plugin-telegram-telegram'))
  expect(latestPluginLog(folder, home)).toBeNull()
  mkdirSync(logs, { recursive: true })
  writeFileSync(join(logs, 'old.jsonl'), '{"debug":"x"}\n')
  utimesSync(join(logs, 'old.jsonl'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
  writeFileSync(join(logs, 'new.jsonl'), '{"debug":"y"}\n')
  expect(latestPluginLog(folder, home)).toBe(join(logs, 'new.jsonl'))
  expect(latestPluginLog(folder, home, Date.now() + 60_000)).toBeNull()
  const line = (k: string, v: string) => JSON.stringify({ [k]: v, timestamp: '2026-10-18T05:00:00.000Z' })
  const failed = [
    line('debug', 'Starting connection with timeout of 30000ms'),
    line('error', 'reply failed: chat not found'),
    line('error', 'Server stderr: telegram channel: TELEGRAM_STANDBY_ONLY=1 — never polling'),
    line('error', 'Connection failed: Executable not found in $PATH: "bun"'),
    line('error', 'Connection failed (CONNECTION_CLOSED): Connection closed'),
  ].join('\n')
  expect(pluginFailure(failed)).toBe('Connection failed: Executable not found in $PATH: "bun"')
  expect(pluginFailure([line('error', 'Connection failed (CONNECTION_CLOSED): Connection closed')].join('\n'))).toBe('Connection failed (CONNECTION_CLOSED): Connection closed')
  expect(pluginFailure(line('error', `Server stderr: token ${TOKEN} refused\n`))).toBe(`token 123456:…SSSS refused`)
  expect(pluginFailure([line('debug', 'Successfully connected'), line('error', 'reply failed: x')].join('\n'))).toBeNull()
  expect(pluginFailure('not json\n')).toBeNull()
})

test('a failed wake: trust (with the folder\'s own fix), the home, bun missing, another plugin reason, claude --bg\'s own words, nothing known', () => {
  const o = { home: '/srv/cc', folder: '/srv/cc/bot1/dm-5' }
  const trust = wakeCause({ ...o, spawnOut: 'Workspace not trusted. Run `claude` in /srv/cc/bot1/dm-5 once and accept the trust prompt, then retry.' })
  expect(trust.cause).toBe('資料夾沒有被信任 (Workspace not trusted)')
  expect(trust.fix).toContain('cd /srv/cc && claude')
  expect(wakeCause({ ...o, spawnOut: 'Workspace not trusted. The home directory is trusted one session at a time' }).cause).toBe('資料夾信任: home 是使用者的家目錄')
  const bun = wakeCause({ ...o, pluginLog: 'Connection failed: Executable not found in $PATH: "bun"' })
  expect(bun.cause).toBe('plugin 起不來: Connection failed: Executable not found in $PATH: "bun"')
  expect(bun.fix).toContain('deploy/install.sh unit')
  expect(wakeCause({ ...o, pluginLog: 'Connection failed (CONNECTION_CLOSED)', logFile: '/x/log.jsonl' }).fix).toContain('/x/log.jsonl')
  expect(wakeCause({ ...o, spawnOut: `error: unknown option --channels ${TOKEN}` }).cause).toBe('claude --bg 失敗: error: unknown option --channels 123456:…SSSS')
  expect(wakeCause(o).cause).toBe('plugin 沒有在時限內連上 router, plugin 的 log 也沒有寫原因')
})

test('waking again later: 1, 2, 5, 10, 30, 30 minutes; the owner told once per cause, again for a new one; recovery told only after a notice; restart releases the hold', () => {
  expect([1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([1, 2, 5, 10, 30, 30].map(m => m * 60_000))
  let t = 1_000_000
  const w = createWakeTracker(() => t)
  expect(w.fail('dm-1', 'A')).toEqual({ notify: true, retryAt: t + 60_000, failures: 1 })
  expect(w.until('dm-1')).toBe(t + 60_000)
  expect(w.fail('dm-1', 'A')).toEqual({ notify: false, retryAt: t + 120_000, failures: 2 })
  expect(w.fail('dm-1', 'B').notify).toBe(true)
  w.release('dm-1')
  expect(w.until('dm-1')).toBe(0)
  expect(w.fail('dm-1', 'B')).toEqual({ notify: false, retryAt: t + 600_000, failures: 4 })
  expect(w.ok('dm-1')).toEqual({ recovered: true, failures: 4 })
  expect(w.ok('dm-1')).toEqual({ recovered: false, failures: 0 })
  expect(w.until('dm-2')).toBe(0)
})

test('supervisor: claude --bg refusing is a failure at once (no wait for the plugin); a held conversation is not woken; restart wakes it anyway', async () => {
  const runs: string[][] = []
  let answer: RunResult = { code: 1, stdout: '', stderr: 'Workspace not trusted. Run `claude` in /f once and accept the trust prompt, then retry.' }
  const fails: Array<string | undefined> = []
  const tracker = createWakeTracker()
  const conv = { key: 'dm-1', bot: 'cc', chat_id: '1', type: 'dm', folder: '/f', role: 'owner', session_id: null, created_at: '' } as unknown as Conversation
  let waited = 0
  const sup = createSupervisor({
    cfg: { claudeBin: 'claude', home: '/h', model: 'm' } as never,
    db: { getConversation: () => conv, undelivered: () => [{}], setSession() {} } as never,
    run: async args => { runs.push(args); return args[1] === 'agents' ? { code: 0, stdout: '[]', stderr: '' } : answer },
    isConnected: () => false,
    waitConnected: async () => { waited++; return false },
    settingsPath: () => '/s.json',
    connectTimeoutMs: 10,
    onWakeFail: (c, info) => { fails.push(info.spawnOut); tracker.fail(c.key, info.spawnOut ?? 'none') },
    holdUntil: k => tracker.until(k),
    release: k => tracker.release(k),
  })
  await sup.ensureAwake(conv)
  expect(fails).toEqual([answer.stderr])
  expect(waited).toBe(0)
  const spawns = () => runs.filter(a => a[1] === '--bg').length
  expect(spawns()).toBe(1)
  // held for a minute: no second try
  await sup.ensureAwake(conv)
  expect(spawns()).toBe(1)
  // the plugin never connects: a failure after the wait
  answer = { code: 0, stdout: 'backgrounded · abcdef12 · tg-dm-1 (idle)', stderr: '' }
  await sup.restart(conv)
  expect(spawns()).toBe(2)
  expect(waited).toBe(1)
  expect(fails).toEqual([expect.stringContaining('Workspace not trusted'), undefined])
})

test('supervisor: the job flag check and the wake backoff on one wake: a job with other flags is stopped and removed, the resume with new flags refused by claude is a failure, then held', async () => {
  const runs: string[][] = []
  const tracker = createWakeTracker()
  const conv = { key: 'dm-1', bot: 'cc', chat_id: '1', type: 'dm', folder: '/f', role: 'owner', session_id: 's1', created_at: '' } as unknown as Conversation
  const fails: Array<string | undefined> = []
  const flags: string[][] = []
  const sup = createSupervisor({
    cfg: { claudeBin: 'claude', home: '/h', model: 'claude-new' } as never,
    db: { getConversation: () => conv, undelivered: () => [{}], setSession() {}, setWorkerFlags: (_k: string, f: string[]) => { flags.push(f) } } as never,
    run: async args => {
      runs.push(args)
      if (args[1] === 'agents') return { code: 0, stdout: JSON.stringify([{ id: 'j1', name: 'tg-dm-1', sessionId: 's1', pid: 5, status: 'idle', cwd: '/f' }]), stderr: '' }
      if (args[1] === '--bg') return { code: 1, stdout: '', stderr: 'Workspace not trusted. Run `claude` in /f once and accept the trust prompt, then retry.' }
      return { code: 0, stdout: '', stderr: '' }
    },
    isConnected: () => false,
    waitConnected: async () => false,
    settingsPath: () => '/s.json',
    connectTimeoutMs: 10,
    jobFlags: () => ['--model', 'claude-old'],
    onWakeFail: (c, info) => { fails.push(info.spawnOut); tracker.fail(c.key, info.spawnOut ?? 'none') },
    holdUntil: k => tracker.until(k),
    release: k => tracker.release(k),
  })
  await sup.ensureAwake(conv)
  // running without its plugin: stopped by the wake; its job has the old model: stopped again (the list was read before) and removed; then a resume with every flag
  expect(runs.filter(a => a[1] !== 'agents').map(a => a.slice(1, 4).join(' '))).toEqual(['stop j1', 'stop j1', 'rm j1', '--bg --resume s1'])
  expect(runs.find(a => a[1] === '--bg')).toContain('claude-new')
  expect(fails).toEqual([expect.stringContaining('Workspace not trusted')])
  // a refused resume records no flags; the next wake within the hold does nothing
  expect(flags).toEqual([])
  const n = runs.length
  await sup.ensureAwake(conv)
  expect(runs.length).toBe(n)
})

test('StopFailure: the 1M context credits error, login, billing, rate limit, model, server, output, safeguards, anything else; each with what to do', () => {
  const m = apiAdvice({ error: 'invalid_request', message: 'API Error: Usage credits required for 1M context · run /usage-credits to turn them on' }, 'claude-sonnet-4-6[1m]')
  expect(m.reason).toBe('模型 claude-sonnet-4-6[1m] 用 1M context, 這個帳號沒有 1M context 的額度 (usage credits)')
  expect(m.fix).toContain('/router config set model claude-sonnet-4-6')
  expect(m.fix).toContain('/usage-credits')
  expect(m.short).toBe('這個模型需要 1M context 額度, 帳號目前沒有')
  expect(apiAdvice({ error: 'authentication_failed' }, 'x').fix).toContain('/login')
  expect(apiAdvice({ error: 'billing_error' }, 'x').short).toBe('Claude 帳號暫時不能用')
  expect(apiAdvice({ error: 'rate_limit' }, 'x').short).toBe('用量額度暫時用完')
  expect(apiAdvice({ error: 'model_not_found' }, 'claude-x').reason).toBe('找不到模型 claude-x')
  expect(apiAdvice({ error: 'overloaded' }, 'x').short).toBe('服務暫時忙碌')
  expect(apiAdvice({ error: 'max_output_tokens' }, 'x').short).toBe('回覆太長被截斷')
  expect(apiAdvice({ error: 'invalid_request', message: 'API Error: ... safeguards flagged this session' }, 'x').short).toBe('這個要求被安全機制擋下')
  expect(apiAdvice({ error: 'unknown', message: 'odd' }, 'x').reason).toBe('API 錯誤 (unknown)')
})

test('model and autoCompactWindow: native 1M models need nothing; Sonnet 4.6 and Opus 4.6 are 200K without [1m]; [1m] says what it needs; unknown models are left alone', () => {
  for (const m of ['claude-opus-5-5', 'claude-opus-4-7', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-haiku-5-5', 'opus', 'sonnet[1m]']) {
    expect(modelWindow(m), m).toEqual({ window: 1_000_000, credits: null })
    expect(modelWindowNotes(m, 750_000), m).toEqual([])
  }
  expect(modelWindow('claude-sonnet-4-6').window).toBe(200_000)
  expect(modelWindowNotes('claude-sonnet-4-6', 750_000)).toEqual(['autoCompactWindow 750000 大於模型 claude-sonnet-4-6 的 200000 context: Claude Code 會在 200000 就壓縮 (設定的值不會生效); 要更大的 context 改用 1M 的模型 (例如 claude-opus-5-5), 不然把 autoCompactWindow 設成 200000 以下'])
  expect(modelWindowNotes('claude-sonnet-4-6', 200_000)).toEqual([])
  expect(modelWindowNotes('claude-sonnet-4-6[1m]', 750_000)).toEqual(['模型 claude-sonnet-4-6[1m]: Sonnet 4.6 的 1M context 在所有方案都要 usage credits (沒有就會 Usage credits required for 1M context)'])
  expect(modelWindow('claude-opus-4-6[1m]').credits).toContain('Max, Team, Enterprise 方案內含')
  expect(modelWindow('claude-haiku-4-5').window).toBe(200_000)
  expect(modelWindow('my-gateway-model')).toEqual({ window: null, credits: null })
  expect(modelWindowNotes('my-gateway-model', 750_000)).toEqual([])
})

test('doctor: each check passing, then each failing; stray jobs and the daemon judged by router/jobs.ts; blocked and wedged workers; never a token', () => {
  const uh = join(dir, 'doc-home'), state = join(dir, 'doc-state'), home = join(dir, 'doc-cc')
  for (const d of [uh, state, home]) mkdirSync(d, { recursive: true })
  const bin = join(uh, 'bin')
  mkdirSync(bin)
  for (const f of ['bun', 'claude']) { writeFileSync(join(bin, f), '#!/bin/sh\n'); chmodSync(join(bin, f), 0o755) }
  // the unit with bin on its PATH, the plugin as deployed, the locator, trust
  mkdirSync(join(uh, '.config', 'systemd', 'user'), { recursive: true })
  writeFileSync(join(uh, '.config', 'systemd', 'user', 'cc-telegram-router.service'), `Environment=PATH=${bin}:/usr/bin\n`)
  const install = join(uh, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.7')
  mkdirSync(install, { recursive: true })
  writeFileSync(join(install, 'server.js'), 'x')
  writeFileSync(join(uh, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'telegram@claude-plugins-official': [{ installPath: install, scope: 'user' }] } }))
  writeFingerprint(state, install)
  const socket = join(state, 'router.sock')
  writeLocator({ home, stateDir: state, socket }, locatorPath(uh))
  writeFileSync(join(uh, '.claude.json'), JSON.stringify({ projects: { [home]: { hasTrustDialogAccepted: true } } }))
  const cfg = { home, stateDir: state, socket, model: 'claude-opus-5-5', autoCompactWindow: 750_000, claudeBin: 'claude', bots: [{ name: 'cc', token: TOKEN }] }
  const conv = (key: string, session: string, extra: Partial<Conversation> = {}) => ({ key, folder: join(home, 'bot1', key), session_id: session, ...extra }) as Conversation
  const convs = [conv('dm-1', 's1'), conv('dm-2', 's2', { model: 'claude-sonnet-4-6' })]
  const prevEnv = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  try {
    const which = (c: string) => c === 'bun' || c === 'claude' ? join(bin, c) : null
    const good = doctorReport({ cfg, userHome: uh, which, conversations: [convs[0]!], agents: [{ id: 'a1', name: 'tg-dm-1', sessionId: 's1', pid: 9, status: 'idle', state: 'done', cwd: convs[0]!.folder }, { id: 'zz', name: 'tg-agent', sessionId: 'x' }], jobs: [], procs: [], isConnected: () => true, version: '9.9.9' })
    expect(good.split('\n')).toEqual([
      'cc-telegram-router doctor 9.9.9 (經由執行中的 router)',
      '✅ bun 與 claude (claude) 在 systemd unit 的 PATH 找得到',
      `✅ telegram plugin 裝在這個使用者 (${join(uh, '.claude', 'plugins')}), 跟部署時相同`,
      `✅ 位置檔 ${locatorPath(uh)} 指向這個 router`,
      `✅ home ${home} 已被 Claude Code 信任 (它自己)`,
      '✅ 預設模型 claude-opus-5-5, autoCompactWindow 750000',
      '✅ daemon 的 job 都是對話目前的 session',
      '✅ claude daemon: 沒有在跑 (下一次叫醒 worker 時由 router 帶起)',
      '✅ 在跑的 worker 的 plugin 都連上了',
    ])
    // now everything wrong
    writeFileSync(join(uh, '.config', 'systemd', 'user', 'cc-telegram-router.service'), 'Environment=PATH=/usr/bin\n')
    writeFileSync(join(install, 'server.js'), 'changed')
    writeLocator({ home: '/elsewhere', stateDir: state, socket: '/elsewhere.sock' }, locatorPath(uh))
    writeFileSync(join(uh, '.claude.json'), JSON.stringify({ projects: {} }))
    const badOut = doctorReport({ cfg: { ...cfg, model: 'claude-sonnet-4-6' }, userHome: uh, which, conversations: convs, agents: [{ id: 'a1', name: 'tg-dm-1', sessionId: 'old', pid: 9, status: 'idle', cwd: convs[0]!.folder }, { id: 'a2', name: 'tg-dm-2', sessionId: 's2', pid: 8, status: 'idle', state: 'blocked', cwd: convs[1]!.folder }], jobs: [{ id: 'j9', name: 'tg-dm-2', sessionId: 'older', cwd: convs[1]!.folder }], procs: [{ pid: 42, ppid: 1, args: ['claude', 'daemon', 'run', '--spawned-by', JSON.stringify({ label: 'terminal', cwd: '/somewhere/else' })] }, { pid: 43, ppid: 7, args: ['claude', '--bg-pty-host', '/run/x/spare/a.pty.sock'] }], isConnected: () => false })
    for (const t of ['⚠️ unit 的 PATH 找不到 bun', '⚠️ telegram plugin: ', '❌ 位置檔指向另一個 router', `❌ home ${home} 沒有被 Claude Code 信任`, `cd ${home} && claude`, '⚠️ 預設: autoCompactWindow 750000 大於模型 claude-sonnet-4-6', '⚠️ dm-2: autoCompactWindow 750000', 'daemon 裡有不是對話目前 session 的 job (router 啟動後 5 秒與每 10 分鐘自動清掉): dm-1 的 a1 (在跑), dm-2 的 j9', '⚠️ claude daemon (pid 42) 不是由 router 帶起的, 而是 /somewhere/else 的 terminal.', '⚠️ 有 1 個 Claude Code 的暖機 spare 程序沒有 daemon 在管 (pid 43)', 'ℹ️ 上一輪結尾在等人回應 (Claude Code 的判讀, 不影響收訊): tg-dm-2', '這些 worker 在跑但 plugin 沒有連上 router: dm-2']) expect(badOut).toContain(t)
    expect(badOut).not.toContain('卡住 (blocked)')
    for (const out of [good, badOut]) expect(out).not.toContain(TOKEN.split(':')[1]!)
    expect(doctorReport({ cfg, userHome: join(dir, 'nobody'), which: () => null, agents: null })).toContain('claude agents --json --all 失敗')
  } finally { if (prevEnv !== undefined) process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = prevEnv }
})

test('/router status shows each worker\'s trouble next to it', () => {
  const c = { key: 'dm-1', bot: 'cc', chat_id: '1', type: 'dm', role: 'owner', created_at: new Date().toISOString(), last_seen: new Date().toISOString() } as unknown as Conversation
  const out = renderStatus(Date.now(), new Date(), [{ name: 'cc', username: 'cc_bot', first_name: 'cc' }], [c], { isConnected: () => false, label: () => 'Boss', backlog: () => 2, health: () => ['⚠️ worker 卡住: rate limited — wait and retry', '⚠️ 13:05 資料夾沒有被信任 (Workspace not trusted)'] })
  expect(out).toContain('Boss (待送 2, ⚠️ worker 卡住: rate limited — wait and retry, ⚠️ 13:05 資料夾沒有被信任 (Workspace not trusted))')
  expect(existsSync(dir)).toBe(true)
})

// docs/operations.md 「cli doctor 與 worker 狀態」: Claude Code's blocked is
// trouble only for a prompt on the worker's window (waitingFor) or an API,
// login or limit error (the job's state.json needs); its end-of-turn reading
// of a reply that asks or waits for approval is a note, not a warning.
test('blocked: a prompt on the window or an API error warns with what it needs; a turn that ended waiting on a person is only a note (doctor and /router status)', () => {
  const jobsDir = join(dir, 'blocked-jobs')
  const job = (id: string, state: object) => { mkdirSync(join(jobsDir, id), { recursive: true }); writeFileSync(join(jobsDir, id, 'state.json'), JSON.stringify(state)) }
  job('j2', { name: 'tg-dm-2', sessionId: 's2', state: 'working', tempo: 'blocked', needs: 'rate limited \u2014 wait and retry' })
  job('j3', { name: 'tg-dm-3', sessionId: 's3', state: 'working', tempo: 'blocked', needs: 'Reply /router skill approve bookmarks' })
  job('j5', { name: 'tg-dm-5', sessionId: 's5', state: 'blocked', tempo: 'blocked', needs: 'login required \u2014 run /login' })
  const jobs = listJobs(jobsDir)
  expect(jobs.find(j => j.id === 'j2')?.needs).toBe('rate limited \u2014 wait and retry')
  const agents = [
    { id: 'j1', name: 'tg-dm-1', sessionId: 's1', pid: 1, status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' },
    { id: 'j2', name: 'tg-dm-2', sessionId: 's2', pid: 2, status: 'idle', state: 'blocked' },
    { id: 'j3', name: 'tg-dm-3', sessionId: 's3', pid: 3, status: 'idle', state: 'blocked' },
    { id: 'j4', name: 'tg-dm-4', sessionId: 's4', state: 'blocked' },
    { id: 'x5', name: 'tg-dm-5', sessionId: 's5', state: 'blocked' },
    { id: 'j6', name: 'tg-dm-6', sessionId: 's6', pid: 6, status: 'busy', state: 'working' },
    { id: 'j7', name: 'tg-dm-7', sessionId: 's7', state: 'failed' },
  ]
  expect(agents.map(a => blockedWhy(a, jobs))).toEqual([
    { warn: true, text: '畫面停在 permission prompt' },
    { warn: true, text: 'rate limited \u2014 wait and retry' },
    { warn: false },
    { warn: false },
    { warn: true, text: 'login required \u2014 run /login' },
    null,
    null,
  ])
  expect(TURN_END_NOTE).toBe('上一輪結尾在等人回應 (Claude Code 的判讀, 不影響收訊)')
  expect([...agents.map(a => workerStateNote(a, jobs)), workerStateNote(undefined, jobs)]).toEqual([
    '⚠️ worker 卡住: 畫面停在 permission prompt',
    '⚠️ worker 卡住: rate limited \u2014 wait and retry',
    TURN_END_NOTE,
    TURN_END_NOTE,
    '⚠️ worker 卡住: login required \u2014 run /login',
    null,
    'worker failed',
    null,
  ])
  const home = join(dir, 'blocked-home')
  const convs = [1, 2, 3, 4, 5, 6, 7].map(n => ({ key: `dm-${n}`, folder: join(home, `dm-${n}`), session_id: `s${n}` }) as Conversation)
  const lines = doctorReport({ cfg: { home, stateDir: join(dir, 'blocked-state'), socket: join(dir, 'blocked.sock'), model: 'claude-opus-5-5', autoCompactWindow: 750_000, claudeBin: 'claude', bots: [] }, userHome: join(dir, 'nobody'), which: () => null, conversations: convs, agents, jobs }).split('\n')
  expect(lines).toContain('⚠️ 這些 worker 卡住 (blocked): tg-dm-1 (畫面停在 permission prompt), tg-dm-2 (rate limited \u2014 wait and retry), tg-dm-5 (login required \u2014 run /login)')
  expect(lines).toContain('ℹ️ 上一輪結尾在等人回應 (Claude Code 的判讀, 不影響收訊): tg-dm-3, tg-dm-4')
  // only turn-end blocked: no warning line at all
  const calm = doctorReport({ cfg: { home, stateDir: join(dir, 'blocked-state'), socket: join(dir, 'blocked.sock'), model: 'claude-opus-5-5', autoCompactWindow: 750_000, claudeBin: 'claude', bots: [] }, userHome: join(dir, 'nobody'), which: () => null, conversations: convs, agents: [agents[2]!], jobs })
  expect(calm).not.toContain('卡住')
  expect(calm).toContain('ℹ️ 上一輪結尾在等人回應 (Claude Code 的判讀, 不影響收訊): tg-dm-3')
})
