// Would this tool call be allowed under a role's settings? (plan 07 權限檢查)
// The router answers this in PreToolUse so a refusal can explain itself and,
// when the person who asked has a higher role, offer elevation. It reads the
// same settings the worker gets (role template + /router perm overrides) and
// understands the rule shapes those use; tools it does not know are left to
// Claude Code (never blocked here).

import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'

export const RANK: Record<string, number> = { guest: 0, user: 1, power: 2, admin: 3, owner: 4 }
export const rank = (role: string | null | undefined) => RANK[role ?? ''] ?? 1

export type Call = { tool_name: string; tool_input: Record<string, any> }
export type Check = { ok: true } | { ok: false; why: string }

type Rule = { tool: string; spec?: string }
function parseRule(r: string): Rule {
  const m = /^([^(]+)\((.*)\)$/.exec(r)
  return m ? { tool: m[1]!, spec: m[2]! } : { tool: r }
}

function globRe(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++ }
    else if (c === '*') re += '[^/]*'
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** "//abs/**" = absolute, "~/x" = home, anything else relative to the folder. */
function ruleSpecPath(spec: string, folder: string): string {
  if (spec.startsWith('//')) return spec.slice(1)
  if (spec.startsWith('~/')) return homedir() + spec.slice(1)
  return resolve(folder, spec.replace(/^\//, ''))
}

function pathMatches(spec: string, path: string, folder: string): boolean {
  const pat = ruleSpecPath(spec, folder)
  const re = globRe(pat)
  // "dir/**" also covers dir itself
  return re.test(path) || (pat.endsWith('/**') && path === pat.slice(0, -3))
}

function callPath(call: Call, folder: string): string {
  const i = call.tool_input ?? {}
  const p = String(i.file_path ?? i.notebook_path ?? i.path ?? folder)
  const abs = p.startsWith('~/') ? homedir() + p.slice(1) : isAbsolute(p) ? p : resolve(folder, p)
  return resolve(abs)
}

/** Split a shell line into simple commands (good enough for allow-list matching). */
export function subcommands(cmd: string): string[] {
  return cmd.split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(Boolean)
}

/** "ls *" matches "ls -la /x"; in Bash rules * spans anything, slashes included. */
function bashMatches(spec: string, cmd: string): boolean {
  return new RegExp(`^${spec.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's').test(cmd)
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const NAMED_TOOLS = new Set(['WebFetch', 'WebSearch'])

export function checkCall(settings: any, call: Call, folder: string, role = 'this role'): Check {
  const perms = settings?.permissions ?? {}
  if (perms.defaultMode === 'bypassPermissions') return { ok: true }
  const allow = ((perms.allow ?? []) as string[]).map(parseRule)
  const deny = ((perms.deny ?? []) as string[]).map(parseRule)
  const tool = call.tool_name
  const input = call.tool_input ?? {}
  const sandbox = settings?.sandbox

  if (tool === 'Bash') {
    const cmd = String(input.command ?? '')
    if (input.dangerouslyDisableSandbox && sandbox?.enabled) return { ok: false, why: `${role} 的 Bash 只能在 sandbox 裡執行, 不能跳出 sandbox` }
    if (deny.some(r => r.tool === 'Bash' && !r.spec)) return { ok: false, why: `${role} 不能使用 Bash` }
    const subs = subcommands(cmd)
    for (const s of subs) if (deny.some(r => r.tool === 'Bash' && (!r.spec || bashMatches(r.spec, s)))) return { ok: false, why: `${role} 禁止這個指令: ${s.slice(0, 80)}` }
    if (allow.some(r => r.tool === 'Bash' && !r.spec)) return { ok: true }
    if (!allow.some(r => r.tool === 'Bash')) return { ok: false, why: `${role} 不能使用 Bash` }
    const bad = subs.find(s => !allow.some(r => r.tool === 'Bash' && r.spec && bashMatches(r.spec, s)))
    return bad ? { ok: false, why: `${role} 的 Bash 只能跑唯讀指令, 這個不在允許範圍: ${bad.slice(0, 80)}` } : { ok: true }
  }

  if (READ_TOOLS.has(tool) || EDIT_TOOLS.has(tool)) {
    const path = callPath(call, folder)
    const kinds = EDIT_TOOLS.has(tool) ? ['Edit', 'Write'] : ['Read']
    const hit = (rs: Rule[]) => rs.some(r => kinds.includes(r.tool) && (!r.spec || pathMatches(r.spec, path, folder)))
    if (hit(deny)) return { ok: false, why: `${role} 禁止${EDIT_TOOLS.has(tool) ? '寫入' : '讀取'} ${path}` }
    if (hit(allow)) return { ok: true }
    return { ok: false, why: `${role} 不能${EDIT_TOOLS.has(tool) ? '寫入' : '讀取'}允許範圍外的路徑: ${path}` }
  }

  if (NAMED_TOOLS.has(tool)) {
    if (deny.some(r => r.tool === tool && !r.spec)) return { ok: false, why: `${role} 禁止 ${tool}` }
    return allow.some(r => r.tool === tool) ? { ok: true } : { ok: false, why: `${role} 不能使用 ${tool}` }
  }

  if (tool.startsWith('mcp__')) {
    const covers = (r: Rule) => !r.spec && (r.tool === tool || tool.startsWith(r.tool + '__'))
    if (deny.some(covers)) return { ok: false, why: `${role} 禁止 ${tool}` }
    return allow.some(covers) ? { ok: true } : { ok: false, why: `${role} 不能使用 ${tool} (不在 MCP 白名單)` }
  }

  return { ok: true }
}

/** One line for logs and approval messages. */
export function describeCall(call: Call): string {
  const i = call.tool_input ?? {}
  const what = i.command ?? i.file_path ?? i.notebook_path ?? i.path ?? i.url ?? i.query ?? ''
  return `${call.tool_name}${i.dangerouslyDisableSandbox ? ' (跳出 sandbox)' : ''}: ${String(what).replace(/\s+/g, ' ').slice(0, 160)}`
}
