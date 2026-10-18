// skill_check: a worker's look at a skill it wrote, before anyone installs or
// approves it (docs/credentials-and-skills.md 「檢查技能草稿」). The router
// reads the folder (inside the conversation's own folder only) with its own
// loadManifest and describeActions, never runs anything, and answers with
// what is wrong (clear enough to fix by), what install_skill would refuse,
// what /router skill approve would list, and what this role can do next.
// Every role but guest may use it (guest cannot write files).

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'fs'
import { basename, isAbsolute, join, relative } from 'path'
import { loadManifest, type Action } from './privskill'
import { describeActions } from './skillrun'
import { TOKEN_RE } from './credentials'
import { SKILL_SRC } from './skills'
import type { Credential } from './config'

export type SkillCheckDeps = {
  /** A credential by name (router config): only its kind is reported, never a value. */
  cred?(name: string): Credential | undefined
}

const ROLES = ['owner', 'admin', 'power', 'user', 'guest']
const DEFAULT_ROLES = ['owner', 'admin', 'power', 'user']
const KNOWN = new Set(['run', 'args', 'roles', 'creds', 'timeout', 'internal', 'auth_failure', 'refresh', 'mounts', 'env', 'http', 'bots', 'store'])
const LIKELY: Record<string, string> = { role: 'roles', arg: 'args', cred: 'creds', command: 'run', cmd: 'run', argv: 'run', stores: 'store', bot: 'bots', mount: 'mounts', authFailure: 'auth_failure', 'auth-failure': 'auth_failure' }
const SKIP_DIR = new Set(['venv', 'node_modules', '__pycache__'])
const MAX_FILES = 2000
const MAX_MANIFEST = 256 * 1024
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const PLACEHOLDER = /^\{(cred:)?([\w-]+)(\?)?\}$/
const PY = /^(.*\/)?python3?(\.\d+)?$/

const inside = (p: string, dir: string) => { const r = relative(dir, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }

/** The skill folder a worker means: relative to its folder (or skills/<name>), inside it. */
export function resolveSkillDir(folder: string, path: string): string | { error: string } {
  const p = path.trim()
  if (!p) return { error: '要給技能資料夾, 例如 skills/<名稱>' }
  const cands = isAbsolute(p) ? [p] : [join(folder, p), ...(!p.includes('/') ? [join(folder, SKILL_SRC, p)] : [])]
  const hit = cands.find(c => existsSync(c))
  if (!hit) return { error: `找不到 ${p}: 給相對於對話資料夾的路徑, 例如 ${SKILL_SRC}/<名稱>` }
  let real: string, root: string
  try { real = realpathSync(hit); root = realpathSync(folder) } catch (e) { return { error: `讀不到 ${p}: ${e instanceof Error ? e.message : e}` } }
  if (!inside(real, root)) return { error: `${p} 不在這個對話的資料夾裡 (只能檢查自己資料夾裡的技能)` }
  if (!lstatSync(real).isDirectory()) return { error: `${p} 不是資料夾: 給技能資料夾 (裡面有 SKILL.md)` }
  return real
}

/** Problems install_skill would refuse (symbolic links, token-like strings), as it finds them. */
function scanFiles(dir: string, errors: string[]) {
  let n = 0
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      if (++n > MAX_FILES) { errors.push(`檔案超過 ${MAX_FILES} 個, 只檢查了前 ${MAX_FILES} 個`); return }
      const p = join(d, e), rel = relative(dir, p)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) { errors.push(`${rel} 是符號連結: install_skill 不接受, 改成真的檔案`); continue }
      if (st.isDirectory()) { if (!SKIP_DIR.has(e)) walk(p); continue }
      if (!st.isFile() || st.size > 2_000_000) continue
      if (TOKEN_RE.test(readFileSync(p, 'utf8'))) errors.push(`${rel} 裡有像 bot token 的字串: install_skill 會拒絕; token 一律登記成 router 的憑證, 動作用 bots 或 http 拿`)
    }
  }
  walk(dir)
}

