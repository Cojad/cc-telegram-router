// Privileged skill actions: a skill's sudo bit (plan 10d, 柯姊 2026-10-16).
// A skill installed at bot or all-bots scope may carry privileged.json, a
// list of actions (like sudoers entries). Once owner or admin approves the
// skill (/router skill approve), a conversation of an allowed role calls an
// action with run_skill; the router runs it outside the conversation's own
// sandbox, in a bwrap sandbox made for that action:
//   - reads: the system, the skill folder, the action's credential folders
//   - writes: the conversation folder (its .chat stays read-only), a private /tmp
//   - hidden: the rest of /x (router state, other conversations), $HOME
// Credentials are handed to the script as folder paths in env vars; the
// conversation never gets them. The skill's files are hashed at approval and
// checked before every run. Arguments are matched against the action's
// patterns and passed one by one (no shell). Output going back to the
// conversation, and text files the run wrote, are scanned for credential
// content: anything found is removed and the owner told. At most 10 runs per
// conversation per hour. An action may name a refresh action (internal, not
// callable by conversations) the router runs once when the output shows the
// credentials were refused, then it retries.

import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync, lstatSync, rmSync } from 'fs'
import { join, relative, isAbsolute } from 'path'

export type ArgSpec = { pattern?: string; flag?: string }
export type Action = {
  /** argv: "scripts/x.sh" resolves inside the skill; "{name}" an argument;
   *  "{name?}" an optional flag argument; "{cred:ENV}" that credential's folder. */
  run: string[]
  args?: Record<string, ArgSpec>
  roles?: string[]
  /** env var -> credential folder name (under the router's creds dir) */
  creds?: Record<string, string>
  timeout?: number
  /** Not callable by conversations: only the router runs it (refresh). */
  internal?: boolean
  /** Output matching this means the credentials were refused... */
  auth_failure?: string
  /** ...then run this internal action once and retry. */
  refresh?: string
}
export type Manifest = { actions: Record<string, Action> }

export const RUNS_PER_HOUR = 10
const SKIP = /(^|\/)(venv|node_modules|__pycache__|\.git)(\/|$)/

export function loadManifest(skillDir: string): Manifest | null {
  const p = join(skillDir, 'privileged.json')
  if (!existsSync(p)) return null
  const m = JSON.parse(readFileSync(p, 'utf8')) as Manifest
  if (!m.actions || typeof m.actions !== 'object') throw new Error('privileged.json 要有 actions')
  return m
}

/** Every file of the skill (skipping venv and the like), in order: approval pins this. */
export function hashSkill(skillDir: string): string {
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e), rel = relative(skillDir, p)
      if (SKIP.test(rel)) continue
      const st = lstatSync(p)
      if (st.isSymbolicLink()) { files.push(`${rel} -> link`); continue }
      if (st.isDirectory()) walk(p); else files.push(rel)
    }
  }
  walk(skillDir)
  const h = createHash('sha256')
  for (const rel of files) {
    h.update(rel + '\0')
    if (!rel.endsWith(' -> link')) h.update(readFileSync(join(skillDir, rel)))
  }
  return h.digest('hex')
}

