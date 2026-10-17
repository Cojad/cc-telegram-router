// Phase 2 acceptance (plan 10 Phase 2; 03 「router 設定指令」 指令表, 被拒絕時,
// bot token 指令的處理, 「Claude Code 怎麼知道發生了什麼」; 06 chat context; 04 hook).
// Keep in sync with those sections.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { ensureConversation, findByFolder } from '../conversations'
import { runCommand, isCommand, type CommandDeps, type CommandInput } from '../commands'
import { buildContext, renderContext, renderLogs, maskTokens, gmt8 } from '../context'
import { iso8, logLine } from '../../shared/time'
import { initBotSetups, adoptBotSetup, tokenBotId, addedSetupText, resetNotice } from '../setup'
import type { Access } from '../telegram/policy'

const OWNER = '137438526', ADMIN = '500', USER = '600'
let dir: string, cfg: Config, db: RouterDb, access: Access
let calls: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr2-'))
  mkdirSync(join(dir, '.router'))
  cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, '.router', 's'), owners: [OWNER], model: 'claude-opus-5-5', autoCompactWindow: 750000, claudeBin: 'claude' }
  db = openRouterDb(join(dir, '.router', 'router.db'))
  db.setUserRole(ADMIN, 'admin')
  access = { dmPolicy: 'allowlist', allowFrom: [OWNER, ADMIN, USER], groups: { '-100555': { requireMention: true, allowFrom: [] } }, pending: { abc123: { senderId: '700', chatId: '700', createdAt: Date.now(), expiresAt: Date.now() + 60000, replies: 1 } } } as Access
  calls = []
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

function deps(): CommandDeps {
  return {
    cfg, db,
    loadAccess: () => structuredClone(access),
    saveAccess: a => { access = a },
    bots: {
      async list() { return [{ name: 'cc', id: 42, username: 'cc_bot', first_name: '柯柯' }] },
      async add(name) { calls.push(`add ${name}`); return 'new_bot' },
      async rotate(name) { calls.push(`rotate ${name}`); return 'cc_bot' },
      async remove(name) { calls.push(`remove ${name}`) },
    },
    sessions: { isConnected: () => false, async restart(c) { calls.push(`restart ${c.key}`) }, async stop(c) { calls.push(`stop ${c.key}`) }, rotateNow() { calls.push('rotate-now') } },
    async applySettings(c, o) { calls.push(`apply ${c.key} dropJob=${o.dropJob}`) },
    async sendTo(_b, chat, text) { calls.push(`send ${chat} ${text}`) },
    recentMessages: () => [],
    writeConfig: m => { const r: Record<string, unknown> = {}; m(r); calls.push(`config ${JSON.stringify(r)}`) },
    restartRouter: () => { calls.push('restart-router') },
    startedAt: new Date(),
  }
}
const run = (text: string, senderId: string, chat: { id: string; type: string } = { id: senderId, type: 'private' }) =>
  runCommand({ bot: 'cc', text, senderId, senderName: `u${senderId}`, chatId: chat.id, chatType: chat.type } as CommandInput, deps())
const GROUP = { id: '-100555', type: 'supergroup' }

test('only /router and /restart are commands, with or without @bot', () => {
  expect(isCommand('/router status')).toBe(true)
  expect(isCommand('/router@cc_bot status')).toBe(true)
  expect(isCommand('/restart')).toBe(true)
  expect(isCommand('/routerx')).toBe(false)
  expect(isCommand('hello /router')).toBe(false)
})

test('users below admin get an explicit refusal, never silence', async () => {
  const out = (await run('/router status', USER))!
  expect(out.reply).toBe('⛔ /router 只開放 owner 與 admin, 你的角色是 user')
})

test('admin may run commands but may not make anyone owner nor touch an owner', async () => {
  expect((await run('/router status', ADMIN))!.reply).toStartWith('router 已運作')
  expect((await run(`/router role user ${USER} owner`, ADMIN))!.reply).toBe('⛔ admin 不能把角色設成 owner')
  db.setUserRole('800', 'owner')
  expect((await run('/router role user 800 user', ADMIN))!.reply).toBe('⛔ admin 不能異動 owner 的角色與權限')
  expect((await run(`/router role user ${OWNER} user`, ADMIN))!.reply).toContain('config 指定的 owner')
  expect((await run(`/router role user ${USER} power`, ADMIN))!.reply).toBe(`${USER} 的角色: user → power`)
  expect(db.getUserRole(USER)).toBe('power')
  expect((await run('/router config set owners 500', ADMIN))!.reply).toBe('⛔ admin 不能異動 owner 的角色與權限')
  // claudeBin runs outside any sandbox: setting it would hand admin the owner's reach
  expect((await run('/router config set claudeBin /tmp/evil', ADMIN))!.reply).toBe('⛔ claudeBin 由 router 在 sandbox 外執行, 只有 owner 能改')
  expect(cfg.claudeBin).toBe('claude')
  expect((await run('/router config set model claude-opus-5-5', ADMIN))!.reply).not.toStartWith('⛔')
})

test('bot add: a new bot gets the first-run line; one added back under a name whose setup is done says it keeps its persona and approvals place', async () => {
  const add = async () => (await run('/router bot add x 123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', OWNER))!.reply
  expect(await add()).toBe('已新增 bot x: @new_bot\n私訊 @new_bot 任何一句話, 它會帶你完成初次設定 (名字, 個性, 風格, 用途, 審核群組)')
  db.updateBotSetup('x', { persona_done: 1, approvals_chat: '-100900', approvals_topic: 7 })
  expect(await add()).toBe('已新增 bot x: @new_bot\n沿用既有人設, 不用重新做初次設定; 審核與通知沿用既有的審核群組 (-100900). 要重新做人設訪談可用 /router setup persona')
  db.updateBotSetup('x', { approvals_chat: null, approvals_topic: null, group_skipped: 1 })
  expect(await add()).toBe('已新增 bot x: @new_bot\n沿用既有人設, 不用重新做初次設定; 審核與通知照舊送 owner 私訊 (已略過群組設定). 要重新做人設訪談可用 /router setup persona')
  db.updateBotSetup('x', { group_skipped: 0 })
  expect(await add()).toBe('已新增 bot x: @new_bot\n沿用既有人設, 不用重新做初次設定; 審核群組還沒設定: 在開了話題的群組裡傳 /router setup group, 或 /router setup skip 改由 owner 私訊接收. 要重新做人設訪談可用 /router setup persona')
  db.updateBotSetup('x', { persona_done: 0 }) // /router setup persona: the interview again
  expect(await add()).toStartWith('已新增 bot x: @new_bot\n私訊 @new_bot 任何一句話, 它會帶你完成初次設定')
})

