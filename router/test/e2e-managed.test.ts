// docs/managed-channel.md end to end: the real router, a fake Bot API, the fake
// claude of e2e-wake (its workers real processes on the router socket), and in
// place of the toolbox's static bwrap a stand-in that makes the same mount
// namespace with the system's bwrap (tmpfs /etc with every entry bound back,
// the managed folder at /etc/claude-code, /etc read-only), so the namespace and
// /proc/<pid>/root are real. Started on a router.db with a conversation and its
// session, and a user config folder (CLAUDE_CONFIG_DIR) holding its transcript
// and a job of it. Covers:
//   - managed mode: the start notice says so; the transcript is copied into
//     <stateDir>/claude-config, the old job removed with the user's own claude;
//     the router's daemon runs in the namespace and sees the managed settings
//   - every claude the router runs goes through bwrap, with the router's config
//     folder, the user's for the login, and no TELEGRAM_*; inside, the router's
//     sessions/ is the user's (the shared session registry); the worker resumes
//     the same session with plugin:telegram@cc-telegram-router and the local
//     marketplace in its settings, and gets the message
//   - a daemon outside the namespace: stopped, started again in it, the owner told
//   - cli doctor through the router: the mode, bwrap, the daemon
//   - managed agents and attach from the terminal through bwrap (attach takes a
//     conversation key); config managed.shareSessions false: no registry bind
//   - degraded: a bwrap that cannot make the namespace puts a second router in
//     legacy mode, the reason in its start notice
// Module level: managed.test.ts.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { openRouterDb } from '../db'
import { ensureConversation } from '../conversations'

const dir = mkdtempSync(join(tmpdir(), 'cctr-managed-e2e-'))
const state = join(dir, '.router')
const userCfg = join(dir, 'user-claude')
mkdirSync(state)
const FAKE = join(dir, 'fake-state.json')
const ENVLOG = join(dir, 'env.log')
const BWLOG = join(dir, 'bwrap.log')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const sha = (b: string) => createHash('sha256').update(b).digest('hex')

// --- fake Bot API ------------------------------------------------------------
const pending: unknown[] = []
const sent: Array<{ token: string; chat_id: string; text: string }> = []
const now = Math.floor(Date.now() / 1000)
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const parts = new URL(req.url).pathname.split('/')
    const method = parts.pop()!
    const token = parts.pop()!.replace(/^bot/, '')
    const ok = (result: unknown) => Response.json({ ok: true, result })
    if (method === 'getMe') return ok({ id: Number(token.split(':')[0]), is_bot: true, first_name: 'cc', username: `cc${token.split(':')[0]}_bot` })
    if (method === 'getUpdates') { await sleep(100); return ok(token.startsWith('123:') ? pending.splice(0) : []) }
    if (method === 'sendMessage') { const b = await req.json() as any; sent.push({ token, chat_id: String(b.chat_id), text: String(b.text) }); return ok({ message_id: 9000 + sent.length, date: now, chat: { id: Number(b.chat_id) }, text: b.text }) }
    return ok(true)
  },
})

// --- the stand-in for the static bwrap: logs its arguments, makes the namespace with the system's bwrap ---
function putBwrap(stateDir: string, script: string) {
  const host = join(stateDir, 'toolbox', 'host')
  mkdirSync(host, { recursive: true })
  writeFileSync(join(host, 'bwrap'), script)
  chmodSync(join(host, 'bwrap'), 0o755)
  writeFileSync(join(stateDir, 'toolbox', 'installed.json'), JSON.stringify({ bwrap: { version: '0.13.1', bins: { bwrap: sha(script) }, host: true } }))
}
putBwrap(state, `#!/bin/bash
echo "$*" >> '${BWLOG}'
managed=""; extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    --ro-bind) [ "$3" = /etc/claude-code ] && managed="$2"; shift 3 ;;
    --bind) [ "$2" != / ] && extra+=(--bind "$2" "$3"); shift 3 ;;
    --dev-bind) shift 3 ;;
    --overlay-src|--tmp-overlay|--remount-ro) shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
a=(--bind / / --dev-bind /dev /dev --tmpfs /etc)
for p in /etc/* /etc/.[!.]*; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  if [ -L "$p" ]; then a+=(--symlink "$(readlink "$p")" "$p"); else a+=(--bind "$p" "$p"); fi
done
exec bwrap "\${a[@]}" --ro-bind "$managed" /etc/claude-code --remount-ro /etc "\${extra[@]}" -- "$@"
`)

