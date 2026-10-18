// Privileged skill actions from the owner's terminal: docs/credentials-and-skills.md
// 「終端機執行特權動作」 and router/skillcli.ts. Real bwrap runs. A run goes
// through runSkill: the role (the conversation's own or --role) and argument
// role checks refuse as for run_skill; the output lands in --out, never the
// conversation folder; skill_runs records terminal:<key>, outside the
// conversation's hourly limit; owner notices come back in the reply. --trial
// runs on a throwaway copy of the bot's databases (the real ones unchanged,
// the copy gone after, the changes listed); --trial-store keeps the copy for
// the next run (publish, then remove); --api points bots credentials at a
// local fake Bot API (only with a trial, only loopback), the token masked.
// --out and --trial-store may not lie in the state dir, the databases, a bot
// or conversation folder. skill refresh runs refreshAll for one skill in the
// daily queue (another approved skill with a refresh action does not run),
// recorded as terminal:refresh (not a daily refresh), failures masked. /router skill run|refresh only from the owner's terminal. Keep in
// sync with that section and docs/operations.md 「終端機 CLI」.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { hashSkill } from '../privskill'
import { runSkill, type SkillRunDeps } from '../skillrun'
import { REFRESH_CONV, type RefreshDeps } from '../skillrefresh'
import { parseSkillRun, folderRefusal, terminalRun, terminalRefresh, type Guard, type SkillRunOpts } from '../skillcli'
import { runCommand, type CommandDeps } from '../commands'
import type { Config } from '../config'

const TOKEN = '1234567890:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
let dir: string, db: RouterDb, deps: SkillRunDeps, conv: Conversation, skill: string, store: string, guard: Guard, told: string[]
let api: ReturnType<typeof Bun.serve>, hits: string[]

const SCRIPT = `#!/bin/bash
set -e
case "$1" in
  list) mkdir -p stickers; cp "$DB/log.jsonl" stickers/inventory.jsonl; echo "count=$(wc -l < "$DB/log.jsonl")" ;;
  publish)
    f=$(realpath "$2"); case "$f" in "$PWD"/*) ;; *) echo "outside the folder: $2"; exit 1 ;; esac
    echo "api: $(curl -s -X POST "$SB_API/addStickerToSet")"
    n=$(( $(wc -l < "$DB/log.jsonl") + 1 )); mkdir -p "$DB/images"; cp "$f" "$DB/images/$n.webp"
    echo "{\\"id\\":$n}" >> "$DB/log.jsonl"; echo "added #$n" ;;
  remove)
    curl -s -X POST "$SB_API/deleteStickerFromSet" > /dev/null
    grep -v "\\"id\\":$2}" "$DB/log.jsonl" > "$DB/t" || true; mv "$DB/t" "$DB/log.jsonl"; rm -f "$DB/images/$2.webp"; echo "removed #$2" ;;
  token) echo "$SB_API" ;;
  extract) echo "force=\${2:-no}" ;;
esac
`
const ALL = ['owner', 'admin', 'power', 'user']
const ACTIONS = {
  list: { run: ['bash', 'scripts/s.sh', 'list'], roles: ALL, store: { DB: 'tg-sticker' }, timeout: 30 },
  publish: { run: ['bash', 'scripts/s.sh', 'publish', '{webp}'], args: { webp: { pattern: '[A-Za-z0-9_./-]+' } }, roles: ALL, bots: { SB: 'baldeagle' }, store: { DB: 'tg-sticker' }, timeout: 30 },
  remove: { run: ['bash', 'scripts/s.sh', 'remove', '{index}'], args: { index: { pattern: '[0-9]+' } }, roles: ['owner', 'admin'], bots: { SB: 'baldeagle' }, store: { DB: { name: 'tg-sticker', mode: 'full' } }, timeout: 30 },
  token: { run: ['bash', 'scripts/s.sh', 'token'], roles: ALL, bots: { SB: 'baldeagle' }, timeout: 30 },
  extract: { run: ['bash', 'scripts/s.sh', 'extract', '{force?}'], args: { force: { flag: '--force', roles: ['owner', 'admin'] } }, roles: ALL, timeout: 30 },
}

