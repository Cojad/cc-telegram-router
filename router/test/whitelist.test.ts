// The whitelisted sandbox of every privileged action (docs/skill-runtime.md 「掛載路徑」
// 「網路」「主機存取 host」「對外 port」; docs/credentials-and-skills.md 「特權技能」).
// Real bwrap, slirp4netns and nft, through run_skill (runSkill) and the refresh
// (runAction), as the router runs them:
//   - the file system: /usr and a few /etc files; the user's home, the router's
//     home and state dir, other conversations and skills, /home, /run, /sys,
//     /etc/ssl/private, the host's passwd do not exist; credentials and databases
//     at /cctr paths; the state dir's path never reaches the script
//   - the internet ports: 80, 443, 53, 22 for actions conversations call (and
//     their outbound_ports, owner approval), any port for internal actions;
//     checked against a TEST-NET address: a refused port fails at once (nft),
//     an open one leaves the sandbox and times out; LIVE=1 also reaches real sites
//   - the host, private ranges, metadata: refused for every action; an internal
//     action reaches only its host.ports at $CCTR_HOST, and only it may connect
//     to the unix socket it mounts
//   - a Bot API on the host's 127.0.0.1 (a self-hosted server, config apiRoot):
//     an action with bots reaches that one port at 10.0.2.2, others do not
//   - privileged.json: host only on internal actions, outbound_ports only on the
//     others, ports in range; the old mounts/env spelling read as host
//   - approval: host and outbound_ports need owner (admin refused, the screen lists them)
// Keep in sync with those sections and /telegram:bot-skill 「執行環境」.

import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { hashSkill, loadManifest, ownerOnly } from '../privskill'
import { runSkill, runAction, approveRefusal, describeActions, outPortsOf, apiForSandbox, type SkillRunDeps } from '../skillrun'
import { nftRules, unixBlockFilter, interfaceAddrs, OUT_PORTS, uidMapped } from '../sandboxnet'
import { sandboxDeps } from './fixtures/sandbox'
import { checkSkill } from '../skillcheck'

const ROOT = join(import.meta.dir, '..', '..')
const TEST_NET = '203.0.113.7' // documentation range: nothing answers, so an open port times out
// services on the host: a browser's CDP, an ssh forward, something else
const hits: Record<string, number> = { a: 0, b: 0, c: 0 }
const svc = (k: string) => Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { hits[k]!++; return new Response(`host ${k}`) } })
const A = svc('a'), B = svc('b'), C = svc('c')
afterAll(() => { A.stop(true); B.stop(true); C.stop(true) })
const hostAddr = interfaceAddrs().find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a))

let dir: string, db: RouterDb, deps: SkillRunDeps, conv: Conversation, skill: string
const told: string[] = []

/** One line per target: "<target> ok ...", "<target> refused <error>" (fails at once) or "<target> timeout". */
// every target at once (each its own thread, results in the given order): the ones that time out wait together
const PROBE = `import socket, sys, threading, time, urllib.request
def probe(t):
    try:
        if t.startswith('unix:'):
            s = socket.socket(socket.AF_UNIX); s.connect(t[5:]); return f"{t} ok {s.recv(32).decode().strip()}"
        elif t.startswith('http'):
            return f"{t} ok {urllib.request.urlopen(t, timeout=4).read().decode()[:40]}"
        else:
            h, p = t.rsplit(':', 1)
            socket.create_connection((h, int(p)), timeout=2.5).close(); return f"{t} ok connected"
    except (socket.timeout, TimeoutError):
        return f"{t} timeout"
    except Exception as e:
        return f"{t} refused {type(e).__name__} {e}"
out = [None] * (len(sys.argv) - 1)
def run(i, t): out[i] = probe(t)
ts = [threading.Thread(target=run, args=(i, t)) for i, t in enumerate(sys.argv[1:])]
for x in ts: x.start()
for x in ts: x.join()
print('\\n'.join(out))
`

function writeSkill(actions: Record<string, unknown>) {
  mkdirSync(join(skill, 'scripts'), { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: wl\ndescription: x\n---\n')
  writeFileSync(join(skill, 'scripts', 'probe.py'), PROBE)
  writeFileSync(join(skill, 'scripts', 'look.sh'), `for p in "$@"; do if [ -e "$p" ]; then echo "SEE $p"; else echo "GONE $p"; fi; done
echo "CWD $(pwd)"; echo "COOKIES $COOKIES"; env | grep -c -- "${join(dir, 'state')}" | sed 's/^/STATEPATHS /'
grep -c . /etc/passwd | sed 's/^/PASSWD /'; cat "$COOKIES/c.txt" | wc -c | sed 's/^/COOKIEBYTES /'
`)
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions }))
  db.approveSkill(skill, 'wl', hashSkill(skill), 'owner')
}

