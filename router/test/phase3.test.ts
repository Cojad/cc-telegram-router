// Phase 3 acceptance (plan 10 Phase 3; 03 對話權限怎麼算 and /router perm, 07
// 權限與隔離 and 提權, 00 跨對話傳訊). Keep in sync with those sections.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { ensureConversation, findByFolder } from '../conversations'
import { checkCall, writesFile, subcommands, writesByOption, permanentRule } from '../permcheck'
import { inParens } from '../context'
import { renderSettings, applyOverrides } from '../settings'
import { runCommand, type CommandDeps } from '../commands'
import { makeAssertAllowedChat } from '../guard'
import { createElevation } from '../elevation'
import { credRoleRefusal } from '../credentials'
import { installRefusal, skillScope } from '../skills'
import { requestGrant, decideGrant, sendGranted, type GrantDeps } from '../grants'
import { approvalPlace, noticePlace, requestOriginNoter, buttons, type ApprovalDeps } from '../approvals'
import { createAuthz } from '../authz'
import { createIpc } from '../ipc'
import type { Access } from '../telegram/policy'

const TEMPLATES = join(import.meta.dir, '..', '..', 'templates')
const OWNER = '137438526', ADMIN = '500'
let dir: string, cfg: Config, db: RouterDb, calls: string[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr3-'))
  mkdirSync(join(dir, '.router'))
  cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, '.router', 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude' }
  db = openRouterDb(join(dir, '.router', 'router.db'), { owners: cfg.owners })
  db.setUserRole(ADMIN, 'admin')
  calls = []
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
const vars = (folder: string) => ({ folder, hidden: ['/srv/cc'], autoCompactWindow: 750000, hooksDir: '/h' })

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
  expect(guest.permissions.allow).toEqual(['mcp__plugin_telegram_telegram', `Read(/${f}/attachments/**)`, 'Read(/{{botDir}}/memory/**)', 'Read(/{{transcripts}}/*/tool-results/**)']) // vars() here gives no botDir or transcripts
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
  expect((await run('/router perm -100555 path read relative', OWNER))!.reply).toBe('路徑要用絕對路徑, 例如 /srv/data/shared')
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
  const editButtons: string[][] = []
  let n = 100
  const approvals: ApprovalDeps = {
    db, owners: [OWNER], isAdmin: uid => uid === ADMIN,
    async send(bot, to, text, buttons) {
      if (to.chat_id === 'unreachable') return null
      sent.push({ bot, chat: to.chat_id, thread: to.thread_id, text, buttons: buttons.map(b => b.data), id: ++n }); return n
    },
    async edit(_bot, chat, id, text, buttons) { edits.push({ chat, id, text }); editButtons.push((buttons ?? []).map(b => b.data)) },
  }
  return { approvals, sent, edits, editButtons }
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
  expect(sent[0]).toMatchObject({ chat: '-100900', thread: 7, buttons: ['grant:1:once', 'grant:1:always', 'grant:1:deny'] })
  expect(sent[0]!.text).toContain('♾️ 永久允許的範圍: group-100555 之後可以送訊息到 bot 所在的任何對話')
  expect(sent[0]!.text).toContain('理由: 回報結果')
  // the once button of a send grant lets that conversation send there from then on: named so (柯姊 2026-10-17)
  expect(sent[0]!.text).toContain('✅ 允許這個對話: 之後 group-100555 都可以傳到 -100777 (加進傳送白名單, 不用再問).')
  expect(await decideGrant(g, 'grant:1:once', '999', '-100900')).toBe('你不能決定這個申請')
  expect(await decideGrant(g, 'grant:1:once', ADMIN, '-100900')).toBe('✅ 已允許這個對話')
  expect(await decideGrant(g, 'grant:1:deny', OWNER, '-100900')).toBe('這個申請已經允許了')
  expect(db.listOverrides(from.key)).toEqual([{ conv: from.key, kind: 'send', value: '-100777' }])
  expect(edits).toEqual([{ chat: '-100900', id: sent[0]!.id, text: `${sent[0]!.text}\n\n✅ 已允許這個對話 (${ADMIN})` }])
  expect(told[0]).toContain('跨對話傳訊申請 #1 ✅ 已允許這個對話')
  expect(await requestGrant(g, from, '-100777', 'owner', 'x')).toBe('已經可以送往 -100777, 直接送出即可')
})

test('grants: a target request whose target is the approvals group (or the owner DM) is one copy, decided by owner or admin; the request and the worker say so', async () => {
  const from = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  db.updateBotSetup('cc', { approvals_chat: '-100900', approvals_topic: 7, notices_topic: 5 })
  const { approvals, sent } = fakeApprovals()
  const g: GrantDeps = { db, approvals, notify() {}, label: id => id }
  expect(await requestGrant(g, from, '-100900', 'target', '回報到審核群組')).toBe('目標對話就是審核處 (審核群組), 只送了一份申請, 由 owner 或 admin 決定 (#1), 決定後會通知你')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ chat: '-100900', thread: 7, buttons: ['grant:1:once', 'grant:1:always', 'grant:1:deny'] })
  expect(sent[0]!.text).toContain('目標對話就是這裡 (審核群組), 只有這一份申請, 由 owner 或 admin 決定.')
  expect(sent[0]!.text).not.toContain('也已在目標對話詢問')
  expect(db.getGrant(1)!.mode).toBe('owner')
  expect(await decideGrant(g, 'grant:1:once', '42', '-100900')).toBe('你不能決定這個申請') // a member of the group is not the target's say here
  expect(await decideGrant(g, 'grant:1:once', ADMIN, '-100900')).toBe('✅ 已允許這個對話')
  // no approvals group: the approvals place is the owner DM
  db.updateBotSetup('cc', { approvals_chat: null, approvals_topic: null, notices_topic: null })
  expect(await requestGrant(g, from, OWNER, 'target', 'x')).toBe('目標對話就是審核處 (owner 私訊), 只送了一份申請, 由 owner 或 admin 決定 (#2), 決定後會通知你')
  expect(sent.at(-1)!.text).toContain('目標對話就是這裡 (owner 私訊), 只有這一份申請, 由 owner 或 admin 決定.')
})