test('bot setup follows the Telegram bot id: kept for the same bot added back, started over for another bot under a reused name (at bot add and at start); ids filled in at start', () => {
  // start: a row from before bot_id was kept gets the configured bot's id; a new bot gets a row with its id
  db.updateBotSetup('cc', { persona_done: 1 })
  initBotSetups(db, [{ name: 'cc', id: '42' }, { name: 'fresh', id: '77' }])
  expect(db.getBotSetup('cc')).toMatchObject({ bot_id: '42', persona_done: 1 })
  expect(db.getBotSetup('fresh')).toMatchObject({ bot_id: '77', persona_done: 0 })
  // config.json now has another bot's token under a name: that setup starts over, like bot add
  db.updateBotSetup('swapped', { bot_id: '90', persona_done: 1, persona: '你是 S', approvals_chat: '-100900', approvals_topic: 7 })
  expect(initBotSetups(db, [{ name: 'cc', id: '42' }, { name: 'swapped', id: '91' }])).toEqual([{ name: 'swapped', was: '90', now: '91' }])
  expect(db.getBotSetup('swapped')).toMatchObject({ bot_id: '91', persona_done: 0, persona: null, approvals_chat: null, approvals_topic: null })
  expect(db.getBotSetup('cc')).toMatchObject({ bot_id: '42', persona_done: 1 }) // the same bot: untouched
  expect(initBotSetups(db, [{ name: 'swapped', id: '91' }])).toEqual([]) // once
  expect(resetNotice({ name: 'swapped', was: '90', now: '91' })).toBe('⚠️ config.json 裡 bot swapped 的 token 換成了另一隻 bot (id 90 → 91): 它的設定已重置 (人設, 審核群組), 當成新 bot. 私訊它任何一句話就會開始初次設定.')
  expect(tokenBotId('42:AAAA')).toBe('42')
  expect(tokenBotId('weird')).toBeNull()
  // bot add
  expect(adoptBotSetup(db, 'brand-new', '500', false)).toBe('new')
  expect(db.getBotSetup('brand-new')!.bot_id).toBe('500')
  db.updateBotSetup('x', { bot_id: '600', persona_done: 1, persona: '你是 X', approvals_chat: '-100900', approvals_topic: 7, group_skipped: 0 })
  expect(adoptBotSetup(db, 'x', '600', true)).toBe('kept') // the same bot added back
  expect(db.getBotSetup('x')).toMatchObject({ persona_done: 1, approvals_chat: '-100900' })
  expect(adoptBotSetup(db, 'x', '601', true)).toBe('reset') // another bot under the name
  expect(db.getBotSetup('x')).toMatchObject({ bot_id: '601', persona_done: 0, persona: null, approvals_chat: null, approvals_topic: null, group_skipped: 0 })
  // a row without bot_id: its folder bot<id> decides
  db.updateBotSetup('old', { bot_id: null, persona_done: 1, group_skipped: 1 })
  expect(adoptBotSetup(db, 'old', '700', true)).toBe('kept')
  expect(db.getBotSetup('old')).toMatchObject({ bot_id: '700', persona_done: 1, group_skipped: 1 })
  db.updateBotSetup('old2', { bot_id: null, persona_done: 1, group_skipped: 1 })
  expect(adoptBotSetup(db, 'old2', '800', false)).toBe('reset')
  expect(db.getBotSetup('old2')).toMatchObject({ bot_id: '800', persona_done: 0, group_skipped: 0 })
  // and the bot add reply follows: the reset bot gets the first-run line
  expect(addedSetupText('x_bot', db.getBotSetup('x'))).toStartWith('私訊 @x_bot 任何一句話, 它會帶你完成初次設定')
})

