// High-risk tools need elevation for power and below (docs/permissions.md
// 「高風險工具」; router/permcheck.ts riskyRefusal, router/elevation.ts own
// subagents). Keep in sync with that section and docs/testing.md 驗收對照.
// The real claude CLI: role-live.test.ts (LIVE=1); through the real router: e2e-toolhistory.test.ts.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Config } from '../config'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { ensureConversation } from '../conversations'
import { riskyRefusal, RISKY_TOOLS } from '../permcheck'
import { renderSettings, applyOverrides } from '../settings'
import { createElevation } from '../elevation'
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
    askTimeoutMs: 60_000,
  })
  return { conv, e: make(), make, sent, told }
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
  expect(await verdict(other.e, other.conv, send('helper'))).toBe('deny')
  // after a router restart the subagents from before are unknown: treated as another session
  const again = harness('user').make()
  expect(await verdict(again, conv, send('helper'))).toBe('deny')
  e.stop(); other.e.stop(); again.stop()
})

test('elevation: an owner\'s turn in a user conversation is asked in the chat, once only (no 永久允許); approved, the subagent may list agents and message another session; the main session still may not', async () => {
  const { conv, e, sent, told } = harness('user')
  e.onDeliver(conv, OWNER)
  const d = await e.onHook(conv, pre('ListAgents'))
  expect(d.reason).toContain('權限不足 (本對話角色 user): power 以下的角色不能使用 ListAgents.')
  expect(d.reason).toContain('router 已在對話裡詢問是否提權 (#1,')
  expect(sent[0]!.buttons).toEqual(['elev:1:once', 'elev:1:deny'])
  expect(sent[0]!.text).toContain('♾️ 不能永久允許: 高風險工具 (傳訊給其他 session, ListAgents, 排程, 遠端觸發, 推播) 只能一次一次允許.')
  expect(await e.decide('elev:1:always', OWNER)).toBe('不能永久允許: 高風險工具 (傳訊給其他 session, ListAgents, 排程, 遠端觸發, 推播) 只能一次一次允許')
  expect(await e.decide('elev:1:once', OWNER)).toBe('已提權一次')
  expect(told[0]).toContain('提權 #1 已核准')
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'S1' })
  expect(await e.onHook(conv, pre('ListAgents', {}, 'S1'))).toEqual({ decision: 'allow', reason: '提權 #1, 以 owner 角色執行' })
  expect(await e.onHook(conv, send('worker', 'S1'))).toEqual({ decision: 'allow', reason: '提權 #1, 以 owner 角色執行' })
  expect(e.boundRole(conv.key, 'S1')).toBe('owner')
  expect(e.boundRole(conv.key, undefined)).toBeNull()
  expect((await e.onHook(conv, pre('ListAgents'))).decision).toBe('deny')
  expect(db.listOverrides(conv.key)).toEqual([]) // nothing permanent
  e.stop()
})

test('elevation: a power sender in a user conversation is not asked in the chat (power may not either); a power user may not approve one; an active request still goes to the owner', async () => {
  const { conv, e, sent } = harness('user')
  e.onDeliver(conv, POWER)
  const d = await e.onHook(conv, send('worker'))
  expect(d.reason).toContain('請改用不越權的方法完成')
  expect(sent).toEqual([])
  // asked by an owner's turn, pressed by power
  e.onDeliver(conv, OWNER)
  await e.onHook(conv, pre('CronCreate', { cron: '7 9 * * *', prompt: 'x' }))
  expect(await e.decide('elev:1:once', POWER)).toBe('你的角色 (power) 也不允許這個動作')
  expect(await e.decide('elev:1:once', ADMIN)).toBe('已提權一次')
  e.stop()
})

test('a power conversation: blocked, an admin\'s turn is asked in the chat; an admin conversation is never asked', async () => {
  const p = harness('power')
  p.e.onDeliver(p.conv, ADMIN)
  expect((await p.e.onHook(p.conv, pre('PushNotification', { message: 'x', status: 'proactive' }))).reason).toContain('router 已在對話裡詢問是否提權')
  const a = harness('admin', '-100777')
  a.e.onDeliver(a.conv, OWNER)
  for (const t of [...TOOLS, 'SendMessage']) expect(await a.e.onHook(a.conv, t === 'SendMessage' ? send('worker') : pre(t))).toEqual({})
  expect(a.sent).toEqual([])
  p.e.stop(); a.e.stop()
})

test('cc-hook forwards an Agent call\'s name and subagent_type (not other tools\' name fields) and SubagentStart\'s agent_type', async () => {
  const conv = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const seen: any[] = []
  const ipc = createIpc({ cfg, db, onCall: async () => ({ content: [] }), identify: () => ({ mode: 'worker', conv, role: 'user' }), onHook: async (_p, ev) => { seen.push(ev); return {} } })
  const hook = (event: string, input: object) => Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', event], {
    stdin: new Blob([JSON.stringify({ cwd: conv.folder, ...input })]),
    env: { ...process.env, CC_TELEGRAM_ROUTER_SOCKET: cfg.socket, CLAUDE_PROJECT_DIR: conv.folder },
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
