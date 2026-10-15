#!/usr/bin/env bun
// Worker hook (plan 04 hook). Compiled to /x/cc/.router/hooks/cc-hook; one
// binary, the job is argv[2]. Never fails or blocks the session: any problem
// means doing nothing.
//
// session-start (matcher compact): put the current <chat_context> back from
//   the conversation's .chat/context.json (plan 06 壓縮後補回).
// progress <event>: report a live-progress event to the router, which owns
//   the "🤔 思考中…" Telegram message (router/progress.ts). Fire and forget.

import { readFileSync } from 'fs'
import { join } from 'path'
import { renderContext, type ChatContext } from '../router/context'
import { toolSummary } from '../router/progress'
import { DEFAULT_SOCKET, encode } from '../shared/protocol'

const SOCKET = process.env.CC_TELEGRAM_ROUTER_SOCKET ?? DEFAULT_SOCKET

function progressEvent(event: string, input: Record<string, any>): Record<string, unknown> | null {
  switch (event) {
    case 'prompt': return { event, telegram: /<channel source="[^"]*telegram/.test(String(input.prompt ?? '')) }
    case 'pre':
    case 'post': {
      const name = String(input.tool_name ?? '')
      if (!name || name.startsWith('mcp__plugin_telegram_telegram__')) return null
      return { event, summary: toolSummary(name, input.tool_input) }
    }
    case 'compact-pre':
    case 'compact-post': return { event, trigger: String(input.trigger ?? '') }
    case 'stop': return { event }
  }
  return null
}

async function send(projectDir: string, ev: Record<string, unknown>): Promise<void> {
  await new Promise<void>(resolve => {
    const t = setTimeout(resolve, 2000)
    Bun.connect({
      unix: SOCKET,
      socket: {
        open(s) { s.write(encode({ t: 'progress', project_dir: projectDir, ev })); s.end() },
        close() { clearTimeout(t); resolve() },
        data() {}, error() { clearTimeout(t); resolve() },
      },
    }).catch(() => { clearTimeout(t); resolve() })
  })
}

async function main(): Promise<void> {
  const [job, event] = [process.argv[2], process.argv[3]]
  const input = JSON.parse(await new Response(Bun.stdin.stream()).text() || '{}')
  const dir = input.cwd ?? process.env.CLAUDE_PROJECT_DIR
  if (!dir) return
  if (job === 'session-start') {
    const ctx = JSON.parse(readFileSync(join(dir, '.chat', 'context.json'), 'utf8')) as ChatContext
    if (!ctx.conversation) return
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: renderContext(ctx) } }))
  } else if (job === 'progress' && event) {
    const ev = progressEvent(event, input)
    if (ev) await send(dir, ev)
  }
}

main().catch(() => {})
