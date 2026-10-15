// Phase 3 acceptance (plan 10 Phase 3; 03 對話權限怎麼算 and /router perm, 07
// 權限與隔離 and 提權, 00 跨對話傳訊). Keep in sync with those sections.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { ensureConversation } from '../conversations'
import { renderSettings, applyOverrides } from '../settings'
import { runCommand, type CommandDeps } from '../commands'
import { makeAssertAllowedChat } from '../guard'
import { createElevation } from '../elevation'
import { requestGrant, decideGrant, type GrantDeps } from '../grants'
import { approvalPlace, noticePlace, type ApprovalDeps } from '../approvals'
import { createIpc } from '../ipc'
import type { Access } from '../telegram/policy'

const TEMPLATES = join(import.meta.dir, '..', '..', 'templates')
const OWNER = '137438526', ADMIN = '500'
let dir: string, cfg: Config, db: RouterDb, calls: string[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr3-'))
  mkdirSync(join(dir, '.router'))
  cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, '.router', 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude' }
  db = openRouterDb(join(dir, '.router', 'router.db'))
  db.setUserRole(ADMIN, 'admin')
  calls = []
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
const vars = (folder: string) => ({ folder, autoCompactWindow: 750000, hooksDir: '/h' })

// --- 07 role templates -------------------------------------------------------

test('five role templates: owner bypass; admin/power write and run code in a sandbox with package registries; user read-only Bash; guest talk only', () => {
  const f = '/x/cc/group-1'
  const owner = renderSettings(TEMPLATES, 'owner', vars(f)) as any
  expect(owner.permissions.defaultMode).toBe('bypassPermissions')
  expect(owner.sandbox).toBeUndefined()
  for (const r of ['admin', 'power']) {
    const s = renderSettings(TEMPLATES, r, vars(f)) as any
    expect(s.permissions.defaultMode).toBe('dontAsk')
    expect(s.permissions.allow).toContain('Bash')
    expect(s.permissions.deny).toContain(`Write(/${f}/.chat/**)`)
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(true)
    expect(s.sandbox.filesystem.denyWrite).toEqual([`${f}/.chat`])
    expect(s.sandbox.network.allowedDomains).toEqual(['pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org'])
  }
  const user = renderSettings(TEMPLATES, 'user', vars(f)) as any
  expect(user.permissions.allow).not.toContain('Bash')
  expect(user.sandbox.autoAllowBashIfSandboxed).toBe(false)
  const guest = renderSettings(TEMPLATES, 'guest', vars(f)) as any
  expect(guest.permissions.allow).toEqual(['mcp__plugin_telegram_telegram', `Read(/${f}/attachments/**)`])
  // every non-owner template keeps the progress + elevation hooks
  for (const r of ['admin', 'power', 'user', 'guest']) {
    const h = (renderSettings(TEMPLATES, r, vars(f)) as any).hooks
    expect(Object.keys(h)).toEqual(expect.arrayContaining(['PreToolUse', 'SubagentStart', 'SubagentStop', 'SessionStart']))
  }
})

test('overrides lay paths into both permission rules and the sandbox, domains into sandbox network, mcp into allow', () => {
  const s = applyOverrides(renderSettings(TEMPLATES, 'user', vars('/x/cc/g')), [
    { conv: 'g', kind: 'path-read', value: '/x/data/shared' },
    { conv: 'g', kind: 'path-write', value: '/x/data/out/' },
    { conv: 'g', kind: 'net', value: 'api.github.com' },
    { conv: 'g', kind: 'mcp', value: 'claude-in-chrome' },
    { conv: 'g', kind: 'tool-allow', value: 'Bash(git status *)' },
    { conv: 'g', kind: 'tool-deny', value: 'WebFetch' },
    { conv: 'g', kind: 'send', value: '-100777' },
  ]) as any
  expect(s.permissions.allow).toEqual(expect.arrayContaining(['Read(//x/data/shared/**)', 'Write(//x/data/out/**)', 'Edit(//x/data/out/**)', 'mcp__claude-in-chrome', 'Bash(git status *)']))
  expect(s.permissions.deny).toContain('WebFetch')
  expect(s.sandbox.filesystem.allowRead).toEqual(expect.arrayContaining(['/x/data/shared', '/x/data/out']))
  expect(s.sandbox.filesystem.allowWrite).toEqual(['/x/data/out'])
  expect(s.sandbox.network.allowedDomains).toEqual(['api.github.com'])
  expect(JSON.stringify(s)).not.toContain('-100777') // send is the router's check
})

// --- /router perm ------------------------------------------------------------

function deps(access: Access = { dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} } as any): CommandDeps {
  return {
    cfg, db, loadAccess: () => access, saveAccess() {},
    bots: { async list() { return [] }, async add() { return '' }, async rotate() { return '' }, async remove() {} },
    sessions: { isConnected: () => false, async restart() {}, async stop() {}, rotateNow() { calls.push('rotate') } },
    async applySettings() {}, applyPermissions(c) { calls.push(`apply ${c.key} ${c.role}`) },
    effectiveSettings: c => applyOverrides(renderSettings(TEMPLATES, c.role, vars(c.folder)), db.listOverrides(c.key)),
    async sendTo() {}, recentMessages: () => [], writeConfig() {}, restartRouter() {}, startedAt: new Date(),
  }
}
const run = (text: string, sender: string, chat = { id: sender, type: 'private' }) =>
  runCommand({ bot: 'cc', text, senderId: sender, senderName: 'x', chatId: chat.id, chatType: chat.type }, deps())

