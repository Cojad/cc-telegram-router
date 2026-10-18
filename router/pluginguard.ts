// Guard over the official telegram plugin's cache (docs/operations.md 「官方
// plugin 的自動更新與快取檢查」). deploy/install.sh plugin puts plugin v2 into
// the cache folder of telegram@claude-plugins-official and records here a
// fingerprint of what it put there (every file's sha256, in the stateDir).
// The router compares the cache with it when a worker's plugin says hello and
// once a day: installed_plugins.json must still point at that folder, the
// files must be the same, and no other version folder may have appeared. A
// mismatch is only reported to the owner (the plugin may have been replaced by
// an official update or a manual `claude plugin update`); nothing is changed.
// In managed mode (docs/managed-channel.md) workers load the plugin from the
// router's own marketplace folder instead: install.sh records that folder in
// plugin-fingerprint.marketplace.json and the guard compares it (checkMarketplace).

import { createHash } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, relative } from 'path'

export const PLUGIN_ID = 'telegram@claude-plugins-official'
export const FINGERPRINT_FILE = 'plugin-fingerprint.json'
export const MARKETPLACE_FINGERPRINT_FILE = 'plugin-fingerprint.marketplace.json'
/** Claude Code's own markers in a plugin version folder: not ours, not compared. */
export const CC_MARKERS = new Set(['.in_use', '.orphaned_at'])

export interface Fingerprint {
  /** The version folder install.sh deployed into. */
  installPath: string
  /** Path relative to installPath -> sha256 of the content (a symlink: "link:<target>"). */
  files: Record<string, string>
  recordedAt: string
}

/** Claude Code's plugins root: CLAUDE_CODE_PLUGIN_CACHE_DIR, else ~/.claude/plugins. */
export function pluginsRoot(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(home, '.claude', 'plugins')
}

