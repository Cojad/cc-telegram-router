// API keys as credentials (柯姊 2026-10-17): /router help topics, cred add
// without --http never calls getMe for a value that is not a bot token, the
// key's place (--header, --scheme, --query) in the same syntax for /router
// cred add, cred-import and /secret set, no paths meaning every path, and the
// extra headers a worker may send with http_api. Keep in sync with
// docs/credentials-and-skills.md 「http 憑證的 key 放哪裡」, docs/operations.md
// 「/router help 主題」 and /telegram:doc; end to end in e2e-setup.test.ts.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { parseHttpScope, refuseHeaders, httpApiCall, describeCreds, BOT_TOKEN_FULL } from '../credentials'
import { runCommand, HELP_TOPICS, type CommandDeps } from '../commands'
import { runSecretCommand, secretCred, newSecretKey, type SecretDeps } from '../secrets'

const OWNER = '137438526'
const ANT = 'sk-ant-TESTxxxxxxxxxxxxxxxxxxxx', OAI = 'sk-TESTxxxxxxxxxxxxxxxxxxxx'
const BOT = '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
let dir: string, cfg: Config, db: RouterDb, getMe: string[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-credhttp-'))
  mkdirSync(join(dir, '.router'))
  cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, '.router', 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude', credentials: {} }
  db = openRouterDb(join(dir, '.router', 'router.db'))
  getMe = []
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

function deps(): CommandDeps {
  return {
    cfg, db, loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: {}, pending: {} }) as any, saveAccess() {},
    verifyBot: async (t: string) => { getMe.push(t); return '@fake_bot (1)' },
    creds: {
      // stands in for main.ts: getMe only for a bot token
      async add(name: string, token: string, methods: string[], by: string, http?: any) {
        if (!http) getMe.push(token)
        cfg.credentials[name] = { token, methods, roles: ['owner', 'admin'], label: http ? `http ${http.baseUrl}` : '@eagle_bot (99)', ...(http ? { kind: 'http', ...http } : {}), addedBy: by }
        return cfg.credentials[name]!.label!
      },
      update() {}, reload: () => 0, async call() { return null },
    },
  } as unknown as CommandDeps
}
const run = (text: string) => runCommand({ bot: 'cc', text, senderId: OWNER, senderName: 'x', chatId: OWNER, chatType: 'private' }, deps())

test('/router help: the cred line shows the --http form and points to the topics; /router help <主題> gives full usage with examples', async () => {
  const all = (await run('/router help'))!.reply
  expect(all).toContain('add <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [路徑...]')
  expect(all).toContain('/router help <主題>: 完整用法與範例, 主題: cred, secret, perm, bot')
  const cred = (await run('/router help cred'))!.reply
  expect(cred).toBe(HELP_TOPICS.cred!)
  for (const s of ['只能在你 (owner 或 admin) 自己和 bot 的私訊', '不會進 worker, 那則訊息會立刻刪除', 'Anthropic: /router cred add anthropic sk-ant-... --http https://api.anthropic.com --header x-api-key', 'anthropic-version: 2023-06-01', 'OpenAI: /router cred add openai sk-...', '/router cred add eagle 123456789:AA...', '沒寫路徑就是那個網址底下全部路徑', '不能帶 Authorization, Cookie, x-api-key', 'cred-import']) expect(cred).toContain(s)
  const secret = (await run('/router help SECRET'))!.reply
  for (const s of ['/secret (對話密鑰)', '/router cred (全域憑證)', '任何角色都能登記', '句子中間提到指令名稱不算']) expect(secret).toContain(s)
  expect((await run('/router help perm'))!.reply).toContain('/router perm user <uid|@username>')
  expect((await run('/router help bot'))!.reply).toContain('/router help cred')
  expect((await run('/router help nope'))!.reply).toStartWith('沒有 nope 這個主題, 主題: cred, secret, perm, bot')
  // /secret help points to the comparison
  const sd: SecretDeps = { cfg: { owners: [OWNER], bots: [], secretKey: newSecretKey() }, db, loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: {}, pending: {} }) as any, verifyBot: async () => '' }
  expect((await runSecretCommand({ bot: 'cc', text: '/secret help', senderId: OWNER, senderName: 'x', chatId: OWNER, chatType: 'private' }, sd))!.reply).toContain('/router help secret')
})

