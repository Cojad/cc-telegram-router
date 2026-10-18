// skill_check and the skill guide's example (docs/credentials-and-skills.md
// 「檢查技能草稿」, /telegram:bot-skill 「特權動作」 and 「範例: 活動報名清單」).
// The example's three files are taken from plugin/skills/bot-skill/SKILL.md
// itself: skill_check passes them with no warning and shows what /router
// skill approve lists; approved and run for real (bwrap, local fake event
// API and Bot API) join appends a line, joining twice fails and writes
// nothing, list reads it, cancel (owner and admin only, full mode) deletes it,
// a user conversation is refused cancel, and the key and token never come back. Then what skill_check reports: every kind of
// mistake a worker makes (with the fix), what install_skill would refuse,
// paths outside the conversation folder, symbolic links left unread, the
// credentials' existence and kind (never a value), the next step per role;
// it never runs anything. The tool definition, and in e2e-setup.test.ts the
// router's handler (any role but guest). Keep in sync with those sections.

import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { hashSkill } from '../privskill'
import { runSkill, describeActions, type SkillRunDeps } from '../skillrun'
import { checkSkill, resolveSkillDir } from '../skillcheck'
import type { Credential } from '../config'

const GUIDE = readFileSync(join(import.meta.dir, '..', '..', 'plugin', 'skills', 'bot-skill', 'SKILL.md'), 'utf8')
/** The example's files as the guide shows them: a `skills/signup/<file>`: line, then a fenced block. */
const EXAMPLE: Record<string, string> = Object.fromEntries([...GUIDE.matchAll(/^`skills\/signup\/([^`]+)`:\n\n```\w*\n([\s\S]*?)\n```$/gm)].map(m => [m[1]!, `${m[2]!}\n`]))

const KEY = 'pk-example-0123456789abcdefghij'
const TOKEN = '1234567890:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const hits: Array<{ path: string; auth: string | null; body: any }> = []
const fake = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const u = new URL(req.url)
    hits.push({ path: u.pathname + u.search, auth: req.headers.get('authorization'), body: req.method === 'POST' ? await req.json() : null })
    if (u.pathname === '/v1/events/current') return Response.json({ title: 'Example Meetup', echo: req.headers.get('authorization') })
    return Response.json({ ok: true, result: { message_id: 1 } })
  },
})
afterAll(() => fake.stop(true))
const CREDS: Record<string, Credential> = {
  'event-api': { kind: 'http', token: KEY, baseUrl: `http://127.0.0.1:${fake.port}`, methods: ['*'] } as Credential,
  'notify-bot': { token: TOKEN, methods: [] } as Credential,
}

let dir: string, db: RouterDb, conv: Conversation, folder: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-check-'))
  mkdirSync(join(dir, 'state'))
  db = openRouterDb(join(dir, 'state', 'router.db'))
  folder = join(dir, 'home', 'bot1', 'dm-7')
  mkdirSync(join(folder, '.chat'), { recursive: true })
  conv = { key: 'dm-7', bot: 'cc', chat_id: '7', type: 'dm', folder, role: 'user', session_id: null, created_at: '' }
  hits.length = 0
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

function writeExample(root: string) {
  for (const [rel, text] of Object.entries(EXAMPLE)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text) }
}
/** A skill in the conversation folder: files by relative path. */
function draft(name: string, files: Record<string, string | object>): string {
  const root = join(folder, 'skills', name)
  mkdirSync(root, { recursive: true })
  for (const [rel, v] of Object.entries(files)) { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), typeof v === 'string' ? v : JSON.stringify(v)) }
  return root
}
const MD = (name: string) => `---\nname: ${name}\ndescription: 測試用\n---\n`
const cred = (n: string) => CREDS[n]

