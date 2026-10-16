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
import { ensureConversation, ensureBotDir, botDir, convFolder, migrateConversation, findByFolder } from './conversations'
import { writeSessionSettings, renderSettings, applyOverrides } from './settings'
import { createSupervisor, bunRunner } from './supervisor'
import { createIpc, type Peer } from './ipc'
import { makeAssertAllowedChat, makeAssertSendable } from './guard'
import { buildContext, renderContext, renderLogs, writeContextFile, maskTokens } from './context'
import { isCommand, runCommand, roleOf, type CommandDeps } from './commands'
import { runCli } from './cli'
import { importV1Messages } from './importv1'
import { refuseUse, refuseOwnBot, botApiCall, httpApiCall, takeB64, shorten, DEFAULT_CRED_ROLES } from './credentials'
import { installSkill } from './skills'
import { createAuthz } from './authz'
import { createProgress, type ProgressEvent, type Mirror } from './progress'
import { rotateTick } from './rotate'
import { requestGrant, decideGrant, sendGranted, type GrantDeps } from './grants'
import { postNotice, type ApprovalDeps } from './approvals'
import { createPkgGate, claudeReviewer } from './pkgreview'
import { newClaimCode, isClaim, initBotSetups, needsPersona, bootstrapNote, GROUP_GUIDE, checkGroup, describeSetup } from './setup'
import { createElevation } from './elevation'
import { dmLabel } from './commands'
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

