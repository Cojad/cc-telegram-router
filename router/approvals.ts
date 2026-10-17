// Where the router asks for decisions and posts important notices (plan 03
// 審核頻道). Each bot may have a forum group set up by its owner with two
// topics, 重要通知 and 權限審核; without one (or when the owner skipped it)
// everything goes to the owner's DM. A request can be posted to several
// chats (e.g. the target conversation of a send grant as well); every copy
// is recorded so the outcome is written onto all of them.

import type { Conversation, RouterDb } from './db'

export type Place = { chat_id: string; thread_id?: number }
export type Button = { text: string; data: string }

/** The three answers to a request (柯姊 2026-10-16): once = this request only;
 *  always = the whole kind of action, with its scope spelled out in the request;
 *  deny. "approve" is the old two-button data, read as once. */
export type Choice = 'once' | 'always' | 'deny'

/** The once button's words where 允許一次 would mislead: a send grant lets that conversation send here from then on (柯姊 2026-10-17). */
export const ONCE_LABEL: Record<string, string> = { grant: '允許這個對話' }

export function buttons(kind: string, ref: number, always: boolean): Button[] {
  return [
    { text: `✅ ${ONCE_LABEL[kind] ?? '允許一次'}`, data: `${kind}:${ref}:once` },
    ...(always ? [{ text: '♾️ 永久允許', data: `${kind}:${ref}:always` }] : []),
    { text: '❌ 拒絕', data: `${kind}:${ref}:deny` },
  ]
}

export function parseChoice(kind: string, data: string): { ref: number; choice: Choice } | null {
  const m = new RegExp(`^${kind}:(\\d+):(once|always|deny|approve)$`).exec(data)
  return m ? { ref: Number(m[1]), choice: m[2] === 'approve' ? 'once' : m[2] as Choice } : null
}

export const revokeButton = (kind: string, ref: number): Button => ({ text: '🚫 撤銷', data: `${kind}:${ref}:revoke` })

export const CHOICE_WORD: Record<Choice, string> = { once: '✅ 已允許一次', always: '♾️ 已永久允許', deny: '❌ 已拒絕' }
/** CHOICE_WORD with the kind's own once words (ONCE_LABEL). */
export const choiceWord = (kind: string, c: Choice) => c === 'once' && ONCE_LABEL[kind] ? `✅ 已${ONCE_LABEL[kind]}` : CHOICE_WORD[c]

export interface ApprovalDeps {
  db: RouterDb
  owners: string[]
  isAdmin(uid: string): boolean
  /** Send with one row of inline buttons (none for a notice); the message id, or null when it failed. */
  send(bot: string, to: Place, text: string, buttons: Button[], opts?: { html?: boolean }): Promise<number | null>
  /** Replace a message's text; buttons replace its keyboard (none = removed). */
  edit(bot: string, chat_id: string, message_id: number, text: string, buttons?: Button[]): Promise<void>
  /** A request kind#ref was just made by conv (to find the message that led to it later). */
  noteRequest?(kind: string, ref: number, conv: Conversation): void
}

/** ApprovalDeps.noteRequest: tie request kind#ref to the Telegram message the
 *  conversation's current turn answers (its result's progress replies to it).
 *  A turn typed in the worker's terminal answers none: nothing is tied, not
 *  even the last Telegram message (elevation.ts knows which turn it is). */
export function requestOriginNoter(o: { db: RouterDb; currentMsg(conv: string): number | undefined; terminalTurn(conv: string): boolean }): (kind: string, ref: number, conv: Conversation) => void {
  return (kind, ref, conv) => {
    if (o.terminalTurn(conv.key)) return
    const mid = o.currentMsg(conv.key)
    if (mid != null) o.db.setRequestOrigin(kind, ref, conv.key, mid)
  }
}

/** What a router notice to a worker is about, when it answers a request. */
export type About = { kind: string; ref: number }

export function approvalPlace(db: RouterDb, owners: string[], bot: string): Place | null {
  const s = db.getBotSetup(bot)
  if (s?.approvals_chat) return { chat_id: s.approvals_chat, ...(s.approvals_topic ? { thread_id: s.approvals_topic } : {}) }
  return owners[0] ? { chat_id: owners[0] } : null
}

