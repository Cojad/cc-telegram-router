// A DM's role is its user's role (docs/permissions.md 「角色」 私訊; docs/operations.md
// /router role, /router perm, /router status). Covers: every read of a DM
// takes users.role (config owners are owner), the settings of a user's DMs
// are rewritten and rotated when the role changes, /router perm <私訊> role
// is /router role, perm overrides stay on top, status shows the user's role,
// and DMs stored with a role of their own are aligned (startup migration;
// through the real router: e2e-dmrole.test.ts). Keep in sync with those
// sections and docs/testing.md 驗收對照.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import type { Config } from '../config'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { ensureConversation } from '../conversations'
import { runCommand, type CommandDeps, type CommandInput } from '../commands'
import { renderSettings, applyOverrides } from '../settings'
import { createElevation } from '../elevation'
import { createToolHistory, hookUse } from '../toolhistory'
import { buildContext } from '../context'
import type { ApprovalDeps } from '../approvals'
import type { Access } from '../telegram/policy'

const TEMPLATES = join(import.meta.dir, '..', '..', 'templates')
const OWNER = '137438526', ADMIN = '500', MEMBER = '700100200', GROUP = '-1009990000001'
let dir: string, cfg: Config, db: RouterDb, applied: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-dmrole-'))
  mkdirSync(join(dir, '.router'))
  cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }, { name: 'two', token: '2:y' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, '.router', 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude' }
  db = openRouterDb(join(dir, '.router', 'router.db'), { owners: cfg.owners })
  db.setUserRole(ADMIN, 'admin')
  applied = []
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const vars = (c: Conversation) => ({ folder: c.folder, hidden: ['/srv/cc'], autoCompactWindow: 750000, hooksDir: '/h' })
const effective = (c: Conversation) => applyOverrides(renderSettings(TEMPLATES, c.role, vars(c)), db.listOverrides(c.key)) as any
function deps(): CommandDeps {
  const access: Access = { dmPolicy: 'allowlist', allowFrom: [OWNER, ADMIN, MEMBER], groups: {}, pending: {} } as Access
  return {
    cfg, db,
    loadAccess: () => structuredClone(access),
    saveAccess: () => {},
    bots: { async list() { return [{ name: 'cc', id: 1, username: 'cc_bot', first_name: 'cc' }, { name: 'two', id: 2, username: 'two_bot', first_name: 'two' }] }, async add() { return '' }, async rotate() { return '' }, async remove() {} },
    sessions: { isConnected: () => false, async restart() {}, async stop() {}, rotateNow() {} },
    async applySettings() {},
    // like router/main.ts: settings and context rewritten, the worker marked for rotation
    applyPermissions(c) { applied.push(`${c.key} ${c.role}`); db.setRotate(c.key, true) },
    effectiveSettings: effective,
    async sendTo() {},
    recentMessages: () => [],
    writeConfig: () => {},
    restartRouter: () => {},
    startedAt: new Date(),
  } as unknown as CommandDeps
}
const run = (text: string, senderId: string, chat: { id: string; type: string } = { id: senderId, type: 'private' }) =>
  runCommand({ bot: 'cc', text, senderId, senderName: `u${senderId}`, chatId: chat.id, chatType: chat.type } as CommandInput, deps())
const dm = (uid: string, bot = 'cc') => ensureConversation(cfg, db, bot, uid, 'private', () => {})

test('a DM\'s role is its user\'s role on every read; config owners are owner; groups keep their own role', () => {
  const a = dm(MEMBER), b = dm(MEMBER, 'two'), o = dm(OWNER), adm = dm(ADMIN)
  const g = ensureConversation(cfg, db, 'cc', GROUP, 'supergroup', () => {})
  expect([a.role, b.role, o.role, adm.role, g.role]).toEqual(['user', 'user', 'owner', 'admin', 'user'])
  const changed = db.setUserRole(MEMBER, 'power')
  // every bot's DM with that person, and nothing else
  expect(changed.map(c => `${c.key} ${c.role}`)).toEqual(['dm-700100200 power', 'two-dm-700100200 power'])
  expect(db.getConversation(a.key)!.role).toBe('power')
  expect(db.findConversation('two', MEMBER)!.role).toBe('power')
  expect(db.listConversations().map(c => `${c.key} ${c.role}`)).toEqual(['dm-137438526 owner', 'dm-500 admin', 'dm-700100200 power', `group-${GROUP.slice(1)} user`, 'two-dm-700100200 power'])
  db.setRotate(a.key, true)
  expect(db.rotatePending().map(c => c.role)).toEqual(['power'])
  // the chat context the worker sees changes with it
  expect(db.getConversation(a.key)!.ctx_v).toBe(2)
  expect(buildContext(cfg, db.getConversation(a.key)!).role).toBe('power')
  // back to the default; the same role again changes nothing
  expect(db.setUserRole(MEMBER, null).map(c => c.role)).toEqual(['user', 'user'])
  expect(db.setUserRole(MEMBER, 'user')).toEqual([])
  // a DM's role cannot be set apart from its user
  expect(() => db.updateConversation(a.key, { role: 'admin' })).toThrow(/user's role/)
  expect(db.updateConversation(g.key, { role: 'power' }).role).toBe('power')
})

test('/router role: the user\'s DMs (every bot) get new settings and are marked for rotation; the reply says so', async () => {
  dm(MEMBER); dm(MEMBER, 'two')
  const ownerDm = dm(OWNER)
  const out = (await run(`/router role ${MEMBER} admin`, OWNER))!
  expect(out.reply).toBe(`${MEMBER} 的角色: user → admin\n私訊 dm-700100200, two-dm-700100200 的 worker 閒置時會停掉, 下一則訊息套用新角色`)
  expect(applied).toEqual(['dm-700100200 admin', 'two-dm-700100200 admin'])
  expect(db.rotatePending().map(c => c.key)).toEqual(['dm-700100200', 'two-dm-700100200'])
  // each DM's worker is told by the router log
  expect(out.logs.map(l => l.conv)).toEqual(['dm-700100200', 'two-dm-700100200', ownerDm.key])
  // the settings the router writes now are admin's
  expect(effective(db.getConversation('dm-700100200')!)).toEqual(renderSettings(TEMPLATES, 'admin', vars(db.getConversation('dm-700100200')!)) as any)
  // someone without a DM: the role changes, nothing to rotate
  applied = []
  expect((await run('/router role 700100201 power', OWNER))!.reply).toBe('700100201 的角色: user → power')
  expect(applied).toEqual([])
})

test('/router perm <私訊> role is /router role for that user: same checks, same effect', async () => {
  const c = dm(MEMBER)
  dm(MEMBER, 'two')
  const out = (await run(`/router perm ${MEMBER} role power`, OWNER))!
  expect(out.reply).toBe(`dm-700100200 是私訊, 角色跟著使用者走, 這個指令改為設定使用者角色 (等同 /router role ${MEMBER} power)\n${MEMBER} 的角色: user → power\n私訊 dm-700100200, two-dm-700100200 的 worker 閒置時會停掉, 下一則訊息套用新角色`)
  expect(db.getUserRole(MEMBER)).toBe('power')
  expect(db.getConversation(c.key)!.role).toBe('power')
  expect(applied).toEqual(['dm-700100200 power', 'two-dm-700100200 power'])
  // by conversation key too
  expect((await run('/router perm two-dm-700100200 role user', OWNER))!.reply).toContain(`${MEMBER} 的角色: power → user`)
  // /router role's checks: admin may not make anyone owner, nor change a config owner
  expect((await run(`/router perm ${MEMBER} role owner`, ADMIN))!.reply).toBe(`⛔ dm-700100200 是私訊, 角色跟著使用者走, 這個指令改為設定使用者角色 (等同 /router role ${MEMBER} owner)\nadmin 不能把角色設成 owner`)
  dm(OWNER)
  expect((await run(`/router perm ${OWNER} role admin`, OWNER))!.reply).toContain('是 config 指定的 owner, 要改請用 /router config set owners')
  expect((await run(`/router perm ${OWNER} role admin`, ADMIN))!.reply).toBe('⛔ admin 不能異動 owner 的角色與權限')
  expect(db.getUserRole(MEMBER)).toBe('user')
})

test('/router perm <私訊> role with no user behind the chat id: refused, pointing at /router role', async () => {
  // a DM row whose chat id is not a Telegram user id
  db.insertConversation({ key: 'dm-odd', bot: 'cc', chat_id: 'odd', type: 'dm', folder: join(dir, 'odd'), role: 'user', session_id: null, created_at: new Date().toISOString() })
  expect((await run('/router perm dm-odd role admin', OWNER))!.reply).toBe('⛔ dm-odd 是私訊, 角色跟著使用者走, 但對應不到使用者 (chat_id odd); 請改用 /router role <uid|@username> <角色>')
  expect(applied).toEqual([])
  expect(db.listUsers().map(u => u.uid)).toEqual([ADMIN])
})

test('a DM\'s perm overrides stay, laid over whatever its user\'s role is', async () => {
  const c = dm(MEMBER)
  await run(`/router perm ${MEMBER} tool allow Bash(git *)`, OWNER)
  await run(`/router perm ${MEMBER} net allow api.example.com`, OWNER)
  await run(`/router role ${MEMBER} power`, OWNER)
  const s = effective(db.getConversation(c.key)!)
  const base = renderSettings(TEMPLATES, 'power', vars(c)) as any
  expect(s.permissions.allow).toEqual([...base.permissions.allow, 'Bash(git *)'])
  expect(s.sandbox.network.allowedDomains).toContain('api.example.com')
  expect(db.listOverrides(c.key).map(o => o.kind)).toEqual(['net', 'tool-allow'])
  const show = (await run(`/router perm ${MEMBER} show`, OWNER))!.reply
  expect(show).toStartWith(`dm-700100200: 角色 power (使用者 ${MEMBER} 的角色, 用 /router role 改)`)
  expect(show).toContain('覆寫: net api.example.com, tool-allow Bash(git *)')
  // reset clears the overrides, the role stays the user's
  expect((await run(`/router perm ${MEMBER} reset`, OWNER))!.reply).toContain('清掉 2 筆覆寫, 回到 power 的預設')
})

test('/router status and /router chat show the user\'s role on DM lines', async () => {
  dm(MEMBER)
  ensureConversation(cfg, db, 'cc', GROUP, 'supergroup', () => {})
  const line = (s: string) => s.split('\n').find(l => l.includes(`: ${MEMBER}`))!
  expect(line((await run('/router status', OWNER))!.reply)).toContain('💤😀🚻')
  await run(`/router role ${MEMBER} admin`, OWNER)
  expect(line((await run('/router status', OWNER))!.reply)).toContain('💤😀🥈')
  expect((await run(`/router chat ${MEMBER}`, OWNER))!.reply).toContain(`chat_id ${MEMBER}, role admin (使用者角色)`)
  expect((await run(`/router chat ${GROUP}`, OWNER))!.reply).toContain(`chat_id ${GROUP}, role user, model`)
})

test('config owners changed: the DMs of those added or removed follow', async () => {
  const c = dm(MEMBER)
  const out = (await run(`/router config set owners ${OWNER},${MEMBER}`, OWNER))!
  expect(out.reply).toContain('私訊 dm-700100200 的 worker 閒置時會停掉')
  expect(db.getConversation(c.key)!.role).toBe('owner')
  expect(applied).toEqual(['dm-700100200 owner'])
  await run(`/router config set owners ${OWNER}`, OWNER)
  expect(db.getConversation(c.key)!.role).toBe('user')
})

test('role checks that read the conversation role see the user\'s role in a DM: high-risk tools, tool_history', async () => {
  const sent: string[] = []
  const approvals: ApprovalDeps = { db, owners: [OWNER], isAdmin: uid => uid === ADMIN, async send(_b, _to, text) { sent.push(text); return 1 }, async edit() {} }
  const e = createElevation({
    db, approvals, notify: () => {}, label: u => u, applyPermissions: () => {},
    roleOf: uid => db.userRole(uid),
    settingsAs: (c, r) => applyOverrides(renderSettings(TEMPLATES, r, vars(c)), db.listOverrides(c.key)),
    askTimeoutMs: 60_000,
  })
  const history = createToolHistory({ db, log: () => {} })
  const pre = { event: 'pre', tool_name: 'ListAgents', tool_input: {} }
  dm(MEMBER)
  const before = await e.onHook(db.findConversation('cc', MEMBER)!, pre)
  expect(before.decision).toBe('deny')
  db.setUserRole(MEMBER, 'admin')
  const conv = db.findConversation('cc', MEMBER)!
  const after = await e.onHook(conv, pre)
  expect(after.decision).toBeUndefined()
  history.record(hookUse(conv, pre, after, null))
  expect(db.toolStats('2000-01-01T00:00:00Z').map(r => r.conv_role)).toEqual(['admin'])
  e.stop()
})

test('migration: DMs stored with a role of their own are aligned to the user\'s role once, ctx_v bumped', () => {
  const a = dm(MEMBER), o = dm(OWNER), adm = dm(ADMIN)
  const g = ensureConversation(cfg, db, 'cc', GROUP, 'supergroup', () => {})
  db.updateConversation(g.key, { role: 'power' })
  db.close()
  // as left by /router perm <私訊> role before DMs followed their user
  const raw = new Database(join(dir, '.router', 'router.db'))
  raw.run("UPDATE conversations SET role = 'power' WHERE key = ?", [a.key])
  raw.run("UPDATE conversations SET role = 'user' WHERE key = ?", [o.key])
  raw.close()
  db = openRouterDb(join(dir, '.router', 'router.db'), { owners: cfg.owners })
  // reads never take the stale value
  expect(db.getConversation(a.key)!.role).toBe('user')
  const changed = db.syncDmRoles()
  expect(changed.map(x => `${x.conv.key} ${x.from} -> ${x.conv.role}`)).toEqual(['dm-137438526 user -> owner', 'dm-700100200 power -> user'])
  expect(db.getConversation(a.key)!.ctx_v).toBe(2)
  expect(db.getConversation(adm.key)!.ctx_v).toBe(1)
  // groups keep their own role; the stored column now matches; a second run does nothing
  expect(db.getConversation(g.key)!.role).toBe('power')
  const ro = new Database(join(dir, '.router', 'router.db'), { readonly: true })
  expect(ro.query("SELECT key, role FROM conversations WHERE type = 'dm' ORDER BY key").all()).toEqual([{ key: 'dm-137438526', role: 'owner' }, { key: 'dm-500', role: 'admin' }, { key: 'dm-700100200', role: 'user' }])
  ro.close()
  expect(db.syncDmRoles()).toEqual([])
})