test('/router cred add without --http: a value that is not a bot token is not sent to getMe; the reply says what it looks like and how to type it; the message is deleted', async () => {
  const ant = (await run(`/router cred add anthropic ${ANT}`))!
  expect(ant.deleteMessage).toBe(true)
  expect(ant.reply).toBe([
    '這看起來不是 Telegram bot token (像是 Anthropic API key), 沒有登記, 也沒有拿去 Telegram 驗證. 這則訊息已刪除.',
    'API key 要加 --http <網址>, 例如:',
    '/router cred add anthropic <key> --http https://api.anthropic.com --header x-api-key',
    '(沒寫路徑就是那個網址底下全部路徑)',
    '完整說明與範例: /router help cred',
  ].join('\n'))
  expect((await run(`/router cred add openai ${OAI}`))!.reply).toContain('(像是 OpenAI API key)')
  expect((await run('/router cred add x some-random-key-value'))!.reply).toStartWith('這看起來不是 Telegram bot token, 沒有登記')
  expect((await run('/router cred add x 123:short'))!.reply).toStartWith('這看起來不是 Telegram bot token')
  expect((await run(`/router cred add x ${BOT} --header x-api-key`))!).toMatchObject({ reply: '--header 只能跟 --http 一起用 (API key); bot token 後面只接方法\n這則訊息已刪除', deleteMessage: true })
  expect(getMe).toEqual([])
  expect(cfg.credentials).toEqual({})
  // a bot token still goes to getMe
  expect((await run(`/router cred add eagle ${BOT} addStickerToSet`))!.reply).toStartWith('已加入憑證 eagle: @eagle_bot (99)')
  expect(getMe).toEqual([BOT])
  expect(BOT_TOKEN_FULL.test(BOT)).toBe(true)
  expect(BOT_TOKEN_FULL.test(`${BOT}x`)).toBe(false)
})

test('the key\'s place, same syntax in /router cred add, cred-import and /secret set: --header (bare key), --scheme <前綴|none>, --query; no paths is every path', async () => {
  expect(parseHttpScope(['--http', 'https://api.anthropic.com/', '--header', 'x-api-key'])).toEqual({ baseUrl: 'https://api.anthropic.com', placement: { header: 'x-api-key', scheme: '' }, paths: [] })
  expect(parseHttpScope(['/v1/*', '--scheme', 'none', '--http', 'https://a.example'])).toEqual({ baseUrl: 'https://a.example', placement: { scheme: '' }, paths: ['/v1/*'] })
  expect(parseHttpScope(['--http', 'https://a.example', '--header', 'authorization', '--scheme', 'Token'])).toMatchObject({ placement: { header: 'Authorization', scheme: 'Token' } })
  expect(parseHttpScope(['--http', 'https://a.example', '--query', 'key'])).toMatchObject({ placement: { query: 'key' } })
  expect(parseHttpScope(['--http', 'https://a.example', '--query', 'key', '--header', 'x-k'])).toEqual({ error: '--query 不能跟 --header 或 --scheme 一起用: key 放在 query 參數就不放標頭' })
  const err = (w: string[]) => (parseHttpScope(w) as { error: string }).error
  expect(err(['--http', 'https://a.example', '--header', 'Cookie'])).toStartWith('標頭 Cookie 不行')
  expect(err(['--http', 'https://a.example', '--header'])).toStartWith('--header 後面要接標頭名稱')
  expect(err(['--http', 'https://a.example', '/v1/../x'])).toStartWith('路徑 /v1/../x 不行')
  expect(err(['--http', 'ftp://a.example'])).toStartWith('--http 後面要接網址')

  // /router cred add
  const r = (await run(`/router cred add anthropic ${ANT} --http https://api.anthropic.com --header x-api-key`))!
  expect(r.reply).toStartWith('已加入憑證 anthropic: http https://api.anthropic.com, 標頭 x-api-key\n路徑: 全部\n')
  expect(cfg.credentials.anthropic).toMatchObject({ kind: 'http', baseUrl: 'https://api.anthropic.com', header: 'x-api-key', scheme: '', methods: ['*'] })
  await run(`/router cred add gem ${OAI} --http https://g.example --query key /v1beta/*`)
  expect(cfg.credentials.gem).toMatchObject({ query: 'key', methods: ['/v1beta/*'] })
  await run(`/router cred add tok ${OAI} --http https://t.example --scheme none`)
  expect(cfg.credentials.tok).toMatchObject({ scheme: '', methods: ['*'] })
  expect(cfg.credentials.tok!.header).toBeUndefined()
  expect(getMe).toEqual([])
  expect(describeCreds(cfg)).toBe([
    'anthropic: http https://api.anthropic.com, 標頭 x-api-key, 路徑 全部, 角色 owner, admin, 加入者 137438526',
    'gem: http https://g.example, key 放在 query 參數 key, 路徑 /v1beta/*, 角色 owner, admin, 加入者 137438526',
    'tok: http https://t.example, 標頭 Authorization, 路徑 全部, 角色 owner, admin, 加入者 137438526',
  ].join('\n'))
  expect(describeCreds({ credentials: { x: { token: 't', kind: 'http', baseUrl: 'https://x.example', methods: [], roles: [] } } })).toBe('x: http https://x.example, 路徑 (無, 全部擋下), 角色 (無, 沒有對話能用)')

  // /secret set
  const sd: SecretDeps = { cfg: { owners: [OWNER], bots: [], secretKey: newSecretKey() }, db, loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: {}, pending: {} }) as any, verifyBot: async t => { getMe.push(t); return '' } }
  const say = async (t: string) => (await runSecretCommand({ bot: 'cc', text: t, senderId: OWNER, senderName: 'x', chatId: OWNER, chatType: 'private' }, sd))!.reply
  expect(await say(`/secret set ant ${ANT} --http https://api.anthropic.com --header x-api-key`)).toStartWith('已登記這個對話的密鑰 ant: http https://api.anthropic.com, 標頭 x-api-key, 路徑 全部')
  expect(await say(`/secret set gq ${OAI} --http https://g.example --query key /v1/*`)).toStartWith('已登記這個對話的密鑰 gq: http https://g.example, key 放在 query 參數 key, 路徑 /v1/*')
  expect(secretCred(db.getConvSecret('cc', OWNER, 'gq')!, OAI)).toMatchObject({ query: 'key', baseUrl: 'https://g.example' })
  expect(await say(`/secret set bad ${OAI} --http https://g.example --query key --scheme Token`)).toBe('--query 不能跟 --header 或 --scheme 一起用: key 放在 query 參數就不放標頭')
  expect(getMe).toEqual([])

  // cred-import (terminal)
  writeFileSync(join(dir, 'k.env'), `ANTHROPIC_API_KEY=${ANT}\n`)
  writeFileSync(cfg.path!, JSON.stringify({ bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: cfg.stateDir, socket: cfg.socket, owners: [OWNER], apiRoot: 'http://127.0.0.1:9' }))
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', cfg.path!, 'cred-import', 'anthropic', join(dir, 'k.env'), 'ANTHROPIC_API_KEY', '--http', 'https://api.anthropic.com', '--header', 'x-api-key'], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  expect(await p.exited).toBe(0)
  expect(out).toContain('已存入憑證 anthropic: http https://api.anthropic.com, 標頭 x-api-key, 路徑 *')
  expect(out).not.toContain(ANT)
  expect(JSON.parse(readFileSync(cfg.path!, 'utf8')).credentials.anthropic).toMatchObject({ token: ANT, kind: 'http', baseUrl: 'https://api.anthropic.com', header: 'x-api-key', scheme: '', methods: ['*'] })
  const q = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', cfg.path!, 'cred-import', 'gem', join(dir, 'k.env'), 'ANTHROPIC_API_KEY', '/v1beta/a,/v1beta/b', '--http', 'https://g.example', '--query', 'key'], { stdout: 'pipe', stderr: 'pipe' })
  expect(await q.exited).toBe(0)
  expect(JSON.parse(readFileSync(cfg.path!, 'utf8')).credentials.gem).toMatchObject({ query: 'key', methods: ['/v1beta/a', '/v1beta/b'] })
}, 20000)