test('labels in parentheses are never nested: the target chat reads 「這個對話 (title, key)」; who decided reads 「(name, id)」 (柯姊 2026-10-17)', async () => {
  expect(inParens('柯姊 (137438526)')).toBe('(柯姊, 137438526)')
  expect(inParens('u42 [owner], 以 owner 角色執行')).toBe('(u42 [owner], 以 owner 角色執行)')
  expect(inParens('@cc:小喵 (500) [admin], 以 admin 角色執行')).toBe('(@cc:小喵, 500 [admin], 以 admin 角色執行)')
  const from = db.updateConversation(ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {}).key, { title: 'Example Group' })
  const { approvals, sent, edits } = fakeApprovals()
  const told: string[] = []
  const g: GrantDeps = { db, approvals, notify(_c, t) { told.push(t) }, label: id => `名字 (${id})` }
  await requestGrant(g, from, '-100888', 'target', '想分享')
  const inTarget = sent.find(m => m.chat === '-100888')!
  expect(inTarget.text).toContain('✅ 允許這個對話: 之後這個對話 (Example Group, group-100555) 都可以傳到這裡.')
  expect(await decideGrant(g, 'grant:1:once', OWNER, OWNER)).toBe('✅ 已允許這個對話')
  expect(edits[0]!.text).toEndWith(`✅ 已允許這個對話 (名字, ${OWNER})`)
  expect(told[0]).toContain(`跨對話傳訊申請 #1 ✅ 已允許這個對話 (名字, ${OWNER}), 現在可以送往`)
  for (const t of [...sent.map(m => m.text), ...edits.map(e => e.text), ...told]) expect(t).not.toMatch(/\([^()]*\(/) // no ( ... ( ... ) ... )
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
  expect(sent[1]!.buttons).toEqual(['grant:1:once', 'grant:1:deny']) // the target chat cannot open everything up
  expect(sent[1]!.text).toContain('✅ 允許這個對話: 之後這個對話 (group-100555) 都可以傳到這裡.')
  expect(buttons('grant', 1, false).map(b => b.text)).toEqual(['✅ 允許這個對話', '❌ 拒絕'])
  expect(buttons('elev', 1, true).map(b => b.text)).toEqual(['✅ 允許一次', '♾️ 永久允許', '❌ 拒絕']) // other kinds unchanged
  expect(await decideGrant(g, 'grant:1:deny', '42', '-100888')).toBe('❌ 已拒絕') // anyone in the target chat
  expect(await decideGrant(g, 'grant:1:once', OWNER, OWNER)).toBe('這個申請已經拒絕了')
  expect(db.listOverrides(from.key)).toEqual([])
  expect(edits.map(e => e.chat)).toEqual([OWNER, '-100888'])
  expect(told[0]).toContain('已拒絕')
  expect(await decideGrant(g, 'not-ours', '42', '-100888')).toBeNull()
  // the target chat unreachable: the owner alone decides
  expect(await requestGrant(g, from, 'unreachable', 'target', 'x')).toBe('無法在 unreachable 詢問 (bot 可能不在那個對話), 已改由 owner 決定 (#2)')
  // the owner may decide a target-mode request from the approvals place too, and only owner/admin may open everything up
  await requestGrant(g, from, '-100888', 'target', '再一次')
  expect(await decideGrant(g, 'grant:3:always', '42', '-100888')).toBe('永久允許只能由 owner 或 admin 決定')
  expect(await decideGrant(g, 'grant:3:always', OWNER, OWNER)).toBe('♾️ 已永久允許')
  expect(db.listOverrides(from.key).map(o => o.value)).toEqual(['*'])
  expect(sendGranted(['*'], '-100123', id => id === '-100123')).toBe(true)
  expect(sendGranted(['*'], '-100124', () => false)).toBe(false) // only chats the bot is allowed in
  expect(await requestGrant(g, from, '-100555', 'owner', 'x')).toBe('已經可以送往 -100555, 直接送出即可')
})

// Bot-wide memory (docs/permissions.md 「bot 共用記憶」): <botDir>/memory is
// readable by every role below owner (permission rule and sandbox allowRead),
// writable by none. role-live checks the same with the real claude.
test('bot memory: admin, power, user and guest read <botDir>/memory (Read rule and sandbox allowRead), none of them writes it', () => {
  const home = '/srv/cc', bot = `${home}/bot1`, f = `${bot}/group-1`, mem = `${bot}/memory`
  const v = { folder: f, home, hidden: [home], botDir: bot, autoCompactWindow: 750000, hooksDir: '/h', transcripts: '/t' }
  const file = (tool: string, file_path: string) => ({ tool_name: tool, tool_input: { file_path } })
  for (const role of ['admin', 'power', 'user', 'guest']) {
    const s = applyOverrides(renderSettings(TEMPLATES, role, v), []) as any
    expect(s.permissions.allow).toContain(`Read(/${mem}/**)`)
    expect(s.sandbox.filesystem.allowRead).toContain(mem)
    expect(s.sandbox.filesystem.denyRead).toEqual([home, '~'])
    // nothing opens it for writing: no Edit/Write rule, no sandbox allowWrite
    expect((s.permissions.allow as string[]).filter(r => /^(Edit|Write)\(/.test(r) && r.includes(mem))).toEqual([])
    expect(s.sandbox.filesystem.allowWrite ?? []).toEqual([])
    expect(checkCall(s, file('Read', `${mem}/facts.md`), f, role).ok).toBe(true)
    expect(checkCall(s, { tool_name: 'Grep', tool_input: { pattern: 'x', path: mem } }, f, role).ok).toBe(true)
    expect(checkCall(s, file('Write', `${mem}/facts.md`), f, role)).toEqual({ ok: false, why: `${role} 不能寫入允許範圍外的路徑: ${mem}/facts.md` })
    expect(checkCall(s, file('Edit', `${mem}/facts.md`), f, role).ok).toBe(false)
    // only memory/: the bot's persona and other conversations stay out
    expect(checkCall(s, file('Read', `${bot}/CLAUDE.md`), f, role).ok).toBe(false)
    expect(checkCall(s, file('Read', `${bot}/dm-2/notes.txt`), f, role).ok).toBe(false)
  }
  // user: cat is on the read-only list, a redirection into memory/ is not
  const user = applyOverrides(renderSettings(TEMPLATES, 'user', v), [])
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })
  expect(checkCall(user, bash(`cat ${mem}/facts.md`), f).ok).toBe(true)
  expect(checkCall(user, bash(`echo x >> ${mem}/facts.md`), f, 'user')).toMatchObject({ ok: false, redirect: true })
  // owner is unrestricted as before
  expect((renderSettings(TEMPLATES, 'owner', v) as any).permissions.defaultMode).toBe('bypassPermissions')
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
  // a read-only rule (Bash(echo *)) never covers writing a file through a redirection, as in Claude Code
  expect(checkCall(user, bash('echo hi > notes.txt'), f, 'user')).toEqual({ ok: false, why: 'user 的 Bash 只能跑唯讀指令, 這個用重導向寫入檔案: echo hi > notes.txt', redirect: true })
  expect(checkCall(user, bash('ls && cat a.txt >> b.txt'), f, 'user')).toMatchObject({ ok: false, why: expect.stringContaining('重導向寫入檔案: cat a.txt >> b.txt') })
  expect(checkCall(user, bash('echo x | tee out.txt'), f, 'user')).toMatchObject({ ok: false, why: expect.stringContaining('不在允許範圍: tee out.txt') })
  expect(checkCall(user, bash('grep -r x . 2>/dev/null'), f).ok).toBe(true)
  expect(checkCall(user, bash('ls missing 2>&1 | head -5'), f).ok).toBe(true)
  expect(checkCall(user, bash('echo "a > b" \'c >> d\''), f).ok).toBe(true) // quoted: not a redirection
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
  expect(checkCall(power, bash('echo hi > notes.txt'), f).ok).toBe(true) // power runs any Bash (in the sandbox)
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

test('subcommands: split at &&, ||, |, ; and newlines, never inside quotes or at an escaped character; the user role runs grep -E \'a|b\' and cut, sort, uniq, but not sort -o or uniq in out', () => {
  expect(subcommands("grep -n -E 'venv|postprocess|\\.venv' notes.txt")).toEqual(["grep -n -E 'venv|postprocess|\\.venv' notes.txt"])
  expect(subcommands('grep -E "a|b;c && d" f | cut -d= -f1')).toEqual(['grep -E "a|b;c && d" f', 'cut -d= -f1'])
  expect(subcommands('grep a\\|b f; ls')).toEqual(['grep a\\|b f', 'ls'])
  expect(subcommands(`echo "it's | fine" && ls || pwd\nwc -l f`)).toEqual([`echo "it's | fine"`, 'ls', 'pwd', 'wc -l f'])
  const f = join(dir, 'g')
  const user = applyOverrides(renderSettings(TEMPLATES, 'user', vars(f)), [])
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })
  // the command from 10/17 09:31: one grep, not a command named postprocess
  expect(checkCall(user, bash("grep -n -E 'venv|postprocess|\\.venv' notes.txt"), f, 'user').ok).toBe(true)
  expect(checkCall(user, bash('grep -E "x > y|z" notes.txt'), f).ok).toBe(true) // quoted > is not a redirection either
  expect(checkCall(user, bash("echo 'a && rm -rf x'"), f).ok).toBe(true)
  expect(checkCall(user, bash('ls && rm -rf x'), f, 'user')).toEqual({ ok: false, why: 'user 的 Bash 只能跑唯讀指令, 這個不在允許範圍: rm -rf x' })
  // cut, sort, uniq (柯姊 2026-10-17), with and without arguments
  for (const c of ['grep KEY .env | cut -d= -f1', 'cut -f1 a.tsv', 'sort a.txt | uniq -c', 'sort', 'uniq', 'cut', 'sort -u -k2 a.txt', 'uniq -f 1 a.txt', 'cat a | uniq - '])
    expect([c, checkCall(user, bash(c), f).ok]).toEqual([c, true])
  // ... but writing a file through them is not read-only
  for (const c of ['sort -o out.txt a.txt', 'sort a.txt -o out.txt', 'sort --output=out.txt a.txt', 'sort -uo out.txt a.txt', 'uniq a.txt out.txt', 'uniq -c a.txt out.txt'])
    expect([c, checkCall(user, bash(c), f).ok]).toEqual([c, false])
  expect(checkCall(user, bash('sort -uo out.txt a.txt'), f, 'user')).toEqual({ ok: false, why: 'user 的 Bash 只能跑唯讀指令, 這個用選項寫入檔案: sort -uo out.txt a.txt', writeOption: true })
  // no permanent rule can cover it: the elevation prompt says so
  const lay = (st: any, o: Array<{ kind: string; value: string }>) => applyOverrides(st, o.map(x => ({ conv: 'g', ...x })) as any)
  expect(permanentRule(user, bash('sort -uo out.txt a.txt'), f, lay)).toEqual({ none: '用選項寫入檔案 (例如 sort -o) 沒辦法寫成固定規則, 只能一次一次允許; 要長期開放請 owner 調整對話角色' })
  expect(writesByOption('uniq -w 3 a.txt')).toBe(false)
  expect(writesByOption('sort -k1,1 -t, a.csv')).toBe(false)
})

