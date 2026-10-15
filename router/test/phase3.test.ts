// Phase 3 acceptance (plan 10 Phase 3; 03 對話權限怎麼算 and /router perm, 07
// 權限與隔離 and 提權, 00 跨對話傳訊). Keep in sync with those sections.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { ensureConversation, findByFolder } from '../conversations'
import { checkCall } from '../permcheck'
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

// --- 07 權限檢查 --------------------------------------------------------------

test('permcheck: each role template allows what it lists and blocks the rest, with a reason', () => {
  const f = join(dir, 'g')
  const as = (role: string) => applyOverrides(renderSettings(TEMPLATES, role, vars(f)), [])
  const bash = (command: string, extra = {}) => ({ tool_name: 'Bash', tool_input: { command, ...extra } })
  const file = (tool: string, file_path: string) => ({ tool_name: tool, tool_input: { file_path } })
  const user = as('user')
  expect(checkCall(user, bash('ls -la'), f).ok).toBe(true)
  expect(checkCall(user, bash('cat notes.txt | grep x'), f).ok).toBe(true)
  expect(checkCall(user, bash('ls && rm -rf x'), f, 'user')).toEqual({ ok: false, why: 'user 的 Bash 只能跑唯讀指令, 這個不在允許範圍: rm -rf x' })
  expect(checkCall(user, bash('find . -exec rm {} ;'), f, 'user')).toMatchObject({ ok: false, why: expect.stringContaining('禁止這個指令') })
  expect(checkCall(user, file('Read', `${f}/a.txt`), f).ok).toBe(true)
  expect(checkCall(user, file('Read', 'notes/a.txt'), f).ok).toBe(true) // relative to the folder
  expect(checkCall(user, file('Read', '/etc/passwd'), f, 'user')).toEqual({ ok: false, why: 'user 不能讀取允許範圍外的路徑: /etc/passwd' })
  expect(checkCall(user, file('Write', `${f}/.chat/context.json`), f, 'user').ok).toBe(false)
  expect(checkCall(user, { tool_name: 'Glob', tool_input: { pattern: '**/*.md' } }, f).ok).toBe(true)
  expect(checkCall(user, { tool_name: 'mcp__plugin_telegram_telegram__reply', tool_input: {} }, f).ok).toBe(true)
  expect(checkCall(user, { tool_name: 'mcp__claude-in-chrome__navigate', tool_input: {} }, f).ok).toBe(false)
  expect(checkCall(user, { tool_name: 'Agent', tool_input: {} }, f).ok).toBe(true) // unknown to the checker: left to Claude Code
  const power = as('power')
  expect(checkCall(power, bash('python3 x.py && rm y'), f).ok).toBe(true)
  expect(checkCall(power, bash('ls /x', { dangerouslyDisableSandbox: true }), f, 'power')).toEqual({ ok: false, why: 'power 的 Bash 只能在 sandbox 裡執行, 不能跳出 sandbox' })
  const guest = as('guest')
  expect(checkCall(guest, { tool_name: 'WebFetch', tool_input: { url: 'https://x' } }, f, 'guest')).toEqual({ ok: false, why: 'guest 不能使用 WebFetch' })
  expect(checkCall(guest, file('Read', `${f}/attachments/p.jpg`), f).ok).toBe(true)
  expect(checkCall(guest, bash('ls'), f, 'guest')).toEqual({ ok: false, why: 'guest 不能使用 Bash' })
  expect(checkCall(as('owner'), bash('rm -rf /', { dangerouslyDisableSandbox: true }), f).ok).toBe(true)
  // /router perm overrides count
  const more = applyOverrides(renderSettings(TEMPLATES, 'user', vars(f)), [{ conv: 'g', kind: 'path-read', value: '/x/data' }, { conv: 'g', kind: 'mcp', value: 'claude-in-chrome' }])
  expect(checkCall(more, file('Read', '/x/data/a.csv'), f).ok).toBe(true)
  expect(checkCall(more, { tool_name: 'mcp__claude-in-chrome__navigate', tool_input: {} }, f).ok).toBe(true)
})

