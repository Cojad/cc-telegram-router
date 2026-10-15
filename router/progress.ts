// Live progress message (v1 docs/v1/tg-live-progress-hooks.md, ported to v2).
// Worker hooks only report events over the router socket; the router owns
// the Telegram message: "🤔 思考中…" when a Telegram-triggered turn starts, one
// line per tool call (▶ rewritten in place to ✅), compaction lines, "✅ 完成"
// at Stop, then deleted after a few seconds. Edits are throttled so a burst of
// tool calls does not hit Telegram's per-chat edit limit.

export type ProgressEvent =
  | { event: 'prompt'; telegram: boolean }
  | { event: 'pre' | 'post'; summary: string }
  | { event: 'compact-pre' | 'compact-post'; trigger: string }
  | { event: 'stop' }

export interface ProgressApi {
  send(chatId: string, text: string): Promise<number | null>
  edit(chatId: string, messageId: number, text: string): Promise<void>
  remove(chatId: string, messageId: number): Promise<void>
}

type State = { chatId: string; messageId: number | null; lines: string[]; head: string; timer: ReturnType<typeof setTimeout> | null; dirty: boolean; starting: Promise<void> | null }

const MAX_LINES = 25

export function createProgress(api: ProgressApi, opts: { throttleMs?: number; deleteAfterMs?: number } = {}) {
  const throttle = opts.throttleMs ?? 800
  const deleteAfter = opts.deleteAfterMs ?? 5000
  const states = new Map<string, State>()

  const render = (s: State) => (s.lines.length ? `${s.head}\n\n${s.lines.join('\n')}` : s.head).slice(0, 4000)

  async function flush(s: State): Promise<void> {
    s.timer = null
    if (s.starting) await s.starting
    if (!s.dirty || s.messageId == null) return
    s.dirty = false
    await api.edit(s.chatId, s.messageId, render(s)).catch(() => {})
  }
  function schedule(s: State): void {
    s.dirty = true
    if (!s.timer) s.timer = setTimeout(() => void flush(s), throttle)
  }

  async function finish(key: string, s: State): Promise<void> {
    states.delete(key)
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    if (s.starting) await s.starting
    if (s.messageId == null) return
    s.head = '✅ 完成'
    s.dirty = true
    await flush(s)
    const id = s.messageId
    setTimeout(() => void api.remove(s.chatId, id).catch(() => {}), deleteAfter)
  }

  return {
    async handle(key: string, chatId: string, ev: ProgressEvent): Promise<void> {
      let s = states.get(key)
      if (ev.event === 'prompt') {
        if (s) await finish(key, s)
        if (!ev.telegram) return
        const st: State = { chatId, messageId: null, lines: [], head: '🤔 思考中…', timer: null, dirty: false, starting: null }
        st.starting = api.send(chatId, st.head).then(id => { st.messageId = id; st.starting = null })
        states.set(key, st)
        return
      }
      if (!s) return // not a Telegram-triggered turn
      if (ev.event === 'stop') return finish(key, s)
      if (ev.event === 'pre' || ev.event === 'post') {
        const pre = `▶ ${ev.summary}`, post = `✅ ${ev.summary}`
        if (ev.event === 'post' && s.lines.at(-1) === pre) s.lines[s.lines.length - 1] = post
        else s.lines.push(ev.event === 'post' ? post : pre)
      } else {
        const pre = `🗜 壓縮 context 中 (trigger=${ev.trigger})…`
        if (ev.event === 'compact-post' && s.lines.at(-1) === pre) s.lines[s.lines.length - 1] = '✅ 壓縮完成, 繼續處理'
        else s.lines.push(ev.event === 'compact-post' ? '✅ 壓縮完成, 繼續處理' : pre)
      }
      s.lines = s.lines.slice(-MAX_LINES)
      schedule(s)
    },
    active: (key: string) => states.has(key),
  }
}

/** Same one-line summary v1 used: tool name plus description, file or command. */
export function toolSummary(toolName: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {}
  const desc = String(i.description ?? i.file_path ?? i.command ?? i.pattern ?? i.query ?? i.url ?? '').slice(0, 60).replace(/\n/g, ' ')
  return desc ? `${toolName}: ${desc}` : toolName
}
