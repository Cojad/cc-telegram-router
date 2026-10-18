// The setup wizard (docs/operations.md 「設定嚮導」, README How to install,
// router/wizard.ts), with keystrokes put in directly; the subcommand in a
// real terminal in e2e-wizard.test.ts (from source) and e2e-compiled.test.ts.
// The token field: one * per character (a paste of many as many *),
// Backspace and Ctrl-U erase, Enter ends, Ctrl-C cancels, escape sequences
// ignored, the token never echoed. A new config: every field, the bot on a
// self-hosted Bot API (getMe on that server, through a fake one), mode 600,
// access.json made with pairing and the owners in allowFrom. The edit mode:
// Enter everywhere changes nothing (the file stays byte for byte, fields
// the wizard does not ask about included); official ↔ self-hosted; a new
// owner goes into an existing access.json's allowFrom and nothing else
// there changes; another bot's token refused. getMe failing writes nothing
// (give up, or try again); Ctrl-C writes nothing; home may not be the
// user's home. At the end, whether bun and claude are found on the systemd
// unit's PATH (the installed unit's, else install.sh's starting list), with
// what to do. Every token here is fake.

import { afterAll, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { Cancelled, KeyQueue, isSetup, keyIo, liveGetMe, readField, runWizard, unitFile, unitPathCheck, type GetMe } from '../wizard'

const TOKEN = `123456:${'A'.repeat(20)}${'b'.repeat(15)}`
const TOKEN2 = `123456:${'C'.repeat(35)}`
const OTHER = `999999:${'D'.repeat(35)}`
const dir = mkdtempSync(join(tmpdir(), 'cctr-wizard-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** readField on these keys: what it returns and what it echoed. */
async function field(keys: string[], mask = true) {
  const q = new KeyQueue()
  let echo = ''
  const p = readField(q, s => { echo += s }, mask)
  for (const k of keys) { q.push(k); await Bun.sleep(1) }
  return { value: await p, echo }
}

test('token field: one * per character, a paste of many as many *; Backspace erases one, Ctrl-U all; Enter ends; the token never echoed', async () => {
  const typed = await field([...TOKEN, '\r'])
  expect(typed.value).toBe(TOKEN)
  expect(typed.echo).toBe('*'.repeat(TOKEN.length))
  const pasted = await field([TOKEN, '\r'])
  expect(pasted).toEqual({ value: TOKEN, echo: '*'.repeat(TOKEN.length) })
  const back = await field([TOKEN + 'xy', '\x7f', '\x7f', '\r'])
  expect(back.value).toBe(TOKEN)
  expect(back.echo).toBe('*'.repeat(TOKEN.length + 2) + '\b \b\b \b')
  // Backspace as ^H too, and on nothing it does nothing
  expect((await field(['\b', 'ab', '\b', '\r'])).value).toBe('a')
  const cleared = await field(['wrong', '\x15', TOKEN, '\r'])
  expect(cleared.value).toBe(TOKEN)
  expect(cleared.echo).toBe('*****' + '\b \b'.repeat(5) + '*'.repeat(TOKEN.length))
  for (const r of [typed, pasted, back, cleared]) expect(r.echo).not.toContain(TOKEN.slice(0, 10))
})

test('token field: Ctrl-C cancels (null); a bracketed paste, arrows and other control keys leave no trace; \\r\\n is one Enter', async () => {
  expect(await field(['abc', '\x03'])).toEqual({ value: null, echo: '***' })
  const br = await field([`\x1b[200~${TOKEN}\x1b[201~`, '\r'])
  expect(br).toEqual({ value: TOKEN, echo: '*'.repeat(TOKEN.length) })
  expect((await field(['ab\x1b[D\x1bOAc\x01\t', '\r'])).value).toBe('abc')
  const q = new KeyQueue()
  q.push('one\r\ntwo\r')
  expect(await readField(q, () => {}, false)).toBe('one')
  expect(await readField(q, () => {}, false)).toBe('two')
  // a plain line echoes what is typed
  expect(await field(['hi', '\r'], false)).toEqual({ value: 'hi', echo: 'hi' })
  // the input ending is a cancel too
  const e = new KeyQueue(); e.end()
  expect(await readField(e, () => {}, true)).toBeNull()
})

test('isSetup: setup with or without --config, nothing else', () => {
  expect(isSetup(['setup'])).toBe(true)
  expect(isSetup(['--config', '/x/config.json', 'setup'])).toBe(true)
  expect(isSetup(['setup', '--config', '/x/config.json'])).toBe(true)
  expect(isSetup(['--config', 'setup'])).toBe(false)
  expect(isSetup(['cli', 'setup'])).toBe(false)
  expect(isSetup([])).toBe(false)
})

// --- the flow ---------------------------------------------------------------
let state: string, configPath: string, out: string, me: Array<{ root: string; token: string }>
let answer: (root: string, token: string) => Awaited<ReturnType<GetMe>>
beforeEach(() => {
  state = mkdtempSync(join(dir, 'state-'))
  configPath = join(state, 'config.json')
  out = ''
  me = []
  answer = (_r, token) => ({ ok: true, id: Number(token.split(':')[0]), username: 'cc_bot' })
})
const getMe: GetMe = async (root, token) => { me.push({ root, token }); return answer(root, token) }
/** The wizard with these answers (each a line ending in Enter unless it already holds control keys). */
function wizard(answers: string[]) {
  const q = new KeyQueue()
  for (const a of answers) q.push(/[\r\x03]/.test(a) ? a : `${a}\r`)
  return runWizard({ configPath, io: keyIo(q, s => { out += s }), getMe, claudeDefault: '/opt/claude/bin/claude', userHome: '/home/someone' })
}
const config = () => JSON.parse(readFileSync(configPath, 'utf8'))
const access = () => JSON.parse(readFileSync(join(state, 'access.json'), 'utf8'))
const NEW_LOCAL = ['', '555', '', '', '', TOKEN, '2', '', '', '', '']

test('new: every field, the bot on a self-hosted server checked there, mode 600; access.json with pairing and the owner; the token never printed', async () => {
  expect(await wizard(NEW_LOCAL)).toBe('written')
  expect(config()).toEqual({
    stateDir: state, home: join(state, '..'), owners: ['555'], model: 'claude-opus-5-5', claudeBin: '/opt/claude/bin/claude',
    bots: [{ name: 'cc', token: TOKEN, apiRoot: 'http://127.0.0.1:8081' }],
  })
  expect(me).toEqual([{ root: 'http://127.0.0.1:8081', token: TOKEN }])
  expect(statSync(configPath).mode & 0o777).toBe(0o600)
  expect(access()).toEqual({ dmPolicy: 'pairing', allowFrom: ['555'], groups: {}, pending: {} })
  expect(statSync(join(state, 'access.json')).mode & 0o777).toBe(0o600)
  expect(out).toContain('建立新的設定')
  expect(out).toContain('驗證成功: @cc_bot (id 123456)')
  expect(out).toContain('*'.repeat(TOKEN.length))
  expect(out).not.toContain(TOKEN)
  expect(out).not.toContain(TOKEN.split(':')[1]!.slice(0, 8))
})

test('new on the official server: no apiRoot; no owners gives an access.json with an empty allowFrom; a second bot', async () => {
  expect(await wizard(['', '', '', '', '', TOKEN, '', 'y', 'two', OTHER, '2', 'http://127.0.0.1:9000/', '/srv/tg-example', '', ''])).toBe('written')
  expect(config().bots).toEqual([{ name: 'cc', token: TOKEN }, { name: 'two', token: OTHER, apiRoot: 'http://127.0.0.1:9000', localFilesDir: '/srv/tg-example' }])
  expect(config().owners).toEqual([])
  expect(me.map(m => m.root)).toEqual(['https://api.telegram.org', 'http://127.0.0.1:9000'])
  expect(access().allowFrom).toEqual([])
})

test('edit: Enter everywhere changes nothing, the file stays as it was (fields the wizard does not ask about too)', async () => {
  await wizard(NEW_LOCAL)
  const c = config()
  c.credentials = { far: { token: '789:far', methods: ['getMe'] } }
  c.secretKey = 'k'
  c.receiveReact = 'all'
  writeFileSync(configPath, JSON.stringify(c, null, 4), { mode: 0o600 })
  const before = readFileSync(configPath, 'utf8')
  const accessBefore = readFileSync(join(state, 'access.json'), 'utf8')
  out = ''; me = []
  expect(await wizard(['', '', '', '', '', ''])).toBe('unchanged')
  expect(readFileSync(configPath, 'utf8')).toBe(before)
  expect(readFileSync(join(state, 'access.json'), 'utf8')).toBe(accessBefore)
  expect(me).toEqual([])
  expect(out).toContain('修改模式')
  expect(out).toContain(`[${join(state, '..')}]`)
  expect(out).toContain(`token 已設定 (末 4 碼 ${TOKEN.slice(-4)}), Bot API 自架 http://127.0.0.1:8081`)
  expect(out).toContain('沒有任何變更, 不寫入')
  expect(out).not.toContain(TOKEN)
})

test('edit: self-hosted → official (getMe there, apiRoot and localFilesDir gone) → self-hosted again; only that bot changes', async () => {
  await wizard(NEW_LOCAL)
  const c = config(); c.bots[0].localFilesDir = '/srv/tg-example'; c.secretKey = 'k'
  writeFileSync(configPath, JSON.stringify(c, null, 2))
  me = []
  // keep everything; bot cc: 2 (edit), name, token kept, 1 (official); no more bots; write
  expect(await wizard(['', '', '', '', '2', '', '', '1', '', ''])).toBe('written')
  expect(config().bots).toEqual([{ name: 'cc', token: TOKEN }])
  expect(config().secretKey).toBe('k')
  expect(me).toEqual([{ root: 'https://api.telegram.org', token: TOKEN }])
  expect(out).toContain('bot cc: Bot API 自架 http://127.0.0.1:8081 → 官方 (api.telegram.org), localFilesDir /srv/tg-example → 不限制')
  me = []
  expect(await wizard(['', '', '', '', '2', '', '', '2', 'http://127.0.0.1:9999', '', '', ''])).toBe('written')
  expect(config().bots).toEqual([{ name: 'cc', token: TOKEN, apiRoot: 'http://127.0.0.1:9999' }])
  expect(me).toEqual([{ root: 'http://127.0.0.1:9999', token: TOKEN }])
})

test('edit: official while the config\'s apiRoot is self-hosted says so on the bot; a new token of the same bot is checked, another bot\'s refused', async () => {
  writeFileSync(configPath, JSON.stringify({ apiRoot: 'http://127.0.0.1:8081', bots: [{ name: 'cc', token: TOKEN }] }))
  expect(await wizard(['', '', '', '', '2', '', OTHER, TOKEN2, '1', '', ''])).toBe('written')
  expect(out).toContain('這個 token 屬於另一隻 bot')
  expect(config().bots).toEqual([{ name: 'cc', token: TOKEN2, apiRoot: 'https://api.telegram.org' }])
  expect(config().apiRoot).toBe('http://127.0.0.1:8081')
  expect(me).toEqual([{ root: 'https://api.telegram.org', token: TOKEN2 }])
  expect(out).toContain('bot cc: token 更換, Bot API 自架 http://127.0.0.1:8081 → 官方 (api.telegram.org)')
  expect(out).not.toContain(TOKEN2)
  expect(out).not.toContain(OTHER)
})

test('edit: a new owner goes into an existing access.json\'s allowFrom, nothing else there changes; owners cleared with -', async () => {
  await wizard(NEW_LOCAL)
  const a = { dmPolicy: 'allowlist', allowFrom: ['555', '600'], groups: { '-100123': { requireMention: true, allowFrom: [] } }, pending: {}, ackReaction: '👀' }
  writeFileSync(join(state, 'access.json'), JSON.stringify(a))
  expect(await wizard(['', '555, 777', '', '', '', '', ''])).toBe('written')
  expect(config().owners).toEqual(['555', '777'])
  expect(access()).toEqual({ ...a, allowFrom: ['555', '600', '777'] })
  expect(out).toContain('access.json 的 allowFrom 加入 owner 777 (其他內容不動)')
  expect(await wizard(['', '-', '', '', '', '', ''])).toBe('written')
  expect(config().owners).toEqual([])
  // removing an owner never takes anyone out of allowFrom
  expect(access().allowFrom).toEqual(['555', '600', '777'])
})

test('getMe failing writes nothing: give up (3) cancels; try again (1) with another token, or (2) another server, then it is written', async () => {
  answer = () => ({ ok: false, error: `401 Unauthorized for ${TOKEN}` })
  await expect(wizard(['', '', '', '', '', TOKEN, '2', '', '', '3'])).rejects.toBeInstanceOf(Cancelled)
  expect(existsSync(configPath)).toBe(false)
  expect(existsSync(join(state, 'access.json'))).toBe(false)
  expect(out).toContain('驗證失敗: 401 Unauthorized for <token>')
  expect(out).not.toContain(TOKEN)
  // the first token fails, the second works
  answer = (_r, t) => t === TOKEN2 ? { ok: true, id: 123456, username: 'cc_bot' } : { ok: false, error: '401 Unauthorized' }
  me = []
  expect(await wizard(['', '', '', '', '', TOKEN, '1', '1', TOKEN2, '1', '', ''])).toBe('written')
  expect(config().bots).toEqual([{ name: 'cc', token: TOKEN2 }])
  rmSync(configPath); rmSync(join(state, 'access.json'))
  // a wrong server, then the right one
  answer = r => r === 'http://127.0.0.1:8082' ? { ok: true, id: 123456, username: 'cc_bot' } : { ok: false, error: '連不上' }
  expect(await wizard(['', '', '', '', '', TOKEN, '2', '', '', '2', '2', 'http://127.0.0.1:8082', '', '', ''])).toBe('written')
  expect(config().bots[0].apiRoot).toBe('http://127.0.0.1:8082')
})

test('Ctrl-C anywhere writes nothing (new, and an edit keeps the file as it was); home may not be the user\'s home; a declined write writes nothing', async () => {
  await expect(wizard(['', '555', '', '', '', 'abc\x03'])).rejects.toBeInstanceOf(Cancelled)
  expect(existsSync(configPath)).toBe(false)
  await wizard(NEW_LOCAL)
  const before = readFileSync(configPath, 'utf8')
  await expect(wizard(['', '999', '', '', '2', '', '\x03'])).rejects.toBeInstanceOf(Cancelled)
  expect(readFileSync(configPath, 'utf8')).toBe(before)
  expect(await wizard(['/home/someone', join(state, 'home'), '', '', '', '', '', 'n'])).toBe('declined')
  expect(out).toContain('home 不能是使用者的家目錄')
  expect(readFileSync(configPath, 'utf8')).toBe(before)
})

test('liveGetMe: getMe on the server it is given, the answer or why not', async () => {
  const seen: string[] = []
  const api = Bun.serve({ port: 0, fetch(req) { seen.push(new URL(req.url).pathname); return new URL(req.url).pathname.includes(TOKEN) ? Response.json({ ok: true, result: { id: 123456, is_bot: true, username: 'cc_bot' } }) : Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }) } })
  try {
    expect(await liveGetMe(`http://127.0.0.1:${api.port}`, TOKEN)).toEqual({ ok: true, id: 123456, username: 'cc_bot' })
    expect(await liveGetMe(`http://127.0.0.1:${api.port}`, OTHER)).toEqual({ ok: false, error: '401 Unauthorized' })
    expect(seen).toEqual([`/bot${TOKEN}/getMe`, `/bot${OTHER}/getMe`])
  } finally { api.stop(true) }
  const down = await liveGetMe('http://127.0.0.1:1', TOKEN)
  expect(down.ok).toBe(false)
})

test('unitPathCheck: bun and claude on the installed unit\'s PATH, else on the list install.sh unit starts from; what to do when not', () => {
  const uh = mkdtempSync(join(dir, 'uh-'))
  const tools = join(uh, 'tools'), local = join(uh, '.local', 'bin')
  for (const d of [tools, local]) mkdirSync(d, { recursive: true })
  for (const f of [join(tools, 'bun'), join(tools, 'claude'), join(local, 'claude')]) { writeFileSync(f, '#!/bin/sh\n'); chmodSync(f, 0o755) }
  const bun = join(tools, 'bun')
  // no unit yet: bun elsewhere than the starting list
  const none = unitPathCheck({ userHome: uh, claudeBin: 'claude', bun, claude: join(local, 'claude') })
  expect(none).toEqual([`⚠️ unit 預設的 PATH 找不到 bun (它在 ${tools}): worker 的 telegram plugin 會起不來 (router log 的 plugin did not connect). 還沒安裝 systemd unit: deploy/install.sh unit 會把它的資料夾加進 unit 的 PATH.`])
  // an installed unit without bun's folder, claude by an absolute path that is there
  mkdirSync(dirname(unitFile(uh)), { recursive: true })
  writeFileSync(unitFile(uh), `[Service]\nEnvironment=PATH=${local}:/usr/bin:/bin\n`)
  const lines = unitPathCheck({ userHome: uh, claudeBin: join(tools, 'claude'), bun, claude: null })
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('unit 的 PATH 找不到 bun')
  expect(lines[0]).toContain('重跑 deploy/install.sh unit 會把它的資料夾加進 unit 的 PATH, 再 systemctl --user restart cc-telegram-router')
  // claude by name, not on the unit's PATH
  writeFileSync(unitFile(uh), `[Service]\nEnvironment=PATH=${tools}:/usr/bin:/bin\n`)
  expect(unitPathCheck({ userHome: uh, claudeBin: 'claude', bun, claude: join(local, 'claude') })).toEqual([])
  writeFileSync(unitFile(uh), `[Service]\nEnvironment=PATH=${join(uh, 'only-bun')}:/usr/bin:/bin\n`)
  mkdirSync(join(uh, 'only-bun')); writeFileSync(join(uh, 'only-bun', 'bun'), '#!/bin/sh\n'); chmodSync(join(uh, 'only-bun', 'bun'), 0o755)
  const c = unitPathCheck({ userHome: uh, claudeBin: 'claude', bun, claude: join(local, 'claude') })
  expect(c).toEqual([`⚠️ unit 的 PATH 找不到 claude (claude, 它在 ${local}): worker 起不來. 重跑 deploy/install.sh unit 會把它的資料夾加進 unit 的 PATH, 再 systemctl --user restart cc-telegram-router, 或把 claudeBin 改成絕對路徑.`])
  // no unit and no bun at all; a claudeBin that does not exist
  rmSync(unitFile(uh))
  expect(unitPathCheck({ userHome: uh, claudeBin: '/nowhere/claude', bun: null, claude: null })).toEqual([
    '⚠️ 找不到 bun: worker 的 telegram plugin 要用 bun 執行, 先安裝 bun (https://bun.sh) 再跑 deploy/install.sh unit.',
    '⚠️ 找不到 claude 執行檔 /nowhere/claude: 先安裝 Claude Code, 或用這個嚮導把 claudeBin 改成它的絕對路徑.',
  ])
})

test('the wizard ends with the unit check, written or not', async () => {
  const seen: string[] = []
  const q = new KeyQueue()
  for (const a of NEW_LOCAL) q.push(`${a}\r`)
  await runWizard({ configPath, io: keyIo(q, s => { out += s }), getMe, claudeDefault: '/opt/claude/bin/claude', userHome: '/home/someone', unitCheck: c => { seen.push(c); return ['⚠️ 檢查結果'] } })
  expect(seen).toEqual(['/opt/claude/bin/claude'])
  expect(out.trimEnd()).toEndWith('⚠️ 檢查結果')
  const q2 = new KeyQueue()
  for (const a of ['', '', '', '', '', '']) q2.push(`${a}\r`)
  expect(await runWizard({ configPath, io: keyIo(q2, s => { out += s }), getMe, claudeDefault: 'x', userHome: '/home/someone', unitCheck: () => ['⚠️ 第二次'] })).toBe('unchanged')
  expect(out.trimEnd()).toEndWith('⚠️ 第二次')
})