// `cc-telegram-router [--config x] cred-import <名稱> <env 檔> <變數> [方法,...]`:
// move a token from a file into config.json credentials without it ever
// being printed (router/credentials.ts). Tells a running router to reload.
const credAt = process.argv.indexOf('cred-import')
if (credAt > 0) {
  const rest = process.argv.slice(credAt + 1)
  const httpAt = rest.indexOf('--http')
  const baseUrl = httpAt >= 0 ? rest[httpAt + 1] : undefined
  if (httpAt >= 0) rest.splice(httpAt, 2)
  const [name, file, varName, methods] = rest
  if (!name || !file || !varName || (httpAt >= 0 && !baseUrl)) { console.error('用法: cc-telegram-router cred-import <名稱> <env 檔> <變數> [方法或路徑,...] [--http <baseUrl>]'); process.exit(2) }
  const line = readFileSync(file, 'utf8').split('\n').find(l => l.startsWith(`${varName}=`))
  const token = line?.slice(varName.length + 1).trim().replace(/^["']|["']$/g, '')
  if (!token) { console.error(`${file} 裡沒有 ${varName}`); process.exit(1) }
  let label: string
  if (baseUrl) label = `http ${baseUrl}`
  else {
    const me = await new Bot(token, cfg.apiRoot ? { client: { apiRoot: cfg.apiRoot } } : undefined).api.getMe().catch(e => { console.error(`token 驗證失敗: ${e}`); process.exit(1) })
    label = `@${me.username} (${me.id})`
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8'))
  raw.credentials ??= {}
  raw.credentials[name] = { ...(raw.credentials[name] ?? {}), token, label, ...(baseUrl ? { kind: 'http', baseUrl } : {}), methods: methods ? methods.split(',') : (raw.credentials[name]?.methods ?? []), roles: raw.credentials[name]?.roles ?? DEFAULT_CRED_ROLES, addedBy: raw.credentials[name]?.addedBy ?? 'terminal' }
  writeFileSync(configPath + '.tmp', JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  renameSync(configPath + '.tmp', configPath)
  console.log(`已存入憑證 ${name}: ${label}, ${baseUrl ? '路徑' : '方法'} ${raw.credentials[name].methods.join(', ') || '(無)'}`)
  if (existsSync(cfg.socket)) await runCli(cfg.socket, ['cred', 'reload'])
  process.exit(0)
}

// `cc-telegram-router [--config x] import-v1 <messages.db>`: copy the v1 message log in.
const importAt = process.argv.indexOf('import-v1')
if (importAt > 0) {
  const src = process.argv[importAt + 1]
  if (!src) { console.error('用法: cc-telegram-router import-v1 <messages.db>'); process.exit(2) }
  openStore(join(cfg.stateDir, 'router.db')).close() // make sure the messages table exists
  const r = importV1Messages(join(cfg.stateDir, 'router.db'), src)
  console.log(`匯入 ${r.imported} 則, 略過已存在的 ${r.skipped} 則`)
  process.exit(0)
}

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

initBotSetups(db, cfg.bots.map(b => b.name))
for (const b of cfg.bots) ensureBotDir(cfg, b.name)
const ctxFile = (c: Conversation) => writeContextFile(cfg, c)
const ctxOf = (c: Conversation) => buildContext(cfg, c)

// No owner yet: the first person to DM "/start <code>" to a bot becomes it.
let claimCode: string | null = cfg.owners.length ? null : newClaimCode()

// home and botDir: skills shared by all bots / by this bot are readable (templates/roles)
const settingsVars = (c: Conversation) => ({ folder: c.folder, home: cfg.home, botDir: botDir(cfg, c.bot), autoCompactWindow: c.compact ?? cfg.autoCompactWindow, hooksDir: HOOKS_DIR })
const settingsFor = (c: Conversation) =>
  writeSessionSettings(cfg.stateDir, TEMPLATES, c.key, c.role, settingsVars(c), db.listOverrides(c.key))

// Templates may have changed since the last run: rewrite every
// conversation's settings and context file. Running workers pick settings up
// on their next resume (live sessions do not reload settings).
for (const c of db.listConversations()) { settingsFor(c); ctxFile(c) }

// Which conversation a Bot API call is made on behalf of, for the outbound log.
const callConv = new AsyncLocalStorage<string>()
// Telegram chat type and title per chat_id, captured from updates (the
// channel notification itself only carries chat_id).
const chats = new Map<string, { type: string; title: string | null }>()

type BotHandle = { cfg: BotConfig; bot: Bot; info: { id: number; username: string; first_name: string } | null }
const bots = new Map<string, BotHandle>()


/** Live progress events from a worker's hooks (router/progress.ts). */
function ipcOnProgress(peer: Peer, ev: Record<string, unknown>): void {
  const c = peer.conv
  if (!c) return
  if (ev.event === 'stop' || (ev.event === 'prompt' && ev.telegram)) log(`progress ${c.key} ${ev.event}`)
  let replyTo: number | undefined, mirrors: Mirror[] | undefined
  if (ev.event === 'prompt' && ev.telegram) {
    replyTo = replyNext.get(c.key); replyNext.delete(c.key)
    mirrors = pendingMirrors.get(c.key); pendingMirrors.delete(c.key)
  }
  void callConv.run(c.key, () => progress.handle(c.key, c.chat_id, ev as ProgressEvent, { replyTo, mirrors })).catch(e => log(`progress ${c.key}: ${e}`))
}

const ipc = createIpc({
  cfg, db, log,
  identify(projectDir): Peer | null {
    let dir = projectDir
    try { dir = realpathSync(projectDir) } catch {}
    const home = realpathSync(cfg.home)
    if (dir === home) return { mode: 'terminal', conv: null, role: 'owner' }
    if (!dir.startsWith(home + '/')) return null
    // Any path inside a conversation folder belongs to that conversation.
    const conv = findByFolder(db, dir)
    return conv ? { mode: 'worker', conv, role: conv.role } : null
  },
  async onCall(peer, tool, args) {
    // Role or settings may have changed since this plugin said hello. An
    // elevated subagent's call carries the elevated role (router/elevation.ts tickets).
    const conv = peer.conv ? db.getConversation(peer.conv.key) : null
    const role = conv ? (elevation.takeTicket(conv.key, tool, args) ?? conv.role) : peer.role
    const live: Peer = conv ? { ...peer, conv, role } : peer
    if (tool === 'request_send_grant') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal session: send anywhere directly' }] }
      const text = await callConv.run(conv.key, () => requestGrant(grantDeps, conv, String(args.chat_id ?? ''), args.mode === 'target' ? 'target' : 'owner', String(args.reason ?? '')))
      return { content: [{ type: 'text', text }] }
    }
    if (tool === 'bot_api') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal: 用 cc-telegram-router cli botapi' }], isError: true }
      const name = String(args.credential ?? ''), method = String(args.method ?? '')
      // "self" (or the bot's own name): this conversation's own bot, for owner/admin
      const own = (name === 'self' || name === conv.bot) && !cfg.credentials[name]
      const cred = own ? { token: cfg.bots.find(b => b.name === conv.bot)!.token, methods: [] } : cfg.credentials[name]
      const why = own ? refuseOwnBot(role, method) : refuseUse(cred, name, role, method)
      if (why) return { content: [{ type: 'text', text: why }], isError: true }
      const files = Object.fromEntries(Object.entries((args.files ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      try { for (const p of Object.values(files)) makeAssertSendable(live, cfg.stateDir)(p) } catch (e) { return { content: [{ type: 'text', text: String(e instanceof Error ? e.message : e) }], isError: true } }
      const params = (args.params ?? {}) as Record<string, unknown>
      const res = await botApiCall({ apiRoot: cfg.apiRoot, token: cred!.token, method, params, files }).catch(e => ({ ok: false, description: String(e) }))
      db.logApiCall(own ? conv.bot : `cred:${name}`, method, { params, files }, res, res.ok ? null : `${res.error_code ?? ''}: ${res.description}`, conv.key)
      return { content: [{ type: 'text', text: maskTokens(JSON.stringify(res)) }], isError: !res.ok }
    }
    if (tool === 'http_api') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal: 直接呼叫 API' }], isError: true }
      const name = String(args.credential ?? ''), method = String(args.method ?? 'POST').toUpperCase(), path = String(args.path ?? '')
      const cred = cfg.credentials[name]
      const why = refuseUse(cred, name, role, path, 'http')
      const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })
      if (why) return fail(why)
      const files = Object.fromEntries(Object.entries((args.files ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      try { for (const p of Object.values(files)) makeAssertSendable(live, cfg.stateDir)(p) } catch (e) { return fail(String(e instanceof Error ? e.message : e)) }
      const save = args.save_b64 as { at?: string; to?: string } | undefined
      const dest = save?.to ? (save.to.startsWith('/') ? save.to : join(conv.folder, save.to)) : null
      if (dest && (!dest.startsWith(conv.folder + '/') || dest.startsWith(join(conv.folder, '.chat') + '/'))) return fail('save_b64.to 要在這個對話的資料夾裡 (不能是 .chat)')
      const res = await httpApiCall({ cred: cred!, method, path, json: args.json, form: args.form as Record<string, unknown> | undefined, files }).catch(e => ({ status: 0, body: String(e) }))
      let body = res.body
      if (dest && save?.at && res.status < 300) {
        const t = takeB64(body, save.at)
        if (t.bytes) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, t.bytes); body = { saved: dest, bytes: t.bytes.length, response: t.body } }
      }
      db.logApiCall(`cred:${name}`, `${method} ${path}`, { json: shorten(args.json), form: args.form, files }, { status: res.status }, res.status >= 300 || res.status === 0 ? `HTTP ${res.status}` : null, conv.key)
      return { content: [{ type: 'text', text: JSON.stringify({ status: res.status, body: shorten(body) }) }], isError: res.status === 0 || res.status >= 300 }
    }
    if (tool === 'install_skill') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal: 直接把技能放進對應的 .claude/skills' }], isError: true }
      const scope = args.scope === 'all' ? 'all' : 'bot'
      const name = String(args.name ?? '')
      try {
        const dest = installSkill({ convFolder: conv.folder, role, name, scopeDir: scope === 'all' ? cfg.home : botDir(cfg, conv.bot), replace: args.replace === true })
        const others = db.listConversations().filter(c => c.key !== conv.key && (scope === 'all' || c.bot === conv.bot))
        for (const c of others) db.setRotate(c.key, true)
        void rotate()
        log(`${conv.key}: installed skill ${name} -> ${dest}`)
        void postNotice(approvalDeps, conv.bot, `🧩 ${conv.key} 安裝了技能 ${name} (${scope === 'all' ? '全部 bot' : '這隻 bot'} 共用): ${dest}`)
        return { content: [{ type: 'text', text: `已安裝到 ${dest}. 其他 ${others.length} 個對話下次叫醒時就有這個技能.` }] }
      } catch (e) {
        return { content: [{ type: 'text', text: String(e instanceof Error ? e.message : e) }], isError: true }
      }
    }
    if (tool === 'request_elevation') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal session: already owner' }] }
      const text = await callConv.run(conv.key, () => elevation.request(conv, String(args.reason ?? ''), String(args.action ?? '')))
      return { content: [{ type: 'text', text }] }
    }
    if (tool === 'save_bot_profile') {
      if (!conv || conv.type !== 'dm' || !cfg.owners.includes(conv.chat_id)) return { content: [{ type: 'text', text: '只有 owner 私訊的對話能設定 bot 人設' }], isError: true }
      const name = String(args.name ?? '').trim()
      const md = `# ${name || conv.bot} 的人設\n\n<!-- owner 初次設定訪談的結果 (save_bot_profile). 這隻 bot 的所有對話都會讀到這份. -->\n\n- **名字:** ${name}\n\n${String(args.persona ?? '').trim().slice(0, 3000)}\n`
      writeFileSync(join(ensureBotDir(cfg, conv.bot), 'CLAUDE.md'), md)
      db.updateBotSetup(conv.bot, { persona_done: 1 })
      // CLAUDE.md is read when a session starts: every worker of this bot picks it up on its next wake
      const others = db.listConversations().filter(c => c.bot === conv.bot && c.key !== conv.key)
      for (const c of others) db.setRotate(c.key, true)
      void rotate()
      log(`${conv.bot}: persona saved to ${botDir(cfg, conv.bot)}/CLAUDE.md, ${others.length} other worker(s) marked for rotation`)
      const s = db.getBotSetup(conv.bot)
      if (!s?.approvals_chat && !s?.group_skipped) {
        setTimeout(() => void approvalDeps.send(conv.bot, { chat_id: conv.chat_id }, GROUP_GUIDE, [{ text: '略過, 用私訊接收', data: `setup:${conv.bot}:skip` }]), 3000)
      }
      return { content: [{ type: 'text', text: `已儲存人設到 ${botDir(cfg, conv.bot)}/CLAUDE.md, 這隻 bot 的其他對話會在下次叫醒時套用 (這個對話在下次重啟後生效, 現在就照新人設說話即可). router 會接著私訊 owner 審核群組的設定步驟, 你不用再說明.` }] }
    }
    if (tool === 'get_chat_context') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal session: no conversation' }] }
      return { content: [{ type: 'text', text: JSON.stringify(ctxOf(conv), null, 2) }] }
    }
    const botName = conv?.bot ?? cfg.bots[0]!.name
    const h = bots.get(botName)
    if (!h) return { content: [{ type: 'text', text: `bot ${botName} is not running` }], isError: true }
    const inboxDir = conv ? join(conv.folder, 'attachments') : join(cfg.home, '.terminal-attachments')
    // sending to another chat on a send grant is a use of it (執行授權)
    const target = String(args.chat_id ?? '')
    if (conv && target && target !== conv.chat_id && role !== 'owner' && role !== 'admin') {
      for (const g of authz.covering(conv, o => o.some(x => x.kind === 'send' && (x.value === target || x.value === '*')))) {
        await authz.use(conv, g, `${tool} → ${label(target)}: ${String(args.text ?? args.emoji ?? args.file_id ?? '').replace(/\s+/g, ' ').slice(0, 300)}`)
      }
    }
    return callConv.run(conv?.key ?? 'terminal', () => callTool(tool, args, {
      bot: h.bot, token: h.cfg.token, inboxDir, loadAccess, store,
      assertAllowedChat: makeAssertAllowedChat(live, loadAccess, chatId => !!conv && sendGranted(db.listOverrides(conv.key).filter(o => o.kind === 'send').map(o => o.value), chatId, id => { const a = loadAccess(); return a.allowFrom.includes(id) || id in a.groups })),
      assertSendable: makeAssertSendable(live, cfg.stateDir),
    }))
  },
  async onHook(peer, ev) {
    const c = peer.conv ? db.getConversation(peer.conv.key) : null
    if (!c) return {}
    // progress events ride along (pre/post/stop/...); subagent events and quiet ones are elevation only
    if (!String(ev.event).startsWith('subagent-') && !ev.quiet) ipcOnProgress(peer, ev)
    const d = await elevation.onHook(c, ev as Record<string, any>)
    if (d.decision) return d
    // power may install packages once they pass review (router/pkgreview.ts)
    if (ev.event === 'pre' && ev.tool_name === 'Bash' && c.role === 'power' && typeof ev.tool_input?.command === 'string') {
      const p = await pkgGate.check(c, ev.tool_input.command)
      if (p.decision === 'deny') await elevation.note(c, 'blocked', `⛔ ${c.key} 套件安裝被擋: ${String(ev.tool_input.command).slice(0, 160)}\n${p.reason}`)
      return p
    }
    return d
  },
  onProgress(peer, ev) { ipcOnProgress(peer, ev) },
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
    if (conn.ctxV !== v) { parts.push(renderContext(ctxOf(c))); conn.ctxV = v }
    const logs = renderLogs(db.bindLogs(key, qid))
    if (logs) parts.push(logs)
    const who = elevation.onDeliver(c, params.meta.user_id)
    if (params.meta.message_id && params.meta.user !== 'router') currentMsg.set(key, Number(params.meta.message_id))
    if (c.type === 'dm' && cfg.owners.includes(c.chat_id) && params.meta.user_id === c.chat_id && needsPersona(db.getBotSetup(c.bot))) parts.push(bootstrapNote(c.bot))
    return {
      content: parts.length ? `${parts.join('\n')}\n${params.content}` : params.content,
      meta: { ...params.meta, ...who, ctx_v: String(v) },
    }
  },
})

