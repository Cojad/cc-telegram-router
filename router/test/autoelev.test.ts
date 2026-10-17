// Automatic elevation, the people of a turn and a user's own overrides
// (docs/permissions.md 「提權」 這一輪的發話者 / 自動提權, 「高風險工具」,
// 「使用者覆寫」; docs/operations.md /router perm user). Unit level:
// router/elevation.ts, router/permcheck.ts riskyRefusal, router/commands.ts.
// Through the real router and hook: e2e-autoelev.test.ts. Keep in sync with
// those sections and docs/testing.md 驗收對照.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Config } from '../config'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { ensureConversation } from '../conversations'
import { riskyRefusal, RISKY_TOOLS } from '../permcheck'
import { renderSettings, applyOverrides } from '../settings'
import { createElevation, workerKey } from '../elevation'
import { runCommand, type CommandDeps, type CommandInput } from '../commands'
import type { ApprovalDeps } from '../approvals'
import type { Access } from '../telegram/policy'

const TEMPLATES = join(import.meta.dir, '..', '..', 'templates')
const OWNER = '137438526', ADMIN = '700100210', POWER = '700100220', MEMBER = '700100200', GROUP = '-1009990000001'
const TOOLS = [...RISKY_TOOLS]
let dir: string, cfg: Config, db: RouterDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-autoelev-'))
  mkdirSync(join(dir, '.router'))
  cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }, { name: 'two', token: '2:y' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, '.router', 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude' }
  db = openRouterDb(join(dir, '.router', 'router.db'), { owners: cfg.owners })
  db.setUserRole(ADMIN, 'admin'); db.setUserRole(POWER, 'power')
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const vars = (c: Conversation) => ({ folder: c.folder, hidden: ['/srv/cc'], autoCompactWindow: 750000, hooksDir: '/h' })
/** extra: rules a role template would add (a template that opens a tool for power). */
function harness(role = 'user', opts: { unknownTurns?: boolean; extra?: Record<string, string[]> } = {}) {
  let conv = ensureConversation(cfg, db, 'cc', GROUP, 'supergroup', () => {})
  conv = db.updateConversation(conv.key, { role })
  const sent: Array<{ chat: string; text: string; buttons: string[] }> = []
  const told: string[] = []
  let n = 100
  const approvals: ApprovalDeps = {
    db, owners: [OWNER], isAdmin: uid => uid === ADMIN,
    async send(_bot, to, text, buttons) { sent.push({ chat: to.chat_id, text, buttons: buttons.map(b => b.data) }); return ++n },
    async edit() {},
  }
  const settingsAs = (c: Conversation, r: string) => {
    const s = applyOverrides(renderSettings(TEMPLATES, r, vars(c)), db.listOverrides(c.key)) as any
    s.permissions.allow.push(...(opts.extra?.[r] ?? []))
    return s
  }
  const e = createElevation({
    db, approvals, notify: (_c, t) => told.push(t), label: u => `u${u}`, applyPermissions: () => {},
    roleOf: uid => uid === OWNER ? 'owner' : db.getUserRole(uid) ?? 'user',
    settingsAs, askTimeoutMs: 60_000, unknownTurns: opts.unknownTurns,
  })
  return { conv, e, sent, told }
}
const pre = (tool_name: string, tool_input: Record<string, unknown> = {}, agent_id?: string) => ({ event: 'pre', tool_name, tool_input, ...(agent_id ? { agent_id } : {}) })
const send = (to: string, agent_id?: string) => pre('SendMessage', { to }, agent_id)
const redirect = pre('Bash', { command: 'echo hi > notes.txt', description: '寫筆記' })
const stop = { event: 'stop' }
const prompt = (extra: Record<string, unknown> = {}) => ({ event: 'prompt', telegram: true, ...extra })

test('a pure admin turn: all six high-risk tools and SendMessage to another session pass at once, without a button or a subagent; each is logged with who, the role and the recipient', async () => {
  const { conv, e, sent, told } = harness('user')
  e.onDeliver(conv, ADMIN)
  await e.onHook(conv, prompt())
  for (const tool of TOOLS) expect([tool, await e.onHook(conv, pre(tool))]).toEqual([tool, { decision: 'allow', reason: `自動提權 (發起者 u${ADMIN} [admin]), 以 admin 角色執行`, effRole: 'admin' }])
  expect(await e.onHook(conv, send('worker [3fa9c1]'))).toEqual({ decision: 'allow', reason: `自動提權 (發起者 u${ADMIN} [admin]), 以 admin 角色執行`, effRole: 'admin' })
  // a subagent's call in that turn too (not one bound to an approval)
  expect(await e.onHook(conv, pre('ListAgents', {}, 'S1'))).toMatchObject({ decision: 'allow', effRole: 'admin' })
  expect(sent).toEqual([])
  expect(told).toEqual([])
  expect(db.pendingElevations()).toEqual([])
  const log = db.elevLog(conv.key, 20).reverse()
  expect(log.map(l => l.kind)).toEqual(Array(TOOLS.length + 2).fill('auto'))
  expect(log[0]!.text).toBe(`⚡ 自動提權 ${conv.key}: ListAgents: \n發起者 u${ADMIN} [admin]: 這一輪的發話者都有權限, 以 admin 角色執行 (不用按鈕)`)
  expect(log[TOOLS.length]!.text).toContain('SendMessage: {"to":"worker [3fa9c1]"}, 收件對象 worker [3fa9c1]\n')
  expect(log.at(-1)!.text).toContain('(subagent S1)')
  // anything else blocked still goes through the subagent elevation, asked in the chat
  expect((await e.onHook(conv, redirect)).reason).toContain('router 已在對話裡詢問是否提權 (#1')
  expect(sent[0]!.buttons).toEqual(['elev:1:once', 'elev:1:deny'])
  e.stop()
})

test('the record goes to the 提權紀錄 topic of the approvals group too', async () => {
  const { conv, e, sent } = harness('user')
  db.updateBotSetup('cc', { approvals_chat: '-1009990000002', elevlog_topic: 7 })
  e.onDeliver(conv, OWNER)
  expect((await e.onHook(conv, pre('CronCreate', { cron: '7 9 * * *', prompt: 'x' }))).decision).toBe('allow')
  for (let i = 0; i < 40 && !sent.length; i++) await new Promise(r => setTimeout(r, 10))
  expect(sent).toEqual([{ chat: '-1009990000002', text: expect.stringContaining(`⚡ 自動提權 ${conv.key}: CronCreate`), buttons: [] }])
  e.stop()
})

test('a mixed turn (a user member, then an admin, read together): no automatic pass and no button, for high-risk tools and any other block', async () => {
  const { conv, e, sent } = harness('user')
  e.onDeliver(conv, MEMBER)
  e.onDeliver(conv, ADMIN)
  await e.onHook(conv, prompt())
  expect(e.turnSenders(conv)).toEqual([MEMBER, ADMIN])
  expect(e.senderOf(conv)).toBe(MEMBER)
  for (const ev of [pre('ListAgents'), send('worker'), redirect]) {
    const d = await e.onHook(conv, ev)
    expect(d.decision).toBe('deny')
    expect(d.reason).toContain('對方同意後呼叫 request_elevation 說明原因')
  }
  expect(sent).toEqual([])
  expect(db.elevLog(conv.key, 5).map(l => l.kind)).toEqual(['blocked', 'blocked', 'blocked'])
  expect(db.elevLog(conv.key, 1)[0]!.text).toEndWith(`發起者 u${MEMBER} [user], u${ADMIN} [admin]`)
  // the other order: an admin, and a member's message coming in while the turn runs
  await e.onHook(conv, stop)
  e.onDeliver(conv, ADMIN)
  await e.onHook(conv, prompt())
  expect((await e.onHook(conv, pre('ListAgents'))).decision).toBe('allow')
  e.onDeliver(conv, MEMBER)
  expect((await e.onHook(conv, pre('ListAgents'))).decision).toBe('deny')
  e.stop()
})

test('a power turn: not passed by default; passed when its role template or the person\'s own override allows the tool (as power); a deny override closes it even for admin', async () => {
  const plain = harness('user')
  plain.e.onDeliver(plain.conv, POWER)
  expect((await plain.e.onHook(plain.conv, pre('ListAgents'))).decision).toBe('deny')
  plain.e.stop()
  // a template that opens ListAgents for power (permissions.allow naming it)
  const tpl = harness('user', { extra: { power: ['ListAgents'] } })
  tpl.e.onDeliver(tpl.conv, POWER)
  expect(await tpl.e.onHook(tpl.conv, pre('ListAgents'))).toMatchObject({ decision: 'allow', effRole: 'power' })
  expect((await tpl.e.onHook(tpl.conv, pre('CronCreate'))).decision).toBe('deny')
  tpl.e.stop()
  // the person's own override (/router perm user), counted in any conversation
  const own = harness('user')
  db.addUserOverride(POWER, 'tool-allow', 'SendMessage')
  own.e.onDeliver(own.conv, POWER)
  expect(await own.e.onHook(own.conv, send('worker'))).toMatchObject({ decision: 'allow', reason: `自動提權 (發起者 u${POWER} [power]), 以 power 角色執行`, effRole: 'power' })
  expect((await own.e.onHook(own.conv, pre('ListAgents'))).decision).toBe('deny')
  // with an admin in the turn: everyone needs it, the turn runs as the lowest (power)
  own.e.onDeliver(own.conv, ADMIN)
  expect(await own.e.onHook(own.conv, send('worker'))).toMatchObject({ decision: 'allow', reason: `自動提權 (發起者 u${POWER} [power], u${ADMIN} [admin]), 以 power 角色執行` })
  expect((await own.e.onHook(own.conv, pre('ListAgents'))).decision).toBe('deny')
  // an admin with a deny override of their own
  await own.e.onHook(own.conv, stop)
  db.addUserOverride(ADMIN, 'tool-deny', 'ListAgents')
  own.e.onDeliver(own.conv, ADMIN)
  expect((await own.e.onHook(own.conv, pre('ListAgents'))).decision).toBe('deny')
  expect((await own.e.onHook(own.conv, pre('CronCreate'))).decision).toBe('allow')
  own.e.stop()
})

test('riskyRefusal reads the settings: an allow rule naming the tool opens it below admin, a deny rule closes it for every role; other rules and tools are untouched', () => {
  const call = (t: string) => ({ tool_name: t, tool_input: { to: 'worker' } })
  const allow = { permissions: { allow: ['ListAgents', 'SendMessage'], deny: [] } }
  expect(riskyRefusal(call('ListAgents'), 'power', false, allow)).toBeNull()
  expect(riskyRefusal(call('SendMessage'), 'guest', false, allow)).toBeNull()
  expect(riskyRefusal(call('CronCreate'), 'power', false, allow)).toBe('power 以下的角色不能使用 CronCreate')
  expect(riskyRefusal(call('ListAgents'), 'power', false, { permissions: { allow: ['ListAgents(*)', 'Bash'] } })).toBe('power 以下的角色不能使用 ListAgents')
  const deny = { permissions: { allow: [], deny: ['ListAgents', 'SendMessage'] } }
  expect(riskyRefusal(call('ListAgents'), 'owner', false, deny)).toBe('owner 禁止 ListAgents')
  expect(riskyRefusal(call('SendMessage'), 'admin', true, deny)).toBe('admin 禁止 SendMessage')
  expect(riskyRefusal(call('Read'), 'guest', false, deny)).toBeNull()
})

test('the people of a turn: Stop starts afresh; a message that comes in while the turn runs counts for this turn and the next; reactions alone and the terminal have no sender', async () => {
  const { conv, e } = harness('user')
  e.onDeliver(conv, OWNER)
  await e.onHook(conv, prompt())
  e.onDeliver(conv, MEMBER) // while the turn runs
  expect(e.turnSenders(conv)).toEqual([OWNER, MEMBER])
  await e.onHook(conv, stop)
  // Claude Code may start the next turn with it: still counted, the owner is not
  expect(e.turnSenders(conv)).toEqual([MEMBER])
  await e.onHook(conv, prompt())
  await e.onHook(conv, stop)
  expect(e.turnSenders(conv)).toEqual([])
  expect(e.senderOf(conv)).toBeNull()
  // reactions alone (router/reactions.ts: no user_id) add nobody, and their turn has no sender
  expect(e.onDeliver(conv, undefined)).toEqual({})
  await e.onHook(conv, prompt({ reactions: true }))
  e.onDeliver(conv, OWNER)
  expect(e.turnSenders(conv)).toBeNull()
  expect((await e.onHook(conv, pre('ListAgents'))).decision).toBe('deny')
  // the owner's message, come in meanwhile, gets its own turn
  await e.onHook(conv, stop)
  await e.onHook(conv, prompt())
  expect(e.turnSenders(conv)).toEqual([OWNER])
  expect((await e.onHook(conv, pre('ListAgents'))).decision).toBe('allow')
  await e.onHook(conv, stop)
  // a turn typed in the terminal: no sender, nothing asked, nothing passed
  e.onDeliver(conv, OWNER)
  await e.onHook(conv, prompt({ telegram: false }))
  expect(e.senderOf(conv)).toBeNull()
  expect((await e.onHook(conv, pre('ListAgents'))).decision).toBe('deny')
  e.stop()
})

test('after the router starts (unknownTurns), a worker already running has no sender until its next Stop; a worker process started after the router is known at once', async () => {
  const { conv, e } = harness('user', { unknownTurns: true })
  e.onDeliver(conv, OWNER)
  expect(e.turnSenders(conv)).toBeNull()
  expect((await e.onHook(conv, pre('ListAgents'))).decision).toBe('deny')
  await e.onHook(conv, prompt())
  e.onDeliver(conv, ADMIN)
  expect(e.senderOf(conv)).toBeNull()
  // the Stop: known from now on; a message delivered while the turn ran counts for the next
  await e.onHook(conv, stop)
  expect(e.turnSenders(conv)).toEqual([ADMIN])
  e.stop()
  if (!existsSync(`/proc/${process.pid}/stat`)) return
  const later = harness('user', { unknownTurns: true })
  // a process started before the router (this test process stands in for one): still unknown
  later.e.workerConnected(later.conv.key, workerKey('sess-1', process.pid)!)
  later.e.onDeliver(later.conv, OWNER)
  expect(later.e.turnSenders(later.conv)).toBeNull()
  const p = Bun.spawn(['sleep', '5'])
  await new Promise(r => setTimeout(r, 30))
  const w = workerKey('sess-9', p.pid)
  p.kill(); await p.exited
  if (!w) return
  later.e.workerConnected(later.conv.key, w)
  expect(later.e.turnSenders(later.conv)).toEqual([]) // the earlier process's turn is gone with it
  later.e.onDeliver(later.conv, ADMIN)
  expect(later.e.turnSenders(later.conv)).toEqual([ADMIN])
  later.e.stop()
})

test('the button elevation uses the same people: a turn with someone not above the conversation is not asked in the chat', async () => {
  const { conv, e, sent } = harness('user')
  e.onDeliver(conv, OWNER)
  e.onDeliver(conv, MEMBER)
  expect((await e.onHook(conv, redirect)).reason).toContain('請改用不越權的方法完成')
  expect(sent).toEqual([])
  await e.onHook(conv, stop)
  e.onDeliver(conv, OWNER)
  e.onDeliver(conv, ADMIN)
  expect((await e.onHook(conv, redirect)).reason).toContain('router 已在對話裡詢問是否提權 (#1')
  expect(sent[0]!.text).toContain(`u${OWNER} [owner], u${ADMIN} [admin] 在 ${conv.key}`)
  e.stop()
})

// /router perm user (docs/operations.md)
let applied: string[] = []
function deps(): CommandDeps {
  const access: Access = { dmPolicy: 'allowlist', allowFrom: [OWNER, ADMIN, MEMBER], groups: {}, pending: {} } as Access
  return {
    cfg, db,
    loadAccess: () => structuredClone(access),
    saveAccess: () => {},
    bots: { async list() { return [] }, async add() { return '' }, async rotate() { return '' }, async remove() {} },
    sessions: { isConnected: () => false, async restart() {}, async stop() {}, rotateNow() {} },
    async applySettings() {},
    applyPermissions(c) { applied.push(c.key); db.setRotate(c.key, true) },
    effectiveSettings: (c: Conversation) => applyOverrides(renderSettings(TEMPLATES, c.role, vars(c)), [...(c.type === 'dm' ? db.listUserOverrides(c.chat_id) : []), ...db.listOverrides(c.key)]),
    async sendTo() {},
    recentMessages: () => [],
    writeConfig: () => {},
    restartRouter: () => {},
    startedAt: new Date(),
  } as unknown as CommandDeps
}
const run = async (text: string, senderId: string) => (await runCommand({ bot: 'cc', text, senderId, senderName: `u${senderId}`, chatId: senderId, chatType: 'private' } as CommandInput, deps()))!

test('/router perm user: owner and admin add, remove and reset overrides on a person; admin may not touch an owner; power may not run it; send and pkg stay on conversations', async () => {
  applied = []
  const a = ensureConversation(cfg, db, 'cc', POWER, 'private', () => {})
  const b = ensureConversation(cfg, db, 'two', POWER, 'private', () => {})
  ensureConversation(cfg, db, 'cc', GROUP, 'supergroup', () => {})
  let out = await run(`/router perm user ${POWER} tool allow ListAgents`, OWNER)
  expect(out.reply).toBe(`${POWER} tool allow ListAgents\n使用者覆寫: tool-allow ListAgents\n私訊 ${a.key}, ${b.key} 的 worker 閒置時會停掉, 下一則訊息套用新權限`)
  expect(applied).toEqual([a.key, b.key])
  expect(db.rotatePending().map(c => c.key)).toEqual([a.key, b.key])
  expect(db.listUserOverrides(POWER)).toEqual([{ conv: `user:${POWER}`, kind: 'tool-allow', value: 'ListAgents' }])
  out = await run(`/router perm user ${POWER} path read /srv/data/shared`, ADMIN)
  expect(out.reply).toContain('使用者覆寫: path-read /srv/data/shared, tool-allow ListAgents')
  expect((await run(`/router perm user ${POWER} path read data`, OWNER)).reply).toBe('路徑要用絕對路徑, 例如 /srv/data/shared')
  expect((await run(`/router perm user ${POWER} net allow example.com`, OWNER)).reply).toContain('使用者覆寫: net example.com, path-read /srv/data/shared, tool-allow ListAgents\n')
  expect((await run(`/router perm user ${POWER} send allow ${GROUP}`, OWNER)).reply).toBe('send 是 router 依對話把關的, 只能掛在對話上: /router perm [chat_id] send ...')
  expect((await run(`/router perm user ${POWER} tool allowx X`, OWNER)).reply).toBe('tool 只能用 allow, deny, rm')
  expect((await run(`/router perm user ${POWER} bogus a b`, OWNER)).reply).toStartWith('用法: /router perm user')
  expect((await run('/router perm user @nobody show', OWNER)).reply).toStartWith('找不到 @nobody')
  // show: the overrides, where they count; the DM's own /router perm show lists them as well
  out = await run(`/router perm user ${POWER}`, ADMIN)
  expect(out.private).toBe(true)
  expect(out.reply).toContain(`${POWER}: 角色 power\n使用者覆寫: net example.com, path-read /srv/data/shared, tool-allow ListAgents`)
  expect(out.reply).toContain('群組裡路徑與網域覆寫不會改變 worker 的 sandbox')
  const dmShow = (await run(`/router perm ${a.key} show`, OWNER)).reply
  expect(dmShow).toContain(`使用者覆寫 (/router perm user ${POWER}): net example.com, path-read /srv/data/shared, tool-allow ListAgents`)
  expect(dmShow).toMatch(/允許: .*ListAgents/)
  expect(dmShow).toContain('/srv/data/shared')
  // rm, reset
  expect((await run(`/router perm user ${POWER} tool rm ListAgents`, OWNER)).reply).toStartWith(`${POWER} 移除 tool ListAgents`)
  expect((await run(`/router perm user ${POWER} tool rm ListAgents`, OWNER)).reply).toBe(`${POWER} 沒有 tool ListAgents 這筆使用者覆寫`)
  expect((await run(`/router perm user ${POWER} reset`, OWNER)).reply).toStartWith(`${POWER} 清掉 2 筆使用者覆寫`)
  expect(db.listUserOverrides(POWER)).toEqual([])
  // who may: admin not on an owner (show is fine), power not at all
  expect((await run(`/router perm user ${OWNER} tool allow ListAgents`, ADMIN)).reply).toBe('⛔ admin 不能異動 owner 的角色與權限')
  expect((await run(`/router perm user ${OWNER}`, ADMIN)).reply).toContain('角色 owner')
  expect((await run(`/router perm user ${MEMBER} tool allow ListAgents`, POWER)).reply).toStartWith('⛔ /router 只開放 owner 與 admin')
  expect(db.listUserOverrides(MEMBER)).toEqual([])
  // someone without a DM: stored, nothing to rotate
  applied = []
  expect((await run(`/router perm user ${MEMBER} mcp allow context7`, OWNER)).reply).toBe(`${MEMBER} mcp allow context7\n使用者覆寫: mcp context7`)
  expect(applied).toEqual([])
})
