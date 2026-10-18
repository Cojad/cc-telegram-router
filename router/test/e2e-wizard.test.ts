// The setup wizard as a user runs it (docs/operations.md 「設定嚮導」, README
// How to install): `cc-telegram-router --config <path> setup` from source,
// in a real pseudo terminal (util-linux script; skipped without it), answering
// each prompt as it appears. The token typed with a slip, Backspace and
// Ctrl-U, then pasted: only * on the screen, never the token; the bot on a
// fake self-hosted Bot API (getMe there); config.json and access.json mode
// 600 with the owner in allowFrom. Without a terminal it refuses and writes
// nothing. Then an owner added to config.json by hand: the router, at start,
// puts them into allowFrom too. Flow details in wizard.test.ts; compiled in
// e2e-compiled.test.ts. Every token here is fake.

import { test, expect, afterAll } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { inTerminal } from './pty'

const MAIN = join(import.meta.dir, '..', 'main.ts')
const TOKEN = `123:${'T'.repeat(30)}${'q'.repeat(5)}`
const dir = mkdtempSync(join(tmpdir(), 'cctr-e2e-wizard-'))
const state = join(dir, '.router')
const configPath = join(state, 'config.json')
const userHome = join(dir, 'user-home')
mkdirSync(userHome)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const seen: string[] = []
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const parts = new URL(req.url).pathname.split('/')
    const method = parts.pop()!, token = parts.pop()!.replace(/^bot/, '')
    seen.push(`${method} ${token === TOKEN ? 'TOKEN' : token}`)
    const ok = (result: unknown) => Response.json({ ok: true, result })
    if (method === 'getMe') return token === TOKEN ? ok({ id: 123, is_bot: true, first_name: 'cc', username: 'cc_bot' }) : Response.json({ ok: false, error_code: 401, description: 'Unauthorized' })
    if (method === 'getUpdates') { await sleep(100); return ok([]) }
    return ok(true)
  },
})
const ROOT = `http://127.0.0.1:${api.port}`
const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash\ncase "$*" in *agents*) echo '[]' ;; *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;; esac\n`)
chmodSync(fakeClaude, 0o755)
const hasScript = Bun.which('script') !== null
let router: ReturnType<typeof Bun.spawn> | null = null
afterAll(async () => {
  router?.kill('SIGTERM'); await router?.exited
  api.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

test('no terminal: refused, with how to do it instead; nothing written', async () => {
  const p = Bun.spawn(['bun', MAIN, '--config', configPath, 'setup'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  p.stdin.end()
  expect(await p.exited).toBe(2)
  expect(await new Response(p.stderr).text()).toContain('cc-telegram-router setup 是互動式嚮導, 要在終端機執行 (這裡沒有 TTY)')
  expect(existsSync(configPath)).toBe(false)
})

test.skipIf(!hasScript)('in a terminal: the token as * only (a slip, Backspace, Ctrl-U, a paste), the bot on a self-hosted server checked there, both files 600 with the owner in allowFrom', async () => {
  // HOME without a systemd unit: the end says install.sh unit will put bun's folder on its PATH
  const t = inTerminal(['bun', MAIN, '--config', configPath, 'setup'], { HOME: userHome })
  await t.answer('router 的家目錄 home', '\r')
  await t.answer('owner 的 Telegram uid', '555\r')
  await t.answer('worker 用的模型 model', '\r')
  await t.answer('claude 執行檔 claudeBin', `${fakeClaude}\r`)
  await t.answer('名稱', '\r')
  // a slip: two extra keys taken back, then all of it cleared, then the token pasted at once
  await t.answer('bot token', ['12', 'x', '\x7f', '\x15', TOKEN, '\r'])
  await t.answer('Bot API: 1) 官方', '2\r')
  await t.answer('Bot API server 的網址', `${ROOT}\r`)
  await t.answer('server 的 --dir', '\r')
  await t.answer('要再加一隻 bot 嗎?', '\r')
  await t.answer('寫入 ', '\r')
  t.close()
  expect(await t.exited).toBe(0)
  const screen = t.out
  expect(screen).toContain('*'.repeat(TOKEN.length))
  expect(screen).toContain('***\b \b\b \b\b \b')
  expect(screen).not.toContain(TOKEN)
  expect(screen).not.toContain('T'.repeat(30))
  expect(screen).toContain('驗證成功: @cc_bot (id 123)')
  if (!['/.local/bin', '/bin'].some(d => dirname(Bun.which('bun')!) === join(userHome, d)) && !['/usr/local/bin', '/usr/bin', '/bin'].includes(dirname(Bun.which('bun')!))) expect(screen).toContain('還沒安裝 systemd unit: deploy/install.sh unit 會把它的資料夾加進 unit 的 PATH')
  expect(seen).toEqual(['getMe TOKEN'])
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  expect(cfg.bots).toEqual([{ name: 'cc', token: TOKEN, apiRoot: ROOT }])
  expect(cfg.owners).toEqual(['555'])
  expect(cfg.home).toBe(dir)
  expect(statSync(configPath).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(join(state, 'access.json'), 'utf8'))).toEqual({ dmPolicy: 'pairing', allowFrom: ['555'], groups: {}, pending: {} })
  expect(statSync(join(state, 'access.json')).mode & 0o777).toBe(0o600)
}, 60000)

test.skipIf(!hasScript)('in a terminal again: the edit mode, Enter keeps everything; Ctrl-C at the token writes nothing', async () => {
  const before = readFileSync(configPath, 'utf8')
  const t = inTerminal(['bun', MAIN, '--config', configPath, 'setup'])
  await t.answer('修改模式', [])
  for (const p of ['router 的家目錄 home', 'owner 的 Telegram uid', 'worker 用的模型 model', 'claude 執行檔 claudeBin', '1) 保留  2) 修改  3) 移除', '要再加一隻 bot 嗎?']) await t.answer(p, '\r')
  t.close()
  expect(await t.exited).toBe(0)
  expect(t.out).toContain('沒有任何變更, 不寫入')
  expect(t.out).toContain(`末 4 碼 ${TOKEN.slice(-4)}`)
  expect(readFileSync(configPath, 'utf8')).toBe(before)
  const c = inTerminal(['bun', MAIN, '--config', configPath, 'setup'])
  for (const p of ['router 的家目錄 home', 'owner 的 Telegram uid', 'worker 用的模型 model', 'claude 執行檔 claudeBin']) await c.answer(p, '\r')
  await c.answer('1) 保留  2) 修改  3) 移除', '2\r')
  await c.answer('名稱', '\r')
  await c.answer('bot token', ['abc', '\x03'])
  c.close()
  expect(await c.exited).toBe(130)
  expect(c.out).toContain('已取消, 沒有寫入任何設定')
  expect(readFileSync(configPath, 'utf8')).toBe(before)
}, 60000)

test.skipIf(!hasScript)('an owner added to config.json by hand: the router puts them into allowFrom at start, the rest of access.json kept', async () => {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  cfg.owners = ['555', '777']
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  router = Bun.spawn(['bun', MAIN, '--config', configPath], { stdout: 'ignore', stderr: 'pipe' })
  let stderr = ''
  void (async () => { for await (const c of router!.stderr as ReadableStream<Uint8Array>) stderr += new TextDecoder().decode(c) })()
  const allow = () => JSON.parse(readFileSync(join(state, 'access.json'), 'utf8')).allowFrom
  for (let t = 0; !allow().includes('777'); t += 50) { if (t > 15000) throw new Error(stderr.slice(-1500)); await sleep(50) }
  expect(allow()).toEqual(['555', '777'])
  expect(JSON.parse(readFileSync(join(state, 'access.json'), 'utf8')).dmPolicy).toBe('pairing')
  for (let t = 0; !stderr.includes('access.json: owner 777 加入 allowFrom'); t += 50) { if (t > 5000) throw new Error(stderr.slice(-1500)); await sleep(50) }
}, 30000)
