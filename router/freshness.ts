// Stale tool descriptions after a restart. A resumed worker keeps what it
// read before: the plugin's tool descriptions it loaded with ToolSearch and
// the skill SOPs it opened. When the plugin or a skill this conversation can
// see has changed since its worker last started, the next message carries a
// one-time reminder in <router_log> (db.addLog, bound to that one delivery).
// Only a resume needs it: a new session reads everything fresh.

import { createHash } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'

export const STALE_NOTE = '工具與技能說明已更新: 之前讀過的技能 SOP 與工具說明可能已過時, 用到時請重新讀取 (技能用 Skill 工具重新載入, 延遲載入的工具用 ToolSearch 重新取得定義).'

const SKIP = new Set(['venv', 'node_modules', '__pycache__', '.git'])

function walk(dir: string, out: string[]): void {
  let names: string[]
  try { names = readdirSync(dir).sort() } catch { return }
  for (const n of names) {
    if (SKIP.has(n)) continue
    const p = join(dir, n)
    const st = lstatSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (st.isFile()) out.push(p)
  }
}

/** One hash over every file (path and content) under these paths; a path
 *  may be a single file. A missing path counts as empty. */
export function fingerprint(paths: string[]): string {
  const h = createHash('sha256')
  for (const root of paths) {
    h.update(`\u0000${root}\u0000`)
    if (!existsSync(root)) continue
    const files: string[] = []
    if (lstatSync(root).isFile()) files.push(root)
    else walk(root, files)
    for (const f of files) { h.update(`${relative(root, f)}\u0000`); h.update(readFileSync(f)); h.update('\u0000') }
  }
  return h.digest('hex')
}

/** Record this start's fingerprint in <folder>/.chat/tools.sha (router-owned,
 *  workers cannot write .chat). True when a resumed worker should be told:
 *  the fingerprint differs from its last start, or none was recorded yet. */
export function noteStart(folder: string, fp: string, resumed: boolean): boolean {
  const file = join(folder, '.chat', 'tools.sha')
  let prev: string | null = null
  try { prev = readFileSync(file, 'utf8').trim() } catch {}
  if (prev !== fp) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, fp + '\n') }
  return resumed && prev !== fp
}