test('bot list for admin; token commands only in the owner DM, and a token message is always deleted', async () => {
  expect((await run('/router bot list', ADMIN))!.reply).toBe('cc: @cc_bot (id 42, 柯柯)')
  // a bot whose getMe is not in yet (its poller just starting): 讀取中, not @? (id 0)
  const d = deps()
  d.bots.list = async () => [{ name: 'cc', id: 42, username: 'cc_bot', first_name: '柯柯' }, { name: 'two', id: null, username: null, first_name: null }]
  const both = await runCommand({ bot: 'cc', text: '/router bot list', senderId: ADMIN, senderName: 'a', chatId: ADMIN, chatType: 'private' } as CommandInput, d)
  expect(both!.reply).toBe('cc: @cc_bot (id 42, 柯柯)\ntwo: 讀取中 (bot 資訊還沒取得, 稍後再試)')
  expect((await runCommand({ bot: 'cc', text: '/router status', senderId: ADMIN, senderName: 'a', chatId: ADMIN, chatType: 'private' } as CommandInput, d))!.reply).toContain('\ntwo (讀取中)\n')
  const inGroup = (await run('/router bot add x 123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', OWNER, GROUP))!
  expect(inGroup.reply).toBe('⛔ /router bot add 只能在 owner 私訊使用; token 曾出現在群組, 建議 /router bot rotate')
  expect(inGroup.deleteMessage).toBe(true)
  const byAdmin = (await run('/router bot rotate cc 123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ADMIN))!
  expect(byAdmin.reply).toStartWith('⛔ /router bot rotate 只能在 owner 私訊使用')
  expect(byAdmin.deleteMessage).toBe(true)
  expect(calls).toEqual([])
  const ok = (await run('/router bot rotate cc 123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', OWNER))!
  expect(ok.reply).toBe('已更換 bot cc: @cc_bot')
  expect(ok.deleteMessage).toBe(true)
  expect(calls).toEqual(['rotate cc'])
})

test('access: pair adds the sender, removes the code and greets them; group mention toggles', async () => {
  const out = (await run('/router access pair abc123', OWNER))!
  expect(out.reply).toBe('已核可 700')
  expect(access.allowFrom).toContain('700')
  expect(access.pending.abc123).toBeUndefined()
  expect(calls).toEqual(['send 700 配對完成, 可以開始對話了.'])
  ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  expect((await run('/router chat mention off', OWNER, GROUP))!.reply).toBe('group-100555 不用 mention 也會收到所有訊息')
  expect(access.groups['-100555']!.requireMention).toBe(false)
})

test('chat compact/model update the conversation, bump ctx_v and reapply settings; model drops the job', async () => {
  const c0 = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const a = (await run('/router chat compact 300k', ADMIN, GROUP))!
  expect(a.reply).toBe('group-100555 autoCompactWindow → 300000')
  expect(calls).toEqual([]) // the reply goes out before the worker is restarted
  a.after!()
  expect((await run('/router chat compact 5k', ADMIN, GROUP))!.reply).toContain('100k 到 1m')
  const b = (await run('/router chat -100555 model claude-sonnet-5-5', OWNER))!
  expect(b.reply).toBe('group-100555 模型 → claude-sonnet-5-5, worker 重啟中')
  b.after!()
  const c = db.getConversation('group-100555')!
  expect(c.compact).toBe(300000)
  expect(c.model).toBe('claude-sonnet-5-5')
  expect(c.ctx_v).toBe((c0.ctx_v ?? 1) + 2)
  expect(calls).toEqual(['apply group-100555 dropJob=false', 'apply group-100555 dropJob=true'])
})

test('every command run in a conversation leaves a router_log line there; changes to another conversation are logged there too', async () => {
  ensureConversation(cfg, db, 'cc', OWNER, 'private', () => {})
  ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const out = (await run('/router chat -100555 compact 1m', OWNER))!
  const convs = out.logs.map(l => l.conv).sort()
  expect(convs).toEqual(['dm-137438526', 'group-100555'])
  expect(out.logs.find(l => l.conv === 'dm-137438526')!.text).toBe('u137438526(owner) /router chat -100555 compact 1m → group-100555 autoCompactWindow → 1000000')
  const refused = (await run('/router status', USER, GROUP))!
  expect(refused.logs).toEqual([{ conv: 'group-100555', text: 'u600(user) /router status → ⛔ /router 只開放 owner 與 admin, 你的角色是 user' }])
})

test('session restart and /restart act only after the reply is sent', async () => {
  ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const out = (await run('/router session restart', ADMIN, GROUP))!
  expect(calls).toEqual([])
  out.after!()
  await Promise.resolve()
  expect(calls).toEqual(['restart group-100555'])
  const r = (await run('/restart', ADMIN))!
  expect(r.reply).toBe('router 重啟中')
  r.after!()
  expect(calls).toContain('restart-router')
})

// --- context / router_log ----------------------------------------------------

test('chat_context block and router_log: GMT+8 times, tokens masked', () => {
  const c = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const block = renderContext(buildContext(cfg, db.updateConversation(c.key, { title: 'Example Group' })))
  expect(block).toStartWith('<chat_context v="2">')
  expect(block).toContain('conversation: group-100555 (group, Example Group)')
  expect(block).toContain('role: user (只能讀寫自己的資料夾')
  expect(maskTokens('bot add x 9000000006:AAH1234567890abcdefghijklmnopqrstuv')).toBe('bot add x 9000000006:…stuv')
  expect(gmt8('2026-10-15T18:30:00.000Z')).toBe('2026-10-16 02:30')
  // log lines and times handed to workers: GMT+8 with its offset, never UTC or Z (shared/time.ts)
  expect(iso8('2026-10-15T18:30:00.123Z')).toBe('2026-10-16T02:30:00.123+08:00')
  expect(iso8(Date.parse('2026-12-31T16:00:00Z'), ' ')).toBe('2027-01-01 00:00:00.000+08:00') // across the year
  expect(Date.parse(iso8('2026-10-15T18:30:00.123Z'))).toBe(Date.parse('2026-10-15T18:30:00.123Z'))
  expect(logLine('router up', Date.parse('2026-10-17T00:06:04.919Z'))).toBe('2026-10-17 08:06:04.919+08:00 router up\n')
  db.addLog(c.key, 'u1(owner) /router bot rotate cc 9000000006:AAH1234567890abcdefghijklmnopqrstuv → 已更換')
  const q = db.enqueue(c.key, { content: 'x', meta: {} })
  const logs = db.bindLogs(c.key, q)
  expect(renderLogs(logs)).toMatch(/^<router_log>\n\[\d{4}-\d\d-\d\d \d\d:\d\d\] u1\(owner\) \/router bot rotate cc 9000000006:…stuv → 已更換\n<\/router_log>$/)
  // a redelivery of the same item carries the same logs; a later item none
  expect(db.bindLogs(c.key, q)).toHaveLength(1)
  expect(db.bindLogs(c.key, q + 1)).toHaveLength(0)
})

test('SessionStart hook puts the chat_context back after compact', async () => {
  const c = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  mkdirSync(join(c.folder, '.chat'), { recursive: true })
  writeFileSync(join(c.folder, '.chat', 'context.json'), JSON.stringify(buildContext(cfg, c)))
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'session-start'], { stdin: new Blob([JSON.stringify({ cwd: c.folder, hook_event_name: 'SessionStart', source: 'compact' })]), stdout: 'pipe' })
  const out = JSON.parse(await new Response(p.stdout).text())
  expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(out.hookSpecificOutput.additionalContext).toStartWith('<chat_context v="1">')
  // a folder without context prints nothing (never breaks the session)
  const q = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'session-start'], { stdin: new Blob([JSON.stringify({ cwd: dir })]), stdout: 'pipe' })
  expect(await new Response(q.stdout).text()).toBe('')
})

// --- 「cc /」relay (plan 01 待驗證 1) -------------------------------------

import { parseRelay, mayRelay, codeBlock, relay, stripChrome, afterEcho, parseCost, parseContext, atPrompt } from '../relay'

test('relay syntax, who may relay, and MarkdownV2 code block escaping', () => {
  expect(parseRelay('cc /status')).toEqual({ cmd: '/status', args: '', raw: false })
  expect(parseRelay('柯柯 /model opus')).toEqual({ cmd: '/model', args: 'opus', raw: false })
  expect(parseRelay('CC/usage')).toEqual({ cmd: '/usage', args: '', raw: false })
  expect(parseRelay('cc //config')).toEqual({ cmd: '/config', args: '', raw: true })
  // a command with its own "/" handling gets it even when asked with "//"
  expect(parseRelay('cc //status')).toEqual({ cmd: '/status', args: '', raw: false })
  expect(parseRelay('cc //context')).toEqual({ cmd: '/context', args: '', raw: false })
  expect(parseRelay('cc //router status')).toEqual({ cmd: '/router', args: 'status', raw: false })
  expect(parseRelay('cc 你好')).toBeNull()
  expect(parseRelay('/router status')).toBeNull()
  expect(mayRelay('owner', '/model', 'private')).toBe(true)
  expect(mayRelay('admin', '/compact', 'supergroup')).toBe(true)
  expect(mayRelay('user', '/status', 'supergroup')).toBe(true)
  expect(mayRelay('user', '/usage', 'private')).toBe(false)
  expect(mayRelay('user', '/model', 'supergroup')).toBe(false)
  expect(codeBlock('a`b\\c (x).')).toBe('```\na\\`b\\\\c (x).\n```')
})

const FIX = (n: string) => readFileSync(join(import.meta.dir, 'fixtures', n), 'utf8')
// like the real one: the top border carries the session name
const BOX = '─'.repeat(40) + ' tg-dm-1 ─\n❯ \n' + '─'.repeat(40) + '\n  ⏵⏵ don\'t ask on (shift+tab to cycle) · ← for agents\n' + '\n'.repeat(8)
const IDLE = '● done\n\n' + BOX

/** A fake terminal: the screen each command leaves, Esc closes a view. */
function fakeTmux(screens: Record<string, string>, chart = { code: 0, stdout: '' }) {
  const seen: Array<{ args: string[]; env?: Record<string, string> }> = []
  let screen = IDLE
  const exec = async (args: string[], env?: Record<string, string>) => {
    seen.push({ args, env })
    if (args[0] === 'tmux' && args[1] === 'capture-pane') return { code: 0, stdout: screen }
    if (args[0] === 'tmux' && args[1] === 'send-keys') {
      const key = args[4]!
      if (key === 'Escape') screen = IDLE
      else screen = screens[key.split(' ')[0]!] ?? IDLE
      return { code: 0, stdout: '' }
    }
    if (args[0] === 'sh') return chart // the chart script
    return { code: 0, stdout: args[0]!.endsWith('tg-status-report.sh') ? 'Version: 2.1\n' : '' }
  }
  return { exec, seen }
}

