#!/usr/bin/env bun
// cc-telegram-router entry point (plan 03). Polls every configured bot, logs
// every update and every Bot API call, answers /router commands itself,
// queues delivered messages per conversation, wakes the conversation's
// worker session, and serves the worker plugins over a unix socket.
//
// The inbound pipeline (transport -> handleInbound -> gate) is the v1 plugin
// code unchanged; its "MCP server" here is a stand-in whose notification()
// lands the message in the router queue instead of a Claude Code session.

import { AsyncLocalStorage } from 'async_hooks'
import { Bot, GrammyError } from 'grammy'
import { randomBytes } from 'crypto'
import { spawn } from 'child_process'
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, copyFileSync, realpathSync } from 'fs'
import { basename, dirname, join } from 'path'
import { defaultConfigPath, loadConfig, type BotConfig } from './config'
import { acquireLock } from './lock'
import { openRouterDb, type Conversation } from './db'
import { ensureConversation } from './conversations'
import { writeSessionSettings } from './settings'
import { createSupervisor, bunRunner } from './supervisor'
import { createIpc, type Peer } from './ipc'
import { makeAssertAllowedChat, makeAssertSendable } from './guard'
import { buildContext, renderContext, renderLogs, writeContextFile } from './context'
import { isCommand, runCommand, roleOf, type CommandDeps } from './commands'
import { runCli } from './cli'
import { createProgress, type ProgressEvent } from './progress'
import { rotateTick } from './rotate'
import { parseRelay, mayRelay, relay, codeBlock, type Exec } from './relay'
import { homedir } from 'os'
import { openStore } from './telegram/store'
import { readAccessFile, gate as policyGate, dmCommandGate as policyDmCommandGate, type Access, type InboundContext } from './telegram/policy'
import { createHandleInbound } from './telegram/inbound'
import { registerTransport } from './telegram/transport'
import { callTool } from './telegram/outbound'
import { chunk } from './telegram/format'
import type { ChannelParams } from '../shared/protocol'