/** SKILL.md: there, a plain file, frontmatter with name and description. */
function checkSkillMd(dir: string, errors: string[], warnings: string[]) {
  const p = join(dir, 'SKILL.md')
  let st
  try { st = lstatSync(p) } catch { errors.push('沒有 SKILL.md: install_skill 會拒絕'); return }
  if (st.isSymbolicLink() || !st.isFile()) { errors.push('SKILL.md 要是一般檔案 (不能是符號連結)'); return }
  const md = readFileSync(p, 'utf8')
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(md)
  if (!fm) { errors.push('SKILL.md 開頭要有 frontmatter (--- 開頭與結尾的一段, 寫 name 與 description)'); return }
  const name = /^name:\s*(.+?)\s*$/m.exec(fm[1]!)?.[1]
  if (!name) errors.push('SKILL.md 的 frontmatter 缺 name')
  else if (name.replace(/^["']|["']$/g, '') !== basename(dir)) warnings.push(`SKILL.md 的 name (${name}) 跟資料夾名稱 (${basename(dir)}) 不同; install_skill 以資料夾名稱安裝, run_skill 的 skill 也是資料夾名稱`)
  if (!/^description:\s*\S/m.test(fm[1]!)) errors.push('SKILL.md 的 frontmatter 缺 description (寫清楚什麼時候用這個技能)')
}

const regexError = (src: string, flags = '') => { try { new RegExp(src, flags); return null } catch (e) { return e instanceof Error ? e.message : String(e) } }

/** What loadManifest lets through but a run would trip on, and what is merely odd. */
function lintAction(dir: string, n: string, a: Action, all: Record<string, Action>, deps: SkillCheckDeps, errors: string[], warnings: string[]) {
  const at = `動作 ${n}`
  for (const k of Object.keys(a)) if (!KNOWN.has(k)) warnings.push(`${at}: 不認得的欄位 ${k}, 會被忽略${LIKELY[k] ? ` (是不是要寫 ${LIKELY[k]}?)` : ''}`)
  if (!Array.isArray(a.run) || !a.run.length || a.run.some(t => typeof t !== 'string')) { errors.push(`${at}: run 要是字串陣列, 例如 ["bash", "scripts/x.sh", "{url}"]`); return }
  const used = new Set<string>()
  for (const tok of a.run) {
    const m = PLACEHOLDER.exec(tok)
    if (m?.[1]) { if (!a.creds?.[m[2]!]) errors.push(`${at}: run 裡的 ${tok} 在 creds 沒有 ${m[2]} (會回「動作清單錯誤」)`); continue }
    if (m) {
      used.add(m[2]!)
      if (!a.args?.[m[2]!]) errors.push(`${at}: run 裡的 ${tok} 在 args 沒有 ${m[2]} (會回「動作清單錯誤」)`)
      continue
    }
    if (/\{[\w:-]+\??\}/.test(tok)) warnings.push(`${at}: ${tok} 裡的 {...} 不會被替換: 參數要獨占 run 的一個元素 (例如 "--url", "{url}"), 不能跟其他字黏在一起`)
    if (tok.includes('/') && !isAbsolute(tok) && !tok.startsWith('-')) {
      const p = join(dir, tok)
      if (/^(venv|node_modules)\//.test(tok)) warnings.push(`${at}: ${tok} 在 ${tok.split('/')[0]} 裡: install_skill 不複製 ${tok.split('/')[0]}, 核准的雜湊也不含它; 安裝後要由 owner 在安裝位置建好, 否則執行時找不到`)
      else if (!existsSync(p)) errors.push(`${at}: 找不到 ${tok} (技能資料夾裡沒有這個檔): 執行時會原樣當成字串傳入, 而工作目錄是對話資料夾, 一定失敗`)
    }
  }
  if (PY.test(a.run[0]!) && !a.run.includes('-B') && !(a.internal && a.env?.PYTHONDONTWRITEBYTECODE)) warnings.push(`${at}: 用 Python 執行時加 -B (例如 ["python3", "-B", "scripts/x.py"]): 技能資料夾在沙箱裡是唯讀的, 不要讓 Python 寫 __pycache__`)
  for (const [name, spec] of Object.entries(a.args ?? {})) {
    if (!spec || typeof spec !== 'object') { errors.push(`${at}: args.${name} 要是物件, 例如 { "pattern": "..." } 或 { "flag": "--force" }`); continue }
    if (!used.has(name)) warnings.push(`${at}: args.${name} 沒有出現在 run 裡 ({${name}} 或 {${name}?}), 帶了也不會傳給腳本`)
    if (spec.flag !== undefined && typeof spec.flag !== 'string') errors.push(`${at}: args.${name}.flag 要是字串, 例如 "--force"`)
    if (spec.pattern !== undefined) {
      if (typeof spec.pattern !== 'string') errors.push(`${at}: args.${name}.pattern 要是字串`)
      else { const why = regexError(`^(?:${spec.pattern})$`); if (why) errors.push(`${at}: args.${name}.pattern 不是合法的正規表示式: ${why}`) }
    } else if (spec.flag === undefined) warnings.push(`${at}: args.${name} 沒有 pattern 也沒有 flag: 任何一行字 (最長 2000 字) 都接受; 能限定就寫 pattern`)
    for (const r of spec.roles ?? []) if (!ROLES.includes(r)) warnings.push(`${at}: args.${name}.roles 裡的 ${r} 不是角色 (${ROLES.join(', ')})`)
  }
  if (a.roles !== undefined) {
    if (!Array.isArray(a.roles)) errors.push(`${at}: roles 要是角色陣列`)
    else {
      for (const r of a.roles) if (!ROLES.includes(r)) warnings.push(`${at}: roles 裡的 ${r} 不是角色 (${ROLES.join(', ')})`)
      if (a.internal) warnings.push(`${at}: internal 動作只由 router 執行, roles 不會用到`)
    }
  }
  if (a.timeout !== undefined && (typeof a.timeout !== 'number' || !(a.timeout > 0))) errors.push(`${at}: timeout 要是正數 (秒), 沒寫是 600`)
  if (a.auth_failure !== undefined) {
    const why = typeof a.auth_failure === 'string' ? regexError(a.auth_failure, 'i') : '要是字串'
    if (why) errors.push(`${at}: auth_failure 不是合法的正規表示式: ${why}`)
  }
  if (a.refresh !== undefined) {
    const r = all[a.refresh]
    if (!r) errors.push(`${at}: refresh 指的動作 ${a.refresh} 不存在`)
    else if (!r.internal) warnings.push(`${at}: refresh 指的動作 ${a.refresh} 不是 internal: 對話也能直接呼叫它; 憑證更新動作通常寫 "internal": true`)
  }
  if (!!a.auth_failure !== !!a.refresh) warnings.push(`${at}: auth_failure 與 refresh 要一起寫才有作用 (輸出比對到 auth_failure 時執行 refresh 再重試)`)
  if (!a.internal && (a.mounts?.length || (a.env && Object.keys(a.env).length))) warnings.push(`${at}: mounts 與 env 只給 internal 動作, 這裡會被忽略`)
  for (const [env, name] of Object.entries(a.creds ?? {})) {
    if (typeof name !== 'string' || !name || name.includes('/') || name.startsWith('.')) errors.push(`${at}: creds.${env} 要是憑證資料夾名稱 (小寫英數與 -, 不能有 / 或以 . 開頭)`)
  }
  for (const [env, name] of Object.entries(a.http ?? {})) {
    const c = typeof name === 'string' ? deps.cred?.(name) : undefined
    if (typeof name !== 'string' || !name) errors.push(`${at}: http.${env} 要是憑證名稱`)
    else if (!c) warnings.push(`${at}: http 憑證 ${name} 在 router 裡不存在: 核准後執行會拒絕, 請 owner 或 admin 先登記 (/router cred add ${name} <key> --http <網址>)`)
    else if (c.kind !== 'http') warnings.push(`${at}: 憑證 ${name} 是 ${c.kind ?? 'telegram-bot'} 類, http 只接受 http 類憑證 (bot token 要寫在 bots)`)
  }
  for (const [, name] of Object.entries(a.bots ?? {})) {
    const c = typeof name === 'string' ? deps.cred?.(name) : undefined
    if (typeof name !== 'string' || !name) continue // loadManifest already says so
    if (!c) warnings.push(`${at}: bot 憑證 ${name} 在 router 裡不存在: 核准後執行會拒絕, 請 owner 或 admin 先登記 (/router cred add ${name} <token>)`)
    else if ((c.kind ?? 'telegram-bot') !== 'telegram-bot') warnings.push(`${at}: 憑證 ${name} 是 ${c.kind} 類, bots 只接受 telegram-bot 憑證 (API key 要寫在 http)`)
  }
}

/** What this role can do with a skill once it checks out. */
function nextSteps(role: string, name: string, privileged: boolean): string {
  const approve = `owner 或 admin 在 Telegram 打 /router skill approve ${name} 核准 (核准記下檔案雜湊, 之後改了任何檔案就暫停, 要重新核准)`
  if (role === 'owner' || role === 'admin') return privileged
    ? `用 install_skill (name ${name}, scope bot 或 all) 安裝 (特權動作只在這隻 bot 或全部 bot 範圍有效), 再請 ${approve}, 之後對話用 run_skill 呼叫`
    : `用 install_skill (name ${name}) 安裝: scope conversation (只有這個對話), bot (這隻 bot), all (全部 bot)`
  if (role === 'power') return privileged
    ? `特權動作只在這隻 bot 或全部 bot 範圍有效, 這兩個範圍只有 owner 與 admin 能裝 (install_skill scope bot 會走提權); 請 owner 或 admin 安裝, 再由 ${approve}`
    : `可以用 install_skill (name ${name}, scope conversation) 裝在這個對話; 要給這隻 bot 的其他對話用, 請 owner 或 admin 安裝`
  return `${role} 角色現在還不能安裝技能: 草稿留在 ${SKILL_SRC}/${name}/, 請 owner 或 admin 安裝${privileged ? ` 並核准 (${approve})` : ''}`
}

/** The whole check, as the text the worker gets back. ok: no errors. */
export function checkSkill(folder: string, path: string, role: string, deps: SkillCheckDeps = {}): { ok: boolean; text: string } {
  const dir = resolveSkillDir(folder, path)
  if (typeof dir !== 'string') return { ok: false, text: `skill check: 無法檢查\n${dir.error}` }
  const name = basename(dir)
  const errors: string[] = [], warnings: string[] = []
  if (!NAME.test(name)) errors.push(`技能資料夾名稱 ${name} 不行: 只能用小寫英數與 - (install_skill 與 run_skill 都用這個名稱)`)
  checkSkillMd(dir, errors, warnings)
  scanFiles(dir, errors)
  const pj = join(dir, 'privileged.json')
  let privileged = false, approve = ''
  let st: ReturnType<typeof lstatSync> | null = null
  try { st = lstatSync(pj) } catch {}
  if (st) {
    privileged = true
    if (st.isSymbolicLink() || !st.isFile()) errors.push('privileged.json 要是一般檔案 (不能是符號連結), 沒有讀它')
    else if (st.size > MAX_MANIFEST) errors.push(`privileged.json 超過 ${MAX_MANIFEST} bytes, 沒有讀它`)
    else {
      let raw: unknown = null
      try { raw = JSON.parse(readFileSync(pj, 'utf8')) } catch (e) { errors.push(`privileged.json 不是合法的 JSON: ${e instanceof Error ? e.message : e}`) }
      if (raw !== null) {
        try {
          const m = loadManifest(dir)!
          for (const [n, a] of Object.entries(m.actions)) {
            if (!a || typeof a !== 'object' || Array.isArray(a)) { errors.push(`動作 ${n} 要是物件`); continue }
            lintAction(dir, n, a, m.actions, deps, errors, warnings)
          }
          if (!Object.values(m.actions).some(a => a && !a.internal)) warnings.push('沒有對話能呼叫的動作 (全部是 internal)')
          if (!errors.length) approve = describeActions(dir)
        } catch (e) { errors.push(`/router skill approve 會拒絕: ${e instanceof Error ? e.message : e}`) }
      }
    }
  }
  const lines = [errors.length ? `skill check: 有 ${errors.length} 個錯誤要改` : `skill check: ok${warnings.length ? ` (${warnings.length} 個提醒)` : ''}`,
    `技能 ${name} (${relative(realpathSync(folder), dir) || '.'}), ${privileged ? '有 privileged.json (特權動作)' : '沒有 privileged.json (一般技能)'}; 只讀檔案, 沒有執行任何程式`]
  if (errors.length) lines.push('', '錯誤:', ...errors.map(e => `- ${e}`))
  if (warnings.length) lines.push('', '提醒:', ...warnings.map(w => `- ${w}`))
  if (approve) lines.push('', `核准時 /router skill approve ${name} 會列出:`, approve)
  if (!errors.length) lines.push('', `下一步: ${nextSteps(role, name, privileged)}`)
  return { ok: !errors.length, text: lines.join('\n') }
}
