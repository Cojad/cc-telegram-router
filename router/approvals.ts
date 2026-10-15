// Where the router asks for decisions and posts important notices (plan 03
// 審核頻道). Each bot may have a forum group set up by its owner with two
// topics, 重要通知 and 權限審核; without one (or when the owner skipped it)
// everything goes to the owner's DM. A request can be posted to several
// chats (e.g. the target conversation of a send grant as well); every copy
// is recorded so the outcome is written onto all of them.

import type { RouterDb } from './db'

export type Place = { chat_id: string; thread_id?: number }
export type Button = { text: string; data: string }

/** The three answers to a request (柯姊 2026-10-16): once = this request only;
 *  always = the whole kind of action, with its scope spelled out in the request;
 *  deny. "approve" is the old two-button data, read as once. */
export type Choice = 'once' | 'always' | 'deny'

export function buttons(kind: string, ref: number, always: boolean): Button[] {
  return [
    { text: '✅ 允許一次', data: `${kind}:${ref}:once` },
    ...(always ? [{ text: '♾️ 永久允許', data: `${kind}:${ref}:always` }] : []),
    { text: '❌ 拒絕', data: `${kind}:${ref}:deny` },
  ]
}

export function parseChoice(kind: string, data: string): { ref: number; choice: Choice } | null {
  const m = new RegExp(`^${kind}:(\\d+):(once|always|deny|approve)$`).exec(data)
  return m ? { ref: Number(m[1]), choice: m[2] === 'approve' ? 'once' : m[2] as Choice } : null
}

export const CHOICE_WORD: Record<Choice, string> = { once: '✅ 已允許一次', always: '♾️ 已永久允許', deny: '❌ 已拒絕' }

export interface ApprovalDeps {
  db: RouterDb
  owners: string[]
  isAdmin(uid: string): boolean
  /** Send with one row of inline buttons (none for a notice); the message id, or null when it failed. */
  send(bot: string, to: Place, text: string, buttons: Button[]): Promise<number | null>
  edit(bot: string, chat_id: string, message_id: number, text: string): Promise<void>
}

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

/** Write the outcome under every copy of the request (buttons go away). */
export async function settleApproval(deps: ApprovalDeps, kind: string, ref: number, outcome: string): Promise<void> {
  for (const m of deps.db.approvalMsgs(kind, ref)) {
    await deps.edit(m.bot, m.chat_id, m.message_id, `${m.text}\n\n${outcome}`).catch(() => {})
  }
}

export async function postNotice(deps: ApprovalDeps, bot: string, text: string): Promise<boolean> {
  const place = noticePlace(deps.db, deps.owners, bot)
  return !!place && (await deps.send(bot, place, text, [])) != null
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