// Live "🤔 思考中…" message per Telegram-triggered turn (v1 hooks, now router-owned).
// Mirrors can go to an approvals group, which is no conversation: find its bot by setup.
const progressBot = (chatId: string) => {
  const c = db.listConversations().find(x => x.chat_id === chatId)
  const viaSetup = c ? null : cfg.bots.find(b => db.getBotSetup(b.name)?.approvals_chat === chatId)
  return bots.get(c?.bot ?? viaSetup?.name ?? cfg.bots[0]!.name)?.bot.api
}
const progress = createProgress({
  async send(chatId, text, o) {
    return (await progressBot(chatId)?.sendMessage(chatId, text, {
      ...(o?.thread ? { message_thread_id: o.thread } : {}),
      ...(o?.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
    }))?.message_id ?? null
  },
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
  onWakeFail: c => void postNotice(approvalDeps, c.bot, `⚠️ ${c.key}${c.title ? ` (${c.title})` : ''} 的 worker 叫不醒, 訊息還在佇列裡. 可試 /router session restart ${c.chat_id}`),
})

/** Put a router-originated message in front of a conversation's worker. */
/** The Telegram message each conversation is handling (set as messages are delivered). */
const currentMsg = new Map<string, number>()
/** Conversations whose next turn answers a request: its progress replies to the message that asked. */
const replyNext = new Map<string, number>()
/** Where the button being handled was pressed (callback handler), for mirrored progress. */
const decisionOrigin = new AsyncLocalStorage<Omit<Mirror, 'label'>>()
const pendingMirrors = new Map<string, Mirror[]>()

/** Put a router-originated message in front of a conversation's worker.
 *  about: it answers request kind#ref, so the turn it starts shows its
 *  progress as a reply to the message that led to the request. */
function notifyConversation(c: Conversation, text: string, about?: { kind: string; ref: number }): void {
  const origin = about ? db.requestOrigin(about.kind, about.ref) : null
  if (origin != null && !progress.active(c.key)) replyNext.set(c.key, origin)
  // pressed in another chat (approvals group, target chat): mirror the progress there too
  const pressed = decisionOrigin.getStore()
  if (pressed && pressed.chatId !== c.chat_id) {
    const m: Mirror = { ...pressed, label: `↪ ${c.type === 'dm' ? dmLabel(db, c.chat_id) : (c.title ?? c.key)} (${c.key}) 收到結果, 處理中:` }
    if (!progress.attach(c.key, m)) pendingMirrors.set(c.key, [...(pendingMirrors.get(c.key) ?? []), m])
  }
  db.enqueue(c.key, { content: text, meta: { chat_id: c.chat_id, user: 'router', ts: new Date().toISOString() } })
  if (ipc.isConnected(c.key)) ipc.pushQueue(c.key)
  else void supervisor.ensureAwake(c)
}

const approvalDeps: ApprovalDeps = {
  db, owners: cfg.owners,
  isAdmin: uid => roleOf(commandDeps, uid) === 'admin',
  async send(bot, to, text, buttons) {
    const api = bots.get(bot)?.bot.api
    if (!api) return null
    return api.sendMessage(to.chat_id, text, {
      ...(to.thread_id ? { message_thread_id: to.thread_id } : {}),
      ...(buttons.length ? { reply_markup: { inline_keyboard: [buttons.map(b => ({ text: b.text, callback_data: b.data }))] } } : {}),
    }).then(m => m.message_id, e => { log(`send to ${to.chat_id}: ${e}`); return null })
  },
  noteRequest(kind, ref, conv) {
    const mid = currentMsg.get(conv.key)
    if (mid != null) db.setRequestOrigin(kind, ref, conv.key, mid)
  },
  async edit(bot, chatId, messageId, text, buttons) {
    await bots.get(bot)?.bot.api.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: buttons?.length ? [buttons.map(b => ({ text: b.text, callback_data: b.data }))] : [] } })
  },
}