const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`)
const startedAt = new Date()

const configPath = defaultConfigPath(process.argv, process.execPath)
const cfg = loadConfig(configPath)

// `cc-telegram-router [--config x] cli <子指令...>`: talk to the running router.
const cliAt = process.argv.indexOf('cli')
if (cliAt > 0) process.exit(await runCli(cfg.socket, process.argv.slice(cliAt + 1)))

const release = acquireLock(configPath + '.lock')
mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
mkdirSync(cfg.home, { recursive: true })

// Templates ship next to the source in dev and next to the binary when deployed.
const TEMPLATES = [join(import.meta.dir, '..', 'templates'), join(cfg.stateDir, 'templates')].find(d => existsSync(join(d, 'base-settings.json')))
if (!TEMPLATES) throw new Error('templates/base-settings.json not found')
const HOOKS_DIR = join(cfg.stateDir, 'hooks')

const DB_FILE = join(cfg.stateDir, 'router.db')
const db = openRouterDb(DB_FILE)
const store = openStore(DB_FILE)
const ACCESS_FILE = join(cfg.stateDir, 'access.json')
const INBOX = join(cfg.stateDir, 'inbox')

function loadAccess(): Access { return readAccessFile(ACCESS_FILE) }
function saveAccess(a: Access): void {
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}
function writeConfig(mutate: (raw: Record<string, unknown>) => void): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'))
  mutate(raw)
  const tmp = configPath + '.tmp'
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, configPath)
}

const settingsFor = (c: Conversation) =>
  writeSessionSettings(cfg.stateDir, TEMPLATES, c.key, c.role, {
    folder: c.folder, autoCompactWindow: c.compact ?? cfg.autoCompactWindow, hooksDir: HOOKS_DIR,
  })

// Templates may have changed since the last run: rewrite every
// conversation's settings and context file. Running workers pick settings up
// on their next resume (live sessions do not reload settings).
for (const c of db.listConversations()) { settingsFor(c); writeContextFile(cfg, c) }

// Which conversation a Bot API call is made on behalf of, for the outbound log.
const callConv = new AsyncLocalStorage<string>()
// Telegram chat type and title per chat_id, captured from updates (the
// channel notification itself only carries chat_id).
const chats = new Map<string, { type: string; title: string | null }>()

type BotHandle = { cfg: BotConfig; bot: Bot; info: { id: number; username: string; first_name: string } | null }
const bots = new Map<string, BotHandle>()

const ipc = createIpc({
  cfg, db, log,
  identify(projectDir): Peer | null {
    let dir = projectDir
    try { dir = realpathSync(projectDir) } catch {}
    const home = realpathSync(cfg.home)
    if (dir === home) return { mode: 'terminal', conv: null, role: 'owner' }
    if (!dir.startsWith(home + '/')) return null
    // Any path inside a conversation folder belongs to that conversation.
    const conv = db.getConversation(dir.slice(home.length + 1).split('/')[0]!)
    return conv ? { mode: 'worker', conv, role: conv.role } : null
  },
  async onCall(peer, tool, args) {
    // Role or settings may have changed since this plugin said hello.
    const conv = peer.conv ? db.getConversation(peer.conv.key) : null
    const live: Peer = conv ? { ...peer, conv, role: conv.role } : peer
    if (tool === 'get_chat_context') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal session: no conversation' }] }
      return { content: [{ type: 'text', text: JSON.stringify(buildContext(cfg, conv), null, 2) }] }
    }
    const botName = conv?.bot ?? cfg.bots[0]!.name
    const h = bots.get(botName)
    if (!h) return { content: [{ type: 'text', text: `bot ${botName} is not running` }], isError: true }
    const inboxDir = conv ? join(conv.folder, 'attachments') : join(cfg.home, '.terminal-attachments')
    return callConv.run(conv?.key ?? 'terminal', () => callTool(tool, args, {
      bot: h.bot, token: h.cfg.token, inboxDir, loadAccess, store,
      assertAllowedChat: makeAssertAllowedChat(live, loadAccess),
      assertSendable: makeAssertSendable(live, cfg.stateDir),
    }))
  },
  onProgress(peer, ev) {
    const c = peer.conv
    if (!c) return
    if (ev.event === 'stop' || (ev.event === 'prompt' && ev.telegram)) log(`progress ${c.key} ${ev.event}`)
    void callConv.run(c.key, () => progress.handle(c.key, c.chat_id, ev as ProgressEvent)).catch(e => log(`progress ${c.key}: ${e}`))
  },
  async onCli(text) {
    const owner = cfg.owners[0]
    if (!owner) return 'config 沒有 owners'
    const out = await runCommand({ bot: cfg.bots[0]!.name, text, senderId: owner, senderName: 'terminal', chatId: owner, chatType: 'private' }, commandDeps)
    if (!out) return `不是 /router 指令: ${text}`
    for (const l of out.logs) db.addLog(l.conv, l.text)
    out.after?.()
    return out.reply
  },
  decorate(key, qid, params, conn) {
    const c = db.getConversation(key)
    if (!c) return params
    const parts: string[] = []
    const v = c.ctx_v ?? 1
    if (conn.ctxV !== v) { parts.push(renderContext(buildContext(cfg, c))); conn.ctxV = v }
    const logs = renderLogs(db.bindLogs(key, qid))
    if (logs) parts.push(logs)
    return {
      content: parts.length ? `${parts.join('\n')}\n${params.content}` : params.content,
      meta: { ...params.meta, ctx_v: String(v) },
    }
  },
})

// Live "🤔 思考中…" message per Telegram-triggered turn (v1 hooks, now router-owned).
const progressBot = (chatId: string) => {
  const c = db.listConversations().find(x => x.chat_id === chatId)
  return bots.get(c?.bot ?? cfg.bots[0]!.name)?.bot.api
}
const progress = createProgress({
  async send(chatId, text) { return (await progressBot(chatId)?.sendMessage(chatId, text))?.message_id ?? null },
  async edit(chatId, id, text) { await progressBot(chatId)?.editMessageText(chatId, id, text) },
  async remove(chatId, id) { await progressBot(chatId)?.deleteMessage(chatId, id) },
  track: (key, chatId, id) => db.trackProgress(key, chatId, id),
  untrack: (key, id) => db.untrackProgress(key, id),
})

const supervisor = createSupervisor({
  cfg, db, log, run: bunRunner,
  isConnected: ipc.isConnected,
  waitConnected: ipc.waitConnected,
  settingsPath: settingsFor,
})

/** A message gate() delivered: queue it for its conversation and make sure a worker picks it up. */
function onChannel(botName: string, params: ChannelParams): void {
  const chat_id = params.meta.chat_id
  if (!chat_id) return
  const seen = chats.get(chat_id)
  let conv = ensureConversation(cfg, db, botName, chat_id, seen?.type, c => {
    if (seen?.title) c = db.updateConversation(c.key, { title: seen.title })
    settingsFor(c)
    writeContextFile(cfg, c)
    log(`new conversation ${c.key} (${c.role})`)
  })
  if (seen?.title && seen.title !== conv.title) {
    conv = db.updateConversation(conv.key, { title: seen.title })
    writeContextFile(cfg, conv)
  }
  // Photos are downloaded into the router's inbox, which workers cannot
  // read; move them into the conversation's own attachments folder.
  if (params.meta.image_path) {
    const dest = join(conv.folder, 'attachments', basename(params.meta.image_path))
    try {
      mkdirSync(dirname(dest), { recursive: true })
      try { renameSync(params.meta.image_path, dest) } catch { copyFileSync(params.meta.image_path, dest) }
      params.meta.image_path = dest
    } catch (e) { log(`move image for ${conv.key} failed: ${e}`) }
  }
  db.enqueue(conv.key, params)
  if (ipc.isConnected(conv.key)) ipc.pushQueue(conv.key)
  else void supervisor.ensureAwake(conv)
}

function apiOpts() {
  return cfg.apiRoot ? { client: { apiRoot: cfg.apiRoot } } : undefined
}

const commandDeps: CommandDeps = {
  cfg, db, loadAccess, saveAccess, writeConfig, startedAt,
  bots: {
    async list() {
      return [...bots.values()].map(h => ({ name: h.cfg.name, id: h.info?.id ?? 0, username: h.info?.username ?? '?', first_name: h.info?.first_name ?? '?' }))
    },
    async add(name, token) {
      if (bots.has(name)) throw new Error(`已經有名為 ${name} 的 bot`)
      const me = await new Bot(token, apiOpts()).api.getMe()
      const bc = { name, token }
      writeConfig(r => { (r.bots as BotConfig[]).push(bc) })
      cfg.bots.push(bc)
      startBot(bc)
      return me.username
    },
    async rotate(name, token) {
      const old = bots.get(name)
      if (!old) throw new Error(`沒有名為 ${name} 的 bot`)
      const me = await new Bot(token, apiOpts()).api.getMe()
      if (old.info && me.id !== old.info.id) throw new Error(`新 token 屬於另一隻 bot (@${me.username}), rotate 只能換同一隻 bot 的 token`)
      const bc = { name, token }
      writeConfig(r => { r.bots = (r.bots as BotConfig[]).map(b => b.name === name ? bc : b) })
      cfg.bots.splice(cfg.bots.findIndex(b => b.name === name), 1, bc)
      // Old poller stops first: Telegram allows one getUpdates consumer per bot.
      await old.bot.stop().catch(() => {})
      startBot(bc)
      return me.username
    },
    async remove(name) {
      const h = bots.get(name)
      if (!h) throw new Error(`沒有名為 ${name} 的 bot`)
      if (cfg.bots.length === 1) throw new Error('不能移除最後一隻 bot')
      await h.bot.stop().catch(() => {})
      bots.delete(name)
      writeConfig(r => { r.bots = (r.bots as BotConfig[]).filter(b => b.name !== name) })
      cfg.bots.splice(cfg.bots.findIndex(b => b.name === name), 1)
    },
  },
  sessions: {
    isConnected: ipc.isConnected,
    restart: (c, opts) => supervisor.restart(c, opts),
    stop: c => supervisor.stop(c),
    rotateNow: () => void rotate(),
  },
  async applySettings(c, opts) {
    settingsFor(c)
    writeContextFile(cfg, c)
    if (await supervisor.liveJob(c)) await supervisor.restart(c, opts)
    else if (opts.dropJob) await supervisor.stop(c, opts)
  },
  async sendTo(botName, chatId, text) {
    await bots.get(botName)?.bot.api.sendMessage(chatId, text)
  },
  recentMessages: (chatId, n) => store.recent(chatId, n),
  restartRouter() {
    // Under systemd (Restart=always) exiting is enough; otherwise start a
    // detached copy of ourselves once the lock is released.
    setTimeout(() => void shutdown('/restart', !process.env.INVOCATION_ID), 500)
  },
}

const exec: Exec = async (args, env) => {
  const p = Bun.spawn(args, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
  const stdout = await new Response(p.stdout).text()
  return { code: await p.exited, stdout }
}

async function handleRelay(botName: string, chatId: string, chatType: string, senderId: string, senderName: string, messageId: number, rel: { cmd: string; args: string }): Promise<void> {
  const api = bots.get(botName)!.bot.api
  const reply = (text: string, md = false) => api.sendMessage(chatId, text, {
    reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
    ...(md ? { parse_mode: 'MarkdownV2' as const } : {}),
  }).catch(e => log(`relay reply failed: ${e}`))
  const role = roleOf(commandDeps, senderId)
  const conv = db.findConversation(botName, chatId)
  const who = `${senderName}(${role})`
  if (!mayRelay(role, rel.cmd, chatType)) {
    const why = `⛔ 代打 ${rel.cmd} 只開放 owner 與 admin${chatType === 'private' ? '' : ' (群組裡所有人都能用 /status 與 /usage)'}, 你的角色是 ${role}`
    if (conv) db.addLog(conv.key, `${who} cc ${rel.cmd} → ${why}`)
    await reply(why)
    return
  }
  if (!conv) { await reply('這個對話還沒有 worker, 先傳一則一般訊息給我'); return }
  try {
    await supervisor.ensureAwake(conv)
    const job = await supervisor.liveJob(db.getConversation(conv.key)!)
    if (!job) { await reply('叫不醒這個對話的 worker'); return }
    const out = await callConv.run(conv.key, () => relay({ exec, stateDir: cfg.stateDir, claudeBin: cfg.claudeBin, scriptsDir: join(homedir(), '.claude', 'bin') }, job.id, rel.cmd, rel.args))
    db.addLog(conv.key, `${who} 代打 ${rel.cmd}${rel.args ? ' ' + rel.args : ''}`)
    await reply(codeBlock(out), true)
  } catch (e) {
    await reply(`代打 ${rel.cmd} 失敗: ${e}`)
  }
}

/** Keep the people table current; refresh the profile photo at most daily. */
function notePerson(bot: Bot, from: { id: number; first_name: string; last_name?: string; username?: string }, chatId: string | null): void {
  const uid = String(from.id)
  const p = db.seePerson({ uid, name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null, username: from.username ?? null, chat_id: chatId })
  if (p.photo_checked_at && Date.now() - Date.parse(p.photo_checked_at) < 86_400_000) return
  db.setPersonPhoto(uid, p.photo_file_id) // mark checked now, whatever happens next
  void bot.api.getUserProfilePhotos(from.id, { limit: 1 }).then(r => {
    const sizes = r.photos[0]
    db.setPersonPhoto(uid, sizes?.length ? sizes[sizes.length - 1]!.file_id : null)
  }).catch(() => {})
}

function startBot(bc: BotConfig): BotHandle {
  const bot = new Bot(bc.token, apiOpts())
  const h: BotHandle = { cfg: bc, bot, info: null }
  bots.set(bc.name, h)

  bot.api.config.use(async (prev, method, payload, signal) => {
    try {
      const res = await prev(method, payload, signal)
      const apiErr = res.ok ? null : `${res.error_code}: ${res.description}`
      if (method !== 'getUpdates') db.logApiCall(bc.name, method, payload, res, apiErr, callConv.getStore() ?? null)
      return res
    } catch (e) {
      db.logApiCall(bc.name, method, payload, undefined, String(e), callConv.getStore() ?? null)
      throw e
    }
  })
  bot.use(async (ctx, next) => {
    db.logEvent(bc.name, ctx.update)
    if (ctx.from) notePerson(bot, ctx.from, ctx.chat ? String(ctx.chat.id) : null)
    if (ctx.chat) {
      const title = ctx.chat.type === 'private'
        ? [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null
        : ('title' in ctx.chat ? ctx.chat.title ?? null : null)
      chats.set(String(ctx.chat.id), { type: ctx.chat.type, title })
      const conv = db.findConversation(bc.name, String(ctx.chat.id))
      if (conv) db.touchConversation(conv.key, ctx.chat.type === 'private' ? null : title)
    }
    const text = ctx.message?.text
    // 「cc /xxx」: type a slash command into this conversation's worker.
    const rel = parseRelay(text)
    if (rel && ctx.chat && ctx.from && loadAccess().allowFrom.concat(Object.keys(loadAccess().groups)).some(x => x === String(ctx.chat!.id) || x === String(ctx.from!.id))) {
      void handleRelay(bc.name, String(ctx.chat.id), ctx.chat.type, String(ctx.from.id), ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name, ctx.message!.message_id, rel)
      return
    }
    // /router and /restart are the router's own: answered here, never
    // forwarded. Handled off the update loop so a slow command (getMe for a
    // new token, ...) never holds up other chats' messages.
    if (ctx.chat && ctx.from && isCommand(text)) {
      const chatId = ctx.chat.id, messageId = ctx.message!.message_id
      const replied = ctx.message!.reply_to_message
      const senderId = String(ctx.from.id)
      const input = {
        bot: bc.name, text: text!, senderId,
        senderName: ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name,
        chatId: String(chatId), chatType: ctx.chat.type, messageId,
        ...(replied?.from ? { reply: { uid: String(replied.from.id), messageId: replied.message_id } } : {}),
      }
      void (async () => {
        const out = await runCommand(input, commandDeps)
        if (!out) return
        for (const l of out.logs) db.addLog(l.conv, l.text)
        let reply = out.reply
        if (out.deleteMessage) {
          // Say what actually happened: in a group the bot can only delete
          // other people's messages when it is an admin there.
          const ok = await bot.api.deleteMessage(chatId, messageId).then(() => true, e => { log(`delete command message failed: ${e}`); return false })
          reply += ok ? '\n已刪除含 token 的訊息' : '\n⚠️ 無法刪除含 token 的訊息 (bot 沒有刪除權限), 請手動刪除'
        }
        // Listings name other conversations and people: in a group they go to
        // the sender's DM, the group only hears that they were sent.
        const toDm = out.private && input.chatType !== 'private'
        const target = toDm ? senderId : String(chatId)
        // Long listings (log, chat) can exceed Telegram's 4096 per message.
        const parts = chunk(toDm ? `(${input.text.trim()} 的結果, 來自群組 ${chats.get(String(chatId))?.title ?? chatId})\n${reply}` : reply, 4000, 'newline')
        let sent = true
        for (let i = 0; i < parts.length && sent; i++) {
          sent = await bot.api.sendMessage(target, parts[i]!, !toDm && i === 0 ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {})
            .then(() => true, e => { log(`command reply failed: ${e}`); return false })
        }
        if (toDm) {
          await bot.api.sendMessage(chatId, sent ? '已私訊給你' : '⛔ 這個指令的結果只會私訊給你, 但我私訊不到你. 請先私訊我一次 (例如 /start) 再試', { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } }).catch(e => log(`command reply failed: ${e}`))
        }
        out.after?.()
      })().catch(e => log(`command failed: ${e}`))
      return
    }
    await next()
  })

  const fakeMcp = {
    async notification(n: { method: string; params?: unknown }) {
      if (n.method === 'notifications/claude/channel') onChannel(bc.name, n.params as ChannelParams)
    },
    setNotificationHandler() {},
  }
  const gate = (ctx: InboundContext) => policyGate(ctx, loadAccess(), h.info?.username ?? '', saveAccess, () => randomBytes(3).toString('hex'))
  const dmCommandGate = (ctx: InboundContext) => policyDmCommandGate(ctx, loadAccess(), saveAccess)
  const handleInbound = createHandleInbound({ gate, bot, mcp: fakeMcp as never, store })
  registerTransport({ bot, mcp: fakeMcp as never, dmCommandGate, loadAccess, handleInbound, token: bc.token, inboxDir: INBOX })
  bot.catch(err => log(`${bc.name}: handler error: ${err.error}`))

  void (async () => {
    for (let attempt = 1; bots.get(bc.name) === h; attempt++) {
      try {
        await bot.start({ onStart: info => {
          h.info = info
          // The bot itself never appears as a sender in its own updates; record it so /id shows its name.
          db.seePerson({ uid: String(info.id), name: info.first_name, username: info.username, chat_id: null })
          log(`${bc.name}: polling as @${info.username}`)
        } })
        return
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 409) {
          const delay = Math.min(1000 * attempt, 15000)
          log(`${bc.name}: 409 Conflict (another getUpdates consumer), retry in ${delay / 1000}s`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        log(`${bc.name}: polling failed: ${err}`)
        return
      }
    }
  })()
  return h
}

for (const bc of cfg.bots) startBot(bc)

// Conversations created before titles were tracked (or quiet since): ask
// Telegram once for the group's title.
for (const c of db.listConversations()) {
  if (c.title || c.type === 'dm') continue
  const api = bots.get(c.bot)?.bot.api
  if (!api) continue
  void api.getChat(c.chat_id).then(ch => {
    if ('title' in ch && ch.title) { const u = db.updateConversation(c.key, { title: ch.title }); writeContextFile(cfg, u) }
  }).catch(e => log(`getChat ${c.key}: ${e}`))
}

// A restart (deploy, /restart, crash) drops in-flight progress messages on
// the floor; remove the ones the previous process left in the chats.
{
  const orphans = db.orphanProgress()
  if (orphans.length) {
    log(`removing ${orphans.length} progress message(s) left by the previous run`)
    void progress.cleanup(orphans)
  }
}

// Backlog sweep: anything queued for a conversation whose worker is not
// connected (missed wake, worker reaped mid-delivery) gets another wake.
function sweepBacklog(): void {
  for (const key of db.convsWithBacklog()) {
    if (ipc.isConnected(key)) { ipc.pushQueue(key); continue }
    const c = db.getConversation(key)
    if (c) void supervisor.ensureAwake(c)
  }
}
setInterval(sweepBacklog, 60_000).unref()

// Workers marked by /router session rotate: stop each once it is idle.
let rotating = false
async function rotate(): Promise<void> {
  if (rotating) return
  rotating = true
  try {
    await rotateTick({ db, liveJob: c => supervisor.liveJob(c), stop: c => supervisor.stop(c), ensureAwake: c => supervisor.ensureAwake(c), log })
  } catch (e) { log(`rotate: ${e}`) } finally { rotating = false }
}
setInterval(() => void rotate(), 60_000).unref()
// After a router restart, give already-running workers a moment to
// reconnect before deciding they need waking.
setTimeout(sweepBacklog, 15_000).unref()

let stopping = false
async function shutdown(sig: string, respawn = false) {
  if (stopping) return
  stopping = true
  log(`shutdown (${sig})`)
  await Promise.allSettled([...bots.values()].map(h => h.bot.stop()))
  ipc.stop()
  try { db.close(); store.close() } catch {}
  release()
  if (respawn) spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore' }).unref()
  process.exit(0)
}
// One failed Bot API call or a bad message must never take the router (and
// with it every conversation's delivery) down.
process.on('unhandledRejection', e => log(`unhandled rejection: ${e instanceof Error ? e.stack ?? e.message : e}`))
process.on('uncaughtException', e => log(`uncaught exception: ${e.stack ?? e.message}`))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
log(`router up: config ${configPath}, home ${cfg.home}, ${cfg.bots.length} bot(s)`)
