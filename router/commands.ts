// /router commands and /restart (plan 03 「router 設定指令」). Handled by the
// router itself, never forwarded to a worker. Who may run what follows the
// 指令表: owner and admin; admin may not make anyone owner nor touch an
// owner; bot token changes only in the owner's own DM.

import type { Config } from './config'
import type { Conversation, RouterDb, OverrideKind, UserOverrideKind } from './db'
import { allowOwners, type Access } from './telegram/policy'
import { settlePairing } from './pairing'
import type { ApprovalDeps } from './approvals'
import type { MessageRecord } from './telegram/store'
import { gmt8, maskTokens } from './context'
import { describeCreds, placementText, defaultHeadersText, parseHttpScope, parseDefaultHeader, refuseDefaultHeader, setHeader, BOT_TOKEN_FULL, httpExample, credSummary, STAGE_TTL_MS, type HttpScope, type CredStaging } from './credentials'
import { SECRET_RE, runSecretCommand, describeSecrets, describeHandles } from './secrets'
import { addedSetupText, escHtml } from './setup'
import { toolReport, KEEP_DAYS } from './toolhistory'
import { REACT_MODES, isReactMode } from './reactions'
import { parseSkillRun, SKILL_RUN_USAGE, type SkillRunOpts } from './skillcli'

export const ROLES = ['owner', 'admin', 'power', 'user', 'guest'] as const

export type CommandInput = {
  bot: string; text: string; senderId: string; senderName: string; chatId: string; chatType: string
  messageId?: number
  /** The message this command replies to, if any (target for /id and role). */
  reply?: { uid: string; messageId: number }
  /** This bot's @username: "/secret@other_bot" is not for it. */
  botUsername?: string
  /** From the terminal CLI: a chat id may be any bot's conversation. */
  terminal?: boolean
}
/** deleteMessage: the command message carried a token; the caller deletes it
 *  and appends whether that worked to the reply. */
/** private: the reply lists other conversations or people; in a group it
 *  goes to the sender's DM instead. */
/** html: the reply is written for parse_mode HTML (the bot settings notices, router/setup.ts). */
/** deleteLater: the command message carries a value and is deleted 60 seconds
 *  after the answer in a DM unless its sender, an owner or an admin cancels,
 *  10 seconds in a group with no button (rawvault scheduleCommand); without
 *  it deleteMessage deletes at once (a refusal, a wrong place).
 *  buttons go under the reply; staged: a /router cred add waiting for 覆蓋. */
export type CommandOutput = { reply: string; private?: boolean; deleteMessage?: boolean; deleteLater?: boolean; deleteLabel?: string; html?: boolean; buttons?: Array<{ text: string; data: string }>; staged?: number; logs: Array<{ conv: string; text: string }>; after?: () => void }

