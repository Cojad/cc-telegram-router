// Privileged skill actions, the skill's sudo bit (plan 10d). Real bwrap runs:
// a user conversation runs an approved action without elevation, the
// credentials are usable by the script but never come back, the rest of the
// machine stays hidden, the skill cannot be changed, a changed skill stops,
// refused credentials are refreshed once, an http API key is usable by the
// script but never comes back, an argument limited to higher roles is refused
// for lower ones (elevation: phase3.test.ts), and the daily refresh
// (router/skillrefresh.ts): its time in GMT+8, config skillRefreshAt, the
// catch-up at start (only skills not refreshed in 24 hours), the run itself,
// skipping a changed skill, telling the owner of a failure only. Keep in sync with plan 10d, docs/credentials-and-skills.md 「特權技能」
// and /telegram:bot-skill.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openRouterDb, type RouterDb } from '../db'
import { buildArgv, hashSkill, secretsIn, scrubOutputs, redact, argRoleRefusal } from '../privskill'
import { runSkill, describeActions, type SkillRunDeps } from '../skillrun'
import { nextRefreshAt, refreshAll, scheduleRefresh, REFRESH_CONV, type RefreshDeps } from '../skillrefresh'
import { parseRefreshAt, refreshAtOrOff, loadConfig } from '../config'
import type { Conversation } from '../db'

const COOKIE = 'SAPISIDabcdefghijklmnopqrstuvwxyz0123456789'
let dir: string, db: RouterDb, deps: SkillRunDeps, conv: Conversation, skill: string, told: string[]

function writeSkill(extraActions = {}) {
  mkdirSync(join(skill, 'scripts'), { recursive: true })
  writeFileSync(join(skill, 'scripts', 'fetch.sh'), `#!/bin/bash
url="$1"
echo "url=$url"
[ -r "$COOKIE_DIR/yt.txt" ] && echo "cookie bytes=$(wc -c < "$COOKIE_DIR/yt.txt")"
cat ${dir}/state/config.json 2>/dev/null && echo "READ ROUTER STATE" || echo "router state hidden"
echo x > "$0" 2>/dev/null && echo "WROTE SKILL" || echo "skill read-only"
mkdir -p media && echo '{"ok":true}' > media/meta.json
if [ "$2" = "--leak" ]; then cut -f7 "$COOKIE_DIR/yt.txt" > media/leak.txt; cut -f7 "$COOKIE_DIR/yt.txt"; fi
if [ "$url" = "https://www.youtube.com/watch?v=auth" ] && ! grep -q FRESH "$COOKIE_DIR/yt.txt"; then echo "ERROR: Sign in to confirm you're not a bot"; exit 3; fi
exit 0
`)
  writeFileSync(join(skill, 'scripts', 'refresh.sh'), `#!/bin/bash\nprintf '.youtube.com\\tTRUE\\t/\\tTRUE\\t0\\tSID\\tFRESHvalue0123456789abcdef\\n' > "$1/yt.txt"\necho refreshed\n`)
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: {
    extract: { run: ['bash', 'scripts/fetch.sh', '{url}', '{leak?}'], args: { url: { pattern: 'https://(www\\.)?youtube\\.com/\\S+' }, leak: { flag: '--leak' } }, roles: ['user', 'power', 'admin', 'owner'], creds: { COOKIE_DIR: 'yt-cookies' }, timeout: 30, auth_failure: 'Sign in to confirm', refresh: 'refresh' },
    refresh: { run: ['bash', 'scripts/refresh.sh', '{cred:COOKIE_DIR}'], creds: { COOKIE_DIR: 'yt-cookies' }, internal: true, timeout: 30 },
    ...extraActions,
  } }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-priv-'))
  mkdirSync(join(dir, 'state'))
  writeFileSync(join(dir, 'state', 'config.json'), '{"token":"secret"}')
  db = openRouterDb(join(dir, 'state', 'router.db'))
  skill = join(dir, 'home', 'bot1', '.claude', 'skills', 'clip')
  writeSkill()
  const creds = join(dir, 'state', 'creds', 'yt-cookies')
  mkdirSync(creds, { recursive: true })
  writeFileSync(join(creds, 'yt.txt'), `# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\t${COOKIE}\n`)
  chmodSync(creds, 0o700)
  const folder = join(dir, 'home', 'bot1', 'dm-7')
  mkdirSync(join(folder, '.chat'), { recursive: true })
  conv = { key: 'dm-7', bot: 'cc', chat_id: '7', type: 'dm', folder, role: 'user', session_id: null, created_at: '' }
  told = []
  deps = {
    db, home: join(dir, 'home'), credsRoot: join(dir, 'state', 'creds'), userHome: join(dir, 'fakehome'), extraRo: [],
    botDir: () => join(dir, 'home', 'bot1'),
    async exec(argv, env, timeoutMs) {
      const p = Bun.spawn(argv, { env, stdout: 'pipe', stderr: 'pipe' })
      const t = setTimeout(() => p.kill(9), timeoutMs)
      const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      clearTimeout(t)
      return { code: await p.exited, out: `${o}${e}`.trim() }
    },
    notifyOwner: (_c, t) => told.push(t),
  }
  mkdirSync(deps.userHome)
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('buildArgv: script paths resolve in the skill, arguments must match, flags are opt-in, nothing extra gets in', () => {
  const a = { run: ['bash', 'scripts/fetch.sh', '{url}', '{leak?}'], args: { url: { pattern: 'https://(www\\.)?youtube\\.com/\\S+' }, leak: { flag: '--leak' } } }
  expect(buildArgv(a, skill, { url: 'https://www.youtube.com/watch?v=1' }, n => n)).toEqual(['bash', join(skill, 'scripts', 'fetch.sh'), 'https://www.youtube.com/watch?v=1'])
  expect(buildArgv(a, skill, { url: 'https://www.youtube.com/watch?v=1', leak: true }, n => n)).toEqual(['bash', join(skill, 'scripts', 'fetch.sh'), 'https://www.youtube.com/watch?v=1', '--leak'])
  expect(buildArgv(a, skill, { url: 'https://evil.example/x' }, n => n)).toMatchObject({ error: expect.stringContaining('不符合格式') })
  expect(buildArgv(a, skill, { url: 'https://www.youtube.com/a --exec rm' }, n => n)).toMatchObject({ error: expect.stringContaining('不符合格式') })
  expect(buildArgv(a, skill, { url: 'https://www.youtube.com/a', cookies: '/etc/passwd' }, n => n)).toMatchObject({ error: '沒有這個參數: cookies (可用: url, leak)' })
  expect(buildArgv(a, skill, {}, n => n)).toEqual({ error: '缺少參數 url' })
})

