// Phase 3: credentials for cross-bot skills and skill scopes (plan 03 憑證,
// 技能範圍; /telegram:bot-skill). Keep in sync with those and README.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { refuseUse, botApiCall, describeCreds } from '../credentials'
import { installSkill } from '../skills'
import { runCommand, type CommandDeps } from '../commands'

const OWNER = '137438526', ADMIN = '500'
const TOKEN = '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
let dir: string, cfg: Config, db: RouterDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr3c-'))
  mkdirSync(join(dir, '.router'))
  cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, '.router', 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude', credentials: {} }
  db = openRouterDb(join(dir, '.router', 'router.db'))
  db.setUserRole(ADMIN, 'admin')
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('refuseUse: unknown credential, role not on its list, method not on its list', () => {
  const c = { token: TOKEN, methods: ['addStickerToSet'] }
  expect(refuseUse(undefined, 'x', 'owner', 'getMe')).toBe('沒有名為 x 的憑證 (/router cred list 查看)')
  expect(refuseUse(c, 'eagle', 'user', 'addStickerToSet')).toBe('憑證 eagle 只開放 owner, admin 角色的對話使用, 這個對話是 user')
  expect(refuseUse(c, 'eagle', 'admin', 'sendMessage')).toContain('憑證 eagle 沒有開放 sendMessage')
  expect(refuseUse(c, 'eagle', 'owner', 'addStickerToSet')).toBeNull()
  expect(refuseUse({ ...c, roles: ['power'] }, 'eagle', 'power', 'addStickerToSet')).toBeNull()
  expect(describeCreds({ credentials: { eagle: { ...c, label: '@eagle_bot (1)' } } })).toBe('eagle: @eagle_bot (1), 方法 addStickerToSet, 角色 owner, admin')
  expect(describeCreds({ credentials: { eagle: c } })).not.toContain(TOKEN)
})

test('botApiCall: JSON for plain calls, multipart with the file for uploads, the token only in the URL', async () => {
  const seen: Array<{ path: string; type: string; body: string }> = []
  const api = Bun.serve({ port: 0, async fetch(req) {
    seen.push({ path: new URL(req.url).pathname, type: req.headers.get('content-type') ?? '', body: await req.text() })
    return Response.json({ ok: true, result: true })
  } })
  try {
    writeFileSync(join(dir, 's.webp'), 'WEBPDATA')
    expect(await botApiCall({ apiRoot: `http://127.0.0.1:${api.port}`, token: TOKEN, method: 'getStickerSet', params: { name: 'set' } })).toEqual({ ok: true, result: true })
    await botApiCall({ apiRoot: `http://127.0.0.1:${api.port}`, token: TOKEN, method: 'addStickerToSet', params: { name: 'set', sticker: { sticker: 'attach://file', emoji_list: ['🐳'] } }, files: { file: join(dir, 's.webp') } })
    expect(seen[0]).toMatchObject({ path: `/bot${TOKEN}/getStickerSet`, type: 'application/json', body: '{"name":"set"}' })
    expect(seen[1]!.type).toStartWith('multipart/form-data')
    expect(seen[1]!.body).toContain('WEBPDATA')
    expect(seen[1]!.body).toContain('{"sticker":"attach://file","emoji_list":["🐳"]}')
  } finally { api.stop(true) }
})