test('the guide\'s example: its three files are in the guide; skill_check passes them with no warning and shows what approve lists', () => {
  expect(Object.keys(EXAMPLE).sort()).toEqual(['SKILL.md', 'privileged.json', 'scripts/signup.py'])
  // no Telegram ids, group ids or private paths in the public example
  for (const t of Object.values(EXAMPLE)) { expect(t).not.toMatch(/\d{6,}/); expect(t).not.toMatch(/\/(home|x)\//) }
  const root = join(folder, 'skills', 'signup')
  writeExample(root)
  const r = checkSkill(folder, 'skills/signup', 'user', { cred })
  expect(r.ok).toBe(true)
  expect(r.text.split('\n')[0]).toBe('skill check: ok')
  expect(r.text).not.toContain('提醒:')
  expect(r.text).toContain('只讀檔案, 沒有執行任何程式')
  expect(r.text).toContain(`核准時 /router skill approve signup 會列出:\n${describeActions(root)}`)
  for (const s of ['join: python3 -B scripts/signup.py join {name} {note?}; 角色 owner, admin, power, user; API 憑證 event-api; bot 憑證 notify-bot; 資料庫 signup (append)', 'cancel: python3 -B scripts/signup.py cancel {index}; 角色 owner, admin; 資料庫 signup (full)']) expect(r.text).toContain(s)
  expect(r.text).toContain('下一步: user 角色現在還不能安裝技能')
  // a bare name means skills/<name>
  expect(checkSkill(folder, 'signup', 'user', { cred }).text.split('\n')[0]).toBe('skill check: ok')
  // credentials the router does not have: said, by name and kind only
  const none = checkSkill(folder, 'skills/signup', 'user', {})
  expect(none.ok).toBe(true)
  expect(none.text).toContain('http 憑證 event-api 在 router 裡不存在: 核准後執行會拒絕')
  expect(none.text).toContain('bot 憑證 notify-bot 在 router 裡不存在')
  const swapped = checkSkill(folder, 'skills/signup', 'user', { cred: n => n === 'event-api' ? CREDS['notify-bot'] : CREDS['event-api'] })
  expect(swapped.text).toContain('憑證 event-api 是 telegram-bot 類, http 只接受 http 類憑證')
  expect(swapped.text).toContain('憑證 notify-bot 是 http 類, bots 只接受 telegram-bot 憑證')
  for (const t of [r.text, none.text, swapped.text]) { expect(t).not.toContain(KEY); expect(t).not.toContain(TOKEN) }
})

test('the guide\'s example runs as written (real bwrap, fake preview API and Bot API): join appends (twice fails and writes nothing), list reads, cancel is owner and admin only and rewrites; key and token never come back', async () => {
  const skill = join(dir, 'home', 'bot1', '.claude', 'skills', 'signup')
  writeExample(skill)
  db.approveSkill(skill, 'signup', hashSkill(skill), 'owner')
  const told: string[] = []
  const deps: SkillRunDeps = {
    db, home: join(dir, 'home'), credsRoot: join(dir, 'state', 'creds'), userHome: join(dir, 'fakehome'), hidden: [join(dir, 'home'), join(dir, 'state')], extraRo: [],
    storeRoot: join(dir, 'state', 'skill-store'), apiRoot: `http://127.0.0.1:${fake.port}`,
    botDir: () => join(dir, 'home', 'bot1'), httpCred: cred, botCred: cred,
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
  const db1 = join(dir, 'state', 'skill-store', 'bot1', 'signup', 'signups.jsonl')
  const names = () => readFileSync(db1, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).name)
  const join1 = await runSkill(deps, conv, 'user', 'signup', 'join', { name: '小明', note: '會晚到' })
  expect(join1.text).toContain('小明 報名成功, 目前 1 人 (Example Meetup)')
  expect(join1.ok).toBe(true)
  expect(hits.find(h => h.path === '/v1/events/current')!.auth).toBe(`Bearer ${KEY}`)
  const sent = hits.find(h => h.path === `/bot${TOKEN}/sendMessage`)!
  expect(sent.body).toEqual({ chat_id: '@example_events', text: '🙋 小明 報名了Example Meetup' })
  expect(names()).toEqual(['小明'])
  // joining twice: exit 1, nothing written back
  const twice = await runSkill(deps, conv, 'power', 'signup', 'join', { name: '小明' })
  expect(twice.ok).toBe(false)
  expect(twice.text).toStartWith('exit 1\n(動作沒有成功結束, 資料庫 signup 未寫回)')
  expect(names()).toEqual(['小明'])
  await runSkill(deps, conv, 'power', 'signup', 'join', { name: '小華' })
  const list = await runSkill(deps, conv, 'user', 'signup', 'list', {})
  expect(list.text).toContain('1. 小明 (會晚到)\n2. 小華')
  expect((await runSkill(deps, conv, 'user', 'signup', 'cancel', { index: '1' })).text).toBe('技能 signup 的 cancel 不開放給 user 角色的對話')
  expect((await runSkill(deps, conv, 'user', 'signup', 'join', { name: ' 空白開頭' })).text).toContain('參數 name 不符合格式')
  const rm = await runSkill(deps, conv, 'admin', 'signup', 'cancel', { index: '1' })
  expect(rm.ok).toBe(true)
  expect(rm.text).toContain('已取消第 1 位: 小明')
  expect(names()).toEqual(['小華'])
  for (const r of [join1, twice, list, rm]) { expect(r.text).not.toContain(KEY); expect(r.text).not.toContain(TOKEN) }
  expect(told).toEqual([])
})

test('skill_check reports each mistake with how to fix it; approve\'s own refusals come through; nothing is run', () => {
  const marker = join(dir, 'ran')
  draft('bad', {
    'SKILL.md': MD('bad'),
    'scripts/x.sh': `#!/bin/bash\ntouch ${marker}\n`,
    'privileged.json': { actions: {
      a: { run: ['bash', 'scripts/x.sh', '--url={url}', '{name}', '{cred:COOKIES}', 'scripts/missing.sh'], args: { url: { pattern: 'https://.*' }, name: { pattern: '([a-z' }, extra: { pattern: 'x' }, free: {} }, role: ['user'], auth_failure: 'reason=(', timeout: -1 },
      b: { run: ['python3', 'scripts/x.py', '{q?}'], args: { q: { flag: '--q' } }, refresh: 'nope', mounts: ['/srv'] },
      c: { run: 'bash scripts/x.sh' },
      d: { run: ['venv/bin/python3', '-B', 'scripts/x.sh'], refresh: 'b', auth_failure: 'x', roles: ['users'] },
    } },
  })
  const r = checkSkill(folder, 'skills/bad', 'power', { cred })
  expect(r.ok).toBe(false)
  expect(r.text.split('\n')[0]).toMatch(/^skill check: 有 \d+ 個錯誤要改$/)
  for (const s of [
    '動作 a: run 裡的 {cred:COOKIES} 在 creds 沒有 COOKIES',
    '動作 a: 找不到 scripts/missing.sh (技能資料夾裡沒有這個檔)',
    '動作 a: args.name.pattern 不是合法的正規表示式',
    '動作 a: timeout 要是正數 (秒), 沒寫是 600',
    '動作 a: auth_failure 不是合法的正規表示式',
    '動作 b: refresh 指的動作 nope 不存在',
    '動作 c: run 要是字串陣列',
  ]) expect(r.text).toContain(`- ${s}`)
  for (const s of [
    '動作 a: --url={url} 裡的 {...} 不會被替換: 參數要獨占 run 的一個元素',
    '動作 a: args.url 沒有出現在 run 裡',
    '動作 a: args.extra 沒有出現在 run 裡',
    '動作 a: args.free 沒有 pattern 也沒有 flag',
    '動作 a: 不認得的欄位 role, 會被忽略 (是不是要寫 roles?)',
    '動作 b: 用 Python 執行時加 -B',
    '動作 b: mounts 與 env 只給 internal 動作, 這裡會被忽略',
    '動作 b: auth_failure 與 refresh 要一起寫才有作用',
    '動作 d: venv/bin/python3 在 venv 裡: install_skill 不複製 venv',
    '動作 d: refresh 指的動作 b 不是 internal',
    '動作 d: roles 裡的 users 不是角色',
  ]) expect(r.text).toContain(`- ${s}`)
  expect(r.text).not.toContain('核准時')
  expect(r.text).not.toContain('下一步')
  expect(existsSync(marker)).toBe(false)
  // what loadManifest (and so /router skill approve) refuses, said as approve would
  draft('full', { 'SKILL.md': MD('full'), 'privileged.json': { actions: { rm: { run: ['true'], store: { DB: { name: 'x', mode: 'full' } } } } } })
  expect(checkSkill(folder, 'full', 'admin').text).toContain('- /router skill approve 會拒絕: 動作 rm 的資料庫 x 是 full 模式, 動作的 roles 只能有 owner, admin (現在: owner, admin, power, user)')
  draft('json', { 'SKILL.md': MD('json'), 'privileged.json': '{ "actions": { "a": { "run": ["true"], } } }' })
  expect(checkSkill(folder, 'json', 'admin').text).toContain('- privileged.json 不是合法的 JSON: ')
  draft('noact', { 'SKILL.md': MD('noact'), 'privileged.json': { action: {} } })
  expect(checkSkill(folder, 'noact', 'admin').text).toContain('- /router skill approve 會拒絕: privileged.json 要有 actions')
})

test('skill_check: what install_skill would refuse (SKILL.md, frontmatter, the folder name, token-like strings, symbolic links); a plain skill', () => {
  draft('Bad_Name', { 'SKILL.md': MD('Bad_Name') })
  expect(checkSkill(folder, 'skills/Bad_Name', 'power').text).toContain('技能資料夾名稱 Bad_Name 不行: 只能用小寫英數與 -')
  draft('nomd', { 'scripts/a.sh': 'echo' })
  expect(checkSkill(folder, 'nomd', 'power').text).toContain('- 沒有 SKILL.md: install_skill 會拒絕')
  draft('nofm', { 'SKILL.md': '# 標題\n' })
  expect(checkSkill(folder, 'nofm', 'power').text).toContain('SKILL.md 開頭要有 frontmatter')
  draft('nodesc', { 'SKILL.md': '---\nname: other\n---\n' })
  const nd = checkSkill(folder, 'nodesc', 'power').text
  expect(nd).toContain('- SKILL.md 的 frontmatter 缺 description')
  expect(nd).toContain('- SKILL.md 的 name (other) 跟資料夾名稱 (nodesc) 不同')
  draft('tok', { 'SKILL.md': MD('tok'), 'scripts/a.sh': `TOKEN=${TOKEN}\n` })
  const t = checkSkill(folder, 'tok', 'power').text
  expect(t).toContain('- scripts/a.sh 裡有像 bot token 的字串: install_skill 會拒絕')
  expect(t).not.toContain(TOKEN)
  const ln = draft('link', { 'SKILL.md': MD('link') })
  symlinkSync('/etc/hostname', join(ln, 'host'))
  expect(checkSkill(folder, 'link', 'power').text).toContain('- host 是符號連結: install_skill 不接受')
  draft('plain', { 'SKILL.md': MD('plain'), 'scripts/a.sh': 'echo hi\n' })
  const p = checkSkill(folder, 'plain', 'power')
  expect(p.ok).toBe(true)
  expect(p.text).toContain('沒有 privileged.json (一般技能)')
  expect(p.text).toContain('下一步: 可以用 install_skill (name plain, scope conversation) 裝在這個對話')
})

test('skill_check reads only inside the conversation folder, and never through a symbolic link privileged.json or SKILL.md', () => {
  const other = join(dir, 'home', 'bot1', 'dm-8', 'skills', 'theirs')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'SKILL.md'), MD('theirs'))
  for (const p of ['../dm-8/skills/theirs', other, '/etc']) expect(checkSkill(folder, p, 'owner').text).toContain('不在這個對話的資料夾裡')
  symlinkSync(other, join(folder, 'skills-link'))
  expect(checkSkill(folder, 'skills-link', 'owner').text).toContain('不在這個對話的資料夾裡')
  expect(checkSkill(folder, 'nothing', 'owner').text).toBe('skill check: 無法檢查\n找不到 nothing: 給相對於對話資料夾的路徑, 例如 skills/<名稱>')
  expect(typeof resolveSkillDir(folder, '')).toBe('object')
  const secret = join(dir, 'state', 'secret.json')
  writeFileSync(secret, '{"actions": TOPSECRETVALUE}')
  const s = draft('sneaky', {})
  symlinkSync(secret, join(s, 'privileged.json'))
  symlinkSync(secret, join(s, 'SKILL.md'))
  const r = checkSkill(folder, 'sneaky', 'owner').text
  expect(r).toContain('- privileged.json 要是一般檔案 (不能是符號連結), 沒有讀它')
  expect(r).toContain('- SKILL.md 要是一般檔案 (不能是符號連結)')
  expect(r).not.toContain('TOPSECRETVALUE')
})

