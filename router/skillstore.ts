// A privileged skill action's database (store, docs/credentials-and-skills.md
// 「特權技能」). Each bot has its own copy of a database, shared by all its
// conversations: <stateDir>/skill-store/<bot folder name>/<database>/, the
// bot folder name being the router's own (bot<id>, as under home). The state
// dir is hidden from conversations and every other sandbox. For a run the
// router copies the database to <stateDir>/skill-store-work/run-*/<ENV>/,
// binds that writable into the action's bwrap and, once the run exits 0,
// checks what changed:
//   append: no file or folder may go, a file's content may not change, a
//     .jsonl file may only grow at its end (the old bytes the start of the new
//     ones, every new line complete, valid UTF-8 and JSON); new files allowed
//   full: anything may change or go (only actions limited to owner and admin)
// Both: only regular files and folders, a written file at most 5 MB (a
// .jsonl in append: what was added), a run at most 20 MB in all, and no
// credential content. All passes -> written back file by file, each one
// atomically (a temp file renamed over it); anything fails -> the run is
// void and the database untouched. Runs on the same database queue (one lock
// per database, for every conversation of the bot).

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { storeOf, type Action } from './privskill'

export const FILE_MAX = 5 * 1024 * 1024
export const RUN_MAX = 20 * 1024 * 1024

export type Mode = 'append' | 'full'
export type StoreUse = { env: string; name: string; mode: Mode; dir: string }

/** The databases an action uses, each at <storeRoot>/<botId>/<name>. */
export function storesOf(a: Action, storeRoot: string, botId: string): StoreUse[] {
  return Object.entries(a.store ?? {}).map(([env, d]) => { const s = storeOf(d); return { env, ...s, dir: join(storeRoot, botId, s.name) } })
}

const chains = new Map<string, Promise<void>>()
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(fn)
  const done = run.then(() => {}, () => {})
  chains.set(key, done)
  void done.then(() => { if (chains.get(key) === done) chains.delete(key) })
  return run
}
/** fn while holding every database's lock (taken in a fixed order, so two runs never wait on each other). */
export function withStoreLocks<T>(dirs: string[], fn: () => Promise<T>): Promise<T> {
  const [first, ...rest] = [...new Set(dirs)].sort()
  return first === undefined ? fn() : withLock(first, () => withStoreLocks(rest, fn))
}

type Entry = { kind: 'file' | 'dir' | 'other'; size: number }
function tree(root: string): Map<string, Entry> {
  const out = new Map<string, Entry>()
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e), rel = relative(root, p)
      const st = lstatSync(p)
      if (st.isDirectory()) { out.set(rel, { kind: 'dir', size: 0 }); walk(p) }
      else out.set(rel, { kind: st.isFile() ? 'file' : 'other', size: st.size })
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

/** A fresh copy of each database (an empty folder when it has none yet) under work. */
export function stage(stores: StoreUse[], work: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const s of stores) {
    mkdirSync(s.dir, { recursive: true, mode: 0o700 })
    const to = join(work, s.env)
    rmSync(to, { recursive: true, force: true })
    cpSync(s.dir, to, { recursive: true })
    mkdirSync(to, { recursive: true, mode: 0o700 })
    env[s.env] = to
  }
  return env
}

export type Plan = { dir: string; name: string; rm: string[]; mkdir: string[]; write: { rel: string; data: Buffer }[]; added: number }

const JSONL = /\.jsonl$/i
const utf8 = new TextDecoder('utf-8', { fatal: true })

function jsonLines(name: string, rel: string, added: Buffer): string | null {
  if (!added.length) return null
  if (added[added.length - 1] !== 0x0a) return `${name}/${rel} 新加的內容要以換行結尾`
  let text: string
  try { text = utf8.decode(added) } catch { return `${name}/${rel} 新加的內容不是合法的 UTF-8` }
  const lines = text.slice(0, -1).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.replace(/\r$/, '')
    if (!l.trim()) return `${name}/${rel} 新加的第 ${i + 1} 行是空行`
    try { JSON.parse(l) } catch { return `${name}/${rel} 新加的第 ${i + 1} 行不是合法 JSON` }
  }
  return null
}

