// A self-hosted Bot API server (docs/operations.md 「自架 Bot API server」,
// router/telegram/files.ts), module level; end to end in e2e-localapi.test.ts
// (from source) and e2e-compiled.test.ts (compiled). A fake server in
// --local mode: getFile answers with an absolute path on disk (in a folder
// named after the token, as telegram-bot-api does) and there is no /file
// endpoint. Checked: config's apiRoot levels (bots[] > config > official)
// and their warnings; download_attachment reads from disk, the token never
// in what comes back or in errors; unreadable, missing, not a regular file,
// outside localFilesDir and inside the router's own folders refused with a
// clear error; uploads up to 2000 MB on a self-hosted server and 50 MB on
// the official one (sparse files: their size is never written to disk);
// the official server as before (over /file/bot<token>/<path>).

import { afterAll, expect, test } from 'bun:test'
import { Bot } from 'grammy'
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, ftruncateSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { callTool, type OutboundDeps } from '../telegram/outbound'
import { fetchBotFile, isOfficialApi, uploadLimit, shownPath, LOCAL_UPLOAD_BYTES, OFFICIAL_UPLOAD_BYTES } from '../telegram/files'
import { openStore } from '../telegram/store'
import { botApiRoot, credApiRoot, loadConfig, OFFICIAL_API_ROOT } from '../config'

const TOKEN = '123:LOCALtokenLOCALtokenLOCALtoken'
const dir = mkdtempSync(join(tmpdir(), 'cctr-localapi-'))
// the server's --dir, with a folder per bot token like telegram-bot-api
const serverDir = join(dir, 'tg-server')
const docs = join(serverDir, TOKEN, 'documents')
mkdirSync(docs, { recursive: true })
writeFileSync(join(docs, 'file_1.txt'), 'hello from the local server\n')
const routerHome = join(dir, 'home')
mkdirSync(join(routerHome, '.router'), { recursive: true })
writeFileSync(join(routerHome, '.router', 'config.json'), '{"secret": true}')

/** file_id -> what getFile answers with as file_path. */
const paths: Record<string, string> = {
  LOCAL: join(docs, 'file_1.txt'),
  MISSING: join(docs, 'file_2.txt'),
  DIR: docs,
  STATE: join(routerHome, '.router', 'config.json'),
  NOREAD: join(docs, 'file_4.txt'),
  REL: 'documents/file_5.txt',
}
writeFileSync(paths.NOREAD!, 'no')
chmodSync(paths.NOREAD!, 0o000)
const fileHits: string[] = []
const calls: string[] = []
function server(local: boolean) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.startsWith('/file/')) {
        fileHits.push(url.pathname)
        // --local has no /file endpoint
        return local ? new Response('Not Found', { status: 404 }) : new Response('over http\n')
      }
      const method = url.pathname.split('/').pop()!
      calls.push(method)
      // multipart (an upload) is read through, its bytes dropped
      const body = (req.headers.get('content-type') ?? '').includes('json') ? await req.json() : (await req.arrayBuffer(), {})
      if (method === 'getFile') return Response.json({ ok: true, result: { file_id: body.file_id, file_unique_id: `u${body.file_id}`, file_path: local ? paths[body.file_id] : `documents/${body.file_id}.txt` } })
      return Response.json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } })
    },
  })
}
const local = server(true), remote = server(false)
const LOCAL_ROOT = `http://127.0.0.1:${local.port}`, REMOTE_ROOT = `http://127.0.0.1:${remote.port}`

afterAll(() => {
  local.stop(true); remote.stop(true)
  try { chmodSync(paths.NOREAD!, 0o600) } catch {}
  rmSync(dir, { recursive: true, force: true })
})

function deps(apiRoot: string, extra: Partial<OutboundDeps> = {}): OutboundDeps {
  return {
    bot: new Bot(TOKEN, { client: { apiRoot } }), token: TOKEN, inboxDir: join(dir, 'inbox'), store: openStore(':memory:').forBot('cc'),
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: {} }),
    assertAllowedChat: () => {}, assertSendable: () => {},
    apiRoot, forbidden: [join(routerHome, '.router'), routerHome], ...extra,
  }
}
const download = (file_id: string, d: OutboundDeps) => callTool('download_attachment', { file_id }, d)
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text

