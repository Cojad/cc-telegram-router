// skill_try (docs/credentials-and-skills.md 「試跑技能草稿」 and 「試跑的網路」,
// /telegram:bot-skill 「試跑」). Real bwrap, slirp4netns and nft. The network
// (router/sandboxnet.ts): a service on the host's 127.0.0.1, the host's own
// interface address, the cloud metadata address 169.254.169.254, slirp's host
// alias 10.0.2.2 and private addresses are refused; the namespace's own
// loopback works; DNS points at slirp's resolver; the sandboxed process cannot
// change the rules; the internet (a real site through DNS) only with LIVE=1.
// Unix sockets: /run and /var/run are empty (docker.sock gone), and no
// AF_UNIX socket can be made at all (a socket the host listens on in a
// visible folder, every socket under /run/user/<uid>), while socketpair and
// TCP work and DNS is still set.
// skill_try on the guide's example: power runs it with fake credentials (the
// fake service on the sandbox's 127.0.0.1 gets the calls, the fake key and
// token never come back), databases start empty (never from the real ones),
// store_seed and session, role simulation (never above one's own), user
// refused until phase 2, internal actions without mounts and env, the
// timeout cap, the hourly limit of 20 apart from run_skill's, missing
// credentials noted, the output folder. Keep in sync with those sections.

import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { sandboxArgv } from '../privskill'
import { nftRules, netMissing, runIsolated, interfaceAddrs, unixBlockFilter, BLOCKED_V4 } from '../sandboxnet'
import { trySkill, TRY_PER_HOUR, type SkillTryDeps } from '../skilltry'
import type { Credential } from '../config'

