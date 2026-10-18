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

/** The Telegram bot id in a token (the part before the colon), or null. */
export function tokenBotId(token: string): string | null {
  const id = token.split(':')[0]
  return id && /^\d+$/.test(id) ? id : null
}

/** Rows for bots seen for the first time. A bot that already has
 *  conversations was in use before setup existed: treat it as set up, with
 *  approvals going to the owner's DM. A row from before bot_id was kept
 *  gets the configured bot's id. A row of another bot (config.json now has
 *  another bot's token under that name) starts over like a new bot, as
 *  /router bot add does. Returns those names with the old and new id. */
export function initBotSetups(db: RouterDb, bots: Array<{ name: string; id: string | null }>): Array<{ name: string; was: string; now: string }> {
  const used = new Set(db.listConversations().map(c => c.bot))
  const reset: Array<{ name: string; was: string; now: string }> = []
  for (const { name, id } of bots) {
    const s = db.getBotSetup(name)
    if (!s) db.updateBotSetup(name, { ...(used.has(name) ? { persona_done: 1, group_skipped: 1 } : {}), bot_id: id })
    else if (!s.bot_id && id) db.updateBotSetup(name, { bot_id: id })
    else if (s.bot_id && id && s.bot_id !== id) { resetBotSetup(db, name, id); reset.push({ name, was: s.bot_id, now: id }) }
  }
  return reset
}

/** A bot under this name is another Telegram bot: no persona, no approvals place. */
function resetBotSetup(db: RouterDb, name: string, botId: string): void {
  db.updateBotSetup(name, { bot_id: botId, persona_done: 0, persona: null, approvals_chat: null, approvals_topic: null, notices_topic: null, elevlog_topic: null, authuse_topic: null, secret_topic: null, pairing_topic: null, group_skipped: 0 })
}

/** What the owner is told when the start found another bot under a name. */
export function resetNotice(r: { name: string; was: string; now: string }): string {
  return `⚠️ config.json 裡 bot ${r.name} 的 token 換成了另一隻 bot (id ${r.was} → ${r.now}): 它的設定已重置 (人設, 審核群組), 當成新 bot. 私訊它任何一句話就會開始初次設定.`
}

/** /router bot add: the setup stored under this name is kept only for the
 *  same Telegram bot (its folder bot<id> is named by the id too). Another
 *  bot under a reused name starts over: no persona, no approvals place. A
 *  row without bot_id counts as the same bot when its folder bot<id> already
 *  exists. Returns what happened. */
export function adoptBotSetup(db: RouterDb, name: string, botId: string, hasBotFolder: boolean): 'new' | 'kept' | 'reset' {
  const s = db.getBotSetup(name)
  if (!s) { db.updateBotSetup(name, { bot_id: botId }); return 'new' }
  if (s.bot_id ? s.bot_id === botId : hasBotFolder) {
    if (!s.bot_id) db.updateBotSetup(name, { bot_id: botId })
    return 'kept'
  }
  resetBotSetup(db, name, botId)
  return 'reset'
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
  '我會建立「🔔 重要通知」「🔐 權限審核」「📜 提權紀錄」「🧾 執行授權」「🔑 密鑰偵測」「🤝 配對申請」六個話題.',
  '不想另開群組也可以略過, 之後這些訊息都直接私訊給你 (隨時可以再用 /router setup group 設定).',
].join('\n')

export type GroupCheck =
  | { ok: true }
  | { ok: false; reason: string }

/** Is this chat usable as the approvals group? (forum supergroup, bot may manage topics) */
export function checkGroup(chat: { type: string; is_forum?: boolean }, member: { status: string; can_manage_topics?: boolean } | null): GroupCheck {
  if (chat.type !== 'supergroup') return { ok: false, reason: '審核群組必須是 supergroup: 群組設定裡打開「話題」會自動升級成 supergroup, 之後再試' }
  if (!chat.is_forum) return { ok: false, reason: '這個群組還沒打開「話題」: 群組設定 → 話題 (Topics) 打開後再試' }
  if (!member || member.status !== 'administrator') return { ok: false, reason: '我還不是這個群組的管理員: 把我設為管理員並勾選「管理話題」後再試' }
  if (!member.can_manage_topics) return { ok: false, reason: '我是管理員但沒有「管理話題」權限: 在管理員權限裡勾選後再試' }
  return { ok: true }
}

/** What /router bot add says about first-run setup. The same bot added back
 *  under its name keeps its persona and approvals place (adoptBotSetup): say
 *  so, instead of promising an interview that will not happen. */
export function addedSetupText(username: string, s: BotSetup | null): string {
  if (needsPersona(s)) return `私訊 @${username} 任何一句話, 它會帶你完成初次設定 (名字, 個性, 風格, 用途, 審核群組)`
  const place = s!.approvals_chat ? `審核與通知沿用既有的審核群組 (${s!.approvals_chat})`
    : s!.group_skipped ? '審核與通知照舊送 owner 私訊 (已略過群組設定)'
    : '審核群組還沒設定: 在開了話題的群組裡傳 /router setup group, 或 /router setup skip 改由 owner 私訊接收'
  return `沿用既有人設, 不用重新做初次設定; ${place}. 要重新做人設訪談可用 /router setup persona`
}

