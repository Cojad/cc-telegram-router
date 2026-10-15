// Cross-conversation send grants (plan 03 Grants, 00 跨對話傳訊). A worker
// refused by reply asks with request_send_grant:
//   owner:  the request goes to the approvals place (approvals group topic,
//           or the owner's DM); owner or admin decides.
//   target: the target conversation is asked to accept, and the same request
//           goes to the approvals place too; whoever presses first decides
//           (anyone in the target chat, or owner/admin).
// Approval is permanent (an overrides send row). Every copy of the request
// gets the outcome written under it, and the requesting worker hears it as
// a <router_status> message.

import type { Conversation, RouterDb } from './db'
import { postApproval, settleApproval, mayDecide, type ApprovalDeps } from './approvals'

export interface GrantDeps {
  db: RouterDb
  approvals: ApprovalDeps
  /** Tell the requesting worker (queued like a message, wakes it if needed). */
  notify(conv: Conversation, text: string): void
  label(chatOrUid: string): string
}

export async function requestGrant(deps: GrantDeps, from: Conversation, target: string, mode: 'owner' | 'target', reason: string): Promise<string> {
  const { db } = deps
  if (db.listOverrides(from.key).some(o => o.kind === 'send' && o.value === target)) return `已經可以送往 ${target}, 直接送出即可`
  if (!deps.approvals.owners[0]) return '沒有設定 owner, 無法申請'
  const id = db.addGrant({ from_conv: from.key, target, mode, reason })
  const who = `${from.key}${from.title ? ` (${from.title})` : ''}`
  const ownerText = `🔐 跨對話傳訊申請 #${id}\n${who} 想送訊息到 ${deps.label(target)}\n理由: ${reason}\n${mode === 'target' ? '(也已在目標對話詢問, 先按的人決定)\n' : ''}允許後永久有效 (可用 /router perm ${from.chat_id} send rm ${target} 撤銷)`
  const extra = mode === 'target' ? [{ place: { chat_id: target }, text: `📨 ${who} 想傳訊息到這個對話 (#${id})\n理由: ${reason}\n要接受嗎?` }] : []
  const reached = await postApproval(deps.approvals, from.bot, 'grant', id, ownerText, extra)
  if (!reached.length) return '審核頻道與目標對話都送不到, 申請沒有送出'
  if (mode === 'owner') return `已向 owner 申請 (#${id}), 決定後會通知你`
  const inTarget = reached.some(p => p.chat_id === target)
  return inTarget ? `已在目標對話詢問, 也同步給 owner (#${id}), 決定後會通知你` : `無法在 ${target} 詢問 (bot 可能不在那個對話), 已改由 owner 決定 (#${id})`
}

/** A button press "grant:<id>:approve|deny" from uid in chat. Returns the answer to show, or null if not ours. */
export async function decideGrant(deps: GrantDeps, data: string, uid: string, chatId: string): Promise<string | null> {
  const m = /^grant:(\d+):(approve|deny)$/.exec(data)
  if (!m) return null
  const g = deps.db.getGrant(Number(m[1]))
  if (!g) return '找不到這個申請'
  if (g.status !== 'pending') return `這個申請已經${g.status === 'approved' ? '允許' : '拒絕'}了`
  const inTarget = g.mode === 'target' && chatId === g.target
  if (!inTarget && !mayDecide(deps.approvals, uid)) return '你不能決定這個申請'
  const status = m[2] === 'approve' ? 'approved' : 'denied'
  if (!deps.db.decideGrant(g.id, status, uid)) return '這個申請已經處理過了'
  const from = deps.db.getConversation(g.from_conv)
  if (status === 'approved') deps.db.addOverride({ conv: g.from_conv, kind: 'send', value: g.target })
  const word = status === 'approved' ? '已允許' : '已拒絕'
  await settleApproval(deps.approvals, 'grant', g.id, `${word} (${deps.label(uid)})`)
  if (from) deps.notify(from, `<router_status>\n跨對話傳訊申請 #${g.id} ${word} (${deps.label(uid)}): 送往 ${deps.label(g.target)}${status === 'approved' ? ', 現在可以送出了' : ''}.\n</router_status>`)
  return word
}
