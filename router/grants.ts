// Cross-conversation send grants (plan 03 Grants, 00 跨對話傳訊). A worker
// refused by reply asks with request_send_grant: either the owner gets a DM
// with approve/deny buttons (approval is permanent: an overrides send row),
// or the target conversation is asked to accept. Either way the requesting
// worker hears the outcome as a <router_status> message.

import type { Conversation, RouterDb } from './db'

export type Button = { text: string; data: string }

export interface GrantDeps {
  db: RouterDb
  owners: string[]
  /** Send a message with one row of inline buttons; resolve true when sent. */
  ask(chatId: string, text: string, buttons: Button[]): Promise<boolean>
  /** Tell the requesting worker (queued like a message, wakes it if needed). */
  notify(conv: Conversation, text: string): void
  label(chatOrUid: string): string
  isAdmin(uid: string): boolean
}

export async function requestGrant(deps: GrantDeps, from: Conversation, target: string, mode: 'owner' | 'target', reason: string): Promise<string> {
  const { db } = deps
  if (db.listOverrides(from.key).some(o => o.kind === 'send' && o.value === target)) return `已經可以送往 ${target}, 直接送出即可`
  const id = db.addGrant({ from_conv: from.key, target, mode, reason })
  const who = `${from.key}${from.title ? ` (${from.title})` : ''}`
  const buttons = [{ text: '✅ 允許', data: `grant:${id}:approve` }, { text: '❌ 拒絕', data: `grant:${id}:deny` }]
  if (mode === 'owner') {
    const owner = deps.owners[0]
    if (!owner) return '沒有設定 owner, 無法申請'
    const ok = await deps.ask(owner, `🔐 跨對話傳訊申請 #${id}\n${who} 想送訊息到 ${deps.label(target)}\n理由: ${reason}\n允許後永久有效 (可用 /router perm ${from.chat_id} send rm ${target} 撤銷)`, buttons)
    return ok ? `已向 owner 申請 (#${id}), 決定後會通知你` : '私訊不到 owner, 申請沒有送出'
  }
  const ok = await deps.ask(target, `📨 ${who} 想傳訊息到這個對話 (#${id})\n理由: ${reason}\n要接受嗎?`, buttons)
  return ok ? `已在目標對話詢問 (#${id}), 對方決定後會通知你` : `無法在 ${target} 詢問 (bot 可能不在那個對話), 申請沒有送出`
}

/** A button press "grant:<id>:approve|deny" from uid in chat. Returns the answer to show, or null if not ours. */
export function decideGrant(deps: GrantDeps, data: string, uid: string, chatId: string): string | null {
  const m = /^grant:(\d+):(approve|deny)$/.exec(data)
  if (!m) return null
  const g = deps.db.getGrant(Number(m[1]))
  if (!g) return '找不到這個申請'
  if (g.status !== 'pending') return `這個申請已經${g.status === 'approved' ? '允許' : '拒絕'}了`
  // owner mode: only owner/admin decide; target mode: anyone in the target chat.
  if (g.mode === 'owner' ? !(deps.owners.includes(uid) || deps.isAdmin(uid)) : chatId !== g.target) return '你不能決定這個申請'
  const status = m[2] === 'approve' ? 'approved' : 'denied'
  if (!deps.db.decideGrant(g.id, status, uid)) return '這個申請已經處理過了'
  const from = deps.db.getConversation(g.from_conv)
  if (status === 'approved') deps.db.addOverride({ conv: g.from_conv, kind: 'send', value: g.target })
  if (from) deps.notify(from, `<router_status>\n跨對話傳訊申請 #${g.id} 已被${status === 'approved' ? '允許' : '拒絕'} (${deps.label(uid)}): 送往 ${deps.label(g.target)}${status === 'approved' ? ', 現在可以送出了' : ''}.\n</router_status>`)
  return status === 'approved' ? '已允許' : '已拒絕'
}