test('user allow-list A (柯姊 2026-10-17): which, tr, seq, hostname and cd run without elevation; every non-owner role reads its own tool-results under the transcripts folder, nothing else there', () => {
  const f = join(dir, 'g')
  const transcripts = '/home/u/.claude/projects/-x-cc-bot1-dm-1'
  const v = { ...vars(f), transcripts }
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })
  const user = applyOverrides(renderSettings(TEMPLATES, 'user', v), [])
  for (const c of ['which ffmpeg ffprobe', "tr '\\n' ' ' < a.txt", 'grep -v x a | tr -d x', 'seq 1 3', 'hostname', 'cd media && ls | wc -l; date', 'cd'])
    expect([c, checkCall(user, bash(c), f).ok]).toEqual([c, true])
  expect(checkCall(user, bash('hostname newname'), f).ok).toBe(false) // setting it is not read-only
  expect(checkCall(user, bash('cd media && rm a'), f).ok).toBe(false)
  const read = (file_path: string) => ({ tool_name: 'Read', tool_input: { file_path } })
  for (const role of ['user', 'power', 'admin', 'guest']) {
    const st = applyOverrides(renderSettings(TEMPLATES, role, v), [])
    expect([role, checkCall(st, read(`${transcripts}/0f3c-session/tool-results/artifact-1.txt`), f).ok]).toEqual([role, true])
    expect([role, checkCall(st, read(`${transcripts}/0f3c-session.jsonl`), f).ok]).toEqual([role, false])
    expect([role, checkCall(st, read('/home/u/.claude/projects/-x-cc-bot1-dm-2/s/tool-results/a.txt'), f).ok]).toEqual([role, false])
  }
})

test('writesFile: output redirections to a file count; quotes, escapes, /dev/null and fd copies do not; a command substitution in double quotes is looked into', () => {
  for (const c of ['echo hi > a', 'echo hi>a', 'cat a >> b', 'echo x &> log', 'ls 1>out', 'echo x >&out.txt', 'cat <> f', 'echo x >', 'diff <(ls) >(cat)', 'echo "$(date > t)"', 'cat <<EOF > f'])
    expect([c, writesFile(c)]).toEqual([c, true])
  for (const c of ['ls -la', 'ls 2>/dev/null', 'ls >/dev/null 2>&1', 'echo x >&2', 'grep ">" a.html', "echo '>> a'", 'echo a \\> b', 'echo "$(date)"', 'cat a 2>&-'])
    expect([c, writesFile(c)]).toEqual([c, false])
})

test('elevation: a user conversation writing a file through a redirection is blocked (logged) and, with the owner asking, offered elevation, once only', async () => {
  const { conv, e, sent } = elevHarness()
  e.onDeliver(conv, OWNER)
  const d = await e.onHook(conv, { event: 'pre', tool_name: 'Bash', tool_input: { command: 'echo hi > notes.txt', description: '寫筆記' } })
  expect(d.decision).toBe('deny')
  expect(d.reason).toContain('router 已在對話裡詢問是否提權 (#1,')
  expect(d.reason).toStartWith('權限不足 (本對話角色 user): user 的 Bash 只能跑唯讀指令, 這個用重導向寫入檔案: echo hi > notes.txt.')
  expect(sent[0]!.buttons).toEqual(['elev:1:once', 'elev:1:deny'])
  expect(sent[0]!.text).toContain('♾️ 不能永久允許: 用重導向 (>, >>) 寫入檔案沒辦法寫成固定規則, 只能一次一次允許; 要長期開放請 owner 調整對話角色.')
  expect(db.elevLog(conv.key, 5).map(l => l.kind).reverse()).toEqual(['blocked', 'request'])
  expect(await e.decide('elev:1:once', OWNER)).toBe('已提權一次')
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'W' })
  expect(await e.onHook(conv, { event: 'pre', tool_name: 'Bash', tool_input: { command: 'echo hi > notes.txt' }, agent_id: 'W' })).toEqual({ decision: 'allow', reason: '提權 #1, 以 owner 角色執行' })
  e.stop()
})

