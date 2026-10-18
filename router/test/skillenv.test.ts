// A skill's Python environment and its approval (docs/skill-runtime.md 「Python 套件 (uv)」
// 「核准」, router/skillenv.ts, router/skillapprove.ts):
//   - uv.lock: PyPI packages apart from custom sources (git with its commit, URL,
//     path); the project itself left out; a git source not locked to a commit refused;
//     pyproject.toml without uv.lock (or the other way) refused
//   - with a real uv (CCTR_TEST_UV, or uv on PATH; skipped without one): the
//     environment is built in the sandbox from a local package index on the host,
//     mounted at /cctr/env, first on PATH (python3 is the environment's), reused by
//     the next run (no new download), shared by skills with the same lock; a lock
//     that does not match pyproject.toml fails the build and the run, nothing left;
//     changing uv.lock pauses an approved skill (the hash)
//   - approve: nothing to look at -> one step (with a lock: "核准中", then the
//     result, approved only once built); a medium package, a custom source, host
//     access -> a screen with a code, approved with that code (a wrong or stale code
//     refused); admin refused for host access; a build that fails is not approved
//   - skill_try: a draft's lock with a custom source or a package not judged low is
//     refused (a person looks at it on approval); no reviewer, refused
//   - the command: the code passed on; the build's result as its own message
//     from Telegram, awaited in the terminal
//   - LIVE=1 with uv: a real PyPI lock with uv's own Python (only-managed)
// Keep in sync with those sections.

import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { hashSkill } from '../privskill'
import { runSkill, type SkillRunDeps } from '../skillrun'
import { lockFiles, lockPackages, customLabel, ensureEnv, type EnvDeps } from '../skillenv'
import { approveSkill } from '../skillapprove'
import { trySkill, type SkillTryDeps } from '../skilltry'
import type { Verdict } from '../pkgreview'
import { sandboxDeps } from './fixtures/sandbox'
import { runCommand, type CommandDeps } from '../commands'
import type { Config } from '../config'

const ROOT = join(import.meta.dir, '..', '..')
const UV = process.env.CCTR_TEST_UV ?? Bun.which('uv') ?? null
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const COMMIT = `c4c4414${'a'.repeat(33)}`

// a package index on the host, as PyPI would serve one; the sandbox reaches its port at 10.0.2.2 (the fixture)
const wheels = new Map<string, Uint8Array>()
let downloads = 0
const index = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  fetch(req) {
    const p = new URL(req.url).pathname
    if (p === '/simple/cctrdemo/') return new Response(`<html><body>${[...wheels.keys()].map(f => `<a href="/files/${f}#sha256=${sha(wheels.get(f)!)}">${f}</a>`).join('')}</body></html>`, { headers: { 'content-type': 'text/html' } })
    const f = /^\/files\/(.+)$/.exec(p)?.[1]
    if (f && wheels.has(f)) { downloads++; return new Response(wheels.get(f)) }
    return new Response('not found', { status: 404 })
  },
})
afterAll(() => index.stop(true))

/** A wheel of cctrdemo <version>: cctrdemo.VALUE = "demo <version>". */
function wheel(work: string, version: string) {
  const f = `cctrdemo-${version}-py3-none-any.whl`
  const p = Bun.spawnSync(['python3', '-I', '-c', `import sys, zipfile
v = sys.argv[2]; z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('cctrdemo/__init__.py', 'VALUE = "demo %s"\\n' % v)
z.writestr('cctrdemo-%s.dist-info/METADATA' % v, 'Metadata-Version: 2.1\\nName: cctrdemo\\nVersion: %s\\n' % v)
z.writestr('cctrdemo-%s.dist-info/WHEEL' % v, 'Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
z.writestr('cctrdemo-%s.dist-info/RECORD' % v, '')
z.close()`, join(work, f), version])
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  wheels.set(f, new Uint8Array(readFileSync(join(work, f))))
}

