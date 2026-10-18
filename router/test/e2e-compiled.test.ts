// The compiled router (docs/credentials-and-skills.md 「試跑技能草稿」, plan of
// deploy/install.sh router): built with `bun build --compile` into a state dir
// with its templates, started the way the systemd unit starts it (no
// --config: config.json next to the executable; working directory the state
// dir; the unit's PATH, without /usr/sbin where nft lives), against a fake Bot
// API. An owner conversation's worker plugin calls skill_try on the guide's
// example: the sandbox starts the fake service with the router's own
// executable (`cc-telegram-router skilltry-fake`), since a compiled program's
// own source files are not on disk (/$bunfs/root); the action runs, the fake
// service gets its calls, the run is recorded. 2.17.0 failed exactly here in
// production while the tests run from source passed. Also router/selfpath.ts.
// The bot has its own apiRoot, a fake self-hosted server in --local mode
// (docs/operations.md 「自架 Bot API server」): the config's apiRoot is never
// reached, and download_attachment reads the absolute path getFile gives
// from disk (from source in e2e-localapi.test.ts). The setup wizard
// (`cc-telegram-router --config <path> setup`) in the compiled router: no
// terminal, refused; in a pseudo terminal, a new config with the token as *
// only (from source in e2e-wizard.test.ts).

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'
import { relaunchArgs, ownArgs, fakeService, FAKE_SUBCOMMAND } from '../selfpath'
import { inTerminal } from './pty'