test('config: apiRoot per bot, else the config\'s, else the official one; trailing / dropped; a wrong one warned and left out; localFilesDir absolute only; a credential\'s own apiRoot', () => {
  const p = join(dir, 'config.json')
  writeFileSync(p, JSON.stringify({
    apiRoot: 'http://127.0.0.1:8081/',
    bots: [{ name: 'a', token: '1:a', apiRoot: 'http://127.0.0.1:9000//', localFilesDir: '/var/lib/telegram-bot-api' }, { name: 'b', token: '2:b' }, { name: 'c', token: '3:c', apiRoot: 'not a url', localFilesDir: 'relative/dir' }],
  }))
  const cfg = loadConfig(p)
  expect(cfg.apiRoot).toBe('http://127.0.0.1:8081')
  expect(cfg.bots[0]).toEqual({ name: 'a', token: '1:a', apiRoot: 'http://127.0.0.1:9000', localFilesDir: '/var/lib/telegram-bot-api' })
  expect(botApiRoot(cfg, 'a')).toBe('http://127.0.0.1:9000')
  expect(botApiRoot(cfg, 'b')).toBe('http://127.0.0.1:8081')
  expect(botApiRoot(cfg, 'c')).toBe('http://127.0.0.1:8081')
  expect(cfg.bots[2]).toEqual({ name: 'c', token: '3:c' })
  expect(cfg.warnings!.join('\n')).toContain('bots[c].apiRoot 要是 http(s) 網址')
  expect(cfg.warnings!.join('\n')).toContain('bots[c].localFilesDir 要是絕對路徑')
  expect(credApiRoot(cfg, { apiRoot: 'http://127.0.0.1:7000/' })).toBe('http://127.0.0.1:7000')
  expect(credApiRoot(cfg, {})).toBe('http://127.0.0.1:8081')
  writeFileSync(p, JSON.stringify({ apiRoot: 'ftp://x', bots: [{ name: 'a', token: '1:a' }] }))
  const off = loadConfig(p)
  expect(off.apiRoot).toBeUndefined()
  expect(botApiRoot(off, 'a')).toBe(OFFICIAL_API_ROOT)
  expect(credApiRoot(off, undefined)).toBe(OFFICIAL_API_ROOT)
  expect(off.warnings!.join('\n')).toContain('apiRoot 要是 http(s) 網址, 收到 "ftp://x"; 改用官方 Bot API')
})

test('the official server is told by its host; uploads: 50 MB there, 2000 MB on any other', () => {
  expect(isOfficialApi(undefined)).toBe(true)
  expect(isOfficialApi('https://api.telegram.org')).toBe(true)
  expect(isOfficialApi('https://API.telegram.org/')).toBe(true)
  expect(isOfficialApi('http://127.0.0.1:8081')).toBe(false)
  expect(uploadLimit(undefined)).toBe(OFFICIAL_UPLOAD_BYTES)
  expect(uploadLimit('https://api.telegram.org')).toBe(50 * 1024 * 1024)
  expect(uploadLimit('http://127.0.0.1:8081')).toBe(LOCAL_UPLOAD_BYTES)
  expect(LOCAL_UPLOAD_BYTES).toBe(2000 * 1024 * 1024)
  expect(shownPath(paths.LOCAL!)).toBe('documents/file_1.txt')
  expect(shownPath('photos/file_0.jpg')).toBe('photos/file_0.jpg')
})

test('--local: download_attachment reads the absolute path from disk, never asks /file; the token is nowhere in what comes back', async () => {
  fileHits.length = 0
  const r = await download('LOCAL', deps(LOCAL_ROOT))
  expect(r.isError).toBeFalsy()
  const path = text(r)
  expect(path).toStartWith(join(dir, 'inbox'))
  expect(path).toEndWith('.txt')
  expect(path).not.toContain(TOKEN)
  expect(readFileSync(path, 'utf8')).toBe('hello from the local server\n')
  expect(fileHits).toEqual([])
  // what rawvault and router.db get: the last two parts, not the server's folders
  const got = await fetchBotFile({ getFile: id => deps(LOCAL_ROOT).bot.api.getFile(id), token: TOKEN, apiRoot: LOCAL_ROOT }, 'LOCAL')
  expect(got.file_path).toBe('documents/file_1.txt')
  expect(got.file_unique_id).toBe('uLOCAL')
})

