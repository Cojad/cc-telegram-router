// High-risk tools need elevation for power and below (docs/permissions.md
// 「高風險工具」; router/permcheck.ts riskyRefusal, router/elevation.ts own
// subagents). Keep in sync with that section and docs/testing.md 驗收對照.
// The real claude CLI: role-live.test.ts (LIVE=1); through the real router: e2e-toolhistory.test.ts.

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
import { createIpc } from '../ipc'
import type { ApprovalDeps } from '../approvals'

const TEMPLATES = join(import.meta.dir, '..', '..', 'templates')
const OWNER = '137438526', ADMIN = '500', POWER = '600', USER = '42'
const ROLES = ['owner', 'admin', 'power', 'user', 'guest']
const TOOLS = [...RISKY_TOOLS]
let dir: string, cfg: Config, db: RouterDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-risky-'))
  mkdirSync(join(dir, '.router'))
  cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, '.router', 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude' }
  db = openRouterDb(join(dir, '.router', 'router.db'))
  db.setUserRole(ADMIN, 'admin'); db.setUserRole(POWER, 'power'); db.setUserRole(USER, 'user')
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

function harness(role = 'user', chat = '-100555') {
  let conv = ensureConversation(cfg, db, 'cc', chat, 'supergroup', () => {})
  conv = db.updateConversation(conv.key, { role })
  const sent: Array<{ chat: string; text: string; buttons: string[] }> = []
  const told: string[] = []
  const logs: string[] = []
  let n = 100
  const approvals: ApprovalDeps = {
    db, owners: [OWNER], isAdmin: uid => uid === ADMIN,
    async send(_bot, to, text, buttons) { sent.push({ chat: to.chat_id, text, buttons: buttons.map(b => b.data) }); return ++n },
    async edit() {},
  }
  const make = () => createElevation({
    db, approvals, notify: (_c, t) => told.push(t), label: u => `u${u}`, applyPermissions: () => {},
    roleOf: uid => uid === OWNER ? 'owner' : db.getUserRole(uid) ?? 'user',
    settingsAs: (c, r) => applyOverrides(renderSettings(TEMPLATES, r, { folder: c.folder, hidden: ['/srv/cc'], autoCompactWindow: 750000, hooksDir: '/h' }), db.listOverrides(c.key)),
    askTimeoutMs: 60_000, log: m => logs.push(m),
  })
  return { conv, e: make(), make, sent, told, logs }
}
const pre = (tool_name: string, tool_input: Record<string, unknown> = {}, agent_id?: string) => ({ event: 'pre', tool_name, tool_input, ...(agent_id ? { agent_id } : {}) })
const send = (to: string, agent_id?: string) => pre('SendMessage', { to, message: 'hi' }, agent_id)
const verdict = async (e: ReturnType<typeof createElevation>, conv: Conversation, ev: Record<string, unknown>) => (await e.onHook(conv, ev)).decision === 'deny' ? 'deny' : 'pass'

test('riskyRefusal: the six tools and SendMessage to another session are refused below admin; own subagents and every other tool are not', () => {
  expect(TOOLS.sort()).toEqual(['CronCreate', 'CronDelete', 'ListAgents', 'PushNotification', 'RemoteTrigger', 'ScheduleWakeup'])
  for (const role of ROLES) for (const tool of TOOLS) {
    const why = riskyRefusal({ tool_name: tool, tool_input: {} }, role, false)
    expect([role, tool, why]).toEqual([role, tool, ['owner', 'admin'].includes(role) ? null : `power 以下的角色不能使用 ${tool}`])
  }
  const msg = { tool_name: 'SendMessage', tool_input: { to: 'worker [3fa9c1]' } }
  expect(riskyRefusal(msg, 'power', false)).toBe('power 以下的角色不能傳訊給其他 session (收件對象 worker [3fa9c1] 不是這個對話自己的 subagent)')
  expect(riskyRefusal(msg, 'power', true)).toBeNull()
  expect(riskyRefusal(msg, 'admin', false)).toBeNull()
  for (const tool of ['Read', 'Agent', 'TaskStop', 'Monitor', 'CronList', 'Skill']) expect(riskyRefusal({ tool_name: tool, tool_input: {} }, 'guest', false)).toBeNull()
})