test('/router perm: show (private), role, tool/path/net/mcp/send add and rm, reset; each change reapplies and reports the difference', async () => {
  ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const show = (await run('/router perm -100555 show', OWNER))!
  expect(show.private).toBe(true)
  expect(show.reply).toContain('group-100555: 角色 user')
  const r = (await run('/router perm -100555 role power', OWNER))!
  expect(r.reply).toStartWith('group-100555 角色 user → power\n變更:')
  expect(r.reply).toContain('網域: pypi.org, files.pythonhosted.org, registry.npmjs.org')
  expect(r.reply).toEndWith('worker 閒置時會停掉, 下一則訊息套用新權限')
  expect(calls).toEqual(['apply group-100555 power'])
  expect((await run('/router perm -100555 path read /x/data/shared', OWNER))!.reply).toContain('覆寫: path-read /x/data/shared')
  expect((await run('/router perm -100555 path read relative', OWNER))!.reply).toBe('路徑要用絕對路徑, 例如 /x/data/shared')
  await run('/router perm -100555 send allow -100777', OWNER)
  await run('/router perm -100555 mcp allow claude-in-chrome', OWNER)
  expect(db.listOverrides('group-100555').map(o => o.kind).sort()).toEqual(['mcp', 'path-read', 'send'])
  expect((await run('/router perm -100555 send rm -100777', OWNER))!.reply).toContain('移除 send -100777')
  expect((await run('/router perm -100555 send rm -100777', OWNER))!.reply).toBe('group-100555 沒有 send -100777 這筆覆寫')
  expect((await run('/router perm -100555 reset', OWNER))!.reply).toContain('清掉 2 筆覆寫')
  expect(db.listOverrides('group-100555')).toEqual([])
})

test('/router perm: admin cannot touch an owner conversation nor make one owner', async () => {
  ensureConversation(cfg, db, 'cc', OWNER, 'private', () => {})
  ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  expect((await run(`/router perm ${OWNER} tool allow Bash`, ADMIN))!.reply).toBe('⛔ admin 不能異動 owner 的角色與權限')
  expect((await run('/router perm -100555 role owner', ADMIN))!.reply).toBe('⛔ admin 不能把角色設成 owner')
  expect((await run('/router perm -100555 role power', ADMIN))!.reply).toStartWith('group-100555 角色 user → power')
})

// --- 00 跨對話傳訊 --------------------------------------------------------------

test('send guard: own chat always; others only with a send grant; owner/admin any allowlisted chat', () => {
  const conv = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const access = () => ({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: { '-100777': {} }, pending: {} }) as any
  const granted = (id: string) => db.listOverrides(conv.key).some(o => o.kind === 'send' && o.value === id)
  const user = makeAssertAllowedChat({ mode: 'worker', conv, role: 'user' }, access, granted)
  expect(() => user('-100777')).toThrow(/request_send_grant/)
  db.addOverride({ conv: conv.key, kind: 'send', value: '-100777' })
  expect(() => user('-100777')).not.toThrow()
  const admin = makeAssertAllowedChat({ mode: 'worker', conv, role: 'admin' }, access)
  expect(() => admin(OWNER)).not.toThrow()
})