// --- 07 提權 -------------------------------------------------------------------

function elevHarness(opts: { askTimeoutMs?: number; authz?: boolean; extraCheck?: Parameters<typeof createElevation>[0]['extraCheck'] } = {}) {
  const conv = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const { approvals, sent, edits, editButtons } = fakeApprovals()
  const told: string[] = [], applied: string[] = []
  db.setUserRole('42', 'user')
  let e!: ReturnType<typeof createElevation>
  const authz = opts.authz ? createAuthz({ db, approvals, notify: (_c, t) => told.push(t), label: u => `u${u}`, applyPermissions: c => applied.push(c.key), dropElevation: ref => e.drop(ref) }) : undefined
  e = createElevation({
    db, approvals, notify: (_c, t) => told.push(t), label: u => `u${u}`, applyPermissions: c => applied.push(c.key), authz,
    roleOf: uid => uid === OWNER ? 'owner' : db.getUserRole(uid) ?? 'user',
    settingsAs: (c, role, keep) => applyOverrides(renderSettings(TEMPLATES, role, vars(c.folder)), db.listOverrides(c.key).filter(o => !keep || keep(o))),
    askTimeoutMs: opts.askTimeoutMs ?? 60_000,
    // as router/main.ts: run_skill with force needs owner or admin (privileged.json args.force.roles)
    extraCheck: opts.extraCheck ?? ((_c, call, role) => call.tool_name === 'mcp__plugin_telegram_telegram__run_skill' && (call.tool_input.args as any)?.force && !['owner', 'admin'].includes(role) ? `參數 force 只開放給 owner, admin 角色, 本對話角色 ${role} 要提權` : null),
  })
  return { conv, e, sent, edits, editButtons, told, applied, authz, approvals }
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
  expect(sent[0]).toMatchObject({ chat: '-100555', buttons: ['elev:1:once', 'elev:1:deny'] }) // leaving the sandbox: no 永久允許
  expect(sent[0]!.text).toContain('♾️ 不能永久允許: 跳出 sandbox 沒辦法寫成固定規則')
  expect(sent[0]!.text).toContain('原因: 列出 /x')
  // a second refusal in the same turn does not ask again
  expect((await e.onHook(conv, escape)).reason).toContain('已在對話裡詢問是否提權 (#1)')
  expect(sent).toHaveLength(1)
  expect(await e.decide('elev:1:once', '42')).toBe('你的角色 (user) 沒有高於這個對話 (user), 不能決定')
  expect(await e.decide('elev:1:once', ADMIN)).toBe('你的角色 (admin) 也不允許這個動作')
  expect(await e.decide('elev:1:always', OWNER)).toBe('不能永久允許: 跳出 sandbox 沒辦法寫成固定規則, 只能一次一次允許')
  expect(await e.decide('elev:1:once', OWNER)).toBe('已提權一次')
  expect(edits[0]!.text).toEndWith(`✅ 已允許一次 (u${OWNER} [owner], 以 owner 角色執行)`)
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

test('elevation: a turn typed in the worker\'s terminal has no sender: only the conversation\'s role counts, nothing is asked in the chat, even right after an owner\'s Telegram message; the next Telegram turn asks again', async () => {
  const { conv, e, sent, approvals } = elevHarness()
  const origins: number[] = [] // requests answering a Telegram message (their result replies to it)
  approvals.noteRequest = (_k, ref) => origins.push(ref)
  e.onDeliver(conv, OWNER)
  expect(await e.onHook(conv, { event: 'prompt', telegram: false })).toEqual({})
  const plain = '權限不足 (本對話角色 user): user 的 Bash 只能在 sandbox 裡執行, 不能跳出 sandbox. 請改用不越權的方法完成.'
  expect((await e.onHook(conv, escape)).reason).toStartWith(plain)
  expect((await e.onHook(conv, { ...escape, agent_id: 'T' })).reason).toStartWith(plain) // its subagents too
  // an owner's message delivered meanwhile waits for its own turn
  e.onDeliver(conv, OWNER)
  expect((await e.onHook(conv, escape)).reason).toStartWith(plain)
  expect(sent).toEqual([])
  expect(db.pendingElevations()).toEqual([])
  expect(db.elevLog(conv.key, 5).every(l => l.kind === 'blocked' && l.text.endsWith('發起者 (不明)'))).toBe(true)
  // an active request from a terminal turn goes to the owner, not into the chat
  expect(await e.request(conv, '要看 /x', 'ls /x')).toBe('已向 bot owner 申請提權 (#1), 結果會以 <router_status> 通知')
  expect(sent.filter(m => m.chat === conv.chat_id)).toEqual([])
  expect(db.getElevation(1)!.sender).toBeNull()
  expect(origins).toEqual([]) // not the last Telegram message
  db.decideElevation(1, 'denied', OWNER, null)
  // the owner's Telegram message starts its turn: asked in the chat
  await e.onHook(conv, { event: 'prompt', telegram: true })
  expect((await e.onHook(conv, escape)).reason).toContain('router 已在對話裡詢問是否提權 (#2,')
  expect(sent.filter(m => m.chat === conv.chat_id)).toHaveLength(1)
  expect(origins).toEqual([2])
  expect(db.getElevation(2)!.sender).toBe(OWNER)
  e.stop()
})

test('request origin: a request from a Telegram turn is tied to the message it answers; one from a terminal turn to none, not the last Telegram message (send grant, package review, elevation)', async () => {
  const { conv, e, approvals } = elevHarness()
  const cur = new Map([[conv.key, 321]]) // main.ts currentMsg: the last delivered Telegram message
  approvals.noteRequest = requestOriginNoter({ db, currentMsg: k => cur.get(k), terminalTurn: k => e.terminalTurn(k) })
  const g: GrantDeps = { db, approvals, notify() {}, label: id => id }
  e.onDeliver(conv, '42')
  await e.onHook(conv, { event: 'prompt', telegram: true })
  expect(e.terminalTurn(conv.key)).toBe(false)
  await requestGrant(g, conv, '-100777', 'owner', 'x')
  expect(db.requestOrigin('grant', 1)).toBe(321)
  await e.onHook(conv, { event: 'prompt', telegram: false })
  expect(e.terminalTurn(conv.key)).toBe(true)
  await requestGrant(g, conv, '-100778', 'owner', 'y')
  expect(db.requestOrigin('grant', 2)).toBeNull()
  approvals.noteRequest!('pkg', 7, conv) // as pkgreview.ts does for a review
  expect(db.requestOrigin('pkg', 7)).toBeNull()
  expect(await e.request(conv, '要看 /x', 'ls /x')).toContain('#1')
  expect(db.requestOrigin('elev', 1)).toBeNull()
  // the next Telegram turn ties again
  await e.onHook(conv, { event: 'prompt', telegram: true })
  approvals.noteRequest!('pkg', 8, conv)
  expect(db.requestOrigin('pkg', 8)).toBe(321)
  e.stop()
})

test('elevation: 永久允許 runs it this time and adds that kind of action to the conversation, spelled out in the prompt', async () => {
  const { conv, e, sent, told, applied } = elevHarness()
  e.onDeliver(conv, OWNER)
  const py = { event: 'pre', tool_name: 'Bash', tool_input: { command: 'ls && python3 run.py', description: '跑分析' } }
  await e.onHook(conv, py)
  expect(sent[0]!.buttons).toEqual(['elev:1:once', 'elev:1:always', 'elev:1:deny'])
  expect(sent[0]!.text).toContain('♾️ 永久允許的範圍: group-100555 之後可以執行 python3 開頭的 Bash 指令 (仍在 sandbox 裡), 不用再問 (權限覆寫 tool-allow Bash(python3), tool-allow Bash(python3 *))')
  expect(await e.decide('elev:1:always', OWNER)).toBe('已永久允許並提權')
  // both shapes, like the role templates: the command alone and with arguments
  expect(db.listOverrides(conv.key).map(o => o.value).sort()).toEqual(['Bash(python3 *)', 'Bash(python3)'])
  expect(applied).toEqual([conv.key])
  expect(told[0]).toContain('另外永久允許: 之後可以執行 python3 開頭的 Bash 指令')
  expect(db.elevLog(conv.key, 1)[0]!.text).toContain('永久允許: 執行 python3 開頭的 Bash 指令')
  // the rule now holds for the conversation itself
  expect(await e.onHook(conv, py)).toEqual({})
  expect(await e.onHook(conv, { event: 'pre', tool_name: 'Bash', tool_input: { command: 'python3' } })).toEqual({})
  // a read outside the folder: the permanent scope is that folder
  await e.onHook(conv, { event: 'pre', tool_name: 'Read', tool_input: { file_path: '/x/data/a.csv' } })
  expect(sent[1]!.text).toContain('之後可以讀取 /x/data 底下的檔案')
  e.stop()
})

test('elevation: a command without arguments (uptime) can be allowed for good: the rule covers it alone and with arguments', async () => {
  const { conv, e, sent } = elevHarness()
  e.onDeliver(conv, OWNER)
  const host = { event: 'pre', tool_name: 'Bash', tool_input: { command: 'uptime' } }
  await e.onHook(conv, host)
  expect(sent[0]!.buttons).toEqual(['elev:1:once', 'elev:1:always', 'elev:1:deny'])
  expect(sent[0]!.text).toContain('♾️ 永久允許的範圍: group-100555 之後可以執行 uptime 開頭的 Bash 指令 (仍在 sandbox 裡), 不用再問 (權限覆寫 tool-allow Bash(uptime), tool-allow Bash(uptime *))')
  expect(sent[0]!.text).not.toContain('明確禁止')
  expect(await e.decide('elev:1:always', OWNER)).toBe('已永久允許並提權')
  expect(await e.onHook(conv, host)).toEqual({})
  expect(await e.onHook(conv, { event: 'pre', tool_name: 'Bash', tool_input: { command: 'uptime -f' } })).toEqual({})
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
  expect(await e.decide('elev:1:once', OWNER)).toBe('這個請求已經逾時了')
})

test('elevation: request_elevation from a plain user turn goes to the bot owner; a denial is reported', async () => {
  const { conv, e, sent, told } = elevHarness()
  e.onDeliver(conv, '42')
  expect(await e.request(conv, '要讀共用資料', '讀 /x/data/a.csv')).toBe('已向 bot owner 申請提權 (#1), 結果會以 <router_status> 通知')
  expect(sent[0]).toMatchObject({ chat: OWNER, buttons: ['elev:1:once', 'elev:1:deny'] })
  expect(sent[0]!.text).toContain('♾️ 不能永久允許: 主動申請沒有具體的動作')
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
      // a 1 ms retry window: one try (the retries: retry.test.ts, e2e-retry.test.ts)
      env: { ...process.env, XDG_RUNTIME_DIR: cfg.stateDir, CC_TELEGRAM_ROUTER_SOCKET: socket, CLAUDE_PROJECT_DIR: conv.folder, CC_TELEGRAM_ROUTER_RETRY_WINDOW_MS: '1' },
    })
    const out = await new Response(p.stdout).text()
    return out ? JSON.parse(out).hookSpecificOutput : null
  }
  const esc = { tool_name: 'Bash', tool_input: { command: 'ls /x', dangerouslyDisableSandbox: true } }
  e.onDeliver(conv, OWNER)
  expect(await hook('pre', esc)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('router 已在對話裡詢問是否提權 (#1') })
  await e.decide('elev:1:once', OWNER)
  await hook('subagent-start', { agent_id: 'sub1' })
  expect(await hook('pre', { ...esc, agent_id: 'sub1' })).toMatchObject({ permissionDecision: 'allow' })
  expect(await hook('pre', { tool_name: 'Read', tool_input: { file_path: `${conv.folder}/x` } })).toBeNull() // within the role: no opinion
  ipc.stop(); e.stop()
  expect(await hook('pre', esc, join(dir, 'nowhere.sock'))).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'router unreachable: no unsandboxed commands' })
}, 30000)