const label = (id: string) => {
  const c = db.listConversations().find(x => x.chat_id === id)
  if (c?.type === 'dm' || (!c && !id.startsWith('-'))) return `${dmLabel(db, id)} (${id})`
  return `${c?.title ?? id} (${id})`
}

const authz = createAuthz({
  db, approvals: approvalDeps, notify: notifyConversation, label, log,
  applyPermissions: c => commandDeps.applyPermissions(c),
  dropElevation: ref => elevation.drop(ref),
})

const grantDeps: GrantDeps = { db, approvals: approvalDeps, notify: notifyConversation, label, authz }

const elevation = createElevation({
  db, approvals: approvalDeps, notify: notifyConversation, label, log, authz,
  applyPermissions: c => commandDeps.applyPermissions(c),
  roleOf: uid => roleOf(commandDeps, uid),
  settingsAs: (c, role, keep) => applyOverrides(renderSettings(TEMPLATES, role, settingsVars(c)), db.listOverrides(c.key).filter(o => !keep || keep(o))),
})

const pkgGate = createPkgGate({
  db, approvals: approvalDeps, notify: notifyConversation, label, log, authz,
  review: claudeReviewer({ claudeBin: cfg.claudeBin, model: () => cfg.model, cwd: (mkdirSync(join(cfg.stateDir, 'review'), { recursive: true }), join(cfg.stateDir, 'review')) }),
})