test('every high-risk tool in every conversation role: owner and admin pass, power, user and guest are blocked with a clear reason and logged', async () => {
  for (const [i, role] of ROLES.entries()) {
    const { conv, e } = harness(role, `-10055${i}`)
    for (const tool of [...TOOLS, 'SendMessage']) {
      const ev = tool === 'SendMessage' ? send('worker') : pre(tool)
      const d = await e.onHook(conv, ev)
      if (role === 'owner' || role === 'admin') expect([role, tool, d.decision]).toEqual([role, tool, undefined])
      else {
        expect([role, tool, d.decision]).toEqual([role, tool, 'deny'])
        expect(d.reason).toStartWith(`權限不足 (本對話角色 ${role}): power 以下的角色不能${tool === 'SendMessage' ? '傳訊給其他 session' : `使用 ${tool}`}`)
      }
    }
    if (role !== 'owner' && role !== 'admin') expect(db.elevLog(conv.key, 20).filter(l => l.kind === 'blocked')).toHaveLength(TOOLS.length + 1)
    e.stop()
  }
})

test('SendMessage: own subagents (agent id from SubagentStart; an Agent name once its subagent starts) pass; "main" only from a subagent; other sessions and unknown names are blocked', async () => {
  const { conv, e } = harness('user')
  e.workerConnected(conv.key, 'sess-1:4242')
  // agent id reported by SubagentStart
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'a1b2c3d4-0001', agent_type: 'general-purpose' })
  expect(await verdict(e, conv, send('a1b2c3d4-0001'))).toBe('pass')
  // a named Agent call: the name is not its own until the subagent starts
  expect(await verdict(e, conv, pre('Agent', { name: 'helper', subagent_type: 'Explore', description: 'x', prompt: 'y' }))).toBe('pass')
  expect(await verdict(e, conv, pre('Agent', { name: 'writer', description: 'x', prompt: 'y' }))).toBe('pass') // no type: general-purpose
  expect(await verdict(e, conv, send('helper'))).toBe('deny')
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'a1b2c3d4-0002', agent_type: 'general-purpose' })
  expect(await verdict(e, conv, send('writer'))).toBe('pass')
  expect(await verdict(e, conv, send('helper'))).toBe('deny')
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'a1b2c3d4-0003', agent_type: 'Explore' })
  expect(await verdict(e, conv, send('helper'))).toBe('pass')
  // a subagent reporting back to its parent; the main session has no "main" to send to
  expect(await verdict(e, conv, send('main', 'a1b2c3d4-0002'))).toBe('pass')
  expect(await verdict(e, conv, send('main'))).toBe('deny')
  // other sessions: a bare name, name [ref], socket and bridge addresses, nothing at all
  for (const to of ['worker', 'helper [3fa9c1]', 'uds:/tmp/cc.sock', 'bridge:session_01', '', 'HELPER'])
    expect([to, await verdict(e, conv, send(to))]).toEqual([to, 'deny'])
  expect(e.ownAgents(conv.key).sort()).toEqual(['a1b2c3d4-0001', 'a1b2c3d4-0002', 'a1b2c3d4-0003', 'helper', 'writer'])
  // another conversation's subagents are not this one's
  const other = harness('user', '-100666')
  other.e.workerConnected(other.conv.key, 'sess-1:4242')
  expect(await verdict(other.e, other.conv, send('helper'))).toBe('deny')
  e.stop(); other.e.stop()
})

test('own subagents are kept in router.db: a router restart keeps them once the same worker\'s plugin says hello again; another worker process drops them', async () => {
  const { conv, e, make } = harness('user')
  e.workerConnected(conv.key, 'sess-1:4242')
  await e.onHook(conv, pre('Agent', { name: 'helper', description: 'x', prompt: 'y' }))
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'a1', agent_type: 'general-purpose' })
  expect(db.ownAgents(conv.key, 'sess-1:4242')).toEqual(['a1', 'helper'])
  // SubagentStop removes nothing: a finished subagent is woken by a SendMessage to it
  await e.onHook(conv, { event: 'subagent-stop', agent_id: 'a1' })
  expect(await verdict(e, conv, send('helper'))).toBe('pass')
  e.stop()
  // router restart: nothing counts until the worker's plugin says hello again
  const again = make()
  expect(await verdict(again, conv, send('helper'))).toBe('deny')
  expect(again.ownAgents(conv.key)).toEqual([])
  again.workerConnected(conv.key, 'sess-1:4242')
  expect(await verdict(again, conv, send('helper'))).toBe('pass')
  expect(await verdict(again, conv, send('a1'))).toBe('pass')
  // the plugin went away: nothing counts; the same worker back: counts again
  again.workerGone(conv.key)
  expect(await verdict(again, conv, send('helper'))).toBe('deny')
  again.workerConnected(conv.key, 'sess-1:4242')
  expect(await verdict(again, conv, send('helper'))).toBe('pass')
  // the same session in a new process (rotate, restart): the older rows go
  again.workerConnected(conv.key, 'sess-1:5151')
  expect(await verdict(again, conv, send('helper'))).toBe('deny')
  expect(db.ownAgents(conv.key, 'sess-1:4242')).toEqual([])
  // and coming back to the old worker key does not bring them back
  again.workerConnected(conv.key, 'sess-1:4242')
  expect(await verdict(again, conv, send('helper'))).toBe('deny')
  again.stop()
})