// --- 07 提權 -------------------------------------------------------------------

function elevHarness(opts: { askTimeoutMs?: number } = {}) {
  const conv = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const { approvals, sent, edits } = fakeApprovals()
  const told: string[] = []
  db.setUserRole('42', 'user')
  const e = createElevation({
    db, approvals, notify: (_c, t) => told.push(t), label: u => `u${u}`,
    roleOf: uid => uid === OWNER ? 'owner' : db.getUserRole(uid) ?? 'user',
    settingsAs: (c, role) => applyOverrides(renderSettings(TEMPLATES, role, vars(c.folder)), db.listOverrides(c.key)),
    askTimeoutMs: opts.askTimeoutMs ?? 60_000,
  })
  return { conv, e, sent, edits, told }
}
const escape = { event: 'pre', tool_name: 'Bash', tool_input: { command: 'ls /x', description: '列出 /x', dangerouslyDisableSandbox: true } }

test('elevation: a plain user turn is refused with advice (find another way, or ask whether to request it from the owner); the refusal is logged', async () => {
  const { conv, e, sent } = elevHarness()
  expect(e.onDeliver(conv, '42')).toEqual({ sender_role: 'user' })
  const d = await e.onHook(conv, { event: 'pre', tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } })
  expect(d.decision).toBe('deny')
  expect(d.reason).toBe('權限不足 (本對話角色 user): user 不能讀取允許範圍外的路徑: /etc/hosts. 請改用不越權的方法完成. 如果在不越權的情況下無法合理完成, 告訴對方這個請求無法繼續, 並問對方是否要向 bot owner 申請權限; 對方同意後呼叫 request_elevation 說明原因.')
  expect(sent).toEqual([])
  expect(db.elevLog(conv.key, 5).map(l => l.kind)).toEqual(['blocked'])
  expect(await e.onHook(conv, { event: 'pre', tool_name: 'Read', tool_input: { file_path: `${conv.folder}/a` } })).toEqual({})
})

test('elevation: a higher-role sender gets an in-chat 提權執行/拒絕 prompt; only a role high enough may approve; approval runs the next subagent with that role', async () => {
  const { conv, e, sent, edits, told } = elevHarness()
  db.setUserRole(ADMIN, 'admin')
  expect(e.onDeliver(conv, OWNER)).toEqual({ sender_role: 'owner', elevated: 'true' })
  const d = await e.onHook(conv, escape)
  expect(d.reason).toContain('router 已在對話裡詢問是否提權 (#1, 60 秒內沒人回應視為拒絕)')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ chat: '-100555', buttons: ['elev:1:approve', 'elev:1:deny'] })
  expect(sent[0]!.text).toContain('原因: 列出 /x')
  // a second refusal in the same turn does not ask again
  expect((await e.onHook(conv, escape)).reason).toContain('已在對話裡詢問是否提權 (#1)')
  expect(sent).toHaveLength(1)
  expect(await e.decide('elev:1:approve', '42')).toBe('你的角色 (user) 沒有高於這個對話 (user), 不能決定')
  expect(await e.decide('elev:1:approve', ADMIN)).toBe('你的角色 (admin) 也不允許這個動作')
  expect(await e.decide('elev:1:approve', OWNER)).toBe('已提權')
  expect(edits[0]!.text).toEndWith(`⚡ 已提權 (u${OWNER} [owner], 以 owner 角色執行)`)
  expect(told[0]).toContain('提權 #1 已核准')
  expect(told[0]).toContain('開「一個」general-purpose subagent')
  expect(db.getElevation(1)).toMatchObject({ status: 'approved', decided_by: OWNER, decided_role: 'owner', kind: 'passive' })
  const log = db.elevLog(conv.key, 10).reverse()
  expect(log.map(l => l.kind)).toEqual(['blocked', 'request', 'blocked', 'approved'])
  expect(log[3]!.text).toContain(`原始請求: https://t.me/c/555/${sent[0]!.id}`)
  // the next subagent runs as owner; the main session and a second subagent do not
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'A' })
  expect(await e.onHook(conv, { ...escape, agent_id: 'A' })).toEqual({ decision: 'allow', reason: '提權 #1, 以 owner 角色執行' })
  expect((await e.onHook(conv, escape)).decision).toBe('deny')
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'B' })
  expect((await e.onHook(conv, { ...escape, agent_id: 'B' })).decision).toBe('deny')
  // a later turn from a plain user may not steer A
  e.onDeliver(conv, '42')
  expect(await e.onHook(conv, { event: 'pre', tool_name: 'SendMessage', tool_input: { to: 'A' } })).toMatchObject({ decision: 'deny' })
  await e.onHook(conv, { event: 'subagent-stop', agent_id: 'A' })
  expect((await e.onHook(conv, { ...escape, agent_id: 'A' })).decision).toBe('deny')
  e.stop()
})