/** Every file under dir (Claude Code's markers at its top level left out). */
export function fingerprintDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, top: boolean) => {
    for (const name of readdirSync(d).sort()) {
      if (top && CC_MARKERS.has(name)) continue
      const p = join(d, name)
      const rel = relative(dir, p)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(p)}`
      else if (st.isDirectory()) walk(p, false)
      else out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  walk(dir, true)
  return out
}

export function writeFingerprint(stateDir: string, installPath: string, now = new Date(), file = FINGERPRINT_FILE): Fingerprint {
  const fp: Fingerprint = { installPath, files: fingerprintDir(installPath), recordedAt: now.toISOString() }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, file)
  writeFileSync(`${path}.new`, JSON.stringify(fp, null, 2) + '\n', { mode: 0o600 })
  renameSync(`${path}.new`, path)
  return fp
}

export function readFingerprint(stateDir: string, file = FINGERPRINT_FILE): Fingerprint | null {
  const path = join(stateDir, file)
  if (!existsSync(path)) return null
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof j?.installPath !== 'string' || !j.files || typeof j.files !== 'object') return null
    return j as Fingerprint
  } catch { return null }
}

export type ProblemKind = 'no-fingerprint' | 'not-installed' | 'install-path' | 'missing-folder' | 'files' | 'orphaned' | 'other-versions'
export interface Problem { kind: ProblemKind; detail: string }

const LIST_MAX = 10
const list = (xs: string[]) => xs.length <= LIST_MAX ? xs.join(', ') : `${xs.slice(0, LIST_MAX).join(', ')} 等 ${xs.length} 個`

/** Compare the official plugin's cache with what deploy/install.sh plugin recorded. Empty: all as deployed. */
export function checkPluginCache(stateDir: string, root = pluginsRoot()): Problem[] {
  const fp = readFingerprint(stateDir)
  if (!fp) return [{ kind: 'no-fingerprint', detail: `沒有部署紀錄 (${join(stateDir, FINGERPRINT_FILE)}): 這版之後還沒跑過 deploy/install.sh plugin` }]
  const problems: Problem[] = []

  let entries: { installPath?: unknown; version?: unknown; scope?: unknown; projectPath?: unknown }[] = []
  try {
    const j = JSON.parse(readFileSync(join(root, 'installed_plugins.json'), 'utf8'))
    const e = j?.plugins?.[PLUGIN_ID]
    entries = Array.isArray(e) ? e : []
  } catch (e) {
    problems.push({ kind: 'not-installed', detail: `讀不到 ${join(root, 'installed_plugins.json')}: ${e instanceof Error ? e.message : e}` })
  }
  if (!problems.length && !entries.length) problems.push({ kind: 'not-installed', detail: `installed_plugins.json 裡沒有 ${PLUGIN_ID}` })
  const elsewhere = entries.filter(e => e.installPath !== fp.installPath)
  if (elsewhere.length) {
    const where = elsewhere.map(e => `${String(e.installPath)} (${String(e.scope ?? '?')}${e.projectPath ? ` ${String(e.projectPath)}` : ''}, version ${String(e.version ?? '?')})`)
    problems.push({ kind: 'install-path', detail: `installed_plugins.json 的 ${PLUGIN_ID} 指向部署以外的資料夾: ${list(where)}` })
  }

  if (!existsSync(fp.installPath)) {
    problems.push({ kind: 'missing-folder', detail: `部署的資料夾 ${fp.installPath} 不見了` })
  } else {
    const now = fingerprintDir(fp.installPath)
    const added = Object.keys(now).filter(f => !(f in fp.files))
    const removed = Object.keys(fp.files).filter(f => !(f in now))
    const changed = Object.keys(now).filter(f => f in fp.files && now[f] !== fp.files[f])
    if (added.length || removed.length || changed.length) {
      const parts = [changed.length ? `內容改變: ${list(changed)}` : '', added.length ? `多出: ${list(added)}` : '', removed.length ? `少了: ${list(removed)}` : ''].filter(Boolean)
      problems.push({ kind: 'files', detail: `${fp.installPath} 的檔案跟部署時不同 (${parts.join('; ')})` })
    }
    if (existsSync(join(fp.installPath, '.orphaned_at'))) problems.push({ kind: 'orphaned', detail: `${fp.installPath} 被 Claude Code 標記為舊版 (.orphaned_at), 14 天後會被刪除` })
  }

  const versions = dirname(fp.installPath)
  let others: string[] = []
  try { others = readdirSync(versions).filter(n => n !== basename(fp.installPath) && lstatSync(join(versions, n)).isDirectory()).sort() } catch {}
  if (others.length) problems.push({ kind: 'other-versions', detail: `${versions} 底下出現其他版本資料夾: ${list(others)}` })
  return problems
}

/** The router's own marketplace folder (managed mode) against what deploy/install.sh plugin recorded. Empty: as deployed. */
export function checkMarketplace(stateDir: string, pluginDir: string): Problem[] {
  const fp = readFingerprint(stateDir, MARKETPLACE_FINGERPRINT_FILE)
  if (!fp) return [{ kind: 'no-fingerprint', detail: `沒有部署紀錄 (${join(stateDir, MARKETPLACE_FINGERPRINT_FILE)}): 這版之後還沒跑過 deploy/install.sh plugin` }]
  if (fp.installPath !== pluginDir) return [{ kind: 'install-path', detail: `部署紀錄是 ${fp.installPath}, 不是 router 的商店資料夾 ${pluginDir}` }]
  if (!existsSync(pluginDir)) return [{ kind: 'missing-folder', detail: `商店的 plugin 資料夾 ${pluginDir} 不見了` }]
  const now = fingerprintDir(pluginDir)
  const added = Object.keys(now).filter(f => !(f in fp.files))
  const removed = Object.keys(fp.files).filter(f => !(f in now))
  const changed = Object.keys(now).filter(f => f in fp.files && now[f] !== fp.files[f])
  if (!added.length && !removed.length && !changed.length) return []
  const parts = [changed.length ? `內容改變: ${list(changed)}` : '', added.length ? `多出: ${list(added)}` : '', removed.length ? `少了: ${list(removed)}` : ''].filter(Boolean)
  return [{ kind: 'files', detail: `${pluginDir} 的檔案跟部署時不同 (${parts.join('; ')})` }]
}

/** The owner's notice (Taiwan Chinese, plain text). */
export function formatProblems(problems: Problem[], managed = false): string {
  if (managed) return [
    '⚠️ router 商店裡的 telegram plugin 跟部署時不同, worker 可能沒在用部署的版本:',
    ...problems.map(p => `• ${p.detail}`),
    'router 不會自動改檔; 請確認後重新執行 deploy/install.sh plugin, 再 /router session rotate all.',
  ].join('\n')
  return [
    '⚠️ 官方 telegram plugin 的快取跟部署時不同, worker 可能沒在用我們的 plugin v2:',
    ...problems.map(p => `• ${p.detail}`),
    '可能是官方更新或手動 `claude plugin update` 蓋掉了. router 不會自動改檔; 請確認後重新執行 deploy/install.sh plugin, 再 /router session rotate all.',
  ].join('\n')
}

export function problemsKey(problems: Problem[]): string {
  return problems.map(p => `${p.kind}:${p.detail}`).join('\n')
}

export interface GuardDeps {
  stateDir: string
  root?: string
  /** Managed mode: check this marketplace plugin folder instead of the official cache. */
  marketplacePluginDir?: string
  notify(text: string): void | Promise<void>
  log?(msg: string): void
}

export type CheckReason = 'hello' | 'daily'

/** hello: tell the owner when the problems differ from the last told; daily:
 *  tell again whenever there are any. Back to normal is only logged, and so is
 *  a missing fingerprint (nothing to compare with). */
export function createPluginGuard(deps: GuardDeps) {
  let told = ''
  function check(reason: CheckReason): Problem[] {
    let problems: Problem[]
    try { problems = deps.marketplacePluginDir ? checkMarketplace(deps.stateDir, deps.marketplacePluginDir) : checkPluginCache(deps.stateDir, deps.root ?? pluginsRoot()) } catch (e) {
      deps.log?.(`plugin guard (${reason}): ${e}`)
      return []
    }
    if (!problems.length) {
      if (told) deps.log?.(`plugin guard (${reason}): the ${deps.marketplacePluginDir ? 'marketplace plugin' : 'official plugin cache'} is as deployed again`)
      told = ''
      return problems
    }
    const key = problemsKey(problems)
    // Nothing recorded to compare with (deploy/install.sh plugin not run since
    // this version, or a test setup): logged once, not a notice.
    if (problems.every(p => p.kind === 'no-fingerprint')) {
      if (key !== told) deps.log?.(`plugin guard (${reason}): ${problems[0]!.detail}`)
      told = key
      return problems
    }
    deps.log?.(`plugin guard (${reason}): ${problems.map(p => p.kind).join(', ')}`)
    if (reason === 'hello' && key === told) return problems
    told = key
    const text = formatProblems(problems, !!deps.marketplacePluginDir)
    void (async () => deps.notify(text))().catch(e => deps.log?.(`plugin guard notice: ${e}`))
    return problems
  }
  return { check }
}

const GMT8 = 8 * 3_600_000

/** The next `at` ("HH:MM", GMT+8) strictly after now. */
export function nextDailyAt(now: number, at: string): number {
  const [h, m] = at.split(':').map(Number) as [number, number]
  const local = new Date(now + GMT8)
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) - GMT8
  if (t <= now) t += 86_400_000
  return t
}

/** Run fn at every `at` (GMT+8). */
export function scheduleDaily(at: string, fn: () => void, o: { now?: () => number; setTimer?: (fn: () => void, ms: number) => { unref?(): void } } = {}): { next(): number; stop(): void } {
  const now = o.now ?? Date.now
  const setTimer = o.setTimer ?? ((f, ms) => setTimeout(f, ms))
  let target = nextDailyAt(now(), at)
  let stopped = false
  const arm = () => {
    setTimer(() => {
      if (stopped) return
      // a timer may fire a little early: never run the same time twice
      target = nextDailyAt(Math.max(now(), target), at)
      try { fn() } catch {}
      arm()
    }, Math.max(0, target - now())).unref?.()
  }
  arm()
  return { next: () => target, stop: () => { stopped = true } }
}

// deploy/install.sh plugin: bun router/pluginguard.ts fingerprint <plugin folder> <stateDir> [--marketplace]
if (import.meta.main) {
  const [cmd, dir, state, flag] = process.argv.slice(2)
  if (cmd !== 'fingerprint' || !dir || !state || (flag && flag !== '--marketplace')) {
    console.error('usage: bun router/pluginguard.ts fingerprint <plugin folder> <stateDir> [--marketplace]')
    process.exit(2)
  }
  const file = flag ? MARKETPLACE_FINGERPRINT_FILE : FINGERPRINT_FILE
  const fp = writeFingerprint(state, dir, new Date(), file)
  console.log(`plugin fingerprint: ${Object.keys(fp.files).length} files -> ${join(state, file)}`)
}
