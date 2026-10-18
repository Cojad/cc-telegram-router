// A privileged skill action's database (store) and bot token credentials
// (bots): docs/credentials-and-skills.md 「特權技能」 (資料庫 store, bot 憑證
// bots) and router/skillstore.ts. Real bwrap runs. append: deleting a file,
// changing one, changing an old .jsonl line, an invalid or empty JSON line, a
// file over 5 MB, more than 20 MB in a run, a symlink or fifo, a folder the
// script made unreadable, all void the run and
// leave the database as it was (the conversation told why, the owner
// notified); valid new files and lines are written back. full: deletions and
// changes written back; full on an action open to user or power refused when
// privileged.json is read. Runs on one database queue across conversations;
// the database is hidden from the conversation and other actions. bots: only
// telegram-bot credentials; the token never comes back (output, files the
// run wrote, the database); store, bots and http together in one action. Keep in sync with that section and
// /telegram:bot-skill.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { hashSkill, loadManifest } from '../privskill'
import { runSkill, describeActions, type SkillRunDeps } from '../skillrun'

const TOKEN = '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const MB = 1024 * 1024
let dir: string, db: RouterDb, deps: SkillRunDeps, conv: Conversation, conv2: Conversation, skill: string, told: string[], store: string

const SCRIPT = `#!/bin/bash
cd "$DB" || exit 9
case "$1" in
  add) mkdir -p img && printf 'WEBP' > img/b.webp && echo '{"id":2,"emoji":"🐳"}' >> log.jsonl && echo '{"id":1}' > new.jsonl ;;
  rm) rm keep.txt ;;
  rmdir) rmdir empty ;;
  edit) echo more >> keep.txt ;;
  oldline) sed -i 's/"id":1/"id":9/' log.jsonl ;;
  badjson) echo 'not json' >> log.jsonl ;;
  emptyline) printf '\\n' >> log.jsonl ;;
  noeol) printf '{"id":3}' >> log.jsonl ;;
  big) head -c ${6 * MB} /dev/zero > big.bin ;;
  total) for i in 1 2 3 4 5; do head -c ${4 * MB + 512 * 1024} /dev/zero > part$i.bin; done ;;
  link) ln -s /etc/hostname link ;;
  fifo) mkfifo pipe ;;
  noperm) chmod 000 img ;;
  fail) echo '{"id":2}' >> log.jsonl; exit 1 ;;
  slow) date +%s%N >> "$OLDPWD/times"; sleep 0.4; echo '{"run":1}' >> log.jsonl; date +%s%N >> "$OLDPWD/times" ;;
esac
echo "done $1"
`

function writeSkill(actions: Record<string, unknown>) {
  mkdirSync(join(skill, 'scripts'), { recursive: true })
  writeFileSync(join(skill, 'scripts', 'store.sh'), SCRIPT)
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions }))
  db.approveSkill(skill, 'sticker', hashSkill(skill), 'owner')
}
const op = { pattern: '[a-z]+' }
const appendAction = { run: ['bash', 'scripts/store.sh', '{op}'], args: { op }, roles: ['user', 'power', 'admin', 'owner'], store: { DB: 'tg-sticker' }, timeout: 30 }

function seed() {
  mkdirSync(join(store, 'empty'), { recursive: true })
  mkdirSync(join(store, 'img'), { recursive: true })
  writeFileSync(join(store, 'keep.txt'), 'keep\n')
  writeFileSync(join(store, 'img', 'a.webp'), 'RIFFxxxxWEBP')
  writeFileSync(join(store, 'log.jsonl'), '{"id":1}\n')
}
/** Every file of the database and its content, folders as "/". */
function snapshot(root = store): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, pre: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { out[`${pre}${e.name}/`] = ''; walk(join(d, e.name), `${pre}${e.name}/`) }
      else out[`${pre}${e.name}`] = readFileSync(join(d, e.name), 'utf8')
    }
  }
  if (existsSync(root)) walk(root, '')
  return out
}

