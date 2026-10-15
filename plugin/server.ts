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
    } else if (m.t === 'reject') {
      process.stderr.write(`telegram: router rejected this session: ${m.reason}\n`)
    }
  },
})

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS as unknown as object[] }))
mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const st = router.state()
  if (st.kind === 'rejected') return err(`not a Telegram worker: ${st.reason}`)
  if (st.kind !== 'ready') return err('router not connected')
  return router.call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
})

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
