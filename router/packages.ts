// Spot package installs in a Bash command (plan 07 power 安裝套件). Only
// what a power conversation would normally type is recognised; anything
// installing from a URL, a local path or a custom index is flagged so it
// goes to the owner instead of the automatic review. An option that changes
// where packages come from (--index-url, --extra-index-url, --find-links,
// --registry...) makes every package of that install a custom-source item,
// "<package> (來源 <url>)": the PyPI/npm facts say nothing about what that
// source serves, so a person decides, and only for that one install
// (pkgreview.ts writes no override for it).

import { readFileSync } from 'fs'
import { isAbsolute, join } from 'path'

export type Eco = 'pypi' | 'npm'
export type Pkg = { eco: Eco; name: string }
/** pkgs: registry packages named on the command line; manifests: files to read them from (source: from a
 *  custom source, see custom); unusual: what the review cannot judge (URL, path, editable); custom: packages
 *  from a custom source, "<package> (來源 <source>)". */
export type Install = { pkgs: Pkg[]; manifests: Array<{ eco: Eco; path: string; source?: string }>; unusual: string[]; custom: string[] }

/** The custom-source item for a package (or a manifest's package) installed from source. */
export const customItem = (spec: string, source: string) => `${spec} (來源 ${source})`

/** Cheap test the hook runs on every Bash command before asking the router. */
export const INSTALL_HINT = /\b(pip3?|pipx|uv|uvx|poetry|pdm|npm|npx|bun|bunx|yarn|pnpm)\b/

/** Shell words, quotes removed; a quote may sit inside a word (--pip-args="--index-url x"). */
function words(segment: string): string[] {
  return (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map(w => w.replace(/"([^"]*)"|'([^']*)'/g, (_m, d, q) => d ?? q))
}


// Options that take a value (the next word, or --x=value): the value is never a package.
// pip, pipx, uv pip / add / tool, poetry, pdm.
const PIP_VALUE_FLAGS = new Set([
  '-c', '--constraint', '-t', '--target', '--prefix', '--root', '--python', '-p', '--platform', '--python-version', '--implementation', '--abi', '--src',
  '--group', '-G', '--extra', '-E', '--extras', '--optional',
  '--only-binary', '--no-binary', '--progress-bar', '--upgrade-strategy', '--log', '--log-file', '--cache-dir', '--cert', '--client-cert', '--proxy', '--retries',
  '--timeout', '--exists-action', '--global-option', '--build-option', '-C', '--config-settings', '--config-setting', '--report', '--root-user-action',
  '--keyring-provider', '--use-feature', '--use-deprecated', '--suffix',
  '--index-strategy', '--resolution', '--prerelease', '--link-mode', '--torch-backend', '--python-platform', '--exclude-newer', '-P', '--upgrade-package',
  '--reinstall-package', '--no-binary-package', '--no-build-package', '--rev', '--tag', '--branch', '--marker', '-m', '--script', '--package', '--directory', '--project',
])
// Options whose value is a package of its own (uvx --from x, uv/uvx --with y, pipx run --spec z).
const PIP_PKG_FLAGS = new Set(['--with', '--from', '--spec'])
// Options that change where packages come from: the whole install goes to the owner (custom source).
const PIP_INDEX_FLAGS = new Set(['-i', '--index-url', '--extra-index-url', '-f', '--find-links', '--index', '--default-index', '--trusted-host', '--source', '--pip-args'])
// npm, npx, bun, bunx, yarn, pnpm.
const NPM_VALUE_FLAGS = new Set([
  '--prefix', '-C', '--cwd', '--dir', '--tag', '--workspace', '-w', '--filter', '-c', '--call', '--omit', '--include', '--install-strategy', '--cache', '--cache-dir',
  '--save-prefix', '--loglevel', '--before', '--os', '--cpu', '--libc', '--linker', '--backend', '--network-concurrency', '--concurrency',
])
const NPM_PKG_FLAGS = new Set(['-p', '--package'])
const NPM_SOURCE_FLAGS = new Set(['--registry', '--userconfig', '--globalconfig', '--config'])

/** Does this option take the next word as its value? */
function takesValue(eco: Eco, flag: string): boolean {
  return eco === 'pypi'
    ? PIP_VALUE_FLAGS.has(flag) || PIP_PKG_FLAGS.has(flag) || PIP_INDEX_FLAGS.has(flag) || ['-r', '--requirement', '-e', '--editable'].includes(flag)
    : NPM_VALUE_FLAGS.has(flag) || NPM_PKG_FLAGS.has(flag) || NPM_SOURCE_FLAGS.has(flag) || /^--@[^:]+:registry$/.test(flag)
}

/** npx/uvx run one package: keep the options before it (with their values)
 *  and the package itself, not its own arguments. When an option named the
 *  package (uvx --from x cmd, npx -p x cmd), the first word is a command. */
function firstArg(eco: Eco, args: string[]): string[] {
  const named = (a: string) => (eco === 'pypi' ? ['--from', '--spec'] : [...NPM_PKG_FLAGS]).includes(a.split('=')[0]!)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('-')) return args.slice(0, args.slice(0, i).some(named) ? i : i + 1)
    if (!a.includes('=') && takesValue(eco, a)) i++
  }
  return args
}

