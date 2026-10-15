// /router commands and /restart (plan 03 「router 設定指令」). Handled by the
// router itself, never forwarded to a worker. Who may run what follows the
// 指令表: owner and admin; admin may not make anyone owner nor touch an
// owner; bot token changes only in the owner's own DM.

import type { Config } from './config'
import type { Conversation, RouterDb, OverrideKind } from './db'
import type { Access } from './telegram/policy'
import type { MessageRecord } from './telegram/store'
import { gmt8 } from './context'

export const ROLES = ['owner', 'admin', 'power', 'user', 'guest'] as const

export type CommandInput = {
  bot: string; text: string; senderId: string; senderName: string; chatId: string; chatType: string
  messageId?: number
  /** The message this command replies to, if any (target for /id and role). */
  reply?: { uid: string; messageId: number }
}
/** deleteMessage: the command message carried a token; the caller deletes it
 *  and appends whether that worked to the reply. */
/** private: the reply lists other conversations or people; in a group it
 *  goes to the sender's DM instead. */
export type CommandOutput = { reply: string; private?: boolean; deleteMessage?: boolean; logs: Array<{ conv: string; text: string }>; after?: () => void }

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
    /** Run a rotation pass now (stop marked workers that are idle). */
    rotateNow(): void
  }
  /** Rewrite the conversation's settings and context file; restart the worker if it runs. */
  applySettings(c: Conversation, opts: { dropJob: boolean }): Promise<void>
  /** Permissions changed: rewrite settings/context now, rotate the worker (stop when idle). */
  applyPermissions(c: Conversation): void
  /** The effective settings the router would write for this conversation. */
  effectiveSettings(c: Conversation): any
  sendTo(bot: string, chatId: string, text: string): Promise<void>
  recentMessages(chatId: string, n: number): MessageRecord[]
  writeConfig(mutate: (raw: Record<string, unknown>) => void): void
  restartRouter(): void
  startedAt: Date
}

const COMMAND_RE = /^\/(router|restart|id|info)(?:@\w+)?(?:\s+([\s\S]*))?$/

export function isCommand(text: string | undefined): boolean {
  return !!text && COMMAND_RE.test(text.trim())
}

/** "柯姊(@Cojad)", "柯姊", "@Cojad" or the bare uid. */
export function personLabel(db: RouterDb, uid: string): string {
  const p = db.getPerson(uid)
  if (!p) return uid
  if (p.name && p.username) return `${p.name}(@${p.username})`
  return p.name ?? (p.username ? `@${p.username}` : uid)
}

/** A uid from "123", "@username" (someone the bot has seen) or null. */
export function resolveUser(db: RouterDb, arg: string | undefined): string | null {
  if (!arg) return null
  if (/^\d+$/.test(arg)) return arg
  if (arg.startsWith('@')) return db.findPersonByUsername(arg)?.uid ?? null
  return null
}

/** "0m", "25m", "1h22m", "3d4h" (minutes are the finest unit). */
export function ago(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60000))
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h${min % 60}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

/** DM title: "@Cojad:🦅 柯姊❤️ Cojad", or just the name when there is no username. */
export function dmLabel(db: RouterDb, uid: string): string {
  const p = db.getPerson(uid)
  if (!p) return uid
  if (p.username && p.name) return `@${p.username}:${p.name}`
  return p.name ?? (p.username ? `@${p.username}` : uid)
}

const STATE_ICON = { on: '🛜', off: '💤' }
const TYPE_ICON: Record<string, string> = { dm: '😀', group: '💬', channel: '📣' }
const ROLE_ICON: Record<string, string> = { owner: '🥇', admin: '🥈', power: '🥉', user: '🚻', guest: '🥷' }
const MAX_BOTS = 5

/** /router status: per bot, its conversations newest first (10 each, or 5
 *  each when that would run past 30 lines), at most 5 bots, then a legend. */