/** Group setup: /router setup group, run in the forum group itself. */
async function setupGroup(bot: string, chatId: string): Promise<string> {
  const h = bots.get(bot)
  if (!h?.info) return 'bot 還沒啟動完成, 稍後再試'
  const chat = await h.bot.api.getChat(chatId).catch(() => null)
  if (!chat) return '查不到這個群組'
  const member = await h.bot.api.getChatMember(chatId, h.info.id).catch(() => null)
  const check = checkGroup(chat as { type: string; is_forum?: boolean }, member as { status: string; can_manage_topics?: boolean } | null)
  if (!check.ok) return `⛔ ${check.reason}`
  const s = db.getBotSetup(bot)
  const same = s?.approvals_chat === chatId
  const reuse = same && !!s.notices_topic && !!s.approvals_topic && !!s.elevlog_topic && !!s.authuse_topic
  const topic = async (have: number | null | undefined, name: string) => (same && have) ? have : (await h.bot.api.createForumTopic(chatId, name)).message_thread_id
  const notices = await topic(s?.notices_topic, '🔔 重要通知')
  const approvals = await topic(s?.approvals_topic, '🔐 權限審核')
  const elevlog = await topic(s?.elevlog_topic, '📜 提權紀錄')
  const authuse = await topic(s?.authuse_topic, '🧾 執行授權')
  const fresh = (have: number | null | undefined) => !(same && have)
  db.updateBotSetup(bot, { approvals_chat: chatId, notices_topic: notices, approvals_topic: approvals, elevlog_topic: elevlog, authuse_topic: authuse, group_skipped: 0 })
  if (fresh(s?.authuse_topic)) await approvalDeps.send(bot, { chat_id: chatId, thread_id: authuse }, '執行授權: 每一次動用已核准的權限 (提權的 subagent, 永久允許的動作, 跨對話傳訊, 已核准的套件) 都會記在這裡, 附工具呼叫內容與 🚫 撤銷 按鈕.', [])
  if (!reuse) {
    await approvalDeps.send(bot, { chat_id: chatId, thread_id: notices }, '這裡會收到重要通知: 新對話, worker 叫不醒等.', [])
    await approvalDeps.send(bot, { chat_id: chatId, thread_id: approvals }, '這裡會收到權限申請: 跨對話傳訊, 套件安裝, 向 owner 的提權申請. owner 與 admin 可以按允許或拒絕.', [])
    await approvalDeps.send(bot, { chat_id: chatId, thread_id: elevlog }, '提權紀錄: 所有被擋下的動作, 所有提權請求 (主動或被動), 以及提權成功 (附原始請求的連結).', [])
  }
  return `✅ 審核群組設定完成${reuse ? ' (沿用既有話題)' : ''}: 重要通知與權限申請之後都送到這個群組的話題`
}

