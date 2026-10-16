// Phase 1 acceptance (plan 10 Phase 1; design in 03 組件/邏輯流程, 04 plugin,
// 05 目錄, 07 權限 user 範本). Keep in sync with those sections.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { convKey, convType, defaultRole, ensureConversation, findByFolder } from '../conversations'
import { renderSettings } from '../settings'
import { makeAssertAllowedChat, makeAssertSendable } from '../guard'
import { acquireLock } from '../lock'
import { createIpc } from '../ipc'
import { createSupervisor, initPrompt, parseShortId, type Runner } from '../supervisor'
import { connectRouter } from '../../plugin/client'
import type { RouterToPlugin } from '../../shared/protocol'

const TEMPLATES = join(import.meta.dir, '..', '..', 'templates')
let dir: string
let cfg: Config
let db: RouterDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-'))
  const stateDir = join(dir, '.router')
  mkdirSync(stateDir)
  cfg = {
    path: join(stateDir, 'config.json'), bots: [{ name: 'main', token: 'x' }, { name: 'second', token: 'y' }],
    home: dir, stateDir, socket: join(stateDir, 'router.sock'), owners: ['137438526'],
    model: 'claude-opus-5-5', autoCompactWindow: 750000, claudeBin: 'claude',
  }
  db = openRouterDb(join(stateDir, 'router.db'))
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// --- 05 目錄: conversation folders -------------------------------------------

test('conversation keys: dm-<id>, group-<id without minus>, prefix for non-primary bots', () => {
  expect(convType('137438526', 'private')).toBe('dm')
  expect(convType('-1009990000001', 'supergroup')).toBe('group')
  expect(convType('-1009990000001')).toBe('group')
  expect(convKey(cfg, 'main', '137438526', 'dm')).toBe('dm-137438526')
  expect(convKey(cfg, 'main', '-1009990000001', 'group')).toBe('group-1009990000001')
  expect(convKey(cfg, 'second', '137438526', 'dm')).toBe('second-dm-137438526')
})

test('owner DM gets the owner role, everything else user', () => {
  expect(defaultRole(cfg, 'dm', '137438526')).toBe('owner')
  expect(defaultRole(cfg, 'dm', '900000003')).toBe('user')
  expect(defaultRole(cfg, 'group', '-1009990000001')).toBe('user')
})

test('first message creates the folder skeleton once', () => {
  let created = 0
  const c = ensureConversation(cfg, db, 'main', '-1009990000001', 'supergroup', () => created++)
  for (const p of ['CLAUDE.md', 'memory', 'attachments', '.chat/context.json']) expect(existsSync(join(c.folder, p))).toBe(true)
  ensureConversation(cfg, db, 'main', '-1009990000001', 'supergroup', () => created++)
  expect(created).toBe(1)
  expect(db.getConversation('group-1009990000001')?.role).toBe('user')
})

// --- 07 權限: settings templates ---------------------------------------------

test('user settings: dontAsk, own folder only, sandbox reads own folder (and the shared skill folders, read-only), plugin enabled', () => {
  const s = renderSettings(TEMPLATES, 'user', { folder: '/x/cc/group-1', home: '/x/cc', botDir: '/x/cc/bot1', autoCompactWindow: 750000 }) as any
  expect(s.permissions.defaultMode).toBe('dontAsk')
  expect(s.permissions.allow).toContain('Read(//x/cc/group-1/**)')
  expect(s.permissions.deny).toContain('Write(//x/cc/group-1/.chat/**)')
  expect(s.permissions.deny).toContain('Bash(find * -exec *)')
  expect(s.sandbox.enabled).toBe(true)
  expect(s.sandbox.autoAllowBashIfSandboxed).toBe(false)
  expect(s.sandbox.filesystem.allowRead).toEqual(['/x/cc/group-1', '/x/cc/.claude/skills', '/x/cc/bot1/.claude/skills'])
  expect(s.permissions.allow).toEqual(expect.arrayContaining(['Read(//x/cc/.claude/skills/**)', 'Read(//x/cc/bot1/.claude/skills/**)']))
  expect(s.permissions.allow).not.toContain('Write(//x/cc/bot1/.claude/skills/**)')
  expect(s.autoCompactWindow).toBe(750000)
  expect(s.autoMemoryDirectory).toBe('/x/cc/group-1/memory')
  expect(s.enabledPlugins['telegram@claude-plugins-official']).toBe(true)
})

