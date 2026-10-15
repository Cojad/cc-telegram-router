// Skill scopes (plan 03 技能範圍). Claude Code reads .claude/skills from the
// working directory and every folder above it, so where a skill sits decides
// who gets it:
//   <home>/.claude/skills            every conversation of every bot
//   <home>/bot<id>/.claude/skills    every conversation of one bot
//   <conversation>/.claude/skills    that conversation only
// A worker writes its own conversation's skills directly. Owner and admin
// conversations install one into the bot or all-bots scope with
// install_skill: the router copies it from the conversation's folder, after
// checking it holds no token (credentials belong in router config).

import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join, relative } from 'path'
import { TOKEN_RE } from './credentials'

export type Scope = 'bot' | 'all'
export const MAY_INSTALL = ['owner', 'admin']

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = lstatSync(p)
    if (st.isSymbolicLink()) throw new Error(`技能裡不能有符號連結: ${e}`)
    if (st.isDirectory()) { if (e !== 'venv' && e !== 'node_modules' && e !== '__pycache__') walk(p, out) }
    else out.push(p)
  }
  return out
}

/** Copy <convFolder>/.claude/skills/<name> into the scope's skills folder. Returns where it went. */
export function installSkill(o: { convFolder: string; role: string; name: string; scopeDir: string; replace?: boolean }): string {
  if (!MAY_INSTALL.includes(o.role)) throw new Error(`只有 owner 與 admin 的對話能安裝 bot 或全部 bot 共用的技能, 這個對話是 ${o.role}; 可以把技能放在自己資料夾的 .claude/skills (只有這個對話用)`)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.name)) throw new Error('技能名稱只能用小寫英數與 -')
  const src = join(o.convFolder, '.claude', 'skills', o.name)
  if (!existsSync(join(src, 'SKILL.md'))) throw new Error(`找不到 ${relative(o.convFolder, src)}/SKILL.md: 先在自己資料夾的 .claude/skills/${o.name}/ 寫好技能`)
  for (const f of walk(src)) {
    if (lstatSync(f).size > 2_000_000) continue
    if (TOKEN_RE.test(readFileSync(f, 'utf8'))) throw new Error(`${relative(src, f)} 裡有像 token 的字串: 技能裡不能放 token, 請改用 router 的憑證 (見 /telegram:bot-skill)`)
  }
  const dest = join(o.scopeDir, '.claude', 'skills', o.name)
  if (existsSync(dest)) {
    if (!o.replace) throw new Error(`${dest} 已經有同名技能; 確定要覆蓋就帶 replace: true`)
    rmSync(dest, { recursive: true, force: true })
  }
  cpSync(src, dest, { recursive: true, filter: s => !/\/(venv|node_modules|__pycache__)(\/|$)/.test(s) })
  return dest
}