function mkConv(key: string): Conversation {
  const folder = join(dir, 'home', 'bot1', key)
  mkdirSync(join(folder, '.chat'), { recursive: true })
  return { key, bot: 'cc', chat_id: key.replace(/\D/g, ''), type: 'dm', folder, role: 'user', session_id: null, created_at: '' }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-store-'))
  mkdirSync(join(dir, 'state'))
  db = openRouterDb(join(dir, 'state', 'router.db'))
  skill = join(dir, 'home', 'bot1', '.claude', 'skills', 'sticker')
  store = join(dir, 'state', 'skill-store', 'bot1', 'tg-sticker')
  conv = mkConv('dm-7')
  conv2 = mkConv('dm-8')
  told = []
  deps = {
    db, home: join(dir, 'home'), credsRoot: join(dir, 'state', 'creds'), userHome: join(dir, 'fakehome'), hidden: [join(dir, 'home'), join(dir, 'state')], extraRo: [],
    storeRoot: join(dir, 'state', 'skill-store'), apiRoot: 'http://127.0.0.1:9',
    botDir: () => join(dir, 'home', 'bot1'),
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
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('append: new files and new .jsonl lines are written back; a missing database starts empty; the staged copy is gone after', async () => {
  writeSkill({ put: appendAction })
  expect(describeActions(skill)).toContain('資料庫 tg-sticker (append)')
  const first = await runSkill(deps, conv, 'user', 'sticker', 'put', { op: 'noop' })
  expect(first.ok).toBe(true)
  expect(snapshot()).toEqual({}) // created empty, nothing written
  seed()
  const r = await runSkill(deps, conv, 'user', 'sticker', 'put', { op: 'add' })
  expect(r.text).toContain('done add')
  expect(r.ok).toBe(true)
  expect(snapshot()).toEqual({ 'empty/': '', 'img/': '', 'img/a.webp': 'RIFFxxxxWEBP', 'img/b.webp': 'WEBP', 'keep.txt': 'keep\n', 'log.jsonl': '{"id":1}\n{"id":2,"emoji":"🐳"}\n', 'new.jsonl': '{"id":1}\n' })
  expect(readdirSync(join(dir, 'state', 'skill-store-work'))).toEqual([])
  expect(told).toEqual([])
})

for (const [opName, why] of [
  ['rm', 'keep.txt 被刪除了'],
  ['rmdir', 'empty 被刪除了'],
  ['edit', 'keep.txt 的內容被改了'],
  ['oldline', 'log.jsonl 原有的內容被改了'],
  ['badjson', '第 1 行不是合法 JSON'],
  ['emptyline', '第 1 行是空行'],
  ['noeol', '要以換行結尾'],
  ['big', '超過單檔上限'],
  ['total', '超過單次上限'],
  ['link', '不是一般檔案或資料夾'],
  ['fifo', '不是一般檔案或資料夾'],
  ['noperm', 'tg-sticker 檢查失敗'],
] as const) {
  test(`append: ${opName} voids the whole run, the database unchanged, the conversation told why, the owner notified`, async () => {
    writeSkill({ put: appendAction })
    seed()
    const before = snapshot()
    const r = await runSkill(deps, conv, 'user', 'sticker', 'put', { op: opName })
    expect(r.text).toContain(`done ${opName}`) // the script itself ran to the end
    expect(r.ok).toBe(false)
    expect(r.text).toContain('資料庫 tg-sticker 未寫回, 整次作廢')
    expect(r.text).toContain(why)
    expect(snapshot()).toEqual(before)
    expect(told.length).toBe(1)
    expect(told[0]).toContain('資料庫沒有變動')
    expect(told[0]).toContain(why)
    expect(readdirSync(join(dir, 'state', 'skill-store-work'))).toEqual([]) // the staged copy is gone, even one the script locked
  }, 30_000)
}

test('append: a run that fails writes nothing back (no owner notice)', async () => {
  writeSkill({ put: appendAction })
  seed()
  const before = snapshot()
  const r = await runSkill(deps, conv, 'user', 'sticker', 'put', { op: 'fail' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('動作沒有成功結束, 資料庫 tg-sticker 未寫回')
  expect(snapshot()).toEqual(before)
  expect(told).toEqual([])
})

test('full: deletions and changes are written back; still no symlinks', async () => {
  writeSkill({ prune: { ...appendAction, roles: ['owner', 'admin'], store: { DB: { name: 'tg-sticker', mode: 'full' } } } })
  expect(describeActions(skill)).toContain('資料庫 tg-sticker (full)')
  seed()
  let r = await runSkill(deps, conv, 'owner', 'sticker', 'prune', { op: 'rm' })
  expect(r.ok).toBe(true)
  r = await runSkill(deps, conv, 'admin', 'sticker', 'prune', { op: 'rmdir' })
  r = await runSkill(deps, conv, 'admin', 'sticker', 'prune', { op: 'oldline' })
  expect(r.ok).toBe(true)
  expect(snapshot()).toEqual({ 'img/': '', 'img/a.webp': 'RIFFxxxxWEBP', 'log.jsonl': '{"id":9}\n' })
  const before = snapshot()
  r = await runSkill(deps, conv, 'owner', 'sticker', 'prune', { op: 'link' })
  expect(r.ok).toBe(false)
  expect(r.text).toContain('不是一般檔案或資料夾')
  expect(snapshot()).toEqual(before)
  expect((await runSkill(deps, conv, 'user', 'sticker', 'prune', { op: 'rm' })).text).toContain('不開放給 user')
})

test('full on an action open to user or power (or every role) is refused when privileged.json is read', async () => {
  for (const roles of [['owner', 'power'], ['user'], undefined]) {
    writeSkill({ prune: { ...appendAction, roles, store: { DB: { name: 'tg-sticker', mode: 'full' } } } })
    expect(() => loadManifest(skill)).toThrow('full 模式, 動作的 roles 只能有 owner, admin')
    expect((await runSkill(deps, conv, 'owner', 'sticker', 'prune', { op: 'rm' })).text).toContain('privileged.json 有誤')
  }
  // other declarations privileged.json refuses
  for (const [a, why] of [
    [{ ...appendAction, store: { DB: { name: 'tg-sticker', mode: 'wide' } } }, 'mode 只能是 append 或 full'],
    [{ ...appendAction, store: { DB: '../x' } }, '資料庫名稱不行'],
    [{ ...appendAction, store: { PATH: 'tg-sticker' } }, '環境變數名稱不行'],
    [{ ...appendAction, creds: { DB: 'c' } }, '環境變數 DB 重複'],
    [{ ...appendAction, internal: true }, 'internal, 不能用 store'],
    [{ run: ['true'], bots: { SB: 'b' }, internal: true }, 'internal, 不能用 bots'],
  ] as const) {
    writeSkill({ x: a })
    expect(() => loadManifest(skill)).toThrow(why)
  }
})

test('runs on one database queue, across conversations; the database is hidden from the conversation and other actions', async () => {
  writeSkill({ put: appendAction, peek: { run: ['bash', '-c', `echo "state=[$(ls -A ${join(dir, 'state')})]"; [ -e ${store} ] && echo SEEN || echo hidden; echo "db=$DB"`], roles: ['user'] } })
  seed()
  const [a, b] = await Promise.all([
    runSkill(deps, conv, 'user', 'sticker', 'put', { op: 'slow' }),
    runSkill(deps, conv2, 'user', 'sticker', 'put', { op: 'slow' }),
  ])
  expect(a.ok && b.ok).toBe(true)
  const t = [conv, conv2].map(c => readFileSync(join(c.folder, 'times'), 'utf8').trim().split('\n').map(BigInt))
  const [x, y] = t[0]![0]! < t[1]![0]! ? [t[0]!, t[1]!] : [t[1]!, t[0]!]
  expect(x[1]! <= y[0]!).toBe(true) // the second started after the first ended
  expect(readFileSync(join(store, 'log.jsonl'), 'utf8')).toBe('{"id":1}\n{"run":1}\n{"run":1}\n') // neither lost
  const p = await runSkill(deps, conv, 'user', 'sticker', 'peek', {})
  expect(p.text).toContain('state=[]') // the state dir is an empty folder
  expect(p.text).toContain('hidden')
  expect(p.text).not.toContain('SEEN')
  expect(p.text).toContain('db=')
  expect(p.text).not.toContain('db=/')
  expect(existsSync(join(conv.folder, 'tg-sticker'))).toBe(false)
})

test('bots: the script gets <apiRoot>/bot<token>; the token never comes back (output, files written, the database); only telegram-bot credentials', async () => {
  writeSkill({
    send: { run: ['bash', '-c', 'echo "api=${SB_API%%/bot*}"; echo "$SB_API" > out.txt; echo "$SB_API"'], bots: { SB: 'baldeagle' }, roles: ['user'] },
    keep: { run: ['bash', '-c', 'echo "{\\"u\\":\\"$SB_API\\"}" >> "$DB/log.jsonl"; echo kept'], bots: { SB: 'baldeagle' }, store: { DB: 'tg-sticker' }, roles: ['user'] },
  })
  expect(describeActions(skill)).toContain('bot 憑證 baldeagle')
  expect((await runSkill(deps, conv, 'user', 'sticker', 'send', {})).text).toBe('技能 sticker 需要的 bot 憑證 baldeagle 不存在, 請 owner 檢查')
  deps.botCred = () => ({ token: TOKEN, kind: 'http', baseUrl: 'https://api.example.com', methods: [] })
  expect((await runSkill(deps, conv, 'user', 'sticker', 'send', {})).text).toContain('需要的 bot 憑證 baldeagle 是 http 類, bots 只接受 telegram-bot 憑證')
  deps.botCred = name => name === 'baldeagle' ? { token: TOKEN, methods: ['addStickerToSet'] } : undefined
  const r = await runSkill(deps, conv, 'user', 'sticker', 'send', {})
  expect(r.text).toContain('api=http://127.0.0.1:9')
  expect(r.text).toContain('http://127.0.0.1:9/bot<已遮蔽>')
  expect(r.text).not.toContain(TOKEN)
  expect(existsSync(join(conv.folder, 'out.txt'))).toBe(false)
  expect(told.some(t => t.includes('含有憑證內容'))).toBe(true)
  // a credential with its own apiRoot (a self-hosted Bot API server) gets that one; a trial run's fixed server wins over it
  deps.botCred = name => name === 'baldeagle' ? { token: TOKEN, methods: ['addStickerToSet'], apiRoot: 'http://127.0.0.1:8081' } : undefined
  expect((await runSkill(deps, conv, 'user', 'sticker', 'send', {})).text).toContain('api=http://127.0.0.1:8081')
  expect((await runSkill({ ...deps, apiRootFixed: 'http://127.0.0.1:7' }, conv, 'user', 'sticker', 'send', {})).text).toContain('api=http://127.0.0.1:7\n')
  deps.botCred = name => name === 'baldeagle' ? { token: TOKEN, methods: ['addStickerToSet'] } : undefined
  told = []
  seed()
  const before = snapshot()
  const k = await runSkill(deps, conv, 'user', 'sticker', 'keep', {})
  expect(k.ok).toBe(false)
  expect(k.text).toContain('log.jsonl 含有憑證內容')
  expect(snapshot()).toEqual(before)
  expect(told.some(t => t.includes('資料庫沒有變動'))).toBe(true)
  expect(told.join('\n')).not.toContain(TOKEN)
})

test('store, bots and http together in one action (the generate action\'s mix): each env is set, the line is written back, no key or token comes back', async () => {
  const KEY = 'sk-test0123456789abcdefghijklmnop'
  writeSkill({ generate: {
    run: ['bash', '-c', 'echo "url=$OPENAI_URL"; [ -n "$OPENAI_HEADER" ] && echo header-set; echo "api=${STICKER_BOT_API%%/bot*}"; echo "$OPENAI_HEADER $STICKER_BOT_API"; echo \'{"id":2}\' >> "$STICKERS/log.jsonl"'],
    roles: ['user', 'power', 'admin', 'owner'], http: { OPENAI: 'openai' }, bots: { STICKER_BOT: 'baldeagle' }, store: { STICKERS: 'tg-sticker' }, timeout: 30,
  } })
  expect(() => loadManifest(skill)).not.toThrow()
  deps.httpCred = name => name === 'openai' ? { token: KEY, kind: 'http', baseUrl: 'https://api.example.com', methods: ['/v1/images/generations'] } : undefined
  deps.botCred = name => name === 'baldeagle' ? { token: TOKEN, methods: ['addStickerToSet'] } : undefined
  seed()
  const r = await runSkill(deps, conv, 'user', 'sticker', 'generate', {})
  expect(r.ok).toBe(true)
  expect(r.text).toContain('url=https://api.example.com')
  expect(r.text).toContain('header-set')
  expect(r.text).toContain('api=http://127.0.0.1:9')
  expect(r.text).toContain('Authorization: Bearer <已遮蔽> http://127.0.0.1:9/bot<已遮蔽>')
  expect(r.text).not.toContain(KEY)
  expect(r.text).not.toContain(TOKEN)
  expect(readFileSync(join(store, 'log.jsonl'), 'utf8')).toBe('{"id":1}\n{"id":2}\n')
})