test('install_skill: owner/admin only; needs SKILL.md; refuses tokens and symlinks; replace is explicit; venv is not copied', () => {
  const conv = join(dir, 'bot1', 'dm-1'), scope = join(dir, 'bot1')
  const skill = join(conv, '.claude', 'skills', 'stickers')
  mkdirSync(join(skill, 'scripts'), { recursive: true })
  mkdirSync(join(skill, 'venv', 'lib'), { recursive: true })
  writeFileSync(join(skill, 'venv', 'lib', 'big.py'), 'x')
  const go = (o: Partial<Parameters<typeof installSkill>[0]> = {}) => installSkill({ convFolder: conv, role: 'admin', name: 'stickers', scopeDir: scope, ...o })
  expect(() => go({ role: 'power' })).toThrow('只有 owner 與 admin 的對話能安裝')
  expect(() => go({ name: 'Bad Name' })).toThrow('技能名稱只能用小寫英數與 -')
  expect(() => go()).toThrow('找不到 .claude/skills/stickers/SKILL.md')
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: stickers\n---\n')
  writeFileSync(join(skill, 'scripts', 'add.sh'), `TOKEN=${TOKEN}\n`)
  expect(() => go()).toThrow('scripts/add.sh 裡有像 token 的字串')
  writeFileSync(join(skill, 'scripts', 'add.sh'), 'echo use bot_api\n')
  symlinkSync('/etc/passwd', join(skill, 'scripts', 'link'))
  expect(() => go()).toThrow('技能裡不能有符號連結: link')
  rmSync(join(skill, 'scripts', 'link'))
  expect(go()).toBe(join(scope, '.claude', 'skills', 'stickers'))
  expect(readFileSync(join(scope, '.claude', 'skills', 'stickers', 'scripts', 'add.sh'), 'utf8')).toBe('echo use bot_api\n')
  expect(existsSync(join(scope, '.claude', 'skills', 'stickers', 'venv'))).toBe(false)
  expect(() => go()).toThrow('已經有同名技能; 確定要覆蓋就帶 replace: true')
  expect(go({ replace: true, role: 'owner' })).toBe(join(scope, '.claude', 'skills', 'stickers'))
})

function deps(store: { added: any[]; config: Record<string, any> }): CommandDeps {
  return {
    cfg, db, loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} }) as any, saveAccess() {},
    creds: {
      async add(name, token, methods, by) { if (!token.includes(':')) throw new Error('getMe: 401 Unauthorized'); cfg.credentials[name] = { token, methods, roles: ['owner', 'admin'], label: '@eagle_bot (99)', addedBy: by }; store.added.push(name); return '@eagle_bot (99)' },
      update(name, change) { if (change) change(cfg.credentials[name]!); else delete cfg.credentials[name] },
      reload: () => Object.keys(cfg.credentials).length,
      async call(name, method) { return { ok: true, result: { name, method } } },
    },
  } as unknown as CommandDeps
}
const run = (d: CommandDeps, text: string, sender: string, chat = sender, type = 'private') =>
  runCommand({ bot: 'cc', text, senderId: sender, senderName: 'x', chatId: chat, chatType: type }, d)

test('/router cred: add only in your own DM (message deleted), admin cannot replace or touch the owner\'s, allow/disallow/roles/rm, list never shows the token', async () => {
  const store = { added: [] as string[], config: {} }
  const d = deps(store)
  const inGroup = (await run(d, `/router cred add eagle ${TOKEN}`, OWNER, '-100555', 'supergroup'))!
  expect(inGroup).toMatchObject({ deleteMessage: true })
  expect(inGroup.reply).toContain('只能在你自己和 bot 的私訊使用; token 曾出現在群組')
  const ok = (await run(d, `/router cred add eagle ${TOKEN} addStickerToSet`, OWNER))!
  expect(ok.deleteMessage).toBe(true)
  expect(ok.reply).toStartWith('已加入憑證 eagle: @eagle_bot (99)\n方法: addStickerToSet')
  expect(ok.reply).not.toContain(TOKEN)
  expect((await run(d, `/router cred add eagle ${TOKEN}`, ADMIN))!.reply).toBe('⛔ 已經有名為 eagle 的憑證, 只有 owner 能取代')
  expect((await run(d, '/router cred allow eagle getStickerSet', ADMIN))!.reply).toBe('⛔ admin 只能調整自己加入的憑證')
  expect((await run(d, '/router cred allow eagle getStickerSet createNewStickerSet', OWNER))!.reply).toBe('eagle 的方法: addStickerToSet, getStickerSet, createNewStickerSet')
  expect((await run(d, '/router cred disallow eagle getStickerSet', OWNER))!.reply).toBe('eagle 的方法: addStickerToSet, createNewStickerSet')
  expect((await run(d, '/router cred roles eagle owner,bogus', OWNER))!.reply).toContain('用法: /router cred roles')
  expect((await run(d, '/router cred roles eagle owner', OWNER))!.reply).toBe('eagle 開放給: owner 角色的對話')
  const list = (await run(d, '/router cred list', OWNER))!
  expect(list.private).toBe(true)
  expect(list.reply).toBe('eagle: @eagle_bot (99), 方法 addStickerToSet, createNewStickerSet, 角色 owner, 加入者 137438526')
  expect((await run(d, '/router cred rm eagle', OWNER))!.reply).toBe('已移除憑證 eagle')
  expect(cfg.credentials).toEqual({})
  // the log line that reaches workers never carries the token
  expect(ok.logs.every(l => !l.text.includes(TOKEN.split(':')[1]!))).toBe(true)
})

