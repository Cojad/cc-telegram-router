// Would this tool call be allowed under a role's settings? (plan 07 權限檢查)
// The router answers this in PreToolUse so a refusal can explain itself and,
// when the person who asked has a higher role, offer elevation. It reads the
// same settings the worker gets (role template + /router perm overrides) and
// understands the rule shapes those use; tools it does not know are left to
// Claude Code (never blocked here).

import { realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'

export const RANK: Record<string, number> = { guest: 0, user: 1, power: 2, admin: 3, owner: 4 }
export const rank = (role: string | null | undefined) => RANK[role ?? ''] ?? 1

export type Call = { tool_name: string; tool_input: Record<string, any> }
export type Check = { ok: true } | { ok: false; why: string; redirect?: true; writeOption?: true }

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

/** The path with every symlink resolved: realpath of the longest part that exists, the rest
 *  as written (a file not written yet). A symlink can then not carry a write out of a rule. */
export function canonicalPath(p: string): string {
  const tail: string[] = []
  for (let cur = resolve(p); ; cur = dirname(cur)) {
    try { return join(realpathSync(cur), ...tail.reverse()) } catch {}
    if (cur === dirname(cur)) return resolve(p)
    tail.push(basename(cur))
  }
}

/** A rule's path pattern with symlinks resolved in its folders (up to the first glob, never its
 *  last part), so it compares with canonicalPath: a home reached through a symlink still matches
 *  its own rules, and a rule for a file that is itself a link does not open the link's target. */
function canonicalPattern(pat: string): string {
  const star = pat.indexOf('*')
  const cut = pat.lastIndexOf('/', star < 0 ? pat.length : star)
  return cut <= 0 ? pat : canonicalPath(pat.slice(0, cut)) + pat.slice(cut)
}

function pathMatches(spec: string, path: string, folder: string, canonical = false): boolean {
  const pat = canonical ? canonicalPattern(ruleSpecPath(spec, folder)) : ruleSpecPath(spec, folder)
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

/** Split a shell line into simple commands at &&, ||, |, ; and newlines
 *  (good enough for allow-list matching). Quoted text and escaped characters
 *  are not split: grep -E 'a|b' is one command (as writesFile reads them). */
export function subcommands(cmd: string): string[] {
  const out: string[] = []
  let cur = '', q: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (q) {
      cur += c
      if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i]
      else if (c === q) q = null
      continue
    }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue }
    if (c === "'" || c === '"') { q = c; cur += c; continue }
    const two = cmd.slice(i, i + 2)
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue }
    if (c === '|' || c === ';' || c === '\n') { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

/** Shell words of a simple command, quotes removed (for reading options). */
function shellWords(cmd: string): string[] {
  return (cmd.match(/(?:[^\s"'\\]+|"(?:\\.|[^"\\])*"|'[^']*'|\\.)+/g) ?? []).map(w => w.replace(/^'|'$/g, '').replace(/^"|"$/g, ''))
}

/** A read-only command that writes a file through an option: sort -o/--output, uniq with an output file. */
export function writesByOption(cmd: string): boolean {
  const w = shellWords(cmd)
  const tool = w[0]?.split('/').pop()
  if (tool === 'sort') return w.slice(1).some(a => /^--output(=|$)/.test(a) || /^-[a-zA-Z]*o/.test(a) && !a.startsWith('--'))
  // uniq [options] [input [output]]: a second operand is written
  if (tool === 'uniq') {
    const operands: string[] = []
    for (let i = 1; i < w.length; i++) {
      const a = w[i]!
      if (a === '--') { operands.push(...w.slice(i + 1)); break }
      if (/^-[fsw]$/.test(a)) { i++; continue } // -f N, -s N, -w N take a value
      if (a.startsWith('-') && a !== '-') continue
      operands.push(a)
    }
    return operands.length >= 2
  }
  return false
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
    // sort -o, uniq in out: a read-only command made to write a file
    const byOption = subs.find(writesByOption)
    if (byOption) return { ok: false, why: `${role} 的 Bash 只能跑唯讀指令, 這個用選項寫入檔案: ${byOption.slice(0, 80)}`, writeOption: true }
    const bad = subs.find(s => !allow.some(r => r.tool === 'Bash' && r.spec && bashMatches(r.spec, s)))
    return bad ? { ok: false, why: `${role} 的 Bash 只能跑唯讀指令, 這個不在允許範圍: ${bad.slice(0, 80)}` } : { ok: true }
  }

  if (READ_TOOLS.has(tool) || EDIT_TOOLS.has(tool)) {
    // `..` is resolved by callPath; a symlink by canonicalPath: the path as written and where it
    // really leads must both stay clear of deny rules, and where it leads must be allowed
    const path = callPath(call, folder), real = canonicalPath(path)
    const kinds = EDIT_TOOLS.has(tool) ? ['Edit', 'Write'] : ['Read']
    const hit = (rs: Rule[], p: string, canonical: boolean) => rs.some(r => kinds.includes(r.tool) && (!r.spec || pathMatches(r.spec, p, folder, canonical)))
    if (hit(deny, path, false) || hit(deny, real, true)) return { ok: false, why: `${role} 禁止${EDIT_TOOLS.has(tool) ? '寫入' : '讀取'} ${path}${real !== path ? ` (實際是 ${real})` : ''}` }
    if (hit(allow, real, true)) return { ok: true }
    return { ok: false, why: `${role} 不能${EDIT_TOOLS.has(tool) ? '寫入' : '讀取'}允許範圍外的路徑: ${path}${real !== path ? ` (實際是 ${real})` : ''}` }
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
    if (!c.ok && c.writeOption) return { none: '用選項寫入檔案 (例如 sort -o) 沒辦法寫成固定規則, 只能一次一次允許; 要長期開放請 owner 調整對話角色' }
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

// High-risk tools (柯姊 2026-10-17): reach beyond the conversation (other
// sessions on the machine, schedules, remote runs, desktop notices). The
// role templates do not mention them, so checkCall lets them through; the
// router refuses them for power and below and offers elevation, once only.
// A settings allow rule naming the tool alone (a role template, or a
// /router perm tool allow ListAgents) opens it below admin; a deny rule
// naming it closes it for every role.
export const RISKY_TOOLS = new Set(['ListAgents', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'PushNotification'])
/** Lowest role that may use the high-risk tools (and SendMessage to other sessions) without elevation. */
export const RISKY_MIN = 'admin'

/** SendMessage's recipient ("to"; "recipient" in older builds). */
export const sendTarget = (call: Call) => String(call.tool_input?.to ?? call.tool_input?.recipient ?? '').trim()

/** Is this call refused for role by the high-risk rule? isOwn: the SendMessage
 *  recipient is one of the conversation's own subagents (elevation.ts decides).
 *  settings: the role's permission settings, whose allow / deny rules naming the tool decide first. */
export function riskyRefusal(call: Call, role: string, isOwn: boolean, settings?: any): string | null {
  const tool = call.tool_name
  if (!RISKY_TOOLS.has(tool) && tool !== 'SendMessage') return null
  const named = (k: 'allow' | 'deny') => ((settings?.permissions?.[k] ?? []) as string[]).includes(tool)
  if (named('deny')) return `${role} 禁止 ${tool}`
  if (rank(role) >= RANK[RISKY_MIN]! || named('allow')) return null
  if (RISKY_TOOLS.has(tool)) return `power 以下的角色不能使用 ${tool}`
  if (!isOwn) return `power 以下的角色不能傳訊給其他 session (收件對象 ${sendTarget(call).slice(0, 60) || '(空白)'} 不是這個對話自己的 subagent)`
  return null
}