test('owner settings: bypassPermissions, no sandbox', () => {
  const s = renderSettings(TEMPLATES, 'owner', { folder: '/x/cc/dm-1', autoCompactWindow: 750000 }) as any
  expect(s.permissions.defaultMode).toBe('bypassPermissions')
  expect(s.sandbox).toBeUndefined()
})

// --- 03 Queue ----------------------------------------------------------------

test('queue: pending -> delivered -> acked; backlog lists unacked conversations', () => {
  const a = db.enqueue('dm-1', { content: 'a', meta: {} })
  const b = db.enqueue('dm-1', { content: 'b', meta: {} })
  expect(db.undelivered('dm-1').map(r => r.qid)).toEqual([a, b])
  db.markDelivered(a)
  expect(db.undelivered('dm-1').map(r => r.status)).toEqual(['delivered', 'pending'])
  db.ack(a); db.ack(b)
  expect(db.undelivered('dm-1')).toEqual([])
  expect(db.convsWithBacklog()).toEqual([])
})

// --- 04 工具: router-side outbound checks ------------------------------------

test('user worker may only target its own chat; owner may target allowlisted chats', () => {
  const conv = ensureConversation(cfg, db, 'main', '-100555', 'supergroup', () => {})
  const access = () => ({ dmPolicy: 'allowlist', allowFrom: ['137438526'], groups: { '-100555': { requireMention: true, allowFrom: [] } }, pending: {} }) as any
  const user = makeAssertAllowedChat({ mode: 'worker', conv, role: 'user' }, access)
  expect(() => user('-100555')).not.toThrow()
  expect(() => user('137438526')).toThrow(/not this conversation/)
  const owner = makeAssertAllowedChat({ mode: 'worker', conv, role: 'owner' }, access)
  expect(() => owner('137438526')).not.toThrow()
  expect(() => owner('999')).toThrow(/not allowlisted/)
})

test('files: user only from own folder, nobody from router state', () => {
  const conv = ensureConversation(cfg, db, 'main', '-100555', 'supergroup', () => {})
  const inFolder = join(conv.folder, 'a.png'); writeFileSync(inFolder, 'x')
  const outside = join(dir, 'b.png'); writeFileSync(outside, 'x')
  const state = join(cfg.stateDir, 'config.json'); writeFileSync(state, '{}')
  const user = makeAssertSendable({ mode: 'worker', conv, role: 'user' }, cfg.stateDir)
  expect(() => user(inFolder)).not.toThrow()
  expect(() => user(outside)).toThrow(/only files inside/)
  const owner = makeAssertSendable({ mode: 'worker', conv, role: 'owner' }, cfg.stateDir)
  expect(() => owner(outside)).not.toThrow()
  expect(() => owner(state)).toThrow(/router state/)
})

// --- 00 單一實例 -------------------------------------------------------------

test('single instance per config: a live holder blocks, a dead one is taken over', async () => {
  const lock = join(dir, 'config.json.lock')
  const holder = Bun.spawn(['bun', '-e', `require('${join(import.meta.dir, '..', 'lock.ts')}').acquireLock('${lock}', 'locktest-marker'); setTimeout(()=>{}, 60000) // locktest-marker`])
  for (let i = 0; i < 50 && !existsSync(lock); i++) await sleep(50)
  expect(() => acquireLock(lock, 'locktest-marker')).toThrow(/already holds/)
  holder.kill(); await holder.exited
  const release = acquireLock(lock, 'locktest-marker')
  expect(readFileSync(lock, 'utf8')).toBe(String(process.pid))
  release()
  expect(existsSync(lock)).toBe(false)
})

// --- 03 IPC + 04 plugin client ------------------------------------------------

function startIpc() {
  const calls: Array<{ key: string | undefined; tool: string }> = []
  const ipc = createIpc({
    cfg, db,
    identify(projectDir) {
      if (projectDir === cfg.home) return { mode: 'terminal', conv: null, role: 'owner' }
      const c = findByFolder(db, projectDir)
      return c ? { mode: 'worker', conv: c, role: c.role } : null
    },
    async onCall(peer, tool) {
      calls.push({ key: peer.conv?.key, tool })
      return { content: [{ type: 'text', text: `ok ${tool} for ${peer.conv?.key ?? 'terminal'}` }] }
    },
  })
  return { ipc, calls }
}