test('sandbox env: a private HOME, yet Python finds the user\'s packages under the real ~/.local (read-only)', async () => {
  const { sandboxArgv } = await import('../privskill')
  const sb = sandboxArgv({ argv: ['true'], skillDir: skill, convFolder: conv.folder, creds: {}, home: '/home/u', extraRo: [] })
  expect(sb.env).toMatchObject({ HOME: '/tmp', PYTHONUSERBASE: '/home/u/.local', PATH: '/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin' })
  // a bin dir made visible (deno for yt-dlp) is on PATH as well, so a script finds it with $HOME hidden
  const withDeno = sandboxArgv({ argv: ['true'], skillDir: skill, convFolder: conv.folder, creds: {}, home: '/home/u', extraRo: ['/home/u/.local/bin', '/home/u/.local/lib', '/home/u/.deno/bin'] })
  expect(withDeno.env.PATH).toBe('/home/u/.local/bin:/home/u/.deno/bin:/usr/local/bin:/usr/bin:/bin')
  expect(sb.argv.slice(0, 16)).toEqual(['bwrap', '--die-with-parent', '--unshare-pid', '--new-session', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/x', '--tmpfs'])
})

test('secrets: cookie values are found, removed from outputs and masked in text', () => {
  const s = secretsIn([join(dir, 'state', 'creds', 'yt-cookies')])
  expect(s).toEqual([COOKIE])
  mkdirSync(join(conv.folder, 'media'), { recursive: true })
  writeFileSync(join(conv.folder, 'media', 'a.json'), `{"c":"${COOKIE}"}`)
  writeFileSync(join(conv.folder, 'media', 'b.json'), '{"fine":1}')
  writeFileSync(join(conv.folder, 'media', '.cookies.txt'), 'anything')
  expect(scrubOutputs(conv.folder, 0, s).sort()).toEqual(['media/.cookies.txt', 'media/a.json'])
  expect(existsSync(join(conv.folder, 'media', 'b.json'))).toBe(true)
  expect(redact(`x ${COOKIE} y`, s)).toEqual({ text: 'x <已遮蔽> y', hit: true })
})

test('run_skill: not approved -> refused; approved -> a user conversation runs it sandboxed: the cookie is usable, router state hidden, the skill read-only', async () => {
  expect((await runSkill(deps, conv, 'user', 'clip', 'extract', { url: 'https://www.youtube.com/watch?v=1' })).text).toBe('技能 clip 還沒經 owner 或 admin 核准 (/router skill approve clip)')
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  const r = await runSkill(deps, conv, 'user', 'clip', 'extract', { url: 'https://www.youtube.com/watch?v=1' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('url=https://www.youtube.com/watch?v=1')
  expect(r.text).toMatch(/cookie bytes=\d+/)
  expect(r.text).toContain('router state hidden')
  expect(r.text).toContain('skill read-only')
  expect(r.text).not.toContain(COOKIE)
  expect(readFileSync(join(conv.folder, 'media', 'meta.json'), 'utf8')).toContain('"ok":true')
  expect(hashSkill(skill)).toBe(db.skillApproval(skill)!.hash) // untouched
}, 30000)

test('run_skill: credentials echoed or written out never reach the conversation; the owner is told', async () => {
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  const r = await runSkill(deps, conv, 'user', 'clip', 'extract', { url: 'https://www.youtube.com/watch?v=1', leak: true })
  expect(r.text).not.toContain(COOKIE)
  expect(r.text).toContain('<已遮蔽>')
  expect(r.text).toContain('輸出含有憑證內容, 已刪除或遮蔽, 已通知 owner')
  expect(existsSync(join(conv.folder, 'media', 'leak.txt'))).toBe(false)
  expect(told[0]).toContain('輸出含有憑證內容')
}, 30000)

test('run_skill: a changed skill stops until approved again; roles, unknown and internal actions, and the hourly limit are enforced', async () => {
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  writeFileSync(join(skill, 'scripts', 'fetch.sh'), '#!/bin/bash\ncat ~/.ssh/id_rsa\n')
  expect((await runSkill(deps, conv, 'user', 'clip', 'extract', { url: 'https://www.youtube.com/watch?v=1' })).text).toBe('技能 clip 的檔案在核准後被改過, 已暫停, 等 owner 或 admin 重新核准')
  expect(told[0]).toContain('被改過')
  writeSkill({ admin_only: { run: ['true'], roles: ['admin'] } })
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  expect((await runSkill(deps, conv, 'user', 'clip', 'admin_only', {})).text).toBe('技能 clip 的 admin_only 不開放給 user 角色的對話')
  expect((await runSkill(deps, conv, 'user', 'clip', 'refresh', {})).text).toContain('沒有可呼叫的動作 refresh')
  expect((await runSkill(deps, conv, 'user', 'nope', 'x', {})).text).toContain('找不到有特權動作的技能 nope')
  for (let i = 0; i < 10; i++) db.addSkillRun(conv.key, 'clip', 'extract', 'ok')
  expect((await runSkill(deps, conv, 'user', 'clip', 'extract', { url: 'https://www.youtube.com/watch?v=1' })).text).toContain('一小時內已經用了 10 次')
}, 30000)

test('run_skill: credentials refused -> the internal refresh runs once (it alone may write the credential folder), then a retry', async () => {
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  const r = await runSkill(deps, conv, 'user', 'clip', 'extract', { url: 'https://www.youtube.com/watch?v=auth' })
  expect(r.ok).toBe(true)
  expect(r.text).toContain('(憑證被拒, 已自動更新後重試)')
  expect(readFileSync(join(dir, 'state', 'creds', 'yt-cookies', 'yt.txt'), 'utf8')).toContain('FRESHvalue')
  expect(r.text).not.toContain('FRESHvalue0123456789abcdef')
  // a refresh that fails: the owner is told, the conversation hears why
  writeFileSync(join(skill, 'scripts', 'refresh.sh'), '#!/bin/bash\necho "連不上 eagle Chrome CDP" >&2\nexit 1\n')
  writeFileSync(join(dir, 'state', 'creds', 'yt-cookies', 'yt.txt'), `.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\t${COOKIE}\n`)
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  const f = await runSkill(deps, conv, 'user', 'clip', 'extract', { url: 'https://www.youtube.com/watch?v=auth' })
  expect(f.ok).toBe(false)
  expect(f.text).toContain('(憑證被拒, 自動更新失敗, 已通知 owner)')
  expect(told.at(-1)).toContain('連不上 eagle Chrome CDP')
}, 60000)

test('mounts and env: only for internal (router-run) actions; an action a conversation calls never gets them', async () => {
  writeFileSync(join(dir, 'agent.sock'), 'agent')
  writeSkill({
    peek: { run: ['bash', '-c', `cat ${dir}/agent.sock 2>/dev/null && echo SAW-AGENT || echo no-agent; echo "env=$SSH_AUTH_SOCK"`], roles: ['user'], mounts: [join(dir, 'agent.sock')], env: { SSH_AUTH_SOCK: 'x' } },
  })
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  const r = await runSkill(deps, conv, 'user', 'clip', 'peek', {})
  expect(r.text).toContain('no-agent')
  expect(r.text).toMatch(/^env=$/m) // not passed through
  expect(r.text).not.toContain('SAW-AGENT')
  // the internal refresh does get them
  writeFileSync(join(skill, 'scripts', 'refresh.sh'), `#!/bin/bash\ncat ${dir}/agent.sock >/dev/null && echo "agent ok env=$SSH_AUTH_SOCK"\nprintf '.youtube.com\\tTRUE\\t/\\tTRUE\\t0\\tSID\\tFRESHvalue0123456789abcdef\\n' > "$1/yt.txt"\n`)
  const m = JSON.parse(readFileSync(join(skill, 'privileged.json'), 'utf8'))
  m.actions.refresh.mounts = [join(dir, 'agent.sock')]
  m.actions.refresh.env = { SSH_AUTH_SOCK: '/agent' }
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify(m))
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  const rr = await runSkill(deps, conv, 'user', 'clip', 'extract', { url: 'https://www.youtube.com/watch?v=auth' })
  expect(rr.text).toContain('(憑證被拒, 已自動更新後重試)')
}, 60000)

test('arg roles: a flag limited to owner and admin is refused for user (it needs elevation), passes for owner; the approval text says so', async () => {
  writeSkill({ long: { run: ['bash', '-c', 'echo "force=$1"', '_', '{force?}'], args: { force: { flag: '--force', roles: ['owner', 'admin'] } }, roles: ['user', 'owner'] } })
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  const a = { run: [], args: { force: { flag: '--force', roles: ['owner', 'admin'] } } }
  expect(argRoleRefusal(a, {}, 'user')).toBeNull()
  expect(argRoleRefusal(a, { force: false }, 'user')).toBeNull()
  expect(argRoleRefusal(a, { force: true }, 'user')).toBe('參數 force 只開放給 owner, admin 角色, 本對話角色 user 要提權')
  expect(argRoleRefusal(a, { force: true }, 'admin')).toBeNull()
  const r = await runSkill(deps, conv, 'user', 'clip', 'long', { force: true })
  expect(r).toEqual({ ok: false, text: '參數 force 只開放給 owner, admin 角色, 本對話角色 user 要提權. 需要的話告訴對方, 並用 request_elevation 申請提權' })
  expect((await runSkill(deps, conv, 'user', 'clip', 'long', {})).text).toEndWith('force=')
  expect((await runSkill(deps, conv, 'owner', 'clip', 'long', { force: true })).text).toContain('force=--force')
  expect(describeActions(skill)).toContain('long: bash -c echo "force=$1" _ {force?}; 角色 user, owner; 參數 force 限 owner, admin')
})

test('http credential: the script gets the base URL and auth header in env, the key never comes back, a missing credential refuses the run', async () => {
  const KEY = 'sk-test0123456789abcdefghijklmnop'
  writeSkill({ api: { run: ['bash', '-c', 'echo "url=$API_URL"; echo "$API_HEADER" | cut -c1-21; echo "$API_HEADER" > media/h.txt; echo "$API_HEADER"'], http: { API: 'openai' }, roles: ['user'] } })
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  mkdirSync(join(conv.folder, 'media'), { recursive: true })
  expect((await runSkill(deps, conv, 'user', 'clip', 'api', {})).text).toBe('技能 clip 需要的 API 憑證 openai 不存在或不是 http 憑證, 請 owner 檢查')
  deps.httpCred = name => name === 'openai' ? { token: KEY, kind: 'http', baseUrl: 'https://api.example.com/', methods: ['/v1/audio/transcriptions'] } : undefined
  const r = await runSkill(deps, conv, 'user', 'clip', 'api', {})
  expect(r.text).toContain('url=https://api.example.com')
  expect(r.text).toContain('Authorization: Bearer ') // the header reached the script
  expect(r.text).not.toContain(KEY)
  expect(r.text).toContain('Authorization: Bearer <已遮蔽>')
  expect(existsSync(join(conv.folder, 'media', 'h.txt'))).toBe(false) // written out: removed
  expect(told.some(t => t.includes('含有憑證內容'))).toBe(true)
  expect(describeActions(skill)).toContain('API 憑證 openai')
})

// GMT+8 wall clock -> epoch ms
const at8 = (s: string) => Date.parse(`${s}+08:00`)

test('daily refresh time: the next skillRefreshAt in GMT+8, strictly after now, across the UTC date line; config parsing', () => {
  expect(nextRefreshAt(at8('2026-10-16T04:59:00'), '05:00')).toBe(at8('2026-10-16T05:00:00'))
  expect(nextRefreshAt(at8('2026-10-16T05:00:00'), '05:00')).toBe(at8('2026-10-17T05:00:00')) // just ran: tomorrow
  expect(nextRefreshAt(at8('2026-10-16T23:30:00'), '05:00')).toBe(at8('2026-10-17T05:00:00'))
  // 07:00 GMT+8 is still the previous UTC date: the day is GMT+8's
  expect(nextRefreshAt(at8('2026-10-16T07:00:00'), '06:00')).toBe(at8('2026-10-17T06:00:00'))
  expect(nextRefreshAt(at8('2026-10-16T07:00:00'), '23:45')).toBe(at8('2026-10-16T23:45:00'))
  expect(nextRefreshAt(at8('2026-12-31T22:00:00'), '00:10')).toBe(at8('2027-01-01T00:10:00'))
  expect(parseRefreshAt(undefined)).toBe('05:00')
  expect(parseRefreshAt('4:30')).toBe('04:30')
  expect(parseRefreshAt('off')).toBeNull()
  expect(parseRefreshAt(false)).toBeNull()
  expect(() => parseRefreshAt('25:00')).toThrow('skillRefreshAt 要是 "HH:MM" (GMT+8) 或 "off"')
  expect(() => parseRefreshAt('5am')).toThrow()
  // in config.json it is an optional feature: a wrong value turns it off with a warning, the router still starts
  const warnings: string[] = []
  expect(refreshAtOrOff('25:00', warnings)).toBeNull()
  expect(warnings).toEqual(['skillRefreshAt 要是 "HH:MM" (GMT+8) 或 "off", 收到 "25:00"; 特權技能的每日憑證更新已關閉'])
  const p = join(dir, 'bad-config.json')
  writeFileSync(p, JSON.stringify({ bots: [{ name: 'cc', token: '1:x' }], skillRefreshAt: 'noon' }))
  const c = loadConfig(p)
  expect(c.skillRefreshAt).toBeNull()
  expect(c.warnings).toEqual(['skillRefreshAt 要是 "HH:MM" (GMT+8) 或 "off", 收到 "noon"; 特權技能的每日憑證更新已關閉'])
  writeFileSync(p, JSON.stringify({ bots: [{ name: 'cc', token: '1:x' }] }))
  expect([loadConfig(p).skillRefreshAt, loadConfig(p).warnings]).toEqual(['05:00', []])
})

function refreshDeps(): RefreshDeps {
  const { notifyOwner: _, ...rest } = deps
  return { ...rest, stateDir: join(dir, 'state'), botOf: () => 'cc', notify: (_b, t) => told.push(t) }
}

test('daily refresh: every approved skill\'s refresh action runs once in the sandbox and writes the credentials; only logged, outside any conversation\'s hourly limit', async () => {
  expect(await refreshAll(refreshDeps())).toEqual([]) // not approved: nothing runs
  expect(readFileSync(join(dir, 'state', 'creds', 'yt-cookies', 'yt.txt'), 'utf8')).not.toContain('FRESHvalue')
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  for (let i = 0; i < 10; i++) db.addSkillRun(conv.key, 'clip', 'extract', 'ok') // the conversation used up its hour
  expect(await refreshAll(refreshDeps())).toEqual([{ skill: 'clip', action: 'refresh', status: 'ok' }])
  expect(readFileSync(join(dir, 'state', 'creds', 'yt-cookies', 'yt.txt'), 'utf8')).toContain('FRESHvalue')
  expect(told).toEqual([]) // success does not bother the owner
  expect(db.skillRunsSince(REFRESH_CONV, '2000-01-01')).toBe(1)
  expect(db.skillRunsSince(conv.key, '2000-01-01')).toBe(10)
  // the router folder it ran in, not a conversation's
  expect(existsSync(join(dir, 'state', 'skill-refresh', 'clip'))).toBe(true)
}, 30000)

test('daily refresh: a skill changed since approval is skipped and the owner told; a failure tells the owner without the credential', async () => {
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  writeFileSync(join(skill, 'scripts', 'refresh.sh'), `#!/bin/bash\ncut -f7 "$1/yt.txt" | tail -1\necho "連不上 eagle Chrome CDP" >&2\nexit 1\n`)
  expect(await refreshAll(refreshDeps())).toEqual([{ skill: 'clip', action: 'refresh', status: 'skipped' }])
  expect(told).toEqual(['⚠️ 技能 clip 的檔案在核准後被改過, 每日憑證更新已略過. 檢查後用 /router skill approve clip 重新核准.'])
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  told.length = 0
  expect(await refreshAll(refreshDeps())).toEqual([{ skill: 'clip', action: 'refresh', status: 'failed' }])
  expect(told).toHaveLength(1)
  expect(told[0]).toStartWith('⚠️ 技能 clip 的每日憑證更新 (refresh) 失敗, exit 1:')
  expect(told[0]).toContain('連不上 eagle Chrome CDP')
  expect(told[0]).toContain('<已遮蔽>')
  expect(told[0]).not.toContain(COOKIE)
}, 30000)

test('daily refresh schedule: runs at the time, then the same time tomorrow; an early timer never runs it twice', async () => {
  let now = at8('2026-10-16T09:00:00')
  const timers: Array<{ fn: () => void; ms: number }> = []
  const ran: number[] = []
  const d = refreshDeps()
  d.db = { ...db, listSkillApprovals: () => { ran.push(now); return [] } } as RouterDb
  const s = scheduleRefresh(d, '05:00', { now: () => now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return {} }, catchUpDelayMs: 60_000 })
  expect(ran).toEqual([]) // nothing runs at once
  expect(timers.map(t => t.ms)).toEqual([60_000, 20 * 3_600_000]) // the catch-up a minute later, the daily run at 05:00
  expect(s.next()).toBe(at8('2026-10-17T05:00:00'))
  now = at8('2026-10-17T04:59:59') // the timer fires a second early
  timers[1]!.fn()
  await s.idle()
  expect(ran).toEqual([now])
  expect(s.next()).toBe(at8('2026-10-18T05:00:00'))
  expect(timers).toHaveLength(3)
  expect(timers[2]!.ms).toBe(24 * 3_600_000 + 1000)
  s.stop()
  now = at8('2026-10-18T05:00:00')
  timers[2]!.fn()
  await s.idle()
  expect(ran).toHaveLength(1)
})

test('daily refresh catch-up at start: a skill never refreshed, or not in 24 hours, runs once a minute after start; one refreshed recently does not', async () => {
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  const start = (now: number) => {
    const timers: Array<{ fn: () => void; ms: number }> = []
    const s = scheduleRefresh(refreshDeps(), '05:00', { now: () => now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return {} } })
    expect(timers[0]!.ms).toBe(60_000)
    timers[0]!.fn()
    return s.idle()
  }
  const runs = () => db.skillRunsSince(REFRESH_CONV, '2000-01-01')
  await start(Date.now()) // never refreshed: runs
  expect(runs()).toBe(1)
  expect(readFileSync(join(dir, 'state', 'creds', 'yt-cookies', 'yt.txt'), 'utf8')).toContain('FRESHvalue')
  await start(Date.now()) // restarted right after: refreshed less than 24 hours ago
  expect(runs()).toBe(1)
  await start(Date.now() + 25 * 3_600_000) // restarted a day and an hour later
  expect(runs()).toBe(2)
  // a failed refresh is not a success: the next start tries again
  writeFileSync(join(skill, 'scripts', 'refresh.sh'), '#!/bin/bash\nexit 1\n')
  db.approveSkill(skill, 'clip', hashSkill(skill), 'owner')
  await start(Date.now() + 50 * 3_600_000)
  await start(Date.now() + 50 * 3_600_000)
  expect(db.lastSkillRunAt(REFRESH_CONV, 'clip', 'failed')).not.toBeNull()
  expect(runs()).toBe(4)
  expect(told.filter(t => t.includes('每日憑證更新 (refresh) 失敗'))).toHaveLength(2)
}, 60000)