test('own subagents while the worker\'s plugin is not back: SendMessage to a known name waits until the hook\'s deadline, judged the moment the plugin says hello; unknown names and older hooks do not wait', async () => {
  const { conv, e, logs } = harness('user')
  e.workerConnected(conv.key, 'sess-1:4242')
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'a1', agent_type: 'general-purpose' })
  e.workerGone(conv.key)
  const timed = async (ev: Record<string, unknown>, deadline?: number) => {
    const t0 = Date.now()
    const v = (await e.onHook(conv, ev, deadline)).decision === 'deny' ? 'deny' : 'pass'
    return { v, ms: Date.now() - t0 }
  }
  // the same worker's plugin comes back 300 ms later: let through then, not at the deadline
  setTimeout(() => e.workerConnected(conv.key, 'sess-1:4242'), 300)
  let r = await timed(send('a1'), Date.now() + 5000)
  expect(r.v).toBe('pass')
  expect(r.ms).toBeGreaterThanOrEqual(250)
  expect(r.ms).toBeLessThan(1500)
  expect(logs.at(-1)).toMatch(/^own subagent a1 of .*: waited 0\.\ds for the worker's plugin, the same worker is back: counted$/)
  // it never comes back: refused at the deadline, as cross-session
  e.workerGone(conv.key)
  r = await timed(send('a1'), Date.now() + 400)
  expect(r.v).toBe('deny')
  expect(r.ms).toBeGreaterThanOrEqual(350)
  expect(logs.at(-1)).toContain('the plugin did not say hello in time: not counted')
  // another worker process says hello meanwhile: its rows went, refused at once
  setTimeout(() => e.workerConnected(conv.key, 'sess-1:5151'), 200)
  r = await timed(send('a1'), Date.now() + 5000)
  expect(r.v).toBe('deny')
  expect(r.ms).toBeLessThan(1500)
  expect(logs.at(-1)).toContain('another worker process said hello: not counted')
  // a name with no row, an older hook with no deadline, "main" from a subagent: no wait, no log line
  e.workerGone(conv.key)
  const lines = logs.length
  r = await timed(send('stranger'), Date.now() + 5000)
  expect(r).toMatchObject({ v: 'deny' })
  expect(r.ms).toBeLessThan(200)
  r = await timed(send('a1'))
  expect(r.v).toBe('deny')
  expect(r.ms).toBeLessThan(200)
  r = await timed(send('main', 'a9'), Date.now() + 5000)
  expect(r.v).toBe('pass')
  expect(r.ms).toBeLessThan(200)
  expect(logs.length).toBe(lines)
  e.stop()
  // a conversation whose role may send anywhere (admin): no wait either
  const adm = harness('admin', '-100777')
  adm.e.workerConnected(adm.conv.key, 'sess-2:1')
  await adm.e.onHook(adm.conv, { event: 'subagent-start', agent_id: 'b1', agent_type: 'general-purpose' })
  adm.e.workerGone(adm.conv.key)
  const t0 = Date.now()
  expect((await adm.e.onHook(adm.conv, send('b1'), Date.now() + 5000)).decision).toBeUndefined()
  expect(Date.now() - t0).toBeLessThan(200)
  expect(adm.logs).toEqual([])
  adm.e.stop()
})

