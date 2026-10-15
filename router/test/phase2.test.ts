// Phase 2 acceptance (plan 10 Phase 2; 03 「router 設定指令」 指令表, 被拒絕時,
// bot token 指令的處理, 「Claude Code 怎麼知道發生了什麼」; 06 chat context; 04 hook).
// Keep in sync with those sections.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { ensureConversation } from '../conversations'
import { runCommand, isCommand, type CommandDeps, type CommandInput } from '../commands'
import { buildContext, renderContext, renderLogs, maskTokens, gmt8 } from '../context'
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
    sessions: { isConnected: () => false, async restart(c) { calls.push(`restart ${c.key}`) }, async stop(c) { calls.push(`stop ${c.key}`) } },
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
})

test('bot list for admin; token commands only in the owner DM, and a token message is always deleted', async () => {
  expect((await run('/router bot list', ADMIN))!.reply).toBe('cc: @cc_bot (id 42, 柯柯)')
  const inGroup = (await run('/router bot add x 123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', OWNER, GROUP))!
  expect(inGroup.reply).toBe('⛔ /router bot add 只能在 owner 私訊使用, 已刪除這則訊息; token 曾出現在群組, 建議 /router bot rotate')
  expect(inGroup.deleteMessage).toBe(true)
  const byAdmin = (await run('/router bot rotate cc 123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ADMIN))!
  expect(byAdmin.reply).toStartWith('⛔ /router bot rotate 只能在 owner 私訊使用')
  expect(byAdmin.deleteMessage).toBe(true)
  expect(calls).toEqual([])
  const ok = (await run('/router bot rotate cc 123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', OWNER))!
  expect(ok.reply).toBe('已更換 bot cc: @cc_bot, 已刪除含 token 的訊息')
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
  expect((await run('/router chat compact 300k', ADMIN, GROUP))!.reply).toBe('group-100555 autoCompactWindow → 300000')
  expect((await run('/router chat compact 5k', ADMIN, GROUP))!.reply).toContain('100k 到 1m')
  expect((await run('/router chat -100555 model claude-sonnet-5-5', OWNER))!.reply).toBe('group-100555 模型 → claude-sonnet-5-5, worker 已重啟')
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

import { parseRelay, mayRelay, codeBlock, relay } from '../relay'

test('relay syntax, who may relay, and MarkdownV2 code block escaping', () => {
  expect(parseRelay('cc /status')).toEqual({ cmd: '/status', args: '' })
  expect(parseRelay('柯柯 /model opus')).toEqual({ cmd: '/model', args: 'opus' })
  expect(parseRelay('CC/usage')).toEqual({ cmd: '/usage', args: '' })
  expect(parseRelay('cc 你好')).toBeNull()
  expect(parseRelay('/router status')).toBeNull()
  expect(mayRelay('owner', '/model', 'private')).toBe(true)
  expect(mayRelay('admin', '/compact', 'supergroup')).toBe(true)
  expect(mayRelay('user', '/status', 'supergroup')).toBe(true)
  expect(mayRelay('user', '/usage', 'private')).toBe(false)
  expect(mayRelay('user', '/model', 'supergroup')).toBe(false)
  expect(codeBlock('a`b\\c (x).')).toBe('```\na\\`b\\\\c (x).\n```')
})

test('relay drives a hidden tmux on the router socket dir and always cleans up', async () => {
  const seen: Array<{ args: string[]; env?: Record<string, string> }> = []
  let captures = 0
  const exec = async (args: string[], env?: Record<string, string>) => {
    seen.push({ args, env })
    if (args[1] === 'capture-pane') { captures++; return { code: 0, stdout: captures < 2 ? '' : '❯ \nModel: opus\n▔▔▔▔\n' } }
    return { code: 0, stdout: args[0]!.endsWith('tg-status-report.sh') ? 'Version: 2.1\n' : '' }
  }
  const out = await relay({ exec, stateDir: dir, claudeBin: 'claude', scriptsDir: '/s' }, 'abcd1234', '/status', '')
  expect(out).toBe('Version: 2.1')
  expect(seen.every(s => s.env?.TMUX_TMPDIR === join(dir, 'tmux'))).toBe(true)
  expect(seen.find(s => s.args[1] === 'new-session')!.args).toContain('claude attach abcd1234')
  expect(seen.find(s => s.args[0] === '/s/tg-status-report.sh')!.args).toEqual(['/s/tg-status-report.sh', 'relay-abcd1234'])
  expect(seen.at(-1)!.args).toEqual(['tmux', 'kill-session', '-t', 'relay-abcd1234'])
  captures = 1
  const gen = await relay({ exec, stateDir: dir, claudeBin: 'claude', scriptsDir: '/s' }, 'abcd1234', '/model', 'opus')
  expect(gen).toBe('❯\nModel: opus')
  expect(seen.some(s => s.args[1] === 'send-keys' && s.args.includes('/model opus'))).toBe(true)
}, 15000)

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
  expect(chats).toContain('dm-137438526\n  chat_id 137438526, role owner, model claude-opus-5-5 (預設), compact 750000 (預設), mention -, 離線')
  expect(chats).toContain('group-100555 (Example Group)\n  chat_id -100555, role user, model claude-opus-5-5 (預設), compact 300000, mention on, 離線')
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
    identify: d => { const x = db.getConversation(d.slice(dir.length + 1)); return x ? { mode: 'worker', conv: x, role: x.role } : null },
    onCall: async () => ({ content: [] }),
    onProgress: (peer, ev) => got.push({ key: peer.conv?.key, ev }),
  })
  const hook = (event: string, input: object) => Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', event], {
    stdin: new Blob([JSON.stringify({ cwd: c.folder, ...input })]), env: { ...process.env, CC_TELEGRAM_ROUTER_SOCKET: cfg.socket },
  }).exited
  await hook('prompt', { prompt: '<channel source="plugin:telegram:telegram" chat_id="-100555">hi</channel>' })
  await hook('pre', { tool_name: 'Bash', tool_input: { command: 'ls', description: 'List' } })
  await hook('pre', { tool_name: 'mcp__plugin_telegram_telegram__reply', tool_input: {} })
  await hook('stop', {})
  for (let i = 0; i < 40 && got.length < 3; i++) await sleepMs(25)
  expect(got).toEqual([
    { key: 'group-100555', ev: { event: 'prompt', telegram: true } },
    { key: 'group-100555', ev: { event: 'pre', summary: 'Bash: List' } },
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
