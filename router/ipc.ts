// Unix socket server for worker plugins (plan 03 IPC, 04 「router 協定」).
// A plugin identifies itself by CLAUDE_PROJECT_DIR; the router maps that to
// a conversation (or to the terminal cc at the home dir) and from then on
// pushes that conversation's queue to it and executes its tool calls.

import { rmSync, chmodSync } from 'fs'
import type { Socket } from 'bun'
import { encode, splitLines, type ChannelParams, type Mode, type PluginToRouter, type RouterToPlugin, type ToolResult } from '../shared/protocol'
import type { Config } from './config'
import type { Conversation, RouterDb } from './db'

export type Peer = { mode: Mode; conv: Conversation | null; role: string }

/** ctxV: the chat_context version this connection has already been shown. */
export type ClientState = { buf: string; out: string; peer: Peer | null; ctxV?: number }

export interface IpcDeps {
  cfg: Config
  db: RouterDb
  /** Map a plugin's project dir to who it is; null = reject. */
  identify: (projectDir: string) => Peer | null
  onCall: (peer: Peer, tool: string, args: Record<string, unknown>) => Promise<ToolResult>
  /** Worker hook progress event, identified by project dir like a hello. */
  onProgress?: (peer: Peer, ev: Record<string, unknown>) => void
  /** Worker hook event: progress plus elevation decisions; returns the decision.
   *  deadline: the hook waits no longer (shared/retry.ts); none from older hooks. */
  onHook?: (peer: Peer, ev: Record<string, unknown>, deadline?: number) => Record<string, unknown> | Promise<Record<string, unknown>>
  /** A worker's plugin said hello (its session id when the plugin knows it, its pid). */
  onWorker?: (conv: Conversation, hello: { session_id?: string; pid: number }) => void
  /** That worker's plugin connection closed. */
  onWorkerGone?: (key: string) => void
  /** Terminal CLI: run a /router command as owner and return the reply. */
  onCli?: (text: string) => Promise<string>
  /** Last-moment additions to a delivery (chat_context, router_log). */
  decorate?: (key: string, qid: number, params: ChannelParams, conn: ClientState) => ChannelParams
  log?: (msg: string) => void
}

