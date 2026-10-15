// Spot package installs in a Bash command (plan 07 power 安裝套件). Only
// what a power conversation would normally type is recognised; anything
// installing from a URL, a local path or a custom index is flagged so it
// goes to the owner instead of the automatic review.

import { readFileSync } from 'fs'
import { isAbsolute, join } from 'path'

export type Eco = 'pypi' | 'npm'
export type Pkg = { eco: Eco; name: string }
/** pkgs: named on the command line or read from a manifest; unusual: sources the review cannot judge (URL, path, custom index). */
export type Install = { pkgs: Pkg[]; manifests: Array<{ eco: Eco; path: string }>; unusual: string[] }

/** Cheap test the hook runs on every Bash command before asking the router. */
export const INSTALL_HINT = /\b(pip3?|pipx|uv|uvx|poetry|pdm|npm|npx|bun|bunx|yarn|pnpm)\b/

function words(segment: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]!)
  return out
}

/** npx/uvx run one package: keep the flags before it and the package itself, not its own arguments. */
function firstArg(args: string[]): string[] {
  const i = args.findIndex(a => !a.startsWith('-'))
  return i < 0 ? args : args.slice(0, i + 1)
}

const PIP_VALUE_FLAGS = new Set(['-c', '--constraint', '-t', '--target', '--prefix', '--root', '--python', '-p', '--platform', '--python-version', '--implementation', '--abi', '--src', '--group', '--extra', '--with'])
const PIP_INDEX_FLAGS = new Set(['-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--index'])
const NPM_VALUE_FLAGS = new Set(['--prefix', '-C', '--cwd', '--registry', '--tag', '--workspace', '-w', '--filter'])

function pypiName(spec: string): string | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([<>=!~;@].*)?$/.exec(spec)
  return m ? m[1]!.toLowerCase().replace(/[._]+/g, '-') : null
}

function npmName(spec: string): string | null {
  const m = /^(@[a-z0-9][\w.-]*\/[\w.-]+|[a-z0-9][\w.-]*)(@.*)?$/i.exec(spec)
  return m ? m[1]!.toLowerCase() : null
}