function pypiName(spec: string): string | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([<>=!~;@].*)?$/.exec(spec)
  return m ? m[1]!.toLowerCase().replace(/[._]+/g, '-') : null
}

function npmName(spec: string): string | null {
  const m = /^(@[a-z0-9][\w.-]*\/[\w.-]+|[a-z0-9][\w.-]*)(@.*)?$/i.exec(spec)
  return m ? m[1]!.toLowerCase() : null
}

/** One package spec: a registry package (with the spec as typed), or something the review cannot judge (URL, path). */
function addSpec(seg: { pkgs: Array<{ pkg: Pkg; spec: string }>; unusual: string[] }, eco: Eco, a: string): void {
  if (/^(git\+|https?:|file:|\.|\/|~)/.test(a) || a.includes('/') && !a.startsWith('@')) { seg.unusual.push(a); return }
  const name = eco === 'pypi' ? pypiName(a) : npmName(a)
  if (name) seg.pkgs.push({ pkg: { eco, name }, spec: a })
  else seg.unusual.push(a)
}

/** How a source option shows in an item: the URL itself for an index or registry, else the option and its value. */
function sourceText(flag: string, value: string): string {
  return /^(-i|--index-url|--extra-index-url|--default-index|--index|-f|--find-links|--registry|--@[^:]+:registry)$/.test(flag) ? value : `${flag} ${value}`.trim()
}

