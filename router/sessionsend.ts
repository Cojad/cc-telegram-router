// Messages from outside the router into a conversation's worker
// (docs/operations.md 「從外部送訊息給 worker」): `cctr cli
// session send`. The terminal side parses the arguments and reads stdin
// (router/cli.ts); the router side queues the text like its own notices
// (main.ts notifyConversation), so a sleeping worker is woken and a router
// restart loses nothing. Only from the host's terminal, never from Telegram.

export const SEND_USAGE = '用法: cctr cli session send <chat_id|對話key> [--bot <名稱>] [--from <發送者>] [--wait <秒>] [<文字> | -] (沒給文字或文字是 - 時從 stdin 讀)'
/** Who the message is from when --from is not given. */
export const DEFAULT_FROM = '終端機'
/** How long the terminal waits for the worker to receive it, by default. */
export const DEFAULT_WAIT_S = 60
export const MAX_WAIT_S = 600
/** The text the worker gets is capped: it lands in the model's context. */
export const MAX_TEXT = 64_000

export type SendArgs = {
  ref: string
  bot?: string
  from: string
  waitS: number
  /** null: read it from stdin */
  text: string | null
}

/** A sender name the worker can SendMessage back to: no spaces, quotes or angle brackets, 1~64 characters. */
export function validFrom(s: string): boolean {
  return /^[^\s<>"'`\x00-\x1f\x7f]{1,64}$/.test(s)
}

/** The words after `session send`: the conversation and the options come
 *  first, the first other word starts the text (`--` ends the options). */
export function parseSendArgs(words: string[]): SendArgs | { error: string } {
  let ref: string | undefined, bot: string | undefined, from: string | undefined, wait: string | undefined
  let i = 0
  for (; i < words.length; i++) {
    const w = words[i]!
    if (w === '--bot' || w === '--from' || w === '--wait') {
      const v = words[i + 1]
      if (v === undefined) return { error: `${w} 後面要有值\n${SEND_USAGE}` }
      if (w === '--bot') bot = v
      else if (w === '--from') from = v
      else wait = v
      i++
    } else if (w === '--') { i++; break }
    else if (ref === undefined) ref = w
    else break
  }
  if (!ref) return { error: SEND_USAGE }
  if (from !== undefined && !validFrom(from)) return { error: `--from 要是 1~64 字, 不能有空白, 引號與 < >: ${JSON.stringify(from)}` }
  let waitS = DEFAULT_WAIT_S
  if (wait !== undefined) {
    if (!/^\d+$/.test(wait) || Number(wait) > MAX_WAIT_S) return { error: `--wait 要是 0~${MAX_WAIT_S} 的整數秒數: ${JSON.stringify(wait)}` }
    waitS = Number(wait)
  }
  const rest = words.slice(i)
  const text = !rest.length || (rest.length === 1 && rest[0] === '-') ? null : rest.join(' ')
  return { ref, ...(bot ? { bot } : {}), from: from ?? DEFAULT_FROM, waitS, text }
}

/** What the worker gets: where it came from and where an answer goes. */
export function hostMessage(from: string, text: string): string {
  const back = from === DEFAULT_FROM
    ? '要回覆發送者時沒有對象 (主機終端機沒有 session 可以收 SendMessage), 不用回'
    : `要回覆發送者時, 用 SendMessage 傳給「${from}」這個 session`
  return [
    `<host_message from="${from}" via="cli">`,
    `這則訊息從主機終端機送進來 (cctr cli session send), 不是 Telegram 上的人說的, 發送者是「${from}」. 回應去向由你判斷: 內容要你轉告這個對話時, 才用 reply 發到 Telegram; ${back}. 不要把回應自動貼到對話裡.`,
    '---',
    text,
    '</host_message>',
  ].join('\n')
}

/** Poll until the worker acked the queue row, or the time is up. */
export async function waitDelivered(isAcked: () => boolean, ms: number, step = 250): Promise<{ delivered: boolean; ms: number }> {
  const start = Date.now()
  for (;;) {
    if (isAcked()) return { delivered: true, ms: Date.now() - start }
    if (Date.now() - start >= ms) return { delivered: false, ms: Date.now() - start }
    await new Promise(r => setTimeout(r, step))
  }
}

/** The command's first line on success: the terminal reads its exit code from these. */
export const QUEUED = '已排進佇列'
export const DELIVERED = '已送達'

/** Exit code for the terminal: 0 delivered (or not waited for), 2 queued but not confirmed in time, 1 anything else. */
export function sendExitCode(reply: string): number {
  if (!reply.startsWith(QUEUED)) return 1
  return reply.split('\n').some(l => l.startsWith(DELIVERED) || l.startsWith('沒有等待')) ? 0 : 2
}