beforeEach(() => {
  told.length = 0
  dir = mkdtempSync(join(tmpdir(), 'cctr-wl-'))
  mkdirSync(join(dir, 'state', 'creds', 'jar'), { recursive: true })
  writeFileSync(join(dir, 'state', 'config.json'), '{"token":"secret"}')
  writeFileSync(join(dir, 'state', 'creds', 'jar', 'c.txt'), 'cookie\n')
  db = openRouterDb(join(dir, 'state', 'router.db'))
  skill = join(dir, 'home', 'bot1', '.claude', 'skills', 'wl')
  const folder = join(dir, 'home', 'bot1', 'dm-7')
  mkdirSync(join(folder, '.chat'), { recursive: true })
  mkdirSync(join(dir, 'home', 'bot1', 'dm-8'), { recursive: true })
  writeFileSync(join(dir, 'home', 'bot1', 'dm-8', 'other.txt'), 'other\n')
  mkdirSync(join(dir, 'home', 'bot1', '.claude', 'skills', 'other'), { recursive: true })
  mkdirSync(join(dir, 'fakehome', '.ssh'), { recursive: true })
  writeFileSync(join(dir, 'fakehome', '.ssh', 'id_rsa'), 'KEY\n')
  writeFileSync(join(dir, 'fakehome', '.ssh', 'known_hosts'), 'host key\n')
  conv = { key: 'dm-7', bot: 'cc', chat_id: '7', type: 'dm', folder, role: 'user', session_id: null, created_at: '' }
  deps = {
    db, home: join(dir, 'home'), credsRoot: join(dir, 'state', 'creds'), userHome: join(dir, 'fakehome'), hidden: [join(dir, 'home'), join(dir, 'state')],
    botDir: () => join(dir, 'home', 'bot1'), storeRoot: join(dir, 'state', 'skill-store'),
    ...sandboxDeps(join(dir, 'state')),
    notifyOwner: (_c, t) => told.push(t),
  }
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const probeRun = (targets: string[]) => ['python3', '-B', 'scripts/probe.py', ...targets]

test('file system: only /usr, a few /etc files, the skill, its credentials and the conversation exist; nothing of the user, the router or other conversations and skills', async () => {
  const gone = [join(dir, 'fakehome'), join(dir, 'fakehome', '.ssh', 'id_rsa'), join(dir, 'state'), join(dir, 'state', 'config.json'), join(dir, 'home', 'bot1', 'dm-8', 'other.txt'), join(dir, 'home', 'bot1', '.claude', 'skills', 'other'),
    '/home', '/root', '/opt', '/var/lib', '/run', '/sys', '/etc/shadow', '/etc/ssl/private', '/etc/sudoers', '/etc/hostname', '/etc/machine-id', ROOT]
  const seen = ['/usr/bin/python3', '/etc/ssl/certs', '/etc/ld.so.cache', '/etc/resolv.conf', '/tmp', '/cctr/creds/COOKIES']
  const look = [...gone, ...seen]
  writeSkill({ look: { run: ['bash', 'scripts/look.sh', ...look.map((_, i) => `{p${i}}`)], args: Object.fromEntries(look.map((_, i) => [`p${i}`, { pattern: '\\S+' }])), creds: { COOKIES: 'jar' } } })
  const r = await runSkill(deps, conv, 'user', 'wl', 'look', Object.fromEntries(look.map((p, i) => [`p${i}`, p])))
  expect(r.text.split('\n')[0]).toBe('exit 0')
  for (const p of gone) expect(r.text).toContain(`GONE ${p}\n`)
  for (const p of seen) expect(r.text).toContain(`SEE ${p}\n`)
  expect(r.text).toContain(`CWD ${conv.folder}\n`)
  expect(r.text).toContain('COOKIES /cctr/creds/COOKIES\n')
  expect(r.text).toContain('COOKIEBYTES 7')
  expect(r.text).toContain('PASSWD 3\n') // root, the sandbox's user, nobody: not the host's list
  expect(r.text).toContain('STATEPATHS 0') // no variable names the router's folders
}, 30_000)

test('network: an action a conversation calls reaches only internet ports 80, 443, 53, 22; never the host, its address, private ranges or metadata', async () => {
  writeSkill({ net: { run: probeRun([`${TEST_NET}:80`, `${TEST_NET}:443`, `${TEST_NET}:22`, `${TEST_NET}:53`, `${TEST_NET}:8080`, `${TEST_NET}:8443`, `127.0.0.1:${A.port}`, `10.0.2.2:${A.port}`, ...(hostAddr ? [`${hostAddr}:${A.port}`] : []), '169.254.169.254:80', '10.1.2.3:443', '172.17.0.1:443', '192.168.1.1:443', 'unix:/tmp/x.sock']) } })
  const r = await runSkill(deps, conv, 'user', 'wl', 'net', {})
  for (const p of [80, 443, 22, 53]) expect(r.text).toContain(`${TEST_NET}:${p} timeout`)
  for (const p of [8080, 8443]) expect(r.text).toMatch(new RegExp(`${TEST_NET}:${p} refused ConnectionRefusedError`))
  for (const t of [`127.0.0.1:${A.port}`, `10.0.2.2:${A.port}`, ...(hostAddr ? [`${hostAddr}:${A.port}`] : []), '169.254.169.254:80', '10.1.2.3:443', '172.17.0.1:443', '192.168.1.1:443']) expect(r.text).toContain(`${t} refused`)
  expect(r.text).toContain('unix:/tmp/x.sock refused PermissionError') // no AF_UNIX socket at all
  expect(hits.a).toBe(0)
}, 60_000)

test('network: outbound_ports adds internet ports to an action (owner approval); still nothing on the host or private ranges', async () => {
  writeSkill({ net: { run: probeRun([`${TEST_NET}:8443`, `${TEST_NET}:8080`, `127.0.0.1:8443`, '10.1.2.3:8443']), outbound_ports: [8443] } })
  const r = await runSkill(deps, conv, 'user', 'wl', 'net', {})
  expect(r.text).toContain(`${TEST_NET}:8443 timeout`)
  expect(r.text).toContain(`${TEST_NET}:8080 refused`)
  expect(r.text).toContain('127.0.0.1:8443 refused')
  expect(r.text).toContain('10.1.2.3:8443 refused')
  expect(nftRules([], { outPorts: outPortsOf(loadManifest(skill)!.actions.net!) })).toContain('tcp dport != { 80, 443, 53, 22, 8443 } reject')
}, 60_000)

test('host access: an internal action reaches its declared host ports at $CCTR_HOST, any internet port, its mounted socket; nothing else of the host', async () => {
  const sockDir = join(dir, 'sock')
  mkdirSync(sockDir)
  const agent = Bun.listen({ unix: join(sockDir, 'agent.sock'), socket: { open(s) { s.write('AGENT\n'); s.end() }, data() {} } })
  const other = Bun.listen({ unix: join(sockDir, 'other.sock'), socket: { open(s) { s.write('OTHER\n'); s.end() }, data() {} } })
  try {
    const targets = [`http://10.0.2.2:${A.port}/`, `http://10.0.2.2:${B.port}/`, `10.0.2.2:${C.port}`, `127.0.0.1:${A.port}`, ...(hostAddr ? [`${hostAddr}:${A.port}`] : []), '169.254.169.254:80', '10.1.2.3:443',
      `${TEST_NET}:8080`, `unix:${join(sockDir, 'agent.sock')}`, `unix:${join(sockDir, 'other.sock')}`]
    writeSkill({
      go: { run: ['true'], creds: { JAR: 'jar' }, auth_failure: 'x', refresh: 'repair' },
      repair: { run: ['bash', '-c', 'echo "HOST=$CCTR_HOST SOCK=$AGENT"; exec python3 -B "$1" "${@:2}"', 'probe', 'scripts/probe.py', ...targets], internal: true, creds: { JAR: 'jar' },
        host: { ports: [A.port, B.port], mounts: [join(sockDir, 'agent.sock'), '~/.ssh/known_hosts'], env: { AGENT: join(sockDir, 'agent.sock') } } },
    })
    const m = loadManifest(skill)!
    mkdirSync(join(dir, 'state', 'refresh'))
    const r = await runAction(deps, skill, m.actions.repair!, {}, join(dir, 'state', 'refresh'))
    expect(r.out).toContain(`HOST=10.0.2.2 SOCK=${join(sockDir, 'agent.sock')}`)
    expect(r.out).toContain(`http://10.0.2.2:${A.port}/ ok host a`)
    expect(r.out).toContain(`http://10.0.2.2:${B.port}/ ok host b`)
    for (const t of [`10.0.2.2:${C.port}`, `127.0.0.1:${A.port}`, ...(hostAddr ? [`${hostAddr}:${A.port}`] : []), '169.254.169.254:80', '10.1.2.3:443']) expect(r.out).toContain(`${t} refused`)
    expect(r.out).toContain(`${TEST_NET}:8080 timeout`) // an internal action: any internet port
    expect(r.out).toContain(`unix:${join(sockDir, 'agent.sock')} ok AGENT`)
    expect(r.out).toContain(`unix:${join(sockDir, 'other.sock')} refused FileNotFoundError`) // only what it declared exists
    expect(hits.c).toBe(0)
  } finally { agent.stop(true); other.stop(true) }
}, 60_000)

test('a Bot API on the host (the credential\'s own apiRoot or the config\'s, on 127.0.0.1: a self-hosted server): an action with bots reaches it at 10.0.2.2 on that port only; without bots, not at all', async () => {
  const TOKEN = '1234567890:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
  deps.apiRoot = `http://127.0.0.1:${A.port}/`
  deps.botCred = () => ({ token: TOKEN, methods: [] } as any)
  const t = [`10.0.2.2:${A.port}`, `10.0.2.2:${B.port}`, `127.0.0.1:${A.port}`]
  writeSkill({
    send: { run: ['bash', '-c', 'echo "API=$BOT_API"; python3 -B -c "import urllib.request,os;print(\'GOT\', urllib.request.urlopen(os.environ[\'BOT_API\']+\'/getMe\').read().decode())"; exec python3 -B "$1" "${@:2}"', 'p', 'scripts/probe.py', ...t], bots: { BOT: 'self-hosted' } },
    plain: { run: probeRun(t) },
  })
  const r = await runSkill(deps, conv, 'user', 'wl', 'send', {})
  expect(r.text).toContain(`API=http://10.0.2.2:${A.port}/bot<已遮蔽>`)
  expect(r.text).toContain('GOT host a')
  expect(r.text).toContain(`10.0.2.2:${A.port} ok connected`)
  expect(r.text).toContain(`10.0.2.2:${B.port} refused`)
  expect(r.text).toContain(`127.0.0.1:${A.port} refused`)
  expect(r.text).not.toContain(TOKEN)
  const p = await runSkill(deps, conv, 'user', 'wl', 'plain', {})
  expect(p.text).toContain(`10.0.2.2:${A.port} refused`)
  // the credential's own apiRoot on the host, the router's global one official: that credential's port is reached
  deps.apiRoot = undefined
  deps.botCred = () => ({ token: TOKEN, methods: [], apiRoot: `http://127.0.0.1:${B.port}` } as any)
  const own = await runSkill(deps, conv, 'user', 'wl', 'send', {})
  expect(own.text).toContain(`API=http://10.0.2.2:${B.port}/bot<已遮蔽>`)
  expect(own.text).toContain('GOT host b')
  expect(own.text).toContain(`10.0.2.2:${A.port} refused`)
  expect(apiForSandbox('https://api.telegram.org')).toEqual({ root: 'https://api.telegram.org' })
  expect(apiForSandbox('http://localhost:8081/')).toEqual({ root: 'http://10.0.2.2:8081', port: 8081 })
  expect(apiForSandbox('http://[::1]:8081/x')).toEqual({ root: 'http://10.0.2.2:8081/x', port: 8081 })
}, 60_000)

test('host access is never given to an action a conversation calls, nor through the old spelling on one', () => {
  mkdirSync(skill, { recursive: true })
  const load = (actions: Record<string, unknown>) => { writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions })); return () => loadManifest(skill) }
  expect(load({ a: { run: ['true'], host: { ports: [9222] } } })).toThrow('動作 a 不是 internal, 不能宣告 host')
  expect(load({ a: { run: ['true'], internal: true, host: { ports: [0] } } })).toThrow('host.ports 要是 1 到 65535 的整數陣列')
  expect(load({ a: { run: ['true'], internal: true, host: { ports: [22, 22] } } })).toThrow('host.ports 有重複')
  expect(load({ a: { run: ['true'], internal: true, host: { network: true } } })).toThrow('host 不認得 network')
  expect(load({ a: { run: ['true'], internal: true, host: { mounts: ['relative/x'] } } })).toThrow('host.mounts 要是絕對路徑或 ~/ 開頭的路徑')
  expect(load({ a: { run: ['true'], internal: true, host: { mounts: ['/a/../etc'] } } })).toThrow('不能有 ..')
  expect(load({ a: { run: ['true'], internal: true, host: { env: { PATH: '/x' } } } })).toThrow('host.env 環境變數名稱不行: PATH')
  expect(load({ a: { run: ['true'], internal: true, outbound_ports: [8443] } })).toThrow('動作 a 是 internal, 對外本來就不限 port')
  expect(load({ a: { run: ['true'], outbound_ports: [70000] } })).toThrow('outbound_ports 要是 1 到 65535 的整數陣列')
  // the old spelling of an internal action is its host mounts and env; on another action it means nothing
  const m = load({ a: { run: ['true'], internal: true, mounts: ['~/.ssh/known_hosts'], env: { X: '1' } }, b: { run: ['true'], mounts: ['/srv'], env: { X: '1' } } })()!
  expect(m.actions.a!.host).toEqual({ mounts: ['~/.ssh/known_hosts'], env: { X: '1' } })
  expect(m.actions.b!.host).toBeUndefined()
  expect(outPortsOf(m.actions.a!)).toBeNull()
  expect(outPortsOf(m.actions.b!)).toEqual(OUT_PORTS)
})

