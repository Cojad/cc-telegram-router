// A self-hosted Bot API server end to end (docs/operations.md 「自架 Bot API
// server」): the real router from source, two bots on two fake servers.
// Bot cc has its own apiRoot, a fake telegram-bot-api in --local mode
// (getFile answers with an absolute path on disk, no /file endpoint) with
// localFilesDir; bot cc2 has none and goes to the config's apiRoot. Each
// bot's getMe and polling reach only its own server; on cc a text
// attachment checked on arrival, a photo downloaded on arrival and a
// worker's download_attachment are read from disk; reply's upload, bot_api
// self go to cc's server; a credential with its own apiRoot to that one,
// one without to the config's; /router bot rotate checks the new token on
// cc's server and keeps its apiRoot and localFilesDir in config.json.
// Module level in local-bot-api.test.ts, compiled in e2e-compiled.test.ts.
// Every token here is fake.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'

const dir = mkdtempSync(join(tmpdir(), 'cctr-e2e-localapi-'))
const state = join(dir, '.router')
mkdirSync(state)
// the server's --dir lies outside the router's home, a folder per token
const serverDir = mkdtempSync(join(tmpdir(), 'cctr-tgserver-'))
const CC = '123:test', CC2 = '456:test2'
const NEW_CC = `123:${'N'.repeat(35)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const OWNER = { id: 555, is_bot: false, first_name: 'Boss', username: 'boss' }
const now = Math.floor(Date.now() / 1000)
const onDisk = (name: string, body: string) => { const p = join(serverDir, CC, 'documents', name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); return p }
const FILES: Record<string, string> = {
  TXT: onDisk('file_1.txt', 'notes from disk\n'),
  PDF: onDisk('file_2.pdf', '%PDF from disk'),
  PHOTO: onDisk('file_3.jpg', 'jpeg bytes from disk'),
}

type Call = { server: string; method: string; token: string; body: any }
const calls: Call[] = []
const updates: Record<string, unknown[]> = { [CC]: [], [NEW_CC]: [], [CC2]: [] }
/** A fake Bot API: local = telegram-bot-api --local (absolute file_path, no /file). */
function server(name: string, local: boolean) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.startsWith('/file/')) { calls.push({ server: name, method: 'file', token: '', body: url.pathname }); return local ? new Response('Not Found', { status: 404 }) : new Response('over http') }
      const parts = url.pathname.split('/')
      const method = parts.pop()!, token = parts.pop()!.replace(/^bot/, '')
      const type = req.headers.get('content-type') ?? ''
      const body = type.includes('json') ? await req.json() : type.includes('multipart') ? Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { file: v.name, size: v.size }])) : {}
      calls.push({ server: name, method, token, body })
      const ok = (result: unknown) => Response.json({ ok: true, result })
      switch (method) {
        case 'getMe': return ok({ id: Number(token.split(':')[0]), is_bot: true, first_name: name, username: `${name}_bot` })
        case 'getUpdates': await sleep(100); return ok((updates[token] ?? []).splice(0))
        case 'getFile': return ok({ file_id: body.file_id, file_unique_id: `u${body.file_id}`, file_path: local ? FILES[body.file_id] : `documents/${body.file_id}` })
        case 'sendMessage': case 'sendDocument': return ok({ message_id: 900 + calls.length, date: now, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text })
        default: return ok(true)
      }
    },
  })
}
const local = server('local', true), global = server('global', false), credServer = server('credsrv', false)

const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash\ncase "$*" in *agents*) echo '[]' ;; *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;; esac\n`)
chmodSync(fakeClaude, 0o755)
writeFileSync(join(state, 'config.json'), JSON.stringify({
  bots: [
    { name: 'cc', token: CC, apiRoot: `http://127.0.0.1:${local.port}/`, localFilesDir: serverDir },
    { name: 'cc2', token: CC2 },
  ],
  home: dir, stateDir: state, owners: ['555'], model: 'claude-opus-5-5', claudeBin: fakeClaude,
  apiRoot: `http://127.0.0.1:${global.port}`,
  credentials: {
    far: { token: '789:far', methods: ['getMe'], apiRoot: `http://127.0.0.1:${credServer.port}` },
    near: { token: '790:near', methods: ['getMe'] },
  },
}, null, 2), { mode: 0o600 })
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['555'], groups: {}, pending: {} }))

const router = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { stdout: 'ignore', stderr: 'pipe' })
let stderr = ''
void (async () => { for await (const c of router.stderr) stderr += new TextDecoder().decode(c) })()

afterAll(async () => {
  router.kill('SIGTERM')
  await router.exited
  for (const s of [local, global, credServer]) s.stop(true)
  rmSync(dir, { recursive: true, force: true })
  rmSync(serverDir, { recursive: true, force: true })
})