const ROOT = join(import.meta.dir, '..', '..')
const GUIDE = readFileSync(join(ROOT, 'plugin', 'skills', 'bot-skill', 'SKILL.md'), 'utf8')
const EXAMPLE: Record<string, string> = Object.fromEntries([...GUIDE.matchAll(/^`skills\/signup\/([^`]+)`:\n\n```\w*\n([\s\S]*?)\n```$/gm)].map(m => [m[1]!, `${m[2]!}\n`]))
const REAL_KEY = 'real-key-0123456789abcdefghijklmn'
const REAL_TOKEN = '1234567890:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
const CREDS: Record<string, Credential> = {
  'event-api': { kind: 'http', token: REAL_KEY, baseUrl: 'https://events.example.com', header: 'x-api-key', scheme: 'none', methods: ['*'] } as Credential,
  'notify-bot': { token: REAL_TOKEN, methods: [] } as Credential,
}

// a service on the host, the kind the sandbox must never reach (a browser's CDP port, an ssh forward)
let hostHits = 0
const hostSvc = Bun.serve({ port: 0, hostname: '0.0.0.0', fetch() { hostHits++; return new Response('host secret') } })
afterAll(() => hostSvc.stop(true))
const hostAddr = interfaceAddrs().find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a))

let dir: string, db: RouterDb, deps: SkillTryDeps
const conv = (key: string, role: string): Conversation => {
  const folder = join(dir, 'home', 'bot1', key)
  mkdirSync(join(folder, '.chat'), { recursive: true })
  return { key, bot: 'cc', chat_id: key.replace(/\D/g, ''), type: 'dm', folder, role, session_id: null, created_at: '' }
}
function exec(argv: string[], env: Record<string, string>, timeoutMs: number) {
  return (async () => {
    const p = Bun.spawn(argv, { env, stdout: 'pipe', stderr: 'pipe' })
    const t = setTimeout(() => p.kill(9), timeoutMs)
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    clearTimeout(t)
    return { code: await p.exited, out: `${o}${e}`.trim() }
  })()
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-try-'))
  mkdirSync(join(dir, 'state'))
  db = openRouterDb(join(dir, 'state', 'router.db'))
  deps = {
    db, home: join(dir, 'home'), credsRoot: join(dir, 'state', 'creds'), userHome: join(dir, 'fakehome'), hidden: [join(dir, 'home'), join(dir, 'state')], extraRo: [],
    storeRoot: join(dir, 'state', 'skill-store'), botDir: () => join(dir, 'home', 'bot1'), exec, notifyOwner: () => {},
    stateDir: join(dir, 'state'), cred: n => CREDS[n], hostAddrs: async () => interfaceAddrs(),
    fake: { cmd: [process.execPath, join(ROOT, 'router', 'skilltry-fake.ts')], ro: [process.execPath, join(ROOT, 'router', 'skilltry-fake.ts')] },
  }
  mkdirSync(deps.userHome)
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

function draft(c: Conversation, name: string, files: Record<string, string | object>): string {
  const root = join(c.folder, 'skills', name)
  mkdirSync(root, { recursive: true })
  for (const [rel, v] of Object.entries(files)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), typeof v === 'string' ? v : JSON.stringify(v)) }
  return root
}

/** A python probe in the isolated network: one line per target, "<target> ok <status>" or "<target> no <error>". */
const PROBE = `import socket, sys, urllib.request
for u in sys.argv[1:]:
    try:
        if u.startswith('unix:'):
            s = socket.socket(socket.AF_UNIX)
            s.connect(u[5:])
            print(u, 'ok connected')
        else:
            print(u, 'ok', urllib.request.urlopen(u, timeout=4).status)
    except Exception as e:
        print(u, 'no', type(e).__name__, getattr(e, 'reason', ''), e)
`
async function probe(urls: string[], extra = ''): Promise<string> {
  const folder = join(dir, 'probe'), skill = join(dir, 'skill')
  mkdirSync(folder, { recursive: true }); mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'probe.py'), PROBE)
  const cmd = ['bash', '-c', `${extra}python3 -B ${join(skill, 'probe.py')} "$@"`, 'probe', ...urls]
  const sb = sandboxArgv({ argv: cmd, skillDir: skill, convFolder: folder, creds: {}, home: deps.userHome, hidden: deps.hidden })
  const r = await runIsolated({ argv: sb.argv, env: sb.env, timeoutMs: 60_000, workDir: join(dir, 'state', 'net'), hostAddrs: interfaceAddrs() })
  if ('error' in r) throw new Error(r.error)
  return r.out
}

test('sandbox network rules: the blocked ranges, slirp DNS open, the host\'s own addresses refused; missing tools are named', () => {
  const rules = nftRules(['172.31.1.2', '2001:db8::5'])
  for (const r of BLOCKED_V4) expect(rules).toContain(r)
  for (const r of ['127.0.0.0/8', '169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10', '172.31.1.2', '2001:db8::5']) expect(rules).toContain(r)
  expect(rules).toContain('ip daddr 10.0.2.3 udp dport 53 accept')
  expect(rules).toContain('oif "lo" accept')
  expect(netMissing([])).toBe('bwrap, nsenter, nft, slirp4netns')
  expect(netMissing()).toBeNull() // this host has them all (the tests below need them)
})

test('sandbox network: the host\'s 127.0.0.1, its own address, 169.254.169.254, 10.0.2.2 and private ranges are refused; the namespace\'s own loopback works; DNS is slirp\'s; the rules cannot be changed from inside', async () => {
  const p = hostSvc.port
  const urls = [`http://127.0.0.1:${p}/`, `http://localhost:${p}/`, ...(hostAddr ? [`http://${hostAddr}:${p}/`] : []), 'http://169.254.169.254/latest/meta-data/', `http://10.0.2.2:${p}/`, 'http://172.17.0.1/', 'http://192.168.1.1/', 'http://10.1.2.3/', 'http://100.100.100.100/']
  // a server on the namespace's own loopback (the fake service lives there)
  const own = 'python3 -m http.server 18080 --bind 127.0.0.1 >/dev/null 2>&1 & sleep 0.5; '
  const out = await probe([...urls, 'http://127.0.0.1:18080/'], `${own}cat /etc/resolv.conf; ip route; /usr/sbin/nft flush ruleset 2>&1 | head -1; `)
  expect(hostHits).toBe(0)
  for (const u of urls) expect(out).toMatch(new RegExp(`^${u.replace(/[.?*+/]/g, '\\$&')} no `, 'm'))
  expect(out).toContain('http://127.0.0.1:18080/ ok 200')
  expect(out).toContain('nameserver 10.0.2.3')
  expect(out).toContain('default via 10.0.2.2 dev tap0')
  expect(out).toMatch(/Operation not permitted|you must be root/)
}, 90_000)

