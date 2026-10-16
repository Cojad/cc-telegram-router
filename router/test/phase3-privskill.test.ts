// Privileged skill actions, the skill's sudo bit (plan 10d). Real bwrap runs:
// a user conversation runs an approved action without elevation, the
// credentials are usable by the script but never come back, the rest of the
// machine stays hidden, the skill cannot be changed, a changed skill stops,
// refused credentials are refreshed once. Keep in sync with plan 10d,
// README 「特權技能」 and /telegram:bot-skill.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openRouterDb, type RouterDb } from '../db'
import { buildArgv, hashSkill, secretsIn, scrubOutputs, redact } from '../privskill'
import { runSkill, type SkillRunDeps } from '../skillrun'
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
