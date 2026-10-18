// DM pairing with buttons (docs/permissions.md 「私訊配對」, docs/operations.md
// 審核群組的「🤝 配對申請」話題). In pairing mode a stranger who DMs the bot
// gets a code (router/telegram/policy.ts gate()). Besides the code the router
// posts a request to the approvals group's 配對申請 topic (the owner's DM
// without a group): who, @username, uid, the start of their first message
// (untrusted text), the code and when it expires, with ✅ 同意 / ❌ 拒絕.
// Only owner and admin may press. A button and /router access pair|deny settle
// the same request through settlePairing: the check and the access.json write
// happen in one synchronous stretch, so the first wins and the other is told
// it was already handled. Codes that expire are swept every minute. Every
// settlement is written to the request (pairing_requests), to every copy of
// the message, to router_log (conv router:pairing) and to the journal.

import type { RouterDb, PairingRequest } from './db'
import type { Access } from './telegram/policy'
import { mayDecide, settleApproval, type ApprovalDeps, type Button, type Place } from './approvals'
import { iso8 } from '../shared/time'

export const PAIRING_TOPIC = '🤝 配對申請'
export const PAIRING_TOPIC_INTRO = '配對申請: 有人私訊 bot 拿到配對碼時貼在這裡 (對方名稱, @username, uid, 第一則訊息的開頭, 配對碼, 到期時間). owner 與 admin 可以按 ✅ 同意 或 ❌ 拒絕, 等同 /router access pair 或 deny; 處理結果, 處理的人與過期都會寫回原訊息.'
/** router_log's conv for pairing settlements (like router:refresh for the daily refresh). */
export const PAIRING_CONV = 'router:pairing'
export const FIRST_TEXT_MAX = 200
export const PAIRED_TEXT = '配對完成, 可以開始對話了.'

/** The approvals group's 配對申請 topic (重要通知 until it exists), else the owner's DM. */
export function pairingPlace(db: RouterDb, owners: string[], bot: string): Place | null {
  const s = db.getBotSetup(bot)
  if (s?.approvals_chat) {
    const thread = s.pairing_topic ?? s.notices_topic
    return { chat_id: s.approvals_chat, ...(thread ? { thread_id: thread } : {}) }
  }
  return owners[0] ? { chat_id: owners[0] } : null
}

/** A stranger's text shown to owner and admin: one line, no control or
 *  direction characters, at most FIRST_TEXT_MAX characters. */
export function untrustedSnippet(text: string | undefined | null): string {
  if (!text) return ''
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > FIRST_TEXT_MAX ? `${chars.slice(0, FIRST_TEXT_MAX).join('')}…` : flat
}

const hhmm = (ms: number) => iso8(ms, ' ').slice(0, 16)

export function requestText(r: Pick<PairingRequest, 'id' | 'bot' | 'code' | 'uid' | 'name' | 'username' | 'first_text' | 'expires_at'>): string {
  return [
    `🤝 配對申請 #${r.id} (bot ${r.bot})`,
    `對方: ${r.name}${r.username ? ` @${r.username}` : ' (沒有 username)'}`,
    `uid: ${r.uid}`,
    `配對碼: ${r.code}, 到期 ${hhmm(r.expires_at)} (GMT+8)`,
    r.first_text ? `第一則訊息的開頭 (對方傳來的內容, 未經驗證, 只供參考): 「${r.first_text}」` : '第一則訊息沒有文字',
    `同意等同 /router access pair ${r.code}, 拒絕等同 /router access deny ${r.code}.`,
  ].join('\n')
}

export const pairButtons = (id: number): Button[] => [
  { text: '✅ 同意', data: `pair:${id}:approve` },
  { text: '❌ 拒絕', data: `pair:${id}:deny` },
]

export interface PairingDeps {
  db: RouterDb
  loadAccess(): Access
  saveAccess(a: Access): void
  /** A plain message from a bot (the greeting after approval). */
  sendTo(bot: string, chatId: string, text: string): Promise<void>
  /** Posting and settling the request messages; without it nothing is posted or edited. */
  approvals?: ApprovalDeps
  /** "name uid" of the one who decided. */
  label?(uid: string): string
  log?(msg: string): void
  now?(): number
}