async function until<T>(fn: () => T | undefined | false, ms = 10000): Promise<T> {
  for (let t = 0; t < ms; t += 50) { try { const v = fn(); if (v) return v } catch {} await sleep(50) }
  throw new Error(`timed out; router stderr:\n${stderr.slice(-2000)}`)
}
const q = (sql: string) => { const db = new Database(join(state, 'router.db'), { readonly: true }); try { return db.query(sql).all() as any[] } finally { db.close() } }
let mid = 1
const dm = (token: string, message: Record<string, unknown>) => { const id = mid++; updates[token]!.push({ update_id: id, message: { message_id: id, date: now, chat: { id: OWNER.id, type: 'private' }, from: OWNER, ...message } }); return id }
const worker = (folder: string, pid: number, delivered: any[] = []) => {
  const c = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: folder, pid }, onMessage(m) { if (m.t === 'deliver') { delivered.push(m.params); c.send({ t: 'ack', qid: m.qid }) } } })
  return c
}
const FOLDER = join(dir, 'bot123', 'dm-555')

test('each bot\'s getMe and polling go to its own server: cc to its apiRoot, cc2 to the config\'s', async () => {
  await until(() => calls.some(c => c.server === 'local' && c.method === 'getUpdates') && calls.some(c => c.server === 'global' && c.method === 'getUpdates'))
  expect(new Set(calls.filter(c => c.token === CC).map(c => c.server))).toEqual(new Set(['local']))
  expect(new Set(calls.filter(c => c.token === CC2).map(c => c.server))).toEqual(new Set(['global']))
  expect(calls.some(c => c.server === 'credsrv')).toBe(false)
}, 30000)

test('--local on cc: a text attachment checked on arrival, a photo downloaded on arrival and download_attachment are read from disk, never over /file; reply uploads to cc\'s server', async () => {
  const delivered: any[] = []
  dm(CC, { text: '嗨' })
  await until(() => q("SELECT key FROM conversations WHERE key = 'dm-555' AND bot = 'cc'")[0])
  const w = worker(FOLDER, 21, delivered)
  await until(() => w.state().kind === 'ready')
  dm(CC, { document: { file_id: 'TXT', file_unique_id: 'uTXT', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 16 } })
  await until(() => q("SELECT file_path FROM attachment_cache WHERE file_id = 'TXT'")[0])
  // router.db keeps the server's last two parts, never its folder with the token
  expect(q("SELECT file_path FROM attachment_cache WHERE file_id = 'TXT'")[0].file_path).toBe('documents/file_1.txt')
  const txt = await w.call('download_attachment', { file_id: 'TXT' })
  expect(readFileSync(txt.content[0]!.text, 'utf8')).toBe('notes from disk\n')
  dm(CC, { photo: [{ file_id: 'PHOTO', file_unique_id: 'uPHOTO', width: 1, height: 1, file_size: 20 }], caption: '看圖' })
  const photo = await until(() => delivered.find(p => p.meta?.image_path))
  expect(photo.meta.image_path).toStartWith(join(FOLDER, 'attachments'))
  expect(readFileSync(photo.meta.image_path, 'utf8')).toBe('jpeg bytes from disk')
  const pdf = await w.call('download_attachment', { file_id: 'PDF' })
  expect(pdf.isError, pdf.content[0]!.text).toBeFalsy()
  expect(readFileSync(pdf.content[0]!.text, 'utf8')).toBe('%PDF from disk')
  expect(pdf.content[0]!.text).not.toContain(CC)
  expect(calls.filter(c => c.method === 'file')).toEqual([])
  expect(new Set(calls.filter(c => c.method === 'getFile').map(c => c.server))).toEqual(new Set(['local']))
  writeFileSync(join(FOLDER, 'out.pdf'), 'to send')
  const sent = await w.call('reply', { chat_id: '555', text: '檔案', files: [join(FOLDER, 'out.pdf')] })
  expect(sent.isError, sent.content[0]!.text).toBeFalsy()
  expect(calls.filter(c => c.method === 'sendDocument').map(c => c.server)).toEqual(['local'])
  w.close()
}, 30000)

test('bot_api: self on cc\'s server; a credential with its own apiRoot on that one, one without on the config\'s', async () => {
  const w = worker(FOLDER, 22)
  await until(() => w.state().kind === 'ready')
  const before = calls.length
  for (const credential of ['self', 'far', 'near']) {
    const r = await w.call('bot_api', { credential, method: 'getMe', params: {} })
    expect(r.isError, r.content[0]!.text).toBeFalsy()
  }
  expect(calls.slice(before).filter(c => c.method === 'getMe' && c.token !== CC2).map(c => `${c.server} ${c.token}`)).toEqual([`local ${CC}`, 'credsrv 789:far', 'global 790:near'])
  w.close()
}, 30000)

test('/router bot rotate: the new token is checked on cc\'s own server, then polled there; config.json keeps its apiRoot and localFilesDir', async () => {
  dm(CC, { text: `/router bot rotate cc ${NEW_CC}` })
  await until(() => calls.some(c => c.token === NEW_CC && c.method === 'getUpdates'))
  expect(new Set(calls.filter(c => c.token === NEW_CC).map(c => c.server))).toEqual(new Set(['local']))
  const bots = JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')).bots
  expect(bots[0]).toEqual({ name: 'cc', token: NEW_CC, apiRoot: `http://127.0.0.1:${local.port}/`, localFilesDir: serverDir })
  expect(bots[1]).toEqual({ name: 'cc2', token: CC2 })
}, 30000)
