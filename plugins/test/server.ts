#!/usr/bin/env bun
// Minimal channel test server (MCP JSON-RPC over stdio, no SDK).
// Everything lives in <session working directory>/.channel-probe/:
//   inbox/*.txt  a file appearing there is pushed as a channel event, then deleted
//   outbox.log   the reply tool appends here
//   server.log   what the server saw
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
const BASE = join(process.cwd(), '.channel-probe')
mkdirSync(join(BASE, 'inbox'), { recursive: true })
const VERSION = '0.0.1'
const log = (m: string) => appendFileSync(join(BASE, 'server.log'), `${new Date().toISOString()} pid=${process.pid} v${VERSION} ${m}\n`)
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
log(`start root=${process.env.CLAUDE_PLUGIN_ROOT ?? ''}`)
let ready = false
let buf = ''
process.stdin.on('data', d => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    try { handle(JSON.parse(line)) } catch {}
  }
})
process.stdin.on('end', () => { log('stdin end'); process.exit(0) })
function handle(m: any) {
  if (m.method) log(`recv ${m.method}`)
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      serverInfo: { name: 'test', version: VERSION },
      instructions: 'Events arrive as <channel source="..." chat_id="...">. Answer each with the reply tool, passing chat_id.',
    } })
  } else if (m.method === 'notifications/initialized') {
    ready = true
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{
      name: 'reply', description: 'Send a reply back over the test channel',
      inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'] },
    }] } })
  } else if (m.method === 'tools/call') {
    const a = m.params?.arguments ?? {}
    appendFileSync(join(BASE, 'outbox.log'), `${new Date().toISOString()} v${VERSION} chat=${a.chat_id} ${a.text}\n`)
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'sent' }] } })
  } else if (m.method === 'ping') {
    send({ jsonrpc: '2.0', id: m.id, result: {} })
  } else if (m.id !== undefined && m.method) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not found' } })
  }
}
let n = 0
setInterval(() => {
  if (!ready) return
  let files: string[] = []
  try { files = readdirSync(join(BASE, 'inbox')).filter(f => f.endsWith('.txt')) } catch { return }
  for (const f of files) {
    const p = join(BASE, 'inbox', f)
    let text = ''
    try { text = readFileSync(p, 'utf8'); unlinkSync(p) } catch { continue }
    n++
    send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: text.trim(), meta: { chat_id: String(n) } } })
    log(`pushed ${f} chat_id=${n}`)
  }
}, 1000)
