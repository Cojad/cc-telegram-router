#!/usr/bin/env bun
// Telegram plugin v2, consumer mode (plan 04). Holds no token and never
// talks to Telegram: connects to the cc-telegram-router socket, says which
// folder its Claude Code session runs in (CLAUDE_PROJECT_DIR, set per
// session), turns router pushes into channel notifications and forwards
// every tool call to the router.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { TOOL_DEFINITIONS } from '../shared/tools'
import { DEFAULT_SOCKET, type RouterToPlugin, type ToolResult } from '../shared/protocol'
import { dirname } from 'path'
import { connectRouter } from './client'

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
// Test-only override; production workers never set it (and must not rely
// on env anyway: background sessions inherit the daemon's environment).
const SOCKET = process.env.CC_TELEGRAM_ROUTER_SOCKET ?? DEFAULT_SOCKET
// The router's home is two levels above its socket (/x/cc/.router/router.sock
// -> /x/cc). Sessions elsewhere never talk to the router: tools just report
// that this session is not a Telegram worker.
const HOME = dirname(dirname(SOCKET))
const IN_HOME = PROJECT_DIR === HOME || PROJECT_DIR.startsWith(HOME + '/')

const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

const mcp = new Server(
  { name: 'telegram', version: '2.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'The sender reads Telegram, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.',
      '',
      'Messages from Telegram arrive as <channel source="telegram" chat_id="..." message_id="..." user="..." ts="...">. If the tag has an image_path attribute, Read that file — it is a photo the sender attached. If the tag has attachment_file_id, call download_attachment with that file_id to fetch the file, then Read the returned path. Reply with the reply tool — pass chat_id back. Use reply_to (set to a message_id) only when replying to an earlier message.',
      '',
      'reply accepts file paths (files: ["/abs/path.png"]) from this conversation\'s folder. Use react to add emoji reactions, and edit_message for interim progress updates. Edits don\'t trigger push notifications — when a long task completes, send a new reply so the user\'s device pings.',
      '',
      'This session serves exactly one Telegram conversation. Sending to any other chat_id is refused unless the owner granted it.',
      '',
      "lookup_message reads the router's log of this conversation's messages (Telegram's Bot API has no history).",
    ].join('\n'),
  },
)

// Deliveries already turned into notifications, so a redelivery after a
// reconnect does not reach Claude twice.
const seen = new Set<number>()

// Claude Code drops channel notifications that arrive before it has
// registered this server as a channel, which happens some time after the
// MCP handshake. Hold the first hello until the handshake is done plus a
// grace period, so the router does not deliver into the void.
const CHANNEL_GRACE_MS = Number(process.env.CC_TELEGRAM_CHANNEL_GRACE_MS ?? 5000)
const ready = new Promise<void>(resolve => {
  mcp.oninitialized = () => setTimeout(resolve, CHANNEL_GRACE_MS)
})

const router = connectRouter({
  ready,
  disabled: IN_HOME ? undefined : `${PROJECT_DIR} is outside ${HOME}`,
  socketPath: SOCKET,
  hello: { t: 'hello', project_dir: PROJECT_DIR, session_id: process.env.CLAUDE_CODE_SESSION_ID, pid: process.pid },
  onMessage(m: RouterToPlugin) {
    if (m.t === 'deliver') {
      if (seen.has(m.qid)) { router.send({ t: 'ack', qid: m.qid }); return }
      mcp.notification({ method: 'notifications/claude/channel', params: m.params }).then(
        () => { seen.add(m.qid); router.send({ t: 'ack', qid: m.qid }) },
        e => process.stderr.write(`telegram: notification failed: ${e}\n`),
      )
    } else if (m.t === 'welcome') {
      notifyRecovered(m.chat_id)
    } else if (m.t === 'reject') {
      process.stderr.write(`telegram: router rejected this session: ${m.reason}\n`)
    }
  },
})

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS as unknown as object[] }))
mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const st = router.state()
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  if (st.kind === 'rejected') return err(`not a Telegram worker: ${st.reason}`)
  if (st.kind !== 'ready') return offline(name, args, 'not-sent')
  const r = await router.call(name, args)
  return r.offline ? offline(name, args, r.offline) : r
})

// While the router is unreachable nothing can reach Telegram. Say so plainly,
// remember what did not go out, and when the router is back, tell Claude
// which calls to redo against the situation as it is by then.
type Missed = { tool: string; what: string; at: Date; how: 'not-sent' | 'maybe-sent' }
const missed: Missed[] = []
const hhmm = (d: Date) => d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Taipei', hour12: false }).slice(0, 5)

function describe(tool: string, args: Record<string, unknown>): string {
  const text = typeof args.text === 'string' ? `: ${args.text.replace(/\s+/g, ' ').slice(0, 80)}${args.text.length > 80 ? '…' : ''}` : ''
  const emoji = typeof args.emoji === 'string' ? ` ${args.emoji}` : ''
  return `${tool}${emoji}${text}`
}

function offline(tool: string, args: Record<string, unknown>, how: Missed['how']) {
  // Reads have nothing to redo; only things meant to reach Telegram are kept.
  if (tool !== 'lookup_message' && tool !== 'get_chat_context') missed.push({ tool, what: describe(tool, args), at: new Date(), how })
  return err(how === 'not-sent'
    ? 'router 目前離線, 這個動作沒有送出, Telegram 那邊收不到. router 恢復連線時會主動通知你, 屆時請依當下最新狀況重新送出. 現在不要重試.'
    : 'router 在處理這個動作時斷線, 無法確定是否已送達. router 恢復連線時會主動通知你, 屆時先用 lookup_message 確認, 沒送到再依當下最新狀況重新送出.')
}

function notifyRecovered(chatId: string | undefined): void {
  if (!missed.length) return
  const items = missed.splice(0)
  const lines = items.map(m => `- ${hhmm(m.at)} ${m.what}${m.how === 'maybe-sent' ? ' (送出途中斷線, 可能已送達)' : ''}`)
  const content = [
    '<router_status>',
    `router 已恢復連線. 離線期間有 ${items.length} 個動作沒有確定送出:`,
    ...lines,
    '請依目前最新狀況決定要不要重新送出: 可以原樣重送, 也可以視情況更新內容或合併成一則. 標示「可能已送達」的先用 lookup_message 確認, 避免重複.',
    '</router_status>',
  ].join('\n')
  mcp.notification({ method: 'notifications/claude/channel', params: { content, meta: { ...(chatId ? { chat_id: chatId } : {}), user: 'router', ts: new Date().toISOString() } } })
    .catch(e => process.stderr.write(`telegram: recovery notification failed: ${e}\n`))
}

await mcp.connect(new StdioServerTransport())

let exiting = false
function bye(code = 0): void {
  if (exiting) return
  exiting = true
  router.close()
  setTimeout(() => process.exit(code), 200)
}
process.stdin.on('end', () => bye())
process.stdin.on('close', () => bye())
process.on('SIGTERM', () => bye())
process.on('SIGINT', () => bye())
process.on('SIGHUP', () => bye())
process.on('unhandledRejection', e => process.stderr.write(`telegram: unhandled rejection: ${e}\n`))