export interface CommandDeps {
  cfg: Config
  db: RouterDb
  loadAccess(): Access
  saveAccess(a: Access): void
  /** Where /router access pair|deny writes its outcome onto the pairing request's messages (router/pairing.ts); none in tests that do not post them. */
  pairingApprovals?: ApprovalDeps
  /** The router's journal (pairing settlements). */
  journal?(msg: string): void
  bots: {
    /** id, username, first_name are null until the bot's getMe is in (shown as 讀取中). */
    list(): Promise<Array<{ name: string; id: number | null; username: string | null; first_name: string | null; poll?: string }>>
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
  /** Overrides were removed by hand: authorizations left with none count as revoked (router/authz.ts). */
  overridesRemoved?(c: Conversation, uid: string): Promise<number>
  /** The effective settings the router would write for this conversation. */
  effectiveSettings(c: Conversation): any
  /** getMe with a token for /secret set (router/secrets.ts): "@username (id)", or throws why not. */
  verifyBot(token: string): Promise<string>
  /** What the owner should know about a bot's settings (router/setup.ts botSettingsNotice). */
  botNotice?(name: string): string
  /** Credentials for cross-bot skills (router/credentials.ts). */
  creds: {
    /** Validate with getMe (a bot token) or not at all (http), store in config.json; returns "@username (id)" or "http <網址>". */
    add(name: string, token: string, methods: string[], addedBy: string, http?: HttpScope): Promise<string>
    /** Only the value of an existing credential (getMe first for a bot token),
     *  plus default headers to set by name (http); returns its label. */
    rotate(name: string, token: string, defaultHeaders?: Record<string, string>): Promise<string>
    /** /router cred add for a name that exists: the new value until 覆蓋 or 取消 (router memory only). */
    staging: CredStaging
    /** Change a stored credential (methods, roles) or remove it (null). */
    update(name: string, change: ((c: import('./config').Credential) => void) | null): void
    /** Re-read credentials from config.json (after cred-import in the terminal). */
    reload(): number
    /** Owner: call the Bot API with a credential or one of the router's own bots. */
    call(name: string, method: string, params: Record<string, unknown>, files: Record<string, string>): Promise<unknown>
  }
  /** Privileged skill actions (router/skillrun.ts). */
  skills: {
    list(bot: string): string
    /** role: the approver's (a skill with host access or more internet ports: owner only); code: the
     *  screen's confirmation code. later: the result once the skill's Python environment is built. */
    approve(bot: string, name: string, by: string, role: string, code?: string): Promise<{ text: string; later?: Promise<string> }>
    revoke(bot: string, name: string): string
    /** Owner's terminal: one action as a conversation (router/skillcli.ts). */
    run?(conv: Conversation, o: SkillRunOpts): Promise<string>
    /** Owner's terminal: one skill's refresh actions now (router/skillcli.ts). */
    refresh?(skill: string): Promise<string>
  }
  /** First-run setup of a bot (router/setup.ts). */
  setup: {
    describe(bot: string): string
    skip(bot: string): void
    resetPersona(bot: string): void
    /** Make this chat the approvals group; the reply (HTML: it ends with the bot settings notice) says what happened or what is missing. */
    group(bot: string, chatId: string): Promise<string>
  }
  sendTo(bot: string, chatId: string, text: string): Promise<void>
  /** /router status's last lines: how privileged sandboxes are limited, the toolbox (router/sandboxlimits.ts, router/toolbox.ts). */
  sandboxStatus?(): string
  /** Whether the bot is an administrator of a group (getChatMember); null when Telegram could not say. Groups send reactions to admins only. */
  botIsAdmin?(bot: string, chatId: string): Promise<boolean | null>
  /** Plan 10e: the plaintext of a masked event into a 600 file (terminal only); returns what to print. */
  events?: { rawToFile(id: number): Promise<string> }
  /** Tool call classifier, stage 1 (router/classifier.ts): the comparison report and one record. */
  classifier?: { report(days: number, qv?: number): string; show(id: number): string }
  /** A bot's messages in a chat (each bot keeps its own: router/telegram/store.ts). */
  recentMessages(bot: string, chatId: string, n: number): MessageRecord[]
  writeConfig(mutate: (raw: Record<string, unknown>) => void): void
  restartRouter(): void
  startedAt: Date
}

const COMMAND_RE = /^\/(router|restart|id|info)(?:@\w+)?(?:\s+([\s\S]*))?$/

export function isCommand(text: string | undefined): boolean {
  return !!text && (COMMAND_RE.test(text.trim()) || SECRET_RE.test(text.trim()))
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
  bots: Array<{ name: string; username: string | null; first_name: string | null; poll?: string }>,
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
    // each bot's polling: 收訊中, 重試中 (since when, why), token 失效 (router/pollnotice.ts)
    out.push('', `${b.username ? `${b.first_name}(@${b.username})` : `${b.name} (讀取中)`}${b.poll ? ` ${b.poll}` : ''}`)
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
  '/router chat (列出全部) | chat <chat_id> | chat [chat_id] compact <750k|1m|auto> | model <模型> | mention <on|off> | react <all|botself_only|disable|default>',
  '/router access show | pair <code> | deny <code> | allow <uid> | remove <uid> | group add <chat_id> [--no-mention] | group rm <chat_id> | policy <pairing|allowlist|disabled>',
  '/router session restart|stop [chat_id] | rotate [chat_id|all] (閒置時停掉, 下一則訊息用新設定叫醒)',
  '/router perm [chat_id] show | role <角色> (私訊等同 /router role) | tool allow|deny|rm <規則> | path read|write|rm <路徑> | net allow|rm <網域> | mcp allow|rm <名稱> | send allow|rm <chat_id> | pkg allow|rm <pypi|npm:名稱> | reset',
  '/router perm user <uid|@username> show | tool|path|net|mcp ... | reset (掛在使用者身上的覆寫: 他發起的一輪重算高風險工具, 他的私訊也套用)',
  '/router setup (這隻 bot 的設定狀態) | setup group (在開了話題的群組裡下, 設為審核群組) | setup skip (通知與申請改私訊 owner) | setup persona (下次私訊重新做人設訪談)',
  '/router skill list | approve <技能> [確認碼] | revoke <技能> (技能的特權動作: 核准後 user 與 power 對話也能執行, 憑證不外流; 有要再看一眼的宣告或套件時先回確認畫面, 照畫面帶確認碼再核准一次) | run <對話> <技能> <動作> --out <資料夾> [--role <角色>] [--trial | --trial-store <資料夾>] [--api <本機網址>] [JSON 參數] | refresh <技能> (run 與 refresh 只在 owner 的終端機: 驗收用)',
  '/router cred list | add <名稱> <bot token> [方法...] | add <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [--default-header <名稱>:<值>]... [路徑...] | rotate <名稱> <新的 key> [--default-header <名稱>:<值>]... (add 與 rotate 只在 owner 或 admin 自己的私訊) | header <名稱> [set <標頭>:<值> | rm <標頭>] (不帶參數就列出預設標頭) | allow|disallow <名稱> <方法或路徑...> | roles <名稱> <角色,...> | rm <名稱> | reload',
  '/router secret list [chat_id] (不寫就列出所有有密鑰的對話) | rm <chat_id> [名稱] (不寫名稱就全部移除): 各對話用 /secret 登記的密鑰',
  '/router secret handles [chat_id] (原文請求發出的密鑰代號, 不寫就列出全部) | revoke <代號>',
  '/router event raw <event id> (只在終端機: 遮蔽過的原始 update 明文寫進權限 600 的檔案, 只印路徑)',
  '/router botapi <憑證或 bot 名稱> <方法> <JSON 參數> [--file 欄位=/路徑] (只限 owner)',
  '/router classifier [天數] [v1|v2] (工具呼叫分類器的比較報表, 預設 7 天; v1/v2 只看某一版題目) | classifier show <編號> (只限 owner)',
  '/router tools [天數 1~30] (工具呼叫統計: 依工具與對話角色計次, 含提權與被擋, 預設 7 天)',
  '/router config (列出全部) | get <key> | set <key> <值>',
  '/router log (所有對話) | log <chat_id> [筆數]',
  '/restart',
  '/id [@username] (回覆某則訊息時查那則): uid, 訊息編號, 對話 id',
  '/router help <主題>: 完整用法與範例, 主題: cred, secret, perm, bot',
  '指定對話的 chat_id 也可以寫對話 key (例如 router-dm-123, /router chat 列表的第一欄); chat_id 預設指這隻 bot 的對話, 加 --bot <名稱> 指別隻 bot; 終端機會找所有 bot, 多隻都有時要加 --bot',
].join('\n')

const CRED_ADD_USAGE = '/router cred add <名稱 (小寫英數)> <bot token> [方法...] 或 /router cred add <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [--default-header <名稱>:<值>]... [路徑...]'
const CRED_ROTATE_USAGE = '/router cred rotate <名稱> <新的 key 或 token> [--default-header <名稱>:<值>]... (只換值, 網址, 標頭, 路徑, 角色不變; bot token 先用 getMe 驗證)'
const CRED_HEADER_USAGE = '/router cred header <名稱> (列出) | /router cred header <名稱> set <標頭>:<值> (同名就更新) | /router cred header <名稱> rm <標頭> (http 憑證的預設標頭, 不用重貼 key)'

/** /router help <主題>: full usage with examples. */
export const HELP_TOPICS: Record<string, string> = {
  cred: [
    '全域憑證 /router cred: 存在 router 設定檔 (config.json), 給 owner 與 admin 角色的對話 (可用 roles 放寬) 透過工具使用; worker 只拿到名稱, 看不到值.',
    '',
    '在哪裡打: add 與 rotate 只能在你 (owner 或 admin) 自己和 bot 的私訊. router 自己處理, 不會進 worker; 含 key 的那則訊息 60 秒後刪除, router 會回一則提示附「取消刪除」按鈕 (你, owner, admin 能按, 按了就保留). 在群組打會被拒絕並立刻刪除, 值已外流, 請換一把新的.',
    '',
    '一般 API key (用 http_api 工具):',
    '/router cred add <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [路徑...]',
    '- 只能呼叫 --http 的網址 (同一個 host); 沒寫路徑就是那個網址底下全部路徑, 寫了就只開放那些 (結尾 * 代表前綴)',
    '- key 預設放在 Authorization: Bearer <key>; --header x-api-key 改放進那個標頭且不加前綴; --scheme Token 改前綴 (none: 不加); --query key 改放在網址的 ?key=',
    '- worker 呼叫時可以自帶其他標頭 (例如 anthropic-version, x-csrf-token), 但不能帶 key 所在的標頭, Authorization, Proxy-Authorization, Cookie, 也不能改寫 --query 的那個參數',
    '- --default-header <名稱>:<值> (可多次): worker 沒帶同名標頭時 router 自動補上, worker 有帶就用 worker 的; 一樣不能是 key 所在的標頭或上面那些被擋的標頭',
    '範例:',
    'Anthropic: /router cred add anthropic sk-ant-... --http https://api.anthropic.com --header x-api-key --default-header anthropic-version:2023-06-01',
    '  (沒加 --default-header 時, worker 呼叫要自帶 anthropic-version: 2023-06-01)',
    'OpenAI: /router cred add openai sk-... --http https://api.openai.com /v1/chat/completions /v1/images/*',
    'Google: /router cred add gemini AIza... --http https://generativelanguage.googleapis.com --header x-goog-api-key',
    '',
    'Telegram bot token (用 bot_api 工具, 操作另一隻 bot):',
    '/router cred add <名稱> <bot token> [方法...]',
    '- 先用 getMe 驗證; 不像 bot token (數字:35 字元) 的值不會拿去 Telegram, 會提示改加 --http',
    '- 沒寫方法就還沒開放任何方法, 用 allow 加入',
    '範例: /router cred add eagle 123456789:AA... addStickerToSet getStickerSet',
    '',
    '換 key: ' + CRED_ROTATE_USAGE,
    '範例: /router cred rotate anthropic sk-ant-...',
    '預設標頭: ' + CRED_HEADER_USAGE,
    '範例: /router cred header anthropic set anthropic-version:2023-06-01',
    '',
    '管理: /router cred list (不顯示值, 顯示預設標頭) | allow|disallow <名稱> <方法或路徑...> | roles <名稱> <角色,...> (預設 owner, admin) | rm <名稱> | reload',
    'rotate, header, allow, disallow, roles, rm: owner, 或加入它的 admin.',
    '同名再 add 一次不會直接取代: router 回覆現有設定 (不含值) 與「覆蓋 / 取消」按鈕, 新的值只暫存在 router 記憶體 2 分鐘, 逾時或取消就丟棄; 按覆蓋才用這次 add 的設定整個取代. 別人 (admin) 加入的同名憑證只有 owner 能取代.',
    '終端機: cc-telegram-router cred-import <名稱> <env 檔> <變數> [方法或路徑,...] [--http <網址> --header ... --scheme ... --query ... --default-header <名稱>:<值>] (值從檔案讀, 不印出)',
    '',
    '跟 /secret 的差別: /router help secret',
  ].join('\n'),
  secret: [
    '兩種存 key 的地方:',
    '- /secret (對話密鑰): 只屬於打指令的那個對話, 任何角色都能登記 (群組裡任何成員), 不用授權, 加密存在 router.db. 適合這個對話自己要用的 key.',
    '- /router cred (全域憑證): owner 或 admin 在自己私訊登記, 存在 router 設定檔, 預設給 owner 與 admin 角色的對話用, 可用 roles 放寬. 適合整隻 bot 或技能共用的 key.',
    'worker 都用 bot_api / http_api 工具, credential 填名稱 (先找對話密鑰, 再找全域憑證); 值不會進 worker, 回應裡出現的值換成 <密鑰>.',
    '',
    '在哪裡打: 要用 key 的那個對話 (私訊或群組). router 自己處理, 不會進 worker; 私訊裡那則訊息 60 秒後刪除, router 會回一則提示附「取消刪除」按鈕 (發訊者, owner, admin 能按); 群組裡 10 秒後刪除, 不給取消按鈕, bot 沒有刪除權限會提醒你自己刪. 被拒的立刻刪除.',
    '',
    '/secret set <名稱> <bot token> [方法...] (getMe 驗證, 沒寫方法就是全部)',
    '/secret set <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [--default-header <名稱>:<值>]... [路徑...] (沒寫路徑就是全部; --default-header: worker 沒帶同名標頭時 router 補上)',
    '範例: /secret set anthropic sk-ant-... --http https://api.anthropic.com --header x-api-key --default-header anthropic-version:2023-06-01',
    '/secret list | rm <名稱> | handles | revoke <代號>',
    '/secret header <名稱> (列出) | header <名稱> set <標頭>:<值> (同名就更新) | header <名稱> rm <標頭>: http 密鑰的預設標頭, 不用重貼 key',
    'owner 與 admin: /router secret list [chat_id] | rm <chat_id> [名稱] | handles [chat_id] | revoke <代號>',
    '',
    '偵測: 訊息開頭就是 /secret set, /router cred add|rotate, /router bot add|rotate 時, 參數位置的值當成密鑰; 句子中間提到指令名稱不算. 其他地方只認 sk-ant-, sk-, bot token 這類格式與已登記的值.',
  ].join('\n'),
  perm: [
    '/router perm [chat_id] show: 看對話的角色與權限覆寫',
    '/router perm [chat_id] role <角色>: 改對話角色 (私訊等同 /router role, 改那位使用者的角色)',
    '/router perm [chat_id] tool allow|deny|rm <規則>: 例如 tool allow Bash(python3 *), tool deny WebFetch',
    '/router perm [chat_id] path read|write|rm <路徑>: 例如 path read /srv/data',
    '/router perm [chat_id] net allow|rm <網域>: 例如 net allow api.example.com',
    '/router perm [chat_id] mcp allow|rm <名稱>',
    '/router perm [chat_id] send allow|rm <chat_id>: 允許傳訊到別的對話 (* 代表 bot 所在的任何對話)',
    '/router perm [chat_id] pkg allow|rm <pypi|npm:名稱>: 套件不用審核 (* 代表 PyPI 與 npm 全部)',
    '/router perm [chat_id] reset: 清掉覆寫',
    '/router perm user <uid|@username> show | tool|path|net|mcp ... | reset: 掛在使用者身上的覆寫, 他發起的一輪重算高風險工具時套用, 他的私訊也套用',
    '覆寫只增加 allow, deny, 路徑與網域, 拒絕規則永遠優先; 改了之後 worker 閒置時重啟套用. chat_id 省略就是目前這個對話.',
  ].join('\n'),
  bot: [
    '/router bot list: 列出 bot',
    '/router bot add <名稱> <bot token>: 新增一隻 bot (只限 owner 私訊, 含 token 的訊息 60 秒後刪除, 可按「取消刪除」保留)',
    '/router bot rotate <名稱> <bot token>: 換 token (只限 owner 私訊, 同上)',
    '/router bot remove <名稱>',
    '這是 router 自己收發訊息的 bot; 給技能操作另一隻 bot 的 token 用 /router cred add (見 /router help cred).',
  ].join('\n'),
}

/** /router perm <what> <op> <value>: the override kind each op adds, and the kinds rm removes. */
const PERM_KINDS: Record<string, { add: Record<string, OverrideKind>; rm: OverrideKind[] }> = {
  tool: { add: { allow: 'tool-allow', deny: 'tool-deny' }, rm: ['tool-allow', 'tool-deny'] },
  path: { add: { read: 'path-read', write: 'path-write' }, rm: ['path-read', 'path-write'] },
  net: { add: { allow: 'net' }, rm: ['net'] },
  mcp: { add: { allow: 'mcp' }, rm: ['mcp'] },
  send: { add: { allow: 'send' }, rm: ['send'] },
  pkg: { add: { allow: 'pkg' }, rm: ['pkg'] },
}
/** The ones a user's own overrides take (/router perm user): they go into settings; send and pkg are the router's, per conversation. */
const USER_PERM = ['tool', 'path', 'net', 'mcp']
const PERM_USER_USAGE = '用法: /router perm user <uid|@username> show | tool allow|deny|rm <規則> | path read|write|rm <路徑> | net allow|rm <網域> | mcp allow|rm <名稱> | reset'

const CONFIG_KEYS: Record<string, 'string' | 'number' | 'list'> = { model: 'string', autoCompactWindow: 'number', claudeBin: 'string', owners: 'list' }

function parseCompact(v: string | undefined): number | null | undefined {
  if (!v) return undefined
  if (v === 'auto' || v === 'default') return null
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(v)
  if (!m) return undefined
  const n = Number(m[1]) * (m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1000 : 1)
  return n >= 100_000 && n <= 1_000_000 ? Math.round(n) : undefined
}

/** The reply for a credential just stored (cred add, or 覆蓋). */
function addedText(name: string, label: string, methods: string[], http?: HttpScope): string {
  return [
    `已加入憑證 ${name}: ${label}${http ? `${placementText(http)}${defaultHeadersText(http.defaultHeaders)}` : ''}`,
    `${http ? '路徑' : '方法'}: ${methods.length === 1 && methods[0] === '*' ? '全部' : methods.join(', ') || '(還沒有, 用 /router cred allow 加入)'}`,
    '角色: owner, admin',
    `${http ? 'API key' : 'token'} 只存在 router 設定檔, worker 用 ${http ? 'http_api' : 'bot_api'} 工具使用`,
  ].join('\n')
}

/** 覆蓋 / 取消 under a /router cred add for a name that exists (credow:<id>:ok|cancel).
 *  Only the sender decides; 覆蓋 checks the role again and stores this add's
 *  settings in place of the old ones. text: the question message's new text
 *  (null: leave it). */
export async function decideCredOverwrite(data: string, uid: string, deps: Pick<CommandDeps, 'cfg' | 'db' | 'creds'>): Promise<{ answer: string; text: string | null }> {
  const m = /^credow:(\d+):(ok|cancel)$/.exec(data)
  const id = m ? Number(m[1]) : -1
  const s = deps.creds.staging.peek(id)
  if (!s) return { answer: '已逾時或處理過, 新的值已丟棄', text: '已逾時或處理過, 沒有覆蓋, 新的值已丟棄. 要覆蓋請重新 /router cred add' }
  if (uid !== s.addedBy) return { answer: '只有下指令的人能決定', text: null }
  deps.creds.staging.take(id)
  if (m![2] === 'cancel') return { answer: '已取消', text: `已取消, 沒有覆蓋憑證 ${s.name}, 新的值已丟棄` }
  const role = roleOf(deps, uid)
  const old = deps.cfg.credentials?.[s.name]
  if (role !== 'owner' && (role !== 'admin' || (old && old.addedBy !== uid))) return { answer: '權限不足', text: `⛔ 沒有覆蓋憑證 ${s.name}: 只有 owner, 或加入它的 admin 能取代; 新的值已丟棄` }
  try {
    const label = await deps.creds.add(s.name, s.token, s.methods, uid, s.http)
    return { answer: '已覆蓋', text: `已覆蓋. ${addedText(s.name, label, s.methods, s.http)}` }
  } catch (e) {
    return { answer: '覆蓋失敗', text: `覆蓋失敗, 沒有更動憑證 ${s.name}: ${e instanceof Error ? e.message : e}` }
  }
}

export async function runCommand(input: CommandInput, deps: CommandDeps): Promise<CommandOutput | null> {
  // /secret: any role, in any chat the router serves (router/secrets.ts)
  if (SECRET_RE.test(input.text.trim())) return runSecretCommand(input, deps)
  const m = COMMAND_RE.exec(input.text.trim())
  if (!m) return null
  const { cfg, db } = deps
  const role = roleOf(deps, input.senderId)
  const here = db.findConversation(input.bot, input.chatId)
  const cmdText = input.text.trim()
  const logs: Array<{ conv: string; text: string }> = []
  const who = `${input.senderName}(${role})`
  // the log reaches the worker: never with a token or API key in it
  const words = cmdText.split(/\s+/)
  const secretAt = /^\/router(@\w+)?$/.test(words[0] ?? '') && ((words[1] === 'cred' && (words[2] === 'add' || words[2] === 'rotate')) || (words[1] === 'bot' && (words[2] === 'add' || words[2] === 'rotate'))) ? 4 : -1
  const shown = secretAt > 0 && words[secretAt] ? words.map((w, i) => i === secretAt ? '<已遮蔽>' : w).join(' ') : cmdText
  const done = (reply: string, extra: Partial<CommandOutput> = {}): CommandOutput => {
    if (here) logs.push({ conv: here.key, text: `${who} ${shown} → ${reply.split('\n')[0]}` })
    return { reply, logs, ...extra }
  }
  const deny = (reason: string, extra: Partial<CommandOutput> = {}) => done(`⛔ ${reason}`, extra)

  const args = m[1] === 'restart' ? ['restart']
    : m[1] === 'id' || m[1] === 'info' ? ['id', ...(m[2] ?? '').trim().split(/\s+/).filter(Boolean)]
    : (m[2] ?? '').trim().split(/\s+/).filter(Boolean)
  // --bot <名稱>: which bot's conversation a chat id means
  let botOpt: string | undefined
  { const at = args.indexOf('--bot'); if (at > 0) { botOpt = args[at + 1]; args.splice(at, 2) } }
  const sub = args[0] ?? 'help'
  const hasToken = (sub === 'bot' && (args[1] === 'add' || args[1] === 'rotate') && args.length >= 4) || (sub === 'cred' && (args[1] === 'add' || args[1] === 'rotate') && args.length >= 4)

  // /id and /info are common names; in a group they may be meant for another
  // bot, so only owner and admin get an answer (the /router refusal stays).
  if ((m[1] === 'id' || m[1] === 'info') && role !== 'owner' && role !== 'admin') return null
  if (role !== 'owner' && role !== 'admin') {
    return deny(`/${m[1] === 'restart' ? 'router' : m[1]} 只開放 owner 與 admin, 你的角色是 ${role}`, { deleteMessage: hasToken })
  }

  /** A conversation named in a command: a conversation key (any bot), or a
   *  chat id. In Telegram a chat id is this bot's (or --bot's) chat; from the
   *  terminal it is the only bot that has it, and several ask for --bot. */
  const isChatRef = (a: string | undefined) => !!a && (/^-?\d+$/.test(a) || !!db.getConversation(a))
  const findChat = (ref: string): { conv: Conversation | null; error?: string } => {
    if (!/^-?\d+$/.test(ref)) return { conv: db.getConversation(ref) }
    if (botOpt) return cfg.bots.some(b => b.name === botOpt) ? { conv: db.findConversation(botOpt, ref) } : { conv: null, error: `沒有名為 ${botOpt} 的 bot (${cfg.bots.map(b => b.name).join(', ')})` }
    if (!input.terminal) return { conv: db.findConversation(input.bot, ref) }
    const all = db.listConversations().filter(c => c.chat_id === ref)
    if (all.length > 1) return { conv: null, error: `${ref} 在 ${all.length} 隻 bot 都有對話, 請加 --bot <名稱> 或改用對話 key: ${all.map(c => `${c.key} (bot ${c.bot})`).join(', ')}` }
    return { conv: all[0] ?? null }
  }
  /** A user's role changed: their DMs (every bot) get new settings, rotated in when idle. */
  const dmsFollow = (changed: Conversation[]) => {
    for (const c of changed) {
      deps.applyPermissions(c)
      if (here?.key !== c.key) logs.push({ conv: c.key, text: `${who} 把這個私訊的使用者角色改成 ${c.role}` })
    }
    return changed.length ? `\n私訊 ${changed.map(c => c.key).join(', ')} 的 worker 閒置時會停掉, 下一則訊息套用新角色` : ''
  }
  /** A new owner reaches the bot in a DM without pairing: into access.json's allowFrom (the DM gate reads only that). */
  const ownersAllowed = (uids: string[]): string => {
    const a = deps.loadAccess()
    const added = allowOwners(a, uids)
    if (!added.length) return ''
    deps.saveAccess(a)
    return `\n${added.join(', ')} 加入 access.json 的 allowFrom, 私訊不用配對`
  }
  /** /router role, and /router perm <私訊> role: same checks, same effect. */
  const setRole = (uid: string, newRole: string | null, prefix = ''): CommandOutput => {
    if (cfg.owners.includes(uid)) return deny(`${prefix}${personLabel(db, uid)} 是 config 指定的 owner, 要改請用 /router config set owners`)
    const current = db.getUserRole(uid)
    if (role === 'admin') {
      if (newRole === 'owner') return deny(`${prefix}admin 不能把角色設成 owner`)
      if (current === 'owner') return deny(`${prefix}admin 不能異動 owner 的角色與權限`)
    }
    const changed = db.setUserRole(uid, newRole)
    const label = personLabel(db, uid)
    return done(`${prefix}${label === uid ? uid : `${label} (${uid})`} 的角色: ${current ?? 'user'} → ${newRole ?? 'user'}${newRole === 'owner' ? ownersAllowed([uid]) : ''}${dmsFollow(changed)}`)
  }
  /** Optional leading conversation; defaults to the current chat. */
  const target = (i: number): { conv: Conversation | null; rest: string[]; error?: string } => {
    if (isChatRef(args[i])) return { ...findChat(args[i]!), rest: args.slice(i + 1) }
    return { conv: here, rest: args.slice(i) }
  }

  switch (sub) {
    case 'help': {
      const topic = args[1]?.toLowerCase()
      if (!topic) return done(HELP)
      return done(HELP_TOPICS[topic] ?? `沒有 ${topic} 這個主題, 主題: ${Object.keys(HELP_TOPICS).join(', ')}\n\n${HELP}`)
    }

    case 'status': {
      const bots = await deps.bots.list()
      return done(renderStatus(Date.now(), deps.startedAt, bots, db.listConversations(), {
        isConnected: deps.sessions.isConnected,
        label: c => c.type === 'dm' ? dmLabel(db, c.chat_id) : (c.title ?? c.chat_id),
        backlog: c => db.undelivered(c.key).length,
      }) + (deps.sandboxStatus ? `\n\n特權技能的沙箱:\n${deps.sandboxStatus()}` : ''))
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
        return done(bots.map(b => b.username ? `${b.name}: @${b.username} (id ${b.id}, ${b.first_name})` : `${b.name}: 讀取中 (bot 資訊還沒取得, 稍後再試)`).join('\n') || '沒有 bot', { private: true })
      }
      if (op !== 'add' && op !== 'rotate' && op !== 'remove') return done('用法: /router bot list | add <名稱> <token> | rotate <名稱> <token> | remove <名稱>')
      const inOwnerDm = role === 'owner' && input.chatType === 'private' && input.chatId === input.senderId
      if (!inOwnerDm) {
        const leaked = hasToken && input.chatType !== 'private'
        return deny(`/router bot ${op} 只能在 owner 私訊使用${leaked ? '; token 曾出現在群組, 建議 /router bot rotate' : ''}`, { deleteMessage: hasToken })
      }
      const name = args[2]
      // in the owner's DM a message with the token is deleted 60 seconds after the answer unless the owner cancels
      const later = { deleteMessage: hasToken, deleteLater: true }
      if (!name) return done(`用法: /router bot ${op} <名稱>${op === 'remove' ? '' : ' <token>'}`, later)
      try {
        if (op === 'remove') {
          await deps.bots.remove(name)
          return done(`已移除 bot ${name}`)
        }
        const token = args[3]
        if (!token) return done(`用法: /router bot ${op} <名稱> <token>`)
        const username = op === 'add' ? await deps.bots.add(name, token) : await deps.bots.rotate(name, token)
        const notice = op === 'add' ? deps.botNotice?.(name) : undefined
        const said = op === 'add' ? `已新增 bot ${name}: @${username}\n${addedSetupText(username, db.getBotSetup(name))}` : `已更換 bot ${name}: @${username}`
        // the settings notice is HTML (bold): the rest of the reply is escaped around it
        return notice ? done(`${escHtml(said)}\n\n${notice}`, { ...later, html: true }) : done(said, later)
      } catch (e) {
        return done(`bot ${op} 失敗: ${e instanceof Error ? e.message : e}`, later)
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
      return setRole(uid, newRole)
    }

    case 'chat': {
      // receiveReact: in a group Telegram sends reactions only when the bot is an administrator there
      const adminNote = async (c: Conversation): Promise<string | null> => {
        if (c.type !== 'group' || (c.react ?? cfg.receiveReact) === 'disable' || !deps.botIsAdmin) return null
        const admin = await deps.botIsAdmin(c.bot, c.chat_id).catch(() => null)
        return admin === false ? '收不到 reaction (bot 不是管理員)' : admin === null ? '查不到 bot 是否為管理員' : null
      }
      const reactOf = async (c: Conversation) => {
        const note = await adminNote(c)
        return `${c.react ?? `${cfg.receiveReact} (預設)`}${note ? `, ${note}` : ''}`
      }
      const describe = async (c: Conversation) => {
        const a = deps.loadAccess()
        const mention = c.type === 'group' ? (a.groups[c.chat_id]?.requireMention === false ? 'off' : 'on') : '-'
        const title = c.type === 'dm' ? personLabel(db, c.chat_id) : c.title
        return `${c.key}${title && title !== c.chat_id ? ` (${title})` : ''}\n  chat_id ${c.chat_id}, role ${c.role}${c.type === 'dm' ? ' (使用者角色)' : ''}, model ${c.model ?? `${cfg.model} (預設)`}, compact ${c.compact ?? `${cfg.autoCompactWindow} (預設)`}, mention ${mention}, react ${await reactOf(c)}, ${deps.sessions.isConnected(c.key) ? '待命中' : '已休眠'}${c.last_seen ? `, 最後活動 ${gmt8(c.last_seen)}` : ''}`
      }
      if (args.length === 1) return done((await Promise.all(db.listConversations().map(describe))).join('\n') || '還沒有任何對話', { private: true })
      if (args.length === 2 && isChatRef(args[1])) {
        const { conv: c, error } = findChat(args[1]!)
        return done(c ? await describe(c) : error ?? '找不到這個對話', { private: true })
      }
      const { conv, rest, error } = target(1)
      if (!conv) return done(error ?? '找不到這個對話 (它還沒有任何訊息進來過)')
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
      if (key === 'react') {
        if (value !== 'default' && !isReactMode(value)) return done(`用法: /router chat [chat_id] react <${REACT_MODES.join('|')}|default>`)
        const c = db.setReact(conv.key, value === 'default' ? null : value)
        const mode = c.react ?? `預設 (${cfg.receiveReact})`
        if (here?.key !== c.key) logs.push({ conv: c.key, text: `${who} 把表情回應的接收改成 ${c.react ?? cfg.receiveReact}` })
        const note = await adminNote(c)
        return done(`${c.key} react → ${mode}${note ? `\n⚠️ ${note}` : ''}`)
      }
      return done('用法: /router chat [chat_id] compact|model|mention|react <值>')
    }

    case 'perm': {
      // overrides on a person rather than a conversation (docs/permissions.md 使用者覆寫)
      if (args[1] === 'user') {
        const [ref, what, op, ...valueParts] = args.slice(2)
        if (!ref) return done(PERM_USER_USAGE)
        const uid = resolveUser(db, ref)
        if (!uid) return done(`找不到 ${ref}: bot 還沒收過這個人的訊息, 或 username 打錯了`)
        const value = valueParts.join(' ')
        const label = personLabel(db, uid) === uid ? uid : `${personLabel(db, uid)} (${uid})`
        const userRole = roleOf(deps, uid)
        const dms = db.listConversations().filter(c => c.type === 'dm' && c.chat_id === uid)
        const list = () => db.listUserOverrides(uid).map(o => `${o.kind} ${o.value}`).join(', ') || '(無)'
        if (!what || what === 'show') return done([
          `${label}: 角色 ${userRole}`,
          `使用者覆寫: ${list()}`,
          `生效: 他發起的一輪 (這一輪所有發話者都要有權限), 在任何對話用他的角色加這些覆寫重算高風險工具, 夠了就直接放行; 他的私訊${dms.length ? ` ${dms.map(c => c.key).join(', ')}` : ''} 的設定也套用. 群組裡路徑與網域覆寫不會改變 worker 的 sandbox.`,
        ].join('\n'), { private: true })
        if (role === 'admin' && userRole === 'owner') return deny('admin 不能異動 owner 的角色與權限')
        const changed = (note: string) => {
          for (const c of dms) {
            deps.applyPermissions(c)
            if (here?.key !== c.key) logs.push({ conv: c.key, text: `${who} 調整了這個私訊使用者的權限: ${note}` })
          }
          return done(`${label} ${note}\n使用者覆寫: ${list()}${dms.length ? `\n私訊 ${dms.map(c => c.key).join(', ')} 的 worker 閒置時會停掉, 下一則訊息套用新權限` : ''}`)
        }
        if (what === 'reset') return changed(`清掉 ${db.clearUserOverrides(uid)} 筆使用者覆寫`)
        if (what === 'send' || what === 'pkg') return done(`${what} 是 router 依對話把關的, 只能掛在對話上: /router perm [chat_id] ${what} ...`)
        const k = USER_PERM.includes(what) ? PERM_KINDS[what] : undefined
        if (!k || !op || !value) return done(PERM_USER_USAGE)
        if (what === 'path' && !value.startsWith('/')) return done('路徑要用絕對路徑, 例如 /srv/data/shared')
        if (op === 'rm') {
          if (!db.removeUserOverride(uid, k.rm as UserOverrideKind[], value)) return done(`${label} 沒有 ${what} ${value} 這筆使用者覆寫`)
          return changed(`移除 ${what} ${value}`)
        }
        const kind = k.add[op]
        if (!kind) return done(`${what} 只能用 ${[...Object.keys(k.add), 'rm'].join(', ')}`)
        db.addUserOverride(uid, kind as UserOverrideKind, value)
        return changed(`${what} ${op} ${value}`)
      }
      const { conv, rest, error } = target(1)
      if (!conv) return done(error ?? '找不到這個對話 (它還沒有任何訊息進來過)')
      const [what, op, ...valueParts] = rest
      const value = valueParts.join(' ')
      const summary = (c: Conversation) => {
        const eff = deps.effectiveSettings(c) ?? {}
        const ov = db.listOverrides(c.key)
        const by = (k: string) => ov.filter(o => o.kind === k).map(o => o.value)
        const fs = eff.sandbox?.filesystem ?? {}
        return [
          `${c.key}${c.title ? ` (${c.title})` : ''}: 角色 ${c.role}${c.type === 'dm' ? ` (使用者 ${c.chat_id} 的角色, 用 /router role 改)` : ''}`,
          `權限模式: ${eff.permissions?.defaultMode ?? '-'}, sandbox: ${eff.sandbox?.enabled ? '開' : '關'}`,
          `允許: ${(eff.permissions?.allow ?? []).join(', ') || '(無)'}`,
          `拒絕: ${(eff.permissions?.deny ?? []).join(', ') || '(無)'}`,
          ...(eff.sandbox ? [`sandbox 可讀: ${(fs.allowRead ?? []).join(', ') || '(無)'}; 可寫: ${(fs.allowWrite ?? []).join(', ') || '(資料夾本身)'}; 網域: ${(eff.sandbox.network?.allowedDomains ?? []).join(', ') || '(全擋)'}`] : []),
          `覆寫: ${ov.length ? ov.map(o => `${o.kind} ${o.value}`).join(', ') : '(無)'}`,
          ...(c.type === 'dm' ? [`使用者覆寫 (/router perm user ${c.chat_id}): ${db.listUserOverrides(c.chat_id).map(o => `${o.kind} ${o.value}`).join(', ') || '(無)'}`] : []),
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
        if (conv.type === 'dm') {
          // a DM has no role of its own: it is the user's role (docs/permissions.md 角色)
          if (!/^\d+$/.test(conv.chat_id)) return deny(`${conv.key} 是私訊, 角色跟著使用者走, 但對應不到使用者 (chat_id ${conv.chat_id}); 請改用 /router role <uid|@username> <角色>`)
          return setRole(conv.chat_id, op, `${conv.key} 是私訊, 角色跟著使用者走, 這個指令改為設定使用者角色 (等同 /router role ${conv.chat_id} ${op})\n`)
        }
        if (role === 'admin' && op === 'owner') return deny('admin 不能把角色設成 owner')
        db.updateConversation(conv.key, { role: op })
        return changed(`角色 ${conv.role} → ${op}`)
      }
      if (what === 'reset') {
        const n = db.clearOverrides(conv.key)
        const revoked = await deps.overridesRemoved?.(conv, input.senderId) ?? 0
        return changed(`清掉 ${n} 筆覆寫, 回到 ${conv.role} 的預設${revoked ? `; ${revoked} 筆審核授權一併標為已撤銷` : ''}`)
      }
      const k = what ? PERM_KINDS[what] : undefined
      if (!k || !op || !value) return done('用法: /router perm [chat_id] show | role <角色> | tool allow|deny|rm <規則> | path read|write|rm <路徑> | net allow|rm <網域> | mcp allow|rm <名稱> | send allow|rm <chat_id> | pkg allow|rm <pypi|npm:名稱> | reset')
      if (what === 'path' && !value.startsWith('/')) return done('路徑要用絕對路徑, 例如 /srv/data/shared')
      if (what === 'pkg' && !/^((pypi|npm|other):\S+|\*)$/.test(value)) return done('套件寫成 pypi:名稱 或 npm:名稱, 例如 pypi:requests; * 代表不用審核')
      if (op === 'rm') {
        const n = db.removeOverride(conv.key, k.rm, value)
        if (!n) return done(`${conv.key} 沒有 ${what} ${value} 這筆覆寫`)
        const revoked = await deps.overridesRemoved?.(conv, input.senderId) ?? 0
        return changed(`移除 ${what} ${value}${revoked ? `; 對應的審核授權一併標為已撤銷` : ''}`)
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
        // the same settlement as the request's ✅ 同意 / ❌ 拒絕 buttons: the first one wins (router/pairing.ts)
        const code = args[2]
        if (!code) return done('找不到有效的配對碼 ')
        const r = await settlePairing({
          db, loadAccess: () => deps.loadAccess(), saveAccess: a2 => deps.saveAccess(a2), sendTo: (b, c, t) => deps.sendTo(b, c, t),
          ...(deps.pairingApprovals ? { approvals: deps.pairingApprovals } : {}),
          label: uid => personLabel(db, uid), log: deps.journal,
        }, { bot: input.bot, code, verdict: op === 'pair' ? 'approve' : 'deny', by: input.senderId, via: 'command' })
        return done(r.text)
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
        const t = all ? null : target(2)
        const picked = all ? db.listConversations() : [t!.conv].filter(Boolean) as Conversation[]
        if (!picked.length) return done(t?.error ?? '找不到這個對話')
        const skipped = role === 'admin' ? picked.filter(c => c.role === 'owner') : []
        const marked = picked.filter(c => !skipped.includes(c))
        for (const c of marked) db.setRotate(c.key, true)
        for (const c of marked) if (here?.key !== c.key) logs.push({ conv: c.key, text: `${who} 標記這個 worker 等待輪替` })
        const note = skipped.length ? `\n略過 ${skipped.map(c => c.key).join(', ')}: admin 不能異動 owner 的角色與權限` : ''
        return done(`已標記 ${marked.length} 個 worker 等待輪替: ${marked.map(c => c.key).join(', ') || '(無)'}\n閒置的會在一分鐘內停掉, 忙碌的等它閒置; 下一則訊息會用新的程式與設定叫醒${note}`, { after: () => deps.sessions.rotateNow() })
      }
      if (op !== 'restart' && op !== 'stop') return done('用法: /router session restart|stop [chat_id] | rotate [chat_id|all]')
      const { conv, error } = target(2)
      if (!conv) return done(error ?? '找不到這個對話')
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
      // the router runs claudeBin outside any sandbox (workers, package review, relay): owner-level power
      if (key === 'claudeBin' && role !== 'owner') return deny('claudeBin 由 router 在 sandbox 外執行, 只有 owner 能改')
      const raw = args.slice(3).join(' ')
      let value: unknown = raw
      if (CONFIG_KEYS[key] === 'number') { value = Number(raw); if (!Number.isFinite(value)) return done(`${key} 要是數字`) }
      if (CONFIG_KEYS[key] === 'list') value = raw.split(/[\s,]+/).filter(Boolean)
      if (key === 'owners' && !(value as string[]).includes(input.senderId)) return deny('不能把自己從 owners 移除')
      deps.writeConfig(r => { r[key] = value })
      // owners is shared by reference (elevation, approvals): change it in place
      if (key === 'owners') cfg.owners.splice(0, cfg.owners.length, ...(value as string[]))
      else (cfg as unknown as Record<string, unknown>)[key] = value
      // an owner is owner in their DMs: the DMs of those added or removed change role
      const dms = key === 'owners' ? dmsFollow(db.syncDmRoles().map(x => x.conv)) : ''
      const allowed = key === 'owners' ? ownersAllowed(value as string[]) : ''
      return done(`${key}: ${JSON.stringify(cur)} → ${JSON.stringify(value)}${allowed}${dms}`)
    }

    case 'log': {
      // /router log [chat_id] [筆數]: without a chat id, every conversation.
      const explicit = !!args[1] && ((/^-?\d+$/.test(args[1]) && Math.abs(Number(args[1])) > 1000) || !!db.getConversation(args[1]))
      const found = explicit ? findChat(args[1]!) : null
      const convs = found ? [found.conv].filter(Boolean) as Conversation[] : db.listConversations()
      if (!convs.length) return done(found ? found.error ?? '找不到這個對話' : '還沒有任何對話')
      const n = Math.min(Math.max(Number(explicit ? args[2] : args[1]) || (explicit ? 10 : 5), 1), 50)
      const fmt = (r: MessageRecord) => `${gmt8(r.ts).slice(5)} ${r.direction === 'in' ? `← ${r.user_id ?? '?'}` : '→'} ${(r.content ?? '').replace(/\s+/g, ' ').slice(0, 80)}${r.delivered ? '' : ' (未送進 worker)'}`
      const blocks = convs.map(c => {
        const rows = deps.recentMessages(c.bot, c.chat_id, n).reverse()
        return `[${c.key}${c.title ? ` ${c.title}` : ''}]\n${rows.map(fmt).join('\n') || '(沒有紀錄)'}`
      })
      return done(blocks.join('\n\n'), { private: true })
    }

    case 'skill': {
      const op = args[1] ?? 'list', name = args[2]
      if (op === 'list') return done(deps.skills.list(input.bot))
      if (op === 'run' || op === 'refresh') {
        // acceptance runs: owner only, only in the terminal (the reply may hold anything the action printed)
        if (!input.terminal || role !== 'owner') return deny(`/router skill ${op} 只在 owner 的終端機執行 (cc-telegram-router cli skill ${op} ...)`)
        if (op === 'refresh') {
          if (!name || args.length !== 3) return done('用法: cc-telegram-router cli skill refresh <技能>')
          return deps.skills.refresh ? done(await deps.skills.refresh(name)) : done('這個 router 沒有 skill refresh')
        }
        const o = parseSkillRun(cmdText.replace(/^\/router(?:@\w+)?\s+skill\s+run\s*/, ''))
        if ('error' in o) return done(o.error)
        if (o.role && !(ROLES as readonly string[]).includes(o.role)) return done(`沒有這個角色: ${o.role} (${ROLES.join(', ')})`)
        const found = findChat(o.conv)
        if (found.error) return done(found.error)
        if (!found.conv) return done(`找不到對話 ${o.conv}\n${SKILL_RUN_USAGE}`)
        return deps.skills.run ? done(await deps.skills.run(found.conv, o)) : done('這個 router 沒有 skill run')
      }
      if (!name) return done('用法: /router skill list | approve <技能> | revoke <技能> | run, refresh (只在終端機)')
      if (op === 'approve') {
        const r = await deps.skills.approve(input.bot, name, `${input.senderName} ${input.senderId}`, role, args[3])
        // the environment's build: the terminal waits for it; Telegram gets the result as its own message
        if (r.later && input.terminal) return done(`${r.text}\n${await r.later}`)
        if (r.later) void r.later.then(t => deps.sendTo(input.bot, input.chatId, t)).catch(() => {})
        return done(r.text)
      }
      if (op === 'revoke') return done(deps.skills.revoke(input.bot, name))
      return done('用法: /router skill list | approve <技能> | revoke <技能> | run, refresh (只在終端機)')
    }

    case 'cred': {
      const op = args[1] ?? 'list', name = args[2]
      if (op === 'list') return done(describeCreds(cfg), { private: true })
      if (op === 'reload') {
        if (role !== 'owner') return deny('/router cred reload 只開放 owner')
        return done(`已重新讀取 ${deps.creds.reload()} 個憑證`)
      }
      if (op === 'add' || op === 'rotate') {
        const inOwnDm = input.chatType === 'private' && input.chatId === input.senderId
        if (!inOwnDm) return deny(`/router cred ${op} 只能在你自己和 bot 的私訊使用${hasToken && input.chatType !== 'private' ? '; token 曾出現在群組, 請到發 token 的地方換一把新的' : ''}`, { deleteMessage: hasToken })
        // the message carries the value: deleted 60 seconds after this answer unless its sender cancels (refused: at once)
        const later = { deleteMessage: hasToken, deleteLater: true }
        const token = args[3]
        if (op === 'rotate') {
          if (!name || !token) return done(`用法: ${CRED_ROTATE_USAGE}`, later)
          const old = cfg.credentials?.[name]
          if (!old) return done(`找不到憑證 ${name}; 新增用 /router cred add`, later)
          if (role !== 'owner' && old.addedBy !== input.senderId) return deny('admin 只能更換自己加入的憑證', { deleteMessage: hasToken })
          const isHttp = old.kind === 'http'
          // after the value only --default-header (http); everything else stays as it is
          const rest = args.slice(4), headers: Record<string, string> = {}
          for (let i = 0; i < rest.length; i += 2) {
            if (rest[i] !== '--default-header' || !isHttp) return done(`${rest[i]} 不行: rotate 只換值${isHttp ? ', 後面只能接 --default-header <名稱>:<值>' : ''}; 網址, 標頭, 路徑, 角色不變 (要整個換掉用 /router cred add 再按覆蓋)`, later)
            const d = parseDefaultHeader(rest[i + 1])
            if ('error' in d) return done(d.error, later)
            const why = refuseDefaultHeader(old, d.name, d.value)
            if (why) return done(`${why}; 沒有更換`, later)
            setHeader(headers, d.name, d.value)
          }
          if (!isHttp && !BOT_TOKEN_FULL.test(token)) return done(`${name} 是 Telegram bot token 憑證, 這個值不像 bot token (數字:35 字元), 沒有更換, 也沒有拿去 Telegram 驗證`, later)
          try {
            const label = await deps.creds.rotate(name, token, Object.keys(headers).length ? headers : undefined)
            return done(`已更換憑證 ${name} 的${old.kind === 'http' ? ' key' : ' token'}${old.kind === 'http' ? '' : `: ${label}`}\n其他設定不變: ${credSummary(name, cfg.credentials[name]!)}`, later)
          } catch (e) {
            return done(`cred rotate 失敗, 沒有更換: ${e instanceof Error ? e.message : e}`, later)
          }
        }
        if (!name || !token || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) return done(`用法: ${CRED_ADD_USAGE}\n完整說明與範例: /router help cred`, later)
        const old = cfg.credentials?.[name]
        if (old && role !== 'owner' && old.addedBy !== input.senderId) return deny(`已經有名為 ${name} 的憑證, 不是你加入的, 只有 owner 能取代`, { deleteMessage: hasToken })
        const rest = args.slice(4)
        let methods = rest, http: HttpScope | undefined
        if (rest.includes('--http')) {
          const h = parseHttpScope(rest)
          if ('error' in h) return done(`${h.error}\n改好再傳一次 (/router help cred 有範例)`, later)
          // no paths: every path under the URL (only the host is fixed)
          methods = h.paths.length ? h.paths : ['*']
          http = { baseUrl: h.baseUrl, ...h.placement, ...(Object.keys(h.defaultHeaders).length ? { defaultHeaders: h.defaultHeaders } : {}) }
        } else if (!BOT_TOKEN_FULL.test(token)) {
          // not a bot token: never sent to getMe
          const ex = httpExample(token)
          return done([
            `這看起來不是 Telegram bot token${ex.what ? ` (像是 ${ex.what})` : ''}, 沒有登記, 也沒有拿去 Telegram 驗證.`,
            'API key 要加 --http <網址>, 例如:',
            `/router cred add ${name} <key> ${ex.flags}`,
            '(沒寫路徑就是那個網址底下全部路徑)',
            '完整說明與範例: /router help cred',
          ].join('\n'), later)
        } else if (rest.some(m => m.startsWith('--'))) return done(`${rest.find(m => m.startsWith('--'))} 只能跟 --http 一起用 (API key); bot token 後面只接方法`, later)
        // the name is taken: never replaced silently; the new value waits in memory for 覆蓋 or 取消
        if (old) {
          const id = deps.creds.staging.stage({ bot: input.bot, name, token, methods, ...(http ? { http } : {}), addedBy: input.senderId, chatId: input.chatId })
          return done([
            `已經有名為 ${name} 的憑證:`,
            credSummary(name, old),
            `要用這次的設定整個取代嗎? (新的值只暫存在 router 記憶體 ${Math.round(STAGE_TTL_MS / 60_000)} 分鐘, 逾時或取消就丟棄)`,
            `只想換 key, 其他設定不變: /router cred rotate ${name} <新的 key>`,
          ].join('\n'), { ...later, buttons: [{ text: '覆蓋', data: `credow:${id}:ok` }, { text: '取消', data: `credow:${id}:cancel` }], staged: id })
        }
        try {
          return done(addedText(name, await deps.creds.add(name, token, methods, input.senderId, http), methods, http), later)
        } catch (e) {
          return done(`cred add 失敗: ${e instanceof Error ? e.message : e}`, later)
        }
      }
      const cred = name ? cfg.credentials?.[name] : undefined
      if (!cred) return done(`找不到憑證 ${name ?? ''}
用法: /router cred list | add | rotate | header | allow | disallow | roles | rm | reload`)
      if (role !== 'owner' && cred.addedBy !== input.senderId) return deny('admin 只能調整自己加入的憑證')
      if (op === 'allow' || op === 'disallow') {
        const ms = args.slice(3)
        if (!ms.length) return done(`用法: /router cred ${op} <名稱> <方法...>`)
        deps.creds.update(name!, c => { c.methods = op === 'allow' ? [...new Set([...c.methods, ...ms])] : c.methods.filter(x => !ms.includes(x)) })
        return done(`${name} 的方法: ${cfg.credentials[name!]!.methods.join(', ') || '(無)'}`)
      }
      if (op === 'roles') {
        const rs = (args[3] ?? '').split(',').filter(Boolean)
        if (!rs.length || rs.some(r => !(ROLES as readonly string[]).includes(r))) return done(`用法: /router cred roles <名稱> <角色,...> (角色: ${ROLES.join(', ')})`)
        deps.creds.update(name!, c => { c.roles = rs })
        return done(`${name} 開放給: ${rs.join(', ')} 角色的對話`)
      }
      if (op === 'rm') { deps.creds.update(name!, null); return done(`已移除憑證 ${name}`) }
      if (op === 'header') {
        // default headers of an http credential, without the key again
        const how = args[3], what = args[4]
        if (cred.kind !== 'http') return done(`${name} 是 Telegram bot token 憑證, 沒有標頭可設`)
        if (how == null) return done(`${name} 的預設標頭: ${defaultHeadersText(cred.defaultHeaders).replace(/^, 預設標頭 /, '') || '(無)'}`)
        if ((how !== 'set' && how !== 'rm') || !what || args.length > 5) return done(`用法: ${CRED_HEADER_USAGE}`)
        if (how === 'set') {
          const d = parseDefaultHeader(what)
          if ('error' in d) return done(`${d.error}\n用法: ${CRED_HEADER_USAGE}`)
          const why = refuseDefaultHeader(cred, d.name, d.value)
          if (why) return done(why)
          deps.creds.update(name!, c => { const h = { ...c.defaultHeaders }; setHeader(h, d.name, d.value); c.defaultHeaders = h })
        } else {
          const key = Object.keys(cred.defaultHeaders ?? {}).find(k => k.toLowerCase() === what.toLowerCase())
          if (!key) return done(`${name} 沒有預設標頭 ${what}`)
          deps.creds.update(name!, c => { const h = { ...c.defaultHeaders }; delete h[key]; if (Object.keys(h).length) c.defaultHeaders = h; else delete c.defaultHeaders })
        }
        return done(`${name} 的預設標頭: ${defaultHeadersText(cfg.credentials[name!]!.defaultHeaders).replace(/^, 預設標頭 /, '') || '(無)'}`)
      }
      return done('用法: /router cred list | add | rotate | header | allow | disallow | roles | rm | reload')
    }

    case 'secret': {
      const op = args[1] ?? 'list', chat = args[2]
      // handles from raw requests (plan 10e): permanent ones stay until revoked
      if (op === 'handles') {
        let list = db.listHandles(null, null)
        if (chat) {
          const found = isChatRef(chat) ? findChat(chat) : { conv: null, error: `不認得的對話 ${chat}` }
          if (found.error || !found.conv) return done(found.error ?? `沒有對話 ${chat}`)
          list = list.filter(h => h.conv === found.conv!.key)
        }
        return done(list.length ? describeHandles(list.map(h => ({ ...h, code: `${h.code} (${h.conv})` }))) : '沒有密鑰代號', { private: true })
      }
      if (op === 'revoke') {
        const h = chat ? db.getHandle(chat) : null
        if (!h) return done('用法: /router secret revoke <代號> (/router secret handles 列出)')
        return done(db.revokeHandle(h.code, input.senderId) ? `已撤銷 ${h.conv} 的代號 ${h.code}${h.registered ? ` (已登記的密鑰 ${h.registered} 不受影響, 要移除用 /router secret rm ${h.conv} ${h.registered})` : ''}` : `代號 ${h.code} 已經撤銷過`)
      }
      if (op === 'list' && !chat) {
        const all = db.convSecretChats()
        return done(all.length ? all.map(r => `${r.bot} ${r.chat_id}: ${r.n} 把`).join('\n') : '沒有任何對話登記密鑰', { private: true })
      }
      if (!chat || !isChatRef(chat) || (op !== 'list' && op !== 'rm')) return done('用法: /router secret list [chat_id] | rm <chat_id> [名稱] | handles [chat_id] | revoke <代號>')
      // secrets belong to (bot, chat): a known conversation tells which bot
      const found = findChat(chat)
      if (found.error) return done(found.error)
      const [sbot, schat] = found.conv ? [found.conv.bot, found.conv.chat_id] : [botOpt ?? input.bot, chat]
      if (op === 'list') {
        const list = db.listConvSecrets(sbot, schat)
        return done(list.length ? describeSecrets(list) : `對話 ${chat} 沒有密鑰`, { private: true })
      }
      const n = db.removeConvSecret(sbot, schat, args[3] ?? null)
      return done(n ? `已移除對話 ${chat} 的${args[3] ? `密鑰 ${args[3]}` : `全部 ${n} 把密鑰`}` : `對話 ${chat} 沒有${args[3] ? `名為 ${args[3]} 的` : ''}密鑰`)
    }

    case 'event': {
      // plan 10e: plaintext only for the owner, only in the terminal, only into a 600 file
      if (args[1] !== 'raw' || !/^\d+$/.test(args[2] ?? '')) return done('用法: cc-telegram-router cli event raw <event id>')
      if (!input.terminal || role !== 'owner') return deny('event raw 只在 owner 的終端機執行 (cc-telegram-router cli event raw <id>), 不提供 Telegram 裡的明文')
      if (!deps.events) return done('這個 router 沒有 event_raw')
      return done(await deps.events.rawToFile(Number(args[2])))
    }

    case 'classifier': {
      // stage 1 tool call classifier (router/classifier.ts): owner only, the records hold tool arguments
      if (role !== 'owner') return deny('/router classifier 只開放 owner')
      if (!deps.classifier) return done('這個 router 沒有分類器')
      if (args[1] === 'show') {
        if (!/^\d+$/.test(args[2] ?? '')) return done('用法: /router classifier show <編號>')
        return done(deps.classifier.show(Number(args[2])), { private: true })
      }
      // [天數] [v1|v2]: the question version, to compare before and after a change of questions
      const rest = args.slice(1)
      const vArg = rest.find(a => /^v\d+$/i.test(a))
      const dArg = rest.find(a => a !== vArg)
      const days = dArg === undefined ? 7 : /^\d+$/.test(dArg) && Number(dArg) >= 1 && Number(dArg) <= 90 ? Number(dArg) : null
      if (days === null || rest.length > 2) return done('用法: /router classifier [天數 1~90] [v1|v2] | classifier show <編號>')
      return done(deps.classifier.report(days, vArg ? Number(vArg.slice(1)) : undefined), { private: true })
    }

    case 'tools': {
      // tool_history (router/toolhistory.ts): no arguments in it, owner and admin like the rest of /router
      const d = args[1]
      const days = d === undefined ? 7 : /^\d+$/.test(d) && Number(d) >= 1 && Number(d) <= KEEP_DAYS ? Number(d) : null
      if (days === null || args.length > 2) return done(`用法: /router tools [天數 1~${KEEP_DAYS}]`)
      return done(toolReport(db, days), { private: true })
    }

    case 'botapi': {
      if (role !== 'owner') return deny('/router botapi 只開放 owner')
      const [name, method] = [args[1], args[2]]
      const rest = cmdText.replace(/^\/router(?:@\w+)?\s+botapi\s+\S+\s+\S+\s*/, '')
      const files: Record<string, string> = {}
      const json = rest.replace(/\s--file\s+(\w+)=(\S+)/g, (_m, f: string, p: string) => { files[f] = p; return '' }).trim()
      if (!name || !method) return done('用法: /router botapi <憑證或 bot 名稱> <方法> <JSON 參數> [--file 欄位=/路徑]')
      let params: Record<string, unknown> = {}
      try { params = json ? JSON.parse(json) : {} } catch { return done('參數要是 JSON 物件, 例如 {"name":"my_set"}') }
      try {
        return done(maskTokens(JSON.stringify(await deps.creds.call(name, method, params, files))))
      } catch (e) {
        return done(`botapi 失敗: ${e instanceof Error ? e.message : e}`)
      }
    }

    case 'setup': {
      if (role !== 'owner') return deny('/router setup 只開放 owner')
      const op = args[1]
      if (!op || op === 'show') return done(deps.setup.describe(input.bot))
      if (op === 'skip') { deps.setup.skip(input.bot); return done('已略過審核群組: 重要通知與權限申請都會私訊給 owner') }
      if (op === 'persona') { deps.setup.resetPersona(input.bot); return done('下次 owner 私訊這隻 bot 時會重新做人設訪談') }
      if (op === 'group') {
        if (input.chatType !== 'supergroup' && input.chatType !== 'group') return done('請在要當審核群組的那個群組裡下 /router setup group')
        return done(await deps.setup.group(input.bot, input.chatId), { html: true })
      }
      return done('用法: /router setup [show] | group | skip | persona')
    }

    case 'restart':
      return done('router 重啟中', { after: () => deps.restartRouter() })

    default:
      return done(`不認得的指令: ${sub}\n${HELP}`)
  }
}
