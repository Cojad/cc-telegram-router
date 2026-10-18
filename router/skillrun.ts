// run_skill: one privileged skill action for a conversation (plan 10d; the
// mechanics are in router/privskill.ts). Finds the approved skill in the
// conversation's bot or all-bots scope, checks its hash, role, arguments and
// the hourly limit, runs it sandboxed with its credential folders, retries
// once after the refresh action when the credentials were refused, and
// scrubs what comes back. An action with a database (store) runs holding its
// lock, on a staged copy written back only when the checks pass
// (router/skillstore.ts).

import { mkdirSync, existsSync, rmSync } from 'fs'
import { basename, join } from 'path'
import type { Conversation, RouterDb } from './db'
import { loadManifest, hashSkill, buildArgv, sandboxArgv, secretsIn, scrubOutputs, redact, argRoleRefusal, storeOf, RUNS_PER_HOUR, type Action, type Manifest } from './privskill'
import type { Credential } from './config'
import { storesOf, withStoreLocks, stage, check, commit, workDir, RUN_MAX, type Plan, type StoreUse } from './skillstore'

export type RunResult = { code: number; out: string }

export interface SkillRunDeps {
  db: RouterDb
  home: string
  /** Where credential folders live (router-private), <stateDir>/creds */
  credsRoot: string
  /** $HOME of the router user, hidden in the sandbox */
  userHome: string
  /** Also hidden: the router's home, its state dir, config sandboxDenyRead (config.ts hiddenPaths) */
  hidden: string[]
  /** Binaries outside the system dirs the sandbox needs (e.g. ~/.local/bin/yt-dlp) */
  extraRo: string[]
  botDir(bot: string): string
  /** An http API credential by name (router config), for actions that declare http. */
  httpCred?(name: string): Credential | undefined
  /** A bot token credential by name (router config), for actions that declare bots. */
  botCred?(name: string): Credential | undefined
  /** Bot API base URL (config apiRoot); default https://api.telegram.org. */
  apiRoot?: string
  /** Databases of actions that declare store: <stateDir>/skill-store (router/skillstore.ts). */
  storeRoot?: string
  /** Run argv with env, killed after timeoutMs. */
  exec(argv: string[], env: Record<string, string>, timeoutMs: number): Promise<RunResult>
  notifyOwner(conv: Conversation, text: string): void
  log?(msg: string): void
}

/** Only bot or all-bots scope: a conversation's own skills are writable by it. */
export function skillDirs(deps: Pick<SkillRunDeps, 'home' | 'botDir'>, bot: string, skill: string): string[] {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill)) return []
  return [join(deps.botDir(bot), '.claude', 'skills', skill), join(deps.home, '.claude', 'skills', skill)].filter(d => existsSync(join(d, 'privileged.json')))
}

const credDir = (deps: Pick<SkillRunDeps, 'credsRoot'>, name: string) => { const d = join(deps.credsRoot, name); mkdirSync(d, { recursive: true, mode: 0o700 }); return d }
/** env var -> credential folder of an action. */
export const credEnv = (deps: Pick<SkillRunDeps, 'credsRoot'>, a: Action) => Object.fromEntries(Object.entries(a.creds ?? {}).map(([env, name]) => [env, credDir(deps, name)]))
const httpCreds = (deps: Pick<SkillRunDeps, 'httpCred'>, a: Action) => Object.entries(a.http ?? {}).map(([env, name]) => ({ env, name, cred: deps.httpCred?.(name) }))
const botCreds = (deps: Pick<SkillRunDeps, 'botCred'>, a: Action) => Object.entries(a.bots ?? {}).map(([env, name]) => ({ env, name, cred: deps.botCred?.(name) }))
/** Why an action's bot credentials cannot be used, or null. */
function botCredRefusal(deps: Pick<SkillRunDeps, 'botCred'>, a: Action): string | null {
  for (const b of botCreds(deps, a)) {
    if (!b.cred) return `需要的 bot 憑證 ${b.name} 不存在`
    if ((b.cred.kind ?? 'telegram-bot') !== 'telegram-bot') return `需要的 bot 憑證 ${b.name} 是 ${b.cred.kind} 類, bots 只接受 telegram-bot 憑證`
  }
  return null
}
/** Every token an action's run must never hand back: http keys and bot tokens. */
const tokensOf = (deps: Pick<SkillRunDeps, 'httpCred' | 'botCred'>, a: Action) => [...httpCreds(deps, a), ...botCreds(deps, a)].map(h => h.cred?.token ?? '').filter(t => t.length >= 16)