let dir: string, db: RouterDb, deps: SkillRunDeps, conv: Conversation, toolbox: string
const env = (): EnvDeps => ({ toolbox, envRoot: deps.envRoot!, etcDir: deps.etcDir, runRoot: deps.runRoot, hostAddrs: deps.hostAddrs, isolated: deps.isolated, pythonPreference: 'only-system' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-env-'))
  mkdirSync(join(dir, 'state'), { recursive: true })
  db = openRouterDb(join(dir, 'state', 'router.db'))
  toolbox = join(dir, 'state', 'toolbox')
  mkdirSync(join(toolbox, 'bin'), { recursive: true })
  if (UV) {
    copyFileSync(UV, join(toolbox, 'bin', 'uv')); chmodSync(join(toolbox, 'bin', 'uv'), 0o755)
    const version = Bun.spawnSync([UV, '--version']).stdout.toString().split(' ')[1]!.trim()
    writeFileSync(join(toolbox, 'installed.json'), JSON.stringify({ uv: { version, bins: { uv: sha(readFileSync(UV)) } } }))
  }
  const folder = join(dir, 'home', 'bot1', 'dm-7')
  mkdirSync(join(folder, '.chat'), { recursive: true })
  conv = { key: 'dm-7', bot: 'cc', chat_id: '7', type: 'dm', folder, role: 'user', session_id: null, created_at: '' }
  deps = {
    db, home: join(dir, 'home'), credsRoot: join(dir, 'state', 'creds'), userHome: join(dir, 'fakehome'), hidden: [join(dir, 'home'), join(dir, 'state')],
    botDir: () => join(dir, 'home', 'bot1'), toolbox, envRoot: join(dir, 'state', 'skill-env'), pythonPreference: 'only-system',
    ...sandboxDeps(join(dir, 'state'), () => [index.port]),
    notifyOwner: () => {},
  }
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

/** A skill using cctrdemo <version> from the host's index: pyproject.toml and uv.lock made by the real uv. */
async function skillWith(name: string, version: string, actions?: Record<string, unknown>): Promise<string> {
  const s = join(dir, 'home', 'bot1', '.claude', 'skills', name)
  mkdirSync(s, { recursive: true })
  writeFileSync(join(s, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`)
  writeFileSync(join(s, 'privileged.json'), JSON.stringify({ actions: actions ?? { show: { run: ['python3', '-B', '-c', 'import cctrdemo, sys; print(cctrdemo.VALUE, sys.executable, sys.prefix)'] } } }))
  wheel(dir, version)
  const local = `http://127.0.0.1:${index.port}/simple`
  writeFileSync(join(s, 'pyproject.toml'), `[project]\nname = "${name}"\nversion = "0"\nrequires-python = ">=3.8"\ndependencies = ["cctrdemo==${version}"]\n\n[[tool.uv.index]]\nname = "local"\nurl = "${local}"\ndefault = true\n`)
  // async: the index answers from this very process
  const lock = Bun.spawn([UV!, 'lock', '--quiet'], { cwd: s, env: { PATH: '/usr/bin:/bin', HOME: dir, UV_CACHE_DIR: join(dir, 'uv-cache-host'), UV_PYTHON_PREFERENCE: 'only-system' }, stderr: 'pipe' })
  if (await lock.exited !== 0) throw new Error(await new Response(lock.stderr).text())
  // the sandbox reaches the index at slirp's host alias: the same URL in both files, as uv sync --locked wants
  for (const f of ['pyproject.toml', 'uv.lock']) writeFileSync(join(s, f), readFileSync(join(s, f), 'utf8').split(local.replace('/simple', '')).join(`http://10.0.2.2:${index.port}`))
  return s
}

test('uv.lock: PyPI packages apart from custom sources; the project left out; git must be locked to a commit; pyproject.toml and uv.lock go together', () => {
  const lock = `version = 1
[[package]]
name = "me"
version = "0"
source = { virtual = "." }
[[package]]
name = "numpy"
version = "2.2.6"
source = { registry = "https://pypi.org/simple" }
[[package]]
name = "yt-dlp-threads"
version = "0.1"
source = { git = "https://github.com/example/yt-dlp-threads?rev=c4c4414#${COMMIT}" }
[[package]]
name = "local"
version = "1"
source = { path = "vendor/local-1.whl" }
[[package]]
name = "mirror"
version = "1"
source = { registry = "https://mirror.example/simple" }
`
  const pkgs = lockPackages(lock) as any[]
  expect(pkgs.map(p => [p.name, p.pypi])).toEqual([['numpy', true], ['yt-dlp-threads', false], ['local', false], ['mirror', false]])
  expect(customLabel(pkgs[1])).toBe(`yt-dlp-threads 0.1 (來源 https://github.com/example/yt-dlp-threads?rev=c4c4414 commit ${COMMIT})`)
  expect(lockPackages(lock.replace(`#${COMMIT}`, ''))).toEqual({ error: 'uv.lock 裡的 yt-dlp-threads 是 git 來源但沒有鎖在完整的 commit: https://github.com/example/yt-dlp-threads?rev=c4c4414' })
  const s = join(dir, 's'); mkdirSync(s)
  expect(lockFiles(s)).toBeNull()
  writeFileSync(join(s, 'pyproject.toml'), '[project]\nname = "s"\n')
  expect(lockFiles(s)).toMatchObject({ error: expect.stringContaining('有 pyproject.toml 但沒有 uv.lock') })
})

test.skipIf(!UV)('the environment: built in the sandbox from the lock, at /cctr/env and first on PATH, reused by the next run and by a skill with the same lock; a wrong lock fails with nothing left', async () => {
  const s = await skillWith('demo', '1.0')
  db.approveSkill(s, 'demo', hashSkill(s), 'owner')
  const r = await runSkill(deps, conv, 'user', 'demo', 'show', {})
  expect(r.text, r.text).toStartWith('exit 0')
  expect(r.text).toContain('demo 1.0 /cctr/env/bin/python3 /cctr/env')
  const built = readdirSync(deps.envRoot!)
  expect(built.length).toBe(1)
  const n = downloads
  expect((await runSkill(deps, conv, 'user', 'demo', 'show', {})).text).toContain('demo 1.0')
  expect(downloads).toBe(n) // reused, nothing fetched
  // another skill, the same lock: the same environment
  const t = join(dir, 'home', 'bot1', '.claude', 'skills', 'demo2')
  mkdirSync(t, { recursive: true })
  for (const f of ['pyproject.toml', 'uv.lock', 'privileged.json', 'SKILL.md']) copyFileSync(join(s, f), join(t, f))
  expect((await ensureEnv(env(), lockFiles(t) as any)).ok).toBe(true)
  expect(readdirSync(deps.envRoot!)).toEqual(built)
  // uv.lock changed: the approved skill pauses
  writeFileSync(join(s, 'uv.lock'), `${readFileSync(join(s, 'uv.lock'), 'utf8')}\n`)
  expect((await runSkill(deps, conv, 'user', 'demo', 'show', {})).text).toContain('檔案在核准後被改過')
  // a lock that does not match pyproject.toml: uv sync --locked refuses, the run says so, nothing is left behind
  const bad = await skillWith('bad', '1.0')
  writeFileSync(join(bad, 'pyproject.toml'), readFileSync(join(bad, 'pyproject.toml'), 'utf8').replace('cctrdemo==1.0', 'cctrdemo==2.0'))
  db.approveSkill(bad, 'bad', hashSkill(bad), 'owner')
  const b = await runSkill(deps, conv, 'user', 'bad', 'show', {})
  expect(b.ok).toBe(false)
  expect(b.text).toContain('技能的 Python 環境建不起來, 沒有執行: 安裝套件 (uv sync --locked) 失敗')
  expect(readdirSync(deps.envRoot!)).toEqual(built)
  expect(readdirSync(deps.runRoot)).toEqual([])
}, 180_000)

const reviewer = (risk: Record<string, Verdict['risk']>) => async (pkgs: Array<{ eco: string; name: string }>) => pkgs.map(p => ({ eco: p.eco, name: p.name, risk: risk[p.name] ?? 'low', reason: risk[p.name] ? '下載量很低' : '常見套件' } as Verdict))

test.skipIf(!UV)('approve: nothing to look at -> built, then approved (the result comes later); a medium package -> a screen and a code; the code approves; a stale code is refused; a failed build is not approved', async () => {
  const s = await skillWith('demo', '1.0')
  const ad = { db, review: reviewer({}), env: env() }
  // registry packages from another index are custom sources: a screen
  const screen = await approveSkill(ad, s, 'demo', 'boss 1', 'admin')
  expect(screen.later).toBeUndefined()
  expect(screen.text).toContain(`⚠️ 套件 cctrdemo 1.0 (來源 http://10.0.2.2:${index.port}/simple) [自訂來源: 不查 PyPI 的資料, 由人判斷]`)
  const code = hashSkill(s).slice(0, 8)
  expect(screen.text).toContain(`確認核准: /router skill approve demo ${code}`)
  expect(db.skillApproval(s)).toBeNull()
  expect((await approveSkill(ad, s, 'demo', 'boss 1', 'admin', 'deadbeef')).text).toStartWith('確認碼 deadbeef 不符')
  const ok = await approveSkill(ad, s, 'demo', 'boss 1', 'admin', code)
  expect(ok.text).toStartWith('核准中: 正在建技能 demo 的 Python 環境')
  expect(db.skillApproval(s)).toBeNull() // not before it is built
  expect(await ok.later).toStartWith('已核准技能 demo 的特權動作')
  expect(db.skillApproval(s)!.hash).toBe(hashSkill(s))
  // a build that fails: not approved
  const bad = await skillWith('bad', '1.0')
  writeFileSync(join(bad, 'pyproject.toml'), readFileSync(join(bad, 'pyproject.toml'), 'utf8').replace('cctrdemo==1.0', 'cctrdemo==2.0'))
  const r = await approveSkill(ad, bad, 'bad', 'boss 1', 'owner', hashSkill(bad).slice(0, 8))
  expect(await r.later).toContain('技能 bad 沒有核准: Python 環境建不起來')
  expect(db.skillApproval(bad)).toBeNull()
}, 180_000)

test('approve without a lock: plain skills in one step; host access needs owner and its screen; a medium PyPI package and a git source make a screen', async () => {
  const s = join(dir, 'home', 'bot1', '.claude', 'skills', 'plain')
  mkdirSync(s, { recursive: true })
  writeFileSync(join(s, 'privileged.json'), JSON.stringify({ actions: { a: { run: ['true'] } } }))
  const ad = { db, review: reviewer({ leftpadx: 'medium' }), env: env() }
  expect((await approveSkill(ad, s, 'plain', 'admin 2', 'admin')).text).toStartWith('已核准技能 plain 的特權動作')
  expect(db.skillApproval(s)).not.toBeNull()
  writeFileSync(join(s, 'privileged.json'), JSON.stringify({ actions: { a: { run: ['true'] }, fix: { run: ['true'], internal: true, host: { ports: [9222] } } } }))
  expect((await approveSkill(ad, s, 'plain', 'admin 2', 'admin')).text).toStartWith('技能 plain 只有 owner 能核准: 動作 fix 宣告了主機存取 (host)')
  const o = await approveSkill(ad, s, 'plain', 'boss 1', 'owner')
  expect(o.text).toContain('⚠️ 動作 fix 宣告了主機存取 (host)')
  expect((await approveSkill(ad, s, 'plain', 'boss 1', 'owner', hashSkill(s).slice(0, 8))).text).toStartWith('已核准技能 plain')
  // the screen lists every package, with the model's verdict
  writeFileSync(join(s, 'privileged.json'), JSON.stringify({ actions: { a: { run: ['true'] } } }))
  writeFileSync(join(s, 'pyproject.toml'), '[project]\nname = "plain"\nversion = "0"\n')
  writeFileSync(join(s, 'uv.lock'), `version = 1\n[[package]]\nname = "requests"\nversion = "2.32.3"\nsource = { registry = "https://pypi.org/simple" }\n[[package]]\nname = "leftpadx"\nversion = "0.1"\nsource = { registry = "https://pypi.org/simple" }\n[[package]]\nname = "plugin"\nversion = "0.1"\nsource = { git = "https://github.com/example/plugin?rev=x#${COMMIT}" }\n`)
  const p = await approveSkill(ad, s, 'plain', 'boss 1', 'owner')
  expect(p.text).toContain('⚠️ 套件 leftpadx 0.1 (PyPI) [medium] 下載量很低')
  expect(p.text).toContain(`⚠️ 套件 plugin 0.1 (來源 https://github.com/example/plugin?rev=x commit ${COMMIT}) [自訂來源: 不查 PyPI 的資料, 由人判斷]`)
  expect(p.text).toContain('- requests 2.32.3 (PyPI) [low] 常見套件')
  expect(p.text).not.toContain('⚠️ 套件 requests')
  // no reviewer at all: a PyPI package needs a person too
  expect((await approveSkill({ db, env: env() }, s, 'plain', 'boss 1', 'owner')).text).toContain('⚠️ 套件 requests 2.32.3 (PyPI) [沒有自動審核結果]')
})

test('skill_try: a draft with a custom source or a package not judged low is refused (approval is where a person looks); without a reviewer, refused', async () => {
  const c = conv
  const d = join(c.folder, 'skills', 'draft')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), '---\nname: draft\ndescription: x\n---\n')
  writeFileSync(join(d, 'privileged.json'), JSON.stringify({ actions: { a: { run: ['python3', '-B', '-c', 'print(1)'] } } }))
  writeFileSync(join(d, 'pyproject.toml'), '[project]\nname = "draft"\nversion = "0"\n')
  const lock = (extra = '') => writeFileSync(join(d, 'uv.lock'), `version = 1\n[[package]]\nname = "leftpadx"\nversion = "0.1"\nsource = { registry = "https://pypi.org/simple" }\n${extra}`)
  const td = (review?: SkillTryDeps['reviewPkgs']): SkillTryDeps => ({ ...deps, stateDir: join(dir, 'state'), cred: () => undefined, fake: { cmd: [process.execPath, join(ROOT, 'router', 'skilltry-fake.ts')], ro: [process.execPath, join(ROOT, 'router', 'skilltry-fake.ts')] }, reviewPkgs: review })
  lock(`[[package]]\nname = "plugin"\nversion = "0.1"\nsource = { git = "https://github.com/example/plugin?rev=x#${COMMIT}" }\n`)
  expect((await trySkill(td(reviewer({})), { ...c, role: 'power' }, 'power', { path: 'draft', action: 'a' })).text).toBe(`skill try: refused\n試跑只建 PyPI 套件的環境; 這些是自訂來源, 要 owner 或 admin 核准時人工審核: plugin 0.1 (來源 https://github.com/example/plugin?rev=x commit ${COMMIT})`)
  lock()
  expect((await trySkill(td(reviewer({ leftpadx: 'high' })), { ...c, role: 'power' }, 'power', { path: 'draft', action: 'a' })).text).toBe('skill try: refused\n試跑只建自動審核判定 low 的套件; 這些要 owner 或 admin 核准時再看: leftpadx 0.1 [high: 下載量很低]')
  expect((await trySkill(td(), { ...c, role: 'power' }, 'power', { path: 'draft', action: 'a' })).text).toBe('skill try: refused\n這個 router 沒有套件審核, 試跑不建 Python 環境')
  rmSync(join(d, 'uv.lock'))
  expect((await trySkill(td(reviewer({})), { ...c, role: 'power' }, 'power', { path: 'draft', action: 'a' })).text).toContain('有 pyproject.toml 但沒有 uv.lock')
})

test.skipIf(!UV || !process.env.LIVE)('LIVE=1: a real PyPI lock built with uv\'s own Python (only-managed), the way the router does it', async () => {
  const s = join(dir, 'home', 'bot1', '.claude', 'skills', 'live')
  mkdirSync(s, { recursive: true })
  writeFileSync(join(s, 'privileged.json'), JSON.stringify({ actions: { v: { run: ['python3', '-B', '-c', 'import six, sys; print("six", six.__version__, sys.version.split()[0], sys.executable)'] } } }))
  writeFileSync(join(s, 'pyproject.toml'), '[project]\nname = "live"\nversion = "0"\nrequires-python = ">=3.12,<3.13"\ndependencies = ["six==1.17.0"]\n')
  const lock = Bun.spawnSync([UV!, 'lock', '--quiet'], { cwd: s, env: { PATH: '/usr/bin:/bin', HOME: dir, UV_CACHE_DIR: join(dir, 'uv-cache-host') }, stderr: 'pipe' })
  expect(lock.exitCode, lock.stderr.toString()).toBe(0)
  db.approveSkill(s, 'live', hashSkill(s), 'owner')
  const r = await runSkill({ ...deps, pythonPreference: undefined }, conv, 'user', 'live', 'v', {})
  expect(r.text, r.text).toMatch(/six 1\.17\.0 3\.12\.\d+ \/cctr\/env\/bin\/python3/)
  expect(readdirSync(join(toolbox, 'python')).some(n => n.startsWith('cpython-3.12'))).toBe(true)
}, 600_000)

test('/router skill approve: the confirmation code is passed on; from Telegram the build\'s result comes as its own message, the terminal waits for it', async () => {
  const OWNER = '111'
  const calls: Array<string | undefined> = [], sent: string[] = []
  let finish: (t: string) => void = () => {}
  const cfg = { path: join(dir, 'state', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: join(dir, 'home'), stateDir: join(dir, 'state'), socket: join(dir, 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude' } as Config
  const cdeps = {
    cfg, db, sendTo: async (_b: string, chat: string, text: string) => { sent.push(`${chat}: ${text}`) },
    skills: { list: () => '', revoke: () => '', approve: async (_b: string, _n: string, _by: string, _r: string, code?: string) => { calls.push(code); return { text: '核准中: 建環境', later: new Promise<string>(r => { finish = r }) } } },
  } as unknown as CommandDeps
  const tg = await runCommand({ bot: 'cc', text: '/router skill approve demo 1a2b3c4d', senderId: OWNER, senderName: 'n', chatId: OWNER, chatType: 'private' }, cdeps)
  expect(tg!.reply).toBe('核准中: 建環境')
  expect(calls).toEqual(['1a2b3c4d'])
  finish('已核准技能 demo')
  await Bun.sleep(10)
  expect(sent).toEqual([`${OWNER}: 已核准技能 demo`])
  const term = runCommand({ bot: 'cc', text: '/router skill approve demo', senderId: OWNER, senderName: 'n', chatId: OWNER, chatType: 'private', terminal: true }, cdeps)
  await Bun.sleep(10)
  finish('已核准技能 demo')
  expect((await term)!.reply).toBe('核准中: 建環境\n已核准技能 demo')
  expect(calls).toEqual(['1a2b3c4d', undefined])
})