// --- before: a conversation with its session; the user's config folder with its transcript and a job ---
const cfgLite = { bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state } as any
let folder = ''
{
  const db = openRouterDb(join(state, 'router.db'))
  db.updateBotSetup('cc', { persona_done: 1, group_skipped: 1, bot_id: '123' })
  const c = ensureConversation(cfgLite, db, 'cc', '666', 'private', () => {})
  folder = c.folder
  db.setSession(c.key, '66666666-6666-6666-6666-666666666666')
  db.close()
}
const SESSION = '66666666-6666-6666-6666-666666666666'
const store = (root: string) => join(root, 'projects', folder.replace(/[/.]/g, '-'))
mkdirSync(join(store(userCfg), SESSION, 'tool-results'), { recursive: true })
writeFileSync(join(store(userCfg), `${SESSION}.jsonl`), '{"type":"user","message":"before the switch"}\n')
writeFileSync(join(store(userCfg), SESSION, 'tool-results', 'big.txt'), 'a tool result')
// one of the user's own sessions in their registry (docs/managed-channel.md 「共用 session 名冊」)
mkdirSync(join(userCfg, 'sessions'), { recursive: true })
writeFileSync(join(userCfg, 'sessions', '999999.json'), JSON.stringify({ pid: 999999, name: 'owner-terminal', kind: 'interactive' }))
mkdirSync(join(userCfg, 'jobs', 'old66666'), { recursive: true })
writeFileSync(join(userCfg, 'jobs', 'old66666', 'state.json'), JSON.stringify({ name: 'tg-dm-666', cwd: folder, sessionId: SESSION, state: 'done' }))

writeFileSync(join(state, 'config.json'), JSON.stringify({
  bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: ['555'],
  claudeBin: join(import.meta.dir, 'fixtures', 'fake-claude.ts'), apiRoot: `http://127.0.0.1:${api.port}`,
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['555', '666'], groups: {}, pending: {} }))
const ENV = { ...process.env, FAKE_STATE: FAKE, FAKE_SOCKET: join(state, 'router.sock'), FAKE_ENV_LOG: ENVLOG, CLAUDE_CONFIG_DIR: userCfg, TELEGRAM_BOT_TOKEN: 'must-not-reach-claude' }
const router = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { env: ENV, stdout: 'ignore', stderr: 'pipe' })
let stderr = ''
void (async () => { for await (const c of router.stderr) stderr += new TextDecoder().decode(c) })()
const procs: number[] = []

afterAll(async () => {
  router.kill('SIGTERM'); await router.exited
  for (const j of jobs()) if (j.pid) try { process.kill(j.pid) } catch {}
  const st = status()
  if (st) try { process.kill(st.supervisorPid) } catch {}
  for (const p of procs) try { process.kill(p) } catch {}
  api.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

const lines = (f: string) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []
const envCalls = () => lines(ENVLOG).map(l => JSON.parse(l) as { args: string[]; config: string | null; secure: string | null; managed: boolean; telegram: string[]; sessions: string[] })
const deliveries = () => lines(FAKE + '.deliveries').map(l => JSON.parse(l) as { dir: string; content: string })
const configDir = join(state, 'claude-config')
const status = (): { supervisorPid: number } | null => { try { return JSON.parse(readFileSync(join(configDir, 'daemon.status.json'), 'utf8')) } catch { return null } }
const sees = (pid: number) => { try { return readFileSync(`/proc/${pid}/root/etc/claude-code/managed-settings.json`, 'utf8') } catch { return null } }
function jobs(): Array<{ id: string; cwd: string; pid: number | null }> {
  const d = FAKE + '.jobs'
  return existsSync(d) ? readdirSync(d).map(f => JSON.parse(readFileSync(join(d, f), 'utf8'))) : []
}
async function until<T>(fn: () => T | undefined | false | null, ms = 20000): Promise<T> {
  for (let t = 0; t < ms; t += 100) { try { const v = fn(); if (v) return v } catch {} await sleep(100) }
  throw new Error('timed out')
}
const MANAGED = JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: [{ marketplace: 'cc-telegram-router', plugin: 'telegram' }] }, null, 2) + '\n'