export interface NewCode { bot: string; code: string; uid: string; chatId: string; name: string; username?: string; text?: string; expiresAt: number }

/** Record a new code and post the request with buttons. The request id. */
export async function postPairingRequest(deps: PairingDeps, n: NewCode): Promise<number> {
  const r = { bot: n.bot, code: n.code, uid: n.uid, chat_id: n.chatId, name: n.name, username: n.username ?? null, first_text: untrustedSnippet(n.text) || null, expires_at: n.expiresAt }
  const id = deps.db.addPairingRequest(r)
  deps.log?.(`pairing #${id} ${n.bot}: code ${n.code} for ${n.uid} (expires ${hhmm(n.expiresAt)} GMT+8)`)
  const a = deps.approvals
  const place = a ? pairingPlace(a.db, a.owners, n.bot) : null
  if (!a || !place) return id
  const text = requestText({ id, ...r })
  const mid = await a.send(n.bot, place, text, pairButtons(id))
  if (mid != null) a.db.addApprovalMsg({ kind: 'pair', ref: id, bot: n.bot, chat_id: place.chat_id, message_id: mid, text })
  else deps.log?.(`pairing #${id}: the request could not be posted`)
  return id
}

type Verdict = 'approve' | 'deny'
type Via = 'button' | 'command' | 'expiry'
const VIA_WORD: Record<Via, string> = { button: '按鈕', command: '指令', expiry: '過期' }

function who(deps: PairingDeps, uid: string): string {
  const l = deps.label?.(uid)
  return l && l !== uid ? `${l} ${uid}` : uid
}

/** What became of a settled request, for its message and for "already handled". */
export function outcomeWord(deps: PairingDeps, r: Pick<PairingRequest, 'status' | 'decided_by' | 'decided_via' | 'decided_at'> & { expires_at?: number }): string {
  const at = r.decided_at ? hhmm(Date.parse(r.decided_at)) : ''
  if (r.status === 'expired') return `⌛ 已過期, 期限內沒有人處理${r.expires_at ? ` (到期 ${hhmm(r.expires_at)})` : ''}`
  const word = r.status === 'approved' ? '✅ 已同意' : r.status === 'denied' ? '❌ 已拒絕' : '⏳ 等待中'
  return r.decided_by ? `${word} (${who(deps, r.decided_by)}, 經由${VIA_WORD[r.decided_via ?? 'command']}${at ? `, ${at}` : ''})` : word
}

/** router_log (conv router:pairing, read by /router log) and the journal. */
function record(deps: PairingDeps, line: string, journal: string): void {
  deps.db.addLog(PAIRING_CONV, line)
  deps.log?.(journal)
}

/** Approve or deny a code: the one path for buttons and /router access pair|deny.
 *  reqId: the request a button belongs to (its code must still be the same person's). */
