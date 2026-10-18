// A skill's Python environment (docs/skill-runtime.md 「Python 套件 (uv)」, 柯姊
// 2026-10-18): a skill with pyproject.toml and uv.lock (versions locked, a git
// source locked to a commit; both in the approval hash) gets its own uv
// environment, which the router builds (never the skill itself) and mounts
// read-only at /cctr/env, first on PATH.
//   - where: <stateDir>/skill-env/<key>/, key = the lock, the pyproject, the
//     .python-version, uv's version and the CPU; skills with the same lock share
//   - Python: uv's own (python-build-standalone, checked by uv), in
//     <stateDir>/toolbox/python, mounted read-only at /cctr/python; never the host's
//   - how: in two sandboxes of the whitelisted kind (router/sandboxfs.ts), in
//     their own network (router/sandboxnet.ts, internet ports 80, 443, 53, 22).
//     uv reads only the project's own [tool.uv] (indexes, git sources): the
//     sandbox has no /etc/uv and an empty HOME.
//     (1) only uv runs: it installs the Python the project asks for (the only
//     time /cctr/python is writable). (2) `uv sync --locked`: packages, whose
//     builds run code, with /cctr/python read-only, a cache of its own (thrown
//     away), the target at /cctr/env, the same path as when the skill runs, so
//     the environment's scripts and links hold. A build that fails leaves nothing.
//   - when: /router skill approve (the approval is recorded only once it is
//     built), at a run whose environment is gone (rebuilt from the same lock,
//     not reviewed again), skill_try for a draft (its own environment, kept
//     apart: skill-env/try-<key>); environments no approved skill uses and not
//     used for 30 days are removed by pruneEnvs (the daily refresh).
//   - review (router/pkgreview.ts): lockPackages sorts uv.lock's packages:
//     PyPI ones go to the model like any install; git, URL and path sources are
//     custom items, always a person (the approval screen lists them).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { join } from 'path'
import { systemArgs } from './sandboxfs'
import { runIsolated, type IsolatedRun, type NetRun } from './sandboxnet'
import { binDir, installed } from './toolbox'

export const PYPI = 'https://pypi.org/simple'
export const ENV_V = '/cctr/env'
export const PYTHON_V = '/cctr/python'
const TOOLS_V = '/cctr/tools/bin'
const BUILD_TIMEOUT_MS = 15 * 60_000
const KEEP_MS = 30 * 86_400_000

export type LockFiles = { pyproject: string; lock: string; pythonVersion: string | null }
/** pyproject.toml and uv.lock of a skill: null when it has neither, an error when only one. */
export function lockFiles(dir: string): LockFiles | null | { error: string } {
  const has = (f: string) => existsSync(join(dir, f))
  if (!has('pyproject.toml') && !has('uv.lock')) return null
  if (!has('uv.lock')) return { error: '有 pyproject.toml 但沒有 uv.lock: 用 uv lock 產生 (版本鎖死), 兩個檔一起放在技能資料夾' }
  if (!has('pyproject.toml')) return { error: '有 uv.lock 但沒有 pyproject.toml' }
  const read = (f: string) => readFileSync(join(dir, f), 'utf8')
  return { pyproject: read('pyproject.toml'), lock: read('uv.lock'), pythonVersion: has('.python-version') ? read('.python-version') : null }
}

/** A package of uv.lock: from PyPI (reviewed by the model), or from a custom source (a person). */
export type LockPkg = { name: string; version: string; pypi: boolean; source: string; commit?: string }

