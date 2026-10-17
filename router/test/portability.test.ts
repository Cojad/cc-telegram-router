// Install location (docs/operations.md 「安裝位置」, docs/testing.md
// 安裝位置驗收對照): the router may be
// installed anywhere, nothing assumes /x. Every test here uses temporary
// install locations: the role templates' sandbox, the privileged skill
// bwrap, the locator that the plugin and the hook find the router by,
// `register` and deploy/install.sh follow them.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Config } from '../config'
import { loadConfig, parseDenyRead, hiddenPaths } from '../config'
import { renderSettings, applyOverrides, fill, outermost } from '../settings'
import { sandboxArgv } from '../privskill'
import { openRouterDb, type RouterDb } from '../db'
import { ensureConversation, findByFolder } from '../conversations'
import { createIpc } from '../ipc'
import { locatorPath, readLocator, writeLocator, syncLocator, findRouter } from '../../shared/locate'

const REPO = join(import.meta.dir, '..', '..')
const TEMPLATES = join(REPO, 'templates')
const SANDBOXED = ['admin', 'power', 'user', 'guest']
let dir: string
let userHome: string
let cfg: Config
let db: RouterDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-port-'))
  userHome = join(dir, 'user')
  mkdirSync(userHome)
  const home = join(dir, 'srv', 'tg')
  const stateDir = join(dir, 'var', 'cc-router') // not under home
  mkdirSync(home, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  cfg = {
    path: join(stateDir, 'config.json'), bots: [{ name: 'main', token: '1:x' }], home, stateDir, socket: join(stateDir, 'r.sock'),
    owners: ['1000001'], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude', credentials: {}, sandboxDenyRead: [join(dir, 'other-projects')],
  }
  db = openRouterDb(join(stateDir, 'router.db'))
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** process.env without the test-only socket override, HOME pointing at a temp user home. */
const envAt = (extra: Record<string, string>) => {
  const e: Record<string, string> = { ...process.env as Record<string, string>, HOME: userHome, ...extra }
  delete e.CC_TELEGRAM_ROUTER_SOCKET
  delete e.CC_TELEGRAM_ROUTER_HOME
  return e
}

// --- config sandboxDenyRead and hiddenPaths ---------------------------------

test('config sandboxDenyRead: absolute paths kept, the rest left out with a warning; default none', () => {
  const w: string[] = []
  expect(parseDenyRead(undefined, w)).toEqual([])
  expect(parseDenyRead(['/x', '/data/other/', 'relative', '/', 5], w)).toEqual(['/x', '/data/other'])
  expect(w).toEqual([
    'sandboxDenyRead 的 "relative" 不是絕對路徑 (也不能是 /), 略過',
    'sandboxDenyRead 的 "/" 不是絕對路徑 (也不能是 /), 略過',
    'sandboxDenyRead 的 5 不是絕對路徑 (也不能是 /), 略過',
  ])
  const w2: string[] = []
  expect(parseDenyRead('/x', w2)).toEqual([])
  expect(w2[0]).toStartWith('sandboxDenyRead 要是路徑陣列')
  // loadConfig: a wrong entry only warns, the router still starts
  writeFileSync(cfg.path, JSON.stringify({ bots: [{ name: 'main', token: '1:x' }], home: cfg.home, sandboxDenyRead: ['/x', 'oops'] }))
  const c = loadConfig(cfg.path)
  expect(c.sandboxDenyRead).toEqual(['/x'])
  expect(c.warnings).toEqual(['sandboxDenyRead 的 "oops" 不是絕對路徑 (也不能是 /), 略過'])
  writeFileSync(cfg.path, JSON.stringify({ bots: [{ name: 'main', token: '1:x' }] }))
  expect(loadConfig(cfg.path).sandboxDenyRead).toEqual([])
})

test('hiddenPaths: the router home, the state dir when it lies elsewhere, sandboxDenyRead; nested and duplicate paths collapse', () => {
  expect(hiddenPaths(cfg)).toEqual([cfg.home, join(dir, 'other-projects'), cfg.stateDir].sort((a, b) => a.length - b.length))
  // the default layout: <home>/.router is inside home
  expect(hiddenPaths({ home: '/srv/tg', stateDir: '/srv/tg/.router', sandboxDenyRead: [] })).toEqual(['/srv/tg'])
  expect(hiddenPaths({ home: '/x/cc', stateDir: '/x/cc/.router', sandboxDenyRead: ['/x'] })).toEqual(['/x'])
  expect(outermost(['/a/b', '/a', '/ab', '/a/', '/c/d/e', '/c/d'])).toEqual(['/a', '/ab', '/c/d'])
})

// --- role templates ---------------------------------------------------------

test('fill splices a list into an array; a sandbox with unfilled hidden paths is refused', () => {
  expect(fill({ a: ['{{h}}', '~', 'x{{n}}'], b: '{{h}}', n: '{{n}}' }, { h: ['/p', '/q'], n: 3 })).toEqual({ a: ['/p', '/q', '~', 'x3'], b: ['/p', '/q'], n: 3 })
  for (const role of SANDBOXED) expect(() => renderSettings(TEMPLATES, role, { folder: '/srv/tg/g' })).toThrow(`role ${role}: sandbox denyRead "{{hidden}}" not filled`)
  expect(() => renderSettings(TEMPLATES, 'owner', { folder: '/srv/tg/g' })).not.toThrow() // no sandbox
})

test('role templates follow the install: denyRead is the router home, the state dir, sandboxDenyRead and ~; no fixed path left', () => {
  for (const f of readdirSync(join(TEMPLATES, 'roles'))) expect(readFileSync(join(TEMPLATES, 'roles', f), 'utf8')).not.toMatch(/"\/x[/"]/)
  const folder = join(cfg.home, 'bot1', 'group-100555')
  const vars = { folder, home: cfg.home, hidden: hiddenPaths(cfg), botDir: join(cfg.home, 'bot1'), autoCompactWindow: 750000, hooksDir: join(cfg.stateDir, 'hooks'), transcripts: '/t' }
  for (const role of SANDBOXED) {
    const s = renderSettings(TEMPLATES, role, vars) as any
    expect(s.sandbox.filesystem.denyRead).toEqual([...hiddenPaths(cfg), '~'])
    expect(s.sandbox.filesystem.allowRead[0]).toBe(folder) // its own folder reopened inside the hidden home
    expect(JSON.stringify(s)).not.toMatch(/"\/x[/"]/)
  }
  // /router perm path read reopens a path inside a hidden one, the hidden list stays
  const s = applyOverrides(renderSettings(TEMPLATES, 'user', vars), [{ conv: 'g', kind: 'path-read', value: join(dir, 'other-projects', 'shared') } as any]) as any
  expect(s.sandbox.filesystem.allowRead).toContain(join(dir, 'other-projects', 'shared'))
  expect(s.sandbox.filesystem.denyRead).toEqual([...hiddenPaths(cfg), '~'])
})