test('managed start: said in the start notice; the transcript copied, the old job removed with the user\'s own claude; the router\'s daemon inside the namespace', async () => {
  const hello = await until(() => sent.find(s => s.text.startsWith('🟢 cc-telegram-router')))
  expect(hello.text).toContain('channel 模式: managed')
  expect(readFileSync(join(state, 'managed', 'managed-settings.json'), 'utf8')).toBe(MANAGED)
  expect(readFileSync(join(store(configDir), `${SESSION}.jsonl`), 'utf8')).toBe('{"type":"user","message":"before the switch"}\n')
  expect(readFileSync(join(store(configDir), SESSION, 'tool-results', 'big.txt'), 'utf8')).toBe('a tool result')
  expect(existsSync(join(store(userCfg), `${SESSION}.jsonl`))).toBe(true)
  expect(JSON.parse(readFileSync(join(configDir, 'migrated.json'), 'utf8')).copied).toEqual([{ key: 'dm-666', session: SESSION }])
  const old = envCalls().filter(c => c.args[1] === 'old66666')
  expect(old.map(c => c.args.join(' '))).toEqual(['stop old66666', 'rm old66666'])
  expect(old.every(c => c.config === userCfg && !c.managed)).toBe(true)
  // the config folder made ready
  expect(JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')).skipDangerousModePermissionPrompt).toBe(true)
  expect(JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')).projects[dir].hasTrustDialogAccepted).toBe(true)
  // the daemon: started by the router through bwrap, sees the managed settings
  const st = await until(() => status())
  expect(await until(() => sees(st.supervisorPid))).toBe(MANAGED)
  expect(sees(process.pid)).toBeNull()
  const run = envCalls().find(c => c.args[0] === 'daemon' && c.args[1] === 'run')!
  expect(run).toMatchObject({ config: configDir, secure: userCfg, managed: true, telegram: [] })
}, 30000)

test('a message: the worker resumes the same session in the namespace with the router\'s own plugin, every claude through bwrap', async () => {
  pending.push({ update_id: 1, message: { message_id: 1, date: now, chat: { id: 666, type: 'private' }, from: { id: 666, is_bot: false, first_name: 'U' }, text: 'after the switch' } })
  const d = await until(() => deliveries().find(x => x.content.endsWith('after the switch')))
  expect(d.dir).toBe(folder)
  const bg = envCalls().find(c => c.args[0] === '--bg')!
  expect(bg.args.slice(0, 3)).toEqual(['--bg', '--resume', SESSION])
  expect(bg.args.join(' ')).toContain('--channels plugin:telegram@cc-telegram-router')
  expect(bg).toMatchObject({ config: configDir, secure: userCfg, managed: true, telegram: [] })
  // every claude of the router's own (not the migration's stop/rm in the user's folder) saw the managed settings
  const ours = envCalls().filter(c => c.args[1] !== 'old66666')
  expect(ours.length).toBeGreaterThan(2)
  expect(ours.filter(c => !c.managed || c.config !== configDir)).toEqual([])
  for (const l of lines(BWLOG)) expect(l).toStartWith(`--bind / / --dev-bind /dev /dev --overlay-src /etc --tmp-overlay /etc --ro-bind ${join(state, 'managed')} /etc/claude-code --remount-ro /etc --bind ${join(userCfg, 'sessions')} ${join(configDir, 'sessions')} -- `)
  // the shared session registry: inside the namespace the router's config folder has the user's sessions
  expect(bg.sessions).toContain('999999.json')
  expect(existsSync(join(configDir, 'sessions', '999999.json'))).toBe(false) // outside, the router's own folder stays empty
  const settings = JSON.parse(readFileSync(join(state, 'sessions', 'dm-666.json'), 'utf8'))
  expect(settings.enabledPlugins).toEqual({ 'telegram@cc-telegram-router': true })
  expect(settings.extraKnownMarketplaces['cc-telegram-router'].source).toEqual({ source: 'directory', path: join(state, 'marketplace') })
  expect(JSON.stringify(settings.permissions.allow)).not.toContain(join(userCfg, 'projects'))
  // the worker is in the daemon's roster and in the namespace
  const job = jobs().find(j => j.cwd === folder && j.pid)!
  expect(sees(job.pid!)).toBe(MANAGED)
}, 30000)

test('a daemon outside the namespace: before the next wake it is stopped and started again inside, the owner told', async () => {
  const st = status()!
  try { process.kill(st.supervisorPid, 'SIGTERM') } catch {}
  for (const j of jobs()) if (j.pid) try { process.kill(j.pid) } catch {}
  // a daemon somebody started outside bwrap with the router's config folder (orphaned, so init reaps it)
  const out = Bun.spawnSync(['bash', '-c', 'sleep 300 >/dev/null 2>&1 & echo $!']).stdout.toString().trim()
  const outside = Number(out)
  procs.push(outside)
  writeFileSync(join(configDir, 'daemon.status.json'), JSON.stringify({ supervisorPid: outside, workers: {} }))
  writeFileSync(join(configDir, 'daemon', 'roster.json'), JSON.stringify({ supervisorPid: outside, workers: {} }))
  await until(() => !existsSync(`/proc/${jobs().find(j => j.cwd === folder)?.pid}`) || undefined)
  const before = sent.length
  pending.push({ update_id: 2, message: { message_id: 2, date: now, chat: { id: 666, type: 'private' }, from: { id: 666, is_bot: false, first_name: 'U' }, text: 'woken again' } })
  const told = await until(() => sent.slice(before).find(s => s.text.includes('看不到 managed settings')))
  expect(told.text).toContain(`pid ${outside}`)
  expect(told.text).toContain('已停掉並在 bwrap 裡重新啟動 daemon')
  expect(existsSync(`/proc/${outside}`)).toBe(false)
  const now2 = await until(() => status()?.supervisorPid !== outside && status())
  expect(sees(now2.supervisorPid)).toBe(MANAGED)
  await until(() => deliveries().find(x => x.content.endsWith('woken again')))
  expect(stderr).toContain(`daemon (pid ${outside}) cannot see /etc/claude-code/managed-settings.json; stopping daemon ${outside}`)
}, 40000)

test('cli doctor through the router: the mode, bwrap and the daemon\'s check', async () => {
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json'), 'cli', 'doctor'], { env: ENV, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  expect(out).toContain('✅ channel 模式: managed')
  expect(out).toContain(`✅ bwrap ${join(state, 'toolbox', 'host', 'bwrap')} (sha256 與工具箱安裝時相同), 設定目錄 ${configDir}`)
  expect(out).toMatch(/✅ router 的 claude daemon \(pid \d+\) 與 \d+ 個 worker 都看得到 managed settings/)
  expect(out).toContain(`✅ home ${dir} 已被 Claude Code 信任 (它自己)`)
  expect(out).not.toContain('不是由 router 帶起')
}, 30000)

test('managed agents and attach from the terminal: through bwrap with the router\'s config folder; attach takes the conversation key; with shareSessions off no registry bind; managed alone lists the subcommands', async () => {
  const cli = async (args: string[], cfgFile = join(state, 'config.json')) => {
    const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', cfgFile, ...args], { env: ENV, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()]
    return { code: await p.exited, out, err }
  }
  const before = envCalls().length
  const a = await cli(['managed', 'agents', '--json', '--all'])
  expect(a.code).toBe(0)
  expect(JSON.parse(a.out).some((j: any) => j.name === 'tg-dm-666')).toBe(true)
  const call = envCalls().slice(before).find(c => c.args[0] === 'agents')!
  expect(call).toMatchObject({ args: ['agents', '--json', '--all'], config: configDir, secure: userCfg, managed: true })
  const job = jobs().find(j => j.cwd === folder && j.pid)!
  const t = await cli(['managed', 'attach', 'dm-666'])
  expect(t.code).toBe(0)
  expect(envCalls().slice(before).find(c => c.args[0] === 'attach')).toMatchObject({ args: ['attach', job.id], config: configDir, managed: true })
  expect(lines(BWLOG).at(-1)).toContain(`--bind ${join(userCfg, 'sessions')} ${join(configDir, 'sessions')} -- `)
  // config managed.shareSessions false: the same router state without the registry bind
  const off = join(dir, 'config-noshare.json')
  writeFileSync(off, JSON.stringify({ ...JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')), managed: { shareSessions: false } }))
  const n = lines(BWLOG).length
  expect((await cli(['managed', 'agents'], off)).code).toBe(0)
  const newer = lines(BWLOG).slice(n)
  expect(newer.length).toBeGreaterThan(0)
  for (const l of newer) expect(l).not.toContain('sessions')
  const u = await cli(['managed'])
  expect(u.code).toBe(0)
  expect(u.err).toContain('用法: cc-telegram-router [--config <路徑>] managed <子指令>')
  expect((await cli(['managed', 'nope'])).code).toBe(2)
}, 60000)

test('degraded: a bwrap that cannot make the namespace puts the router in legacy mode, the reason in its start notice', async () => {
  const state2 = join(dir, 'state2')
  mkdirSync(state2)
  putBwrap(state2, '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n')
  writeFileSync(join(state2, 'config.json'), JSON.stringify({
    bots: [{ name: 'two', token: '456:test' }], home: join(dir, 'home2'), stateDir: state2, owners: ['555'],
    claudeBin: join(import.meta.dir, 'fixtures', 'fake-claude.ts'), apiRoot: `http://127.0.0.1:${api.port}`,
  }))
  writeFileSync(join(state2, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['555'], groups: {}, pending: {} }))
  const r2 = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state2, 'config.json')], { env: { ...ENV, FAKE_STATE: join(dir, 'fake2.json') }, stdout: 'ignore', stderr: 'pipe' })
  let err2 = ''
  void (async () => { for await (const c of r2.stderr) err2 += new TextDecoder().decode(c) })()
  try {
    const hello = await until(() => sent.find(s => s.token.startsWith('456:') && s.text.startsWith('🟢 cc-telegram-router')))
    expect(hello.text).toContain('channel 模式: legacy (降級: bwrap 試跑失敗')
    expect(hello.text).toContain('setting up uid map: Permission denied')
    expect(err2).toContain('channel mode: legacy')
    expect(existsSync(join(state2, 'claude-config', 'migrated.json'))).toBe(false)
    expect(existsSync(join(state2, 'claude-config', 'settings.json'))).toBe(false)
  } finally { r2.kill('SIGTERM'); await r2.exited }
}, 30000)
