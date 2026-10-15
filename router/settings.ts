// Per-conversation settings (plan 03 「對話權限怎麼算」, 07). base-settings.json
// + roles/<role>.json, placeholders filled, written to
// <stateDir>/sessions/<key>.json and passed to the worker via --settings.
// Lives outside the conversation folder so a worker can never edit its own
// permissions. Phase 1 has only the owner and user templates; overrides come
// in Phase 3.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

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

/** Replace {{name}} inside strings; a string that is exactly one placeholder
 *  takes the value's own type (so numbers stay numbers). */
export function fill(v: Json, vars: Record<string, string | number>): Json {
  if (typeof v === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(v)
    if (whole && whole[1] in vars) return vars[whole[1]]
    return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  }
  if (Array.isArray(v)) return v.map(x => fill(x, vars))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]))
  return v
}

export function renderSettings(templatesDir: string, role: string, vars: Record<string, string | number>): Json {
  const base = JSON.parse(readFileSync(join(templatesDir, 'base-settings.json'), 'utf8'))
  const rolePath = join(templatesDir, 'roles', `${role}.json`)
  if (!existsSync(rolePath)) throw new Error(`no settings template for role ${role}`)
  const roleT = JSON.parse(readFileSync(rolePath, 'utf8'))
  return fill(deepMerge(base, roleT), vars)
}

export function writeSessionSettings(stateDir: string, templatesDir: string, key: string, role: string, vars: Record<string, string | number>): string {
  const dir = join(stateDir, 'sessions')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${key}.json`)
  writeFileSync(path, JSON.stringify(renderSettings(templatesDir, role, vars), null, 2) + '\n', { mode: 0o600 })
  return path
}
