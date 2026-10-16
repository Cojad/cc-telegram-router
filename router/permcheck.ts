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
export type Check = { ok: true } | { ok: false; why: string; redirect?: true }

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

const NULL_DEVS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])

/** Does a simple command write a file through a redirection (>, >>, &>, >|,
 *  <>, >(...))? Claude Code does not let a read-only allow rule such as
 *  Bash(echo *) cover it, so neither does the router. Quoted text, escaped
 *  characters, >/dev/null and fd copies (2>&1) do not count; a command
 *  substitution inside double quotes is looked into. */
export function writesFile(cmd: string): boolean {
  const s = cmd.replace(/\\[\s\S]/g, '__')
    .replace(/'[^']*'/g, "''")
    .replace(/"([^"]*)"/g, (_m, inner: string) => /\$\(|`/.test(inner) ? ` ${inner} ` : '""')
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '>') continue
    let j = i + 1
    if (s[j] === '(') return true
    if (s[j] === '>') j++
    if (s[j] === '|') j++
    let fdCopy = false
    if (s[j] === '&') { fdCopy = true; j++ }
    while (s[j] === ' ' || s[j] === '\t') j++
    let target = ''
    while (j < s.length && !/[\s;&|<>()]/.test(s[j]!)) target += s[j++]
    if (fdCopy ? !/^(\d+|-)$/.test(target) : !NULL_DEVS.has(target)) return true
    i = j - 1
  }
  return false
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
    // only read-only commands are allowed: one that writes a file through a redirection is not read-only
    const writes = subs.find(writesFile)
    if (writes) return { ok: false, why: `${role} 的 Bash 只能跑唯讀指令, 這個用重導向寫入檔案: ${writes.slice(0, 80)}`, redirect: true }
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
  // anything else (an MCP tool such as run_skill): its arguments as they are
  const what = i.command ?? i.file_path ?? i.notebook_path ?? i.path ?? i.url ?? i.query ?? (Object.keys(i).length ? JSON.stringify(i) : '')
  return `${call.tool_name}${i.dangerouslyDisableSandbox ? ' (跳出 sandbox)' : ''}: ${String(what).replace(/\s+/g, ' ').slice(0, 160)}`
}

export type Rule = { overrides: Array<{ kind: 'tool-allow' | 'path-read' | 'path-write' | 'mcp'; value: string }>; desc: string }

/** What 永久允許 would add for a blocked call (柯姊 2026-10-16: 「該類動作」):
 *  Bash -> the leading command of each refused part, Bash(<cmd>) and Bash(<cmd> *); reads and
 *  writes -> the folder of the path; WebFetch/WebSearch -> the tool; MCP ->
 *  the server. lay(settings, overrides) applies /router perm overrides (from
 *  settings.ts); the rule is offered only when it really makes the call pass.
 *  Leaving the sandbox has no such rule. */
export function permanentRule(settings: any, call: Call, folder: string, lay: (s: any, o: Rule['overrides']) => any): Rule | { none: string } {
  const i = call.tool_input ?? {}
  const tool = call.tool_name
  let r: Rule | null = null
  if (tool === 'Bash') {
    if (i.dangerouslyDisableSandbox) return { none: '跳出 sandbox 沒辦法寫成固定規則, 只能一次一次允許' }
    const c = checkCall(settings, call, folder)
    if (!c.ok && c.redirect) return { none: '用重導向 (>, >>) 寫入檔案沒辦法寫成固定規則, 只能一次一次允許; 要長期開放請 owner 調整對話角色' }
    const cmds = [...new Set(subcommands(String(i.command ?? ''))
      .filter(s => !checkCall(settings, { tool_name: 'Bash', tool_input: { command: s } }, folder).ok)
      .map(s => s.split(/\s+/).find(w => !/^\w+=/.test(w) && w !== 'sudo') ?? ''))].filter(Boolean)
    // both shapes, like the role templates (Bash(ls) + Bash(ls *)): "hostname" alone never matches Bash(hostname *)
    if (cmds.length) r = { overrides: cmds.flatMap(c => [{ kind: 'tool-allow' as const, value: `Bash(${c})` }, { kind: 'tool-allow' as const, value: `Bash(${c} *)` }]), desc: `執行 ${cmds.join(', ')} 開頭的 Bash 指令 (仍在 sandbox 裡)` }
  } else if (READ_TOOLS.has(tool) || EDIT_TOOLS.has(tool)) {
    const p = callPath(call, folder)
    const dir = tool === 'Glob' || tool === 'Grep' || tool === 'LS' ? p : p.replace(/\/[^/]*$/, '') || '/'
    const write = EDIT_TOOLS.has(tool)
    r = { overrides: [{ kind: write ? 'path-write' : 'path-read', value: dir }], desc: `${write ? '讀寫' : '讀取'} ${dir} 底下的檔案` }
  } else if (NAMED_TOOLS.has(tool)) {
    r = { overrides: [{ kind: 'tool-allow', value: tool }], desc: `使用 ${tool}` }
  } else if (tool.startsWith('mcp__')) {
    const server = tool.split('__')[1]!
    r = { overrides: [{ kind: 'mcp', value: server }], desc: `使用 MCP ${server} 的所有工具` }
  }
  if (!r) return { none: '這類動作沒有對應的權限規則' }
  if (!checkCall(lay(settings, r.overrides), call, folder).ok) return { none: '這類動作是這個角色明確禁止的, 要改對話角色才行' }
  return r
}