test('relay: /status and /usage use the report scripts; the one-off tmux runs on the router socket dir and always goes away', async () => {
  const { exec, seen } = fakeTmux({})
  const out = await relay({ exec, stateDir: dir, claudeBin: 'claude', scriptsDir: '/s' }, 'abcd1234', { cmd: '/status', args: '', raw: false })
  expect(out).toEqual({ kind: 'text', text: 'Version: 2.1' })
  expect(seen.every(s => s.args[0] !== 'tmux' || s.env?.TMUX_TMPDIR === join(dir, 'tmux'))).toBe(true)
  expect(seen.find(s => s.args[1] === 'new-session')!.args).toContain('claude attach abcd1234')
  expect(seen.at(-1)!.args).toEqual(['tmux', 'kill-session', '-t', 'relay-abcd1234'])
})

test('relay /context: only its own output, as a table of the session\'s categories plus a donut chart', async () => {
  const { exec, seen } = fakeTmux({ '/context': FIX('relay-context.txt') })
  const out = await relay({ exec, stateDir: dir, claudeBin: 'claude', scriptsDir: '/s', settleMs: 30, outDir: dir, now: () => '2026-10-16 09:40' }, 'abcd1234', { cmd: '/context', args: '', raw: false })
  expect(out.kind).toBe('photo')
  const text = (out as any).text as string
  expect(text).toStartWith('📊 Context 用量 (2026-10-16 09:40)\nclaude-opus-5-5: 100.6k / 750k (13%)')
  const rows = text.split('\n').slice(3, 12)
  expect(rows.map(r => r.split(/\s{2,}/)[0])).toEqual(['System prompt', 'System tools', 'MCP tools', 'MCP server instructions', 'Memory files', 'Skills', 'Messages', 'Free space', 'Autocompact buffer'])
  expect(rows[6]).toMatch(/^Messages\s+63\.5k\s+8\.5%$/)
  expect(text).not.toMatch(/[⛁⛀⛶⛝]/) // no grid icons in the table
  expect(text).toContain('自動壓縮門檻 750k · MCP 工具 191 個 · 記憶檔 3 個 · 技能 22 個')
  expect(text).not.toContain('Earlier reply') // nothing from before the command
  const chart = seen.find(s => s.args[0] === 'sh')!
  expect(chart.args.slice(-2)).toEqual(['/s/tg-context-chart.py', join(dir, 'context-abcd1234.png')])
  expect(JSON.parse(chart.env!.TG_CHART_JSON!)).toMatchObject({ total_tokens: 750000, used_tokens: 100600, pct_used: 13, model: 'claude-opus-5-5' })
})

test('relay /context without matplotlib: the table plus the script\'s text chart and install hint; a failed chart: the table alone', async () => {
  const textChart = 'Messages  █▊░░░░░░░░░░░░░░░░░░    8.5%\n\n(沒有 matplotlib, 改用文字圖. 想要圖片請安裝: python3 -m pip install --user matplotlib)\n'
  const deps = (exec: any) => ({ exec, stateDir: dir, claudeBin: 'claude', scriptsDir: '/s', settleMs: 30, outDir: dir, now: () => '2026-10-16 09:40' })
  const none = await relay(deps(fakeTmux({ '/context': FIX('relay-context.txt') }, { code: 3, stdout: textChart }).exec), 'abcd1234', { cmd: '/context', args: '', raw: false })
  expect(none.kind).toBe('text')
  const text = (none as any).text as string
  expect(text).toStartWith('📊 Context 用量 (2026-10-16 09:40)\nclaude-opus-5-5: 100.6k / 750k (13%)')
  expect(text).toEndWith('\n\nMessages  █▊░░░░░░░░░░░░░░░░░░    8.5%\n\n(沒有 matplotlib, 改用文字圖. 想要圖片請安裝: python3 -m pip install --user matplotlib)')
  const failed = await relay(deps(fakeTmux({ '/context': FIX('relay-context.txt') }, { code: 1, stdout: '' }).exec), 'abcd1234', { cmd: '/context', args: '', raw: false })
  expect(failed.kind).toBe('text')
  expect((failed as any).text).toEndWith('自動壓縮門檻 750k · MCP 工具 191 個 · 記憶檔 3 個 · 技能 22 個')
})

test('relay /cost: just this session\'s section of the view, in Chinese; the view is closed before leaving', async () => {
  const { exec, seen } = fakeTmux({ '/cost': FIX('relay-cost.txt') })
  const out = await relay({ exec, stateDir: dir, claudeBin: 'claude', scriptsDir: '/s', settleMs: 30 }, 'abcd1234', { cmd: '/cost', args: '', raw: false })
  expect(out.kind).toBe('text')
  const text = (out as any).text as string
  expect(text).toStartWith('💵 這個 session 的用量\n\n總花費: $3.15\nAPI 時間: 4m 33s\n實際經過時間: 1h 53m 3s')
  expect(text).toContain('各模型用量:\n     claude-opus-5-5:')
  expect(text).not.toContain('Current week') // the account's weekly limits are /usage's job
  const keys = seen.filter(s => s.args[1] === 'send-keys').map(s => s.args[4])
  expect(keys).toEqual(['/cost', 'Escape']) // left on the view: closed
  expect(seen.at(-1)!.args[1]).toBe('kill-session')
})

test('relay: an unknown command is said so (no screen); other commands hand their cut-out output to the worker; cc //x sends the screen as it is', async () => {
  const unknown = '● earlier\n❯ /router status\n● Unknown command: /router\n' + BOX
  const compact = '● earlier chat\n❯ /compact\n  ⎿  Compacted. ctrl+o to see full summary\n' + BOX
  const model = 'Select model\n ❯ 1. Opus 5.5\n   2. Fable 5.1\nEnter to confirm · Esc to exit\n'
  const { exec, seen } = fakeTmux({ '/router': unknown, '/compact': compact, '/model': model })
  const deps = { exec, stateDir: dir, claudeBin: 'claude', scriptsDir: '/s', settleMs: 30 }
  expect(await relay(deps, 'w', { cmd: '/router', args: 'status', raw: false })).toEqual({ kind: 'text', text: '/router 不是 Claude Code 的指令. 要看終端機的畫面可以用 cc //router' })
  expect(await relay(deps, 'w', { cmd: '/compact', args: '', raw: false })).toEqual({ kind: 'handoff', output: '⎿  Compacted. ctrl+o to see full summary' })
  const shot = await relay(deps, 'w', { cmd: '/model', args: '', raw: true })
  expect(shot).toEqual({ kind: 'text', text: model.trim() })
  // the picker was left open by the screenshot: closed before leaving
  expect(seen.filter(s => s.args[1] === 'send-keys').map(s => s.args[4]).slice(-2)).toEqual(['/model', 'Escape'])
})