// --- privileged skill bwrap -------------------------------------------------

test('skill bwrap: tmpfs over /tmp, $HOME and the hidden paths (existing, not nested, not under /tmp), all before the binds', () => {
  const sb = sandboxArgv({ argv: ['true'], skillDir: '/srv/tg/.claude/skills/s', convFolder: '/srv/tg/bot1/dm-7', creds: {}, home: '/home/u', hidden: ['/srv/tg', '/srv/tg/.router', '/nonexistent-cctr', join(dir, 'var')], extraRo: [] })
  const a = sb.argv
  const tmpfs = a.flatMap((x, i) => x === '--tmpfs' ? [a[i + 1]] : [])
  // /srv/tg does not exist here: left out, like any missing path; dir/var is under /tmp
  expect(tmpfs).toEqual(['/tmp', ...(existsSync('/home/u') ? ['/home/u'] : [])])
  const real = sandboxArgv({ argv: ['true'], skillDir: '/s', convFolder: '/c', creds: {}, home: userHome, hidden: ['/usr/share/doc', '/usr/share'], extraRo: [] }).argv
  expect(real.flatMap((x, i) => x === '--tmpfs' ? [real[i + 1]] : [])).toEqual(['/tmp', '/usr/share'])
  expect(real.lastIndexOf('--tmpfs')).toBeLessThan(real.indexOf('--ro-bind', 5))
  expect(a).not.toContain('/x')
})