test('elevation: nobody answers within the time limit -> refused by default, the worker is told, the log shows it', async () => {
  const { conv, e, edits, told } = elevHarness({ askTimeoutMs: 50 })
  e.onDeliver(conv, OWNER)
  await e.onHook(conv, escape)
  for (let i = 0; i < 40 && !told.length; i++) await new Promise(r => setTimeout(r, 25))
  expect(db.getElevation(1)!.status).toBe('expired')
  expect(edits[0]!.text).toEndWith('⌛ 逾時, 預設拒絕')
  expect(told[0]).toContain('逾時沒有回應, 視為拒絕')
  expect(db.elevLog(conv.key, 1)[0]!.kind).toBe('expired')
  expect(await e.decide('elev:1:approve', OWNER)).toBe('這個請求已經逾時了')
})

test('elevation: request_elevation from a plain user turn goes to the bot owner; a denial is reported', async () => {
  const { conv, e, sent, told } = elevHarness()
  e.onDeliver(conv, '42')
  expect(await e.request(conv, '要讀共用資料', '讀 /x/data/a.csv')).toBe('已向 bot owner 申請提權 (#1), 結果會以 <router_status> 通知')
  expect(sent[0]).toMatchObject({ chat: OWNER, buttons: ['elev:1:approve', 'elev:1:deny'] })
  expect(sent[0]!.text).toContain('(主動申請)')
  expect(await e.request(conv, 'again', 'x')).toBe('已有一個提權請求在等待 (#1)')
  expect(await e.decide('elev:1:deny', OWNER)).toBe('已拒絕')
  expect(told[0]).toContain('被拒絕')
  expect(db.elevLog(conv.key, 5).map(l => l.kind).reverse()).toEqual(['request', 'denied'])
})

test('elevation log: with an approvals group, every entry also goes to its 提權紀錄 topic', async () => {
  const { conv, e, sent } = elevHarness()
  db.updateBotSetup('cc', { approvals_chat: '-100900', approvals_topic: 7, notices_topic: 5, elevlog_topic: 9 })
  e.onDeliver(conv, '42')
  await e.onHook(conv, { event: 'pre', tool_name: 'WebFetch', tool_input: { url: 'https://x' } }) // user has WebFetch: allowed, not logged
  await e.onHook(conv, { event: 'pre', tool_name: 'Bash', tool_input: { command: 'rm x' } })
  expect(sent.map(m => [m.chat, m.thread])).toEqual([['-100900', 9]])
  expect(sent[0]!.text).toStartWith('⛔ group-100555 被擋: Bash: rm x')
})