test('screen helpers: input box and status bar dropped; output cut after the last echo', () => {
  expect(stripChrome('a\nb\n\n' + IDLE.replace('● done\n\n', ''))).toEqual(['a', 'b'])
  expect(afterEcho('❯ /x\nold\n❯ /x\nnew 1\nnew 2\n' + IDLE, '/x')).toEqual(['new 1', 'new 2', '● done'])
  expect(afterEcho('nothing here\n' + IDLE, '/x')).toBeNull()
  // the real screen (input box border with the session name): at the prompt, box dropped
  const real = FIX('relay-context.txt')
  expect(atPrompt(real)).toBe(true)
  expect(stripChrome(real).at(-1)!.trim()).toMatch(/tokens$/)
  expect(atPrompt('Usage\nEsc to cancel\n')).toBe(false)
  expect(parseCost(['no session here'])).toBeNull()
  expect(parseContext(['no usage'])).toBeNull()
})

// --- listing commands -------------------------------------------------------

test('/router config, /router chat and /router log with no arguments list everything', async () => {
  const cfgOut = (await run('/router config', OWNER))!.reply
  for (const k of ['bots: cc', `owners: ${OWNER}`, 'model: claude-opus-5-5', 'autoCompactWindow: 750000', 'claudeBin: claude', `home: ${dir}`]) expect(cfgOut).toContain(k)
  expect(cfgOut).not.toContain('1:x') // no token
  expect((await run('/router config show', ADMIN))!.reply).toBe(cfgOut)
  ensureConversation(cfg, db, 'cc', OWNER, 'private', () => {})
  ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  db.updateConversation('group-100555', { title: 'Example Group', compact: 300000 })
  const chats = (await run('/router chat', OWNER))!.reply
  expect(chats).toContain('dm-137438526\n  chat_id 137438526, role owner, model claude-opus-5-5 (預設), compact 750000 (預設), mention -, 已休眠')
  expect(chats).toContain('group-100555 (Example Group)\n  chat_id -100555, role user, model claude-opus-5-5 (預設), compact 300000, mention on, 已休眠')
  expect((await run('/router chat -100555', OWNER))!.reply).toStartWith('group-100555 (Example Group)')
  const logs = (await run('/router log', OWNER))!.reply
  expect(logs).toContain('[dm-137438526]')
  expect(logs).toContain('[group-100555 Example Group]')
})

// --- live progress (docs/v1/tg-live-progress-hooks.md, v2 port) ------------

import { createProgress, toolSummary } from '../progress'

test('progress: a Telegram-triggered turn gets one message, tool lines flip ▶→✅ in place, Stop finishes and deletes', async () => {
  const ops: string[] = []
  const p = createProgress({
    async send(chat, text) { ops.push(`send ${chat} ${text}`); return 77 },
    async edit(chat, id, text) { ops.push(`edit ${id} ${text}`) },
    async remove(chat, id) { ops.push(`remove ${id}`) },
  }, { throttleMs: 20, deleteAfterMs: 20 })
  await p.handle('g', '-1', { event: 'prompt', telegram: false })
  await p.handle('g', '-1', { event: 'pre', summary: 'Bash: ls' })
  expect(ops).toEqual([]) // not a Telegram turn: nothing at all
  await p.handle('g', '-1', { event: 'prompt', telegram: true })
  await p.handle('g', '-1', { event: 'pre', summary: 'Bash: ls' })
  await p.handle('g', '-1', { event: 'post', summary: 'Bash: ls' })
  await p.handle('g', '-1', { event: 'pre', summary: 'Read: a.md' })
  await sleepMs(60)
  await p.handle('g', '-1', { event: 'compact-pre', trigger: 'auto' })
  await p.handle('g', '-1', { event: 'compact-post', trigger: 'auto' })
  await p.handle('g', '-1', { event: 'stop' })
  await sleepMs(60)
  expect(ops[0]).toBe('send -1 🤔 思考中…')
  expect(ops[1]).toBe('edit 77 🤔 思考中…\n\n✅ Bash: ls\n▶ Read: a.md') // three events, one throttled edit
  expect(ops).toContain('edit 77 ✅ 完成\n\n✅ Bash: ls\n▶ Read: a.md\n✅ 壓縮完成, 繼續處理')
  expect(ops.at(-1)).toBe('remove 77')
  expect(p.active('g')).toBe(false)
  expect(toolSummary('Bash', { command: 'ls -la\nx', description: 'List files' })).toBe('Bash: List files')
  expect(toolSummary('Grep', { pattern: 'foo' })).toBe('Grep: foo')
})
const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms))

import { createIpc } from '../ipc'

test('cc-hook progress reports events to the router socket for its conversation; telegram plugin tools are skipped', async () => {
  const c = ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const got: Array<{ key?: string; ev: Record<string, unknown> }> = []
  const ipc = createIpc({
    cfg, db,
    identify: d => { const x = findByFolder(db, d); return x ? { mode: 'worker', conv: x, role: x.role } : null },
    onCall: async () => ({ content: [] }),
    onHook: (peer, ev) => { got.push({ key: peer.conv?.key, ev }); return {} },
  })
  // cwd is a subfolder (the session ran `cd memory` earlier); the hook must
  // still report the conversation folder, which Claude Code gives it as
  // CLAUDE_PROJECT_DIR.
  const hook = (event: string, input: object) => Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', event], {
    stdin: new Blob([JSON.stringify({ cwd: join(c.folder, 'memory'), ...input })]), env: { ...process.env, CC_TELEGRAM_ROUTER_SOCKET: cfg.socket, CLAUDE_PROJECT_DIR: c.folder },
  }).exited
  await hook('prompt', { prompt: '<channel source="plugin:telegram:telegram" chat_id="-100555">hi</channel>' })
  await hook('pre', { tool_name: 'Bash', tool_input: { command: 'ls', description: 'List' } })
  await hook('pre', { tool_name: 'mcp__plugin_telegram_telegram__reply', tool_input: {} })
  await hook('stop', {})
  for (let i = 0; i < 40 && got.length < 3; i++) await sleepMs(25)
  expect(got).toEqual([
    { key: 'group-100555', ev: { event: 'prompt', telegram: true } },
    // the fields the permission check needs travel with it (router/permcheck.ts)
    { key: 'group-100555', ev: { event: 'pre', summary: 'Bash: List', tool_name: 'Bash', tool_input: { command: 'ls', description: 'List' } } },
    { key: 'group-100555', ev: { event: 'stop' } },
  ])
  ipc.stop()
}, 20000)

import { isRunning } from '../supervisor'

test('a worker whose last turn is "done" is still running; only a live pid with a status counts', () => {
  expect(isRunning({ id: 'a', pid: 1, status: 'idle', state: 'done' })).toBe(true)
  expect(isRunning({ id: 'a', pid: 1, status: 'idle', state: 'blocked' })).toBe(true)
  expect(isRunning({ id: 'a', state: 'stopped' })).toBe(false)
  expect(isRunning({ id: 'a', state: 'done' })).toBe(false)
})

test('progress: a failed send (e.g. chat not found) neither throws nor leaves edits pending', async () => {
  const ops: string[] = []
  const p = createProgress({
    async send() { throw new Error('400: chat not found') },
    async edit() { ops.push('edit') },
    async remove() { ops.push('remove') },
  }, { throttleMs: 10, deleteAfterMs: 10 })
  await p.handle('x', '1', { event: 'prompt', telegram: true })
  await p.handle('x', '1', { event: 'pre', summary: 'Bash: ls' })
  await p.handle('x', '1', { event: 'stop' })
  await sleepMs(40)
  expect(ops).toEqual([])
})

