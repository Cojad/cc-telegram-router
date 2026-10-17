#!/usr/bin/env bun
// Worker hook (plan 04 hook). Compiled to <stateDir>/hooks/cc-hook; one
// binary, the job is argv[2]. Never fails or blocks the session: any problem
// means doing nothing.
//
// session-start (matcher compact): put the current <chat_context> back from
//   the conversation's .chat/context.json (plan 06 壓縮後補回).
// progress <event>: report the event to the router, which owns the
//   "🤔 思考中…" Telegram message (router/progress.ts), decides elevation
//   (router/elevation.ts) and reviews package installs (router/pkgreview.ts):
//   for PreToolUse its allow/deny is printed back. PreToolUse and
//   SubagentStart retry a router they cannot reach (shared/retry.ts).

import { readFileSync } from 'fs'
import { join } from 'path'
import { renderContext, type ChatContext } from '../router/context'
import { toolSummary } from '../router/progress'
import { encode, type PluginToRouter } from '../shared/protocol'
import { reportEvent, UNREACHABLE, RETRY_WINDOW_MS } from '../shared/retry'
import { findRouter } from '../shared/locate'
import { INSTALL_HINT } from '../router/packages'

// The router's socket from its locator file (shared/locate.ts); none = unreachable.
const FOUND = findRouter()
const SOCKET = 'socket' in FOUND ? FOUND.socket : null

function progressEvent(event: string, input: Record<string, any>): Record<string, unknown> | null {
  const agent = input.agent_id ? { agent_id: String(input.agent_id) } : {}
  switch (event) {
    case 'prompt': {
      const tags = String(input.prompt ?? '').match(/<channel source="[^"]*telegram[^>]*>/g) ?? []
      // a turn started by message reactions alone (router/reactions.ts): the router shows no progress for it
      return { event, telegram: tags.length > 0, ...(tags.length && tags.every(t => / kind="reactions"/.test(t)) ? { reactions: true } : {}) }
    }
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
        // an Agent call's name and type: SendMessage to it counts as to the conversation's own subagent (router/elevation.ts)
        ...(event === 'pre' ? { tool_input: pick(input.tool_input ?? {}, ['command', 'description', 'dangerouslyDisableSandbox', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'to', 'recipient', ...(name === 'Agent' || name === 'Task' ? ['name', 'subagent_type'] : [])]) } : {}),
        // package installs are reviewed by the router (router/pkgreview.ts): wait longer
        ...(event === 'pre' && name === 'Bash' && INSTALL_HINT.test(String(input.tool_input?.command ?? '')) ? { install: true } : {}),
      }
    }
    case 'compact-pre':
    case 'compact-post': return { event, trigger: String(input.trigger ?? '') }
    case 'stop': return { event }
    case 'subagent-start': return { event, ...agent, ...(input.agent_type ? { agent_type: String(input.agent_type) } : {}) }
    case 'subagent-stop': return { event, ...agent }
  }
  return null
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]))
}

/** One request to the router: its decision; null when it did not answer in
 *  waitMs (connected: the router is still at it, not a reason to retry);
 *  UNREACHABLE when nothing answered (no socket, refused, closed before the answer). */
function ask(socket: string, msg: Extract<PluginToRouter, { t: 'hook' }>, waitMs: number): Promise<Record<string, any> | null | typeof UNREACHABLE> {
  return new Promise(resolve => {
    let buf = '', done = false
    const finish = (v: Record<string, any> | null | typeof UNREACHABLE) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => finish(null), waitMs)
    Bun.connect({
      unix: socket,
      socket: {
        open(s) { s.write(encode(msg)) },
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
        close() { finish(UNREACHABLE) },
        error() { finish(UNREACHABLE) },
      },
    }).catch(() => finish(UNREACHABLE))
  })
}

/** Tests only: a shorter retry window (never longer than RETRY_WINDOW_MS). */
const WINDOW = Number(process.env.CC_TELEGRAM_ROUTER_RETRY_WINDOW_MS) || RETRY_WINDOW_MS

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
    const d = SOCKET ? await reportEvent(event, dir, ev, (msg, waitMs) => ask(SOCKET, msg, waitMs), WINDOW) : null
    if (event !== 'pre') return
    // The router checks permissions and elevation (router/elevation.ts).
    // Unreachable router (every try failed): nobody leaves the sandbox; the
    // rest is up to the worker's own settings.
    const decision = d?.decision ?? (input.tool_input?.dangerouslyDisableSandbox ? 'deny' : undefined)
    if (decision) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: d?.reason ?? 'router unreachable: no unsandboxed commands' } }))
    }
  }
}

main().catch(() => {})