/** Every file of a folder and its content. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, pre: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${pre}${e.name}/`)
      else out[`${pre}${e.name}`] = readFileSync(join(d, e.name), 'utf8')
    }
  }
  if (existsSync(root)) walk(root, '')
  return out
}
const opts = (o: Partial<SkillRunOpts>): SkillRunOpts => ({ conv: conv.key, skill: 'sticker', action: 'list', out: join(dir, 'out'), trial: false, args: {}, ...o })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-skillcli-'))
  mkdirSync(join(dir, 'state'))
  db = openRouterDb(join(dir, 'state', 'router.db'))
  skill = join(dir, 'home', 'bot1', '.claude', 'skills', 'sticker')
  mkdirSync(join(skill, 'scripts'), { recursive: true })
  writeFileSync(join(skill, 'scripts', 's.sh'), SCRIPT)
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: ACTIONS }))
  db.approveSkill(skill, 'sticker', hashSkill(skill), 'owner')
  store = join(dir, 'state', 'skill-store', 'bot1', 'tg-sticker')
  mkdirSync(join(store, 'images'), { recursive: true })
  writeFileSync(join(store, 'log.jsonl'), '{"id":1}\n{"id":2}\n')
  writeFileSync(join(store, 'images', '1.webp'), 'RIFF1')
  const folder = join(dir, 'home', 'bot1', 'group-100')
  mkdirSync(join(folder, '.chat'), { recursive: true })
  conv = { key: 'group-100', bot: 'cc', chat_id: '-100', type: 'group', folder, role: 'user', session_id: null, created_at: '' }
  hits = []
  api = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { const u = new URL(req.url); hits.push(u.pathname); return Response.json({ ok: true, result: true }) } })
  told = []
  deps = {
    db, home: join(dir, 'home'), credsRoot: join(dir, 'state', 'creds'), userHome: join(dir, 'fakehome'), hidden: [join(dir, 'home'), join(dir, 'state')], extraRo: [],
    storeRoot: join(dir, 'state', 'skill-store'), apiRoot: 'http://127.0.0.1:9',
    botDir: () => join(dir, 'home', 'bot1'),
    botCred: name => name === 'baldeagle' ? { token: TOKEN, methods: [] } : undefined,
    async exec(argv, env, timeoutMs) {
      const p = Bun.spawn(argv, { env, stdout: 'pipe', stderr: 'pipe' })
      const t = setTimeout(() => p.kill(9), timeoutMs)
      const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      clearTimeout(t)
      return { code: await p.exited, out: `${o}${e}`.trim() }
    },
    notifyOwner: (_c, t) => told.push(t),
  }
  mkdirSync(deps.userHome)
  guard = { home: join(dir, 'home'), stateDir: join(dir, 'state'), storeRoot: join(dir, 'state', 'skill-store'), protectedDirs: [join(dir, 'home', 'bot1'), folder] }
})
afterEach(() => { api.stop(true); db.close(); rmSync(dir, { recursive: true, force: true }) })

test('parseSkillRun: positions, options, JSON arguments with spaces; --out required; --api only with a trial and only loopback', () => {
  expect(parseSkillRun('group-100 sticker generate --out /x/o --role user {"prompt": "a  whale waving"}')).toEqual({ conv: 'group-100', skill: 'sticker', action: 'generate', out: '/x/o', role: 'user', trial: false, args: { prompt: 'a  whale waving' } })
  expect(parseSkillRun('k s a --out /o --trial-store /t --api http://127.0.0.1:8081')).toMatchObject({ trial: true, trialStore: '/t', api: 'http://127.0.0.1:8081', args: {} })
  expect(parseSkillRun('k s a --out /o --trial --bot cc')).toMatchObject({ trial: true })
  expect(parseSkillRun('k s a')).toEqual({ error: expect.stringContaining('要用 --out 指定輸出資料夾') })
  expect(parseSkillRun('k s --out /o')).toEqual({ error: expect.stringContaining('用法: cc-telegram-router cli skill run') })
  expect(parseSkillRun('k s a --out /o --api http://127.0.0.1:1')).toEqual({ error: expect.stringContaining('--api 只能跟 --trial 或 --trial-store 一起用') })
  expect(parseSkillRun('k s a --out /o --trial --api https://api.telegram.org')).toEqual({ error: expect.stringContaining('--api 只接受本機網址') })
  expect(parseSkillRun('k s a --out /o {"x":')).toEqual({ error: expect.stringContaining('參數要是 JSON 物件') })
  expect(parseSkillRun('k s a --out /o --nope')).toEqual({ error: expect.stringContaining('不認得的選項 --nope') })
  expect(parseSkillRun('k s a --out --trial')).toEqual({ error: expect.stringContaining('--out 後面要接值') })
})

test('folderRefusal: not relative, not the home itself, not in the state dir, the databases, a bot or conversation folder', () => {
  expect(folderRefusal('out', '--out ', guard)).toContain('要是絕對路徑')
  expect(folderRefusal(join(dir, 'home'), '--out ', guard)).toContain('不可以是 router 的家目錄')
  expect(folderRefusal(join(dir, 'state', 'x'), '--out ', guard)).toContain('stateDir')
  expect(folderRefusal(conv.folder, '--out ', guard)).toContain('不可以在對話或 bot 資料夾裡')
  expect(folderRefusal(join(conv.folder, 'media'), '--out ', guard)).toContain('不可以在對話或 bot 資料夾裡')
  expect(folderRefusal(join(dir, 'home', 'bot1', '.claude'), '--out ', guard)).toContain('不可以在對話或 bot 資料夾裡')
  expect(folderRefusal(join(dir, 'state', 'skill-store-work', 'a'), '--trial-store ', { ...guard, stateDir: '/nowhere' })).toContain('不可以在正式資料庫裡')
  expect(folderRefusal(join(dir, 'home', 'acceptance', 'run1'), '--out ', guard)).toBeNull()
})

test('a run as the conversation: output in --out only, skill_runs as terminal:<key>, outside (and not held to) the hourly limit; refusals as for run_skill', async () => {
  for (let i = 0; i < 10; i++) db.addSkillRun(conv.key, 'sticker', 'list', 'ok')
  expect((await runSkill(deps, conv, 'user', 'sticker', 'list', {})).text).toContain('一小時內已經用了 10 次')
  const before = snapshot(store)
  const r = await terminalRun(deps, conv, opts({}), guard)
  expect(r).toStartWith('skill run: ok\n技能 sticker 的 list, 以對話 group-100 (bot cc) 的身分, 角色 user, 輸出在 ' + join(dir, 'out'))
  expect(r).toContain('count=2')
  expect(readFileSync(join(dir, 'out', 'stickers', 'inventory.jsonl'), 'utf8')).toBe('{"id":1}\n{"id":2}\n')
  expect(existsSync(join(conv.folder, 'stickers'))).toBe(false)
  expect(snapshot(store)).toEqual(before)
  const since = new Date(Date.now() - 60_000).toISOString()
  expect(db.skillRunsSince('terminal:group-100', since)).toBe(1)
  expect(db.skillRunsSince(conv.key, since)).toBe(10)
  // the role: the conversation's, or --role; an argument limited to higher roles
  expect(await terminalRun(deps, conv, opts({ action: 'remove', args: { index: '2' } }), guard)).toStartWith('skill run: refused\n')
  expect(await terminalRun(deps, conv, opts({ action: 'remove', args: { index: '2' } }), guard)).toContain('技能 sticker 的 remove 不開放給 user 角色的對話')
  expect(await terminalRun(deps, conv, opts({ action: 'extract', args: { force: true } }), guard)).toContain('參數 force 只開放給 owner, admin 角色, 本對話角色 user 要提權')
  expect(await terminalRun(deps, conv, opts({ action: 'extract', role: 'admin', args: { force: true } }), guard)).toContain('force=--force')
  expect(await terminalRun(deps, conv, opts({ action: 'publish', args: { webp: 'a.webp; rm -rf /' } }), guard)).toContain('參數 webp 不符合格式')
  expect(await terminalRun(deps, conv, opts({ out: conv.folder }), guard)).toStartWith('skill run: refused\n--out 不可以在對話或 bot 資料夾裡')
  // a failed run: "failed", not "refused"
  writeFileSync(join(dir, 'out', 'x.webp'), 'RIFF')
  expect(await terminalRun(deps, conv, opts({ action: 'publish', args: { webp: '../outside.webp' } }), guard)).toStartWith('skill run: failed\n')
  expect(told).toEqual([])
})

test('--trial: a throwaway copy of the databases, the real ones unchanged, the copy gone, its changes listed; --api: the fake Bot API, the token masked', async () => {
  const before = snapshot(store)
  writeFileSync(join(dir, 'state', 'skill-store', 'bot1', 'other.txt'), 'x') // a file beside the databases
  mkdirSync(join(dir, 'out'), { recursive: true })
  writeFileSync(join(dir, 'out', 's.webp'), 'RIFFnew')
  const r = await terminalRun(deps, conv, opts({ action: 'publish', args: { webp: 's.webp' }, trial: true, api: `http://127.0.0.1:${api.port}` }), guard)
  expect(r).toStartWith('skill run: ok\n')
  expect(r).toContain(`試跑 (資料庫用拋棄式複本, Bot API 改成 http://127.0.0.1:${api.port})`)
  expect(r).toContain('added #3')
  expect(r).toContain('api: {"ok":true,"result":true}')
  expect(r).toContain('試跑資料庫的變動: \n新增 tg-sticker/images/3.webp (7 bytes)\n修改 tg-sticker/log.jsonl (18 -> 27 bytes, 2 -> 3 行)')
  expect(hits).toEqual([`/bot${TOKEN}/addStickerToSet`])
  expect(snapshot(store)).toEqual(before)
  expect(readdirSync(join(dir, 'state', 'skill-store-trial'))).toEqual([])
  // the token never comes back, even from a trial
  const t = await terminalRun(deps, conv, opts({ action: 'token', trial: true, api: `http://127.0.0.1:${api.port}` }), guard)
  expect(t).toContain(`http://127.0.0.1:${api.port}/bot<已遮蔽>`)
  expect(t).not.toContain(TOKEN)
  expect(t).toContain('[owner 通知] ⚠️ 技能 sticker 的 token 在 group-100 的輸出含有憑證內容')
  expect(told).toEqual([])
})

test('--trial-store: the copy is kept and seeded once, so publish then remove (owner) follow one another; the real databases never change', async () => {
  const before = snapshot(store)
  const copy = join(dir, 'trial')
  mkdirSync(join(dir, 'out'), { recursive: true })
  writeFileSync(join(dir, 'out', 's.webp'), 'RIFFnew')
  const fake = `http://127.0.0.1:${api.port}`
  const p = await terminalRun(deps, conv, opts({ action: 'publish', args: { webp: 's.webp' }, trial: true, trialStore: copy, api: fake }), guard)
  expect(p).toContain(`資料庫複本在 ${copy}`)
  expect(readFileSync(join(copy, 'bot1', 'tg-sticker', 'log.jsonl'), 'utf8')).toBe('{"id":1}\n{"id":2}\n{"id":3}\n')
  expect(readFileSync(join(copy, 'bot1', 'tg-sticker', 'images', '3.webp'), 'utf8')).toBe('RIFFnew')
  const rm = await terminalRun(deps, conv, opts({ action: 'remove', role: 'owner', args: { index: '3' }, trial: true, trialStore: copy, api: fake }), guard)
  expect(rm).toStartWith('skill run: ok\n')
  expect(rm).toContain('removed #3')
  expect(rm).toContain('刪除 tg-sticker/images/3.webp')
  expect(readFileSync(join(copy, 'bot1', 'tg-sticker', 'log.jsonl'), 'utf8')).toBe('{"id":1}\n{"id":2}\n')
  expect(hits.map(h => h.split('/').pop())).toEqual(['addStickerToSet', 'deleteStickerFromSet'])
  expect(snapshot(store)).toEqual(before)
  expect(existsSync(`${copy}-work`)).toBe(false)
  expect(await terminalRun(deps, conv, opts({ trial: true, trialStore: join(dir, 'state', 'skill-store', 'x') }), guard)).toContain('--trial-store 不可以在 router 的 stateDir 裡')
})

test('a skill changed since approval: refused, the owner notice in the reply, not sent', async () => {
  writeFileSync(join(skill, 'scripts', 's.sh'), SCRIPT + '\n# changed\n')
  const r = await terminalRun(deps, conv, opts({}), guard)
  expect(r).toStartWith('skill run: refused\n')
  expect(r).toContain('[owner 通知] ⚠️ 技能 sticker 的檔案在核准後被改過')
  expect(told).toEqual([])
})

test('skill refresh: refreshAll for one skill in the given queue, recorded as terminal:refresh (not a daily refresh); a failure masked, its notice in the reply', async () => {
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: {
    get: { run: ['bash', '-c', 'echo get'], roles: ALL, creds: { C: 'c1' }, refresh: 'renew', auth_failure: 'reason=auth' },
    renew: { run: ['bash', '-c', 'if [ -f "$C/k" ]; then cat "$C/k"; exit 3; fi; echo SECRETVALUE0123456789abc > "$C/k"; echo renewed'], creds: { C: 'c1' }, internal: true },
  } }))
  db.approveSkill(skill, 'sticker', hashSkill(skill), 'owner')
  const notified: string[] = []
  const rd: RefreshDeps = { ...deps, stateDir: join(dir, 'state'), botOf: () => 'cc', notify: (_b, t) => notified.push(t) }
  let queued = 0
  const enqueue = <T>(fn: () => Promise<T>) => { queued++; return fn() }
  const ok = await terminalRefresh(rd, 'sticker', enqueue)
  expect(ok).toBe('skill refresh: ok\nsticker/renew: ok\nrenewed')
  expect(queued).toBe(1)
  const bad = await terminalRefresh(rd, 'sticker', enqueue)
  expect(bad).toStartWith('skill refresh: failed\nsticker/renew: failed\n<已遮蔽>')
  expect(bad).toContain('[owner 通知] ⚠️ 技能 sticker 的每日憑證更新 (renew) 失敗, exit 3')
  expect(bad).not.toContain('SECRETVALUE0123456789abc')
  expect(notified).toEqual([])
  expect(db.lastSkillRunAt('terminal:refresh', 'sticker', 'ok')).not.toBeNull()
  expect(db.lastSkillRunAt(REFRESH_CONV, 'sticker', 'ok')).toBeNull()
  expect(await terminalRefresh(rd, 'nope')).toStartWith('skill refresh: none\n技能 nope 沒有核准紀錄')
})

test('skill refresh <技能> runs only that skill: of two approved skills with a refresh action, the other one has no skill_runs row and its credentials are untouched', async () => {
  const refreshing = (cred: string) => ({ actions: {
    get: { run: ['bash', '-c', 'echo get'], roles: ALL, creds: { C: cred }, refresh: 'renew', auth_failure: 'reason=auth' },
    renew: { run: ['bash', '-c', 'echo fresh > "$C/k"; echo renewed'], creds: { C: cred }, internal: true },
  } })
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify(refreshing('c1')))
  db.approveSkill(skill, 'sticker', hashSkill(skill), 'owner')
  const other = join(dir, 'home', 'bot1', '.claude', 'skills', 'other')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'privileged.json'), JSON.stringify(refreshing('c2')))
  db.approveSkill(other, 'other', hashSkill(other), 'owner')
  const rd: RefreshDeps = { ...deps, stateDir: join(dir, 'state'), botOf: () => 'cc', notify: () => {} }
  expect(await terminalRefresh(rd, 'sticker')).toBe('skill refresh: ok\nsticker/renew: ok\nrenewed')
  expect(db.lastSkillRunAt('terminal:refresh', 'sticker', 'ok')).not.toBeNull()
  for (const status of ['ok', 'failed', 'skipped']) {
    expect(db.lastSkillRunAt('terminal:refresh', 'other', status)).toBeNull()
    expect(db.lastSkillRunAt(REFRESH_CONV, 'other', status)).toBeNull()
  }
  expect(existsSync(join(dir, 'state', 'creds', 'c1', 'k'))).toBe(true)
  expect(existsSync(join(dir, 'state', 'creds', 'c2', 'k'))).toBe(false)
  expect(existsSync(join(dir, 'state', 'skill-refresh', 'other'))).toBe(false)
})

test('/router skill run|refresh: only the owner\'s terminal; the conversation found by key or chat id; the JSON arguments passed whole', async () => {
  const OWNER = '111'
  db.insertConversation({ ...conv, created_at: new Date().toISOString() })
  const calls: Array<{ conv: string; o: SkillRunOpts } | string> = []
  const cfg = { path: join(dir, 'state', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: join(dir, 'home'), stateDir: join(dir, 'state'), socket: join(dir, 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude' } as Config
  const cdeps = { cfg, db, skills: { list: () => '', approve: () => '', revoke: () => '', run: async (c: Conversation, o: SkillRunOpts) => { calls.push({ conv: c.key, o }); return 'skill run: ok' }, refresh: async (s: string) => { calls.push(s); return 'skill refresh: ok' } } } as unknown as CommandDeps
  const run = (text: string, terminal: boolean) => runCommand({ bot: 'cc', text, senderId: OWNER, senderName: 'n', chatId: OWNER, chatType: 'private', terminal }, cdeps)
  expect((await run('/router skill run group-100 sticker list --out /tmp/o', false))!.reply).toBe('⛔ /router skill run 只在 owner 的終端機執行 (cc-telegram-router cli skill run ...)')
  expect((await run('/router skill refresh sticker', false))!.reply).toStartWith('⛔ /router skill refresh 只在 owner 的終端機執行')
  expect(calls).toEqual([])
  expect((await run('/router skill run group-100 sticker generate --out /tmp/o --role user {"prompt": "a  whale"}', true))!.reply).toBe('skill run: ok')
  expect((await run('/router skill run -100 sticker list --out /tmp/o --trial', true))!.reply).toBe('skill run: ok')
  expect(calls).toEqual([
    { conv: 'group-100', o: { conv: 'group-100', skill: 'sticker', action: 'generate', out: '/tmp/o', role: 'user', trial: false, args: { prompt: 'a  whale' } } },
    { conv: 'group-100', o: { conv: '-100', skill: 'sticker', action: 'list', out: '/tmp/o', trial: true, args: {} } },
  ])
  expect((await run('/router skill run group-100 sticker list --out /tmp/o --role boss', true))!.reply).toStartWith('沒有這個角色: boss')
  expect((await run('/router skill run dm-404 sticker list --out /tmp/o', true))!.reply).toStartWith('找不到對話 dm-404')
  expect((await run('/router skill refresh sticker', true))!.reply).toBe('skill refresh: ok')
  expect(calls.at(-1)).toBe('sticker')
})
