// (bot, chat_id) -> conversation folder (plan 03 Conversations, 05 目錄).
// First message from a chat creates the folder and its settings; the worker
// session itself is started by the supervisor.
//
// Layout: <home>/CLAUDE.md (shared rules) / bot<id>/CLAUDE.md (that bot's
// persona) / <type>-<chat>/CLAUDE.md (one conversation). Claude Code reads
// CLAUDE.md from the working directory upwards, so all three apply.

import { mkdirSync, writeFileSync, existsSync, renameSync, readdirSync, realpathSync, rmdirSync } from 'fs'
import { homedir } from 'os'
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

/** owner's DM: owner; a broadcast channel: guest (its posts come from the channel, not a person); else user. */
export function defaultRole(cfg: Pick<Config, 'owners'>, type: ConvType, chat_id: string): string {
  if (type === 'channel') return 'guest'
  return type === 'dm' && cfg.owners.includes(chat_id) ? 'owner' : 'user'
}

const CLAUDE_MD = (key: string) => `# ${key}\n\n這個對話的客製設定. bot 的人設在上一層的 CLAUDE.md, 共用規則在最上層的 CLAUDE.md.\n`

/** bot<id>: the Telegram bot id (the token's part before the colon), so a token change keeps the folder. */
export function botDir(cfg: Pick<Config, 'home' | 'bots'>, bot: string): string {
  const b = cfg.bots.find(x => x.name === bot)
  const id = b?.token.split(':')[0]
  return join(cfg.home, id && /^\d+$/.test(id) ? `bot${id}` : bot)
}

export const BOT_CLAUDE_MD = (bot: string) => `# ${bot} 的人設\n\n(尚未設定: owner 第一次私訊這隻 bot 時會進行初次設定訪談, 結果寫在這裡.)\n`

/** The bot's folder and its persona CLAUDE.md (placeholder until the interview). */
export function ensureBotDir(cfg: Pick<Config, 'home' | 'bots'>, bot: string): string {
  const d = botDir(cfg, bot)
  mkdirSync(d, { recursive: true })
  if (!existsSync(join(d, 'CLAUDE.md'))) writeFileSync(join(d, 'CLAUDE.md'), BOT_CLAUDE_MD(bot))
  return d
}

export function convFolder(cfg: Pick<Config, 'home' | 'bots'>, bot: string, chat_id: string, type: ConvType): string {
  return join(botDir(cfg, bot), `${type}-${chat_id.replace(/^-/, '')}`)
}

/** Claude Code keeps a project's transcripts under ~/.claude/projects/<path with / and . as ->. */
export function projectStore(folder: string, base = join(homedir(), '.claude', 'projects')): string {
  return join(base, folder.replace(/[/.]/g, '-'))
}

/** Move a conversation that still lives at the old <home>/<key> into its bot folder,
 *  transcripts included. The caller stops its worker first. */
export function migrateConversation(cfg: Pick<Config, 'home' | 'bots'>, db: RouterDb, c: Conversation, projects?: string): Conversation | null {
  const target = convFolder(cfg, c.bot, c.chat_id, c.type)
  if (c.folder === target) return null
  mkdirSync(botDir(cfg, c.bot), { recursive: true })
  if (existsSync(c.folder) && !existsSync(target)) renameSync(c.folder, target)
  const from = projectStore(c.folder, projects), to = projectStore(target, projects)
  if (existsSync(from)) {
    mkdirSync(to, { recursive: true })
    for (const f of readdirSync(from)) if (!existsSync(join(to, f))) renameSync(join(from, f), join(to, f))
    if (!readdirSync(from).length) rmdirSync(from)
  }
  return db.setFolder(c.key, target)
}

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
  ensureBotDir(cfg, bot)
  const folder = convFolder(cfg, bot, chat_id, type)
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

/** The conversation whose folder is dir or contains it (a plugin or hook may report a subfolder). */
export function findByFolder(db: RouterDb, dir: string): Conversation | null {
  const real = (p: string) => { try { return realpathSync(p) } catch { return p } }
  const d = real(dir)
  return db.listConversations().find(c => { const f = real(c.folder); return d === f || d.startsWith(f + '/') }) ?? null
}