test('own subagents: a SubagentStart with no worker plugin connected keeps nothing; an Agent call waiting from an earlier worker is not matched by the next worker\'s subagent', async () => {
  const { conv, e } = harness('user')
  await e.onHook(conv, pre('Agent', { name: 'early', description: 'x', prompt: 'y' }))
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'a0', agent_type: 'general-purpose' })
  e.workerConnected(conv.key, 'sess-1:1')
  expect(e.ownAgents(conv.key)).toEqual([])
  expect(await verdict(e, conv, send('early'))).toBe('deny')
  // an Agent call let through in one worker, the next worker's SubagentStart
  await e.onHook(conv, pre('Agent', { name: 'stale', description: 'x', prompt: 'y' }))
  e.workerConnected(conv.key, 'sess-2:2')
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'b1', agent_type: 'general-purpose' })
  expect(e.ownAgents(conv.key)).toEqual(['b1'])
  expect(await verdict(e, conv, send('stale'))).toBe('deny')
  e.stop()
})

test('own_agents rows: newest 500 per worker kept, a name added again is the newest; purge drops old rows and rows of conversations gone', () => {
  const conv = ensureConversation(cfg, db, 'cc', '-100777', 'supergroup', () => {})
  for (let i = 0; i < 502; i++) db.addOwnAgent(conv.key, 'w', `a${i}`, 500)
  const list = db.ownAgents(conv.key, 'w')
  expect(list).toHaveLength(500)
  expect(list[0]).toBe('a2')
  db.addOwnAgent(conv.key, 'w', 'a2', 500)
  expect(db.ownAgents(conv.key, 'w').at(-1)).toBe('a2')
  expect(db.isOwnAgent(conv.key, 'w', 'a3')).toBe(true)
  expect(db.isOwnAgent(conv.key, 'other', 'a3')).toBe(false)
  db.addOwnAgent(conv.key, 'w2', 'x', 500)
  expect(db.dropOwnAgents(conv.key, 'w2')).toBe(500)
  expect(db.ownAgents(conv.key, 'w2')).toEqual(['x'])
  db.addOwnAgent('no-such-conv', 'w', 'y', 500)
  expect(db.purgeOwnAgents(new Date(Date.now() - 86_400_000).toISOString())).toBe(1) // the gone conversation's row
  expect(db.purgeOwnAgents(new Date(Date.now() + 1000).toISOString())).toBe(1)
  expect(db.dropOwnAgents(conv.key, null)).toBe(0)
})

test.skipIf(!existsSync(`/proc/${process.pid}/stat`))('workerKey: session, pid and the process start time (a pid used again is another worker); no start time, no key', async () => {
  const k = workerKey('sess-1', process.pid)
  expect(k).toMatch(new RegExp(`^sess-1:${process.pid}:\\d+$`))
  expect(workerKey('sess-1', process.pid)).toBe(k)
  expect(workerKey(undefined, process.pid)).toStartWith(`?:${process.pid}:`)
  // another process: another start time in the key
  const p = Bun.spawn(['sleep', '5'])
  const other = workerKey('sess-1', p.pid)
  p.kill(); await p.exited
  expect(other).toMatch(new RegExp(`^sess-1:${p.pid}:\\d+$`))
  // gone, or never there: cannot be told apart
  expect(workerKey('sess-1', p.pid)).toBeNull()
  expect(workerKey('sess-1', 999999999)).toBeNull()
})

test('elevation: an owner\'s turn in a user conversation makes the high-risk calls at once (automatic elevation, autoelev.test.ts), without a button, nothing permanent; an approved subagent elevation still covers them', async () => {
  const { conv, e, sent, told } = harness('user')
  e.onDeliver(conv, OWNER)
  expect(await e.onHook(conv, pre('ListAgents'))).toEqual({ decision: 'allow', reason: `自動提權 (發起者 u${OWNER} [owner]), 以 owner 角色執行`, effRole: 'owner' })
  expect(sent).toEqual([])
  expect(told).toEqual([])
  expect(db.listOverrides(conv.key)).toEqual([]) // nothing permanent
  // a high-risk call stored in a request (an approval asked before): once only, never 永久允許
  const id = db.addElevation({ conv: conv.key, kind: 'passive', sender: OWNER, action: JSON.stringify({ tool_name: 'ListAgents', tool_input: {} }), reason: '' })
  expect(await e.decide(`elev:${id}:always`, OWNER)).toBe('不能永久允許: 高風險工具 (傳訊給其他 session, ListAgents, 排程, 遠端觸發, 推播) 只能一次一次允許')
  expect(await e.decide(`elev:${id}:once`, OWNER)).toBe('已提權一次')
  expect(told[0]).toContain(`提權 #${id} 已核准`)
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'S1' })
  expect(await e.onHook(conv, pre('ListAgents', {}, 'S1'))).toEqual({ decision: 'allow', reason: `提權 #${id}, 以 owner 角色執行` })
  expect(await e.onHook(conv, send('worker', 'S1'))).toEqual({ decision: 'allow', reason: `提權 #${id}, 以 owner 角色執行` })
  expect(e.boundRole(conv.key, 'S1')).toBe('owner')
  expect(e.boundRole(conv.key, undefined)).toBeNull()
  // the owner's turn over, a turn from nobody: the main session is back to its role
  await e.onHook(conv, { event: 'stop' })
  expect((await e.onHook(conv, pre('ListAgents'))).decision).toBe('deny')
  e.stop()
})