test('plugin hello -> welcome, queued messages delivered in order, ack clears them, calls answered', async () => {
  const conv = ensureConversation(cfg, db, 'main', '-100555', 'supergroup', () => {})
  db.enqueue(conv.key, { content: 'first', meta: { chat_id: '-100555' } })
  db.enqueue(conv.key, { content: 'second', meta: { chat_id: '-100555' } })
  const { ipc, calls } = startIpc()
  const got: RouterToPlugin[] = []
  const client = connectRouter({
    socketPath: cfg.socket,
    hello: { t: 'hello', project_dir: conv.folder, pid: 1 },
    onMessage(m) { got.push(m); if (m.t === 'deliver') client.send({ t: 'ack', qid: m.qid }) },
  })
  expect(await ipc.waitConnected(conv.key, 3000)).toBe(true)
  for (let i = 0; i < 40 && got.filter(m => m.t === 'deliver').length < 2; i++) await sleep(25)
  expect(got[0]).toMatchObject({ t: 'welcome', mode: 'worker', conv: conv.key, chat_id: '-100555', role: 'user' })
  expect(got.filter(m => m.t === 'deliver').map(m => (m as any).params.content)).toEqual(['first', 'second'])
  await sleep(50)
  expect(db.undelivered(conv.key)).toEqual([])
  const r = await client.call('reply', { chat_id: '-100555', text: 'hi' })
  expect(r.content[0]!.text).toBe(`ok reply for ${conv.key}`)
  expect(calls).toEqual([{ key: conv.key, tool: 'reply' }])
  client.close(); ipc.stop()
})

test('unacked deliveries are sent again after the plugin reconnects', async () => {
  const conv = ensureConversation(cfg, db, 'main', '-100555', 'supergroup', () => {})
  db.enqueue(conv.key, { content: 'lost', meta: {} })
  const { ipc } = startIpc()
  const first: string[] = []
  const c1 = connectRouter({ socketPath: cfg.socket, hello: { t: 'hello', project_dir: conv.folder, pid: 1 }, onMessage(m) { if (m.t === 'deliver') first.push(m.params.content) } })
  for (let i = 0; i < 40 && first.length < 1; i++) await sleep(25)
  expect(first).toEqual(['lost'])
  c1.close() // gone without acking
  await sleep(50)
  const second: string[] = []
  const c2 = connectRouter({ socketPath: cfg.socket, hello: { t: 'hello', project_dir: conv.folder, pid: 2 }, onMessage(m) { if (m.t === 'deliver') { second.push(m.params.content); c2.send({ t: 'ack', qid: m.qid }) } } })
  for (let i = 0; i < 40 && second.length < 1; i++) await sleep(25)
  expect(second).toEqual(['lost'])
  c2.close(); ipc.stop()
})

test('a folder that is not a conversation is rejected; the home dir is the terminal cc', async () => {
  const { ipc } = startIpc()
  const got: RouterToPlugin[] = []
  const bad = connectRouter({ socketPath: cfg.socket, hello: { t: 'hello', project_dir: join(dir, 'nope'), pid: 1 }, onMessage(m) { got.push(m) } })
  const term = connectRouter({ socketPath: cfg.socket, hello: { t: 'hello', project_dir: cfg.home, pid: 2 }, onMessage(m) { got.push(m) } })
  for (let i = 0; i < 40 && got.length < 2; i++) await sleep(25)
  expect(got).toContainEqual(expect.objectContaining({ t: 'reject' }))
  expect(got).toContainEqual({ t: 'welcome', mode: 'terminal', role: 'owner' })
  expect(bad.state().kind).toBe('rejected')
  bad.close(); term.close(); ipc.stop()
})

// --- 03 Supervisor ------------------------------------------------------------