export async function settlePairing(deps: PairingDeps, o: { bot: string; code: string; reqId?: number; verdict: Verdict; by: string; via: Via }): Promise<{ ok: boolean; text: string }> {
  const now = deps.now?.() ?? Date.now()
  // --- synchronous: decide and write before anything else can run ---
  const req = o.reqId != null ? deps.db.getPairingRequest(o.reqId) : deps.db.pairingRequestByCode(o.code)
  if (req && req.status !== 'pending') {
    if (deps.approvals) await settleApproval(deps.approvals, 'pair', req.id, outcomeWord(deps, req))
    return { ok: false, text: `配對碼 ${req.code} 已處理: ${outcomeWord(deps, req)}` }
  }
  const a = deps.loadAccess()
  const p = a.pending[o.code]
  const valid = !!p && p.expiresAt >= now && (!req || p.senderId === req.uid)
  if (!valid) {
    if (!req) return { ok: false, text: `找不到有效的配對碼 ${o.code}` }
    if (p && p.expiresAt < now) { delete a.pending[o.code]; deps.saveAccess(a) }
    deps.db.settlePairingRequest(req.id, 'expired', null, 'expiry')
    record(deps, `配對碼 ${req.code} 已失效 (${req.name} ${req.uid}), ${who(deps, o.by)} 經由${VIA_WORD[o.via]}處理時發現`, `pairing #${req.id} ${req.code}: expired (found by ${o.by} via ${o.via}, uid ${req.uid})`)
    const done = deps.db.getPairingRequest(req.id)!
    if (deps.approvals) await settleApproval(deps.approvals, 'pair', req.id, outcomeWord(deps, done))
    return { ok: false, text: `配對碼 ${req.code} 已過期或失效, 沒有變更` }
  }
  delete a.pending[o.code]
  if (o.verdict === 'approve' && !a.allowFrom.includes(p!.senderId)) a.allowFrom.push(p!.senderId)
  deps.saveAccess(a)
  const status = o.verdict === 'approve' ? 'approved' : 'denied'
  if (req) deps.db.settlePairingRequest(req.id, status, o.by, o.via)
  const target = req ? `${req.name} ${req.uid}` : p!.senderId
  record(deps, `${o.verdict === 'approve' ? '同意' : '拒絕'}配對 ${target}, 由 ${who(deps, o.by)} 經由${VIA_WORD[o.via]} (配對碼 ${o.code})`,
    `pairing${req ? ` #${req.id}` : ''} ${o.code}: ${status} by ${o.by} via ${o.via} (uid ${p!.senderId})`)
  // --- then the messages ---
  if (o.verdict === 'approve') await deps.sendTo(req?.bot ?? o.bot, p!.chatId, PAIRED_TEXT).catch(e => deps.log?.(`pairing ${o.code}: greeting failed: ${e}`))
  if (req && deps.approvals) await settleApproval(deps.approvals, 'pair', req.id, outcomeWord(deps, deps.db.getPairingRequest(req.id)!))
  return { ok: true, text: o.verdict === 'approve' ? `已核可 ${p!.senderId}` : `已拒絕配對碼 ${o.code}` }
}

/** A press of ✅ 同意 / ❌ 拒絕: "pair:<id>:approve|deny". The answer for the presser. */
export async function decidePairButton(deps: PairingDeps & { approvals: ApprovalDeps }, data: string, uid: string): Promise<string> {
  const m = /^pair:(\d+):(approve|deny)$/.exec(data)
  if (!m) return '看不懂這個按鈕'
  if (!mayDecide(deps.approvals, uid)) return '你沒有權限: 只有 owner 與 admin 能處理配對申請'
  const req = deps.db.getPairingRequest(Number(m[1]))
  if (!req) return '找不到這筆配對申請'
  const r = await settlePairing(deps, { bot: req.bot, code: req.code, reqId: req.id, verdict: m[2] as Verdict, by: uid, via: 'button' })
  return r.text
}

/** Codes that expired with nobody deciding: mark them, write the outcome on their messages. How many. */
export async function expirePairings(deps: PairingDeps): Promise<number> {
  const now = deps.now?.() ?? Date.now()
  const due = deps.db.expiredPairingRequests(now)
  if (!due.length) return 0
  const a = deps.loadAccess()
  let changed = false
  for (const r of due) {
    const p = a.pending[r.code]
    if (p && p.senderId === r.uid && p.expiresAt < now) { delete a.pending[r.code]; changed = true }
  }
  if (changed) deps.saveAccess(a)
  let n = 0
  for (const r of due) {
    if (!deps.db.settlePairingRequest(r.id, 'expired', null, 'expiry')) continue
    n++
    record(deps, `配對碼 ${r.code} 過期, 沒有人處理 (${r.name} ${r.uid})`, `pairing #${r.id} ${r.code}: expired (uid ${r.uid})`)
    if (deps.approvals) await settleApproval(deps.approvals, 'pair', r.id, outcomeWord(deps, deps.db.getPairingRequest(r.id)!))
  }
  return n
}