// --- 撤銷與執行授權 (柯姊 2026-10-16) -----------------------------------------------

test('authz: an approved elevation keeps a 🚫 撤銷 button; each tool call of its subagent is a use, posted to 執行授權 with the call and a revoke button; revoking unbinds it', async () => {
  const { conv, e, sent, edits, editButtons, told } = elevHarness({ authz: true })
  db.updateBotSetup('cc', { approvals_chat: OWNER, approvals_topic: null, notices_topic: null, elevlog_topic: null, authuse_topic: 77 })
  e.onDeliver(conv, OWNER)
  await e.onHook(conv, escape)
  const req = sent.find(m => m.buttons[0] === 'elev:1:once')!
  expect(await e.decide('elev:1:once', OWNER)).toBe('已提權一次')
  // the in-chat copy is not at the approvals place: no revoke there; a copy at the approvals place would keep it
  expect(edits.at(-1)!.id).toBe(req.id)
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'A' })
  await e.onHook(conv, { ...escape, agent_id: 'A' })
  const use = sent.at(-1)!
  expect(use).toMatchObject({ chat: OWNER, thread: 77, buttons: ['elev:1:revoke'] })
  expect(use.text).toStartWith('🧾 提權授權 (審核 #1) 使用於 group-100555')
  expect(use.text).toContain('subagent A 以 owner 角色: Bash {"command":"ls /x"')
  expect(db.authUses(db.approvalGrantsFor('elev', 1)[0]!.id)).toHaveLength(1)
  told.length = 0
  const authz = createAuthz({ db, approvals: fakeApprovals().approvals, notify: (_c, t) => told.push(t), label: u => `u${u}`, applyPermissions() {}, dropElevation: ref => e.drop(ref) })
  expect(await authz.revoke('elev:1:revoke', '42')).toBe('只有 owner 或 admin 能撤銷')
  expect(await authz.revoke('elev:1:revoke', OWNER)).toBe('已撤銷')
  expect(await authz.revoke('elev:1:revoke', OWNER)).toBe('這個授權已經撤銷了')
  expect(told[0]).toContain('提權授權 (審核 #1) 已被 u137438526 撤銷')
  expect((await e.onHook(conv, { ...escape, agent_id: 'A' })).decision).toBe('deny') // unbound
  void editButtons
  e.stop()
})