test('approval: host access and outbound_ports need owner; admin is refused with the reason and the list; owner and plain skills go through', () => {
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: {
    extract: { run: ['true'], creds: { JAR: 'jar' }, refresh: 'repair', auth_failure: 'x', outbound_ports: [8443] },
    repair: { run: ['true'], internal: true, creds: { JAR: 'jar' }, host: { ports: [40001, 5022], mounts: ['/tmp/agent.sock', '~/.ssh/known_hosts'], env: { SSH_AUTH_SOCK: '/tmp/agent.sock' } } },
  } }))
  expect(ownerOnly(loadManifest(skill)!)).toEqual(['動作 extract 宣告了額外的對外 port (outbound_ports 8443)', '動作 repair 宣告了主機存取 (host)'])
  const no = approveRefusal(skill, 'wl', 'admin')!
  expect(no).toStartWith('技能 wl 只有 owner 能核准: 動作 extract 宣告了額外的對外 port (outbound_ports 8443); 動作 repair 宣告了主機存取 (host). 沒有核准\n')
  expect(no).toContain('⚠️ 額外的對外 port 8443 (只有 owner 能核准)')
  expect(no).toContain('⚠️ 主機存取 (只有 owner 能核准): 連得到主機本機的 port 40001, 5022 (經 $CCTR_HOST), 可讀 /tmp/agent.sock, ~/.ssh/known_hosts (可以連 unix socket), 環境變數 SSH_AUTH_SOCK; 主機其他 port 與內網照樣連不到')
  expect(approveRefusal(skill, 'wl', 'owner')).toBeNull()
  expect(describeActions(skill)).toContain('repair (只由 router 執行)')
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: { a: { run: ['true'] } } }))
  expect(approveRefusal(skill, 'wl', 'admin')).toBeNull()
  writeFileSync(join(skill, 'privileged.json'), '{')
  expect(approveRefusal(skill, 'wl', 'owner')).toStartWith('privileged.json 有誤: ')
})