test('http_api extra headers: passed on as they are; the key\'s own header, Authorization, Cookie, Proxy-Authorization and other auth-like names are refused', () => {
  const xk = { header: 'x-api-key' }
  expect(refuseHeaders(xk, undefined)).toBeNull()
  expect(refuseHeaders(xk, { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'x', 'Idempotency-Key': 'k1', 'OpenAI-Organization': 'org' })).toBeNull()
  expect(refuseHeaders(xk, { 'X-API-KEY': 'other' })).toBe('標頭 X-API-KEY 是憑證放 key 的地方, 由 router 設定, 不能自己帶')
  for (const h of ['Authorization', 'authorization', 'Cookie', 'Proxy-Authorization', 'x-goog-api-key', 'X-Auth-Token', 'x-amz-security-token', 'Set-Cookie', 'Host', 'Content-Type', 'Content-Length']) expect(refuseHeaders(xk, { [h]: 'v' })).toStartWith(`標頭 ${h} 不能自己帶`)
  // with the key in a query parameter there is no key header, auth headers are still refused
  expect(refuseHeaders({ query: 'key' }, { Authorization: 'Bearer other' })).toStartWith('標頭 Authorization 不能自己帶')
  expect(refuseHeaders({}, { 'x-api-key': 'other' })).toStartWith('標頭 x-api-key 不能自己帶')
  expect(refuseHeaders(xk, { 'bad name': 'v' })).toBe('標頭 bad name 不行: 只能用英數與 -')
  expect(refuseHeaders(xk, { a: 'x\r\nInjected: 1' })).toBe('標頭 a 的值要是一行文字 (最多 2000 字)')
  expect(refuseHeaders(xk, { a: 1 })).toBe('標頭 a 的值要是一行文字 (最多 2000 字)')
  expect(refuseHeaders(xk, ['a'])).toStartWith('headers 要是物件')
  expect(refuseHeaders(xk, Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`h${i}`, 'v'])))).toBe('headers 最多 20 個')
})