test('cc-hook asks the router and prints its PreToolUse decision; unreachable router denies leaving the sandbox', async () => {
  const { conv, e } = elevHarness()
  const ipc = createIpc({
    cfg, db, onCall: async () => ({ content: [] }),
    identify: d => { const x = findByFolder(db, d); return x ? { mode: 'worker', conv: x, role: x.role } : null },
    onHook: (peer, ev) => e.onHook(peer.conv!, ev as any),
  })
  const hook = async (event: string, input: object, socket = cfg.socket) => {
    const p = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', event], {
      stdin: new Blob([JSON.stringify({ cwd: conv.folder, ...input })]), stdout: 'pipe',
      env: { ...process.env, CC_TELEGRAM_ROUTER_SOCKET: socket, CLAUDE_PROJECT_DIR: conv.folder },
    })
    const out = await new Response(p.stdout).text()
    return out ? JSON.parse(out).hookSpecificOutput : null
  }
  const esc = { tool_name: 'Bash', tool_input: { command: 'ls /x', dangerouslyDisableSandbox: true } }
  e.onDeliver(conv, OWNER)
  expect(await hook('pre', esc)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('router 已在對話裡詢問是否提權 (#1') })
  await e.decide('elev:1:approve', OWNER)
  await hook('subagent-start', { agent_id: 'sub1' })
  expect(await hook('pre', { ...esc, agent_id: 'sub1' })).toMatchObject({ permissionDecision: 'allow' })
  expect(await hook('pre', { tool_name: 'Read', tool_input: { file_path: `${conv.folder}/x` } })).toBeNull() // within the role: no opinion
  ipc.stop(); e.stop()
  expect(await hook('pre', esc, join(dir, 'nowhere.sock'))).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'router unreachable: no unsandboxed commands' })
}, 30000)

// --- 05 目錄: bot 資料夾 ---------------------------------------------------------

test('bot folders: <home>/bot<id>/<type>-<chat>; an old <home>/<key> conversation moves there with its transcripts', async () => {
  const { botDir, convFolder, ensureBotDir, migrateConversation, projectStore, BOT_CLAUDE_MD } = await import('../conversations')
  cfg.bots = [{ name: 'cc', token: '1234567890:secret' }, { name: 'b2', token: '42:x' }]
  expect(botDir(cfg, 'cc')).toBe(join(dir, 'bot1234567890'))
  expect(convFolder(cfg, 'b2', '-1009', 'group')).toBe(join(dir, 'bot42', 'group-1009'))
  ensureBotDir(cfg, 'cc')
  expect(await Bun.file(join(dir, 'bot1234567890', 'CLAUDE.md')).text()).toBe(BOT_CLAUDE_MD('cc'))
  // a conversation from before bot folders
  const old = join(dir, 'dm-7')
  mkdirSync(join(old, 'memory'), { recursive: true })
  writeFileSync(join(old, 'memory', 'm.md'), 'remember')
  db.insertConversation({ key: 'dm-7', bot: 'cc', chat_id: '7', type: 'dm', folder: old, role: 'user', session_id: 's1', created_at: new Date().toISOString() })
  const projects = join(dir, 'projects')
  mkdirSync(projectStore(old, projects), { recursive: true })
  writeFileSync(join(projectStore(old, projects), 's1.jsonl'), '{}')
  const moved = migrateConversation(cfg, db, db.getConversation('dm-7')!, projects)!
  expect(moved.folder).toBe(join(dir, 'bot1234567890', 'dm-7'))
  expect(await Bun.file(join(moved.folder, 'memory', 'm.md')).text()).toBe('remember')
  expect(await Bun.file(join(projectStore(moved.folder, projects), 's1.jsonl')).text()).toBe('{}')
  expect(existsSync(projectStore(old, projects))).toBe(false) // the emptied old store is removed
  expect(projectStore(moved.folder, projects)).toBe(join(projects, `${dir.replace(/[/.]/g, '-')}-bot1234567890-dm-7`))
  expect(moved.session_id).toBe('s1') // resumed from the new folder
  expect(migrateConversation(cfg, db, moved, projects)).toBeNull() // already there
  // the lookup a plugin or hook goes through finds it, subfolders included
  expect(findByFolder(db, join(moved.folder, 'memory'))?.key).toBe('dm-7')
  expect(findByFolder(db, old)).toBeNull()
})