test('authz: 永久允許 overrides are revocable; calls that pass only because of them are uses; revoking removes them and rewrites settings', async () => {
  const { conv, e, sent, edits, told, applied, authz } = elevHarness({ authz: true })
  db.updateBotSetup('cc', { authuse_topic: 77, elevlog_topic: 9, approvals_chat: OWNER })
  e.onDeliver(conv, OWNER)
  const py = { event: 'pre', tool_name: 'Bash', tool_input: { command: 'python3 run.py' } }
  await e.onHook(conv, py)
  await e.decide('elev:1:always', OWNER)
  const before = sent.length
  expect(await e.onHook(conv, py)).toEqual({})
  expect(sent.length).toBe(before + 1)
  expect(sent.at(-1)!.text).toContain('Bash {"command":"python3 run.py"}')
  // a call allowed by the role itself is not a use
  expect(await e.onHook(conv, { event: 'pre', tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({})
  expect(sent.length).toBe(before + 1)
  applied.length = 0
  expect(await authz!.revoke('elev:1:revoke', OWNER)).toBe('已撤銷')
  expect(db.listOverrides(conv.key)).toEqual([])
  expect(applied).toEqual([conv.key])
  expect(told.at(-1)).toContain('移除 tool-allow Bash(python3), tool-allow Bash(python3 *)')
  // every message it showed in is marked, the 提權成功 line in 提權紀錄 too
  const ok = sent.find(m => m.thread === 9 && m.text.startsWith('✅ 提權成功 (永久允許) #1'))!
  expect(edits.find(x => x.id === ok.id)?.text).toMatch(/^✅ 提權成功 \(永久允許\) #1[\s\S]*\n\n🚫 已撤銷 \(u\d+\)$/)
  for (const m of sent.filter(m => m.thread === 9 && !m.text.startsWith('✅'))) expect(edits.some(x => x.id === m.id)).toBe(false) // blocked and request lines are left alone
  e.stop()
})

test('authz: send grants and package approvals settle with a revoke button at the approvals place; their uses are logged; revoke takes the override back', async () => {
  const from = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  db.updateBotSetup('cc', { approvals_chat: '-100900', approvals_topic: 7, authuse_topic: 77 })
  const { approvals, sent, edits, editButtons } = fakeApprovals()
  const told: string[] = []
  const authz = createAuthz({ db, approvals, notify: (_c, t) => told.push(t), label: u => u, applyPermissions() {} })
  const g: GrantDeps = { db, approvals, notify() {}, label: id => id, authz }
  await requestGrant(g, from, '-100888', 'target', 'x')
  await decideGrant(g, 'grant:1:once', OWNER, '-100900')
  const at = edits.findIndex(x => x.chat === '-100900')
  expect(editButtons[at]).toEqual(['grant:1:revoke'])
  expect(editButtons[edits.findIndex(x => x.chat === '-100888')]).toEqual([]) // not in the target chat
  const [grant] = authz.covering(from, o => o.some(x => x.value === '-100888'))
  await authz.use(from, grant!, 'reply → -100888: hi')
  expect(sent.at(-1)).toMatchObject({ chat: '-100900', thread: 77, buttons: ['grant:1:revoke'] })
  const useMsg = sent.at(-1)!
  await authz.use(from, grant!, 'reply → -100888: again')
  const useMsg2 = sent.at(-1)!
  const before = edits.length
  expect(await authz.revoke('grant:1:revoke', ADMIN)).toBe('已撤銷')
  expect(db.listOverrides(from.key)).toEqual([])
  // every place it showed: both copies of the request and both uses, buttons gone, 已撤銷 added
  const after = edits.slice(before).map((e, i) => ({ ...e, buttons: editButtons[before + i] }))
  expect(after.map(e => e.id).sort()).toEqual([...sent.filter(m => m.buttons.includes('grant:1:once') || m.buttons.includes('grant:1:deny')).map(m => m.id), useMsg.id, useMsg2.id].sort())
  expect(after.every(e => e.buttons!.length === 0 && e.text.endsWith(`🚫 已撤銷 (${ADMIN})`))).toBe(true)
  expect(after.find(e => e.chat === '-100900' && e.text.includes('跨對話傳訊申請'))!.text).toContain(`✅ 已允許這個對話 (${OWNER})\n🚫 已撤銷 (${ADMIN})`)
  expect(after.find(e => e.id === useMsg.id)!.text).toBe(`${useMsg.text}\n\n🚫 已撤銷 (${ADMIN})`)
  // a stale button pressed later: the messages are tidied again, nothing else changes
  const n = edits.length
  expect(await authz.revoke('grant:1:revoke', OWNER)).toBe('這個授權已經撤銷了')
  expect(edits.length - n).toBe(after.length)
  expect(editButtons.slice(n).every(b => b.length === 0)).toBe(true)
  expect(edits.at(-1)!.text).toEndWith(`🚫 已撤銷 (${ADMIN})`) // still says who revoked it
  // a revoked authorization is not logged as used any more
  expect(authz.covering(from, () => true)).toEqual([])
})

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

test('authz: removing an approved override by hand (/router perm rm or reset) marks that authorization revoked and updates its messages; partly removed stays active', async () => {
  const from = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  db.updateBotSetup('cc', { approvals_chat: '-100900', approvals_topic: 7, authuse_topic: 77 })
  const { approvals, edits, editButtons } = fakeApprovals()
  const authz = createAuthz({ db, approvals, notify() {}, label: u => `u${u}`, applyPermissions() {} })
  const g: GrantDeps = { db, approvals, notify() {}, label: id => id, authz }
  await requestGrant(g, from, '-100777', 'owner', 'x')
  await decideGrant(g, 'grant:1:once', OWNER, '-100900')
  const d = { ...deps(), overridesRemoved: (c: any, uid: string) => authz.syncRemoved(c, uid) } as CommandDeps
  const before = edits.length
  const r = (await runCommand({ bot: 'cc', text: '/router perm -100555 send rm -100777', senderId: OWNER, senderName: 'x', chatId: OWNER, chatType: 'private' }, d))!
  expect(r.reply).toContain('移除 send -100777; 對應的審核授權一併標為已撤銷')
  expect(db.approvalGrantsFor('grant', 1)[0]!.status).toBe('revoked')
  expect(edits.slice(before).at(-1)!.text).toEndWith(`🚫 已撤銷 (u${OWNER}, 用 /router perm 移除)`)
  expect(editButtons.slice(before).every(b => b.length === 0)).toBe(true)
  // reset: every authorization of the conversation goes with it
  await requestGrant(g, from, '-100778', 'owner', 'y')
  await decideGrant(g, 'grant:2:once', OWNER, '-100900')
  db.addOverride({ conv: from.key, kind: 'net', value: 'example.com' }) // set by hand, not from an approval
  const reset = (await runCommand({ bot: 'cc', text: '/router perm -100555 reset', senderId: OWNER, senderName: 'x', chatId: OWNER, chatType: 'private' }, d))!
  expect(reset.reply).toContain('清掉 2 筆覆寫')
  expect(reset.reply).toContain('1 筆審核授權一併標為已撤銷')
  expect(db.activeApprovalGrants(from.key)).toEqual([])
})

test('elevation tickets: an elevated subagent\'s Telegram tool call (bot_api...) runs router-side with the elevated role, once, only for exactly that call', async () => {
  const { conv, e } = elevHarness()
  e.onDeliver(conv, OWNER)
  expect(await e.request(conv, '刪掉 bot 自己的訊息', 'bot_api self deleteMessage')).toContain('#1')
  await e.decide('elev:1:once', OWNER)
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'S' })
  const args = { credential: 'self', method: 'deleteMessage', params: { chat_id: '-100555', message_id: 157192 } }
  // the hook reports the subagent's call before it runs
  expect(await e.onHook(conv, { event: 'pre', quiet: true, agent_id: 'S', tool_name: 'mcp__plugin_telegram_telegram__bot_api', tool_input: args })).toMatchObject({ decision: 'allow' })
  expect(e.takeTicket(conv.key, 'bot_api', { params: { message_id: 157192, chat_id: '-100555' }, method: 'deleteMessage', credential: 'self' })).toBe('owner') // key order does not matter
  expect(e.takeTicket(conv.key, 'bot_api', args)).toBeNull() // one use
  // the main session's own call (no agent) or another conversation gets nothing
  await e.onHook(conv, { event: 'pre', quiet: true, tool_name: 'mcp__plugin_telegram_telegram__bot_api', tool_input: args })
  expect(e.takeTicket(conv.key, 'bot_api', args)).toBeNull()
  await e.onHook(conv, { event: 'pre', quiet: true, agent_id: 'S', tool_name: 'mcp__plugin_telegram_telegram__bot_api', tool_input: args })
  expect(e.takeTicket('other', 'bot_api', args)).toBeNull()
  // revoking the elevation drops its tickets
  e.drop(1)
  expect(e.takeTicket(conv.key, 'bot_api', args)).toBeNull()
  e.stop()
})

test('cc-hook forwards a subagent\'s Telegram tool call (quiet, for elevation) but not the main session\'s', async () => {
  const conv = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const seen: any[] = []
  const ipc = createIpc({ cfg, db, onCall: async () => ({ content: [] }), identify: () => ({ mode: 'worker', conv, role: 'user' }), onHook: async (_p, ev) => { seen.push(ev); return {} } })
  const hook = (input: object) => Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', 'pre'], {
    stdin: new Blob([JSON.stringify({ cwd: conv.folder, tool_name: 'mcp__plugin_telegram_telegram__bot_api', tool_input: { credential: 'self', method: 'getChat' }, ...input })]),
    env: { ...process.env, XDG_RUNTIME_DIR: cfg.stateDir, CC_TELEGRAM_ROUTER_SOCKET: cfg.socket, CLAUDE_PROJECT_DIR: conv.folder },
  }).exited
  await hook({})
  await hook({ agent_id: 'S' })
  for (let i = 0; i < 40 && !seen.length; i++) await new Promise(r => setTimeout(r, 25))
  expect(seen).toEqual([{ event: 'pre', quiet: true, tool_name: 'mcp__plugin_telegram_telegram__bot_api', tool_input: { credential: 'self', method: 'getChat' }, agent_id: 'S' }])
  ipc.stop()
}, 30000)

