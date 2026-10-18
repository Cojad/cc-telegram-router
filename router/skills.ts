// Skill scopes (plan 03 技能範圍). Claude Code reads .claude/skills from the
// working directory and every folder above it, so where a skill sits decides
// who gets it:
//   <home>/.claude/skills            every conversation of every bot
//   <home>/bot<id>/.claude/skills    every conversation of one bot
//   <conversation>/.claude/skills    that conversation only
// Claude Code never lets a worker below owner write under .claude (not with
// an allow rule, a hook or the sandbox), so a worker writes a skill in
// <conversation>/skills/<name>/ and install_skill has the router copy it in,
// after checking it holds no token (credentials belong in router config):
// into the conversation itself (power and up), or the bot or all-bots scope
// (owner and admin). A role too low is an elevation matter (router/main.ts).

import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join, relative } from 'path'
import { TOKEN_RE } from './credentials'

export type Scope = 'conversation' | 'bot' | 'all'
export const MAY_INSTALL: Record<Scope, string[]> = { conversation: ['owner', 'admin', 'power'], bot: ['owner', 'admin'], all: ['owner', 'admin'] }
/** Where a worker writes a skill before install_skill (relative to its folder). */
export const SKILL_SRC = 'skills'

/** install_skill's scope argument (bot when missing or unknown). */
export function skillScope(v: unknown): Scope {
  return v === 'all' || v === 'conversation' ? v : 'bot'
}

/** Why this role may not install into this scope, or null. */
export function installRefusal(scope: Scope, role: string): string | null {
  if (MAY_INSTALL[scope].includes(role)) return null
  return scope === 'conversation'
    ? `只有 power 以上的對話能安裝這個對話自己的技能, 這個對話是 ${role}`
    : `只有 owner 與 admin 的對話能安裝${scope === 'bot' ? '這隻 bot' : '全部 bot'} 共用的技能, 這個對話是 ${role}`
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) throw new Error(`技能裡不能有符號連結: ${e}`)
    if (st.isDirectory()) { if (e !== 'venv' && e !== '.venv' && e !== 'node_modules' && e !== '__pycache__') walk(p, out) }
    else out.push(p)
  }
  return out
}

/** Copy <convFolder>/skills/<name> into <scopeDir>/.claude/skills/<name>
 *  (scopeDir is the conversation folder itself for scope conversation).
 *  An owner may have written it under .claude/skills directly: that is used
 *  when skills/<name> is not there (bot and all scopes). Returns where it went. */
export function installSkill(o: { convFolder: string; role: string; name: string; scope: Scope; scopeDir: string; replace?: boolean }): string {
  const why = installRefusal(o.scope, o.role)
  if (why) throw new Error(why)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.name)) throw new Error('技能名稱只能用小寫英數與 -')
  let src = join(o.convFolder, SKILL_SRC, o.name)
  const own = join(o.convFolder, '.claude', 'skills', o.name)
  if (!existsSync(join(src, 'SKILL.md')) && o.scope !== 'conversation' && existsSync(join(own, 'SKILL.md'))) src = own
  if (!existsSync(join(src, 'SKILL.md'))) throw new Error(`找不到 ${SKILL_SRC}/${o.name}/SKILL.md: 先在自己資料夾的 ${SKILL_SRC}/${o.name}/ 寫好技能 (.claude 底下只有 owner 的對話寫得進去)`)
  for (const f of walk(src)) {
    if (lstatSync(f).size > 2_000_000) continue
    if (TOKEN_RE.test(readFileSync(f, 'utf8'))) throw new Error(`${relative(src, f)} 裡有像 token 的字串: 技能裡不能放 token, 請改用 router 的憑證 (見 /telegram:bot-skill)`)
  }
  const dest = join(o.scopeDir, '.claude', 'skills', o.name)
  if (existsSync(dest)) {
    if (!o.replace) throw new Error(`${dest} 已經有同名技能; 確定要覆蓋就帶 replace: true`)
    rmSync(dest, { recursive: true, force: true })
  }
  cpSync(src, dest, { recursive: true, filter: s => !/\/(\.?venv|node_modules|__pycache__)(\/|$)/.test(s) })
  return dest
}
