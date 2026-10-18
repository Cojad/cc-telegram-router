// Privileged skill actions run from the owner's terminal (acceptance runs,
// docs/credentials-and-skills.md 「終端機執行特權動作」):
//   cc-telegram-router cli skill run <對話> <技能> <動作> --out <資料夾> [--role <角色>] [--trial | --trial-store <資料夾>] [--api <本機網址>] [JSON 參數]
//   cc-telegram-router cli skill refresh <技能>
// A run goes through runSkill (router/skillrun.ts) exactly like run_skill:
// the conversation's bot and skills, approval hash, role (the conversation's
// own, or --role), argument patterns, sandbox, creds, http, bots, store, the
// output scan and masking. What differs: the conversation folder is --out (a
// folder outside conversation and bot folders and the state dir), the run is
// recorded in skill_runs as terminal:<對話 key> (not counted toward, nor held
// to, the conversation's hourly limit), and owner notices come back in the
// reply instead of Telegram. --trial runs on a throwaway copy of the bot's
// databases (removed after; the real ones never change); --trial-store keeps
// that copy in a folder of the caller's (seeded from the real databases the
// first time) so runs can follow one another (publish, then remove). --api,
// only with a trial, points bots credentials at a local fake Bot API. A
// refresh runs refreshAll (router/skillrefresh.ts) for one skill in the daily
// refresh's own queue, recorded as terminal:refresh.

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'fs'
import { createHash } from 'crypto'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import type { Conversation } from './db'
import { runSkill, type SkillRunDeps } from './skillrun'
import { refreshAll, type RefreshDeps, type RefreshResult } from './skillrefresh'

export const TERMINAL_PREFIX = 'terminal:'
export const TERMINAL_REFRESH = 'terminal:refresh'
export const SKILL_RUN_USAGE = '用法: cc-telegram-router cli skill run <對話 key 或 chat_id> <技能> <動作> --out <資料夾> [--role <角色>] [--trial | --trial-store <資料夾>] [--api <http://127.0.0.1:埠>] [JSON 參數]'

export type SkillRunOpts = {
  conv: string; skill: string; action: string; out: string
  role?: string; trial: boolean; trialStore?: string; api?: string
  args: Record<string, unknown>
}

/** The words after "skill run" (the JSON arguments are the rest of the line from the first "{"). */
export function parseSkillRun(rest: string): SkillRunOpts | { error: string } {
  const pos: string[] = []
  const o: Partial<SkillRunOpts> & { trial: boolean; args: Record<string, unknown> } = { trial: false, args: {} }
  let s = rest.trim()
  while (s) {
    if (s.startsWith('{')) {
      try { o.args = JSON.parse(s) } catch { return { error: `參數要是 JSON 物件, 例如 {"prompt":"a whale"}\n${SKILL_RUN_USAGE}` } }
      if (!o.args || typeof o.args !== 'object' || Array.isArray(o.args)) return { error: `參數要是 JSON 物件\n${SKILL_RUN_USAGE}` }
      break
    }
    const m = /^(\S+)\s*/.exec(s)!
    s = s.slice(m[0].length)
    const w = m[1]!
    const value = () => { const v = /^(\S+)\s*/.exec(s); if (!v || v[1]!.startsWith('--')) return null; s = s.slice(v[0].length); return v[1]! }
    if (w === '--trial') { o.trial = true; continue }
    if (w === '--role' || w === '--out' || w === '--trial-store' || w === '--api' || w === '--bot') {
      const v = value()
      if (!v) return { error: `${w} 後面要接值\n${SKILL_RUN_USAGE}` }
      if (w === '--role') o.role = v
      else if (w === '--out') o.out = v
      else if (w === '--trial-store') { o.trialStore = v; o.trial = true }
      else if (w === '--api') o.api = v
      // --bot: already taken by the command table (which bot a chat id means)
      continue
    }
    if (w.startsWith('--')) return { error: `不認得的選項 ${w}\n${SKILL_RUN_USAGE}` }
    pos.push(w)
  }
  if (pos.length !== 3) return { error: SKILL_RUN_USAGE }
  if (!o.out) return { error: `要用 --out 指定輸出資料夾 (不可以是對話資料夾)\n${SKILL_RUN_USAGE}` }
  if (o.api && !o.trial) return { error: '--api 只能跟 --trial 或 --trial-store 一起用 (假 API 的結果不能寫進正式資料庫)' }
  if (o.api && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/.test(o.api)) return { error: `--api 只接受本機網址 (http://127.0.0.1:埠, localhost 或 [::1]), bot token 會送到那裡: ${o.api}` }
  return { conv: pos[0]!, skill: pos[1]!, action: pos[2]!, ...o } as SkillRunOpts
}

