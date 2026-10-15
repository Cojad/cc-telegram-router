// First run of a bot (plan 03 初次設定), in three steps:
//   1. owner: a router with no owners prints a one-time claim code to its
//      log; whoever DMs "/start <code>" to any bot becomes the owner.
//   2. persona: until the owner has done it, every owner DM to the bot
//      carries a <bootstrap> note; the worker interviews the owner (name,
//      personality, style, purpose) and saves the result with
//      save_bot_profile. The persona then rides in every conversation's
//      chat_context for that bot.
//   3. approvals group: the router explains how to make a forum group for
//      notices and approval requests (/router setup group in that group),
//      or the owner skips it and everything goes to their DM.

import { randomBytes } from 'crypto'
import type { RouterDb, BotSetup } from './db'

export function newClaimCode(): string {
  return randomBytes(4).toString('hex')
}

/** "/start <code>" in a private chat when the router has no owner yet. */
export function isClaim(text: string | undefined, code: string | null): boolean {
  if (!code || !text) return false
  const m = /^\/start(?:@\w+)?\s+(\S+)\s*$/.exec(text.trim())
  return !!m && m[1] === code
}

/** Rows for bots seen for the first time. A bot that already has
 *  conversations was in use before setup existed: treat it as set up, with
 *  approvals going to the owner's DM. */
export function initBotSetups(db: RouterDb, bots: string[]): void {
  const used = new Set(db.listConversations().map(c => c.bot))
  for (const b of bots) {
    if (db.getBotSetup(b)) continue
    db.updateBotSetup(b, used.has(b) ? { persona_done: 1, group_skipped: 1 } : {})
  }
}

export function needsPersona(s: BotSetup | null): boolean {
  return !s || !s.persona_done
}

export function bootstrapNote(bot: string): string {
  return `<bootstrap>
這隻 bot (${bot}) 剛啟用, 還沒有人設. 這則訊息來自 owner: 先和 owner 完成初次設定訪談, 再處理其他事.
用自然的對話一次問一兩題, 依序弄清楚:
1. 名字: owner 想怎麼稱呼這隻 bot
2. 個性: 例如沉穩, 活潑, 毒舌, 溫柔
3. 說話風格: 語言, 正式程度, emoji, 回覆長短
4. 用途: 主要拿來做什麼, 會在哪些群組, 對誰服務
owner 說「都可以」或「你決定」的項目, 提一個具體建議請對方確認.
全部確認後呼叫 save_bot_profile (name 與 persona). persona 用第二人稱寫成給 bot 自己看的設定 (「你是...」), 涵蓋上面四點, 300 字內.
存好之後 router 會接手說明審核群組的設定, 你不用說明那部分.
</bootstrap>`
}

export const GROUP_GUIDE = [
  '最後一步: 設定審核群組 (重要通知與權限申請都送到那裡).',
  '1. 建立一個新群組, 在群組設定裡打開「話題」(Topics)',
  '2. 把我加進群組並設為管理員, 權限勾選「管理話題」',
  '3. 在群組裡傳 /router setup group',
  '我會建立「🔔 重要通知」與「🔐 權限審核」兩個話題.',
  '不想另開群組也可以略過, 之後這些訊息都直接私訊給你 (隨時可以再用 /router setup group 設定).',
].join('\n')

export type GroupCheck =
  | { ok: true }
  | { ok: false; reason: string }

/** Is this chat usable as the approvals group? (forum supergroup, bot may manage topics) */
export function checkGroup(chat: { type: string; is_forum?: boolean }, member: { status: string; can_manage_topics?: boolean } | null): GroupCheck {
  if (chat.type !== 'supergroup' || !chat.is_forum) return { ok: false, reason: '這個群組還沒打開「話題」: 群組設定 → 話題 (Topics) 打開後再試' }
  if (!member || member.status !== 'administrator') return { ok: false, reason: '我還不是這個群組的管理員: 把我設為管理員並勾選「管理話題」後再試' }
  if (!member.can_manage_topics) return { ok: false, reason: '我是管理員但沒有「管理話題」權限: 在管理員權限裡勾選後再試' }
  return { ok: true }
}

export function describeSetup(s: BotSetup | null, ownerDm: string | undefined): string {
  const place = s?.approvals_chat
    ? `群組 ${s.approvals_chat} (重要通知話題 ${s.notices_topic ?? '?'}, 權限審核話題 ${s.approvals_topic ?? '?'})`
    : `owner 私訊 ${ownerDm ?? '(沒有 owner)'}${s?.group_skipped ? ' (已略過群組設定)' : ' (群組尚未設定)'}`
  return [`人設: ${needsPersona(s) ? '尚未完成 (owner 下次私訊時會開始訪談)' : '已完成'}`, `審核與通知: ${place}`].join('\n')
}