/** A message gate() delivered: queue it for its conversation and make sure a worker picks it up. */
function onChannel(botName: string, params: ChannelParams): void {
  const chat_id = params.meta.chat_id
  if (!chat_id) return
  const seen = chats.get(chat_id)
  let conv = ensureConversation(cfg, db, botName, chat_id, seen?.type, c => {
    if (seen?.title) c = db.updateConversation(c.key, { title: seen.title })
    settingsFor(c)
    ctxFile(c)
    log(`new conversation ${c.key} (${c.role})`)
    void postNotice(approvalDeps, botName, `🆕 新對話 ${c.key}${seen?.title ? ` (${seen.title})` : ''}, 角色 ${c.role}`)
  })
  if (seen?.title && seen.title !== conv.title) {
    conv = db.updateConversation(conv.key, { title: seen.title })
    ctxFile(conv)
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
      ensureBotDir(cfg, name)
      db.updateBotSetup(name, {})
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
    ctxFile(c)
    if (await supervisor.liveJob(c)) await supervisor.restart(c, opts)
    else if (opts.dropJob) await supervisor.stop(c, opts)
  },
  applyPermissions(c) {
    settingsFor(c)
    ctxFile(c)
    db.setRotate(c.key, true)
    void rotate()
  },
  creds: {
    async add(name, token, methods, addedBy, http) {
      let label: string
      if (http) label = `http ${http.baseUrl}`
      else { const me = await new Bot(token, apiOpts()).api.getMe(); label = `@${me.username} (${me.id})` }
      const c = { token, label, methods, roles: DEFAULT_CRED_ROLES, addedBy, ...(http ? { kind: 'http' as const, baseUrl: http.baseUrl } : {}) }
      writeConfig(r => { r.credentials = { ...(r.credentials as object ?? {}), [name]: c } })
      cfg.credentials[name] = c
      return label
    },
    update(name, change) {
      writeConfig(r => {
        const all = (r.credentials ?? {}) as Record<string, any>
        if (change) change(all[name]); else delete all[name]
        r.credentials = all
      })
      if (change) change(cfg.credentials[name]!); else delete cfg.credentials[name]
    },
    reload() {
      cfg.credentials = JSON.parse(readFileSync(configPath, 'utf8')).credentials ?? {}
      return Object.keys(cfg.credentials).length
    },
    async call(name, method, params, files) {
      const token = cfg.credentials[name]?.token ?? cfg.bots.find(b => b.name === name)?.token
      if (!token) throw new Error(`沒有名為 ${name} 的憑證或 bot`)
      const res = await botApiCall({ apiRoot: cfg.apiRoot, token, method, params, files })
      db.logApiCall(`cred:${name}`, method, { params, files }, res, res.ok ? null : `${res.error_code ?? ''}: ${res.description}`, 'terminal')
      return res
    },
  },
  setup: {
    describe: bot => describeSetup(db.getBotSetup(bot), cfg.owners[0]),
    skip(bot) { db.updateBotSetup(bot, { group_skipped: 1, approvals_chat: null, approvals_topic: null, notices_topic: null }) },
    resetPersona(bot) { db.updateBotSetup(bot, { persona_done: 0 }) },
    group: setupGroup,
  },
  overridesRemoved: (c, uid) => authz.syncRemoved(c, uid),
  effectiveSettings: c => applyOverrides(renderSettings(TEMPLATES, c.role, settingsVars(c)), db.listOverrides(c.key)),
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
    // Buttons: send grants, package reviews, setup. Each settles every copy itself.
    const data = ctx.callbackQuery?.data
    if (data && ctx.from && /^(grant|pkg|elev|setup):/.test(data)) {
      const uid = String(ctx.from.id)
      let answer = null as string | null
      // the request message that was pressed: the turn this decision starts mirrors its progress there
      const pressed = ctx.callbackQuery!.message
      const origin = { chatId: String(ctx.chat?.id ?? ''), ...(pressed && 'message_thread_id' in pressed && pressed.message_thread_id ? { thread: pressed.message_thread_id } : {}), ...(pressed ? { replyTo: pressed.message_id } : {}) }
      await decisionOrigin.run(origin, async () => {
        if (data.endsWith(':revoke')) answer = await authz.revoke(data, uid)
        else if (data.startsWith('grant:')) answer = await decideGrant(grantDeps, data, uid, String(ctx.chat?.id ?? ''))
        else if (data.startsWith('pkg:')) answer = await pkgGate.decide(data, uid)
        else if (data.startsWith('elev:')) answer = await elevation.decide(data, uid)
      })
      if (data === `setup:${bc.name}:skip`) {
        if (!cfg.owners.includes(uid)) answer = '只有 owner 能決定'
        else {
          commandDeps.setup.skip(bc.name)
          answer = '已略過, 通知與申請都會私訊給你'
          await ctx.editMessageText(`${GROUP_GUIDE}\n\n${answer}`).catch(() => {})
        }
      }
      await ctx.answerCallbackQuery({ text: answer ?? '' }).catch(() => {})
      return
    }
    // A router without owners: "/start <code>" in a DM claims it (router/setup.ts).
    if (claimCode && ctx.chat?.type === 'private' && ctx.from && isClaim(ctx.message?.text, claimCode)) {
      const uid = String(ctx.from.id)
      claimCode = null
      writeConfig(r => { r.owners = [uid] })
      cfg.owners.push(uid)
      const a = loadAccess()
      if (!a.allowFrom.includes(uid)) { a.allowFrom.push(uid); saveAccess(a) }
      log(`owner claimed by ${uid}`)
      await ctx.reply('✅ 你現在是這個 router 的 owner. 傳任何一句話給我, 我們從 bot 的名字與個性開始設定.').catch(() => {})
      return
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

// Conversations from before bot folders (<home>/<key>): stop each worker,
// move the folder and its transcripts to <home>/bot<id>/<type>-<chat>, and
// let the next message resume it there. Done before polling starts.
for (const c of db.listConversations()) {
  if (c.folder === convFolder(cfg, c.bot, c.chat_id, c.type)) continue
  await supervisor.stop(c, { dropJob: true }).catch(e => log(`stop ${c.key} before move: ${e}`))
  const moved = migrateConversation(cfg, db, c)
  if (moved) { settingsFor(moved); ctxFile(moved); log(`moved ${c.key}: ${c.folder} -> ${moved.folder}`) }
}

for (const bc of cfg.bots) startBot(bc)

// People seen before the people table existed: fill them in from the event log.
{
  const n = db.backfillPeople()
  if (n) log(`people: backfilled ${n} from the event log`)
}

// Conversations created before titles were tracked (or quiet since): ask
// Telegram once for the group's title.
for (const c of db.listConversations()) {
  if (c.title || c.type === 'dm') continue
  const api = bots.get(c.bot)?.bot.api
  if (!api) continue
  void api.getChat(c.chat_id).then(ch => {
    if ('title' in ch && ch.title) { const u = db.updateConversation(c.key, { title: ch.title }); ctxFile(u) }
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
  elevation.stop()
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
if (claimCode) log(`沒有 owner: 私訊任一隻 bot「/start ${claimCode}」認領 owner (這個碼只在這次執行有效)`)
