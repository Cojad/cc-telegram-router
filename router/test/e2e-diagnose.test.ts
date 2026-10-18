// Why workers fail, end to end (docs/operations.md 「疑難排解」): the real
// router from source against a fake Bot API and a fake claude, with a
// temporary HOME (its own ~/.claude.json, never this machine's) and a PATH
// without bun. At start the owner hears that bun is missing and that home is
// not trusted, each with its fix. A DM wakes a worker that claude --bg
// refuses (Workspace not trusted): the owner is told the cause and the fix
// once, the next message within the hold neither starts claude again nor
// tells again. A turn that ends on an API error (the StopFailure hook's
// event, sent by hooks/hook.ts: Usage credits required for 1M context) tells the owner why and
// what to do, and the chat that no answer is coming. /router status shows
// the trouble; /router doctor answers in the owner's DM without a token.
// Module level in diagnose.test.ts.

import { test, expect, afterAll } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { encode } from '../../shared/protocol'

const dir = mkdtempSync(join(tmpdir(), 'cctr-e2e-diagnose-'))
const state = join(dir, '.router')
const userHome = join(dir, 'user-home')
for (const d of [state, userHome]) mkdirSync(d, { recursive: true })
// this HOME's Claude Code trusts some other folder, not the router's home
writeFileSync(join(userHome, '.claude.json'), JSON.stringify({ projects: { '/somewhere/else': { hasTrustDialogAccepted: true } } }))
const TOKEN = '123:test'
/** A token in the real format: masked wherever it would show. */
const PASTED = `7000000001:${'A'.repeat(35)}`
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const OWNER = { id: 555, is_bot: false, first_name: 'Boss', username: 'boss' }
const now = Math.floor(Date.now() / 1000)
const calls: Array<{ method: string; body: any }> = []
const updates: unknown[] = []
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    const body = (req.headers.get('content-type') ?? '').includes('json') ? await req.json() : {}
    calls.push({ method, body })
    const ok = (result: unknown) => Response.json({ ok: true, result })
    if (method === 'getMe') return ok({ id: 123, is_bot: true, first_name: 'cc', username: 'cc_bot' })
    if (method === 'getUpdates') { await sleep(100); return ok(updates.splice(0)) }
    if (method === 'sendMessage') return ok({ message_id: 900 + calls.length, date: now, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text })
    return ok(true)
  },
})
// claude --bg refuses the way Claude Code does in an untrusted folder; every call is logged
const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash\necho "$*" >> "${dir}/claude.log"\ncase "$*" in *agents*) echo '[]' ;; *--bg*) echo "Workspace not trusted. Run \\\`claude\\\` in $PWD once and accept the trust prompt, then retry." >&2; exit 1 ;; esac\n`)
chmodSync(fakeClaude, 0o755)
writeFileSync(join(state, 'config.json'), JSON.stringify({ bots: [{ name: 'cc', token: TOKEN }], home: dir, stateDir: state, owners: ['555'], model: 'claude-sonnet-4-6[1m]', claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}` }))
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['555'], groups: {}, pending: {} }))