/** One action in its own sandbox, the conversation (or router) folder
 *  writable: shared by run_skill and the daily refresh (router/skillrefresh.ts).
 *  Only internal (router-run) actions get extra mounts and env, and write
 *  their credential folders: a conversation's actions never see the ssh agent. */
export async function runAction(deps: Omit<SkillRunDeps, 'notifyOwner'>, dir: string, a: Action, args: Record<string, unknown>, folder: string, stores: Record<string, string> = {}): Promise<RunResult> {
  const http = httpCreds(deps, a)
  const missing = http.find(h => h.cred?.kind !== 'http' || !h.cred.baseUrl)
  if (missing) return { code: -1, out: `需要的 API 憑證 ${missing.name} 不存在或不是 http 憑證` }
  const botWhy = botCredRefusal(deps, a)
  if (botWhy) return { code: -1, out: botWhy }
  const argv = buildArgv(a, dir, args, name => credDir(deps, name))
  if ('error' in argv) return { code: -1, out: argv.error }
  const httpEnv: Record<string, string> = Object.fromEntries(http.flatMap(({ env, cred }) => [
    [`${env}_URL`, cred!.baseUrl!.replace(/\/+$/, '')],
    [`${env}_HEADER`, `${cred!.header ?? 'Authorization'}: ${`${cred!.scheme ?? 'Bearer'} ${cred!.token}`.trim()}`],
  ]))
  const botEnv = Object.fromEntries(botCreds(deps, a).map(({ env, cred }) => [`${env}_API`, `${(deps.apiRoot ?? 'https://api.telegram.org').replace(/\/+$/, '')}/bot${cred!.token}`]))
  const mounts = a.internal ? (a.mounts ?? []).map(m => m.startsWith('~/') ? join(deps.userHome, m.slice(2)) : m) : []
  const sb = sandboxArgv({ argv, skillDir: dir, convFolder: folder, creds: credEnv(deps, a), home: deps.userHome, hidden: deps.hidden, extraRo: [...deps.extraRo, ...mounts], credsWritable: !!a.internal, writable: Object.values(stores), env: { ...(a.internal ? a.env : {}), ...httpEnv, ...botEnv, ...stores } })
  return deps.exec(sb.argv, sb.env, (a.timeout ?? 600) * 1000)
}

/** runAs: the skill_runs conversation to record under instead of conv.key
 *  (the owner's terminal, router/skillcli.ts); such a run is not counted
 *  toward, nor held to, the conversation's hourly limit. */