import { settle } from '../relay'

test('relay waits for a long command to finish (screen stops changing) instead of cancelling it', async () => {
  const frames = ['❯ /compact', 'Compacting conversation… 1s', 'Compacting conversation… 2s', 'Compacting conversation… 3s', '✻ Conversation compacted']
  let i = 0
  const out = await settle(async () => frames[Math.min(i++, frames.length - 1)]!, 120, 5000, 30)
  expect(out).toBe('✻ Conversation compacted')
})

test('progress: parallel tool calls each get their own ▶ line ticked in place', async () => {
  const ops: string[] = []
  const p = createProgress({ async send() { return 5 }, async edit(_c, _i, t) { ops.push(t) }, async remove() {} }, { throttleMs: 10, deleteAfterMs: 10 })
  await p.handle('k', '1', { event: 'prompt', telegram: true })
  for (const ev of ['pre:Bash: a', 'pre:Read: b', 'post:Read: b', 'post:Bash: a'] as const) {
    const [e, summary] = [ev.split(':')[0] as 'pre' | 'post', ev.slice(ev.indexOf(':') + 1)]
    await p.handle('k', '1', { event: e, summary })
  }
  await sleepMs(40)
  expect(ops.at(-1)).toBe('🤔 思考中…\n\n✅ Bash: a\n✅ Read: b')
})

test('progress messages are tracked while live, so a restart can remove the ones left behind', async () => {
  const tracked = new Map<string, { chat: string; id: number }>()
  const removed: number[] = []
  const api = {
    async send() { return 42 },
    async edit() {},
    async remove(_c: string, id: number) { removed.push(id) },
    track: (k: string, chat: string, id: number) => { tracked.set(`${k}:${id}`, { chat, id }) },
    untrack: (k: string, id: number) => { tracked.delete(`${k}:${id}`) },
  }
  const first = createProgress(api, { throttleMs: 10, deleteAfterMs: 10 })
  await first.handle('k', '1', { event: 'prompt', telegram: true })
  await sleepMs(20)
  expect([...tracked.values()]).toEqual([{ chat: '1', id: 42 }])
  // the router dies here; a new process cleans up what is still tracked
  const second = createProgress(api, { throttleMs: 10, deleteAfterMs: 10 })
  await second.cleanup([...tracked.entries()].map(([k, v]) => ({ key: k.split(':')[0]!, chat_id: v.chat, message_id: v.id })))
  expect(removed).toEqual([42])
  expect(tracked.size).toBe(0)
  // and a normal finish untracks after deleting
  await second.handle('k', '1', { event: 'prompt', telegram: true })
  await second.handle('k', '1', { event: 'stop' })
  await sleepMs(40)
  expect(tracked.size).toBe(0)
})

// --- people, /id, role targets, private listings ----------------------------

test('role targets: uid, @username, or the replied-to person; "user" keyword optional; list shows name(@username)', async () => {
  db.seePerson({ uid: '900000001', name: 'Example User', username: 'example_user', chat_id: '-100555' })
  db.seePerson({ uid: OWNER, name: '柯姊', username: 'Cojad', chat_id: OWNER })
  expect((await run('/router role @example_user admin', OWNER))!.reply).toBe('Example User(@example_user) (900000001) 的角色: user → admin')
  expect((await run('/router role user 900000001 power', OWNER))!.reply).toBe('Example User(@example_user) (900000001) 的角色: admin → power')
  const viaReply = (await runCommand({ bot: 'cc', text: '/router role admin', senderId: OWNER, senderName: 'o', chatId: '-100555', chatType: 'supergroup', reply: { uid: '900000001', messageId: 9 } }, deps()))!
  expect(viaReply.reply).toBe('Example User(@example_user) (900000001) 的角色: power → admin')
  expect((await run('/router role @nobody admin', OWNER))!.reply).toStartWith('找不到 @nobody')
  const list = (await run('/router role list', OWNER))!
  expect(list.reply).toBe(`柯姊(@Cojad) ${OWNER} owner (config)\n${ADMIN} admin\nExample User(@example_user) 900000001 admin`) // sorted by uid as text
  expect(list.private).toBe(true)
})

test('/id and /info: 訊息ID / 作者ID [@username] / 對話ID; @username lookup; silent for non-admins', async () => {
  db.seePerson({ uid: '900000001', name: 'Example User', username: 'example_user', chat_id: '-100555' })
  db.seePerson({ uid: '9000000006', name: '柯柯', username: 'example_bot', chat_id: null })
  ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const mine = (await runCommand({ bot: 'cc', text: '/id', senderId: ADMIN, senderName: 'a', chatId: '-100555', chatType: 'supergroup', messageId: 77 }, deps()))!
  expect(mine.reply).toBe(`訊息ID: 77\n作者ID: ${ADMIN}\n對話ID: -100555`) // no username known: none shown
  const replied = (await runCommand({ bot: 'cc', text: '/id', senderId: OWNER, senderName: 'o', chatId: '-9990000003', chatType: 'group', reply: { uid: '9000000006', messageId: 180 } }, deps()))!
  expect(replied.reply).toBe('訊息ID: 180\n作者ID: 9000000006 [@example_bot]\n對話ID: -9990000003')
  expect((await run('/info @example_user', ADMIN))!.reply).toMatch(/^使用者ID: 900000001 \[@example_user\]\n最後出現: \d{4}-\d\d-\d\d \d\d:\d\d, 對話ID -100555$/)
  expect(await run('/id', USER, GROUP)).toBeNull() // may be another bot's command
  expect((await run('/router status', USER, GROUP))!.reply).toStartWith('⛔') // /router still refuses
})

test('listings are marked private (sent to DM when run in a group); actions are not', async () => {
  ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  for (const c of ['/router chat', '/router chat -100555', '/router log', '/router role list', '/router access show', '/router config', '/router config get model', '/router bot list']) {
    expect([c, (await run(c, OWNER, GROUP))!.private]).toEqual([c, true])
  }
  for (const c of ['/router status', '/router help', '/router chat mention on', '/router access allow 9', '/id']) { // status stays in the group (柯姊 2026-10-16)
    expect([c, (await run(c, OWNER, GROUP))!.private ?? false]).toEqual([c, false])
  }
})

// --- rotation -----------------------------------------------------------------

import { rotateTick } from '../rotate'

test('/router session rotate marks one or all workers (admin skips owner ones) and runs a pass right after', async () => {
  ensureConversation(cfg, db, 'cc', OWNER, 'private', () => {})
  ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  const one = (await run('/router session rotate', ADMIN, GROUP))!
  expect(one.reply).toStartWith('已標記 1 個 worker 等待輪替: group-100555')
  one.after!()
  expect(calls).toEqual(['rotate-now'])
  const all = (await run('/router session rotate all', ADMIN))!
  expect(all.reply).toContain('略過 dm-137438526: admin 不能異動 owner 的角色與權限')
  expect(db.rotatePending().map(c => c.key)).toEqual(['group-100555'])
  expect((await run('/router session rotate all', OWNER))!.reply).toStartWith('已標記 2 個 worker')
  expect((await run('/router status', OWNER))!.reply).toMatch(/ 💤💬🚻 +\d+m前: -100555 \(待輪替\)/) // a group without a title shows its chat id
})

