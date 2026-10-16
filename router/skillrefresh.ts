// Daily credential refresh for privileged skills (plan 10d, 柯姊 2026-10-16).
// Once a day at config skillRefreshAt (default 05:00 GMT+8, "off" disables)
// the router runs, for every approved skill, each internal action another
// action names as its refresh: the same sandbox, mounts, env and hash check
// as run_skill (router/skillrun.ts). A skill changed since approval is
// skipped and the owner told; a failed refresh tells the owner; a refresh
// that works is only logged (router log and skill_runs, conversation
// "router:refresh", so it never counts toward a conversation's hourly
// limit). At router start, a skill whose last successful daily refresh is
// over 24 hours old (or that never had one) is refreshed once a minute
// later (柯姊 2026-10-16); after that, every day at skillRefreshAt. Runs
// never overlap.

import { mkdirSync } from 'fs'
import { join } from 'path'
import { loadManifest, hashSkill, secretsIn, redact } from './privskill'
import { runAction, credEnv, type SkillRunDeps } from './skillrun'

export const REFRESH_CONV = 'router:refresh'
const GMT8 = 8 * 3_600_000

/** The next HH:MM (GMT+8) strictly after now, as epoch ms. */
export function nextRefreshAt(now: number, at: string): number {
  const [h, m] = at.split(':').map(Number) as [number, number]
  const local = new Date(now + GMT8)
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) - GMT8
  if (t <= now) t += 86_400_000
  return t
}

export interface RefreshDeps extends Omit<SkillRunDeps, 'notifyOwner'> {
  /** Router-private folder the refresh runs in (writable in the sandbox). */
  stateDir: string
  /** The bot whose owner notices a skill folder's problems go to. */
  botOf(dir: string): string
  notify(bot: string, text: string): void
}

export type RefreshResult = { skill: string; action: string; status: 'ok' | 'failed' | 'skipped' }

/** Every approved skill's refresh actions (only those skills `only` accepts), once each. */
export async function refreshAll(deps: RefreshDeps, only?: (skill: string) => boolean): Promise<RefreshResult[]> {
  const out: RefreshResult[] = []
  for (const { dir, skill, hash } of deps.db.listSkillApprovals()) {
    if (only && !only(skill)) continue
    let manifest
    try { manifest = loadManifest(dir) } catch (e) { deps.log?.(`skill ${skill}: daily refresh: privileged.json 有誤: ${e}`); continue }
    if (!manifest) continue
    const names = [...new Set(Object.values(manifest.actions).map(a => a.refresh).filter((n): n is string => !!n && !!manifest.actions[n]))]
    if (!names.length) continue
    const bot = deps.botOf(dir)
    if (hashSkill(dir) !== hash) {
      deps.notify(bot, `⚠️ 技能 ${skill} 的檔案在核准後被改過, 每日憑證更新已略過. 檢查後用 /router skill approve ${skill} 重新核准.`)
      for (const n of names) { deps.db.addSkillRun(REFRESH_CONV, skill, n, 'skipped'); out.push({ skill, action: n, status: 'skipped' }) }
      continue
    }
    const folder = join(deps.stateDir, 'skill-refresh', skill)
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    for (const n of names) {
      const a = manifest.actions[n]!
      const r = await runAction(deps, dir, a, {}, folder).catch(e => ({ code: -1, out: String(e) }))
      const status = r.code === 0 ? 'ok' : 'failed'
      deps.db.addSkillRun(REFRESH_CONV, skill, n, status)
      out.push({ skill, action: n, status })
      if (r.code === 0) { deps.log?.(`skill ${skill}: daily refresh ${n} ok`); continue }
      deps.log?.(`skill ${skill}: daily refresh ${n} failed (exit ${r.code})`)
      // the failure text never carries a credential
      const secrets = [...secretsIn(Object.values(credEnv(deps, a))), ...Object.values(a.http ?? {}).map(c => deps.httpCred?.(c)?.token ?? '').filter(t => t.length >= 16)]
      deps.notify(bot, `⚠️ 技能 ${skill} 的每日憑證更新 (${n}) 失敗, exit ${r.code}:\n${redact(r.out.split('\n').slice(-3).join('\n'), secrets).text}`)
    }
  }
  return out
}

export const CATCH_UP_DELAY_MS = 60_000
const DAY = 86_400_000

/** At start (after catchUpDelayMs) refresh the skills whose last successful
 *  daily refresh is over 24 hours old or missing; then refreshAll at every
 *  `at` (GMT+8). Runs are queued one after another. */
export function scheduleRefresh(deps: RefreshDeps, at: string, o: { now?: () => number; setTimer?: (fn: () => void, ms: number) => { unref?(): void }; catchUpDelayMs?: number } = {}): { next(): number; stop(): void; idle(): Promise<void> } {
  const now = o.now ?? Date.now
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  let target = nextRefreshAt(now(), at)
  let stopped = false
  let chain = Promise.resolve()
  const run = (why: string, only?: (skill: string) => boolean) => {
    chain = chain.then(async () => {
      if (stopped) return
      try {
        const rs = await refreshAll(deps, only)
        if (rs.length) deps.log?.(`${why} skill refresh: ${rs.map(r => `${r.skill}/${r.action} ${r.status}`).join(', ')}`)
      } catch (e) { deps.log?.(`${why} skill refresh: ${e}`) }
    })
  }
  const arm = () => {
    if (stopped) return
    setTimer(() => {
      if (stopped) return
      // a timer may fire a little early: never run the same time twice
      target = nextRefreshAt(Math.max(now(), target), at)
      run('daily')
      arm()
    }, Math.max(0, target - now())).unref?.()
  }
  const stale = (skill: string) => {
    const t = deps.db.lastSkillRunAt(REFRESH_CONV, skill, 'ok')
    return !t || now() - Date.parse(t) > DAY
  }
  setTimer(() => run('catch-up', stale), o.catchUpDelayMs ?? CATCH_UP_DELAY_MS).unref?.()
  arm()
  return { next: () => target, stop: () => { stopped = true }, idle: () => chain }
}