/** What writing the staged copy back takes, or why the run is void. */
export function check(s: StoreUse, staged: string, secrets: string[]): Plan | { error: string } {
  const before = tree(s.dir), after = tree(staged)
  const plan: Plan = { dir: s.dir, name: s.name, rm: [], mkdir: [], write: [], added: 0 }
  const fail = (why: string) => ({ error: why })
  for (const [rel, e] of after) if (e.kind === 'other') return fail(`${s.name}/${rel} 不是一般檔案或資料夾 (symlink, 裝置檔等一律不接受)`)
  for (const [rel, e] of before) {
    const now = after.get(rel)
    if (s.mode === 'append') {
      if (!now) return fail(`${s.name}/${rel} 被刪除了 (append 模式不能刪)`)
      if (now.kind !== e.kind) return fail(`${s.name}/${rel} 從${e.kind === 'dir' ? '資料夾' : '檔案'}變成別的東西了`)
    } else if (!now || now.kind !== e.kind) plan.rm.push(rel)
  }
  for (const [rel, e] of after) {
    const old = before.get(rel)
    if (e.kind === 'dir') { if (!old || old.kind !== 'dir') plan.mkdir.push(rel); continue }
    let data: Buffer, oldData: Buffer | null = null
    try { data = readFileSync(join(staged, rel)) } catch (err) { return fail(`${s.name}/${rel} 讀不到: ${err}`) }
    if (old?.kind === 'file') {
      oldData = readFileSync(join(s.dir, rel))
      if (oldData.equals(data)) continue
    }
    let added = data.length
    if (s.mode === 'append') {
      if (oldData && !JSONL.test(rel)) return fail(`${s.name}/${rel} 的內容被改了 (append 模式只能新增檔案, .jsonl 只能在尾端加)`)
      if (JSONL.test(rel)) {
        if (oldData && (data.length < oldData.length || !data.subarray(0, oldData.length).equals(oldData))) return fail(`${s.name}/${rel} 原有的內容被改了 (.jsonl 只能在尾端加)`)
        if (oldData?.length && oldData[oldData.length - 1] !== 0x0a) return fail(`${s.name}/${rel} 原有內容沒有以換行結尾, 不能再加`)
        const why = jsonLines(s.name, rel, data.subarray(oldData?.length ?? 0))
        if (why) return fail(why)
        added = data.length - (oldData?.length ?? 0)
      }
    }
    if (added > FILE_MAX) return fail(`${s.name}/${rel} 寫入 ${added} bytes, 超過單檔上限 ${FILE_MAX} bytes`)
    plan.added += added
    const hit = secrets.find(x => data.includes(x))
    if (hit) return fail(`${s.name}/${rel} 含有憑證內容`)
    plan.write.push({ rel, data })
  }
  return plan
}

/** Write the plans back: what goes first, then new folders, then each file
 *  through a temp file in work renamed over it. */
export function commit(plans: Plan[], work: string) {
  let n = 0
  for (const p of plans) {
    for (const rel of [...p.rm].sort().reverse()) rmSync(join(p.dir, rel), { recursive: true, force: true })
    for (const rel of [...p.mkdir].sort()) mkdirSync(join(p.dir, rel), { recursive: true, mode: 0o700 })
    for (const w of p.write) {
      const tmp = join(work, `.commit-${n++}`)
      writeFileSync(tmp, w.data, { mode: 0o600 })
      renameSync(tmp, join(p.dir, w.rel))
    }
  }
}

/** A run's work folder (same file system as the databases, so rename is atomic). */
export function workDir(storeRoot: string): string {
  const root = `${storeRoot}-work`
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return mkdtempSync(join(root, 'run-'))
}