test('a conversation named by chat id: this bot\'s in Telegram (--bot for another); from the terminal any bot\'s, ambiguous ones ask for --bot; a conversation key works everywhere', async () => {
  cfg.bots.push({ name: 'router', token: '2:y' })
  ensureConversation(cfg, db, 'cc', '-100555', 'supergroup', () => {})
  ensureConversation(cfg, db, 'router', '-100555', 'supergroup', () => {})
  ensureConversation(cfg, db, 'router', '-100777', 'supergroup', () => {})
  const term = (text: string) => runCommand({ bot: 'cc', text, senderId: OWNER, senderName: 'terminal', chatId: OWNER, chatType: 'private', terminal: true }, deps())
  // terminal: the only bot with that chat
  expect((await term('/router session rotate -100777'))!.reply).toStartWith('已標記 1 個 worker 等待輪替: router-group-100777')
  // several bots have it: no silent pick, the candidates are listed
  const amb = (await term('/router session rotate -100555'))!.reply
  expect(amb).toBe('-100555 在 2 隻 bot 都有對話, 請加 --bot <名稱> 或改用對話 key: group-100555 (bot cc), router-group-100555 (bot router)')
  expect((await term('/router session rotate -100555 --bot router'))!.reply).toStartWith('已標記 1 個 worker 等待輪替: router-group-100555')
  expect((await term('/router session rotate router-group-100555'))!.reply).toStartWith('已標記 1 個 worker 等待輪替: router-group-100555')
  expect((await term('/router session rotate -100555 --bot nope'))!.reply).toBe('沒有名為 nope 的 bot (cc, router)')
  expect((await term('/router chat -100555'))!.reply).toStartWith('-100555 在 2 隻 bot 都有對話')
  expect((await term('/router chat router-group-100777'))!.reply).toStartWith('router-group-100777')
  expect((await term('/router perm -100555 show'))!.reply).toStartWith('-100555 在 2 隻 bot 都有對話')
  expect((await term('/router log -100555'))!.reply).toStartWith('-100555 在 2 隻 bot 都有對話')
  expect((await term('/router log router-group-100777'))!.reply).toStartWith('[router-group-100777]')
  expect((await term('/router secret list -100777'))!.reply).toBe('對話 -100777 沒有密鑰')
  expect((await term('/router secret list -100555'))!.reply).toStartWith('-100555 在 2 隻 bot 都有對話')
  // Telegram: a chat id is this bot's chat; another bot's needs --bot or the key
  expect((await run('/router session rotate -100777', OWNER))!.reply).toBe('找不到這個對話')
  expect((await run('/router session rotate -100777 --bot router', OWNER))!.reply).toStartWith('已標記 1 個 worker 等待輪替: router-group-100777')
  expect((await run('/router session rotate -100555', OWNER))!.reply).toStartWith('已標記 1 個 worker 等待輪替: group-100555')
})

test('rotation: idle workers are stopped and unmarked, busy ones wait, stopped ones are just unmarked; a backlog is woken', async () => {
  const a = ensureConversation(cfg, db, 'cc', '-1001', 'supergroup', () => {})
  const b = ensureConversation(cfg, db, 'cc', '-1002', 'supergroup', () => {})
  const c = ensureConversation(cfg, db, 'cc', '-1003', 'supergroup', () => {})
  for (const x of [a, b, c]) db.setRotate(x.key, true)
  db.enqueue(c.key, { content: 'waiting', meta: {} })
  const status: Record<string, string | undefined> = { [a.key]: 'idle', [b.key]: 'busy', [c.key]: undefined }
  const log: string[] = []
  const r = await rotateTick({
    db,
    async liveJob(x) { return status[x.key] ? { id: x.key, pid: 1, status: status[x.key] } : undefined },
    async stop(x) { log.push(`stop ${x.key}`) },
    async ensureAwake(x) { log.push(`wake ${x.key}`) },
  })
  expect(r).toEqual({ stopped: [a.key], waiting: [b.key] })
  expect(log).toEqual([`stop ${a.key}`, `wake ${c.key}`])
  expect(db.rotatePending().map(x => x.key)).toEqual([b.key])
  status[b.key] = 'idle'
  expect((await rotateTick({ db, async liveJob(x) { return status[x.key] ? { id: x.key, pid: 1, status: status[x.key] } : undefined }, async stop() {}, async ensureAwake() {} })).stopped).toEqual([b.key])
  expect(db.rotatePending()).toEqual([])
})

import { renderStatus, ago } from '../commands'

test('status: per bot newest first, icons, right-aligned "ago" in minutes, 10 each or 5 when past 30 lines, max 5 bots, legend', () => {
  const now = Date.parse('2026-10-16T05:00:00Z')
  const conv = (bot: string, i: number, type: 'dm' | 'group', role: string, secAgo: number) => ({
    key: `${type}-${bot}-${i}`, bot, chat_id: String(i), type, folder: '', role, session_id: null,
    created_at: '2026-10-01T00:00:00Z', last_seen: new Date(now - secAgo * 1000).toISOString(), title: `T${i}`,
  }) as any
  const bots = [{ name: 'cc', username: 'example_bot', first_name: '柯柯' }, { name: 'tiger', username: 'tigerbot', first_name: '虎虎' }]
  const convs = [conv('cc', 1, 'dm', 'owner', 90), conv('cc', 2, 'group', 'admin', 2 * 3600 + 22 * 60), conv('tiger', 3, 'group', 'user', 185)]
  const out = renderStatus(now, new Date(now - (3 * 3600 + 45 * 60) * 1000), bots, convs, {
    isConnected: k => k === 'dm-cc-1', label: c => c.type === 'dm' ? '@Cojad:🦅 柯姊❤️ Cojad' : c.title, backlog: () => 0,
  })
  expect(out).toBe([
    'router 已運作 3h45m', '',
    '柯柯(@example_bot)', ' 🛜😀🥇     1m前: @Cojad:🦅 柯姊❤️ Cojad', ' 💤💬🥈  2h22m前: T2', '',
    '虎虎(@tigerbot)', ' 💤💬🚻     3m前: T3', '',
    '說明:', ' 🛜待命中 💤已休眠', ' 😀DM 💬群組 📣頻道', ' 🥇owner 🥈admin 🥉power 🚻user 🥷guest',
  ].join('\n'))
  // limits: 12 conversations on one bot -> 10 shown; 3 bots x 10 -> past 30 lines -> 5 each; 6 bots -> 5 listed
  const many = (bot: string, n: number) => Array.from({ length: n }, (_, i) => conv(bot, i + 100, 'group', 'user', i * 10))
  const one = renderStatus(now, new Date(now), [bots[0]!], many('cc', 12), { isConnected: () => false, label: c => c.title, backlog: () => 0 })
  expect(one.split('\n').filter(l => l.startsWith(' 💤')).length).toBe(10)
  const b3 = ['a', 'b', 'c'].map(x => ({ name: x, username: x, first_name: x }))
  const three = renderStatus(now, new Date(now), b3, [...many('a', 12), ...many('b', 12), ...many('c', 12)], { isConnected: () => false, label: c => c.title, backlog: () => 0 })
  expect(three.split('\n').filter(l => l.startsWith(' 💤')).length).toBe(15)
  const b6 = ['a', 'b', 'c', 'd', 'e', 'f'].map(x => ({ name: x, username: x, first_name: x }))
  const six = renderStatus(now, new Date(now), b6, [], { isConnected: () => false, label: c => c.title, backlog: () => 0 })
  expect(six).toContain('(另有 1 隻 bot 未列出)')
  expect(six).not.toContain('f(@f)')
  expect([ago(5000), ago(185000), ago(8520000), ago(3 * 86400000 + 4 * 3600000)]).toEqual(['0m', '3m', '2h22m', '3d4h'])
})

