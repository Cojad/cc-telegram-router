// The compiled router (docs/credentials-and-skills.md 「試跑技能草稿」, plan of
// deploy/install.sh router): built with `bun build --compile` into a state dir
// with its templates, started the way the systemd unit starts it (no
// --config: config.json next to the executable; working directory the state
// dir; the unit's PATH, without /usr/sbin where nft lives), against a fake Bot
// API. An owner conversation's worker plugin calls skill_try on the guide's
// example: the sandbox starts the fake service with the router's own
// executable (`cctr skilltry-fake`), since a compiled program's
// own source files are not on disk (/$bunfs/root); the action runs, the fake
// service gets its calls, the run is recorded. 2.17.0 failed exactly here in
// production while the tests run from source passed. Also router/selfpath.ts.
// The bot has its own apiRoot, a fake self-hosted server in --local mode
// (docs/operations.md 「自架 Bot API server」): the config's apiRoot is never
// reached, and download_attachment reads the absolute path getFile gives
// from disk (from source in e2e-localapi.test.ts). The setup wizard
// (`cctr --config <path> setup`) in the compiled router: no
// terminal, refused; in a pseudo terminal, a new config with the token as *
// only (from source in e2e-wizard.test.ts).
// And run_skill of an approved skill (docs/skill-runtime.md): the whitelisted
// file system and its own network, from the compiled router with the unit's
// PATH (nft, nsenter found outside it); a bot credential with its own
// apiRoot on the host's 127.0.0.1 is reached at 10.0.2.2 on that port. The toolbox (docs/skill-runtime.md
// 「工具箱」): the toolbox subcommand without config.json, the toolbox mounted
// for run_skill, a missing tool refused.
// The executable's name (2.33.0, README 「升級」): <state>/cctr as deploy/install.sh
// builds it; the one-router lock (router/lock.ts) still holds with that command
// line, also when started through the old name's link.

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'
import { relaunchArgs, ownArgs, fakeService, FAKE_SUBCOMMAND } from '../selfpath'
import { inTerminal } from './pty'