test('skill_check: the next step says what each role can do with a privileged skill', () => {
  writeExample(join(folder, 'skills', 'signup'))
  const next = (role: string) => checkSkill(folder, 'signup', role, { cred }).text.split('\n').find(l => l.startsWith('下一步: '))!
  expect(next('owner')).toContain('用 install_skill (name signup, scope bot 或 all) 安裝 (特權動作只在這隻 bot 或全部 bot 範圍有效), 再請 owner 或 admin 在 Telegram 打 /router skill approve signup 核准')
  expect(next('admin')).toBe(next('owner'))
  expect(next('power')).toContain('這兩個範圍只有 owner 與 admin 能裝 (install_skill scope bot 會走提權); 請 owner 或 admin 安裝')
  expect(next('user')).toContain('user 角色現在還不能安裝技能: 草稿留在 skills/signup/, 請 owner 或 admin 安裝 並核准')
})

test('skill_check is a tool every worker sees; the guide teaches it and the run environment', async () => {
  const { TOOL_DEFINITIONS } = await import('../../shared/tools')
  const t = (TOOL_DEFINITIONS as any[]).find(d => d.name === 'skill_check')
  expect(t.inputSchema.required).toEqual(['path'])
  expect(t.description).toContain('nothing is run')
  expect(t.description).toContain('Every role but guest')
  for (const s of [
    '`skill_check` (path: `skills/<名稱>`)', '**工作目錄是對話資料夾**', '**整串比對**', '`{名稱?}`', '`{cred:環境變數}`', '**技能資料夾在沙箱裡唯讀**', '`-B`', 'PYTHONDONTWRITEBYTECODE',
    '`HOME` 是沙箱私有的 `/tmp`', '`$<ENV>_URL`', '`$<ENV>_HEADER`', '`$<ENV>_API`', '**exit code 不是 0 就算失敗**', '**輸出會掃描憑證**', '**每個對話每小時最多 10 次**', '**之後改了任何檔案都自動暫停**',
    '以換行結尾, 不能有空行, 不能刪改舊行', '單檔上限 5 MB', '20 MB', '不接受符號連結', '**不要從對話資料夾載入程式或套件**', '### 各角色能做到哪裡', '| user | 可以 | 可以 | 現在還不能', '| guest | 不行 (不能寫檔) |', '### 範例: 活動報名清單',
  ]) expect(GUIDE).toContain(s)
  // a control experiment asks workers for a shared-bookmarks skill: the guide must not hold that answer
  expect(GUIDE).not.toMatch(/書籤|網址收藏|bookmark/i)
  // the old contradiction is gone: privileged actions call APIs themselves, not through bot_api or .pylib
  expect(GUIDE).toContain('不用 `bot_api` 與 `http_api`, 也不用 `.pylib`')
})
