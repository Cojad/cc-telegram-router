// /router skill approve (docs/credentials-and-skills.md 「特權技能」, docs/skill-runtime.md
// 「核准」「Python 套件 (uv)」). One step when nothing needs a second look; else a screen
// first, then `/router skill approve <技能> <確認碼>` (the first 8 hex of the skill's hash,
// so a skill changed in between needs the screen again). Needs a second look:
//   - host access or more internet ports (owner only: admin is refused outright)
//   - uv.lock packages the model did not judge low risk (or could not judge), and
//     every package from a custom source (git, URL, path: always a person; 柯姊's rule)
// A skill with pyproject.toml and uv.lock has its environment built
// (router/skillenv.ts) before the approval is recorded: the reply says it is
// being built, the result comes as a second message (later); a build that
// fails, or a skill changed meanwhile, is not approved.

import type { RouterDb } from './db'
import type { Pkg } from './packages'
import type { Verdict } from './pkgreview'
import { hashSkill, loadManifest, ownerOnly } from './privskill'
import { approveRefusal, describeActions } from './skillrun'
import { lockFiles, lockPackages, customLabel, ensureEnv, type EnvDeps, type LockPkg } from './skillenv'

export interface ApproveDeps {
  db: RouterDb
  /** pkgreview's verdicts (the model, its cache); none: every PyPI package needs a person too. */
  review?(pkgs: Pkg[]): Promise<Verdict[]>
  env?: EnvDeps
}
export type ApproveResult = { text: string; later?: Promise<string> }

/** What the approval screen lists about the packages, and what of it needs a second look. */
async function packages(deps: ApproveDeps, pkgs: LockPkg[]): Promise<{ lines: string[]; flagged: string[] }> {
  const pypi = pkgs.filter(p => p.pypi), custom = pkgs.filter(p => !p.pypi)
  let vs: Verdict[] = []
  if (pypi.length && deps.review) { try { vs = await deps.review(pypi.map(p => ({ eco: 'pypi', name: p.name.toLowerCase() }))) } catch {} }
  const verdict = (p: LockPkg) => vs.find(v => v.name === p.name.toLowerCase())
  const lines: string[] = [], flagged: string[] = []
  for (const p of pypi) {
    const v = verdict(p)
    const line = v ? `${p.name} ${p.version} (PyPI) [${v.risk}] ${v.reason}` : `${p.name} ${p.version} (PyPI) [沒有自動審核結果]`
    lines.push(line)
    if (!v || v.risk !== 'low') flagged.push(line)
  }
  for (const p of custom) { const line = `${customLabel(p)} [自訂來源: 不查 PyPI 的資料, 由人判斷]`; lines.push(line); flagged.push(line) }
  return { lines, flagged }
}

/** /router skill approve <name> [code] by role (owner or admin; the command checks). */
export async function approveSkill(deps: ApproveDeps, dir: string, name: string, by: string, role: string, code?: string): Promise<ApproveResult> {
  const refusal = approveRefusal(dir, name, role)
  if (refusal) return { text: refusal }
  const m = loadManifest(dir)!
  const files = lockFiles(dir)
  if (files && 'error' in files) return { text: `技能 ${name} 沒有核准: ${files.error}` }
  const pkgs = files ? lockPackages(files.lock) : []
  if (!Array.isArray(pkgs)) return { text: `技能 ${name} 沒有核准: ${pkgs.error}` }
  const hash = hashSkill(dir), short = hash.slice(0, 8)
  const pk = await packages(deps, pkgs)
  const owner = ownerOnly(m)
  const look = [...owner, ...pk.flagged.map(l => `套件 ${l}`)]
  if (code !== undefined && code !== short) return { text: `確認碼 ${code} 不符 (技能在畫面之後被改過, 或打錯了): 重新打 /router skill approve ${name} 看最新的畫面` }
  if (look.length && code === undefined) {
    return { text: [
      `技能 ${name} 要確認後才核准 (${dir}):`,
      ...look.map(l => `⚠️ ${l}`),
      '', '動作:', describeActions(dir),
      ...(pk.lines.length ? ['', `Python 套件 (uv.lock, 共 ${pk.lines.length} 個):`, ...pk.lines.map(l => `- ${l}`)] : []),
      '', `確認核准: /router skill approve ${name} ${short}`, '(之後檔案若被改動, 確認碼就不再有效)',
    ].join('\n') }
  }
  const done = () => `已核准技能 ${name} 的特權動作 (${dir}):\n${describeActions(dir)}${pk.lines.length ? `\nPython 套件 ${pk.lines.length} 個, 環境已建好` : ''}\n之後檔案若被改動會自動暫停, 需要重新核准`
  if (!files) { deps.db.approveSkill(dir, name, hash, by); return { text: done() } }
  if (!deps.env) return { text: `技能 ${name} 沒有核准: 這個 router 沒有設定 Python 環境的位置` }
  const later = ensureEnv(deps.env, files).then(r => {
    if (!r.ok) return `技能 ${name} 沒有核准: Python 環境建不起來: ${r.why}`
    if (hashSkill(dir) !== hash) return `技能 ${name} 沒有核准: 建環境的時候檔案被改過了, 重新打 /router skill approve ${name}`
    deps.db.approveSkill(dir, name, hash, by)
    return done()
  }, e => `技能 ${name} 沒有核准: Python 環境建不起來: ${e instanceof Error ? e.message : e}`)
  return { text: `核准中: 正在建技能 ${name} 的 Python 環境 (uv sync --locked, ${pkgs.length} 個套件), 好了會再發一則結果; 結果出來前還不能用`, later }
}