test('elevation for a skill argument: run_skill with force from a user conversation asks (owner sender: in the chat, once only); approved, the subagent\'s call runs with the elevated role', async () => {
  const { conv, e, sent } = elevHarness()
  const call = { tool_name: 'mcp__plugin_telegram_telegram__run_skill', tool_input: { skill: 'web-instagram', action: 'extract', args: { url: 'https://www.youtube.com/watch?v=1', force: true } } }
  expect(e.extraCheck(conv, call, 'user')).toBe('參數 force 只開放給 owner, admin 角色, 本對話角色 user 要提權')
  expect(e.extraCheck(conv, { ...call, tool_input: { ...call.tool_input, args: { url: 'https://www.youtube.com/watch?v=1' } } }, 'user')).toBeNull()
  // a plain user turn: advice to ask the owner (request_elevation)
  e.onDeliver(conv, '42')
  expect((await e.refuse(conv, call, e.extraCheck(conv, call, 'user')!)).reason).toContain('對方同意後呼叫 request_elevation 說明原因')
  expect(sent).toEqual([])
  // the owner asked: an in-chat prompt, no 永久允許
  await e.onHook(conv, { event: 'stop' }) // the user's turn is over (elevation.ts: a turn's people)
  e.onDeliver(conv, OWNER)
  expect((await e.refuse(conv, call, e.extraCheck(conv, call, 'user')!)).reason).toContain('router 已在對話裡詢問是否提權 (#1')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.buttons).toEqual(['elev:1:once', 'elev:1:deny'])
  expect(sent[0]!.text).toContain('♾️ 不能永久允許: 技能參數的角色限制沒辦法寫成固定規則')
  expect(sent[0]!.text).toContain('mcp__plugin_telegram_telegram__run_skill: {"skill":"web-instagram","action":"extract","args":{"url":"https://www.youtube.com/watch?v=1","force":true}}')
  expect(await e.decide('elev:1:once', OWNER)).toBe('已提權一次')
  // the main session may still not; the elevated subagent's call passes and leaves an owner ticket
  expect((await e.onHook(conv, { event: 'pre', quiet: true, tool_name: call.tool_name, tool_input: call.tool_input })).decision).toBe('deny')
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'V' })
  expect(await e.onHook(conv, { event: 'pre', quiet: true, agent_id: 'V', tool_name: call.tool_name, tool_input: call.tool_input })).toMatchObject({ decision: 'allow' })
  expect(e.takeTicket(conv.key, 'run_skill', call.tool_input)).toBe('owner')
  e.stop()
})