test('skill_check: the old mounts/env spelling, host.ports ($CCTR_HOST) and outbound_ports get their notes; host on a conversation\'s action is an error', () => {
  const folder = conv.folder
  const d = join(folder, 'skills', 'hosty')
  mkdirSync(join(d, 'scripts'), { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), '---\nname: hosty\ndescription: x\n---\n')
  writeFileSync(join(d, 'scripts', 'r.sh'), 'true\n')
  writeFileSync(join(d, 'privileged.json'), JSON.stringify({ actions: {
    go: { run: ['bash', 'scripts/r.sh'], outbound_ports: [8443] },
    repair: { run: ['bash', 'scripts/r.sh'], internal: true, mounts: ['~/.ssh/known_hosts'], env: { X: '1' } },
    tunnel: { run: ['bash', 'scripts/r.sh'], internal: true, host: { ports: [9222] } },
  } }))
  const r = checkSkill(folder, 'skills/hosty', 'owner')
  expect(r.text).toStartWith('skill check: ok')
  expect(r.text).toContain('- 動作 repair: mounts 與 env 是舊寫法, 照 host.mounts 與 host.env 讀; 請改寫成 "host": { "mounts": [...], "env": {...} }')
  expect(r.text).toContain('- 動作 tunnel: host.ports 的主機 port 要連 $CCTR_HOST (例如 http://$CCTR_HOST:9222), 不是 127.0.0.1 或 localhost (那是沙箱自己); 有 host 宣告的技能只有 owner 能核准')
  expect(r.text).toContain('- 動作 go: outbound_ports (8443) 讓動作連外網的這些 port (預設只有 80, 443, 53, 22); 有這個宣告的技能只有 owner 能核准')
  writeFileSync(join(d, 'privileged.json'), JSON.stringify({ actions: { go: { run: ['bash', 'scripts/r.sh'], host: { ports: [9222] } } } }))
  expect(checkSkill(folder, 'skills/hosty', 'owner').text).toContain('/router skill approve 會拒絕: 動作 go 不是 internal, 不能宣告 host')
})

