// Chat context (plan 06) and router_log (plan 03 「Claude Code 怎麼知道發生了什麼」).
// Both ride in front of the next message delivered to a worker, so they land
// at the tail of the conversation and never invalidate the prompt cache.

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Config } from './config'
import type { Conversation, LogRow } from './db'

export const ROLE_DESC: Record<string, string> = {
  owner: '全部能力, 不受資料夾與 sandbox 限制',
  admin: '可讀寫指定的外部路徑, 可跨對話傳訊, 可用白名單內的 MCP',
  power: '自己資料夾內可寫入並執行 python3 / node / bun',
  user: '只能讀寫自己的資料夾, Bash 只能跑唯讀指令',
  guest: '只能對話',
}

export type ChatContext = {
  v: number
  conversation: string
  chat_id: string
  type: string
  title: string | null
  bot: string
  role: string
  role_desc: string
  folder: string
  model: string
  autoCompactWindow: number
}

export function buildContext(cfg: Config, c: Conversation): ChatContext {
  return {
    v: c.ctx_v ?? 1,
    conversation: c.key,
    chat_id: c.chat_id,
    type: c.type,
    title: c.title ?? null,
    bot: c.bot,
    role: c.role,
    role_desc: ROLE_DESC[c.role] ?? '',
    folder: c.folder,
    model: c.model ?? cfg.model,
    autoCompactWindow: c.compact ?? cfg.autoCompactWindow,
  }
}

export function renderContext(ctx: ChatContext): string {
  const lines = [
    `conversation: ${ctx.conversation} (${ctx.type}${ctx.title ? `, ${ctx.title}` : ''})`,
    `chat_id: ${ctx.chat_id}`,
    `role: ${ctx.role} (${ctx.role_desc})`,
    `folder: ${ctx.folder}`,
    `model: ${ctx.model}, autoCompactWindow: ${ctx.autoCompactWindow}`,
    '這個 session 只服務這一個 Telegram 對話.',
  ]
  return `<chat_context v="${ctx.v}">\n${lines.join('\n')}\n</chat_context>`
}

export function writeContextFile(cfg: Config, c: Conversation): void {
  mkdirSync(join(c.folder, '.chat'), { recursive: true })
  writeFileSync(join(c.folder, '.chat', 'context.json'), JSON.stringify(buildContext(cfg, c), null, 2) + '\n')
}

/** 2026-10-16 03:05 (GMT+8) */
/** A label in parentheses, without parentheses inside: "柯姊 (137438526)"
 *  becomes "(柯姊, 137438526)" rather than "(柯姊 (137438526))" (柯姊 2026-10-17). */
export function inParens(s: string): string {
  return `(${s.replace(/\s*\(([^()]*)\)/g, ', $1').replace(/^, /, '')})`
}

export function gmt8(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei', hour12: false }).slice(0, 16)
}

/** Bot tokens never go into a worker's context: keep the bot id and last 4. */
export function maskTokens(text: string): string {
  return text.replace(/\b(\d{3,15}):([A-Za-z0-9_-]{25,})\b/g, (_m, id: string, secret: string) => `${id}:…${secret.slice(-4)}`)
}

export function renderLogs(logs: LogRow[]): string {
  if (!logs.length) return ''
  return `<router_log>\n${logs.map(l => `[${gmt8(l.ts)}] ${maskTokens(l.text)}`).join('\n')}\n</router_log>`
}
