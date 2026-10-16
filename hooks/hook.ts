#!/usr/bin/env bun
// Worker hook (plan 04 hook). Compiled to /x/cc/.router/hooks/cc-hook; one
// binary, the job is argv[2]. Never fails or blocks the session: any problem
// means doing nothing.
//
// session-start (matcher compact): put the current <chat_context> back from
//   the conversation's .chat/context.json (plan 06 壓縮後補回).
// progress <event>: report the event to the router, which owns the
//   "🤔 思考中…" Telegram message (router/progress.ts), decides elevation
//   (router/elevation.ts) and reviews package installs (router/pkgreview.ts):
//   for PreToolUse its allow/deny is printed back.

import { readFileSync } from 'fs'
import { join } from 'path'
import { renderContext, type ChatContext } from '../router/context'
import { toolSummary } from '../router/progress'
import { DEFAULT_SOCKET, encode } from '../shared/protocol'
import { INSTALL_HINT } from '../router/packages'

const SOCKET = process.env.CC_TELEGRAM_ROUTER_SOCKET ?? DEFAULT_SOCKET

function progressEvent(event: string, input: Record<string, any>): Record<string, unknown> | null {
  const agent = input.agent_id ? { agent_id: String(input.agent_id) } : {}
  switch (event) {
    case 'prompt': return { event, telegram: /<channel source="[^"]*telegram/.test(String(input.prompt ?? '')) }
    case 'pre':
    case 'post': {
      const name = String(input.tool_name ?? '')
      if (!name) return null
      if (name.startsWith('mcp__plugin_telegram_telegram__')) {
        // Not a progress line. But a subagent's call has to reach the router:
        // an elevated one runs the router-side tool (bot_api...) with the
        // elevated role (router/elevation.ts tickets).
        if (event === 'pre' && input.agent_id) return { event, quiet: true, tool_name: name, tool_input: input.tool_input ?? {}, ...agent }
        return null
      }
      return {
        event, summary: toolSummary(name, input.tool_input), tool_name: name, ...agent,
        // what the elevation check needs; the rest of tool_input stays on this machine
        // what the permission check needs (router/permcheck.ts); file contents stay here
        ...(event === 'pre' ? { tool_input: pick(input.tool_input ?? {}, ['command', 'description', 'dangerouslyDisableSandbox', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'to', 'recipient']) } : {}),
        // package installs are reviewed by the router (router/pkgreview.ts): wait longer
        ...(event === 'pre' && name === 'Bash' && INSTALL_HINT.test(String(input.tool_input?.command ?? '')) ? { install: true } : {}),
      }
    }
    case 'compact-pre':
    case 'compact-post': return { event, trigger: String(input.trigger ?? '') }
    case 'stop': return { event }
    case 'subagent-start':
    case 'subagent-stop': return { event, ...agent }
  }
  return null
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]))
}

/** Ask the router; resolve its decision, or null when it cannot be reached in time. */
async function ask(projectDir: string, ev: Record<string, unknown>, waitMs: number): Promise<Record<string, any> | null> {
  return new Promise(resolve => {
    let buf = '', done = false
    const finish = (v: Record<string, any> | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => finish(null), waitMs)
    Bun.connect({
      unix: SOCKET,
      socket: {
        open(s) { s.write(encode({ t: 'hook', id: 1, project_dir: projectDir, ev })) },
        data(s, chunk) {
          buf += chunk.toString()
          const line = buf.split('\n')[0]
          if (!buf.includes('\n')) return
          try {
            const m = JSON.parse(line!)
            finish(m.t === 'result' ? JSON.parse(m.result.content[0].text) : {})
          } catch { finish({}) }
          s.end()
        },
        close() { finish(null) },
        error() { finish(null) },
      },
    }).catch(() => finish(null))
  })
}

async function main(): Promise<void> {
  const [job, event] = [process.argv[2], process.argv[3]]
  const input = JSON.parse(await new Response(Bun.stdin.stream()).text() || '{}')
  // The project dir, not input.cwd: a `cd` in a Bash call moves the
  // session's cwd into subfolders, and every later hook would report that.
  const dir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd
  if (!dir) return
  if (job === 'session-start') {
    const ctx = JSON.parse(readFileSync(join(dir, '.chat', 'context.json'), 'utf8')) as ChatContext
    if (!ctx.conversation) return
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: renderContext(ctx) } }))
  } else if (job === 'progress' && event) {
    const ev = progressEvent(event, input)
    if (!ev) return
    // A package review takes seconds; everything else answers at once.
    const d = await ask(dir, ev, ev.install ? 55_000 : 5000)
    if (event !== 'pre') return
    // The router checks permissions and elevation (router/elevation.ts).
    // Unreachable router: nobody leaves the sandbox; the rest is up to the
    // worker's own settings.
    const decision = d?.decision ?? (input.tool_input?.dangerouslyDisableSandbox ? 'deny' : undefined)
    if (decision) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: d?.reason ?? 'router unreachable: no unsandboxed commands' } }))
    }
  }
}

main().catch(() => {})