test('--local: missing, not a regular file, unreadable, in the router\'s own folders, outside localFilesDir: refused with why, the token masked', async () => {
  const d = deps(LOCAL_ROOT)
  const missing = await download('MISSING', d)
  expect(missing.isError).toBe(true)
  expect(text(missing)).toContain('不存在: router 要跟 server 在同一台')
  const isDir = await download('DIR', d)
  expect(text(isDir)).toContain('不是一般檔案, 不讀取')
  const state = await download('STATE', d)
  expect(text(state)).toContain('落在 router 自己的資料夾裡, 不讀取')
  // a symlink in the server's folder pointing at router state: judged by where it really is
  symlinkSync(paths.STATE!, join(docs, 'file_6.txt'))
  paths.LINK = join(docs, 'file_6.txt')
  expect(text(await download('LINK', d))).toContain('落在 router 自己的資料夾裡')
  const outside = await download('LOCAL', deps(LOCAL_ROOT, { localFilesDir: join(dir, 'elsewhere') }))
  expect(text(outside)).toContain(`不在這隻 bot 的 localFilesDir (${join(dir, 'elsewhere')}) 裡, 不讀取`)
  const inside = await download('LOCAL', deps(LOCAL_ROOT, { localFilesDir: serverDir }))
  expect(inside.isError).toBeFalsy()
  if (process.getuid?.() !== 0) {
    const noread = await download('NOREAD', d)
    expect(text(noread)).toContain('router 沒有讀取權限: 讓執行 router 的使用者能讀 server 的 --dir')
  }
  for (const r of [missing, isDir]) {
    expect(text(r)).not.toContain(TOKEN)
    expect(text(r)).toContain('<token>')
  }
})

test('a self-hosted server without --local (a relative file_path) and the official layout: downloaded over /file/bot<token>/<path> as before', async () => {
  fileHits.length = 0
  const r = await download('REL', deps(REMOTE_ROOT))
  expect(r.isError).toBeFalsy()
  expect(readFileSync(text(r), 'utf8')).toBe('over http\n')
  expect(fileHits).toEqual([`/file/bot${TOKEN}/documents/REL.txt`])
})

/** A file of this apparent size that takes no space (sparse): only its size is checked. */
function sparse(name: string, bytes: number): string {
  const p = join(dir, name)
  const fd = openSync(p, 'w')
  ftruncateSync(fd, bytes)
  closeSync(fd)
  return p
}

test('upload limit: 51 MB is refused on the official server and goes to a self-hosted one; over 2000 MB is refused there too, before anything is sent', async () => {
  const mb51 = sparse('big.pdf', 51 * 1024 * 1024)
  const over = sparse('huge.pdf', LOCAL_UPLOAD_BYTES + 1)
  const official = deps('https://api.telegram.org')
  // never sent: the official server is not reached in this test
  official.bot = new Bot(TOKEN, { client: { apiRoot: REMOTE_ROOT } })
  calls.length = 0
  const r1 = await callTool('reply', { chat_id: '1', text: 'x', files: [mb51] }, official)
  expect(r1.isError).toBe(true)
  expect(text(r1)).toContain('max 50MB')
  const s1 = await callTool('send_sticker', { chat_id: '1', file: mb51 }, official)
  expect(text(s1)).toContain('max 50MB')
  const r2 = await callTool('reply', { chat_id: '1', text: 'x', files: [over] }, deps(LOCAL_ROOT))
  expect(r2.isError).toBe(true)
  expect(text(r2)).toContain('max 2000MB')
  expect(calls).toEqual([])
  const r3 = await callTool('reply', { chat_id: '1', text: 'x', files: [mb51] }, deps(LOCAL_ROOT))
  expect(r3.isError, text(r3)).toBeFalsy()
  expect(calls).toEqual(['sendDocument'])
}, 30000)
