// Live progress message (v1 docs/v1/tg-live-progress-hooks.md, ported to v2).
// Worker hooks only report events over the router socket; the router owns
// the Telegram message: "🤔 思考中…" when a Telegram-triggered turn starts, one
// line per tool call (▶ rewritten in place to ✅), compaction lines, "✅ 完成"
// at Stop, then deleted after a few seconds. Edits are throttled so a burst of
// tool calls does not hit Telegram's per-chat edit limit. A turn started by
// the outcome of a request (approved, denied, revoked) replies to the message
// that led to the request, so whoever asked sees it carry on, and a copy goes
// where the button was pressed (Mirror) (柯姊 2026-10-16).

export type ProgressEvent =
  | { event: 'prompt'; telegram: boolean }
  | { event: 'pre' | 'post'; summary: string }
  | { event: 'compact-pre' | 'compact-post'; trigger: string }
  | { event: 'stop' }

/** A second copy of the progress where someone pressed the approve/deny/revoke
 *  button that started this turn (柯姊 2026-10-16), so they see the
 *  conversation working. label names the conversation. */
export type Mirror = { chatId: string; thread?: number; replyTo?: number; label: string }

export interface ProgressApi {
  send(chatId: string, text: string, opts?: { thread?: number; replyTo?: number }): Promise<number | null>
  edit(chatId: string, messageId: number, text: string): Promise<void>
  remove(chatId: string, messageId: number): Promise<void>
  /** Remember / forget a live progress message outside this process, so one
   *  left behind by a router restart can be removed on the next start. */
  track?(key: string, chatId: string, messageId: number): void
  untrack?(key: string, messageId: number): void
}

type Target = { chatId: string; messageId: number | null; label?: string; starting: Promise<void> | null }
type State = { targets: Target[]; lines: string[]; head: string; timer: ReturnType<typeof setTimeout> | null; dirty: boolean }

const MAX_LINES = 25

export function createProgress(api: ProgressApi, opts: { throttleMs?: number; deleteAfterMs?: number } = {}) {
  const throttle = opts.throttleMs ?? 800
  const deleteAfter = opts.deleteAfterMs ?? 5000
  const states = new Map<string, State>()

  const render = (s: State, t: Target) => {
    const body = s.lines.length ? `${s.head}\n\n${s.lines.join('\n')}` : s.head
    return (t.label ? `${t.label}\n${body}` : body).slice(0, 4000)
  }

  function open(key: string, s: State, t: Target, where?: { thread?: number; replyTo?: number }): void {
    t.starting = api.send(t.chatId, render(s, t), where && (where.thread || where.replyTo) ? { ...(where.thread ? { thread: where.thread } : {}), ...(where.replyTo ? { replyTo: where.replyTo } : {}) } : undefined)
      .then(id => { t.messageId = id; if (id != null) api.track?.(key, t.chatId, id) }, () => { t.messageId = null })
      .finally(() => { t.starting = null })
    s.targets.push(t)
  }

  async function flush(s: State): Promise<void> {
    s.timer = null
    await Promise.all(s.targets.map(t => t.starting))
    if (!s.dirty) return
    s.dirty = false
    await Promise.all(s.targets.filter(t => t.messageId != null).map(t => api.edit(t.chatId, t.messageId!, render(s, t)).catch(() => {})))
  }
  function schedule(s: State): void {
    s.dirty = true
    if (!s.timer) s.timer = setTimeout(() => void flush(s), throttle)
  }

  async function finish(key: string, s: State): Promise<void> {
    states.delete(key)
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    s.head = '✅ 完成'
    s.dirty = true
    await flush(s)
    for (const t of s.targets) {
      const id = t.messageId
      if (id == null) continue
      setTimeout(() => void api.remove(t.chatId, id).catch(() => {}).finally(() => api.untrack?.(key, id)), deleteAfter)
    }
  }

  return {
    /** opts.replyTo: the conversation's own progress replies to that message;
     *  opts.mirrors: copies elsewhere (see Mirror). */
    async handle(key: string, chatId: string, ev: ProgressEvent, opts: { replyTo?: number; mirrors?: Mirror[] } = {}): Promise<void> {
      const s = states.get(key)
      if (ev.event === 'prompt') {
        if (s) await finish(key, s)
        if (!ev.telegram) return
        const st: State = { targets: [], lines: [], head: '🤔 思考中…', timer: null, dirty: false }
        states.set(key, st)
        open(key, st, { chatId, messageId: null, starting: null }, { replyTo: opts.replyTo })
        for (const m of opts.mirrors ?? []) open(key, st, { chatId: m.chatId, messageId: null, label: m.label, starting: null }, m)
        return
      }
      if (!s) return // not a Telegram-triggered turn
      if (ev.event === 'stop') return finish(key, s)
      if (ev.event === 'pre' || ev.event === 'post') {
        const pre = `▶ ${ev.summary}`, post = `✅ ${ev.summary}`
        // Tools can run in parallel: tick the latest matching ▶ line, wherever it is.
        const at = ev.event === 'post' ? s.lines.lastIndexOf(pre) : -1
        if (at >= 0) s.lines[at] = post
        else s.lines.push(ev.event === 'post' ? post : pre)
      } else {
        const pre = `🗜 壓縮 context 中 (trigger=${ev.trigger})…`
        if (ev.event === 'compact-post' && s.lines.at(-1) === pre) s.lines[s.lines.length - 1] = '✅ 壓縮完成, 繼續處理'
        else s.lines.push(ev.event === 'compact-post' ? '✅ 壓縮完成, 繼續處理' : pre)
      }
      s.lines = s.lines.slice(-MAX_LINES)
      schedule(s)
    },
    /** Add a mirror to the turn already running for this conversation. False when none is. */
    attach(key: string, m: Mirror): boolean {
      const s = states.get(key)
      if (!s) return false
      open(key, s, { chatId: m.chatId, messageId: null, label: m.label, starting: null }, m)
      return true
    },
    active: (key: string) => states.has(key),
    /** Delete progress messages a previous router process left behind. */
    async cleanup(orphans: Array<{ key: string; chat_id: string; message_id: number }>): Promise<void> {
      for (const o of orphans) {
        await api.remove(o.chat_id, o.message_id).catch(() => {})
        api.untrack?.(o.key, o.message_id)
      }
    },
  }
}

/** Same one-line summary v1 used: tool name plus description, file or command. */
export function toolSummary(toolName: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {}
  const desc = String(i.description ?? i.file_path ?? i.command ?? i.pattern ?? i.query ?? i.url ?? '').slice(0, 60).replace(/\n/g, ' ')
  return desc ? `${toolName}: ${desc}` : toolName
}
