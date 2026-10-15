#!/usr/bin/env bun
// cc-telegram-router entry point (plan 03). Polls every configured bot, logs
// every update and every Bot API call, queues delivered messages per
// conversation, wakes the conversation's worker session, and serves the
// worker plugins over a unix socket.
//
// The inbound pipeline (transport -> handleInbound -> gate) is the v1 plugin
// code unchanged; its "MCP server" here is a stand-in whose notification()
// lands the message in the router queue instead of a Claude Code session.

import { AsyncLocalStorage } from 'async_hooks'
import { Bot, GrammyError } from 'grammy'
import { randomBytes } from 'crypto'
import { mkdirSync, renameSync, writeFileSync, existsSync, copyFileSync, realpathSync } from 'fs'
import { basename, dirname, join } from 'path'
import { defaultConfigPath, loadConfig } from './config'
import { acquireLock } from './lock'
import { openRouterDb, type Conversation } from './db'
import { ensureConversation } from './conversations'
import { writeSessionSettings } from './settings'
import { createSupervisor, bunRunner } from './supervisor'
import { createIpc, type Peer } from './ipc'
import { makeAssertAllowedChat, makeAssertSendable } from './guard'
import { openStore } from './telegram/store'
import { readAccessFile, gate as policyGate, dmCommandGate as policyDmCommandGate, type Access, type InboundContext } from './telegram/policy'
import { createHandleInbound } from './telegram/inbound'
import { registerTransport } from './telegram/transport'
import { callTool } from './telegram/outbound'
import type { ChannelParams } from '../shared/protocol'

const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`)

const configPath = defaultConfigPath(process.argv, process.execPath)
const cfg = loadConfig(configPath)
const release = acquireLock(configPath + '.lock')
mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
mkdirSync(cfg.home, { recursive: true })

// Templates ship next to the source in dev and next to the binary when deployed.
const TEMPLATES = [join(import.meta.dir, '..', 'templates'), join(cfg.stateDir, 'templates')].find(d => existsSync(join(d, 'base-settings.json')))
if (!TEMPLATES) throw new Error('templates/base-settings.json not found')

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

const settingsFor = (c: Conversation) =>
  writeSessionSettings(cfg.stateDir, TEMPLATES, c.key, c.role, { folder: c.folder, autoCompactWindow: cfg.autoCompactWindow })

// Which conversation a Bot API call is made on behalf of, for the outbound log.
// Templates may have changed since the last run: rewrite every
// conversation's settings. Running workers pick them up on their next
// resume (live sessions do not reload settings).
for (const c of db.listConversations()) settingsFor(c)

const callConv = new AsyncLocalStorage<string>()
// Telegram chat type per chat_id, captured from updates (the channel
// notification itself only carries chat_id).
const chatTypes = new Map<string, string>()

const bots = new Map<string, Bot>()

const ipc = createIpc({
  cfg, db, log,
  identify(projectDir): Peer | null {
    let dir = projectDir
    try { dir = realpathSync(projectDir) } catch {}
    if (dir === realpathSync(cfg.home)) return { mode: 'terminal', conv: null, role: 'owner' }
    if (dirname(dir) !== realpathSync(cfg.home)) return null
    const conv = db.getConversation(basename(dir))
    return conv ? { mode: 'worker', conv, role: conv.role } : null
  },
  async onCall(peer, tool, args) {
    const botName = peer.conv?.bot ?? cfg.bots[0]!.name
    const bot = bots.get(botName)!
    const token = cfg.bots.find(b => b.name === botName)!.token
    const inboxDir = peer.conv ? join(peer.conv.folder, 'attachments') : join(cfg.home, '.terminal-attachments')
    return callConv.run(peer.conv?.key ?? 'terminal', () => callTool(tool, args, {
      bot, token, inboxDir, loadAccess, store,
      assertAllowedChat: makeAssertAllowedChat(peer, loadAccess),
      assertSendable: makeAssertSendable(peer, cfg.stateDir),
    }))
  },
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
  const conv = ensureConversation(cfg, db, botName, chat_id, chatTypes.get(chat_id), c => {
    settingsFor(c)
    log(`new conversation ${c.key} (${c.role})`)
  })
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

for (const bc of cfg.bots) {
  const bot = new Bot(bc.token)
  bots.set(bc.name, bot)
  let username = ''

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
    if (ctx.chat) chatTypes.set(String(ctx.chat.id), ctx.chat.type)
    await next()
  })

  const fakeMcp = {
    async notification(n: { method: string; params?: unknown }) {
      if (n.method === 'notifications/claude/channel') onChannel(bc.name, n.params as ChannelParams)
    },
    setNotificationHandler() {},
  }
  const gate = (ctx: InboundContext) => policyGate(ctx, loadAccess(), username, saveAccess, () => randomBytes(3).toString('hex'))
  const dmCommandGate = (ctx: InboundContext) => policyDmCommandGate(ctx, loadAccess(), saveAccess)
  const handleInbound = createHandleInbound({ gate, bot, mcp: fakeMcp as never, store })
  registerTransport({ bot, mcp: fakeMcp as never, dmCommandGate, loadAccess, handleInbound, token: bc.token, inboxDir: INBOX })
  bot.catch(err => log(`${bc.name}: handler error: ${err.error}`))

  void (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await bot.start({ onStart: info => { username = info.username; log(`${bc.name}: polling as @${info.username}`) } })
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
// After a router restart, give already-running workers a moment to
// reconnect before deciding they need waking.
setTimeout(sweepBacklog, 15_000).unref()

let stopping = false
async function shutdown(sig: string) {
  if (stopping) return
  stopping = true
  log(`shutdown (${sig})`)
  await Promise.allSettled([...bots.values()].map(b => b.stop()))
  ipc.stop()
  try { db.close(); store.close() } catch {}
  release()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
log(`router up: config ${configPath}, home ${cfg.home}, ${cfg.bots.length} bot(s)`)