const inside = (p: string, dir: string) => { const r = relative(dir, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }

export type Guard = { home: string; stateDir: string; storeRoot: string; protectedDirs: string[] }

/** Why this folder may not take a terminal run's output or trial databases, or null. */
export function folderRefusal(p: string, what: string, g: Guard): string | null {
  if (!isAbsolute(p)) return `${what}要是絕對路徑: ${p}`
  const r = resolve(p)
  if (r === resolve(g.home)) return `${what}不可以是 router 的家目錄`
  if (inside(r, g.stateDir)) return `${what}不可以在 router 的 stateDir 裡: ${r}`
  if (inside(r, g.storeRoot) || inside(r, `${g.storeRoot}-work`)) return `${what}不可以在正式資料庫裡: ${r}`
  for (const d of g.protectedDirs) if (inside(r, resolve(d))) return `${what}不可以在對話或 bot 資料夾裡 (${d}): ${r}`
  return null
}

type Snap = Map<string, { hash: string; size: number; lines?: number }>
function snap(root: string): Snap {
  const out: Snap = new Map()
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e)
      const st = lstatSync(p)
      if (st.isDirectory()) { walk(p); continue }
      if (!st.isFile()) { out.set(relative(root, p), { hash: 'other', size: st.size }); continue }
      const data = readFileSync(p)
      out.set(relative(root, p), { hash: createHash('sha256').update(data).digest('hex'), size: st.size, ...(e.endsWith('.jsonl') ? { lines: data.toString('utf8').split('\n').filter(l => l.trim()).length } : {}) })
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

/** What changed in a trial copy of a bot's databases during one run, one line per file. */
function diff(before: Snap, after: Snap): string[] {
  const out: string[] = []
  for (const [rel, a] of after) {
    const b = before.get(rel)
    if (!b) out.push(`新增 ${rel} (${a.size} bytes${a.lines !== undefined ? `, ${a.lines} 行` : ''})`)
    else if (b.hash !== a.hash) out.push(`修改 ${rel} (${b.size} -> ${a.size} bytes${a.lines !== undefined ? `, ${b.lines} -> ${a.lines} 行` : ''})`)
  }
  for (const rel of before.keys()) if (!after.has(rel)) out.push(`刪除 ${rel}`)
  return out
}

/** One privileged action from the terminal; the reply starts with "skill run: ok|failed|refused". */
export async function terminalRun(deps: SkillRunDeps, conv: Conversation, o: SkillRunOpts, g: Guard): Promise<string> {
  const role = o.role ?? conv.role
  const outWhy = folderRefusal(o.out, '--out ', g)
  if (outWhy) return `skill run: refused\n${outWhy}`
  if (o.trialStore) {
    const why = folderRefusal(o.trialStore, '--trial-store ', g)
    if (why) return `skill run: refused\n${why}`
  }
  const out = resolve(o.out)
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const botId = basename(deps.botDir(conv.bot))
  let trialRoot: string | null = null, temp = false
  if (o.trial) {
    if (!deps.storeRoot) return 'skill run: refused\nrouter 沒有設定資料庫位置, 不能試跑'
    if (o.trialStore) trialRoot = resolve(o.trialStore)
    else {
      mkdirSync(join(g.stateDir, 'skill-store-trial'), { recursive: true, mode: 0o700 })
      trialRoot = mkdtempSync(join(g.stateDir, 'skill-store-trial', 'run-'))
      temp = true
    }
    const mine = join(trialRoot, botId)
    // the first run on a trial copy starts from the bot's real databases
    if (!existsSync(mine)) {
      mkdirSync(mine, { recursive: true, mode: 0o700 })
      const real = join(deps.storeRoot, botId)
      if (existsSync(real)) cpSync(real, mine, { recursive: true })
    }
  }
  const before = trialRoot ? snap(join(trialRoot, botId)) : null
  const notices: string[] = []
  const d: SkillRunDeps = {
    ...deps,
    ...(trialRoot ? { storeRoot: trialRoot } : {}),
    ...(o.api ? { apiRoot: o.api } : {}),
    notifyOwner: (_c, text) => notices.push(text),
  }
  try {
    const r = await runSkill(d, { ...conv, folder: out }, role, o.skill, o.action, o.args, { runAs: `${TERMINAL_PREFIX}${conv.key}` })
    const status = r.ok ? 'ok' : /^exit -?\d+/.test(r.text) ? 'failed' : 'refused'
    const lines = [
      `skill run: ${status}`,
      `技能 ${o.skill} 的 ${o.action}, 以對話 ${conv.key} (bot ${conv.bot}) 的身分, 角色 ${role}, 輸出在 ${out}${trialRoot ? `, 試跑 (資料庫${temp ? '用拋棄式複本' : `複本在 ${trialRoot}`}${o.api ? `, Bot API 改成 ${o.api}` : ''})` : ''}`,
      r.text,
    ]
    if (trialRoot) {
      const changes = diff(before!, snap(join(trialRoot, botId)))
      lines.push(`試跑資料庫的變動: ${changes.length ? `\n${changes.join('\n')}` : '無'}`)
    }
    for (const n of notices) lines.push(`[owner 通知] ${n}`)
    return lines.join('\n')
  } finally {
    if (trialRoot) {
      if (temp) rmSync(trialRoot, { recursive: true, force: true })
      // runSkill's work folders sit beside the databases (<root>-work): gone once empty
      try { rmdirSync(`${trialRoot}-work`) } catch {}
    }
  }
}

/** One skill's refresh actions now, in the daily refresh's queue when there is one. */
export async function terminalRefresh(deps: RefreshDeps, skill: string, enqueue?: <T>(fn: () => Promise<T>) => Promise<T>): Promise<string> {
  const notices: string[] = []
  const run = () => refreshAll({ ...deps, notify: (_bot, text) => notices.push(text) }, s => s === skill, TERMINAL_REFRESH)
  const rs: RefreshResult[] = await (enqueue ? enqueue(run) : run())
  if (!rs.length) return `skill refresh: none\n技能 ${skill} 沒有核准紀錄, 或沒有被 refresh 指到的 internal 動作`
  const lines = [`skill refresh: ${rs.every(r => r.status === 'ok') ? 'ok' : 'failed'}`]
  for (const r of rs) lines.push(`${r.skill}/${r.action}: ${r.status}${r.tail ? `\n${r.tail}` : ''}`)
  for (const n of notices) lines.push(`[owner 通知] ${n}`)
  return lines.join('\n')
}