/** Parse every install in a command line; null when there is none. */
export function parseInstall(command: string): Install | null {
  const res: Install = { pkgs: [], manifests: [], unusual: [] }
  let found = false
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    let w = words(segment.trim())
    while (w[0] && (/^\w+=/.test(w[0]) || w[0] === 'sudo' || w[0] === 'env' || w[0] === 'exec' || w[0] === 'time')) w = w.slice(1)
    // python -m pip ..., python3.12 -m pip ...
    if (w[0] && /^python[\d.]*$/.test(w[0]) && w[1] === '-m') w = w.slice(2)
    const [tool, sub] = [w[0]?.split('/').pop() ?? '', w[1]]
    let eco: Eco | null = null, rest: string[] = []
    if ((tool === 'pip' || tool === 'pip3' || tool === 'pipx') && (sub === 'install' || sub === 'run')) { eco = 'pypi'; rest = w.slice(2) }
    else if (tool === 'uv' && w[1] === 'pip' && w[2] === 'install') { eco = 'pypi'; rest = w.slice(3) }
    else if (tool === 'uv' && (sub === 'add' || (sub === 'tool' && (w[2] === 'install' || w[2] === 'run')))) { eco = 'pypi'; rest = w.slice(sub === 'tool' ? 3 : 2) }
    else if (tool === 'uv' && sub === 'sync') { found = true; res.manifests.push({ eco: 'pypi', path: 'pyproject.toml' }); continue }
    else if (tool === 'uvx') { eco = 'pypi'; rest = firstArg(w.slice(1)) }
    else if ((tool === 'poetry' || tool === 'pdm') && sub === 'add') { eco = 'pypi'; rest = w.slice(2) }
    else if ((tool === 'poetry' || tool === 'pdm') && sub === 'install') { found = true; res.manifests.push({ eco: 'pypi', path: 'pyproject.toml' }); continue }
    else if (tool === 'npm' && ['install', 'i', 'in', 'add', 'isntall', 'ci', 'exec'].includes(sub ?? '')) { eco = 'npm'; rest = w.slice(2) }
    else if ((tool === 'bun' || tool === 'pnpm') && ['add', 'install', 'i', 'x', 'dlx'].includes(sub ?? '')) { eco = 'npm'; rest = w.slice(2) }
    else if (tool === 'yarn' && (sub === 'add' || sub === 'install' || sub === 'dlx' || sub === undefined)) { eco = 'npm'; rest = w.slice(2) }
    else if (tool === 'npx' || tool === 'bunx') { eco = 'npm'; rest = firstArg(w.slice(1)) }
    if (!eco) continue
    found = true
    let named = 0
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!
      if (a === '--') continue
      const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
      if (eco === 'pypi' && (flag === '-r' || flag === '--requirement')) { const v = inline ?? rest[++i]; if (v) res.manifests.push({ eco, path: v }); continue }
      if (eco === 'pypi' && (flag === '-e' || flag === '--editable')) { res.unusual.push(`editable ${inline ?? rest[++i] ?? ''}`.trim()); continue }
      if (eco === 'pypi' && PIP_INDEX_FLAGS.has(flag)) { res.unusual.push(`index ${inline ?? rest[++i] ?? ''}`.trim()); continue }
      if (eco === 'npm' && flag === '--registry') { res.unusual.push(`registry ${inline ?? rest[++i] ?? ''}`.trim()); continue }
      if ((eco === 'pypi' ? PIP_VALUE_FLAGS : NPM_VALUE_FLAGS).has(flag)) { if (inline === undefined) i++; continue }
      if (a.startsWith('-')) continue
      named++
      if (/^(git\+|https?:|file:|\.|\/|~)/.test(a) || a.includes('/') && !a.startsWith('@')) { res.unusual.push(a); continue }
      const name = eco === 'pypi' ? pypiName(a) : npmName(a)
      if (name) res.pkgs.push({ eco, name })
      else res.unusual.push(a)
    }
    // bare npm/bun/yarn/pnpm install installs package.json
    if (eco === 'npm' && !named && !['x', 'dlx', 'exec'].includes(sub ?? '') && tool !== 'npx' && tool !== 'bunx') res.manifests.push({ eco, path: 'package.json' })
  }
  if (!found) return null
  const seen = new Set<string>()
  res.pkgs = res.pkgs.filter(p => { const k = `${p.eco}:${p.name}`; if (seen.has(k)) return false; seen.add(k); return true })
  return res
}

/** Package names listed in a manifest inside the conversation folder. Paths
 *  outside the folder are not read (unusual instead). */
export function readManifest(folder: string, m: { eco: Eco; path: string }): { pkgs: Pkg[]; unusual: string[] } {
  const path = isAbsolute(m.path) ? m.path : join(folder, m.path)
  if (!path.startsWith(folder + '/')) return { pkgs: [], unusual: [`manifest outside the folder: ${m.path}`] }
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return { pkgs: [], unusual: [] } } // missing: the install fails by itself
  const pkgs: Pkg[] = [], unusual: string[] = []
  if (m.path.endsWith('package.json')) {
    try {
      const j = JSON.parse(text)
      for (const [name, ver] of Object.entries({ ...j.dependencies, ...j.devDependencies, ...j.optionalDependencies } as Record<string, string>)) {
        if (/^(git|https?:|file:|link:|github:|\.|\/)/.test(String(ver)) || String(ver).includes('/')) unusual.push(`${name}@${ver}`)
        else pkgs.push({ eco: 'npm', name: name.toLowerCase() })
      }
    } catch { unusual.push(`${m.path}: not valid JSON`) }
  } else if (m.path.endsWith('.toml')) {
    const deps = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text)?.[1] ?? ''
    for (const q of deps.matchAll(/["']([^"']+)["']/g)) { const n = pypiName(q[1]!); if (n) pkgs.push({ eco: 'pypi', name: n }); else unusual.push(q[1]!) }
  } else {
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*/, '').trim()
      if (!line) continue
      if (line.startsWith('-')) { unusual.push(line); continue }
      const n = pypiName(line)
      if (n && !line.includes('://')) pkgs.push({ eco: 'pypi', name: n }); else unusual.push(line)
    }
  }
  return { pkgs, unusual }
}