/** uv.lock's packages, the project itself left out; an error when a git source is not locked to a commit. */
export function lockPackages(lock: string): LockPkg[] | { error: string } {
  let j: { package?: Array<{ name: string; version?: string; source?: Record<string, string> }> }
  try { j = Bun.TOML.parse(lock) as typeof j } catch (e) { return { error: `uv.lock 讀不懂: ${e instanceof Error ? e.message : e}` } }
  const out: LockPkg[] = []
  for (const p of j.package ?? []) {
    const s = p.source ?? {}
    if (s.virtual !== undefined || s.editable === '.' || s.directory === '.') continue // the project
    const version = String(p.version ?? '')
    if (s.registry !== undefined) { out.push({ name: p.name, version, pypi: s.registry.replace(/\/+$/, '') === PYPI, source: s.registry }); continue }
    if (s.git !== undefined) {
      const commit = /#([0-9a-f]{40})$/.exec(s.git)?.[1]
      if (!commit) return { error: `uv.lock 裡的 ${p.name} 是 git 來源但沒有鎖在完整的 commit: ${s.git}` }
      out.push({ name: p.name, version, pypi: false, source: s.git.replace(/#.*$/, ''), commit })
      continue
    }
    const where = s.url ?? s.path ?? s.directory ?? s.editable ?? JSON.stringify(s)
    out.push({ name: p.name, version, pypi: false, source: String(where) })
  }
  return out
}

/** How a custom package shows on the approval screen (and in pkgreview's custom items). */
export const customLabel = (p: LockPkg) => `${p.name} ${p.version} (來源 ${p.source}${p.commit ? ` commit ${p.commit}` : ''})`

export interface EnvDeps {
  /** <stateDir>/toolbox: uv, and Python under python/ */
  toolbox: string
  /** <stateDir>/skill-env */
  envRoot: string
  etcDir: string
  runRoot: string
  hostAddrs(): Promise<string[]>
  isolated?(o: IsolatedRun): Promise<NetRun>
  /** uv's --python-preference; only-managed (uv's own Python) but in tests */
  pythonPreference?: string
  log?(msg: string): void
}

/** The environment's folder name for these files and this toolbox's uv. */
export function envKey(f: LockFiles, toolbox: string, arch = process.arch): string {
  const uv = installed(toolbox).uv?.version ?? 'none'
  return createHash('sha256').update(JSON.stringify([f.pyproject, f.lock, f.pythonVersion, uv, arch])).digest('hex').slice(0, 16)
}

const building = new Map<string, Promise<EnvResult>>()
export type EnvResult = { ok: true; dir: string } | { ok: false; why: string }

/** The built environment of these files (building it when missing, once at a time per key). prefix: try- for drafts. */
export function ensureEnv(deps: EnvDeps, f: LockFiles, prefix = ''): Promise<EnvResult> {
  if (!installed(deps.toolbox).uv) return Promise.resolve({ ok: false, why: '工具箱沒有 uv (cc-telegram-router toolbox install), 建不了 Python 環境' })
  const key = `${prefix}${envKey(f, deps.toolbox)}`
  const dir = join(deps.envRoot, key)
  if (existsSync(join(dir, '.ok'))) { touch(dir); return Promise.resolve({ ok: true, dir }) }
  const known = building.get(key)
  if (known) return known
  const p = build(deps, f, dir).finally(() => building.delete(key))
  building.set(key, p)
  return p
}

const touch = (dir: string) => { try { utimesSync(join(dir, '.ok'), new Date(), new Date()) } catch {} }

/** One sandbox of the build (whitelisted file system, own network): uv from the toolbox, the project
 *  files read-only at /cctr/project, the given folders bound (writable unless ro), cwd the project. */
async function step(deps: EnvDeps, work: string, name: string, args: string[], binds: Array<[string, string, boolean?]>, env: Record<string, string>): Promise<NetRun> {
  const b = ['bwrap', '--die-with-parent', '--unshare-pid', '--new-session', ...systemArgs({ etcDir: deps.etcDir }),
    '--ro-bind', binDir(deps.toolbox), TOOLS_V]
  for (const [src, dst, ro] of binds) b.push(ro ? '--ro-bind' : '--bind', src, dst)
  b.push('--chdir', '/cctr/project', '--', join(TOOLS_V, 'uv'), ...args)
  return (deps.isolated ?? runIsolated)({
    argv: b, timeoutMs: BUILD_TIMEOUT_MS, workDir: join(work, `net-${name}`), hostAddrs: await deps.hostAddrs(),
    env: { PATH: `${TOOLS_V}:/usr/bin:/bin`, HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', UV_LINK_MODE: 'copy', UV_PYTHON_INSTALL_DIR: PYTHON_V, UV_PYTHON_PREFERENCE: deps.pythonPreference ?? 'only-managed', ...env },
  })
}

async function build(deps: EnvDeps, f: LockFiles, dir: string): Promise<EnvResult> {
  mkdirSync(deps.envRoot, { recursive: true, mode: 0o700 })
  mkdirSync(deps.runRoot, { recursive: true, mode: 0o700 })
  const python = join(deps.toolbox, 'python')
  mkdirSync(python, { recursive: true })
  const work = join(deps.runRoot, `env-${randomBytes(6).toString('hex')}`)
  const project = join(work, 'project'), target = join(work, 'env'), cache = join(work, 'cache')
  for (const d of [project, target, cache]) mkdirSync(d, { recursive: true })
  writeFileSync(join(project, 'pyproject.toml'), f.pyproject)
  writeFileSync(join(project, 'uv.lock'), f.lock)
  if (f.pythonVersion !== null) writeFileSync(join(project, '.python-version'), f.pythonVersion)
  const fail = (what: string, r: NetRun): EnvResult => ({ ok: false, why: `${what}失敗: ${'error' in r ? r.error : `exit ${r.code}\n${r.out.split('\n').slice(-15).join('\n')}`}` })
  try {
    // (1) only uv runs: the Python the project asks for, into the shared folder
    const py = await step(deps, work, 'python', ['venv', '--quiet', '/tmp/probe'], [[project, '/cctr/project', true], [python, PYTHON_V], [cache, '/cctr/uv-cache']], { UV_CACHE_DIR: '/cctr/uv-cache' })
    if ('error' in py || py.code !== 0) return fail('準備 Python ', py)
    // (2) the packages: their builds run code, so Python is read-only now and the cache is this build's own
    const sync = await step(deps, work, 'sync', ['sync', '--locked', '--no-install-project', '--no-dev', '--quiet'], [[project, '/cctr/project', true], [python, PYTHON_V, true], [cache, '/cctr/uv-cache'], [target, ENV_V]], { UV_CACHE_DIR: '/cctr/uv-cache', UV_PROJECT_ENVIRONMENT: ENV_V, UV_PYTHON_DOWNLOADS: 'never' })
    if ('error' in sync || sync.code !== 0) return fail('安裝套件 (uv sync --locked) ', sync)
    writeFileSync(join(target, '.ok'), JSON.stringify({ built: new Date().toISOString() }))
    rmSync(dir, { recursive: true, force: true })
    renameSync(target, dir)
    deps.log?.(`skill env: built ${dir}`)
    return { ok: true, dir }
  } finally { rmSync(work, { recursive: true, force: true }) }
}

/** Remove environments no approved skill uses (inUse: their folder names) and unused for 30 days. */
export function pruneEnvs(envRoot: string, inUse: Set<string>, now = Date.now()): string[] {
  if (!existsSync(envRoot)) return []
  const gone: string[] = []
  for (const e of readdirSync(envRoot)) {
    if (inUse.has(e)) continue
    let at = 0
    try { at = statSync(join(envRoot, e, '.ok')).mtimeMs } catch {}
    if (now - at > KEEP_MS) { rmSync(join(envRoot, e), { recursive: true, force: true }); gone.push(e) }
  }
  return gone
}

/** A skill folder's environment folder name, for pruneEnvs (null: no environment). */
export function envNameOf(dir: string, toolbox: string): string | null {
  const f = lockFiles(dir)
  return f && !('error' in f) ? envKey(f, toolbox) : null
}