test('people are backfilled from the event log for anyone not yet in the table, newest name winning', () => {
  db.logEvent('cc', { update_id: 1, message: { message_id: 1, chat: { id: 137438526, type: 'private' }, from: { id: 137438526, first_name: '舊名' } } })
  db.logEvent('cc', { update_id: 2, message: { message_id: 2, chat: { id: -100555, type: 'supergroup' }, from: { id: 137438526, first_name: '🦅 柯姊❤️', last_name: 'Cojad', username: 'Cojad' } } })
  db.seePerson({ uid: '600', name: 'Known', username: null, chat_id: null })
  db.logEvent('cc', { update_id: 3, message: { message_id: 3, chat: { id: 600, type: 'private' }, from: { id: 600, first_name: 'Other' } } })
  expect(db.backfillPeople()).toBe(1)
  expect(db.getPerson('137438526')).toMatchObject({ name: '🦅 柯姊❤️ Cojad', username: 'Cojad', last_chat_id: '-100555' })
  expect(db.getPerson('600')!.name).toBe('Known') // already known: untouched
})

test('progress: a turn answering a request replies to the message that asked, and is mirrored where the button was pressed (labelled); both go away together; a running turn gets the mirror attached', async () => {
  const ops: string[] = []
  let n = 80
  const p = createProgress({
    async send(chat, text, o) { const id = ++n; ops.push(`send ${chat} ${o?.thread ?? '-'} ${o?.replyTo ?? '-'} #${id} ${text}`); return id },
    async edit(chat, id, text) { ops.push(`edit ${chat} #${id} ${text}`) },
    async remove(chat, id) { ops.push(`remove ${chat} #${id}`) },
  }, { throttleMs: 20, deleteAfterMs: 20 })
  const m = { chatId: '-100900', thread: 7, replyTo: 55, label: '↪ G (group-1) 收到結果, 處理中:' }
  await p.handle('g', '-1', { event: 'prompt', telegram: true }, { replyTo: 12, mirrors: [m] })
  await p.handle('g', '-1', { event: 'pre', summary: 'Bash: ls' })
  await sleepMs(60)
  await p.handle('g', '-1', { event: 'stop' })
  await sleepMs(60)
  expect(ops[0]).toBe('send -1 - 12 #81 🤔 思考中…')
  expect(ops[1]).toBe('send -100900 7 55 #82 ↪ G (group-1) 收到結果, 處理中:\n🤔 思考中…')
  expect(ops).toContain('edit -1 #81 🤔 思考中…\n\n▶ Bash: ls')
  expect(ops).toContain('edit -100900 #82 ↪ G (group-1) 收到結果, 處理中:\n✅ 完成\n\n▶ Bash: ls')
  expect(ops.filter(o => o.startsWith('remove'))).toEqual(['remove -1 #81', 'remove -100900 #82'])
  ops.length = 0
  expect(p.attach('g', m)).toBe(false)
  await p.handle('g', '-1', { event: 'prompt', telegram: true })
  expect(ops[0]).toBe('send -1 - - #83 🤔 思考中…') // an ordinary turn: no reply
  expect(p.attach('g', m)).toBe(true)
  await sleepMs(10)
  expect(ops[1]).toStartWith('send -100900 7 55 #84 ↪ G')
})

test('relay: a view still loading (no key hint yet) is closed too; a busy worker gets no keys at all', async () => {
  const loading = 'Usage\n  Loading usage…\n' + '\n'.repeat(10)
  const { exec, seen } = fakeTmux({ '/cost': loading })
  const out = await relay({ exec, stateDir: dir, claudeBin: 'claude', scriptsDir: '/s', settleMs: 30 }, 'w', { cmd: '/cost', args: '', raw: false })
  expect(out.kind).toBe('text')
  expect(seen.filter(s => s.args[1] === 'send-keys').map(s => s.args[4])).toEqual(['/cost', 'Escape'])
  const busy = '● Working…\n✻ Thinking… (esc to interrupt)\n' + BOX
  const b = fakeTmux({})
  const busyExec = async (args: string[], env?: Record<string, string>) => args[1] === 'capture-pane' ? { code: 0, stdout: busy } : b.exec(args, env)
  expect(await relay({ exec: busyExec, stateDir: dir, claudeBin: 'claude', scriptsDir: '/s', settleMs: 30 }, 'w', { cmd: '/compact', args: '', raw: false })).toEqual({ kind: 'text', text: '分身正在處理中, 等這一輪結束再試 (要看當下的畫面可以用 cc //compact)' })
  const shot = await relay({ exec: busyExec, stateDir: dir, claudeBin: 'claude', scriptsDir: '/s', settleMs: 30 }, 'w', { cmd: '/model', args: '', raw: true })
  expect((shot as any).text).toStartWith('(分身正在處理中, /model 沒有執行; 以下是當下的畫面)')
  expect(b.seen.filter(s => s.args[1] === 'send-keys')).toEqual([]) // nothing typed, no Esc
}, 30000)

test('relay: a worker already stuck on a view is brought back to the prompt first; Escs are a second apart and stop at the prompt', async () => {
  const stuck = 'Usage\n  Current week  11% used\nEsc to cancel\n' + '\n'.repeat(10)
  const { exec, seen } = fakeTmux({ '/cost': FIX('relay-cost.txt') })
  // start on a leftover view: the fake closes it on Escape
  let isStuck = true
  const wrapped = async (args: string[], env?: Record<string, string>) => {
    if (isStuck && args[1] === 'send-keys' && args[4] === 'Escape') isStuck = false
    if (isStuck && args[1] === 'capture-pane') return { code: 0, stdout: stuck }
    return exec(args, env)
  }
  const out = await relay({ exec: wrapped, stateDir: dir, claudeBin: 'claude', scriptsDir: '/s', settleMs: 30 }, 'w', { cmd: '/cost', args: '', raw: false })
  expect((out as any).text).toStartWith('💵 這個 session 的用量')
  const keys = seen.filter(s => s.args[1] === 'send-keys').map(s => s.args[4])
  expect(keys).toEqual(['Escape', '/cost', 'Escape']) // healed, ran, closed — never two Escs in a row
}, 20000)