const ROOT = join(import.meta.dir, '..', '..')
const GUIDE = readFileSync(join(ROOT, 'plugin', 'skills', 'bot-skill', 'SKILL.md'), 'utf8')
const EXAMPLE: Record<string, string> = Object.fromEntries([...GUIDE.matchAll(/^`skills\/signup\/([^`]+)`:\n\n```\w*\n([\s\S]*?)\n```$/gm)].map(m => [m[1]!, `${m[2]!}\n`]))
const BOT_TOKEN = '4242424242:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'
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
  const build = Bun.spawnSync(['bun', 'build', '--compile', join(ROOT, 'router', 'main.ts'), '--outfile', join(state, 'cctr')], { stderr: 'pipe' })
  if (build.exitCode !== 0) throw new Error(build.stderr.toString())
  cpSync(join(ROOT, 'templates'), join(state, 'templates'), { recursive: true })
  const fakeClaude = join(dir, 'fake-claude')
  writeFileSync(fakeClaude, `#!/bin/bash\ncase "$*" in *agents*) echo '[]' ;; *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;; esac\n`)
  chmodSync(fakeClaude, 0o755)
  writeFileSync(join(state, 'config.json'), JSON.stringify({ bots: [{ name: 'cc', token: '123:test', apiRoot: `http://127.0.0.1:${api.port}`, localFilesDir: serverDir }], home: dir, stateDir: state, owners: ['555'], claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${globalApi.port}`, credentials: { 'notify-bot': { token: BOT_TOKEN, methods: [], apiRoot: `http://127.0.0.1:${api.port}` } } }), { mode: 0o600 })
  writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['555'], groups: {}, pending: {} }))
  // as deploy/cc-telegram-router.service starts it
  const home = process.env.HOME!
  router = Bun.spawn([join(state, 'cctr')], { cwd: state, env: { HOME: home, PATH: `${home}/.local/bin:${home}/bin:/usr/local/bin:/usr/bin:/bin` }, stdout: 'ignore', stderr: 'pipe' })
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
  expect(fakeService(true, '/srv/r/cctr', '/$bunfs/root')).toEqual({ cmd: ['/srv/r/cctr', FAKE_SUBCOMMAND], ro: ['/srv/r/cctr'] })
  expect(fakeService(false, '/usr/bin/bun', '/repo/router')).toEqual({ cmd: ['/usr/bin/bun', '/repo/router/skilltry-fake.ts'], ro: ['/usr/bin/bun', '/repo/router/skilltry-fake.ts'] })
  expect(relaunchArgs(['bun', '/$bunfs/root/cctr', '--config', 'x'])).toEqual(['--config', 'x'])
  expect(relaunchArgs(['/usr/bin/bun', '/repo/router/main.ts', '--config', 'x'])).toEqual(['/repo/router/main.ts', '--config', 'x'])
  expect(ownArgs(['bun', '/$bunfs/root/cctr', 'skilltry-fake', 'log'])).toEqual(['skilltry-fake', 'log'])
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

test('the compiled router is <state>/cctr, as deploy/install.sh names it; a second one on the same config.json, by that name or by the old name\'s link (install.sh link_old_name), finds the lock held: its argv[0] is cctr, not cc-telegram-router', async () => {
  const sh = readFileSync(join(ROOT, 'deploy', 'install.sh'), 'utf8')
  expect(sh).toContain('bun build --compile "$REPO/router/main.ts" --outfile "$STATE/cctr.new"')
  await until(() => existsSync(join(state, 'router.sock')))
  const cmdline = readFileSync(`/proc/${router!.pid}/cmdline`, 'utf8')
  expect(cmdline.split('\0')[0]).toBe(join(state, 'cctr'))
  expect(cmdline).not.toContain('cc-telegram-router')
  symlinkSync('cctr', join(state, 'cc-telegram-router'))
  const home = process.env.HOME!
  for (const exe of ['cctr', 'cc-telegram-router']) {
    const second = Bun.spawn([join(state, exe)], { cwd: state, env: { HOME: home, PATH: `${home}/.local/bin:${home}/bin:/usr/local/bin:/usr/bin:/bin` }, stdout: 'ignore', stderr: 'pipe' })
    const err = await new Response(second.stderr).text()
    expect(await second.exited, exe).not.toBe(0)
    expect(err, exe).toContain(`another router (pid ${router!.pid}) already holds ${join(state, 'config.json.lock')}`)
  }
  expect(readFileSync(join(state, 'config.json.lock'), 'utf8')).toBe(String(router!.pid))
  // --help on the compiled executable (and through the link): the usage, the running router untouched
  for (const exe of ['cctr', 'cc-telegram-router']) {
    const h = Bun.spawnSync([join(state, exe), '--help'], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: home } })
    expect(h.exitCode, exe).toBe(0)
    expect(h.stdout.toString()).toStartWith('用法: cctr [--config <config.json>] [<子指令> ...]\n')
  }
  expect(readFileSync(join(state, 'config.json.lock'), 'utf8')).toBe(String(router!.pid))
  // the old name runs the same build: its subcommands work through the link
  const st = Bun.spawnSync([join(state, 'cc-telegram-router'), 'toolbox', 'status', '--state', join(dir, 'link-state')], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: home } })
  expect(st.exitCode).toBe(0)
  expect(st.stdout.toString()).toContain('ffmpeg: 沒有安裝 (cctr toolbox install)')
}, 60_000)