// A real bwrap run with an install outside /tmp and $HOME (/var/tmp), so the
// hidden paths themselves have to do the hiding.
const VARTMP = (() => { try { const d = mkdtempSync('/var/tmp/cctr-port-'); rmSync(d, { recursive: true }); return Bun.which('bwrap') ? '/var/tmp' : null } catch { return null } })()
test.skipIf(!VARTMP)('skill bwrap, real run: other conversations, the state dir elsewhere and sandboxDenyRead are hidden; its own folder is not', async () => {
  const root = mkdtempSync(join(VARTMP!, 'cctr-port-'))
  try {
    const home = join(root, 'tg'), state = join(root, 'state'), extra = join(root, 'other')
    const own = join(home, 'bot1', 'dm-7'), sibling = join(home, 'bot1', 'dm-8'), skill = join(home, '.claude', 'skills', 's')
    for (const d of [own, sibling, skill, state, extra]) mkdirSync(d, { recursive: true })
    writeFileSync(join(own, 'mine.txt'), 'MINE\n')
    writeFileSync(join(sibling, 'secret.txt'), 'SIBLING\n')
    writeFileSync(join(state, 'config.json'), 'STATE\n')
    writeFileSync(join(extra, 'x.txt'), 'EXTRA\n')
    writeFileSync(join(skill, 'run.sh'), `for f in ${own}/mine.txt ${sibling}/secret.txt ${state}/config.json ${extra}/x.txt; do cat $f 2>/dev/null || echo HIDDEN; done\n`)
    const sb = sandboxArgv({ argv: ['bash', join(skill, 'run.sh')], skillDir: skill, convFolder: own, creds: {}, home: userHome, hidden: hiddenPaths({ home, stateDir: state, sandboxDenyRead: [extra] }), extraRo: [] })
    const p = Bun.spawn(sb.argv, { env: sb.env, stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(p.stdout).text()
    const err = await new Response(p.stderr).text()
    expect(await p.exited, err).toBe(0)
    expect(out.trim().split('\n')).toEqual(['MINE', 'HIDDEN', 'HIDDEN', 'HIDDEN'])
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 20000)

// --- locator: how the plugin and the hook find the router -------------------

test('locator: written and read back; malformed or relative is none; the router keeps it in step only when it is the one named', () => {
  const file = locatorPath(userHome)
  expect(file).toBe(join(userHome, '.config', 'cc-telegram-router', 'router.json'))
  expect(readLocator(file)).toBeNull()
  const me = { home: cfg.home, stateDir: cfg.stateDir, socket: cfg.socket }
  expect(syncLocator(me, file)).toBe('missing')
  expect(existsSync(file)).toBe(false) // never created by a starting router
  writeLocator(me, file)
  expect(readLocator(file)).toEqual(me)
  expect(syncLocator(me, file)).toBe('ok')
  expect(syncLocator({ ...me, socket: join(cfg.stateDir, 'new.sock') }, file)).toBe('updated')
  expect(readLocator(file)!.socket).toBe(join(cfg.stateDir, 'new.sock'))
  expect(syncLocator({ home: '/elsewhere', stateDir: '/elsewhere/.router', socket: '/elsewhere/.router/router.sock' }, file)).toBe('other')
  expect(readLocator(file)!.home).toBe(cfg.home) // another router (a test, a second install) does not touch it
  writeFileSync(file, JSON.stringify({ home: 'rel', stateDir: '/a', socket: '/a/s' }))
  expect(readLocator(file)).toBeNull()
})

test('findRouter: the locator in the user home; the test-only env override; none says how to fix it', () => {
  writeLocator({ home: cfg.home, stateDir: cfg.stateDir, socket: cfg.socket }, locatorPath(userHome))
  expect(findRouter({ HOME: userHome })).toEqual({ socket: cfg.socket, home: cfg.home })
  expect(findRouter({ HOME: userHome, CC_TELEGRAM_ROUTER_SOCKET: '/a/.router/s' })).toEqual({ socket: '/a/.router/s', home: '/a' })
  expect(findRouter({ HOME: userHome, CC_TELEGRAM_ROUTER_SOCKET: '/a/s', CC_TELEGRAM_ROUTER_HOME: '/b' })).toEqual({ socket: '/a/s', home: '/b' })
  expect(findRouter({ HOME: join(dir, 'nobody') })).toEqual({ error: `找不到 ${locatorPath(join(dir, 'nobody'))} (deploy/install.sh router 或 cc-telegram-router register 會寫入)` })
  writeFileSync(locatorPath(userHome), '{')
  expect(findRouter({ HOME: userHome })).toEqual({ error: `${locatorPath(userHome)} 格式不對` })
})

test('cc-telegram-router register writes the locator from config.json (relative paths resolved)', async () => {
  writeFileSync(cfg.path, JSON.stringify({ bots: [{ name: 'main', token: '1:x' }], home: '../../srv/tg', socket: 'r.sock' }))
  const p = Bun.spawn(['bun', join(REPO, 'router', 'main.ts'), '--config', cfg.path, 'register'], { env: envAt({}), stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  expect(await p.exited).toBe(0)
  expect(readLocator(locatorPath(userHome))).toEqual({ home: cfg.home, stateDir: cfg.stateDir, socket: cfg.socket })
  expect(out.trim()).toBe(`已寫入 ${locatorPath(userHome)}: home ${cfg.home}, socket ${cfg.socket}`)
}, 20000)

function startIpc(got: unknown[]) {
  return createIpc({
    cfg, db,
    identify(projectDir) {
      if (projectDir === cfg.home) return { mode: 'terminal', conv: null, role: 'owner' }
      const c = findByFolder(db, projectDir)
      return c ? { mode: 'worker', conv: c, role: c.role } : null
    },
    async onCall(peer, tool) { return { content: [{ type: 'text', text: `ok ${tool} for ${peer.conv?.key ?? 'terminal'}` }] } },
    onHook(peer, ev) { got.push({ key: peer.conv?.key, ev }); return {} },
  })
}

test('plugin finds the router through the locator, wherever it is installed; no locator: not a worker, and says why', async () => {
  const conv = ensureConversation(cfg, db, 'main', '-100555', 'supergroup', () => {})
  const ipc = startIpc([])
  const plugin = async (env: Record<string, string>) => {
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
    await client.connect(new StdioClientTransport({ command: 'bun', args: [join(REPO, 'plugin', 'server.ts')], env }))
    return client
  }
  try {
    // no locator yet
    const none = await plugin(envAt({ CLAUDE_PROJECT_DIR: conv.folder }))
    const r: any = await none.callTool({ name: 'reply', arguments: { chat_id: '-100555', text: 'x' } })
    expect(r.content[0].text).toBe(`not a Telegram worker: 找不到 ${locatorPath(userHome)} (deploy/install.sh router 或 cc-telegram-router register 會寫入)`)
    await none.close()
    writeLocator({ home: cfg.home, stateDir: cfg.stateDir, socket: cfg.socket }, locatorPath(userHome))
    const worker = await plugin(envAt({ CLAUDE_PROJECT_DIR: conv.folder, CC_TELEGRAM_CHANNEL_GRACE_MS: '50' }))
    expect(await ipc.waitConnected(conv.key, 5000)).toBe(true)
    const ok: any = await worker.callTool({ name: 'reply', arguments: { chat_id: '-100555', text: 'yo' } })
    expect(ok.content[0].text).toBe(`ok reply for ${conv.key}`)
    await worker.close()
    // the owner's terminal session (cwd = the router home) is found the same way
    const term = await plugin(envAt({ CLAUDE_PROJECT_DIR: cfg.home, CC_TELEGRAM_CHANNEL_GRACE_MS: '50' }))
    let t: any
    for (let i = 0; i < 60; i++) { t = await term.callTool({ name: 'reply', arguments: { chat_id: '1', text: 'x' } }); if (!t.isError) break; await sleep(50) }
    expect(t.content[0].text).toBe('ok reply for terminal')
    await term.close()
    // outside the router home: not a worker
    const out = await plugin(envAt({ CLAUDE_PROJECT_DIR: join(dir, 'elsewhere') }))
    const o: any = await out.callTool({ name: 'reply', arguments: { chat_id: '1', text: 'x' } })
    expect(o.content[0].text).toBe(`not a Telegram worker: ${join(dir, 'elsewhere')} is outside ${cfg.home}`)
    await out.close()
  } finally { ipc.stop() }
}, 30000)

test('cc-hook finds the router through the locator; without one it is unreachable (no leaving the sandbox)', async () => {
  const conv = ensureConversation(cfg, db, 'main', '-100555', 'supergroup', () => {})
  const got: any[] = []
  const ipc = startIpc(got)
  const hook = async (event: string, input: object) => {
    const p = Bun.spawn(['bun', join(REPO, 'hooks', 'hook.ts'), 'progress', event], {
      stdin: new Blob([JSON.stringify({ cwd: conv.folder, ...input })]), stdout: 'pipe', env: envAt({ CLAUDE_PROJECT_DIR: conv.folder }),
    })
    const out = await new Response(p.stdout).text()
    await p.exited
    return out ? JSON.parse(out).hookSpecificOutput : null
  }
  const esc = { tool_name: 'Bash', tool_input: { command: 'ls /', dangerouslyDisableSandbox: true } }
  try {
    expect(await hook('pre', esc)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'router unreachable: no unsandboxed commands' })
    expect(got).toEqual([])
    writeLocator({ home: cfg.home, stateDir: cfg.stateDir, socket: cfg.socket }, locatorPath(userHome))
    await hook('stop', {})
    for (let i = 0; i < 40 && !got.length; i++) await sleep(25)
    expect(got).toEqual([{ key: conv.key, ev: { event: 'stop' } }])
  } finally { ipc.stop() }
}, 30000)

// --- deploy/install.sh ------------------------------------------------------

test('install.sh: no fixed default; without CC_ROUTER_STATE or an earlier install it stops and says how', async () => {
  const sh = readFileSync(join(REPO, 'deploy', 'install.sh'), 'utf8')
  expect(sh).not.toContain('/x/')
  for (const job of ['router', 'unit']) {
    const p = Bun.spawn(['bash', join(REPO, 'deploy', 'install.sh'), job], { env: envAt({}), stdout: 'pipe', stderr: 'pipe' })
    const err = await new Response(p.stderr).text()
    expect(await p.exited).toBe(1)
    expect(err.trim()).toBe(`沒有指定安裝位置: 第一次安裝請用 CC_ROUTER_STATE=<home>/.router install.sh ${job} (例如 CC_ROUTER_STATE=$HOME/cc/.router)`)
  }
  expect(existsSync(join(userHome, '.config', 'systemd'))).toBe(false)
})

test('the plugin, hook and shared code name no install path', () => {
  for (const f of ['plugin/server.ts', 'hooks/hook.ts', 'shared/protocol.ts', 'shared/locate.ts', 'router/privskill.ts', 'router/config.ts'])
    expect(readFileSync(join(REPO, f), 'utf8')).not.toMatch(/['"`]\/x[/'"`]/)
})
