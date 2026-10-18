// Router socket client for the plugin: line-delimited JSON, request/response
// matching by id, reconnect with backoff (the router may restart under us —
// /restart — and the plugin must keep the MCP session alive meanwhile).

import { encode, splitLines, type PluginToRouter, type RouterToPlugin, type ToolResult } from '../shared/protocol'

export type ClientState =
  | { kind: 'connecting' }
  | { kind: 'ready'; welcome: Extract<RouterToPlugin, { t: 'welcome' }> }
  | { kind: 'rejected'; reason: string }
  | { kind: 'closed' }

export interface ClientOpts {
  socketPath: string
  /** Set to a reason to never connect (session is not a Telegram worker). */
  disabled?: string
  /** Resolves when it is safe to say hello (see server.ts); default immediately. */
  ready?: Promise<void>
  hello: Extract<PluginToRouter, { t: 'hello' }>
  onMessage: (m: RouterToPlugin) => void
  callTimeoutMs?: number
  /** Tools that may take longer than callTimeoutMs (run_skill: a skill action up to 15 minutes, a refresh, a retry; skill_try: up to 10 minutes, a refresh, a retry). */
  toolTimeoutMs?: Record<string, number>
  maxBackoffMs?: number
}

export function connectRouter(opts: ClientOpts) {
  let state: ClientState = opts.disabled ? { kind: 'rejected', reason: opts.disabled } : { kind: 'connecting' }
  let sock: { write(d: string): number; end(): void } | null = null
  let buf = ''
  let out = ''
  let nextId = 1
  let backoff = 500
  const pending = new Map<number, (r: ToolResult) => void>()
  const timeout = opts.callTimeoutMs ?? 120_000
  const toolTimeout = opts.toolTimeoutMs ?? { run_skill: 2_100_000, skill_try: 1_500_000, event_raw: 180_000 }

  function flush(): void {
    if (!sock || !out) return
    const n = sock.write(out)
    out = n > 0 ? out.slice(n) : out
  }
  function send(m: PluginToRouter): void {
    out += encode(m)
    flush()
  }

  function failPending(reason: string): void {
    // The router may or may not have acted on these before the line dropped.
    for (const [, resolve] of pending) resolve({ content: [{ type: 'text', text: reason }], isError: true, offline: 'maybe-sent' })
    pending.clear()
  }

  async function connect(): Promise<void> {
    if (state.kind === 'closed' || state.kind === 'rejected') return
    try {
      await Bun.connect({
        unix: opts.socketPath,
        socket: {
          open(s) {
            sock = s
            backoff = 500
            out = ''
            send(opts.hello)
          },
          data(_s, chunk) {
            const [lines, rest] = splitLines(buf + chunk.toString())
            buf = rest
            for (const line of lines) {
              let m: RouterToPlugin
              try { m = JSON.parse(line) } catch { continue }
              if (m.t === 'welcome') state = { kind: 'ready', welcome: m }
              else if (m.t === 'reject') { state = { kind: 'rejected', reason: m.reason }; sock?.end() }
              else if (m.t === 'result') { pending.get(m.id)?.(m.result); pending.delete(m.id) }
              opts.onMessage(m)
            }
          },
          drain() { flush() },
          close() {
            sock = null
            buf = ''
            failPending('router connection lost')
            if (state.kind === 'ready' || state.kind === 'connecting') {
              state = { kind: 'connecting' }
              setTimeout(() => void connect(), backoff)
              backoff = Math.min(backoff * 2, opts.maxBackoffMs ?? 10_000)
            }
          },
          error() {},
        },
      })
    } catch {
      setTimeout(() => void connect(), backoff)
      backoff = Math.min(backoff * 2, opts.maxBackoffMs ?? 10_000)
    }
  }
  void (opts.ready ?? Promise.resolve()).then(() => connect())

  return {
    state: () => state,
    send,
    call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
      const id = nextId++
      return new Promise(resolve => {
        pending.set(id, resolve)
        send({ t: 'call', id, tool, args })
        const limit = toolTimeout[tool] ?? timeout
        setTimeout(() => {
          if (pending.delete(id)) resolve({ content: [{ type: 'text', text: `${tool}: router did not answer in ${limit / 1000}s` }], isError: true, offline: 'maybe-sent' })
        }, limit)
      })
    },
    close(): void {
      if (sock && state.kind === 'ready') send({ t: 'bye' })
      state = { kind: 'closed' }
      sock?.end()
    },
  }
}
