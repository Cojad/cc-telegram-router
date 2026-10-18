// deploy/install.sh's checks before any job (README How to install, docs/operations.md
// 「部署」): bun at least the version package.json's engines asks; the repo's packages
// installed as bun.lock has them (missing or out of date: bun install --frozen-lockfile,
// never an unlocked install); claude found, its version shown, a warning when older than
// the version the router is tested with. install.sh checks that bun exists before it
// runs this. Exit 1 when something has to be fixed first. Tests: router/test/preflight.test.ts.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** The Claude Code version the router is developed and tested with (README Requirements). */
export const TESTED_CLAUDE = '2.1.302'

/** package.json's engines.bun, e.g. ">=1.4.3". */
export function bunRange(repo: string): string | null {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  return typeof pkg.engines?.bun === 'string' ? pkg.engines.bun : null
}

/** a < b for dotted versions (numbers compared part by part; anything after - or + ignored). */
export function olderThan(a: string, b: string): boolean {
  const parts = (v: string) => v.split(/[-+ ]/)[0]!.split('.').map(n => Number.parseInt(n, 10) || 0)
  const x = parts(a), y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

/** bun.lock (JSON with trailing commas) as an object. */
function readLock(repo: string): any {
  return JSON.parse(readFileSync(join(repo, 'bun.lock'), 'utf8').replace(/,(\s*[}\]])/g, '$1'))
}

/** Where a bun.lock packages key lives: "a/b" is b under a's node_modules; @scope/name is one name. */
export function modulePath(repo: string, key: string): string {
  const names: string[] = []
  const parts = key.split('/')
  for (let i = 0; i < parts.length; i++) names.push(parts[i]!.startsWith('@') ? `${parts[i]}/${parts[++i]}` : parts[i]!)
  return join(repo, 'node_modules', names.join('/node_modules/'))
}

/** The packages bun.lock has that node_modules is missing or holds at another version (none: in step). */
export function depsOutOfStep(repo: string): string[] {
  if (!existsSync(join(repo, 'node_modules'))) return ['node_modules']
  const out: string[] = []
  for (const [key, entry] of Object.entries(readLock(repo).packages ?? {}) as Array<[string, any[]]>) {
    const meta = entry[2] ?? {}
    // packages for another platform are not installed here
    if ((meta.os && ![meta.os].flat().includes(process.platform)) || (meta.cpu && ![meta.cpu].flat().includes(process.arch))) continue
    const spec = String(entry[0])
    const want = spec.slice(spec.lastIndexOf('@') + 1)
    let have: string | null = null
    try { have = JSON.parse(readFileSync(join(modulePath(repo, key), 'package.json'), 'utf8')).version ?? null } catch {}
    if (have !== want) out.push(`${key} (要 ${want}, ${have ? `裝的是 ${have}` : '沒有裝'})`)
  }
  return out
}

export type Check = { ok: boolean; lines: string[] }

/** bun: the running one against engines. */
export function checkBun(repo: string, version = Bun.version, path = process.execPath): Check {
  const range = bunRange(repo)
  const ok = !range || Bun.semver.satisfies(version, range)
  return { ok, lines: [ok ? `bun: ${path} (${version}${range ? `, 需要 ${range}` : ''})` : `bun ${version} (${path}) 太舊: package.json 的 engines 要 ${range}. 更新: bun upgrade (或照 https://bun.sh 重新安裝)`] }
}

/** claude: found, its version; older than TESTED_CLAUDE is a warning only. */
export function checkClaude(path: string | null, version: string | null): Check {
  if (!path) return { ok: false, lines: ['找不到 claude (Claude Code CLI): 先安裝 Claude Code (https://code.claude.com/docs), 確認 command -v claude 找得到'] }
  const v = version?.match(/\d+\.\d+\.\d+/)?.[0] ?? null
  if (!v) return { ok: true, lines: [`claude: ${path} (版本讀不到, 本 router 以 ${TESTED_CLAUDE} 開發與測試)`] }
  const old = olderThan(v, TESTED_CLAUDE)
  return { ok: true, lines: [`claude: ${path} (${v})`, ...(old ? [`⚠️ claude ${v} 比開發與測試用的 ${TESTED_CLAUDE} 舊, 部分功能可能不能用; 建議更新 (claude update)`] : [])] }
}

/** The repo's packages: in step, or installed now with bun install --frozen-lockfile. */
export function checkDeps(repo: string, install: (repo: string) => number = defaultInstall): Check {
  const off = depsOutOfStep(repo)
  if (!off.length) return { ok: true, lines: ['相依套件: 跟 bun.lock 一致'] }
  const lines = [`相依套件沒有裝好 (${off.slice(0, 5).join(', ')}${off.length > 5 ? ` 等 ${off.length} 個` : ''}): 正在執行 bun install --frozen-lockfile`]
  const code = install(repo)
  const left = code === 0 ? depsOutOfStep(repo) : off
  if (code === 0 && !left.length) return { ok: true, lines: [...lines, '相依套件: 已安裝, 跟 bun.lock 一致'] }
  return { ok: false, lines: [...lines, `bun install --frozen-lockfile 失敗 (結束碼 ${code}${code === 0 ? ', 裝完仍跟 bun.lock 不一致' : ''}): 在 repo 目錄看它的錯誤訊息; bun.lock 跟 package.json 不一致時先 git pull 或 git checkout bun.lock package.json, 不要用沒鎖版本的 bun install`] }
}

function defaultInstall(repo: string): number {
  return Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile'], { cwd: repo, stdout: 'inherit', stderr: 'inherit' }).exitCode
}

if (import.meta.main) {
  const repo = join(import.meta.dir, '..')
  const claudePath = Bun.which('claude')
  const claudeVersion = claudePath ? Bun.spawnSync([claudePath, '--version'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim() : null
  let ok = true
  for (const c of [checkBun(repo), checkDeps(repo), checkClaude(claudePath, claudeVersion)]) {
    for (const l of c.lines) (c.ok ? process.stdout : process.stderr).write(`${l}\n`)
    if (!c.ok) ok = false
  }
  process.exit(ok ? 0 : 1)
}