export async function runSkill(deps: SkillRunDeps, conv: Conversation, role: string, skill: string, actionName: string, args: Record<string, unknown>, o: { runAs?: string } = {}): Promise<{ ok: boolean; text: string }> {
  const { db } = deps
  const dir = skillDirs(deps, conv.bot, skill)[0]
  if (!dir) return { ok: false, text: `找不到有特權動作的技能 ${skill} (只有這隻 bot 或全部 bot 範圍, 而且帶 privileged.json 的技能可以用)` }
  const approval = db.skillApproval(dir)
  if (!approval) return { ok: false, text: `技能 ${skill} 還沒經 owner 或 admin 核准 (/router skill approve ${skill})` }
  if (hashSkill(dir) !== approval.hash) {
    deps.notifyOwner(conv, `⚠️ 技能 ${skill} 的檔案在核准後被改過, 特權動作已暫停. 檢查後用 /router skill approve ${skill} 重新核准.`)
    return { ok: false, text: `技能 ${skill} 的檔案在核准後被改過, 已暫停, 等 owner 或 admin 重新核准` }
  }
  let manifest: Manifest
  try { manifest = loadManifest(dir)! } catch (e) { return { ok: false, text: `技能 ${skill} 的 privileged.json 有誤: ${e instanceof Error ? e.message : e}` } }
  const action = manifest.actions[actionName]
  if (!action || action.internal) return { ok: false, text: `技能 ${skill} 沒有可呼叫的動作 ${actionName} (可用: ${Object.entries(manifest.actions).filter(([, a]) => !a.internal).map(([n]) => n).join(', ')})` }
  if (!(action.roles ?? ['owner', 'admin', 'power', 'user']).includes(role)) return { ok: false, text: `技能 ${skill} 的 ${actionName} 不開放給 ${role} 角色的對話` }
  const argWhy = argRoleRefusal(action, args, role)
  if (argWhy) return { ok: false, text: `${argWhy}. 需要的話告訴對方, 並用 request_elevation 申請提權` }
  const used = o.runAs ? 0 : db.skillRunsSince(conv.key, new Date(Date.now() - 3_600_000).toISOString())
  if (used >= RUNS_PER_HOUR) { db.addSkillRun(conv.key, skill, actionName, 'refused'); return { ok: false, text: `這個對話一小時內已經用了 ${used} 次特權技能, 上限 ${RUNS_PER_HOUR} 次, 請稍後再試` } }

  for (const h of [...httpCreds(deps, action), ...(action.refresh && manifest.actions[action.refresh] ? httpCreds(deps, manifest.actions[action.refresh]!) : [])]) {
    if (h.cred?.kind !== 'http' || !h.cred.baseUrl) return { ok: false, text: `技能 ${skill} 需要的 API 憑證 ${h.name} 不存在或不是 http 憑證, 請 owner 檢查` }
  }
  const botWhy = botCredRefusal(deps, action)
  if (botWhy) return { ok: false, text: `技能 ${skill} ${botWhy}, 請 owner 檢查` }
  if (action.store && Object.keys(action.store).length && !deps.storeRoot) return { ok: false, text: `技能 ${skill} 要用資料庫, 但 router 沒有設定資料庫位置` }
  const stores = deps.storeRoot ? storesOf(action, deps.storeRoot, basename(deps.botDir(conv.bot))) : []
  const runAs = o.runAs ?? conv.key
  if (!stores.length) return run(deps, conv, runAs, skill, actionName, dir, manifest, action, args, [])
  return withStoreLocks(stores.map(s => s.dir), async () => {
    const work = workDir(deps.storeRoot!)
    try { return await run(deps, conv, runAs, skill, actionName, dir, manifest, action, args, stores, work) } finally { dropWork(work, deps.log) }
  })
}