test('sandbox unix sockets: /run and /var/run are empty (docker.sock is gone), no AF_UNIX socket can be made (a socket in a visible folder, every socket under /run/user/<uid>), socketpair and TCP still work; DNS is still set', async () => {
  const uid = process.getuid!()
  const userRun = `/run/user/${uid}`
  const hostSocks = existsSync(userRun) ? (Bun.spawnSync(['find', userRun, '-maxdepth', '3', '-type', 's']).stdout.toString().split('\n').filter(Boolean).slice(0, 5)) : []
  // a socket the host listens on, in a folder the sandbox sees (its own folder): only the seccomp filter stands in the way
  const folder = join(dir, 'probe'); mkdirSync(folder, { recursive: true })
  let accepted = 0
  const listener = Bun.listen({ unix: join(folder, 'host.sock'), socket: { open() { accepted++ }, data() {} } })
  try {
    const targets = ['/run/docker.sock', '/var/run/docker.sock', '/run/dbus/system_bus_socket', join(folder, 'host.sock'), ...hostSocks].map(s => `unix:${s}`)
    const out = await probe(targets, `ls -A /run; ls -A /var/run; cat /etc/resolv.conf; python3 -c "import socket; socket.socketpair(); socket.socket(socket.AF_INET); print('pair and tcp ok')"; `)
    for (const t of targets) expect(out).toMatch(new RegExp(`^${t.replace(/[.?*+/]/g, '\\$&')} no `, 'm'))
    expect(out).toContain(`unix:${join(folder, 'host.sock')} no PermissionError`)
    expect(out).toContain('pair and tcp ok')
    expect(out).toContain('nameserver 10.0.2.3')
    expect(out).not.toContain('docker.sock\n')
    expect(accepted).toBe(0)
  } finally { listener.stop(true) }
}, 90_000)

test('the seccomp program: socket(AF_UNIX) and io_uring_setup refused, other architectures and x32 refused, unknown CPUs give none', () => {
  const f = unixBlockFilter('x64')!
  expect(f.length).toBe(10 * 8)
  expect(f.readUInt32LE(1 * 8 + 4)).toBe(0xc000003e)
  expect(f.readUInt32LE(4 * 8 + 4)).toBe(425)
  expect(f.readUInt32LE(5 * 8 + 4)).toBe(41)
  expect(f.readUInt32LE(9 * 8 + 4)).toBe(0x00050001)
  expect(unixBlockFilter('arm64')!.readUInt32LE(5 * 8 + 4)).toBe(198)
  expect(unixBlockFilter('ia32')).toBeNull()
})

test.skipIf(!process.env.LIVE)('sandbox network (LIVE=1): the internet works, names resolve through slirp', async () => {
  const out = await probe(['https://example.com/'])
  expect(out).toContain('https://example.com/ ok 200')
}, 90_000)

function example(c: Conversation) { return draft(c, 'signup', EXAMPLE) }

