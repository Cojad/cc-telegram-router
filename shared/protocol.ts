// Router <-> plugin wire protocol over the unix socket (plan 04 「router 協定」).
// One JSON object per line. Requests carry an id and get a result with the
// same id; router pushes (deliver) carry none.

// Where the socket is: shared/locate.ts (the router may be installed anywhere).

/** What the plugin turns into a notifications/claude/channel notification. */
export type ChannelParams = { content: string; meta: Record<string, string> }

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  /** Set by the plugin's client when the call never got an answer from the
   *  router (offline, connection lost mid-call, timeout). Not on the wire. */
  offline?: 'not-sent' | 'maybe-sent'
}

export type PluginToRouter =
  | { t: 'hello'; project_dir: string; session_id?: string; pid: number }
  | { t: 'ack'; qid: number }
  | { t: 'call'; id: number; tool: string; args: Record<string, unknown> }
  | { t: 'bye' }
  /** Worker hook event; answered with a result whose text is a JSON HookDecision.
   *  deadline (epoch ms): the hook's first try + its retry window (shared/retry.ts),
   *  the router waits no longer; retry: this is not the first try. */
  | { t: 'hook'; id: number; project_dir: string; ev: Record<string, unknown>; deadline?: number; retry?: { tries: number; waited_ms: number } }
  /** Worker hook: a live-progress event (router/progress.ts). No answer (older hooks). */
  | { t: 'progress'; project_dir: string; ev: Record<string, unknown> }
  /** Terminal CLI (owner): run a /router command. Answered with result.
   *  body: text kept as it is (session send: newlines and spaces), beside the command line. */
  | { t: 'cli'; id: number; text: string; body?: string }

export type Mode = 'worker' | 'terminal'

export type RouterToPlugin =
  | { t: 'welcome'; mode: Mode; conv?: string; chat_id?: string; role: string }
  | { t: 'reject'; reason: string }
  | { t: 'deliver'; qid: number; params: ChannelParams }
  | { t: 'result'; id: number; result: ToolResult }

/** Split a growing buffer into complete lines; returns [lines, rest]. */
export function splitLines(buf: string): [string[], string] {
  const parts = buf.split('\n')
  const rest = parts.pop() ?? ''
  return [parts.filter(l => l.trim() !== ''), rest]
}

export function encode(msg: PluginToRouter | RouterToPlugin): string {
  return JSON.stringify(msg) + '\n'
}
