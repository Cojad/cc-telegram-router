// /router commands and /restart (plan 03 「router 設定指令」). Handled by the
// router itself, never forwarded to a worker. Who may run what follows the
// 指令表: owner and admin; admin may not make anyone owner nor touch an
// owner; bot token changes only in the owner's own DM.

import type { Config } from './config'
import type { Conversation, RouterDb } from './db'
import type { Access } from './telegram/policy'
import type { MessageRecord } from './telegram/store'
import { gmt8 } from './context'

export const ROLES = ['owner', 'admin', 'power', 'user', 'guest'] as const

export type CommandInput = { bot: string; text: string; senderId: string; senderName: string; chatId: string; chatType: string }
export type CommandOutput = { reply: string; deleteMessage?: boolean; logs: Array<{ conv: string; text: string }>; after?: () => void }

export interface CommandDeps {
  cfg: Config
  db: RouterDb
  loadAccess(): Access
  saveAccess(a: Access): void
  bots: {
    list(): Promise<Array<{ name: string; id: number; username: string; first_name: string }>>
    add(name: string, token: string): Promise<string>
    rotate(name: string, token: string): Promise<string>
    remove(name: string): Promise<void>
  }
  sessions: {
    isConnected(key: string): boolean
    restart(c: Conversation, opts?: { dropJob?: boolean }): Promise<void>
    stop(c: Conversation): Promise<void>
  }
  /** Rewrite the conversation's settings and context file; restart the worker if it runs. */
  applySettings(c: Conversation, opts: { dropJob: boolean }): Promise<void>
  sendTo(bot: string, chatId: string, text: string): Promise<void>
  recentMessages(chatId: string, n: number): MessageRecord[]
  writeConfig(mutate: (raw: Record<string, unknown>) => void): void
  restartRouter(): void
  startedAt: Date
}

const COMMAND_RE = /^\/(router|restart)(?:@\w+)?(?:\s+([\s\S]*))?$/

export function isCommand(text: string | undefined): boolean {
  return !!text && COMMAND_RE.test(text.trim())
}

export function roleOf(deps: Pick<CommandDeps, 'cfg' | 'db'>, uid: string): string {
  if (deps.cfg.owners.includes(uid)) return 'owner'
  return deps.db.getUserRole(uid) ?? 'user'
}

const HELP = [
  '/router status',
  '/router bot list | add <名稱> <token> | rotate <名稱> <token> | remove <名稱>',
  '/router role user <uid> <角色|none> | role list',
  '/router chat [chat_id] compact <750k|1m|auto> | model <模型> | mention <on|off>',
  '/router access show | pair <code> | deny <code> | allow <uid> | remove <uid> | group add <chat_id> [--no-mention] | group rm <chat_id> | policy <pairing|allowlist|disabled>',
  '/router session restart|stop [chat_id]',
  '/router config get <key> | set <key> <值>',
  '/router log [chat_id] [筆數]',
  '/restart',
].join('\n')

const CONFIG_KEYS: Record<string, 'string' | 'number' | 'list'> = { model: 'string', autoCompactWindow: 'number', claudeBin: 'string', owners: 'list' }

function parseCompact(v: string | undefined): number | null | undefined {
  if (!v) return undefined
  if (v === 'auto' || v === 'default') return null
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(v)
  if (!m) return undefined
  const n = Number(m[1]) * (m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1000 : 1)
  return n >= 100_000 && n <= 1_000_000 ? Math.round(n) : undefined
}