test.skipIf(!Bun.which('script'))('the compiled router\'s setup wizard: no terminal, refused; in a terminal, a new config whose token shows as * only, checked on the self-hosted server', async () => {
  const exe = join(state, 'cctr')
  const other = join(dir, 'wizard', '.router', 'config.json')
  const no = Bun.spawn([exe, '--config', other, 'setup'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  no.stdin.end()
  expect(await no.exited).toBe(2)
  expect(await new Response(no.stderr).text()).toContain('要在終端機執行 (這裡沒有 TTY)')
  const token = `321:${'W'.repeat(35)}`
  // a temporary HOME: the wizard reads ~/.claude.json for folder trust, never this machine's
  const fakeHome = join(dir, 'wizard-home')
  mkdirSync(fakeHome, { recursive: true })
  const t = inTerminal([exe, '--config', other, 'setup'], { HOME: fakeHome })
  for (const [prompt, keys] of [['router 的家目錄 home', '\r'], ['owner 的 Telegram uid', '555\r'], ['worker 用的模型 model', '\r'], ['claude 執行檔 claudeBin', '\r'], ['名稱', '\r'], ['bot token', `${token}\r`], ['Bot API: 1) 官方', '2\r'], ['Bot API server 的網址', `http://127.0.0.1:${api.port}\r`], ['server 的 --dir', '\r'], ['要再加一隻 bot 嗎?', '\r'], ['寫入 ', '\r']] as const) await t.answer(prompt, keys)
  t.close()
  expect(await t.exited).toBe(0)
  expect(t.out).toContain('*'.repeat(token.length))
  expect(t.out).not.toContain(token)
  expect(JSON.parse(readFileSync(other, 'utf8')).bots).toEqual([{ name: 'cc', token, apiRoot: `http://127.0.0.1:${api.port}` }])
  expect(JSON.parse(readFileSync(join(dir, 'wizard', '.router', 'access.json'), 'utf8')).allowFrom).toEqual(['555'])
}, 60000)

test('the compiled router runs an approved skill (run_skill) in the whitelisted sandbox and its own network: no home, no state dir, no other conversation, nothing on the host but its Bot API\'s port for an action with bots; internet ports 80, 443, 53, 22 only', async () => {
  const folder = join(dir, 'bot123', 'dm-555')
  await until(() => q("SELECT key FROM conversations WHERE key = 'dm-555'")[0])
  writeFileSync(join(dir, 'bot123', 'other.txt'), 'other\n')
  const skill = join(dir, 'bot123', '.claude', 'skills', 'probe')
  mkdirSync(join(skill, 'scripts'), { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: probe\ndescription: x\n---\n')
  writeFileSync(join(skill, 'scripts', 'p.sh'), `for f in ${process.env.HOME} ${state} ${join(dir, 'bot123', 'other.txt')} /home /run; do [ -e "$f" ] && echo "SEE $f" || echo "GONE $f"; done
python3 -B - <<'PY'
import socket
for h, p in [('127.0.0.1', ${api.port}), ('10.0.2.2', ${api.port}), ('203.0.113.7', 443), ('203.0.113.7', 8080)]:
    try: socket.create_connection((h, p), timeout=2.5).close(); print(h, p, 'ok')
    except (socket.timeout, TimeoutError): print(h, p, 'timeout')
    except Exception as e: print(h, p, 'refused', type(e).__name__)
PY
`)
  // bots: the router's Bot API (config apiRoot) is on the host's 127.0.0.1, like a self-hosted one
  writeFileSync(join(skill, 'scripts', 'bot.sh'), 'echo "API=$BOT_API"; python3 -B -c "import urllib.request, os; print(urllib.request.urlopen(os.environ[\'BOT_API\'] + \'/getMe\').read().decode())"\n')
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: { go: { run: ['bash', 'scripts/p.sh'] }, bot: { run: ['bash', 'scripts/bot.sh'], bots: { BOT: 'notify-bot' } } } }))
  const { openRouterDb } = await import('../db')
  const { hashSkill } = await import('../privskill')
  const db = openRouterDb(join(state, 'router.db'))
  db.approveSkill(skill, 'probe', hashSkill(skill), 'test')
  db.close()
  const plugin = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: folder, pid: 78 }, onMessage(m) { if (m.t === 'deliver') plugin.send({ t: 'ack', qid: m.qid }) } })
  await until(() => plugin.state().kind === 'ready')
  const r = await plugin.call('run_skill', { skill: 'probe', action: 'go' })
  const text = r.content[0]!.text
  expect(text, text).toStartWith('exit 0')
  for (const f of [process.env.HOME!, join(dir, 'bot123', 'other.txt'), '/home', '/run']) expect(text).toContain(`GONE ${f}\n`)
  // the state dir is gone, and its path masked in what comes back (docs/skill-runtime.md 「exit code 與輸出」)
  expect(text).toContain('GONE <router 私有路徑>\n')
  expect(text).not.toContain(state)
  expect(text).toContain(`127.0.0.1 ${api.port} refused`)
  expect(text).toContain(`10.0.2.2 ${api.port} refused`)
  expect(text).toContain('203.0.113.7 443 timeout')
  expect(text).toContain('203.0.113.7 8080 refused')
  const b = (await plugin.call('run_skill', { skill: 'probe', action: 'bot' })).content[0]!.text
  expect(b, b).toStartWith('exit 0')
  expect(b).toContain(`API=http://10.0.2.2:${api.port}/bot<已遮蔽>`)
  expect(b).toContain('"username":"cc_bot"')
  expect(b).not.toContain(BOT_TOKEN)
  expect(q("SELECT status FROM skill_runs WHERE conv = 'dm-555' AND skill = 'probe'").map(x => x.status)).toEqual(['ok', 'ok'])
  plugin.close()
}, 120_000)