test('wake: first time spawns with the worker flags and records the session; a burst wakes once; later wakes resume', async () => {
  const conv = ensureConversation(cfg, db, 'main', '-100555', 'supergroup', () => {})
  const runs: string[][] = []
  let connected = false
  let jobGone = false
  const run: Runner = async args => {
    runs.push(args)
    if (args[1] === 'agents') return { code: 0, stdout: JSON.stringify(jobGone ? [] : [{ id: 'abc12345', sessionId: 'abc12345-0000', name: `tg-${conv.key}` }]), stderr: '' }
    if (args[1] === '--bg') { setTimeout(() => { connected = true }, 30); return { code: 0, stdout: 'backgrounded · abc12345 · tg-x (idle)', stderr: '' } }
    return { code: 0, stdout: '', stderr: '' }
  }
  const sup = createSupervisor({
    cfg, db, run,
    isConnected: () => connected,
    async waitConnected(_k, ms) { for (let t = 0; t < ms && !connected; t += 10) await sleep(10); return connected },
    settingsPath: () => '/x/cc/.router/sessions/group-100555.json',
  })
  await Promise.all([sup.ensureAwake(conv), sup.ensureAwake(conv), sup.ensureAwake(conv)])
  const spawns = runs.filter(a => a[1] === '--bg')
  expect(spawns.length).toBe(1)
  expect(spawns[0]).toEqual(expect.arrayContaining(['--name', `tg-${conv.key}`, '--allow-dangerously-skip-permissions', '--setting-sources', 'project,local', '--settings', '--channels', 'plugin:telegram@claude-plugins-official', '--model', 'claude-opus-5-5']))
  expect(spawns[0]!.slice(-2)).toEqual(['--', initPrompt(conv)])
  expect(db.getConversation(conv.key)?.session_id).toBe('abc12345-0000')
  connected = false
  runs.length = 0
  await sup.ensureAwake(db.getConversation(conv.key)!)
  // daemon still has the job: resume carries no flags (they would start a copy)
  expect(runs.find(a => a[1] === '--bg')).toEqual(['claude', '--bg', '--resume', 'abc12345-0000'])
  // job gone (claude rm / pruned): nothing saved, so the flags go along
  jobGone = true
  connected = false
  runs.length = 0
  await sup.ensureAwake(db.getConversation(conv.key)!)
  expect(runs.find(a => a[1] === '--bg')).toEqual(expect.arrayContaining(['--resume', 'abc12345-0000', '--settings', '--channels', 'plugin:telegram@claude-plugins-official']))
})

test('parseShortId reads the id claude --bg prints', () => {
  expect(parseShortId('backgrounded · 979f4788 · bgtest (idle — send a prompt to start)')).toBe('979f4788')
  expect(parseShortId('error')).toBeNull()
})

// --- 04 plugin over real MCP stdio ------------------------------------------

test('plugin v2 speaks MCP: lists the tools, turns a delivery into a channel notification, forwards calls', async () => {
  const conv = ensureConversation(cfg, db, 'main', '-100555', 'supergroup', () => {})
  const { ipc, calls } = startIpc()
  const transport = new StdioClientTransport({
    command: 'bun', args: [join(import.meta.dir, '..', '..', 'plugin', 'server.ts')],
    env: { ...process.env, CLAUDE_PROJECT_DIR: conv.folder, CC_TELEGRAM_ROUTER_SOCKET: cfg.socket, CC_TELEGRAM_CHANNEL_GRACE_MS: '100' } as Record<string, string>,
  })
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  const notes: any[] = []
  client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.any() }), n => { notes.push(n.params) })
  await client.connect(transport)
  const tools = await client.listTools()
  expect(tools.tools.map(t => t.name)).toEqual(expect.arrayContaining(['reply', 'react', 'edit_message', 'download_attachment', 'lookup_message', 'send_sticker']))
  expect(await ipc.waitConnected(conv.key, 5000)).toBe(true)
  db.enqueue(conv.key, { content: 'hello worker', meta: { chat_id: '-100555', message_id: '7' } })
  ipc.pushQueue(conv.key)
  for (let i = 0; i < 80 && notes.length < 1; i++) await sleep(25)
  expect(notes[0]).toEqual({ content: 'hello worker', meta: { chat_id: '-100555', message_id: '7' } })
  await sleep(100)
  expect(db.undelivered(conv.key)).toEqual([])
  const r: any = await client.callTool({ name: 'reply', arguments: { chat_id: '-100555', text: 'yo' } })
  expect(r.content[0].text).toBe(`ok reply for ${conv.key}`)
  expect(calls.at(-1)).toEqual({ key: conv.key, tool: 'reply' })
  await client.close(); ipc.stop()
}, 20000)