export function renderStatus(
  now: number,
  startedAt: Date,
  bots: Array<{ name: string; username: string; first_name: string }>,
  convs: Conversation[],
  o: { isConnected(key: string): boolean; label(c: Conversation): string; backlog(c: Conversation): number },
): string {
  const lastAt = (c: Conversation) => Date.parse(c.last_seen ?? c.created_at)
  const shown = bots.slice(0, MAX_BOTS)
  const per = (n: number) => shown.map(b => ({ b, list: convs.filter(c => c.bot === b.name).sort((x, y) => lastAt(y) - lastAt(x)).slice(0, n) }))
  const lineCount = (groups: ReturnType<typeof per>) => groups.reduce((n, g) => n + 2 + g.list.length, 0)
  let groups = per(10)
  if (lineCount(groups) > 30) groups = per(5)
  const out = [`router 已運作 ${ago(now - startedAt.getTime())}`]
  // "ago" is right-aligned in a column at least 6 wide ("12h34m").
  const width = Math.max(6, ...groups.flatMap(g => g.list.map(c => ago(now - lastAt(c)).length)))
  for (const { b, list } of groups) {
    out.push('', `${b.first_name}(@${b.username})`)
    if (!list.length) out.push(' (還沒有對話)')
    for (const c of list) {
      const extra = [o.backlog(c) ? `待送 ${o.backlog(c)}` : '', c.rotate_pending ? '待輪替' : ''].filter(Boolean)
      const icons = `${o.isConnected(c.key) ? STATE_ICON.on : STATE_ICON.off}${TYPE_ICON[c.type] ?? '❔'}${ROLE_ICON[c.role] ?? '❔'}`
      out.push(` ${icons} ${ago(now - lastAt(c)).padStart(width)}前: ${o.label(c)}${extra.length ? ` (${extra.join(', ')})` : ''}`)
    }
  }
  if (bots.length > MAX_BOTS) out.push('', `(另有 ${bots.length - MAX_BOTS} 隻 bot 未列出)`)
  out.push('', '說明:', ' 🛜待命中 💤已休眠', ' 😀DM 💬群組 📣頻道', ' 🥇owner 🥈admin 🥉power 🚻user 🥷guest')
  return out.join('\n')
}

export function roleOf(deps: Pick<CommandDeps, 'cfg' | 'db'>, uid: string): string {
  if (deps.cfg.owners.includes(uid)) return 'owner'
  return deps.db.getUserRole(uid) ?? 'user'
}

