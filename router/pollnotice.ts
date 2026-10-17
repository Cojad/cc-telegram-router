// What the owner is told about a bot's polling (router/poller.ts), and how
// /router status shows it. Times are GMT+8 (HH:MM).

import { gmt8 } from './context'
import type { PollEvent, PollState } from './poller'

const hhmm = (t: number) => gmt8(new Date(t)).slice(11)
const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000))

export function pollNoticeText(name: string, username: string | null, e: PollEvent, _bots = 1): string {
  const who = `bot ${name}${username ? ` (@${username})` : ''}`
  switch (e.kind) {
    case 'down': return `⚠️ ${who} 收不到訊息超過 2 分鐘 (從 ${hhmm(e.since)} 開始): ${e.reason}. router 會持續重試 (間隔逐步拉長到每 5 分鐘), 恢復時會再通知.`
    case 'conflict': return `⚠️ ${who} 的 token 被另一個程式拿去收訊息 (409 衝突, 從 ${hhmm(e.since)} 開始): 同一個 token 同時只能有一個地方收訊息. router 每 60 秒重試; 請停掉另一個程式, 或用 /router bot rotate ${name} <新 token> 換掉 token.`
    case 'unauthorized': return `⛔ ${who} 的 token 失效 (${e.reason}): router 已停止這隻 bot 收訊息, 不再重試. 請到 @BotFather 取得新 token, 在私訊用 /router bot rotate ${name} <新 token>.`
    case 'recovered': return `✅ ${who} 恢復收訊 (從 ${hhmm(e.since)} 中斷到 ${hhmm(e.at)}, 約 ${mins(e.at - e.since)} 分鐘).`
  }
}

/** Which bots to send a polling notice about name through, in order: other
 *  bots that still work first; then the bot itself where it can still send
 *  (a 409 only stops its polling; a recovery means it works again). A
 *  single-bot router thus still hears of a conflict; when nothing can send,
 *  the caller only logs. */
export function noticeVia(name: string, kind: PollEvent['kind'], bots: Array<{ name: string; ok: boolean }>): string[] {
  return [...bots.filter(b => b.name !== name && b.ok).map(b => b.name), ...(kind === 'recovered' || kind === 'conflict' ? [name] : [])]
}

/** One line for /router status. */
export function describePoll(s: PollState): string {
  switch (s.kind) {
    case 'ok': return '收訊中'
    case 'starting': return '啟動中'
    case 'retrying': return `重試中 (從 ${hhmm(s.since)} 開始, ${s.reason})`
    case 'unauthorized': return `token 失效 (${hhmm(s.since)} 起, 請用 /router bot rotate)`
    case 'stopped': return '已停止'
  }
}