test('plugin v2 outside the router home: tools say it is not a Telegram worker', async () => {
  const transport = new StdioClientTransport({
    command: 'bun', args: [join(import.meta.dir, '..', '..', 'plugin', 'server.ts')],
    env: { ...process.env, CLAUDE_PROJECT_DIR: '/somewhere/else', CC_TELEGRAM_ROUTER_SOCKET: cfg.socket } as Record<string, string>,
  })
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await client.connect(transport)
  const r: any = await client.callTool({ name: 'reply', arguments: { chat_id: '1', text: 'x' } })
  expect(r.isError).toBe(true)
  expect(r.content[0].text).toMatch(/not a Telegram worker/)
  await client.close()
}, 20000)

test('router offline: sends say not sent, reads say no data and let Claude choose; on reconnect the plugin tells Claude what to redo', async () => {
  const conv = ensureConversation(cfg, db, 'main', '-100555', 'supergroup', () => {})
  const transport = new StdioClientTransport({
    command: 'bun', args: [join(import.meta.dir, '..', '..', 'plugin', 'server.ts')],
    env: { ...process.env, CLAUDE_PROJECT_DIR: conv.folder, CC_TELEGRAM_ROUTER_SOCKET: cfg.socket, CC_TELEGRAM_CHANNEL_GRACE_MS: '50' } as Record<string, string>,
  })
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  const notes: any[] = []
  client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.any() }), n => { notes.push(n.params) })
  await client.connect(transport)
  // no router yet
  const r: any = await client.callTool({ name: 'reply', arguments: { chat_id: '-100555', text: '晚點見' } })
  expect(r.isError).toBe(true)
  expect(r.content[0].text).toStartWith('router 目前離線, 這個動作沒有送出')
  const look: any = await client.callTool({ name: 'lookup_message', arguments: { chat_id: '-100555' } })
  expect(look.isError).toBe(true)
  expect(look.content[0].text).toStartWith('router 目前離線, lookup_message 取不到資料, 沒有任何東西被送出或修改. 你可以先繼續不需要這份資料的工作, 也可以暫停等候')
  // router comes up; the plugin reconnects on its own and reports the missed reply (not the read)
  const { ipc } = startIpc()
  for (let i = 0; i < 200 && notes.length < 1; i++) await sleep(50)
  expect(notes).toHaveLength(1)
  expect(notes[0].meta).toMatchObject({ chat_id: '-100555', user: 'router' })
  expect(notes[0].content).toStartWith('<router_status>\nrouter 已恢復連線, Telegram 的收發都恢復正常.\n離線期間有 1 個動作沒有確定送出:')
  expect(notes[0].content).toMatch(/- \d\d:\d\d reply: 晚點見\n/)
  expect(notes[0].content).toContain('離線期間有 1 次查詢沒有取到資料:\n- ')
  expect(notes[0].content).toMatch(/- \d\d:\d\d lookup_message\n如果還需要這些資料/)
  // once reported, it is not reported again on the next reconnect
  ipc.stop()
  const again = startIpc()
  await sleep(2500)
  expect(notes).toHaveLength(1)
  await client.close(); again.ipc.stop()
}, 30000)

test('plugin calls: a router that does not answer times out after callTimeoutMs; run_skill (a long skill action) waits longer', async () => {
  const server = Bun.listen({ unix: cfg.socket, socket: { data() {} } }) // accepts, never answers
  const client = connectRouter({ socketPath: cfg.socket, hello: { t: 'hello', project_dir: dir, pid: 1 }, onMessage() {}, callTimeoutMs: 50, toolTimeoutMs: { run_skill: 400 } })
  await sleep(50)
  let skillDone = false
  const skill = client.call('run_skill', { skill: 's', action: 'a' }).then(r => { skillDone = true; return r })
  const r = await client.call('reply', { chat_id: '1', text: 'x' })
  expect(r).toMatchObject({ isError: true, content: [{ text: 'reply: router did not answer in 0.05s' }] })
  await sleep(150)
  expect(skillDone).toBe(false)
  expect((await skill).content[0]!.text).toBe('run_skill: router did not answer in 0.4s')
  client.close(); server.stop(true)
})