export function noticePlace(db: RouterDb, owners: string[], bot: string): Place | null {
  const s = db.getBotSetup(bot)
  if (s?.approvals_chat) return { chat_id: s.approvals_chat, ...(s.notices_topic ? { thread_id: s.notices_topic } : {}) }
  return owners[0] ? { chat_id: owners[0] } : null
}

/** Owner and admin decide anything posted to the approvals place. */
export function mayDecide(deps: Pick<ApprovalDeps, 'owners' | 'isAdmin'>, uid: string): boolean {
  return deps.owners.includes(uid) || deps.isAdmin(uid)
}

/** Post a request with buttons "<kind>:<ref>:once|always|deny" to the
 *  approvals place plus any extra places (each with its own text, and
 *  without 永久允許 unless it says so). Resolves the places it reached. */
export async function postApproval(deps: ApprovalDeps, bot: string, kind: string, ref: number, text: string, extra: Array<{ place: Place; text: string; always?: boolean }> = [], always = true): Promise<Place[]> {
  const main = approvalPlace(deps.db, deps.owners, bot)
  const targets = [...(main ? [{ place: main, text, always }] : []), ...extra.filter(e => e.place.chat_id !== main?.chat_id)]
  const reached: Place[] = []
  for (const t of targets) {
    const id = await deps.send(bot, t.place, t.text, buttons(kind, ref, !!t.always))
    if (id == null) continue
    deps.db.addApprovalMsg({ kind, ref, bot, chat_id: t.place.chat_id, message_id: id, text: t.text })
    reached.push(t.place)
  }
  return reached
}

/** Write the outcome under every copy of the request. revocable: the copy at
 *  the approvals place (where owner/admin decide) keeps a 🚫 撤銷 button. */
export async function settleApproval(deps: ApprovalDeps, kind: string, ref: number, outcome: string, revocable = false): Promise<void> {
  for (const m of deps.db.approvalMsgs(kind, ref)) {
    const atApprovals = m.chat_id === approvalPlace(deps.db, deps.owners, m.bot)?.chat_id
    await deps.edit(m.bot, m.chat_id, m.message_id, `${m.text}\n\n${outcome}`, revocable && atApprovals ? [revokeButton(kind, ref)] : []).catch(() => {})
  }
}

/** Each use of an approved authorization (執行授權) goes to its own topic of the approvals group; without a group it stays in router.db. */
export function usePlace(db: RouterDb, bot: string): Place | null {
  const s = db.getBotSetup(bot)
  return s?.approvals_chat && s.authuse_topic ? { chat_id: s.approvals_chat, thread_id: s.authuse_topic } : null
}

export async function postNotice(deps: ApprovalDeps, bot: string, text: string, opts?: { html?: boolean }): Promise<boolean> {
  const place = noticePlace(deps.db, deps.owners, bot)
  return !!place && (await deps.send(bot, place, text, [], opts)) != null
}

/** The elevation log (提權紀錄) lives only in an approvals group; without one it stays in router.db. */
export function logPlace(db: RouterDb, bot: string): Place | null {
  const s = db.getBotSetup(bot)
  return s?.approvals_chat && s.elevlog_topic ? { chat_id: s.approvals_chat, thread_id: s.elevlog_topic } : null
}

/** https://t.me/c/<id>/<msg> for supergroups and channels; null for DMs and basic groups. */
export function messageLink(chatId: string, messageId: number): string | null {
  return chatId.startsWith('-100') ? `https://t.me/c/${chatId.slice(4)}/${messageId}` : null
}

/** Secret detections, raw requests and handles (🔑 密鑰偵測, plan 10e): the
 *  approvals group's topic for them (重要通知 until it exists), else the owner's DM. */
export function secretPlace(db: RouterDb, owners: string[], bot: string): Place | null {
  const s = db.getBotSetup(bot)
  if (s?.approvals_chat) {
    const thread = s.secret_topic ?? s.notices_topic
    return { chat_id: s.approvals_chat, ...(thread ? { thread_id: thread } : {}) }
  }
  return owners[0] ? { chat_id: owners[0] } : null
}