function fakeApprovals() {
  const sent: Array<{ bot: string; chat: string; thread?: number; text: string; buttons: string[]; id: number }> = []
  const edits: Array<{ chat: string; id: number; text: string }> = []
  let n = 100
  const approvals: ApprovalDeps = {
    db, owners: [OWNER], isAdmin: uid => uid === ADMIN,
    async send(bot, to, text, buttons) {
      if (to.chat_id === 'unreachable') return null
      sent.push({ bot, chat: to.chat_id, thread: to.thread_id, text, buttons: buttons.map(b => b.data), id: ++n }); return n
    },
    async edit(_bot, chat, id, text) { edits.push({ chat, id, text }) },
  }
  return { approvals, sent, edits }
}

test('approvals place: the owner DM by default; the approvals group topics once set up', () => {
  expect(approvalPlace(db, [OWNER], 'cc')).toEqual({ chat_id: OWNER })
  expect(noticePlace(db, [OWNER], 'cc')).toEqual({ chat_id: OWNER })
  db.updateBotSetup('cc', { approvals_chat: '-100900', approvals_topic: 7, notices_topic: 5 })
  expect(approvalPlace(db, [OWNER], 'cc')).toEqual({ chat_id: '-100900', thread_id: 7 })
  expect(noticePlace(db, [OWNER], 'cc')).toEqual({ chat_id: '-100900', thread_id: 5 })
  expect(approvalPlace(db, [OWNER], 'other')).toEqual({ chat_id: OWNER })
  expect(approvalPlace(db, [], 'other')).toBeNull()
})

test('grants: owner mode goes to the approvals place; only owner/admin decide; approval adds a permanent send, every copy shows it, the worker is told', async () => {
  const from = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  db.updateBotSetup('cc', { approvals_chat: '-100900', approvals_topic: 7, notices_topic: 5 })
  const { approvals, sent, edits } = fakeApprovals()
  const told: string[] = []
  const g: GrantDeps = { db, approvals, notify(c, text) { told.push(`${c.key}: ${text}`) }, label: id => id }
  expect(await requestGrant(g, from, '-100777', 'owner', '回報結果')).toBe('已向 owner 申請 (#1), 決定後會通知你')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ chat: '-100900', thread: 7, buttons: ['grant:1:approve', 'grant:1:deny'] })
  expect(sent[0]!.text).toContain('理由: 回報結果')
  expect(await decideGrant(g, 'grant:1:approve', '999', '-100900')).toBe('你不能決定這個申請')
  expect(await decideGrant(g, 'grant:1:approve', ADMIN, '-100900')).toBe('已允許')
  expect(await decideGrant(g, 'grant:1:deny', OWNER, '-100900')).toBe('這個申請已經允許了')
  expect(db.listOverrides(from.key)).toEqual([{ conv: from.key, kind: 'send', value: '-100777' }])
  expect(edits).toEqual([{ chat: '-100900', id: sent[0]!.id, text: `${sent[0]!.text}\n\n已允許 (${ADMIN})` }])
  expect(told[0]).toContain('跨對話傳訊申請 #1 已允許')
  expect(await requestGrant(g, from, '-100777', 'owner', 'x')).toBe('已經可以送往 -100777, 直接送出即可')
})

test('grants: target mode asks the target chat and the owner at once; the first press decides and both copies show it; a denial grants nothing', async () => {
  const from = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const { approvals, sent, edits } = fakeApprovals()
  const told: string[] = []
  const g: GrantDeps = { db, approvals, notify(_c, t) { told.push(t) }, label: id => id }
  expect(await requestGrant(g, from, '-100888', 'target', '想分享')).toBe('已在目標對話詢問, 也同步給 owner (#1), 決定後會通知你')
  expect(sent.map(m => m.chat)).toEqual([OWNER, '-100888'])
  expect(sent[0]!.text).toContain('也已在目標對話詢問')
  expect(await decideGrant(g, 'grant:1:deny', '42', '-100999')).toBe('你不能決定這個申請') // a stranger elsewhere
  expect(await decideGrant(g, 'grant:1:deny', '42', '-100888')).toBe('已拒絕') // anyone in the target chat
  expect(await decideGrant(g, 'grant:1:approve', OWNER, OWNER)).toBe('這個申請已經拒絕了')
  expect(db.listOverrides(from.key)).toEqual([])
  expect(edits.map(e => e.chat)).toEqual([OWNER, '-100888'])
  expect(told[0]).toContain('已拒絕')
  expect(await decideGrant(g, 'not-ours', '42', '-100888')).toBeNull()
  // the owner may decide a target-mode request from the approvals place too
  await requestGrant(g, from, '-100888', 'target', '再一次')
  expect(await decideGrant(g, 'grant:2:approve', OWNER, OWNER)).toBe('已允許')
  // the target chat unreachable: the owner alone decides
  expect(await requestGrant(g, from, 'unreachable', 'target', 'x')).toBe('無法在 unreachable 詢問 (bot 可能不在那個對話), 已改由 owner 決定 (#3)')
})

