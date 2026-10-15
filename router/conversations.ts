// (bot, chat_id) -> conversation folder (plan 03 Conversations, 05 目錄).
// First message from a chat creates the folder and its settings; the worker
// session itself is started by the supervisor.

import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Config } from './config'
import type { Conversation, ConvType, RouterDb } from './db'

export function convType(chat_id: string, chatType?: string): ConvType {
  if (chatType === 'channel') return 'channel'
  if (chatType === 'private') return 'dm'
  if (chatType === 'group' || chatType === 'supergroup') return 'group'
  return chat_id.startsWith('-') ? 'group' : 'dm'
}

/** dm-137438526, group-1009990000001. Bots other than the first get a prefix
 *  so two bots in the same chat don't share a folder. */
export function convKey(cfg: Pick<Config, 'bots'>, bot: string, chat_id: string, type: ConvType): string {
  const id = chat_id.replace(/^-/, '')
  const base = `${type}-${id}`
  return bot === cfg.bots[0]!.name ? base : `${bot}-${base}`
}

export function defaultRole(cfg: Pick<Config, 'owners'>, type: ConvType, chat_id: string): string {
  return type === 'dm' && cfg.owners.includes(chat_id) ? 'owner' : 'user'
}

const CLAUDE_MD = (key: string) => `# ${key}\n\n這個對話的客製設定. 共用規則在 /x/cc/CLAUDE.md.\n`

export function ensureConversation(
  cfg: Config,
  db: RouterDb,
  bot: string,
  chat_id: string,
  chatType: string | undefined,
  onCreate: (c: Conversation) => void,
): Conversation {
  const found = db.findConversation(bot, chat_id)
  if (found) return found
  const type = convType(chat_id, chatType)
  const key = convKey(cfg, bot, chat_id, type)
  const folder = join(cfg.home, key)
  for (const d of [folder, join(folder, 'memory'), join(folder, 'attachments'), join(folder, '.chat')]) {
    mkdirSync(d, { recursive: true })
  }
  if (!existsSync(join(folder, 'CLAUDE.md'))) writeFileSync(join(folder, 'CLAUDE.md'), CLAUDE_MD(key))
  const c: Conversation = {
    key, bot, chat_id, type, folder,
    role: defaultRole(cfg, type, chat_id),
    session_id: null,
    created_at: new Date().toISOString(),
  }
  db.insertConversation(c)
  writeFileSync(join(folder, '.chat', 'context.json'), JSON.stringify({ v: 1, chat_id, type, role: c.role, bot }, null, 2) + '\n')
  onCreate(c)
  return c
}
