// run_skill: one privileged skill action for a conversation (plan 10d; the
// mechanics are in router/privskill.ts). Finds the approved skill in the
// conversation's bot or all-bots scope, checks its hash, role, arguments and
// the hourly limit, runs it sandboxed with its credential folders, retries
// once after the refresh action when the credentials were refused, and
// scrubs what comes back.

import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { Conversation, RouterDb } from './db'
import { loadManifest, hashSkill, buildArgv, sandboxArgv, secretsIn, scrubOutputs, redact, argRoleRefusal, RUNS_PER_HOUR, type Action } from './privskill'
import type { Credential } from './config'

export type RunResult = { code: number; out: string }

export interface SkillRunDeps {
  db: RouterDb
  home: string
  /** Where credential folders live (router-private), e.g. /x/cc/.router/creds */
  credsRoot: string
  /** $HOME of the router user, hidden in the sandbox */
  userHome: string
  /** Binaries outside the system dirs the sandbox needs (e.g. ~/.local/bin/yt-dlp) */
  extraRo: string[]
  botDir(bot: string): string
  /** An http API credential by name (router config), for actions that declare http. */
  httpCred?(name: string): Credential | undefined
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

export async function runSkill(deps: SkillRunDeps, conv: Conversation, role: string, skill: string, actionName: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const { db } = deps
  const dir = skillDirs(deps, conv.bot, skill)[0]
  if (!dir) return { ok: false, text: `找不到有特權動作的技能 ${skill} (只有這隻 bot 或全部 bot 範圍, 而且帶 privileged.json 的技能可以用)` }
  const approval = db.skillApproval(dir)
  if (!approval) return { ok: false, text: `技能 ${skill} 還沒經 owner 或 admin 核准 (/router skill approve ${skill})` }
  if (hashSkill(dir) !== approval.hash) {
    deps.notifyOwner(conv, `⚠️ 技能 ${skill} 的檔案在核准後被改過, 特權動作已暫停. 檢查後用 /router skill approve ${skill} 重新核准.`)
    return { ok: false, text: `技能 ${skill} 的檔案在核准後被改過, 已暫停, 等 owner 或 admin 重新核准` }
  }
  const manifest = loadManifest(dir)!
  const action = manifest.actions[actionName]
  if (!action || action.internal) return { ok: false, text: `技能 ${skill} 沒有可呼叫的動作 ${actionName} (可用: ${Object.entries(manifest.actions).filter(([, a]) => !a.internal).map(([n]) => n).join(', ')})` }
  if (!(action.roles ?? ['owner', 'admin', 'power', 'user']).includes(role)) return { ok: false, text: `技能 ${skill} 的 ${actionName} 不開放給 ${role} 角色的對話` }
  const argWhy = argRoleRefusal(action, args, role)
  if (argWhy) return { ok: false, text: `${argWhy}. 需要的話告訴對方, 並用 request_elevation 申請提權` }
  const used = db.skillRunsSince(conv.key, new Date(Date.now() - 3_600_000).toISOString())
  if (used >= RUNS_PER_HOUR) { db.addSkillRun(conv.key, skill, actionName, 'refused'); return { ok: false, text: `這個對話一小時內已經用了 ${used} 次特權技能, 上限 ${RUNS_PER_HOUR} 次, 請稍後再試` } }

  const credDir = (name: string) => { const d = join(deps.credsRoot, name); mkdirSync(d, { recursive: true, mode: 0o700 }); return d }
  const credEnv = (a: Action) => Object.fromEntries(Object.entries(a.creds ?? {}).map(([env, name]) => [env, credDir(name)]))
  const httpCreds = (a: Action) => Object.entries(a.http ?? {}).map(([env, name]) => ({ env, name, cred: deps.httpCred?.(name) }))
  for (const h of [...httpCreds(action), ...(action.refresh && manifest.actions[action.refresh] ? httpCreds(manifest.actions[action.refresh]!) : [])]) {
    if (h.cred?.kind !== 'http' || !h.cred.baseUrl) return { ok: false, text: `技能 ${skill} 需要的 API 憑證 ${h.name} 不存在或不是 http 憑證, 請 owner 檢查` }
  }
  const httpEnv = (a: Action): Record<string, string> => Object.fromEntries(httpCreds(a).flatMap(({ env, cred }) => [
    [`${env}_URL`, cred!.baseUrl!.replace(/\/+$/, '')],
    [`${env}_HEADER`, `${cred!.header ?? 'Authorization'}: ${`${cred!.scheme ?? 'Bearer'} ${cred!.token}`.trim()}`],
  ]))
  const once = async (a: Action, a_args: Record<string, unknown>): Promise<RunResult> => {
    const argv = buildArgv(a, dir, a_args, credDir)
    if ('error' in argv) return { code: -1, out: argv.error }
    // only internal (router-run) actions get extra mounts and env: a conversation's actions never see the ssh agent
    const mounts = a.internal ? (a.mounts ?? []).map(m => m.startsWith('~/') ? join(deps.userHome, m.slice(2)) : m) : []
    const sb = sandboxArgv({ argv, skillDir: dir, convFolder: conv.folder, creds: credEnv(a), home: deps.userHome, extraRo: [...deps.extraRo, ...mounts], credsWritable: !!a.internal, env: { ...(a.internal ? a.env : {}), ...httpEnv(a) } })
    return deps.exec(sb.argv, sb.env, (a.timeout ?? 600) * 1000)
  }

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
  const creds = Object.values({ ...credEnv(action), ...(action.refresh && manifest.actions[action.refresh] ? credEnv(manifest.actions[action.refresh]!) : {}) })
  const secrets = [...secretsIn(creds), ...httpCreds(action).map(h => h.cred!.token).filter(t => t.length >= 16)]
  const removed = scrubOutputs(conv.folder, start - 1000, secrets)
  const red = redact(r.out, secrets)
  if (removed.length || red.hit) {
    deps.notifyOwner(conv, `⚠️ 技能 ${skill} 的 ${actionName} 在 ${conv.key} 的輸出含有憑證內容, 已${removed.length ? `刪除 ${removed.join(', ')}` : ''}${red.hit ? ' 並遮蔽回傳文字' : ''}. 請檢查這支技能.`)
    notes.push('(輸出含有憑證內容, 已刪除或遮蔽, 已通知 owner)')
  }
  db.addSkillRun(conv.key, skill, actionName, r.code === 0 ? 'ok' : 'failed')
  const tail = red.text.split('\n').slice(-60).join('\n').slice(-6000)
  return { ok: r.code === 0, text: [`exit ${r.code}`, ...notes, tail].join('\n') }
}

/** What /router skill approve shows about a skill's actions. */
export function describeActions(dir: string): string {
  const m = loadManifest(dir)
  if (!m) return '(沒有 privileged.json)'
  return Object.entries(m.actions).map(([n, a]) => `${n}${a.internal ? ' (只由 router 執行)' : ''}: ${a.run.join(' ')}; 角色 ${(a.roles ?? ['owner', 'admin', 'power', 'user']).join(', ')}${a.creds ? `; 憑證 ${Object.values(a.creds).join(', ')}` : ''}${a.http ? `; API 憑證 ${Object.values(a.http).join(', ')}` : ''}${Object.entries(a.args ?? {}).filter(([, s]) => s.roles).map(([n, s]) => `; 參數 ${n} 限 ${s.roles!.join(', ')}`).join('')}${a.internal && a.mounts?.length ? `; 另外可讀 ${a.mounts.join(', ')}` : ''}`).join('\n')
}