// --- 07 提權 -------------------------------------------------------------------

test('elevation: an owner message in a lower conversation lets exactly the next subagent out; main session and others stay; a non-owner turn cannot steer it', () => {
  const e = createElevation([OWNER])
  expect(e.onDeliver('g', 'user', '42')).toBeNull()
  const note = e.onDeliver('g', 'user', OWNER)!
  expect(note).toContain(`role: owner (elevated by uid#${OWNER}), original role: user`)
  // main session cannot leave the sandbox even in the owner's turn
  expect(e.onHook('g', { event: 'pre', tool_name: 'Bash', tool_input: { dangerouslyDisableSandbox: true } })).toMatchObject({ decision: 'deny' })
  e.onHook('g', { event: 'subagent-start', agent_id: 'A' })
  expect(e.onHook('g', { event: 'pre', agent_id: 'A', tool_name: 'Bash', tool_input: { dangerouslyDisableSandbox: true } })).toMatchObject({ decision: 'allow' })
  expect(e.onHook('g', { event: 'pre', agent_id: 'A', tool_name: 'Read' })).toMatchObject({ decision: 'allow' })
  // bound once: a second subagent gets nothing
  e.onHook('g', { event: 'subagent-start', agent_id: 'B' })
  expect(e.onHook('g', { event: 'pre', agent_id: 'B', tool_name: 'Bash', tool_input: { dangerouslyDisableSandbox: true } })).toMatchObject({ decision: 'deny' })
  expect(e.onHook('g', { event: 'pre', agent_id: 'B', tool_name: 'Read' })).toEqual({}) // normal permissions apply
  // another conversation's agent id does not count
  expect(e.onHook('other', { event: 'pre', agent_id: 'A', tool_name: 'Read' })).toEqual({})
  // a non-owner message arrives; the main session may not steer A
  e.onDeliver('g', 'user', '42')
  expect(e.onHook('g', { event: 'pre', tool_name: 'SendMessage', tool_input: { to: 'A' } })).toMatchObject({ decision: 'deny' })
  e.onHook('g', { event: 'subagent-stop', agent_id: 'A' })
  expect(e.onHook('g', { event: 'pre', agent_id: 'A', tool_name: 'Read' })).toEqual({})
  // an owner turn that ends without a subagent drops the pending mark; owner conversations never elevate
  e.onDeliver('g', 'user', OWNER); e.onHook('g', { event: 'stop' }); e.onHook('g', { event: 'subagent-start', agent_id: 'C' })
  expect(e.state().bound).toEqual([])
  expect(e.onDeliver('dm-owner', 'owner', OWNER)).toBeNull()
})

test('cc-hook asks the router and prints its PreToolUse decision; unreachable router denies leaving the sandbox', async () => {
  const conv = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const e = createElevation([OWNER])
  const ipc = createIpc({
    cfg, db, onCall: async () => ({ content: [] }),
    identify: d => { const x = db.getConversation(d.slice(dir.length + 1).split('/')[0]!); return x ? { mode: 'worker', conv: x, role: x.role } : null },
    onHook: (peer, ev) => e.onHook(peer.conv!.key, ev as any),
  })
  const hook = async (event: string, input: object, socket = cfg.socket) => {
    const p = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', event], {
      stdin: new Blob([JSON.stringify({ cwd: conv.folder, ...input })]), stdout: 'pipe',
      env: { ...process.env, CC_TELEGRAM_ROUTER_SOCKET: socket, CLAUDE_PROJECT_DIR: conv.folder },
    })
    const out = await new Response(p.stdout).text()
    return out ? JSON.parse(out).hookSpecificOutput : null
  }
  const escape = { tool_name: 'Bash', tool_input: { command: 'ls /x', dangerouslyDisableSandbox: true } }
  expect(await hook('pre', escape)).toMatchObject({ permissionDecision: 'deny' })
  e.onDeliver(conv.key, 'user', OWNER)
  await hook('subagent-start', { agent_id: 'sub1' })
  expect(await hook('pre', { ...escape, agent_id: 'sub1' })).toMatchObject({ permissionDecision: 'allow' })
  expect(await hook('pre', { tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeNull() // no opinion: normal rules
  ipc.stop()
  expect(await hook('pre', escape, join(dir, 'nowhere.sock'))).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'router unreachable: no unsandboxed commands' })
}, 30000)