/** argv for an action, or why the arguments are refused. */
export function buildArgv(a: Action, skillDir: string, args: Record<string, unknown>, credDir: (name: string) => string): string[] | { error: string } {
  const out: string[] = []
  const known = new Set(Object.keys(a.args ?? {}))
  for (const k of Object.keys(args)) if (!known.has(k)) return { error: `沒有這個參數: ${k} (可用: ${[...known].join(', ') || '(無)'})` }
  for (const tok of a.run) {
    const m = /^\{(cred:)?([\w-]+)(\?)?\}$/.exec(tok)
    if (m?.[1]) {
      const name = a.creds?.[m[2]!]
      if (!name) return { error: `動作清單錯誤: ${tok} 沒有對應的 creds` }
      out.push(credDir(name))
      continue
    }
    if (m) {
      const spec = a.args?.[m[2]!]
      const v = args[m[2]!]
      if (!spec) return { error: `動作清單錯誤: ${tok} 沒有對應的 args` }
      if (spec.flag) { if (v === true || v === 'true') out.push(spec.flag); continue }
      if (v === undefined || v === null || v === '') { if (m[3]) continue; return { error: `缺少參數 ${m[2]}` } }
      const s = String(v)
      if (s.length > 2000 || /[\0\n\r]/.test(s)) return { error: `參數 ${m[2]} 格式不對` }
      if (spec.pattern && !new RegExp(`^(?:${spec.pattern})$`).test(s)) return { error: `參數 ${m[2]} 不符合格式: ${spec.pattern}` }
      out.push(s)
      continue
    }
    // a path inside the skill, or a plain word (bash, python3, --flag)
    if (tok.includes('/') && !isAbsolute(tok) && existsSync(join(skillDir, tok))) out.push(join(skillDir, tok))
    else out.push(tok)
  }
  return out
}

/** Values in Netscape cookie files (and plain secret files): what must never come back. */
export function secretsIn(dirs: string[]): string[] {
  const out = new Set<string>()
  for (const d of dirs) {
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (!statSync(p).isFile() || statSync(p).size > 2_000_000) continue
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (!line || line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue
        const cols = line.split('\t')
        const v = cols.length >= 7 ? cols[6]!.trim() : line.trim()
        if (v.length >= 16) out.add(v)
      }
    }
  }
  return [...out]
}

const TEXT = /\.(json|txt|vtt|srt|err|log|md|csv|html?|xml)$/i

/** Remove what the run wrote that holds a secret (or looks like a cookie jar). Returns the files removed. */
export function scrubOutputs(root: string, since: number, secrets: string[]): string[] {
  const removed: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = lstatSync(p)
      if (st.isDirectory()) { if (e !== '.chat') walk(p); continue }
      if (!st.isFile() || st.mtimeMs < since) continue
      const cookieJar = /cookie/i.test(e)
      const leaked = !cookieJar && TEXT.test(e) && st.size < 5_000_000 && secrets.some(s => readFileSync(p, 'utf8').includes(s))
      if (cookieJar || leaked) { rmSync(p, { force: true }); removed.push(relative(root, p)) }
    }
  }
  if (existsSync(root)) walk(root)
  return removed
}

export function redact(text: string, secrets: string[]): { text: string; hit: boolean } {
  let hit = false
  for (const s of secrets) if (text.includes(s)) { hit = true; text = text.split(s).join('<已遮蔽>') }
  return { text, hit }
}

export type Sandbox = { argv: string[]; env: Record<string, string> }

/** bwrap for one run: the system read-only, /x and $HOME hidden, then the
 *  skill and credential folders read-only and the conversation folder writable. */
export function sandboxArgv(o: { argv: string[]; skillDir: string; convFolder: string; creds: Record<string, string>; home: string; extraRo?: string[]; env?: Record<string, string>; credsWritable?: boolean }): Sandbox {
  const b = ['bwrap', '--die-with-parent', '--unshare-pid', '--new-session', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--tmpfs', '/tmp', '--tmpfs', '/x', '--tmpfs', o.home]
  for (const p of o.extraRo ?? []) if (existsSync(p)) b.push('--ro-bind', p, p)
  b.push('--ro-bind', o.skillDir, o.skillDir)
  // only the router's own refresh writes credentials; actions a conversation calls read them
  for (const d of Object.values(o.creds)) b.push(o.credsWritable ? '--bind' : '--ro-bind', d, d)
  b.push('--bind', o.convFolder, o.convFolder)
  if (existsSync(join(o.convFolder, '.chat'))) b.push('--ro-bind', join(o.convFolder, '.chat'), join(o.convFolder, '.chat'))
  b.push('--chdir', o.convFolder, '--', ...o.argv)
  const env: Record<string, string> = { PATH: `${o.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`, HOME: '/tmp', LANG: 'C.UTF-8', TMPDIR: '/tmp', ...o.creds, ...o.env }
  return { argv: b, env }
}