const router = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { env: { HOME: userHome, PATH: '/usr/bin:/bin' }, stdout: 'ignore', stderr: 'pipe' })
let stderr = ''
void (async () => { for await (const c of router.stderr) stderr += new TextDecoder().decode(c) })()
afterAll(async () => {
  router.kill('SIGTERM')
  await router.exited
  api.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

async function until<T>(fn: () => T | undefined | false, ms = 15000): Promise<T> {
  for (let t = 0; t < ms; t += 50) { try { const v = fn(); if (v) return v } catch {} await sleep(50) }
  throw new Error(`timed out; router stderr:\n${stderr.slice(-2000)}`)
}
const toOwner = (prefix: string) => calls.filter(c => c.method === 'sendMessage' && Number(c.body.chat_id) === 555 && String(c.body.text).startsWith(prefix))
let mid = 1
const dm = (text: string) => { const id = mid++; updates.push({ update_id: id, message: { message_id: id, date: now, chat: { id: 555, type: 'private' }, from: OWNER, text } }); return id }
const bgCalls = () => (existsSync(join(dir, 'claude.log')) ? readFileSync(join(dir, 'claude.log'), 'utf8') : '').split('\n').filter(l => l.includes('--bg')).length

test('at start: bun missing on the router\'s PATH and home not trusted, each told to the owner with its fix; the model\'s 1M credits noted', async () => {
  const bun = await until(() => toOwner('⚠️ router 的 PATH 找不到 bun')[0])
  expect(bun.body.text).toContain('deploy/install.sh unit')
  expect(bun.body.text).toContain('目前的 PATH: /usr/bin:/bin')
  const trust = await until(() => toOwner(`⚠️ router 的 home ${dir} 沒有被 Claude Code 信任`)[0])
  expect(trust.body.text).toContain(`cd ${dir} && claude`)
  const model = await until(() => toOwner('ℹ️ 模型 claude-sonnet-4-6[1m]')[0])
  expect(model.body.text).toContain('usage credits')
}, 30000)

test('a worker claude --bg refuses: the owner told the cause and the fix once; the next message within the hold neither starts claude nor tells again', async () => {
  dm('嗨')
  const notice = await until(() => toOwner('⚠️ dm-555')[0])
  expect(notice.body.text).toContain('的 worker 叫不醒, 訊息還在佇列裡.')
  expect(notice.body.text).toContain('原因: 資料夾沒有被信任 (Workspace not trusted)')
  expect(notice.body.text).toContain(`修法: 在 router 的使用者下互動執行一次: cd ${dir} && claude`)
  expect(notice.body.text).toContain('下次自動重試')
  expect(bgCalls()).toBe(1)
  dm('還在嗎')
  await sleep(1500)
  expect(bgCalls()).toBe(1)
  expect(toOwner('⚠️ dm-555')).toHaveLength(1)
  expect(stderr).toContain('dm-555: wake failed (1 in a row): 資料夾沒有被信任 (Workspace not trusted)')
}, 30000)

/** What a worker's StopFailure hook sends (hooks/hook.ts stop-failure). */
function hookEvent(ev: Record<string, unknown>): Promise<void> {
  return new Promise(resolve => {
    Bun.connect({ unix: join(state, 'router.sock'), socket: { open(s) { s.write(encode({ t: 'hook', id: 1, project_dir: join(dir, 'bot123', 'dm-555'), ev } as never)) }, data(s) { s.end(); resolve() }, close() { resolve() }, error() { resolve() } } }).catch(() => resolve())
  })
}

test('a turn ending on an API error (StopFailure): the owner learns the 1M credits cause and the fix; the chat that no answer is coming; /router status shows it', async () => {
  // the worker's own hook, as Claude Code runs it on StopFailure (hooks/hook.ts progress stop-failure)
  const folder = join(dir, 'bot123', 'dm-555')
  const h = Bun.spawn([process.execPath, join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', 'stop-failure'], {
    stdin: new Blob([JSON.stringify({ hook_event_name: 'StopFailure', cwd: folder, error: 'invalid_request', error_details: '', last_assistant_message: `API Error: Usage credits required for 1M context · run /usage-credits to turn them on ${PASTED}` })]),
    env: { ...process.env, HOME: userHome, XDG_RUNTIME_DIR: state, CC_TELEGRAM_ROUTER_SOCKET: join(state, 'router.sock'), CLAUDE_PROJECT_DIR: folder }, stdout: 'ignore', stderr: 'ignore',
  })
  await h.exited
  const owner = await until(() => toOwner('⚠️ dm-555').find(c => String(c.body.text).includes('這一輪因 API 錯誤結束, 沒有回覆.')))
  expect(owner.body.text).toContain('原因: 模型 claude-sonnet-4-6[1m] 用 1M context, 這個帳號沒有 1M context 的額度 (usage credits)')
  expect(owner.body.text).toContain('/router config set model claude-sonnet-4-6')
  const chat = await until(() => calls.find(c => c.method === 'sendMessage' && String(c.body.text).startsWith('⚠️ 暫時無法回應: 這個模型需要 1M context 額度')))
  expect(Number(chat.body.chat_id)).toBe(555)
  // the same error again soon: neither told again
  await hookEvent({ event: 'stop', failure: { error: 'invalid_request', message: 'API Error: Usage credits required for 1M context' } })
  await sleep(500)
  expect(toOwner('⚠️ dm-555').filter(c => String(c.body.text).includes('這一輪因 API 錯誤結束'))).toHaveLength(1)
  expect(calls.filter(c => String(c.body?.text ?? '').startsWith('⚠️ 暫時無法回應'))).toHaveLength(1)
  dm('/router status')
  const status = await until(() => toOwner('router 已運作')[0])
  expect(status.body.text).toContain('模型 claude-sonnet-4-6[1m] 用 1M context')
  for (const c of calls) expect(JSON.stringify(c.body)).not.toContain(PASTED)
  expect(stderr).not.toContain(PASTED)
}, 30000)

test('/router doctor: in the owner\'s DM, the checks that fail here, no token', async () => {
  dm('/router doctor')
  const d = await until(() => toOwner('cc-telegram-router doctor')[0])
  expect(d.body.text).toContain('(經由執行中的 router)')
  expect(d.body.text).toContain('⚠️ 找不到 bun')
  expect(d.body.text).toContain(`❌ home ${dir} 沒有被 Claude Code 信任`)
  expect(d.body.text).toContain('⚠️ 預設: 模型 claude-sonnet-4-6[1m]')
  expect(d.body.text).not.toContain(TOKEN)
}, 30000)
