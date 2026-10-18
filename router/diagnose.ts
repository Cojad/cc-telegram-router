// What went wrong with a worker, in words an owner can act on (docs/operations.md
// 「疑難排解」「cli doctor」): folder trust read from ~/.claude.json (never
// written here), the plugin's own MCP log when it did not connect, an API error
// that ended a turn (StopFailure), the model against autoCompactWindow, waking
// again later after repeated failures, and the doctor report. Nothing here
// prints a token: every text that leaves goes through maskTokens.
// Tests: router/test/diagnose.test.ts, e2e-diagnose.test.ts.

import { accessSync, chmodSync, constants, copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { maskTokens } from './context'

// --- folder trust -------------------------------------------------------------

/** The git repository a folder is in (the folder with .git), or null. */
export function gitRoot(dir: string): string | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
    if (d === dirname(d)) return null
  }
}

export type Trust = { trusted: boolean; key: string; why: string }

/** Whether Claude Code counts dir as trusted (docs: Configure permissions,
 *  Project allow rules and workspace trust): in a repository by its root;
 *  outside one by dir or a folder above it with hasTrustDialogAccepted;
 *  the user's home never (its trust is kept for one session only).
 *  projects: ~/.claude.json's "projects", read by the caller. */
export function trustOf(projects: Record<string, { hasTrustDialogAccepted?: boolean } | undefined>, dir: string, userHome: string): Trust {
  let d = resolve(dir)
  try { d = realpathSync(d) } catch {}
  const home = resolve(userHome)
  if (d === home) return { trusted: false, key: d, why: 'home' }
  const root = gitRoot(d)
  if (root) return { trusted: projects[root]?.hasTrustDialogAccepted === true, key: root, why: 'repo' }
  for (let a = d; ; a = dirname(a)) {
    if (a !== home && projects[a]?.hasTrustDialogAccepted === true) return { trusted: true, key: a, why: a === d ? 'self' : 'parent' }
    if (a === dirname(a)) return { trusted: false, key: d, why: 'none' }
  }
}

/** ~/.claude.json's projects, or null when it cannot be read (only the trust flags are looked at). */
export function readProjects(claudeJson: string): Record<string, { hasTrustDialogAccepted?: boolean }> | null {
  try {
    const all = JSON.parse(readFileSync(claudeJson, 'utf8')).projects ?? {}
    return Object.fromEntries(Object.entries(all as Record<string, any>).map(([k, v]) => [k, { hasTrustDialogAccepted: v?.hasTrustDialogAccepted === true }]))
  } catch { return null }
}