export function describeSetup(s: BotSetup | null, ownerDm: string | undefined): string {
  const place = s?.approvals_chat
    ? `群組 ${s.approvals_chat} (重要通知話題 ${s.notices_topic ?? '?'}, 權限審核話題 ${s.approvals_topic ?? '?'}, 提權紀錄話題 ${s.elevlog_topic ?? '?'}, 執行授權話題 ${s.authuse_topic ?? '?'}, 密鑰偵測話題 ${s.secret_topic ?? '?'}, 配對申請話題 ${s.pairing_topic ?? '?'})`
    : `owner 私訊 ${ownerDm ?? '(沒有 owner)'}${s?.group_skipped ? ' (已略過群組設定)' : ' (群組尚未設定)'}`
  return [`人設: ${needsPersona(s) ? '尚未完成 (owner 下次私訊時會開始訪談)' : '已完成'}`, `審核與通知: ${place}`].join('\n')
}

/** Text for Telegram's parse_mode HTML: & < > escaped (names of groups, people, channels too). */
export const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** The plain text of a message written for parse_mode HTML (the terminal CLI prints it so). */
export const htmlToText = (s: string) => s.replace(/<\/?b>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const t = escHtml
const b = (s: string) => `<b>${escHtml(s)}</b>`

/** Group privacy (@BotFather /setprivacy; getMe can_read_all_group_messages
 *  true = off). Wording by 柯姊 (2026-10-17), bold where her reviewed draft
 *  had it; HTML (parse_mode HTML), like B2B_NOTICE: whoever sends it sends
 *  the whole message as HTML and escapes the rest (escHtml). The
 *  current-setting line is picked from getMe. null when getMe is not known yet. */
export function privacyNotice(me: { username: string; can_read_all_group_messages?: boolean } | null): string | null {
  if (!me) return null
  const off = me.can_read_all_group_messages === true
  return [
    `🔒 ${b('群組隱私模式 (Group Privacy)')}`,
    t('這是 @BotFather 裡的設定, 每隻 bot 預設都是開啟的.'),
    `- ${b('開啟 (預設):')}${t(' bot 在群組裡只收得到以 / 開頭的指令, 以及直接回覆 bot 的訊息. 用名字叫它 (例如「柯柯」) 或一般聊天, 它都看不到.')}`,
    `- ${b('關閉:')}${t(' bot 看得到群組裡的每一則訊息, 可以用名字呼叫, 也能跟上對話的前後文.')}`,
    t('為了讓分身在群組裡好用, 通常要改為關閉.'),
    '',
    t(off ? '你目前 Group Privacy 設定: ✅ 關閉 (Bot 可以看到每則群組訊息, 符合建議的設定)'
      : '你目前 Group Privacy 設定: ⚠️ 開啟 (ℹ️ Bot 無法看到每則群組訊息, 建議改為關閉)'),
    '',
    `${b('關閉方式:')}${t(' 私訊 @BotFather → /setprivacy → 選這隻 bot → Disable.')}`,
    '',
    `⚠️ ${b('兩件很重要的事:')}`,
    `1. ${b('改完之後, 要把 bot 從群組移除再重新加入才會生效.')}${t(' 已經在群組裡的 bot 不會自動套用新設定, 每個群組都要重加一次.')}`,
    `2. ${b('如果 bot 是該群組的管理員, 就不受隱私模式限制')}${t(', 本來就看得到全部訊息, 那個群組可以不用改.')}`,
  ].join('\n')
}

/** Bot-to-Bot Communication Mode (@BotFather): Bot API getMe has no field
 *  for it, so it cannot be checked, only explained. Wording by 柯姊 (2026-10-17). */
export const B2B_NOTICE = [
  `🤖 ${b('Bot 之間互傳訊息 (Bot-to-Bot Communication Mode)')}`,
  t('這是 @BotFather 裡的設定, 預設關閉. router 沒辦法查到它目前是開是關.'),
  `- ${b('關閉 (預設):')}${t(' 這隻 bot 收不到其他 bot 的訊息.')}`,
  `- ${b('開啟:')}${t(' 在群組裡, 別的 bot 對它下 /指令@這隻bot, 或回覆它的訊息時, 它收得到. 如果它是群組管理員或關了隱私模式, 會收到群組裡其他 bot 的所有訊息. 私訊要兩隻 bot 都開啟才能互傳.')}`,
  `${b('設定方式:')}${t(' 私訊 @BotFather → /setbot2bot → 選這隻 bot → Enable (開啟) 或 Disable (關閉); 也可以在 @BotFather 的 Mini App 裡設定.')}`,
  `${b('開啟的風險:')}${t(' router 不分辨發話者是人還是 bot, 其他 bot 的訊息會像一般成員一樣交給分身處理, 包括 /secret 這類指令; 兩隻 bot 也可能互相回覆停不下來.')}`,
  t('如果你希望你的 bot 能跟一般帳號一樣與其他 bot 互動, 就需要打開, 但這有機會增加被其他機器人攻擊的風險, 需要小心並理解. 如果你沒打算讓 bot 跟其他 bot 溝通, 不用去打開; 如果你希望 bot 能跟其他 bot 溝通來擴展能力, 則可以打開.'),
].join('\n')

/** What the owner should know about a bot's settings: group privacy and bot-to-bot (HTML). */
export function botSettingsNotice(me: { username: string; can_read_all_group_messages?: boolean } | null): string {
  return [privacyNotice(me), B2B_NOTICE].filter(Boolean).join('\n\n')
}

/** The bot was added to a broadcast channel. Channels are not supported:
 *  posts only go to events, so tell the owner and point to GitHub issues. */
export function channelJoinNotice(botUsername: string, chat: { id: number; title?: string }): string {
  return [
    `📣 @${botUsername} 被加入頻道「${chat.title ?? chat.id}」(${chat.id})`,
    '目前尚未正式支援 Telegram 頻道, bot 不會處理頻道貼文.',
    '如果有實際想要的應用場景, 請到 GitHub https://github.com/Cojad/cc-telegram-router/issues 提交使用情境與需要的功能, 作者會視情況加入頻道支援.',
  ].join('\n')
}