const ROOT = join(import.meta.dir, '..', '..')
const GUIDE = readFileSync(join(ROOT, 'plugin', 'skills', 'bot-skill', 'SKILL.md'), 'utf8')
const EXAMPLE: Record<string, string> = Object.fromEntries([...GUIDE.matchAll(/^`skills\/signup\/([^`]+)`:\n\n```\w*\n([\s\S]*?)\n```$/gm)].map(m => [m[1]!, `${m[2]!}\n`]))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const dir = mkdtempSync(join(tmpdir(), 'cctr-compiled-'))
const state = join(dir, '.router')
const now = Math.floor(Date.now() / 1000)
const updates: unknown[] = []
// the server's --dir, outside the router's home
const serverDir = mkdtempSync(join(tmpdir(), 'cctr-compiled-tgserver-'))
mkdirSync(join(serverDir, '123:test', 'documents'), { recursive: true })
writeFileSync(join(serverDir, '123:test', 'documents', 'file_7.pdf'), '%PDF compiled')
const fileHits: string[] = []
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/file/')) { fileHits.push(url.pathname); return new Response('Not Found', { status: 404 }) }
    const method = url.pathname.split('/').pop()!
    const ok = (result: unknown) => Response.json({ ok: true, result })
    if (method === 'getFile') return ok({ file_id: 'PDF', file_unique_id: 'uPDF', file_path: join(serverDir, '123:test', 'documents', 'file_7.pdf') })
    if (method === 'getMe') return ok({ id: 123, is_bot: true, first_name: 'cc', username: 'cc_bot' })
    if (method === 'getUpdates') { await sleep(100); return ok(updates.splice(0)) }
    if (method === 'sendMessage') return ok({ message_id: 900, date: now, chat: { id: 555 }, text: '' })
    return ok(true)
  },
})
// the config's apiRoot: a bot with its own never goes here
const unused: string[] = []
const globalApi = Bun.serve({ port: 0, fetch(req) { unused.push(new URL(req.url).pathname); return Response.json({ ok: false, error_code: 404, description: 'Not Found' }) } })
let router: ReturnType<typeof Bun.spawn> | null = null
let stderr = ''

async function until<T>(fn: () => T | undefined | false, ms = 15000): Promise<T> {
  for (let t = 0; t < ms; t += 50) { try { const v = fn(); if (v) return v } catch {} await sleep(50) }
  throw new Error(`timed out; router stderr:\n${stderr.slice(-2000)}`)
}
const q = (sql: string) => { const db = new Database(join(state, 'router.db'), { readonly: true }); try { return db.query(sql).all() as any[] } finally { db.close() } }

beforeAll(async () => {
  mkdirSync(state, { recursive: true, mode: 0o700 })
  // what deploy/install.sh router does: the executable and the templates in the state dir
  const build = Bun.spawnSync(['bun', 'build', '--compile', join(ROOT, 'router', 'main.ts'), '--outfile', join(state, 'cc-telegram-router')], { stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(build.stderr.toString())
  cpSync(join(ROOT, 'templates'), join(state, 'templates'), { recursive: true })
  const fakeClaude = join(dir, 'fake-claude')
  writeFileSync(fakeClaude, `#!/bin/bash\ncase "$*" in *agents*) echo '[]' ;; *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;; esac\n`)
  chmodSync(fakeClaude, 0o755)
  writeFileSync(join(state, 'config.json'), JSON.stringify({ bots: [{ name: 'cc', token: '123:test', apiRoot: `http://127.0.0.1:${api.port}`, localFilesDir: serverDir }], home: dir, stateDir: state, owners: ['555'], claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${globalApi.port}` }), { mode: 0o600 })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['555'], groups: {}, pending: {} }))
  // as deploy/cc-telegram-router.service starts it
  const home = process.env.HOME!
  router = Bun.spawn([join(state, 'cc-telegram-router')], { cwd: state, env: { HOME: home, PATH: `${home}/.local/bin:${home}/bin:/usr/local/bin:/usr/bin:/bin` }, stdout: 'ignore', stderr: 'pipe' })
  void (async () => { for await (const c of router!.stderr as ReadableStream<Uint8Array>) stderr += new TextDecoder().decode(c) })()
}, 120_000)

afterAll(async () => {
  router?.kill('SIGTERM')
  await router?.exited
  api.stop(true)
  globalApi.stop(true)
  rmSync(dir, { recursive: true, force: true })
  rmSync(serverDir, { recursive: true, force: true })
})

test('router/selfpath.ts: compiled, the fake service is the router itself with a subcommand; from source, bun and the script; arguments past the virtual entry point', () => {
  expect(fakeService(true, '/srv/r/cc-telegram-router', '/$bunfs/root')).toEqual({ cmd: ['/srv/r/cc-telegram-router', FAKE_SUBCOMMAND], ro: ['/srv/r/cc-telegram-router'] })
  expect(fakeService(false, '/usr/bin/bun', '/repo/router')).toEqual({ cmd: ['/usr/bin/bun', '/repo/router/skilltry-fake.ts'], ro: ['/usr/bin/bun', '/repo/router/skilltry-fake.ts'] })
  expect(relaunchArgs(['bun', '/$bunfs/root/cc-telegram-router', '--config', 'x'])).toEqual(['--config', 'x'])
  expect(relaunchArgs(['/usr/bin/bun', '/repo/router/main.ts', '--config', 'x'])).toEqual(['/repo/router/main.ts', '--config', 'x'])
  expect(ownArgs(['bun', '/$bunfs/root/cc-telegram-router', 'skilltry-fake', 'log'])).toEqual(['skilltry-fake', 'log'])
})

test('the compiled router, started as the systemd unit starts it, runs skill_try on the guide\'s example for an owner conversation; the bot\'s own --local Bot API server: download_attachment from disk', async () => {
  updates.push({ update_id: 1, message: { message_id: 1, date: now, chat: { id: 555, type: 'private' }, from: { id: 555, is_bot: false, first_name: 'Boss' }, text: '嗨' } })
  await until(() => q("SELECT key FROM conversations WHERE key = 'dm-555'")[0])
  const folder = join(dir, 'bot123', 'dm-555')
  for (const [rel, text] of Object.entries(EXAMPLE)) { mkdirSync(join(folder, 'skills', 'signup', rel, '..'), { recursive: true }); writeFileSync(join(folder, 'skills', 'signup', rel), text) }
  const plugin = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: folder, pid: 77 }, onMessage(m) { if (m.t === 'deliver') plugin.send({ t: 'ack', qid: m.qid }) } })
  await until(() => plugin.state().kind === 'ready')
  const r = await plugin.call('skill_try', { path: 'skills/signup', action: 'join', args: { name: '小明' } })
  const text = r.content[0]!.text
  expect(text, text).toStartWith('skill try: ok')
  expect(text).toContain('小明 報名成功, 目前 1 人 (這次活動)')
  expect(text).toContain('- GET /http/EVENTS/v1/events/current (0 bytes)')
  expect(text).toMatch(/- POST \/bot<已遮蔽>\/sendMessage/)
  expect(text).not.toContain('讀不到')
  expect(q("SELECT status FROM skill_runs WHERE conv = 'try:dm-555'").map(x => x.status)).toEqual(['ok'])
  // --local: the attachment comes from the server's disk, not over /file
  const dl = await plugin.call('download_attachment', { file_id: 'PDF' })
  expect(dl.isError, dl.content[0]!.text).toBeFalsy()
  expect(readFileSync(dl.content[0]!.text, 'utf8')).toBe('%PDF compiled')
  expect(fileHits).toEqual([])
  expect(unused).toEqual([])
  plugin.close()
}, 120_000)

test.skipIf(!Bun.which('script'))('the compiled router\'s setup wizard: no terminal, refused; in a terminal, a new config whose token shows as * only, checked on the self-hosted server', async () => {
  const exe = join(state, 'cc-telegram-router')
  const other = join(dir, 'wizard', '.router', 'config.json')
  const no = Bun.spawn([exe, '--config', other, 'setup'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  no.stdin.end()
  expect(await no.exited).toBe(2)
  expect(await new Response(no.stderr).text()).toContain('要在終端機執行 (這裡沒有 TTY)')
  const token = `321:${'W'.repeat(35)}`
  const t = inTerminal([exe, '--config', other, 'setup'])
  for (const [prompt, keys] of [['router 的家目錄 home', '\r'], ['owner 的 Telegram uid', '555\r'], ['worker 用的模型 model', '\r'], ['claude 執行檔 claudeBin', '\r'], ['名稱', '\r'], ['bot token', `${token}\r`], ['Bot API: 1) 官方', '2\r'], ['Bot API server 的網址', `http://127.0.0.1:${api.port}\r`], ['server 的 --dir', '\r'], ['要再加一隻 bot 嗎?', '\r'], ['寫入 ', '\r']] as const) await t.answer(prompt, keys)
  t.close()
  expect(await t.exited).toBe(0)
  expect(t.out).toContain('*'.repeat(token.length))
  expect(t.out).not.toContain(token)
  expect(JSON.parse(readFileSync(other, 'utf8')).bots).toEqual([{ name: 'cc', token, apiRoot: `http://127.0.0.1:${api.port}` }])
  expect(JSON.parse(readFileSync(join(dir, 'wizard', '.router', 'access.json'), 'utf8')).allowFrom).toEqual(['555'])
}, 60000)