export async function runCommand(input: CommandInput, deps: CommandDeps): Promise<CommandOutput | null> {
  const m = COMMAND_RE.exec(input.text.trim())
  if (!m) return null
  const { cfg, db } = deps
  const role = roleOf(deps, input.senderId)
  const here = db.findConversation(input.bot, input.chatId)
  const cmdText = input.text.trim()
  const logs: Array<{ conv: string; text: string }> = []
  const who = `${input.senderName}(${role})`
  const done = (reply: string, extra: Partial<CommandOutput> = {}): CommandOutput => {
    if (here) logs.push({ conv: here.key, text: `${who} ${cmdText} → ${reply.split('\n')[0]}` })
    return { reply, logs, ...extra }
  }
  const deny = (reason: string, extra: Partial<CommandOutput> = {}) => done(`⛔ ${reason}`, extra)

  const args = (m[1] === 'restart' ? ['restart'] : (m[2] ?? '').trim().split(/\s+/).filter(Boolean))
  const sub = args[0] ?? 'help'
  const hasToken = sub === 'bot' && (args[1] === 'add' || args[1] === 'rotate') && args.length >= 4

  if (role !== 'owner' && role !== 'admin') {
    return deny(`/router 只開放 owner 與 admin, 你的角色是 ${role}`, { deleteMessage: hasToken })
  }

  /** Optional leading chat id; defaults to the current chat. */
  const target = (i: number): { conv: Conversation | null; rest: string[] } => {
    if (args[i] && /^-?\d+$/.test(args[i]!)) return { conv: db.findConversation(input.bot, args[i]!), rest: args.slice(i + 1) }
    return { conv: here, rest: args.slice(i) }
  }

  switch (sub) {
    case 'help':
      return done(HELP)

    case 'status': {
      const up = Math.round((Date.now() - deps.startedAt.getTime()) / 60000)
      const lines = [`router 已運作 ${up} 分鐘, bots: ${cfg.bots.map(b => b.name).join(', ')}`]
      for (const c of db.listConversations()) {
        const backlog = db.undelivered(c.key).length
        lines.push(`${c.key} ${c.title ? `(${c.title}) ` : ''}${c.role} ${deps.sessions.isConnected(c.key) ? '在線' : '離線'}${backlog ? `, 待送 ${backlog}` : ''}`)
      }
      return done(lines.join('\n'))
    }

    case 'bot': {
      const op = args[1]
      if (op === 'list') {
        const bots = await deps.bots.list()
        return done(bots.map(b => `${b.name}: @${b.username} (id ${b.id}, ${b.first_name})`).join('\n') || '沒有 bot')
      }
      if (op !== 'add' && op !== 'rotate' && op !== 'remove') return done('用法: /router bot list | add <名稱> <token> | rotate <名稱> <token> | remove <名稱>')
      const inOwnerDm = role === 'owner' && input.chatType === 'private' && input.chatId === input.senderId
      if (!inOwnerDm) {
        const leaked = hasToken && input.chatType !== 'private'
        return deny(`/router bot ${op} 只能在 owner 私訊使用${hasToken ? ', 已刪除這則訊息' : ''}${leaked ? '; token 曾出現在群組, 建議 /router bot rotate' : ''}`, { deleteMessage: hasToken })
      }
      const name = args[2]
      if (!name) return done(`用法: /router bot ${op} <名稱>${op === 'remove' ? '' : ' <token>'}`, { deleteMessage: hasToken })
      try {
        if (op === 'remove') {
          await deps.bots.remove(name)
          return done(`已移除 bot ${name}`)
        }
        const token = args[3]
        if (!token) return done(`用法: /router bot ${op} <名稱> <token>`)
        const username = op === 'add' ? await deps.bots.add(name, token) : await deps.bots.rotate(name, token)
        return done(`${op === 'add' ? '已新增' : '已更換'} bot ${name}: @${username}, 已刪除含 token 的訊息`, { deleteMessage: true })
      } catch (e) {
        return done(`bot ${op} 失敗: ${e instanceof Error ? e.message : e}`, { deleteMessage: hasToken })
      }
    }

    case 'role': {
      if (args[1] === 'list') {
        const lines = [...cfg.owners.map(u => `${u} owner (config)`), ...db.listUsers().filter(u => !cfg.owners.includes(u.uid)).map(u => `${u.uid} ${u.role}`)]
        return done(lines.join('\n') || '沒有設定任何角色')
      }
      if (args[1] !== 'user' || !args[2] || !args[3]) return done('用法: /router role user <uid> <角色|none> | role list')
      const uid = args[2]!
      const newRole = args[3] === 'none' ? null : args[3]!
      if (newRole && !(ROLES as readonly string[]).includes(newRole)) return done(`角色只能是 ${ROLES.join(', ')} 或 none`)
      if (cfg.owners.includes(uid)) return deny(`${uid} 是 config 指定的 owner, 要改請用 /router config set owners`)
      const current = db.getUserRole(uid)
      if (role === 'admin') {
        if (newRole === 'owner') return deny('admin 不能把角色設成 owner')
        if (current === 'owner') return deny('admin 不能異動 owner 的角色與權限')
      }
      db.setUserRole(uid, newRole)
      return done(`${uid} 的角色: ${current ?? 'user'} → ${newRole ?? 'user'}`)
    }

    case 'chat': {
      const { conv, rest } = target(1)
      if (!conv) return done('找不到這個對話 (它還沒有任何訊息進來過)')
      if (role === 'admin' && conv.role === 'owner') return deny('admin 不能異動 owner 的角色與權限')
      const [key, value] = rest
      if (key === 'compact') {
        const n = parseCompact(value)
        if (n === undefined) return done('compact 要介於 100k 到 1m, 或 auto')
        const c = db.updateConversation(conv.key, { compact: n })
        await deps.applySettings(c, { dropJob: false })
        if (here?.key !== c.key) logs.push({ conv: c.key, text: `${who} 把 autoCompactWindow 改成 ${n ?? cfg.autoCompactWindow}` })
        return done(`${c.key} autoCompactWindow → ${n ?? `預設 (${cfg.autoCompactWindow})`}`)
      }
      if (key === 'model') {
        if (!value) return done('用法: /router chat [chat_id] model <模型>')
        const c = db.updateConversation(conv.key, { model: value === 'default' ? null : value })
        await deps.applySettings(c, { dropJob: true })
        if (here?.key !== c.key) logs.push({ conv: c.key, text: `${who} 把模型改成 ${c.model ?? cfg.model}` })
        return done(`${c.key} 模型 → ${c.model ?? `預設 (${cfg.model})`}, worker 已重啟`)
      }
      if (key === 'mention') {
        if (conv.type !== 'group') return done('mention 只適用群組')
        if (value !== 'on' && value !== 'off') return done('用法: /router chat [chat_id] mention <on|off>')
        const a = deps.loadAccess()
        a.groups[conv.chat_id] = { ...(a.groups[conv.chat_id] ?? { allowFrom: [] }), requireMention: value === 'on' }
        deps.saveAccess(a)
        return done(`${conv.key} ${value === 'on' ? '要 mention 才回應' : '不用 mention 也會收到所有訊息'}`)
      }
      return done('用法: /router chat [chat_id] compact|model|mention <值>')
    }

    case 'access': {
      const a = deps.loadAccess()
      const op = args[1]
      if (!op || op === 'show') {
        const pend = Object.entries(a.pending).map(([code, p]) => `${code} ← ${p.senderId}`)
        return done([`dmPolicy: ${a.dmPolicy}`, `allowFrom: ${a.allowFrom.join(', ') || '(空)'}`, `groups: ${Object.entries(a.groups).map(([g, p]) => `${g}${p.requireMention ? '' : ' (不需 mention)'}`).join(', ') || '(空)'}`, `pending: ${pend.join(', ') || '(無)'}`].join('\n'))
      }
      if (op === 'pair' || op === 'deny') {
        const code = args[2]
        const p = code ? a.pending[code] : undefined
        if (!code || !p || p.expiresAt < Date.now()) return done(`找不到有效的配對碼 ${code ?? ''}`)
        delete a.pending[code]
        if (op === 'pair' && !a.allowFrom.includes(p.senderId)) a.allowFrom.push(p.senderId)
        deps.saveAccess(a)
        if (op === 'pair') await deps.sendTo(input.bot, p.chatId, '配對完成, 可以開始對話了.').catch(() => {})
        return done(op === 'pair' ? `已核可 ${p.senderId}` : `已拒絕配對碼 ${code}`)
      }
      if (op === 'allow' || op === 'remove') {
        const uid = args[2]
        if (!uid) return done(`用法: /router access ${op} <uid>`)
        if (role === 'admin' && op === 'remove' && roleOf(deps, uid) === 'owner') return deny('admin 不能異動 owner 的角色與權限')
        a.allowFrom = op === 'allow' ? [...new Set([...a.allowFrom, uid])] : a.allowFrom.filter(x => x !== uid)
        deps.saveAccess(a)
        return done(`${op === 'allow' ? '已允許' : '已移除'} ${uid}`)
      }
      if (op === 'group') {
        const gop = args[2], gid = args[3]
        if ((gop !== 'add' && gop !== 'rm') || !gid) return done('用法: /router access group add <chat_id> [--no-mention] | group rm <chat_id>')
        if (gop === 'add') a.groups[gid] = { requireMention: !args.includes('--no-mention'), allowFrom: [] }
        else delete a.groups[gid]
        deps.saveAccess(a)
        return done(`群組 ${gid} ${gop === 'add' ? '已加入' : '已移除'}`)
      }
      if (op === 'policy') {
        const mode = args[2]
        if (mode !== 'pairing' && mode !== 'allowlist' && mode !== 'disabled') return done('policy 只能是 pairing, allowlist, disabled')
        a.dmPolicy = mode
        deps.saveAccess(a)
        return done(`dmPolicy → ${mode}`)
      }
      return done('用法: /router access show | pair | deny | allow | remove | group | policy')
    }

    case 'session': {
      const op = args[1]
      if (op !== 'restart' && op !== 'stop') return done('用法: /router session restart|stop [chat_id]')
      const { conv } = target(2)
      if (!conv) return done('找不到這個對話')
      if (role === 'admin' && conv.role === 'owner' && op === 'stop') return deny('admin 不能異動 owner 的角色與權限')
      if (here?.key !== conv.key) logs.push({ conv: conv.key, text: `${who} ${op === 'restart' ? '重啟' : '停止'}了這個 worker` })
      // Restarting the worker that would carry this reply happens after the reply is sent.
      const act = () => void (op === 'restart' ? deps.sessions.restart(conv) : deps.sessions.stop(conv))
      return done(`${conv.key} ${op === 'restart' ? '重啟中' : '已停止, 下一則訊息會再叫醒'}`, { after: act })
    }

    case 'config': {
      const op = args[1], key = args[2]
      if (!key || !(key in CONFIG_KEYS)) return done(`可用的 key: ${Object.keys(CONFIG_KEYS).join(', ')} (bot token 請用 /router bot)`)
      const cur = (cfg as unknown as Record<string, unknown>)[key]
      if (op === 'get') return done(`${key} = ${JSON.stringify(cur)}`)
      if (op !== 'set' || args.length < 4) return done('用法: /router config get <key> | set <key> <值>')
      if (key === 'owners' && role !== 'owner') return deny('admin 不能異動 owner 的角色與權限')
      const raw = args.slice(3).join(' ')
      let value: unknown = raw
      if (CONFIG_KEYS[key] === 'number') { value = Number(raw); if (!Number.isFinite(value)) return done(`${key} 要是數字`) }
      if (CONFIG_KEYS[key] === 'list') value = raw.split(/[\s,]+/).filter(Boolean)
      if (key === 'owners' && !(value as string[]).includes(input.senderId)) return deny('不能把自己從 owners 移除')
      deps.writeConfig(r => { r[key] = value })
      ;(cfg as unknown as Record<string, unknown>)[key] = value
      return done(`${key}: ${JSON.stringify(cur)} → ${JSON.stringify(value)}`)
    }

    case 'log': {
      const { conv, rest } = target(1)
      if (!conv) return done('找不到這個對話')
      const n = Math.min(Math.max(Number(rest[0]) || 10, 1), 50)
      const rows = deps.recentMessages(conv.chat_id, n).reverse()
      const lines = rows.map(r => `${gmt8(r.ts).slice(5)} ${r.direction === 'in' ? `← ${r.user_id ?? '?'}` : '→'} ${(r.content ?? '').replace(/\s+/g, ' ').slice(0, 80)}${r.delivered ? '' : ' (未送進 worker)'}`)
      return done(lines.join('\n') || '沒有紀錄')
    }

    case 'restart':
      return done('router 重啟中', { after: () => deps.restartRouter() })

    default:
      return done(`不認得的指令: ${sub}\n${HELP}`)
  }
}