test('elevation: a power sender in a user conversation is not asked in the chat nor passed (power may not either); with the owner in the same turn the high-risk call is asked in the chat (once only); a power user may not approve it', async () => {
  const { conv, e, sent } = harness('user')
  e.onDeliver(conv, POWER)
  const d = await e.onHook(conv, send('worker'))
  expect(d.reason).toContain('請改用不越權的方法完成')
  expect(sent).toEqual([])
  e.onDeliver(conv, OWNER) // the same turn: no automatic pass (power may not), but the owner may press
  expect((await e.onHook(conv, pre('CronCreate', { cron: '7 9 * * *', prompt: 'x' }))).reason).toContain(`發起者 u${OWNER} [owner] 的角色較高, router 已在對話裡詢問是否提權 (#1`)
  expect(sent[0]!.buttons).toEqual(['elev:1:once', 'elev:1:deny'])
  expect(sent[0]!.text).toContain(`u${POWER} [power], u${OWNER} [owner] 在 ${conv.key}`)
  expect(await e.decide('elev:1:once', POWER)).toBe('你的角色 (power) 也不允許這個動作')
  expect(await e.decide('elev:1:once', ADMIN)).toBe('已提權一次')
  e.stop()
})

test('a power conversation: blocked, an admin\'s turn passes at once; an admin conversation never needs it', async () => {
  const p = harness('power')
  p.e.onDeliver(p.conv, ADMIN)
  expect(await p.e.onHook(p.conv, pre('PushNotification', { message: 'x', status: 'proactive' }))).toMatchObject({ decision: 'allow', effRole: 'admin' })
  expect(p.sent).toEqual([])
  const a = harness('admin', '-100777')
  a.e.onDeliver(a.conv, OWNER)
  for (const t of [...TOOLS, 'SendMessage']) expect(await a.e.onHook(a.conv, t === 'SendMessage' ? send('worker') : pre(t))).toEqual({})
  expect(a.sent).toEqual([])
  expect(db.elevLog(a.conv.key, 5)).toEqual([])
  p.e.stop(); a.e.stop()
})

test('cc-hook forwards an Agent call\'s name and subagent_type (not other tools\' name fields) and SubagentStart\'s agent_type', async () => {
  const conv = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const seen: any[] = []
  const ipc = createIpc({ cfg, db, onCall: async () => ({ content: [] }), identify: () => ({ mode: 'worker', conv, role: 'user' }), onHook: async (_p, ev) => { seen.push(ev); return {} } })
  const hook = (event: string, input: object) => Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', event], {
    stdin: new Blob([JSON.stringify({ cwd: conv.folder, ...input })]),
    env: { ...process.env, XDG_RUNTIME_DIR: cfg.stateDir, CC_TELEGRAM_ROUTER_SOCKET: cfg.socket, CLAUDE_PROJECT_DIR: conv.folder },
  }).exited
  await hook('pre', { tool_name: 'Agent', tool_input: { name: 'helper', subagent_type: 'Explore', description: 'd', prompt: 'secret prompt' } })
  await hook('pre', { tool_name: 'mcp__x__y', tool_input: { name: 'n', subagent_type: 't' } })
  await hook('subagent-start', { agent_id: 'a1', agent_type: 'Explore' })
  for (let i = 0; i < 40 && seen.length < 3; i++) await new Promise(r => setTimeout(r, 25))
  expect(seen[0]).toMatchObject({ event: 'pre', tool_name: 'Agent', tool_input: { name: 'helper', subagent_type: 'Explore', description: 'd' } })
  expect(seen[0].tool_input.prompt).toBeUndefined()
  expect(seen[1].tool_input).toEqual({})
  expect(seen[2]).toEqual({ event: 'subagent-start', agent_id: 'a1', agent_type: 'Explore' })
  ipc.stop()
}, 30000)
