// Per-conversation settings (plan 03 「對話權限怎麼算」, 07). base-settings.json
// + roles/<role>.json, placeholders filled, written to
// <stateDir>/sessions/<key>.json and passed to the worker via --settings.
// Lives outside the conversation folder so a worker can never edit its own
// permissions. /router perm overrides are laid on top (applyOverrides).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, resolve, sep } from 'path'
import type { Override } from './db'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export function deepMerge(a: Json, b: Json): Json {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: { [k: string]: Json } = { ...a }
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v
    return out
  }
  return b
}

type Vars = Record<string, string | number | string[]>

/** Replace {{name}} inside strings; a string that is exactly one placeholder
 *  takes the value's own type (so numbers stay numbers), and inside an array
 *  a list value is spliced in (denyRead: ["{{hidden}}", "~"]). */
export function fill(v: Json, vars: Vars): Json {
  if (typeof v === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(v)
    if (whole && whole[1] in vars) return vars[whole[1]] as Json
    return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  }
  if (Array.isArray(v)) return v.flatMap(x => {
    const whole = typeof x === 'string' ? /^\{\{(\w+)\}\}$/.exec(x) : null
    const val = whole && whole[1] in vars ? vars[whole[1]] : undefined
    return Array.isArray(val) ? val : [fill(x, vars)]
  })
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]))
  return v
}

/** The paths that are not inside another one of them (normalized, deduped). */
export function outermost(paths: string[]): string[] {
  const norm = [...new Set(paths.map(p => resolve(p)))].sort((a, b) => a.length - b.length)
  const out: string[] = []
  for (const p of norm) if (!out.some(o => p === o || p.startsWith(o === sep ? o : o + sep))) out.push(p)
  return out
}

export function renderSettings(templatesDir: string, role: string, vars: Vars): Json {
  const base = JSON.parse(readFileSync(join(templatesDir, 'base-settings.json'), 'utf8'))
  const rolePath = join(templatesDir, 'roles', `${role}.json`)
  if (!existsSync(rolePath)) throw new Error(`no settings template for role ${role}`)
  const roleT = JSON.parse(readFileSync(rolePath, 'utf8'))
  const s = fill(deepMerge(base, roleT), vars) as any
  // A sandbox whose hidden paths did not get filled would show other
  // conversations and the router's state: refuse to render it.
  const deny: unknown[] = s?.sandbox?.filesystem?.denyRead ?? []
  const left = deny.find(p => typeof p !== 'string' || p.includes('{{'))
  if (left !== undefined) throw new Error(`role ${role}: sandbox denyRead ${JSON.stringify(left)} not filled`)
  return s
}

/** top: keys that replace the rendered ones as a whole (managed mode's plugin keys, router/claudecmd.ts pluginSettings). */
export function writeSessionSettings(stateDir: string, templatesDir: string, key: string, role: string, vars: Vars, overrides: Override[] = [], top: Record<string, unknown> | null = null): string {
  const dir = join(stateDir, 'sessions')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${key}.json`)
  const rendered = { ...(renderSettings(templatesDir, role, vars) as Record<string, Json>), ...(top as Record<string, Json> | null ?? {}) }
  writeFileSync(path, JSON.stringify(applyOverrides(rendered, overrides), null, 2) + '\n', { mode: 0o600 })
  return path
}

/** Lay /router perm overrides over a rendered settings object (plan 03 對話權限怎麼算).
 *  Paths go into both the permission rules and the Bash sandbox. */
export function applyOverrides(settings: Json, overrides: Override[]): Json {
  const s = JSON.parse(JSON.stringify(settings ?? {})) as any
  const perms = (s.permissions ??= {})
  const allow: string[] = (perms.allow ??= [])
  const deny: string[] = (perms.deny ??= [])
  const sandbox = s.sandbox
  const fs = sandbox ? (sandbox.filesystem ??= {}) : null
  const push = (arr: string[], v: string) => { if (!arr.includes(v)) arr.push(v) }
  for (const o of overrides) {
    const abs = o.value.replace(/\/+$/, '')
    switch (o.kind) {
      case 'tool-allow': push(allow, o.value); break
      case 'tool-deny': push(deny, o.value); break
      case 'path-read':
        push(allow, `Read(/${abs}/**)`)
        if (fs) push(fs.allowRead ??= [], abs)
        break
      case 'path-write':
        for (const t of ['Read', 'Edit', 'Write']) push(allow, `${t}(/${abs}/**)`)
        if (fs) { push(fs.allowRead ??= [], abs); push(fs.allowWrite ??= [], abs) }
        break
      case 'net':
        if (sandbox) push((sandbox.network ??= {}).allowedDomains ??= [], o.value)
        break
      case 'mcp': push(allow, `mcp__${o.value}`); break
      case 'send': break // enforced by the router (guard.ts), not by Claude Code
    }
  }
  return s
}