test('/router botapi: owner only; JSON params and --file uploads', async () => {
  const d = deps({ added: [], config: {} })
  expect((await run(d, '/router botapi eagle getMe {}', ADMIN))!.reply).toBe('⛔ /router botapi 只開放 owner')
  expect((await run(d, '/router botapi eagle getStickerSet {"name": "s"} --file sticker=/tmp/a.webp', OWNER))!.reply).toBe('{"ok":true,"result":{"name":"eagle","method":"getStickerSet"}}')
  expect((await run(d, '/router botapi eagle getStickerSet not-json', OWNER))!.reply).toBe('參數要是 JSON 物件, 例如 {"name":"my_set"}')
})

test('http credentials: the key goes in a header (never to the worker); JSON or multipart; allowed paths (exact or prefix*); base64 can be cut out to a file; long strings are shortened', async () => {
  const { httpApiCall, takeB64, shorten } = await import('../credentials')
  const seen: Array<{ path: string; auth: string | null; type: string; body: string }> = []
  const api = Bun.serve({ port: 0, async fetch(req) {
    seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), type: req.headers.get('content-type') ?? '', body: await req.text() })
    return Response.json({ data: [{ b64_json: Buffer.from('PNGDATA').toString('base64') }] })
  } })
  try {
    const cred = { token: 'sk-test', kind: 'http' as const, baseUrl: `http://127.0.0.1:${api.port}/`, methods: ['/v1/images/generations', '/v1/files/*'] }
    expect(refuseUse(cred, 'openai', 'owner', '/v1/images/generations', 'http')).toBeNull()
    expect(refuseUse(cred, 'openai', 'owner', '/v1/files/abc', 'http')).toBeNull()
    expect(refuseUse(cred, 'openai', 'owner', '/v1/chat/completions', 'http')).toContain('沒有開放 /v1/chat/completions')
    expect(refuseUse(cred, 'openai', 'owner', 'getMe')).toBe('憑證 openai 是 http 類, 要用 http_api 工具')
    const r = await httpApiCall({ cred, method: 'POST', path: '/v1/images/generations', json: { prompt: 'whale' } })
    expect(seen[0]).toMatchObject({ path: '/v1/images/generations', auth: 'Bearer sk-test', type: 'application/json', body: '{"prompt":"whale"}' })
    writeFileSync(join(dir, 'ref.png'), 'REFIMG')
    await httpApiCall({ cred, method: 'POST', path: '/v1/images/generations', form: { prompt: 'same whale' }, files: { image: join(dir, 'ref.png') } })
    expect(seen[1]!.type).toStartWith('multipart/form-data')
    expect(seen[1]!.body).toContain('REFIMG')
    const t = takeB64(r.body, 'data.0.b64_json')
    expect(t.bytes!.toString()).toBe('PNGDATA')
    expect(t.body).toEqual({ data: [{ b64_json: '<已存檔, 7 bytes>' }] })
    expect(takeB64({ x: 1 }, 'data.0.b64_json').bytes).toBeNull()
    expect(shorten({ a: 'x'.repeat(5000) }).a).toEndWith('…(5000 字元, 已截斷)')
  } finally { api.stop(true) }
})