export function createIpc(deps: IpcDeps) {
  const { cfg, db, identify, onCall } = deps
  const log = deps.log ?? (() => {})
  const workers = new Map<string, Socket<ClientState>>()
  const waiters = new Map<string, Array<(ok: boolean) => void>>()

  function send(s: Socket<ClientState>, msg: RouterToPlugin): void {
    s.data.out += encode(msg)
    flush(s)
  }
  function flush(s: Socket<ClientState>): void {
    if (!s.data.out) return
    const n = s.write(s.data.out)
    s.data.out = n > 0 ? s.data.out.slice(n) : s.data.out
  }

  /** Send queued messages. On (re)connect everything not yet acked goes out
   *  again (the plugin dedups by qid); otherwise only never-sent ones. */
  function pushQueue(key: string, includeUnacked = false): void {
    const s = workers.get(key)
    if (!s) return
    for (const row of db.undelivered(key)) {
      if (!includeUnacked && row.status !== 'pending') continue
      let params = JSON.parse(row.params) as ChannelParams
      if (deps.decorate) params = deps.decorate(key, row.qid, params, s.data)
      send(s, { t: 'deliver', qid: row.qid, params })
      db.markDelivered(row.qid)
    }
  }

  function onHello(s: Socket<ClientState>, m: Extract<PluginToRouter, { t: 'hello' }>): void {
    const peer = identify(m.project_dir)
    if (!peer) {
      send(s, { t: 'reject', reason: `${m.project_dir} is not a Telegram conversation folder` })
      return
    }
    s.data.peer = peer
    if (peer.mode === 'terminal' || !peer.conv) {
      send(s, { t: 'welcome', mode: peer.mode, role: peer.role })
      log(`terminal plugin connected (pid ${m.pid})`)
      return
    }
    const key = peer.conv.key
    const old = workers.get(key)
    if (old && old !== s) old.end()
    workers.set(key, s)
    send(s, { t: 'welcome', mode: 'worker', conv: key, chat_id: peer.conv.chat_id, role: peer.role })
    log(`worker ${key} connected (pid ${m.pid}, session ${m.session_id ?? '?'})`)
    deps.onWorker?.(peer.conv, { session_id: m.session_id, pid: m.pid })
    pushQueue(key, true)
    for (const w of waiters.get(key) ?? []) w(true)
    waiters.delete(key)
  }

  async function onMessage(s: Socket<ClientState>, m: PluginToRouter): Promise<void> {
    switch (m.t) {
      case 'hello': return onHello(s, m)
      case 'ack': db.ack(m.qid); return
      case 'bye': {
        const key = s.data.peer?.conv?.key
        if (key && workers.get(key) === s) { workers.delete(key); deps.onWorkerGone?.(key) }
        log(`worker ${key ?? '(terminal)'} said bye`)
        return
      }
      case 'hook': {
        const peer = identify(m.project_dir)
        if (m.retry) log(`hook ${String(m.ev?.event)} ${peer?.conv?.key ?? m.project_dir}: reached the router on try ${m.retry.tries}, ${(m.retry.waited_ms / 1000).toFixed(1)}s after the first`)
        const decision = peer && deps.onHook ? await deps.onHook(peer, m.ev, typeof m.deadline === 'number' ? m.deadline : undefined) : {}
        send(s, { t: 'result', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } })
        return
      }
      case 'progress': {
        const peer = identify(m.project_dir)
        if (peer && deps.onProgress) deps.onProgress(peer, m.ev)
        return
      }
      case 'cli': {
        const text = deps.onCli ? await deps.onCli(m.text) : 'CLI not available'
        send(s, { t: 'result', id: m.id, result: { content: [{ type: 'text', text }] } })
        return
      }
      case 'call': {
        if (!s.data.peer) {
          send(s, { t: 'result', id: m.id, result: { content: [{ type: 'text', text: 'not identified: send hello first' }], isError: true } })
          return
        }
        const result = await onCall(s.data.peer, m.tool, m.args ?? {})
        send(s, { t: 'result', id: m.id, result })
        return
      }
    }
  }

  rmSync(cfg.socket, { force: true })
  const server = Bun.listen<ClientState>({
    unix: cfg.socket,
    socket: {
      open(s) { s.data = { buf: '', out: '', peer: null } },
      data(s, chunk) {
        const [lines, rest] = splitLines(s.data.buf + chunk.toString())
        s.data.buf = rest
        for (const line of lines) {
          let m: PluginToRouter
          try { m = JSON.parse(line) } catch { log(`bad line from plugin: ${line.slice(0, 200)}`); continue }
          void onMessage(s, m).catch(e => log(`ipc ${m.t} error: ${e}`))
        }
      },
      drain(s) { flush(s) },
      close(s) {
        const key = s.data?.peer?.conv?.key
        if (key && workers.get(key) === s) {
          workers.delete(key)
          log(`worker ${key} disconnected`)
          deps.onWorkerGone?.(key)
        }
      },
    },
  })
  chmodSync(cfg.socket, 0o600)

  return {
    isConnected: (key: string) => workers.has(key),
    waitConnected(key: string, ms: number): Promise<boolean> {
      if (workers.has(key)) return Promise.resolve(true)
      return new Promise(resolve => {
        const list = waiters.get(key) ?? []
        let done = false
        const fn = (ok: boolean) => { if (!done) { done = true; resolve(ok) } }
        list.push(fn)
        waiters.set(key, list)
        setTimeout(() => fn(false), ms)
      })
    },
    /** Push whatever is queued for this conversation, if its plugin is here. */
    pushQueue,
    stop() { server.stop(true); rmSync(cfg.socket, { force: true }) },
  }
}