test('elevation for a credential: bot_api / http_api refused only for the conversation\'s role asks like any block (admin sender: in the chat); the admin approves, the subagent\'s call runs as admin', async () => {
  const creds = { routertest: { token: 'k', kind: 'http' as const, baseUrl: 'http://127.0.0.1:1', methods: ['/anything*'], roles: ['owner', 'admin'] } }
  const pre = 'mcp__plugin_telegram_telegram__'
  // only the role part: an unknown credential or a path it does not allow is refused at call time, not elevated
  expect(credRoleRefusal(creds, 'cc', 'http_api', { credential: 'routertest', path: '/anything/ping' }, 'user')).toBe('憑證 routertest 只開放 owner, admin 角色的對話使用, 這個對話是 user')
  expect(credRoleRefusal(creds, 'cc', 'http_api', { credential: 'routertest', path: '/anything/ping' }, 'admin')).toBeNull()
  expect(credRoleRefusal(creds, 'cc', 'http_api', { credential: 'routertest', path: '/other' }, 'user')).toBeNull()
  expect(credRoleRefusal(creds, 'cc', 'http_api', { credential: 'nope', path: '/x' }, 'user')).toBeNull()
  expect(credRoleRefusal(creds, 'cc', 'bot_api', { credential: 'self', method: 'getChat' }, 'user')).toBe('只有 owner 與 admin 的對話能用這隻 bot 自己的 token, 這個對話是 user')
  expect(credRoleRefusal(creds, 'cc', 'bot_api', { credential: 'self', method: 'getUpdates' }, 'user')).toBeNull()
  expect(credRoleRefusal(creds, 'cc', 'reply', { credential: 'routertest' }, 'user')).toBeNull()
  const { conv, e, sent } = elevHarness({ extraCheck: (c, call, role) => credRoleRefusal(creds, c.bot, call.tool_name.replace(pre, ''), call.tool_input, role) })
  db.setUserRole('500', 'admin')
  const call = { tool_name: `${pre}http_api`, tool_input: { credential: 'routertest', method: 'GET', path: '/anything/ping' } }
  // a plain user turn: advice to ask the owner, logged
  e.onDeliver(conv, '42')
  const plain = await e.refuse(conv, call, e.extraCheck(conv, call, 'user')!)
  expect(plain.reason).toContain('憑證 routertest 只開放 owner, admin 角色的對話使用')
  expect(plain.reason).toContain('對方同意後呼叫 request_elevation 說明原因')
  expect(sent).toEqual([])
  expect(db.elevLog(conv.key, 5).map(l => l.kind)).toEqual(['blocked'])
  // the admin asked: an in-chat prompt, no 永久允許 (the credential's roles are the place for that)
  await e.onHook(conv, { event: 'stop' }) // the user's turn is over (elevation.ts: a turn's people)
  e.onDeliver(conv, '500')
  expect((await e.refuse(conv, call, e.extraCheck(conv, call, 'user')!)).reason).toContain('router 已在對話裡詢問是否提權 (#1')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.buttons).toEqual(['elev:1:once', 'elev:1:deny'])
  expect(sent[0]!.text).toContain('♾️ 不能永久允許: 憑證開放給哪些角色要由 owner 用 /router cred roles 調整')
  expect(await e.decide('elev:1:once', '500')).toBe('已提權一次')
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'W' })
  expect(await e.onHook(conv, { event: 'pre', quiet: true, agent_id: 'W', tool_name: call.tool_name, tool_input: call.tool_input })).toMatchObject({ decision: 'allow' })
  expect(e.takeTicket(conv.key, 'http_api', call.tool_input)).toBe('admin')
  e.stop()
})

test('elevation for install_skill: a scope above the conversation\'s role asks like any block (admin sender: in the chat, once only); approved, the subagent\'s call runs as admin', async () => {
  const pre = 'mcp__plugin_telegram_telegram__'
  const { conv, e, sent } = elevHarness({ extraCheck: (_c, call, role) => call.tool_name === `${pre}install_skill` ? installRefusal(skillScope(call.tool_input.scope), role) : null })
  db.setUserRole('500', 'admin')
  const call = { tool_name: `${pre}install_skill`, tool_input: { name: 'hello', scope: 'conversation' } }
  expect(e.extraCheck(conv, call, 'user')).toBe('只有 power 以上的對話能安裝這個對話自己的技能, 這個對話是 user')
  expect(e.extraCheck(conv, call, 'power')).toBeNull()
  e.onDeliver(conv, '500')
  expect((await e.refuse(conv, call, e.extraCheck(conv, call, 'user')!)).reason).toContain('router 已在對話裡詢問是否提權 (#1')
  expect(sent[0]!.buttons).toEqual(['elev:1:once', 'elev:1:deny'])
  expect(sent[0]!.text).toContain('♾️ 不能永久允許: 安裝技能的角色限制跟著對話角色')
  expect(await e.decide('elev:1:once', '500')).toBe('已提權一次')
  await e.onHook(conv, { event: 'subagent-start', agent_id: 'X' })
  expect(await e.onHook(conv, { event: 'pre', quiet: true, agent_id: 'X', tool_name: call.tool_name, tool_input: call.tool_input })).toMatchObject({ decision: 'allow' })
  expect(e.takeTicket(conv.key, 'install_skill', call.tool_input)).toBe('admin')
  e.stop()
})

test('elevation after a restart: a request asked in the chat expires when its time is up (quietly, if it already was), or gets the rest of its time; a new block then asks anew', async () => {
  const first = elevHarness()
  first.e.onDeliver(first.conv, OWNER)
  await first.e.onHook(first.conv, escape)
  expect(db.getElevation(1)!.status).toBe('pending')
  first.e.stop() // the router stops; its timers are gone
  await new Promise(r => setTimeout(r, 20))
  // restarted with its time already up: expired at once, the message settled, no worker told
  const later = elevHarness({ askTimeoutMs: 10 })
  for (let i = 0; i < 40 && !later.edits.length; i++) await new Promise(r => setTimeout(r, 10))
  expect(db.getElevation(1)!.status).toBe('expired')
  expect(later.edits[0]!.text).toEndWith('⌛ 逾時, 預設拒絕')
  expect(later.told).toEqual([])
  // a new block asks again instead of pointing at the old request
  later.e.onDeliver(later.conv, OWNER)
  expect((await later.e.onHook(later.conv, escape)).reason).toContain('router 已在對話裡詢問是否提權 (#2')
  later.e.stop()
  // restarted within its time: still pending, expires (and tells the worker) when the rest runs out
  const again = elevHarness({ askTimeoutMs: 400 })
  expect(db.getElevation(2)!.status).toBe('pending')
  for (let i = 0; i < 60 && !again.told.length; i++) await new Promise(r => setTimeout(r, 20))
  expect(db.getElevation(2)!.status).toBe('expired')
  expect(again.told[0]).toContain('逾時沒有回應, 視為拒絕')
  again.e.stop()
})

test('elevation: a request still waiting for the owner (sent to the owner, no time limit) does not stop a new in-chat question', async () => {
  const { conv, e, sent } = elevHarness()
  e.onDeliver(conv, '42')
  expect(await e.request(conv, '要讀 /x', 'ls /x')).toContain('#1') // a plain user: goes to the owner
  expect(db.getElevation(1)!.status).toBe('pending')
  await e.onHook(conv, { event: 'stop' }) // the user's turn is over (elevation.ts: a turn's people)
  e.onDeliver(conv, OWNER)
  expect((await e.onHook(conv, escape)).reason).toContain('router 已在對話裡詢問是否提權 (#2')
  expect(sent.filter(m => m.chat === '-100555')).toHaveLength(1)
  e.stop()
})