test('skill_try on the guide\'s example: power runs join with fake credentials on the sandbox\'s fake service; nothing real is touched or returned; a trial database starts empty', async () => {
  const c = conv('dm-7', 'power')
  example(c)
  // the bot's real database exists and must neither be read nor written
  const real = join(dir, 'state', 'skill-store', 'bot1', 'signup')
  mkdirSync(real, { recursive: true })
  writeFileSync(join(real, 'signups.jsonl'), '{"name":"real person","note":"","event":"x","at":1}\n')
  const r = await trySkill(deps, c, 'power', { path: 'skills/signup', action: 'join', args: { name: '小明', note: '會晚到' } })
  expect(r.text.split('\n')[0]).toBe('skill try: ok')
  expect(r.ok).toBe(true)
  expect(r.text).toContain('扮演角色 power')
  expect(r.text).toContain('網路: 外網可連, 主機本機與內網擋下')
  expect(r.text).toContain('小明 報名成功, 目前 1 人 (這次活動)')
  expect(r.text).toContain('試跑資料庫的變動: \n新增 signup/signups.jsonl (')
  expect(r.text).toContain('1 行)')
  expect(r.text).toContain('- GET /http/EVENTS/v1/events/current (0 bytes)')
  expect(r.text).toMatch(/- POST \/bot<已遮蔽>\/sendMessage \(\d+ bytes: \{"chat_id": "@example_events"/)
  for (const s of [REAL_KEY, REAL_TOKEN, 'real person', 'FAKE', 'fake-', '__CCTR_FAKE__']) expect(r.text).not.toContain(s)
  expect(readFileSync(join(real, 'signups.jsonl'), 'utf8')).toBe('{"name":"real person","note":"","event":"x","at":1}\n')
  // the output folder in the conversation, the trial's own folders gone
  expect(readdirSync(join(c.folder, 'skill-try'))[0]).toMatch(/^\d{8}-\d{6}-join$/)
  expect(readdirSync(join(dir, 'state', 'skill-try', 'dm-7'))).toEqual([])
  // recorded apart from run_skill
  expect(db.skillRunsSince('try:dm-7', '2000-01-01')).toBe(1)
  expect(db.skillRunsSince('dm-7', '2000-01-01')).toBe(0)
}, 60_000)

test('skill_try: session keeps the trial databases between runs; store_seed starts them from a folder in the conversation (plain files only)', async () => {
  const c = conv('dm-7', 'admin')
  example(c)
  await trySkill(deps, c, 'admin', { path: 'signup', action: 'join', args: { name: '小明' }, session: 's1' })
  await trySkill(deps, c, 'admin', { path: 'signup', action: 'join', args: { name: '小華' }, session: 's1' })
  const list = await trySkill(deps, c, 'admin', { path: 'signup', action: 'list', session: 's1' })
  expect(list.text).toContain('1. 小明\n2. 小華')
  const twice = await trySkill(deps, c, 'admin', { path: 'signup', action: 'join', args: { name: '小明' }, session: 's1' })
  expect(twice.text.split('\n')[0]).toBe('skill try: failed')
  expect(twice.text).toContain('小明 已經報名過了')
  const cancel = await trySkill(deps, c, 'admin', { path: 'signup', action: 'cancel', args: { index: '1' }, session: 's1' })
  expect(cancel.text).toContain('已取消第 1 位: 小明')
  expect(cancel.text).toContain('修改 signup/signups.jsonl (')
  expect(cancel.text).toContain('2 -> 1 行)')
  // without a session: empty again
  expect((await trySkill(deps, c, 'admin', { path: 'signup', action: 'list' })).text).toContain('試跑資料庫的變動: 無')
  mkdirSync(join(c.folder, 'seed', 'signup'), { recursive: true })
  writeFileSync(join(c.folder, 'seed', 'signup', 'signups.jsonl'), '{"name":"種子","note":"","event":"x","at":1}\n')
  const seeded = await trySkill(deps, c, 'admin', { path: 'signup', action: 'list', store_seed: 'seed' })
  expect(seeded.text).toContain('1. 種子')
  expect(seeded.text).toContain('從 store_seed 開始')
  symlinkSync('/etc/hostname', join(c.folder, 'seed', 'signup', 'link'))
  expect((await trySkill(deps, c, 'admin', { path: 'signup', action: 'list', store_seed: 'seed' })).text).toBe('skill try: refused\nstore_seed 裡的 signup/link 不是一般檔案 (符號連結, fifo 等不接受)')
  expect((await trySkill(deps, c, 'admin', { path: 'signup', action: 'list', store_seed: '/etc' })).text).toContain('不在這個對話的資料夾裡')
}, 120_000)

test('skill_try: power and up only (user waits for phase 2); role is simulated but never above one\'s own; roles and argument roles refuse as run_skill would', async () => {
  const u = conv('dm-8', 'user')
  example(u)
  const r = await trySkill(deps, u, 'user', { path: 'signup', action: 'join', args: { name: 'x' } })
  expect(r.text).toBe('skill try: refused\nskill_try 只開放 power 以上的對話 (這個對話是 user): 試跑的程式還沒經過核准, 要等之後的白名單沙箱才開放給 user. 可以先用 skill_check 檢查草稿')
  expect((await trySkill(deps, u, 'guest', { path: 'signup', action: 'list' })).text).toContain('只開放 power 以上')
  const p = conv('dm-7', 'power')
  example(p)
  expect((await trySkill(deps, p, 'power', { path: 'signup', action: 'cancel', args: { index: '1' } })).text).toBe('skill try: refused\n動作 cancel 不開放給 power 角色 (正式執行時也會這樣拒絕)')
  expect((await trySkill(deps, p, 'power', { path: 'signup', action: 'cancel', args: { index: '1' }, role: 'admin' })).text).toBe('skill try: refused\nrole 只能扮演等於或低於自己的角色 (這個對話是 power)')
  const o = conv('dm-9', 'owner')
  example(o)
  expect((await trySkill(deps, o, 'owner', { path: 'signup', action: 'cancel', args: { index: '1' }, role: 'user' })).text).toContain('動作 cancel 不開放給 user 角色')
  draft(o, 'flagged', { 'SKILL.md': '---\nname: flagged\ndescription: x\n---\n', 'privileged.json': { actions: { go: { run: ['echo', 'hi', '{force?}'], args: { force: { flag: '--force', roles: ['owner'] } } } } } })
  expect((await trySkill(deps, o, 'owner', { path: 'flagged', action: 'go', args: { force: true }, role: 'power' })).text).toContain('參數 force 只開放給 owner')
  expect((await trySkill(deps, o, 'owner', { path: 'flagged', action: 'nope' })).text).toBe('skill try: refused\n沒有動作 nope (有: go)')
  expect(db.skillRunsSince('try:dm-9', '2000-01-01')).toBe(0)
}, 60_000)

test('skill_try: internal actions run without mounts and env; the timeout is capped at 600 seconds; credentials missing from the router are noted; refused without the network tools; the hourly limit is 20', async () => {
  const c = conv('dm-7', 'owner')
  draft(c, 'refresher', {
    'SKILL.md': '---\nname: refresher\ndescription: x\n---\n',
    'scripts/r.sh': 'echo "secret=${MY_SECRET:-unset}"; ls /srv/mounted 2>&1 | head -1; echo token > "$1/cookie.txt"; echo wrote\n',
    'privileged.json': { actions: {
      go: { run: ['bash', 'scripts/r.sh'], http: { API: 'nowhere' }, timeout: 3600, auth_failure: 'x', refresh: 'refresh' },
      refresh: { run: ['bash', 'scripts/r.sh', '{cred:JAR}'], creds: { JAR: 'jar' }, internal: true, mounts: ['/srv/mounted'], env: { MY_SECRET: 'abc' } },
    } },
  })
  const r = await trySkill(deps, c, 'owner', { path: 'refresher', action: 'refresh' })
  expect(r.text.split('\n')[0]).toBe('skill try: ok')
  expect(r.text).toContain('secret=unset')
  expect(r.text).toContain('動作 refresh 的 mounts 與 env 在試跑時一律不給')
  const g = await trySkill(deps, c, 'owner', { path: 'refresher', action: 'go' })
  expect(g.text).toContain('動作 go 的 timeout 在試跑時最多 600 秒')
  expect(g.text).toContain('憑證 nowhere 在 router 裡不存在: 試跑用假的照跑, 核准後正式執行會拒絕')
  // no network isolation possible: refused, never run without it
  const none = await trySkill({ ...deps, netMissing: () => 'slirp4netns' }, c, 'owner', { path: 'refresher', action: 'go' })
  expect(none.text).toBe('skill try: refused\n這台主機缺少試跑網路隔離需要的工具 (slirp4netns), 不試跑 (不會改成不隔離)')
  for (let i = 0; i < TRY_PER_HOUR; i++) db.addSkillRun('try:dm-7', 'refresher', 'go', 'ok')
  expect((await trySkill(deps, c, 'owner', { path: 'refresher', action: 'go' })).text).toContain(`一小時內已經試跑 ${TRY_PER_HOUR + 2} 次, 上限 ${TRY_PER_HOUR} 次`)
  expect(db.skillRunsSince('dm-7', '2000-01-01')).toBe(0)
}, 60_000)

test('skill_try is a tool; the guide and docs say what it does', async () => {
  const { TOOL_DEFINITIONS } = await import('../../shared/tools')
  const t = (TOOL_DEFINITIONS as any[]).find(d => d.name === 'skill_try')
  expect(t.inputSchema.required).toEqual(['path', 'action'])
  for (const k of ['path', 'action', 'args', 'role', 'session', 'store_seed']) expect(t.inputSchema.properties[k]).toBeDefined()
  expect(t.description).toContain('power and up')
  for (const s of ['### 試跑 (skill_try)', '**憑證全是假的**', '**資料庫從空的開始**', '**試跑的網路: 連得到外網, 連不到主機本機與內網**', '每個對話每小時 20 次', 'timeout 最多 600 秒', '| user | 可以 | 可以 | 不行 (試跑的程式還沒核准, 要等之後的白名單沙箱)']) expect(GUIDE).toContain(s)
  const docs = readFileSync(join(ROOT, 'docs', 'credentials-and-skills.md'), 'utf8')
  for (const s of ['### 試跑技能草稿', '### 試跑的網路', 'user 對話一律拒絕', 'NS_GET_USERNS', '`/run` 蓋上空的 tmpfs', 'AF_UNIX socket 的 `socket(2)` 失敗', '`io_uring_setup`', '**已知限制**: 已核准的特權動作']) expect(docs).toContain(s)
  expect(GUIDE).toContain('**也不能建立 unix socket**')
})

test('a sandbox that ends before its network is set up (a path it mounts is missing, as the compiled router\'s fake script was) says why, in bwrap\'s words', async () => {
  const folder = join(dir, 'probe'), skill = join(dir, 'skill')
  mkdirSync(folder, { recursive: true }); mkdirSync(skill, { recursive: true })
  const sb = sandboxArgv({ argv: ['true'], skillDir: skill, convFolder: folder, creds: {}, home: deps.userHome, hidden: deps.hidden })
  const r = await runIsolated({ argv: sb.argv, env: sb.env, timeoutMs: 30_000, workDir: join(dir, 'state', 'net'), hostAddrs: [], extraRo: ['/$bunfs/root/skilltry-fake.ts'] })
  expect('error' in r && r.error).toMatch(/^沙箱在設定網路前就結束了 \(exit 1\): bwrap: Can't find source path \/\$bunfs\/root\/skilltry-fake\.ts/)
})

test('skill_try: when the sandbox cannot start (here: the fake service\'s script is missing) the try is refused with bwrap\'s reason, and nothing ran', async () => {
  const c = conv('dm-7', 'power')
  example(c)
  const r = await trySkill({ ...deps, fake: { cmd: [process.execPath, '/$bunfs/root/skilltry-fake.ts'], ro: ['/$bunfs/root/skilltry-fake.ts'] } }, c, 'power', { path: 'signup', action: 'join', args: { name: '小明' } })
  expect(r.ok).toBe(false)
  expect(r.text.split('\n')[0]).toBe('skill try: refused')
  expect(r.text).toContain("試跑的網路隔離失敗, 沒有執行: 沙箱在設定網路前就結束了 (exit 1): bwrap: Can't find source path /$bunfs/root/skilltry-fake.ts")
  expect(r.text).toContain('試跑資料庫的變動: 無')
})
