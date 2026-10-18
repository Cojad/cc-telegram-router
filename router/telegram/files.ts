// Attachments to and from a bot's Bot API server (docs/operations.md
// 「自架 Bot API server」): the official https://api.telegram.org, or a
// self-hosted telegram-bot-api. In --local mode that server's getFile answers
// with an absolute path on its own disk and has no /file endpoint, so the
// router (on the same machine) reads the file itself; uploads may then be up
// to 2000 MB instead of 50 MB. Tests: router/test/local-bot-api.test.ts.

import { realpathSync, statSync, readFileSync } from 'fs'
import { basename, dirname, isAbsolute } from 'path'
import { OFFICIAL_API_ROOT } from '../config'

export const OFFICIAL_UPLOAD_BYTES = 50 * 1024 * 1024
export const LOCAL_UPLOAD_BYTES = 2000 * 1024 * 1024
/** The largest file read from a --local server's disk (its own limit). */
export const LOCAL_DOWNLOAD_BYTES = 2000 * 1024 * 1024

/** The official server (by host): anything else counts as self-hosted. */
export function isOfficialApi(apiRoot: string | undefined): boolean {
  if (!apiRoot) return true
  try { return new URL(apiRoot).hostname.toLowerCase() === new URL(OFFICIAL_API_ROOT).hostname } catch { return false }
}

/** The largest attachment a bot may send through this server: 2000 MB on a self-hosted one, else 50 MB. */
export function uploadLimit(apiRoot: string | undefined): number {
  return isOfficialApi(apiRoot) ? OFFICIAL_UPLOAD_BYTES : LOCAL_UPLOAD_BYTES
}

export const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`

/** A file of a server's answer, for names downstream: never the server's own
 *  folders, which hold the bot token in --local mode (its last two parts, e.g. documents/file_3.txt). */
export function shownPath(filePath: string): string {
  return isAbsolute(filePath) ? `${basename(dirname(filePath))}/${basename(filePath)}` : filePath
}

export type FetchFileOpts = {
  getFile: (fileId: string) => Promise<{ file_path?: string; file_unique_id: string }>
  token: string
  apiRoot: string | undefined
  /** bots[].localFilesDir: a path from the server must be under it. */
  localFilesDir?: string
  /** Never read from here, whatever the server says (the router's state dir and home). */
  forbidden?: string[]
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir === '/' ? dir : dir + '/')

/** getFile and the file's bytes: over HTTP from <apiRoot>/file/bot<token>/<path>,
 *  or, when the server answers with an absolute path (--local), from disk:
 *  a regular file, at most LOCAL_DOWNLOAD_BYTES, not in forbidden, under
 *  localFilesDir when set. file_path comes back as shownPath; errors never carry the token. */
export async function fetchBotFile(o: FetchFileOpts, fileId: string): Promise<{ buf: Buffer; file_path: string; file_unique_id: string }> {
  const got = await o.getFile(fileId)
  if (!got.file_path) throw new Error('Telegram returned no file_path — file may have expired')
  const hide = (s: string) => o.token ? s.split(o.token).join('<token>') : s
  if (!isAbsolute(got.file_path)) {
    const res = await fetch(`${(o.apiRoot ?? OFFICIAL_API_ROOT).replace(/\/+$/, '')}/file/bot${o.token}/${got.file_path}`)
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    return { buf: Buffer.from(await res.arrayBuffer()), file_path: got.file_path, file_unique_id: got.file_unique_id }
  }
  const shown = hide(got.file_path)
  const fail = (why: string) => new Error(`自架 Bot API server (--local) 的附件 ${shown} ${why}`)
  let real: string
  try { real = realpathSync(got.file_path) } catch (e) { throw diskError(e, fail) }
  for (const f of o.forbidden ?? []) {
    let dir = f
    try { dir = realpathSync(f) } catch {}
    if (under(real, dir)) throw fail('落在 router 自己的資料夾裡, 不讀取')
  }
  if (o.localFilesDir) {
    let dir = o.localFilesDir
    try { dir = realpathSync(o.localFilesDir) } catch {}
    if (!under(real, dir)) throw fail(`不在這隻 bot 的 localFilesDir (${dir}) 裡, 不讀取`)
  }
  let st
  try { st = statSync(real) } catch (e) { throw diskError(e, fail) }
  if (!st.isFile()) throw fail('不是一般檔案, 不讀取')
  if (st.size > LOCAL_DOWNLOAD_BYTES) throw fail(`太大 (${mb(st.size)}, 上限 ${mb(LOCAL_DOWNLOAD_BYTES)})`)
  let buf: Buffer
  try { buf = readFileSync(real) } catch (e) { throw diskError(e, fail) }
  return { buf, file_path: shownPath(got.file_path), file_unique_id: got.file_unique_id }
}

function diskError(e: unknown, fail: (why: string) => Error): Error {
  const code = (e as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM') return fail('router 沒有讀取權限: 讓執行 router 的使用者能讀 server 的 --dir (例如把它加進 server 使用者的群組, 資料夾與檔案給群組讀取權限)')
  if (code === 'ENOENT' || code === 'ENOTDIR') return fail('不存在: router 要跟 server 在同一台, 並看得到同一個路徑 (server 在 docker 裡時, 要把它的 --dir 以相同路徑掛出來)')
  return fail(`讀取失敗: ${code ?? String(e)}`)
}