const HELP = [
  '/router status',
  '/router bot list | add <名稱> <token> | rotate <名稱> <token> | remove <名稱>',
  '/router role <uid|@username> <角色|none> (回覆某人的訊息時可省略對象) | role list',
  '/router chat (列出全部) | chat <chat_id> | chat [chat_id] compact <750k|1m|auto> | model <模型> | mention <on|off>',
  '/router access show | pair <code> | deny <code> | allow <uid> | remove <uid> | group add <chat_id> [--no-mention] | group rm <chat_id> | policy <pairing|allowlist|disabled>',
  '/router session restart|stop [chat_id] | rotate [chat_id|all] (閒置時停掉, 下一則訊息用新設定叫醒)',
  '/router perm [chat_id] show | role <角色> | tool allow|deny|rm <規則> | path read|write|rm <路徑> | net allow|rm <網域> | mcp allow|rm <名稱> | send allow|rm <chat_id> | reset',
  '/router config (列出全部) | get <key> | set <key> <值>',
  '/router log (所有對話) | log <chat_id> [筆數]',
  '/restart',
  '/id [@username] (回覆某則訊息時查那則): uid, 訊息編號, 對話 id',
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

  const args = m[1] === 'restart' ? ['restart']
    : m[1] === 'id' || m[1] === 'info' ? ['id', ...(m[2] ?? '').trim().split(/\s+/).filter(Boolean)]
    : (m[2] ?? '').trim().split(/\s+/).filter(Boolean)
  const sub = args[0] ?? 'help'
  const hasToken = sub === 'bot' && (args[1] === 'add' || args[1] === 'rotate') && args.length >= 4

  // /id and /info are common names; in a group they may be meant for another
  // bot, so only owner and admin get an answer (the /router refusal stays).
  if ((m[1] === 'id' || m[1] === 'info') && role !== 'owner' && role !== 'admin') return null
  if (role !== 'owner' && role !== 'admin') {
    return deny(`/${m[1] === 'restart' ? 'router' : m[1]} 只開放 owner 與 admin, 你的角色是 ${role}`, { deleteMessage: hasToken })
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
      const bots = await deps.bots.list()
      return done(renderStatus(Date.now(), deps.startedAt, bots, db.listConversations(), {
        isConnected: deps.sessions.isConnected,
        label: c => c.type === 'dm' ? dmLabel(db, c.chat_id) : (c.title ?? c.chat_id),
        backlog: c => db.undelivered(c.key).length,
      }))
    }

    case 'id': {
      // /id: this message; as a reply: that message; /id @username: that person.
      const author = (uid: string) => {
        const u = db.getPerson(uid)?.username
        return `${uid}${u ? ` [@${u}]` : ''}`
      }
      if (args[1] && !input.reply) {
        const uid = resolveUser(db, args[1])
        if (!uid) return done(`找不到 ${args[1]}: bot 還沒收過這個人的訊息, 或 username 打錯了`)
        const p = db.getPerson(uid)
        return done([`使用者ID: ${author(uid)}`, ...(p ? [`最後出現: ${gmt8(p.last_seen)}${p.last_chat_id ? `, 對話ID ${p.last_chat_id}` : ''}`] : [])].join('\n'))
      }
      const [mid, uid] = input.reply ? [input.reply.messageId, input.reply.uid] : [input.messageId, input.senderId]
      return done([...(mid != null ? [`訊息ID: ${mid}`] : []), `作者ID: ${author(uid)}`, `對話ID: ${input.chatId}`].join('\n'))
    }

    case 'bot': {
      const op = args[1]
      if (op === 'list') {
        const bots = await deps.bots.list()
        return done(bots.map(b => `${b.name}: @${b.username} (id ${b.id}, ${b.first_name})`).join('\n') || '沒有 bot', { private: true })
      }
      if (op !== 'add' && op !== 'rotate' && op !== 'remove') return done('用法: /router bot list | add <名稱> <token> | rotate <名稱> <token> | remove <名稱>')
      const inOwnerDm = role === 'owner' && input.chatType === 'private' && input.chatId === input.senderId
      if (!inOwnerDm) {
        const leaked = hasToken && input.chatType !== 'private'
        return deny(`/router bot ${op} 只能在 owner 私訊使用${leaked ? '; token 曾出現在群組, 建議 /router bot rotate' : ''}`, { deleteMessage: hasToken })
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
        return done(`${op === 'add' ? '已新增' : '已更換'} bot ${name}: @${username}`, { deleteMessage: true })
      } catch (e) {
        return done(`bot ${op} 失敗: ${e instanceof Error ? e.message : e}`, { deleteMessage: hasToken })
      }
    }

    case 'role': {
      if (args[1] === 'list') {
        const seen = new Set<string>()
        const lines: string[] = []
        for (const u of cfg.owners) { seen.add(u); lines.push(`${personLabel(db, u) === u ? u : `${personLabel(db, u)} ${u}`} owner (config)`) }
        const who = (u: string) => personLabel(db, u) === u ? u : `${personLabel(db, u)} ${u}`
        for (const u of db.listUsers()) if (!seen.has(u.uid)) lines.push(`${who(u.uid)} ${u.role}`)
        return done(lines.join('\n') || '沒有設定任何角色', { private: true })
      }
      // /router role [user] <uid|@username> <角色|none>, or as a reply: /router role [user] <角色|none>
      const rest = args.slice(1)
      if (rest[0] === 'user') rest.shift()
      let who: string | undefined, newRoleArg: string | undefined
      if (rest.length >= 2) [who, newRoleArg] = rest
      else if (rest.length === 1 && input.reply) { who = input.reply.uid; newRoleArg = rest[0] }
      if (!who || !newRoleArg) return done('用法: /router role <uid|@username> <角色|none>, 或回覆某人的訊息打 /router role <角色> | role list')
      const uid = resolveUser(db, who)
      if (!uid) return done(`找不到 ${who}: bot 還沒收過這個人的訊息, 或 username 打錯了. 也可以回覆他的訊息再下指令`)
      const newRole = newRoleArg === 'none' ? null : newRoleArg
      if (newRole && !(ROLES as readonly string[]).includes(newRole)) return done(`角色只能是 ${ROLES.join(', ')} 或 none`)
      if (cfg.owners.includes(uid)) return deny(`${personLabel(db, uid)} 是 config 指定的 owner, 要改請用 /router config set owners`)
      const current = db.getUserRole(uid)
      if (role === 'admin') {
        if (newRole === 'owner') return deny('admin 不能把角色設成 owner')
        if (current === 'owner') return deny('admin 不能異動 owner 的角色與權限')
      }
      db.setUserRole(uid, newRole)
      const label = personLabel(db, uid)
      return done(`${label === uid ? uid : `${label} (${uid})`} 的角色: ${current ?? 'user'} → ${newRole ?? 'user'}`)
    }

    case 'chat': {
      const describe = (c: Conversation) => {
        const a = deps.loadAccess()
        const mention = c.type === 'group' ? (a.groups[c.chat_id]?.requireMention === false ? 'off' : 'on') : '-'
        const title = c.type === 'dm' ? personLabel(db, c.chat_id) : c.title
        return `${c.key}${title && title !== c.chat_id ? ` (${title})` : ''}\n  chat_id ${c.chat_id}, role ${c.role}, model ${c.model ?? `${cfg.model} (預設)`}, compact ${c.compact ?? `${cfg.autoCompactWindow} (預設)`}, mention ${mention}, ${deps.sessions.isConnected(c.key) ? '待命中' : '已休眠'}${c.last_seen ? `, 最後活動 ${gmt8(c.last_seen)}` : ''}`
      }
      if (args.length === 1) return done(db.listConversations().map(describe).join('\n') || '還沒有任何對話', { private: true })
      if (args.length === 2 && /^-?\d+$/.test(args[1]!)) {
        const c = db.findConversation(input.bot, args[1]!)
        return done(c ? describe(c) : '找不到這個對話', { private: true })
      }
      const { conv, rest } = target(1)
      if (!conv) return done('找不到這個對話 (它還沒有任何訊息進來過)')
      if (role === 'admin' && conv.role === 'owner') return deny('admin 不能異動 owner 的角色與權限')
      const [key, value] = rest
      if (key === 'compact') {
        const n = parseCompact(value)
        if (n === undefined) return done('compact 要介於 100k 到 1m, 或 auto')
        const c = db.updateConversation(conv.key, { compact: n })
        if (here?.key !== c.key) logs.push({ conv: c.key, text: `${who} 把 autoCompactWindow 改成 ${n ?? cfg.autoCompactWindow}` })
        // Restarting the worker takes seconds: answer first.
        return done(`${c.key} autoCompactWindow → ${n ?? `預設 (${cfg.autoCompactWindow})`}`, { after: () => void deps.applySettings(c, { dropJob: false }) })
      }
      if (key === 'model') {
        if (!value) return done('用法: /router chat [chat_id] model <模型>')
        const c = db.updateConversation(conv.key, { model: value === 'default' ? null : value })
        if (here?.key !== c.key) logs.push({ conv: c.key, text: `${who} 把模型改成 ${c.model ?? cfg.model}` })
        return done(`${c.key} 模型 → ${c.model ?? `預設 (${cfg.model})`}, worker 重啟中`, { after: () => void deps.applySettings(c, { dropJob: true }) })
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

    case 'perm': {
      const { conv, rest } = target(1)
      if (!conv) return done('找不到這個對話 (它還沒有任何訊息進來過)')
      const [what, op, ...valueParts] = rest
      const value = valueParts.join(' ')
      const summary = (c: Conversation) => {
        const eff = deps.effectiveSettings(c) ?? {}
        const ov = db.listOverrides(c.key)
        const by = (k: string) => ov.filter(o => o.kind === k).map(o => o.value)
        const fs = eff.sandbox?.filesystem ?? {}
        return [
          `${c.key}${c.title ? ` (${c.title})` : ''}: 角色 ${c.role}`,
          `權限模式: ${eff.permissions?.defaultMode ?? '-'}, sandbox: ${eff.sandbox?.enabled ? '開' : '關'}`,
          `允許: ${(eff.permissions?.allow ?? []).join(', ') || '(無)'}`,
          `拒絕: ${(eff.permissions?.deny ?? []).join(', ') || '(無)'}`,
          ...(eff.sandbox ? [`sandbox 可讀: ${(fs.allowRead ?? []).join(', ') || '(無)'}; 可寫: ${(fs.allowWrite ?? []).join(', ') || '(資料夾本身)'}; 網域: ${(eff.sandbox.network?.allowedDomains ?? []).join(', ') || '(全擋)'}`] : []),
          `覆寫: ${ov.length ? ov.map(o => `${o.kind} ${o.value}`).join(', ') : '(無)'}`,
          `可跨對話送往: ${by('send').join(', ') || '(只限自己的對話)'}`,
        ].join('\n')
      }
      if (!what || what === 'show') return done(summary(conv), { private: true })
      if (role === 'admin' && conv.role === 'owner') return deny('admin 不能異動 owner 的角色與權限')
      const before = summary(conv)
      const changed = (note: string) => {
        const c = db.getConversation(conv.key)!
        deps.applyPermissions(c)
        if (here?.key !== c.key) logs.push({ conv: c.key, text: `${who} 調整了這個對話的權限: ${note}` })
        const after = summary(c)
        const diff = after.split('\n').filter((l, i) => l !== before.split('\n')[i])
        return done(`${c.key} ${note}\n變更:\n${diff.join('\n') || '(設定內容沒有變化)'}\nworker 閒置時會停掉, 下一則訊息套用新權限`)
      }
      if (what === 'role') {
        if (!op || !(ROLES as readonly string[]).includes(op)) return done(`用法: /router perm [chat_id] role <${ROLES.join('|')}>`)
        if (role === 'admin' && op === 'owner') return deny('admin 不能把角色設成 owner')
        db.updateConversation(conv.key, { role: op })
        return changed(`角色 ${conv.role} → ${op}`)
      }
      if (what === 'reset') {
        const n = db.clearOverrides(conv.key)
        return changed(`清掉 ${n} 筆覆寫, 回到 ${conv.role} 的預設`)
      }
      const kinds: Record<string, { add: Record<string, OverrideKind>; rm: OverrideKind[] }> = {
        tool: { add: { allow: 'tool-allow', deny: 'tool-deny' }, rm: ['tool-allow', 'tool-deny'] },
        path: { add: { read: 'path-read', write: 'path-write' }, rm: ['path-read', 'path-write'] },
        net: { add: { allow: 'net' }, rm: ['net'] },
        mcp: { add: { allow: 'mcp' }, rm: ['mcp'] },
        send: { add: { allow: 'send' }, rm: ['send'] },
      }
      const k = what ? kinds[what] : undefined
      if (!k || !op || !value) return done('用法: /router perm [chat_id] show | role <角色> | tool allow|deny|rm <規則> | path read|write|rm <路徑> | net allow|rm <網域> | mcp allow|rm <名稱> | send allow|rm <chat_id> | reset')
      if (what === 'path' && !value.startsWith('/')) return done('路徑要用絕對路徑, 例如 /x/data/shared')
      if (op === 'rm') {
        const n = db.removeOverride(conv.key, k.rm, value)
        return n ? changed(`移除 ${what} ${value}`) : done(`${conv.key} 沒有 ${what} ${value} 這筆覆寫`)
      }
      const kind = k.add[op]
      if (!kind) return done(`${what} 只能用 ${[...Object.keys(k.add), 'rm'].join(', ')}`)
      db.addOverride({ conv: conv.key, kind, value })
      return changed(`${what} ${op} ${value}`)
    }

    case 'access': {
      const a = deps.loadAccess()
      const op = args[1]
      if (!op || op === 'show') {
        const pend = Object.entries(a.pending).map(([code, p]) => `${code} ← ${p.senderId}`)
        return done([`dmPolicy: ${a.dmPolicy}`, `allowFrom: ${a.allowFrom.map(u => personLabel(db, u) === u ? u : `${personLabel(db, u)} ${u}`).join(', ') || '(空)'}`, `groups: ${Object.entries(a.groups).map(([g, p]) => `${g}${p.requireMention ? '' : ' (不需 mention)'}`).join(', ') || '(空)'}`, `pending: ${pend.join(', ') || '(無)'}`].join('\n'), { private: true })
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
      if (op === 'rotate') {
        const all = args[2] === 'all'
        const picked = all ? db.listConversations() : [target(2).conv].filter(Boolean) as Conversation[]
        if (!picked.length) return done('找不到這個對話')
        const skipped = role === 'admin' ? picked.filter(c => c.role === 'owner') : []
        const marked = picked.filter(c => !skipped.includes(c))
        for (const c of marked) db.setRotate(c.key, true)
        for (const c of marked) if (here?.key !== c.key) logs.push({ conv: c.key, text: `${who} 標記這個 worker 等待輪替` })
        const note = skipped.length ? `\n略過 ${skipped.map(c => c.key).join(', ')}: admin 不能異動 owner 的角色與權限` : ''
        return done(`已標記 ${marked.length} 個 worker 等待輪替: ${marked.map(c => c.key).join(', ') || '(無)'}\n閒置的會在一分鐘內停掉, 忙碌的等它閒置; 下一則訊息會用新的程式與設定叫醒${note}`, { after: () => deps.sessions.rotateNow() })
      }
      if (op !== 'restart' && op !== 'stop') return done('用法: /router session restart|stop [chat_id] | rotate [chat_id|all]')
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
      if (!op || op === 'show') {
        const lines = [
          `bots: ${cfg.bots.map(b => b.name).join(', ')} (token 請用 /router bot list)`,
          `owners: ${cfg.owners.join(', ')}`,
          `model: ${cfg.model}`,
          `autoCompactWindow: ${cfg.autoCompactWindow}`,
          `claudeBin: ${cfg.claudeBin}`,
          `home: ${cfg.home}`,
          `stateDir: ${cfg.stateDir}`,
          `socket: ${cfg.socket}`,
          `config: ${cfg.path}`,
        ]
        return done(lines.join('\n'), { private: true })
      }
      if (!key || !(key in CONFIG_KEYS)) return done(`可用的 key: ${Object.keys(CONFIG_KEYS).join(', ')} (bot token 請用 /router bot)`)
      const cur = (cfg as unknown as Record<string, unknown>)[key]
      if (op === 'get') return done(`${key} = ${JSON.stringify(cur)}`, { private: true })
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
      // /router log [chat_id] [筆數]: without a chat id, every conversation.
      const explicit = args[1] && /^-?\d+$/.test(args[1]) && Math.abs(Number(args[1])) > 1000
      const convs = explicit ? [db.findConversation(input.bot, args[1]!)].filter(Boolean) as Conversation[] : db.listConversations()
      if (!convs.length) return done(explicit ? '找不到這個對話' : '還沒有任何對話')
      const n = Math.min(Math.max(Number(explicit ? args[2] : args[1]) || (explicit ? 10 : 5), 1), 50)
      const fmt = (r: MessageRecord) => `${gmt8(r.ts).slice(5)} ${r.direction === 'in' ? `← ${r.user_id ?? '?'}` : '→'} ${(r.content ?? '').replace(/\s+/g, ' ').slice(0, 80)}${r.delivered ? '' : ' (未送進 worker)'}`
      const blocks = convs.map(c => {
        const rows = deps.recentMessages(c.chat_id, n).reverse()
        return `[${c.key}${c.title ? ` ${c.title}` : ''}]\n${rows.map(fmt).join('\n') || '(沒有紀錄)'}`
      })
      return done(blocks.join('\n\n'), { private: true })
    }

    case 'restart':
      return done('router 重啟中', { after: () => deps.restartRouter() })

    default:
      return done(`不認得的指令: ${sub}\n${HELP}`)
  }
}