test('the compiled router\'s toolbox: `toolbox status` and `toolbox install` work without config.json (a failed download only fails that tool, exit 1); run_skill finds the toolbox at /cctr/tools/bin and refuses an action whose tool is missing', async () => {
  const exe = join(state, 'cctr')
  const empty = join(dir, 'empty-mirror'); mkdirSync(empty, { recursive: true })
  const other = join(dir, 'other-state')
  const st = Bun.spawnSync([exe, 'toolbox', 'status', '--state', other], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME! } })
  expect(st.exitCode).toBe(0)
  expect(st.stdout.toString()).toContain('ffmpeg: 沒有安裝 (cctr toolbox install)')
  const ins = Bun.spawnSync([exe, 'toolbox', 'install', '--state', other, '--mirror', empty], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME! } })
  expect(ins.exitCode).toBe(1)
  expect(ins.stdout.toString()).toContain('ffmpeg 7.0.2: 失敗')
  expect(ins.stdout.toString()).toContain('uv 0.12.22: 失敗')
  // a toolbox in the router's state dir (as toolbox install leaves it), with a stand-in ffmpeg
  const box = join(state, 'toolbox')
  mkdirSync(join(box, 'bin'), { recursive: true })
  writeFileSync(join(box, 'bin', 'ffmpeg'), '#!/bin/sh\necho "toolbox ffmpeg $*"\n'); chmodSync(join(box, 'bin', 'ffmpeg'), 0o755)
  writeFileSync(join(box, 'installed.json'), JSON.stringify({ ffmpeg: { version: '7.0.2', bins: { ffmpeg: 'x' } } }))
  const skill = join(dir, 'bot123', '.claude', 'skills', 'media')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: media\ndescription: x\n---\n')
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: { cut: { run: ['ffmpeg', '-i', 'a'], tools: ['ffmpeg'] }, js: { run: ['deno', 'x'], tools: ['deno'] } } }))
  const { openRouterDb } = await import('../db')
  const { hashSkill } = await import('../privskill')
  const db = openRouterDb(join(state, 'router.db'))
  db.approveSkill(skill, 'media', hashSkill(skill), 'test')
  db.close()
  const folder = join(dir, 'bot123', 'dm-555')
  const plugin = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: folder, pid: 79 }, onMessage(m) { if (m.t === 'deliver') plugin.send({ t: 'ack', qid: m.qid }) } })
  await until(() => plugin.state().kind === 'ready')
  const cut = (await plugin.call('run_skill', { skill: 'media', action: 'cut' })).content[0]!.text
  expect(cut, cut).toBe('exit 0\ntoolbox ffmpeg -i a')
  const js = (await plugin.call('run_skill', { skill: 'media', action: 'js' })).content[0]!.text
  expect(js).toContain('工具箱缺少這個動作需要的 deno, 沒有執行')
  plugin.close()
}, 120_000)

const UV = process.env.CCTR_TEST_UV ?? Bun.which('uv') ?? null
test.skipIf(!UV || !process.env.LIVE)('LIVE=1 with uv: the compiled router builds a skill\'s Python environment from a real PyPI lock (uv\'s own Python) and runs it', async () => {
  const box = join(state, 'toolbox')
  mkdirSync(join(box, 'bin'), { recursive: true })
  cpSync(UV!, join(box, 'bin', 'uv')); chmodSync(join(box, 'bin', 'uv'), 0o755)
  const prev = JSON.parse(readFileSync(join(box, 'installed.json'), 'utf8'))
  writeFileSync(join(box, 'installed.json'), JSON.stringify({ ...prev, uv: { version: Bun.spawnSync([UV!, '--version']).stdout.toString().split(' ')[1]!.trim(), bins: { uv: 'x' } } }))
  const skill = join(dir, 'bot123', '.claude', 'skills', 'pysix')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: pysix\ndescription: x\n---\n')
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: { v: { run: ['python3', '-B', '-c', 'import six, sys; print("six", six.__version__, sys.executable)'] } } }))
  writeFileSync(join(skill, 'pyproject.toml'), '[project]\nname = "pysix"\nversion = "0"\nrequires-python = ">=3.12,<3.13"\ndependencies = ["six==1.17.0"]\n')
  expect(Bun.spawnSync([UV!, 'lock', '--quiet'], { cwd: skill, env: { PATH: '/usr/bin:/bin', HOME: dir, UV_CACHE_DIR: join(dir, 'uv-cache-host') } }).exitCode).toBe(0)
  const { openRouterDb } = await import('../db')
  const { hashSkill } = await import('../privskill')
  const db = openRouterDb(join(state, 'router.db'))
  db.approveSkill(skill, 'pysix', hashSkill(skill), 'test')
  db.close()
  const plugin = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'bot123', 'dm-555'), pid: 80 }, onMessage(m) { if (m.t === 'deliver') plugin.send({ t: 'ack', qid: m.qid }) } })
  await until(() => plugin.state().kind === 'ready')
  const v = (await plugin.call('run_skill', { skill: 'pysix', action: 'v' })).content[0]!.text
  expect(v, v).toBe('exit 0\nsix 1.17.0 /cctr/env/bin/python3')
  plugin.close()
}, 600_000)