/** Parse every install in a command line; null when there is none. */
export function parseInstall(command: string): Install | null {
  const res: Install = { pkgs: [], manifests: [], unusual: [], custom: [] }
  let found = false
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    let w = words(segment.trim())
    while (w[0] && (/^\w+=/.test(w[0]) || w[0] === 'sudo' || w[0] === 'env' || w[0] === 'exec' || w[0] === 'time')) w = w.slice(1)
    // python -m pip ..., python3.12 -m pip ...
    if (w[0] && /^python[\d.]*$/.test(w[0]) && w[1] === '-m') w = w.slice(2)
    const [tool, sub] = [w[0]?.split('/').pop() ?? '', w[1]]
    let eco: Eco | null = null, rest: string[] = []
    if ((tool === 'pip' || tool === 'pip3' || tool === 'pipx') && sub === 'install') { eco = 'pypi'; rest = w.slice(2) }
    else if (tool === 'pipx' && sub === 'run') { eco = 'pypi'; rest = firstArg('pypi', w.slice(2)) }
    else if (tool === 'uv' && w[1] === 'pip' && w[2] === 'install') { eco = 'pypi'; rest = w.slice(3) }
    else if (tool === 'uv' && (sub === 'add' || (sub === 'tool' && w[2] === 'install'))) { eco = 'pypi'; rest = w.slice(sub === 'tool' ? 3 : 2) }
    else if (tool === 'uv' && sub === 'tool' && w[2] === 'run') { eco = 'pypi'; rest = firstArg('pypi', w.slice(3)) }
    else if (tool === 'uv' && sub === 'sync') { found = true; res.manifests.push({ eco: 'pypi', path: 'pyproject.toml' }); continue }
    else if (tool === 'uvx') { eco = 'pypi'; rest = firstArg('pypi', w.slice(1)) }
    else if ((tool === 'poetry' || tool === 'pdm') && sub === 'add') { eco = 'pypi'; rest = w.slice(2) }
    else if ((tool === 'poetry' || tool === 'pdm') && sub === 'install') { found = true; res.manifests.push({ eco: 'pypi', path: 'pyproject.toml' }); continue }
    else if (tool === 'npm' && ['install', 'i', 'in', 'add', 'isntall', 'ci', 'exec'].includes(sub ?? '')) { eco = 'npm'; rest = w.slice(2) }
    else if ((tool === 'bun' || tool === 'pnpm') && ['add', 'install', 'i', 'x', 'dlx'].includes(sub ?? '')) { eco = 'npm'; rest = w.slice(2) }
    else if (tool === 'yarn' && (sub === 'add' || sub === 'install' || sub === 'dlx' || sub === undefined)) { eco = 'npm'; rest = w.slice(2) }
    else if (tool === 'npx' || tool === 'bunx') { eco = 'npm'; rest = firstArg('npm', w.slice(1)) }
    if (!eco) continue
    found = true
    let named = 0
    const seg = { pkgs: [] as Array<{ pkg: Pkg; spec: string }>, unusual: [] as string[], manifests: [] as string[], sources: [] as string[] }
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!
      if (a === '--') continue
      const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
      if (eco === 'pypi' && (flag === '-r' || flag === '--requirement')) { const v = inline ?? rest[++i]; if (v) seg.manifests.push(v); continue }
      if (eco === 'pypi' && (flag === '-e' || flag === '--editable')) { seg.unusual.push(`editable ${inline ?? rest[++i] ?? ''}`.trim()); continue }
      // where the packages come from: the whole install becomes custom-source items (a scoped registry, --@scope:registry=url, too)
      if ((eco === 'pypi' && PIP_INDEX_FLAGS.has(flag)) || (eco === 'npm' && (NPM_SOURCE_FLAGS.has(flag) || /^--@[^:]+:registry$/.test(flag)))) { seg.sources.push(sourceText(flag, inline ?? rest[++i] ?? '')); continue }
      if ((eco === 'pypi' ? PIP_VALUE_FLAGS : NPM_VALUE_FLAGS).has(flag)) { if (inline === undefined) i++; continue }
      let spec = a
      if ((eco === 'pypi' ? PIP_PKG_FLAGS : NPM_PKG_FLAGS).has(flag)) { const v = inline ?? rest[++i]; if (!v) continue; spec = v }
      else if (a.startsWith('-')) continue
      named++
      addSpec(seg, eco, spec)
    }
    // bare npm/bun/yarn/pnpm install installs package.json
    if (eco === 'npm' && !named && !['x', 'dlx', 'exec'].includes(sub ?? '') && tool !== 'npx' && tool !== 'bunx') seg.manifests.push('package.json')
    const source = seg.sources.length ? seg.sources.join(', ') : undefined
    if (source) res.custom.push(...seg.pkgs.map(p => customItem(p.spec, source)))
    else res.pkgs.push(...seg.pkgs.map(p => p.pkg))
    res.unusual.push(...seg.unusual)
    res.manifests.push(...seg.manifests.map(path => ({ eco: eco!, path, ...(source ? { source } : {}) })))
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
