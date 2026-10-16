// Cross-conversation send grants (plan 03 Grants, 00 跨對話傳訊). A worker
// refused by reply asks with request_send_grant:
//   owner:  the request goes to the approvals place (approvals group topic,
//           or the owner's DM); owner or admin decides.
//   target: the target conversation is asked to accept, and the same request
//           goes to the approvals place too; whoever presses first decides
//           (anyone in the target chat, or owner/admin).
// 允許一次 adds that target to the conversation's list (an overrides send
// row); 永久允許 (owner/admin only, not offered in the target chat) lets the
// conversation send to any chat the bot is in (send *). Every copy of the
// request gets the outcome written under it, and the requesting worker hears
// it as a <router_status> message. When the target of a target request is
// the approvals place itself (the approvals group, or the owner's DM), it is
// an owner request: one copy, owner or admin decides, and the request and
// the worker are told so.

import type { Conversation, RouterDb } from './db'
import { postApproval, settleApproval, mayDecide, parseChoice, approvalPlace, CHOICE_WORD, type ApprovalDeps, type About } from './approvals'
import type { Authz } from './authz'

/** The send overrides allow chat_id: listed, or send * and the bot is in it. */
export function sendGranted(sends: string[], chatId: string, allowlisted: (id: string) => boolean): boolean {
  return sends.includes(chatId) || (sends.includes('*') && allowlisted(chatId))
}

export interface GrantDeps {
  db: RouterDb
  approvals: ApprovalDeps
  /** Tell the requesting worker (queued like a message, wakes it if needed). */
  notify(conv: Conversation, text: string, about?: About): void
  label(chatOrUid: string): string
  /** Remembers what an approval granted (revoke, 執行授權). */
  authz?: Authz
}

export async function requestGrant(deps: GrantDeps, from: Conversation, target: string, mode: 'owner' | 'target', reason: string): Promise<string> {
  const { db } = deps
  const sends = db.listOverrides(from.key).filter(o => o.kind === 'send').map(o => o.value)
  if (sends.includes(target) || sends.includes('*')) return `已經可以送往 ${target}, 直接送出即可`
  if (!deps.approvals.owners[0]) return '沒有設定 owner, 無法申請'
  // the target is where owner and admin decide anyway: one copy, theirs to decide
  const place = approvalPlace(db, deps.approvals.owners, from.bot)
  const atApprovals = mode === 'target' && place?.chat_id === target
  const placeName = db.getBotSetup(from.bot)?.approvals_chat ? '審核群組' : 'owner 私訊'
  if (atApprovals) mode = 'owner'
  const id = db.addGrant({ from_conv: from.key, target, mode, reason })
  deps.approvals.noteRequest?.('grant', id, from)
  const who = `${from.key}${from.title ? ` (${from.title})` : ''}`
  const ownerText = [
    `🔐 跨對話傳訊申請 #${id}`,
    `${who} 想送訊息到 ${deps.label(target)}`,
    `理由: ${reason}`,
    ...(mode === 'target' ? ['(也已在目標對話詢問, 先按的人決定)'] : []),
    ...(atApprovals ? [`目標對話就是這裡 (${placeName}), 只有這一份申請, 由 owner 或 admin 決定.`] : []),
    `✅ 允許一次: 把 ${target} 加進這個對話的傳送白名單 (之後送往這個對話不用再問).`,
    `♾️ 永久允許的範圍: ${from.key} 之後可以送訊息到 bot 所在的任何對話, 不用再申請 (權限覆寫 send *).`,
    `撤銷: /router perm ${from.chat_id} send rm ${target} 或 send rm *`,
  ].join('\n')
  const extra = mode === 'target' ? [{ place: { chat_id: target }, text: `📨 ${who} 想傳訊息到這個對話 (#${id})\n理由: ${reason}\n✅ 允許一次: 之後 ${from.key} 都可以傳訊息到這個對話.\n要接受嗎?` }] : []
  const reached = await postApproval(deps.approvals, from.bot, 'grant', id, ownerText, extra)
  if (!reached.length) return '審核頻道與目標對話都送不到, 申請沒有送出'
  if (atApprovals) return `目標對話就是審核處 (${placeName}), 只送了一份申請, 由 owner 或 admin 決定 (#${id}), 決定後會通知你`
  if (mode === 'owner') return `已向 owner 申請 (#${id}), 決定後會通知你`
  const inTarget = reached.some(p => p.chat_id === target)
  return inTarget ? `已在目標對話詢問, 也同步給 owner (#${id}), 決定後會通知你` : `無法在 ${target} 詢問 (bot 可能不在那個對話), 已改由 owner 決定 (#${id})`
}

/** A button press "grant:<id>:once|always|deny" from uid in chat. Returns the answer to show, or null if not ours. */
export async function decideGrant(deps: GrantDeps, data: string, uid: string, chatId: string): Promise<string | null> {
  const p = parseChoice('grant', data)
  if (!p) return null
  const g = deps.db.getGrant(p.ref)
  if (!g) return '找不到這個申請'
  if (g.status !== 'pending') return `這個申請已經${g.status === 'approved' ? '允許' : '拒絕'}了`
  const inTarget = g.mode === 'target' && chatId === g.target
  const decider = mayDecide(deps.approvals, uid)
  if (!inTarget && !decider) return '你不能決定這個申請'
  if (p.choice === 'always' && !decider) return '永久允許只能由 owner 或 admin 決定'
  const status = p.choice === 'deny' ? 'denied' : 'approved'
  if (!deps.db.decideGrant(g.id, status, uid)) return '這個申請已經處理過了'
  const from = deps.db.getConversation(g.from_conv)
  const value = p.choice === 'always' ? '*' : g.target
  if (p.choice !== 'deny') deps.db.addOverride({ conv: g.from_conv, kind: 'send', value })
  const word = CHOICE_WORD[p.choice]
  const outcome = `${word} (${deps.label(uid)})`
  if (p.choice !== 'deny' && from) deps.authz?.record('grant', g.id, from, p.choice, [{ kind: 'send', value }], outcome)
  await settleApproval(deps.approvals, 'grant', g.id, outcome, p.choice !== 'deny')
  const scope = p.choice === 'always' ? ', 之後送往 bot 所在的任何對話都不用再申請' : p.choice === 'once' ? `, 現在可以送往 ${deps.label(g.target)}` : ''
  if (from) deps.notify(from, `<router_status>\n跨對話傳訊申請 #${g.id} ${word} (${deps.label(uid)})${scope}.\n</router_status>`, { kind: 'grant', ref: g.id })
  return word
}