/** YYYYMMDD-HHMMSS in GMT+8, for backup names. */
const stamp8 = (d: Date) => new Date(d.getTime() + 8 * 3_600_000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

export type GrantResult = { ok: boolean; backup?: string; why?: string }

/** The setup wizard writing folder trust, only after the owner typed y
 *  (docs: Error reference, Workspace has not been trusted: set
 *  projects["<path>"].hasTrustDialogAccepted in ~/.claude.json). Every
 *  Claude Code process rewrites that file, so: back it up first, read it
 *  again just before writing, change that one key and nothing else, write a
 *  temporary file with the same mode and rename it over, read it back, and
 *  again after settleMs to see that no other process wrote over it. */
export async function grantTrust(claudeJson: string, key: string, o: { now?: Date; wait?: (ms: number) => Promise<void>; settleMs?: number } = {}): Promise<GrantResult> {
  if (!existsSync(claudeJson)) return { ok: false, why: `${claudeJson} 不存在 (Claude Code 還沒在這個使用者下執行過), 不代寫` }
  const mode = statSync(claudeJson).mode & 0o777
  const backup = `${claudeJson}.cc-router-backup-${stamp8(o.now ?? new Date())}`
  copyFileSync(claudeJson, backup)
  chmodSync(backup, 0o600)
  let j: any
  try { j = JSON.parse(readFileSync(claudeJson, 'utf8')) } catch { return { ok: false, backup, why: `${claudeJson} 不是有效的 JSON, 不動它` } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, backup, why: `${claudeJson} 的格式不對, 不動它` }
  j.projects = j.projects && typeof j.projects === 'object' ? j.projects : {}
  j.projects[key] = { ...(j.projects[key] ?? {}), hasTrustDialogAccepted: true }
  const tmp = `${claudeJson}.cc-router-tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(j, null, 2), { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, claudeJson)
  const has = () => readProjects(claudeJson)?.[key]?.hasTrustDialogAccepted === true
  if (!has()) return { ok: false, backup, why: '寫入後讀回來沒有這個設定' }
  await (o.wait ?? Bun.sleep)(o.settleMs ?? 3000)
  if (!has()) return { ok: false, backup, why: '寫入後被其他 Claude Code 程序蓋掉了' }
  return { ok: true, backup }
}

export function trustFix(home: string, t: Trust): string {
  if (t.why === 'home') return `router 的 home (${home}) 是使用者的家目錄: Claude Code 不會存下家目錄的信任, worker 一律起不來. 把 home 改到它底下的資料夾 (設定嚮導 deploy/install.sh setup), 再照下一行做`
  return `在 router 的使用者下互動執行一次: cd ${t.why === 'repo' ? t.key : home} && claude, 在資料夾信任確認框選接受, 然後 /exit${t.why === 'repo' ? ` (${home} 在 git repo ${t.key} 裡, 信任記在 repo 根目錄)` : ''}`
}

// --- the plugin's MCP log -------------------------------------------------------

/** Claude Code's folder name for a project: every character other than a letter or digit becomes -. */
export const projectSlug = (dir: string) => resolve(dir).replace(/[^a-zA-Z0-9]/g, '-')

export const pluginLogDir = (folder: string, userHome: string) => join(userHome, '.cache', 'claude-cli-nodejs', projectSlug(folder), 'mcp-logs-plugin-telegram-telegram')

/** The newest log file of the conversation's telegram plugin (written at or after since, when given), or null. */
export function latestPluginLog(folder: string, userHome: string, since = 0): string | null {
  const dir = pluginLogDir(folder, userHome)
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl') || f.endsWith('.txt') || f.endsWith('.log'))
    if (!files.length) return null
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)
    const newest = join(dir, files[0]!)
    return statSync(newest).mtimeMs >= since ? newest : null
  } catch { return null }
}

const NOISE = /TELEGRAM_STANDBY_ONLY|standing by to take over|reply failed|Calling MCP tool|completed successfully/

/** Why the plugin did not connect, from its log (JSON lines with "error"):
 *  the last line about a missing executable or a failed start, else the
 *  last connection failure, else the last stderr line; tool errors are not it. */
export function pluginFailure(text: string): string | null {
  const errors: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { const j = JSON.parse(line); if (typeof j.error === 'string') errors.push(j.error) } catch {}
  }
  const pick = (re: RegExp) => [...errors].reverse().find(e => re.test(e) && !NOISE.test(e))
  const why = pick(/not found in \$PATH|ENOENT|Executable|spawn|exited|exit code|command not found|No such file/i)
    ?? pick(/Connection failed|timed out|timeout/i)
    ?? pick(/^Server stderr:/)
  if (!why) return null
  return maskTokens(why.replace(/^Server stderr:\s*/, '').replace(/\s+/g, ' ').trim()).slice(0, 300)
}

// --- why a worker would not wake, and what to do -------------------------------------

/** A wake that failed: the cause in a few words, and what to do. spawnOut: what claude --bg said. */
export function wakeCause(o: { spawnOut?: string; pluginLog?: string | null; home: string; folder: string; logFile?: string | null; trust?: Trust | null }): { cause: string; fix: string } {
  const out = o.spawnOut ?? ''
  if (/home directory is trusted one session at a time/i.test(out)) return { cause: '資料夾信任: home 是使用者的家目錄', fix: trustFix(o.home, { trusted: false, key: o.home, why: 'home' }) }
  if (/Workspace not trusted/i.test(out)) return { cause: '資料夾沒有被信任 (Workspace not trusted)', fix: trustFix(o.home, o.trust ?? { trusted: false, key: o.home, why: 'none' }) }
  const log = o.pluginLog ?? null
  if (log && /bun/i.test(log) && /not found|ENOENT|No such file/i.test(log)) return { cause: `plugin 起不來: ${log}`, fix: 'worker 的 telegram plugin 要用 bun 執行, 但 router (systemd unit) 的 PATH 找不到它: 執行 deploy/install.sh unit (會把 bun 的資料夾加進 unit 的 PATH), 再 systemctl --user restart cc-telegram-router' }
  if (log) return { cause: `plugin 沒有連上: ${log}`, fix: `看 plugin 的 log${o.logFile ? `: ${o.logFile}` : ''}; 可試 /router session restart` }
  if (out.trim() && !/backgrounded/.test(out)) return { cause: `claude --bg 失敗: ${maskTokens(out.replace(/\s+/g, ' ').trim()).slice(0, 300)}`, fix: '照上面 claude 的訊息處理; cctr cli doctor 會一併檢查環境' }
  return { cause: 'plugin 沒有在時限內連上 router, plugin 的 log 也沒有寫原因', fix: `看 plugin 的 log (${pluginLogDir(o.folder, '~')}), 或跑 cctr cli doctor` }
}

/** Minutes to wait before waking again after n failures in a row. */
export const WAKE_BACKOFF_MIN = [1, 2, 5, 10, 30]
export const backoffMs = (failures: number) => (WAKE_BACKOFF_MIN[Math.min(Math.max(failures, 1), WAKE_BACKOFF_MIN.length) - 1]!) * 60_000

export type WakeState = { failures: number; until: number; cause: string; notified: string | null; at: number }

/** Failed wakes per conversation: when to try again, and whether to tell the owner (once per cause). */
export function createWakeTracker(now: () => number = Date.now) {
  const s = new Map<string, WakeState>()
  return {
    /** A failed wake: notify is true only for a cause not told yet. */
    fail(key: string, cause: string): { notify: boolean; retryAt: number; failures: number } {
      const prev = s.get(key)
      const failures = (prev?.failures ?? 0) + 1
      const until = now() + backoffMs(failures)
      const notify = prev?.notified !== cause
      s.set(key, { failures, until, cause, notified: notify ? cause : prev!.notified, at: now() })
      return { notify, retryAt: until, failures }
    },
    /** Connected: recovered is true when the owner was told about a failure. */
    ok(key: string): { recovered: boolean; failures: number } {
      const prev = s.get(key)
      s.delete(key)
      return { recovered: !!prev?.notified, failures: prev?.failures ?? 0 }
    },
    /** /router session restart: wake now; what was told stays (so recovery is told). */
    release(key: string): void { const p = s.get(key); if (p) p.until = 0 },
    /** Waking before this is held back (0 when not failing). */
    until: (key: string) => s.get(key)?.until ?? 0,
    get: (key: string) => s.get(key) ?? null,
  }
}

// --- an API error that ended a turn (StopFailure) ----------------------------------

export type ApiFailure = { error?: string; details?: string; message?: string }

/** The turn's API error in a few words and what to do (docs: Error reference). */
export function apiAdvice(f: ApiFailure, model: string): { reason: string; fix: string; short: string } {
  const text = `${f.message ?? ''} ${f.details ?? ''}`
  const base = model.replace(/\[1m\]$/i, '')
  if (/Usage credits required for 1M context/i.test(text)) return {
    reason: `模型 ${model} 用 1M context, 這個帳號沒有 1M context 的額度 (usage credits)`,
    fix: `改用沒有 [1m] 的模型: /router config set model ${base} (或只改這個對話: /router chat <chat_id> model ${base}), 並把 autoCompactWindow 調到 200000 以下; 或在 router 的使用者下開 claude 執行 /usage-credits 開啟額度, 再 /router session restart`,
    short: '這個模型需要 1M context 額度, 帳號目前沒有',
  }
  switch (f.error) {
    case 'authentication_failed': case 'oauth_org_not_allowed': case 'cloud_credential_error':
      return { reason: `Claude Code 的登入失效或不被允許 (${f.error})`, fix: '在 router 的使用者下執行 claude, 用 /login 重新登入, 再 /router session restart', short: 'Claude 的登入失效' }
    case 'billing_error': case 'account_on_hold':
      return { reason: `帳號的付款或狀態有問題 (${f.error})`, fix: '到 claude.ai 的帳號設定檢查方案與付款', short: 'Claude 帳號暫時不能用' }
    case 'rate_limit':
      return { reason: '用量額度用完了 (rate limit)', fix: '等額度重置 (/usage 看重置時間), 或換用較省的模型', short: '用量額度暫時用完' }
    case 'model_not_found':
      return { reason: `找不到模型 ${model}`, fix: `模型名稱有誤或這個帳號不能用: /router config set model <正確的模型> (例如 claude-opus-5-5)`, short: '設定的模型不存在' }
    case 'overloaded': case 'server_error':
      return { reason: `Anthropic 的服務暫時有問題 (${f.error})`, fix: '通常稍後就恢復, 不用處理; 持續發生再看 status.claude.com', short: '服務暫時忙碌' }
    case 'max_output_tokens':
      return { reason: '回覆超過輸出上限', fix: '請對方把要求拆小一點', short: '回覆太長被截斷' }
  }
  if (/safeguards flagged/i.test(text)) return { reason: '這一輪被 Anthropic 的安全分類器擋下', fix: '換個方式提問; 誤判時可回報 Anthropic', short: '這個要求被安全機制擋下' }
  return { reason: `API 錯誤${f.error ? ` (${f.error})` : ''}`, fix: '看下面的原始訊息; 持續發生再跑 cctr cli doctor', short: '服務暫時出錯' }
}

// --- the model against autoCompactWindow ----------------------------------------------

/** The context window Claude Code gives a model (docs: Model configuration,
 *  Extended context): native 1M for Fable, Mythos, Sonnet 5+, Haiku 5.5 and
 *  Opus 4.7+ (and the aliases, which resolve to them); 200K for Opus 4.6 and
 *  Sonnet 4.6 without [1m] and older models; null when unknown. */
export function modelWindow(model: string): { window: number | null; credits: string | null } {
  const m = model.toLowerCase().trim()
  const oneM = /\[1m\]$/.test(m)
  const id = m.replace(/\[1m\]$/, '')
  const native = /^(opus|sonnet|haiku|fable|opusplan|best|default)$/.test(id) || /fable|mythos|sonnet-5|haiku-5|opus-4-[7-9]|opus-5/.test(id)
  if (native) return { window: 1_000_000, credits: null }
  if (/sonnet-4-6/.test(id)) return oneM ? { window: 1_000_000, credits: 'Sonnet 4.6 的 1M context 在所有方案都要 usage credits (沒有就會 Usage credits required for 1M context)' } : { window: 200_000, credits: null }
  if (/opus-4-6/.test(id)) return oneM ? { window: 1_000_000, credits: 'Opus 4.6 的 1M context 在 Max, Team, Enterprise 方案內含, 其他方案要 usage credits' } : { window: 200_000, credits: null }
  if (/claude-(opus|sonnet|haiku)-[34]|claude-3/.test(id)) return { window: 200_000, credits: oneM ? `${id} 沒有 1M context 的版本` : null }
  return { window: null, credits: null }
}

/** Lines about a model and its autoCompactWindow (none when they agree). */
export function modelWindowNotes(model: string, compact: number | string): string[] {
  const w = modelWindow(model)
  const n = typeof compact === 'number' ? compact : compact === 'auto' ? null : Number(compact)
  const out: string[] = []
  if (w.credits) out.push(`模型 ${model}: ${w.credits}`)
  if (w.window === 200_000 && n && n > 200_000) out.push(`autoCompactWindow ${n} 大於模型 ${model} 的 200000 context: Claude Code 會在 200000 就壓縮 (設定的值不會生效); 要更大的 context 改用 1M 的模型 (例如 claude-opus-5-5), 不然把 autoCompactWindow 設成 200000 以下`)
  return out
}

// --- bun and claude on the systemd unit's PATH ------------------------------------

/** The systemd unit deploy/install.sh unit writes. */
/** The router's systemd user unit (deploy/cc-telegram-router.service). */
export const UNIT_NAME = 'cc-telegram-router.service'
export const unitFile = (userHome: string) => join(userHome, '.config', 'systemd', 'user', UNIT_NAME)
/** The unit's PATH before install.sh adds bun's and claude's folders (deploy/cc-telegram-router.service). */
export const unitBasePath = (userHome: string) => [join(userHome, '.local', 'bin'), join(userHome, 'bin'), '/usr/local/bin', '/usr/bin', '/bin']

/** Whether bun (the worker's telegram plugin runs it, plugin/.mcp.json) and
 *  claudeBin are found on the unit's PATH: the installed unit's, else the one
 *  install.sh unit would start from. Lines to show; none when both are found. */
export function unitPathCheck(o: { userHome: string; claudeBin: string; bun: string | null; claude: string | null }): string[] {
  const file = unitFile(o.userHome)
  let dirs = unitBasePath(o.userHome), installed = false
  if (existsSync(file)) {
    const m = /^Environment=PATH=(.*)$/m.exec(readFileSync(file, 'utf8'))
    if (m) { dirs = m[1]!.trim().split(':').filter(Boolean); installed = true }
  }
  const runnable = (p: string) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile() } catch { return false } }
  const found = (cmd: string) => isAbsolute(cmd) ? runnable(cmd) : dirs.some(d => runnable(join(d, cmd)))
  const fix = installed ? '重跑 deploy/install.sh unit 會把它的資料夾加進 unit 的 PATH, 再 systemctl --user restart cc-telegram-router' : '還沒安裝 systemd unit: deploy/install.sh unit 會把它的資料夾加進 unit 的 PATH'
  const out: string[] = []
  if (!found('bun')) out.push(o.bun
    ? `⚠️ ${installed ? 'unit 的 PATH' : 'unit 預設的 PATH'} 找不到 bun (它在 ${dirname(o.bun)}): worker 的 telegram plugin 會起不來 (router log 的 plugin did not connect). ${fix}.`
    : '⚠️ 找不到 bun: worker 的 telegram plugin 要用 bun 執行, 先安裝 bun (https://bun.sh) 再跑 deploy/install.sh unit.')
  const claude = isAbsolute(o.claudeBin) ? o.claudeBin : o.claude
  if (isAbsolute(o.claudeBin) ? !runnable(o.claudeBin) : !found(o.claudeBin)) out.push(claude && runnable(claude)
    ? `⚠️ ${installed ? 'unit 的 PATH' : 'unit 預設的 PATH'} 找不到 claude (${o.claudeBin}, 它在 ${dirname(claude)}): worker 起不來. ${fix}, 或把 claudeBin 改成絕對路徑.`
    : `⚠️ 找不到 claude 執行檔 ${o.claudeBin}: 先安裝 Claude Code, 或用這個嚮導把 claudeBin 改成它的絕對路徑.`)
  return out
}