async function run(deps: SkillRunDeps, conv: Conversation, runAs: string, skill: string, actionName: string, dir: string, manifest: Manifest, action: Action, args: Record<string, unknown>, stores: StoreUse[], work = ''): Promise<{ ok: boolean; text: string }> {
  const { db } = deps
  // the main action gets a fresh copy of its databases on every attempt; the refresh none
  const once = (a: Action, a_args: Record<string, unknown>) => runAction(deps, dir, a, a_args, conv.folder, a === action && stores.length ? stage(stores, work) : {})

  const start = Date.now()
  let r = await once(action, args)
  const notes: string[] = []
  if (r.code !== -1 && action.auth_failure && action.refresh && new RegExp(action.auth_failure, 'i').test(r.out)) {
    const refresh = manifest.actions[action.refresh]
    const rr = refresh ? await once(refresh, {}) : { code: 1, out: 'refresh 動作不存在' }
    if (rr.code === 0) {
      notes.push('(憑證被拒, 已自動更新後重試)')
      deps.log?.(`skill ${skill}: credentials refreshed for ${conv.key}`)
      r = await once(action, args)
    } else {
      notes.push('(憑證被拒, 自動更新失敗, 已通知 owner)')
      deps.notifyOwner(conv, `⚠️ 技能 ${skill} 的憑證被拒, 自動更新也失敗 (${conv.key} 使用時):\n${rr.out.split('\n').slice(-3).join('\n')}`)
    }
  }
  // nothing that holds a credential goes back to the conversation
  const creds = Object.values({ ...credEnv(deps, action), ...(action.refresh && manifest.actions[action.refresh] ? credEnv(deps, manifest.actions[action.refresh]!) : {}) })
  const secrets = [...secretsIn(creds), ...tokensOf(deps, action)]
  const removed = scrubOutputs(conv.folder, start - 1000, secrets)
  const red = redact(r.out, secrets)
  if (removed.length || red.hit) {
    deps.notifyOwner(conv, `⚠️ 技能 ${skill} 的 ${actionName} 在 ${conv.key} 的輸出含有憑證內容, 已${removed.length ? `刪除 ${removed.join(', ')}` : ''}${red.hit ? ' 並遮蔽回傳文字' : ''}. 請檢查這支技能.`)
    notes.push('(輸出含有憑證內容, 已刪除或遮蔽, 已通知 owner)')
  }
  let ok = r.code === 0
  if (stores.length) {
    const names = stores.map(s => s.name).join(', ')
    if (!ok) notes.push(`(動作沒有成功結束, 資料庫 ${names} 未寫回)`)
    else {
      const why = writeBack(stores, work, secrets)
      if (why) {
        ok = false
        notes.push(`(資料庫 ${names} 未寫回, 整次作廢: ${why})`)
        deps.notifyOwner(conv, `⚠️ 技能 ${skill} 的 ${actionName} 在 ${conv.key} 對資料庫 ${names} 的寫入被拒, 整次作廢, 資料庫沒有變動: ${why}`)
      }
    }
  }
  db.addSkillRun(runAs, skill, actionName, ok ? 'ok' : 'failed')
  const tail = red.text.split('\n').slice(-60).join('\n').slice(-6000)
  return { ok, text: [`exit ${r.code}`, ...notes, tail].join('\n') }
}

/** Remove a run's work folder, even after the script took its own permissions away. */
function dropWork(work: string, log?: (msg: string) => void) {
  try { rmSync(work, { recursive: true, force: true }) } catch {
    Bun.spawnSync(['chmod', '-R', 'u+rwx', work])
    try { rmSync(work, { recursive: true, force: true }) } catch (e) { log?.(`skill store: could not remove ${work}: ${e}`) }
  }
}

/** Check every staged database and write them all back, or none: why not, or null. */
function writeBack(stores: StoreUse[], work: string, secrets: string[]): string | null {
  const plans: Plan[] = []
  for (const s of stores) {
    let p: ReturnType<typeof check>
    try { p = check(s, join(work, s.env), secrets) } catch (e) { return `${s.name} 檢查失敗: ${e instanceof Error ? e.message : e}` }
    if ('error' in p) return p.error
    plans.push(p)
  }
  const total = plans.reduce((n, p) => n + p.added, 0)
  if (total > RUN_MAX) return `這次共寫入 ${total} bytes, 超過單次上限 ${RUN_MAX} bytes`
  try { commit(plans, work) } catch (e) { return `寫回失敗: ${e instanceof Error ? e.message : e}` }
  return null
}

/** What /router skill approve shows about a skill's actions. */
export function describeActions(dir: string): string {
  const m = loadManifest(dir)
  if (!m) return '(沒有 privileged.json)'
  return Object.entries(m.actions).map(([n, a]) => `${n}${a.internal ? ' (只由 router 執行)' : ''}: ${a.run.join(' ')}; 角色 ${(a.roles ?? ['owner', 'admin', 'power', 'user']).join(', ')}${a.creds ? `; 憑證 ${Object.values(a.creds).join(', ')}` : ''}${a.http ? `; API 憑證 ${Object.values(a.http).join(', ')}` : ''}${a.bots ? `; bot 憑證 ${Object.values(a.bots).join(', ')}` : ''}${a.store ? `; 資料庫 ${Object.values(a.store).map(d => { const s = storeOf(d); return `${s.name} (${s.mode})` }).join(', ')}` : ''}${Object.entries(a.args ?? {}).filter(([, s]) => s.roles).map(([n, s]) => `; 參數 ${n} 限 ${s.roles!.join(', ')}`).join('')}${a.internal && a.mounts?.length ? `; 另外可讀 ${a.mounts.join(', ')}` : ''}`).join('\n')
}