// bwrap reports child-pid before the sandbox writes its uid map; nft entered then had no capabilities
// (「套不上網路規則 (nft)」 under load). runIsolated waits for the map; this is what it waits on.
test('uidMapped: a new user namespace is unmapped until its uid map is written; nft entered before that fails, after it loads the rules', async () => {
  const rules = join(dir, 'rules.nft')
  writeFileSync(rules, nftRules(interfaceAddrs()))
  const nft = (pid: number) => Bun.spawnSync(['nsenter', `--user=/proc/${pid}/ns/user`, `--net=/proc/${pid}/ns/net`, '--preserve-credentials', 'nft', '-f', rules]).exitCode
  const p = Bun.spawn(['unshare', '--user', '--net', 'sleep', '10'], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    // unshare execs sleep once the namespace is in place: the process then shows it
    for (let t = 0; t < 200 && readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').split('\0')[0] !== 'sleep'; t++) await Bun.sleep(10)
    expect(uidMapped(p.pid)).toBe(false)
    expect(nft(p.pid)).not.toBe(0) // what runIsolated hit when it did not wait
    writeFileSync(`/proc/${p.pid}/uid_map`, `0 ${process.getuid!()} 1\n`)
    expect(uidMapped(p.pid)).toBe(true)
    expect(nft(p.pid)).toBe(0)
  } finally { p.kill(9); await p.exited }
  expect(uidMapped(p.pid)).toBe(false) // gone
})

test('the rules and the seccomp program: host ports before the private ranges, the port rule after them; AF_UNIX allowed only when asked, io_uring always refused', () => {
  const r = nftRules(['172.31.1.2'], { hostPorts: [40001, 5022], outPorts: [80, 443, 53, 22] })
  const at = (s: string) => r.indexOf(s)
  expect(at('ip daddr 10.0.2.2 tcp dport { 40001, 5022 } accept')).toBeGreaterThan(0)
  expect(at('ip daddr 10.0.2.2 tcp dport')).toBeLessThan(at('ip daddr { 0.0.0.0/8'))
  expect(at('tcp dport != { 80, 443, 53, 22 } reject')).toBeGreaterThan(at('ip6 daddr {'))
  expect(r).toContain('udp dport != { 80, 443, 53, 22 } reject')
  expect(nftRules([], { outPorts: null })).not.toContain('dport !=')
  expect(nftRules([])).toContain('tcp dport != { 80, 443, 53, 22 } reject') // the default: the conversations' ports
  const open = unixBlockFilter('x64', { allowUnix: true })!
  expect(open.length).toBe(7 * 8)
  expect(open.readUInt32LE(4 * 8 + 4)).toBe(425)
  expect([...Array(7).keys()].map(i => open.readUInt32LE(i * 8 + 4))).not.toContain(41)
})

test.skipIf(!process.env.LIVE)('network (LIVE=1): real sites on 80 and 443 through slirp\'s DNS; a site on another port is refused', async () => {
  writeSkill({ net: { run: probeRun(['http://example.com/', 'https://example.com/', 'http://portquiz.net:8080/']) } })
  const r = await runSkill(deps, conv, 'user', 'wl', 'net', {})
  expect(r.text).toContain('http://example.com/ ok')
  expect(r.text).toContain('https://example.com/ ok')
  expect(r.text).toMatch(/http:\/\/portquiz\.net:8080\/ refused/)
}, 60_000)
