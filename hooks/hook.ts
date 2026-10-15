#!/usr/bin/env bun
// Worker hook (plan 04 hook, 06 壓縮後補回). Compiled to
// /x/cc/.router/hooks/cc-hook; one binary, the event name is argv[2].
//
// session-start (matcher compact): the compact summary may have dropped the
// last <chat_context> block, so put the current one back from the
// conversation's .chat/context.json. Never fails the session: any problem
// means printing nothing.

import { readFileSync } from 'fs'
import { join } from 'path'
import { renderContext, type ChatContext } from '../router/context'

async function main(): Promise<void> {
  const event = process.argv[2]
  const input = JSON.parse(await new Response(Bun.stdin.stream()).text() || '{}')
  if (event === 'session-start') {
    const dir = input.cwd ?? process.env.CLAUDE_PROJECT_DIR
    if (!dir) return
    const ctx = JSON.parse(readFileSync(join(dir, '.chat', 'context.json'), 'utf8')) as ChatContext
    if (!ctx.conversation) return
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: renderContext(ctx) } }))
  }
}

main().catch(() => {})