test('httpApiCall puts the key only where the credential says (a local server sees every header and the query)', async () => {
  const seen: Array<{ search: string; headers: Record<string, string> }> = []
  const api = Bun.serve({ port: 0, fetch(req) { seen.push({ search: new URL(req.url).search, headers: Object.fromEntries(req.headers) }); return Response.json({ ok: 1 }) } })
  const base = `http://127.0.0.1:${api.port}`
  const holding = (h: Record<string, string>) => Object.entries(h).filter(([, v]) => v.includes(ANT)).map(([k]) => k)
  try {
    await httpApiCall({ cred: { token: ANT, kind: 'http', baseUrl: base, methods: ['*'], header: 'x-api-key', scheme: '' }, method: 'POST', path: '/v1/messages', json: {}, headers: { 'anthropic-version': '2023-06-01' } })
    expect(seen[0]!.headers['x-api-key']).toBe(ANT)
    expect(seen[0]!.headers['anthropic-version']).toBe('2023-06-01')
    expect(seen[0]!.headers['content-type']).toBe('application/json')
    expect(holding(seen[0]!.headers)).toEqual(['x-api-key'])
    expect(seen[0]!.search).toBe('')
    // default: Authorization: Bearer; --scheme none: the bare key in Authorization
    await httpApiCall({ cred: { token: ANT, kind: 'http', baseUrl: base, methods: ['*'] }, method: 'GET', path: '/v1/models' })
    expect(seen[1]!.headers.authorization).toBe(`Bearer ${ANT}`)
    await httpApiCall({ cred: { token: ANT, kind: 'http', baseUrl: base, methods: ['*'], scheme: '' }, method: 'GET', path: '/v1/models' })
    expect(seen[2]!.headers.authorization).toBe(ANT)
    // query: in the URL next to the worker's own parameters, in no header
    await httpApiCall({ cred: { token: ANT, kind: 'http', baseUrl: base, methods: ['*'], query: 'key' }, method: 'GET', path: '/v1/models?page=2', headers: { 'x-trace': 't' } })
    expect(new URLSearchParams(seen[3]!.search).get('key')).toBe(ANT)
    expect(new URLSearchParams(seen[3]!.search).get('page')).toBe('2')
    expect(holding(seen[3]!.headers)).toEqual([])
    expect(seen[3]!.headers['x-trace']).toBe('t')
    // the key's header is set last: a same-named extra header (refuseHeaders stops it first) cannot replace it
    await httpApiCall({ cred: { token: ANT, kind: 'http', baseUrl: base, methods: ['*'], header: 'x-api-key', scheme: '' }, method: 'GET', path: '/', headers: { 'X-Api-Key': 'other' } })
    expect(seen[4]!.headers['x-api-key']).toBe(ANT)
  } finally { api.stop(true) }
})

test('/telegram:doc and /telegram:bot-skill teach registering keys: where to type, the message is deleted, the key never reaches the worker, --http with the key\'s place, Anthropic example; http_api documents headers', async () => {
  const doc = await Bun.file(join(import.meta.dir, '..', '..', 'plugin', 'skills', 'doc', 'SKILL.md')).text()
  for (const s of ['## 登記 API key 與 bot token', '只能在他自己和 bot 的私訊', '要用 key 的那個對話', '**不會送進 worker**', '**立刻刪除**', '**你永遠拿不到值**', '一定要加 `--http <網址>`', '沒寫路徑就是那個網址底下全部路徑', '/router cred add anthropic sk-ant-... --http https://api.anthropic.com --header x-api-key', 'anthropic-version', '/router cred add eagle 123456789:AA...', '/router help cred', '`/router help <主題>`', '(無, 全部擋下)', '句子中間提到指令']) expect(doc).toContain(s)
  const skill = await Bun.file(join(import.meta.dir, '..', '..', 'plugin', 'skills', 'bot-skill', 'SKILL.md')).text()
  for (const s of ['--query <參數>', '/router cred add anthropic sk-ant-... --http https://api.anthropic.com --header x-api-key', '`headers` 只放 API 需要的其他標頭']) expect(skill).toContain(s)
  const { TOOL_DEFINITIONS } = await import('../../shared/tools')
  const http = (TOOL_DEFINITIONS as any[]).find(t => t.name === 'http_api')
  expect(http.inputSchema.properties.headers.type).toBe('object')
  expect(http.description).toContain('never send Authorization, Cookie, x-api-key')
})
