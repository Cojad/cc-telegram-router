// Tool call classifier as an optional feature of a public repo (README
// 「工具呼叫分類器」 開關與設定; router/classifier.ts): the real router against
// a fake Bot API. A classifier block that is not usable never stops the
// router: it starts, says why in its log and the classifier stays off. On but
// with no credentials: each API provider is logged as skipped once at start,
// the worker's tool calls pass as before, the rows say no-key. Unit level in
// classifier.test.ts.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

const dir = mkdtempSync(join(tmpdir(), 'cctr-cls-off-'))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const OWNER = { id: 55500002, is_bot: false, first_name: 'Boss', username: 'boss' }
const USER = { id: 66600002, is_bot: false, first_name: 'U', username: 'u' }
const now = Math.floor(Date.now() / 1000)

/** One fake Bot API per router: its own update queue. */
function fakeTelegram() {
  const updates: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop()!
      const body = (req.headers.get('content-type') ?? '').includes('json') ? await req.json() : {}
      const ok = (result: unknown) => Response.json({ ok: true, result })
      switch (method) {
        case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot', can_read_all_group_messages: true })
        case 'getUpdates': await sleep(100); return ok(updates.splice(0))
        case 'sendMessage': return ok({ message_id: 900, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
        default: return ok(true)
      }
    },
  })
  return { updates, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash
if [ "$1" = "-p" ]; then cat > /dev/null; echo '{"type":"result","result":"{\\"beyond_request\\":0.1,\\"leak\\":0,\\"irreversible\\":0,\\"risk\\":0.5,\\"reason\\":\\"r\\"}","total_cost_usd":0.002,"usage":{"input_tokens":3,"output_tokens":40}}'; exit 0; fi
case "$*" in *agents*) echo '[]' ;; *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;; esac
`)
chmodSync(fakeClaude, 0o755)

const running: Array<{ proc: ReturnType<typeof Bun.spawn>; api: ReturnType<typeof fakeTelegram> }> = []
function startRouter(name: string, classifier: unknown) {
  const state = join(dir, name, '.router')
  mkdirSync(state, { recursive: true })
  const api = fakeTelegram()
  writeFileSync(join(state, 'config.json'), JSON.stringify({
    bots: [{ name: 'cc', token: '123:test' }], home: join(dir, name), stateDir: state, owners: [String(OWNER.id)],
    model: 'claude-opus-5-5', claudeBin: fakeClaude, apiRoot: api.url, classifier,
  }))
  writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(OWNER.id), String(USER.id)], groups: {}, pending: {} }))
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { stdout: 'ignore', stderr: 'pipe' })
  const r = { proc, api, state, home: join(dir, name), stderr: '' }
  void (async () => { for await (const c of proc.stderr) r.stderr += new TextDecoder().decode(c) })()
  running.push({ proc, api })
  return r
}

afterAll(async () => {
  for (const r of running) { r.proc.kill('SIGTERM'); await r.proc.exited; r.api.stop() }
  rmSync(dir, { recursive: true, force: true })
})

async function until<T>(fn: () => T | undefined | false, ms = 10000): Promise<T> {
  for (let t = 0; t < ms; t += 50) {
    try { const v = fn(); if (v) return v } catch {}
    await sleep(50)
  }
  throw new Error('timed out')
}
const q = (state: string, sql: string) => {
  const db = new Database(join(state, 'router.db'), { readonly: true })
  try { return db.query(sql).all() as any[] } finally { db.close() }
}

test('an unusable classifier block: the router starts and works, the log says which field, the classifier is off', async () => {
  const r = startRouter('bad', { enabled: true, keepDays: 'thirty' })
  await until(() => r.stderr.includes('router up'))
  expect(r.stderr).toContain('classifier: config.json classifier 有誤, 分類器關閉: classifier.keepDays 要是 0 以上的數字, 收到 "thirty"')
  expect(r.stderr).not.toContain('classifier: on')
  // still serving: a DM becomes a conversation
  r.api.updates.push({ update_id: 1, message: { message_id: 1, date: now, chat: { id: USER.id, type: 'private' }, from: USER, text: 'hi' } })
  await until(() => q(r.state, `SELECT key FROM conversations WHERE key = 'dm-${USER.id}'`).length === 1)
}, 20000)

test('on with no credentials: each API provider is logged as skipped once at start; tool calls pass as before; rows say no-key', async () => {
  const r = startRouter('nokey', { enabled: true })
  await until(() => r.stderr.includes('router up'))
  expect(r.stderr).toContain('classifier: on (record only)')
  for (const p of ['openai', 'typesafe', 'clef', 'clefflash']) {
    expect(r.stderr.split(`classifier: ${p} skipped (credential openrouter is not in config.json credentials); the others still run`).length - 1).toBe(1)
  }
  r.api.updates.push({ update_id: 1, message: { message_id: 1, date: now, chat: { id: USER.id, type: 'private' }, from: USER, text: 'hi' } })
  const key = `dm-${USER.id}`, folder = join(r.home, 'bot123', key)
  await until(() => q(r.state, `SELECT key FROM conversations WHERE key = '${key}'`).length === 1)
  const hook = async (tool_name: string, tool_input: object) => {
    const p = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', 'pre'], {
      stdin: new Blob([JSON.stringify({ cwd: folder, tool_name, tool_input })]), stdout: 'pipe',
      env: { ...process.env, CC_TELEGRAM_ROUTER_SOCKET: join(r.state, 'router.sock'), CLAUDE_PROJECT_DIR: folder },
    })
    const out = await new Response(p.stdout).text()
    await p.exited
    return out ? JSON.parse(out).hookSpecificOutput : null
  }
  // allowed for user: passes; outside the folder: refused, as without the classifier
  expect(await hook('Read', { file_path: join(folder, 'a.md') })).toBeNull()
  expect(await hook('Read', { file_path: '/etc/hosts' })).toMatchObject({ permissionDecision: 'deny' })
  const call = await until(() => q(r.state, 'SELECT * FROM classify_calls')[0])
  await until(() => q(r.state, `SELECT count(*) n FROM classify_results WHERE call_id = ${call.id}`)[0].n === 5)
  expect(q(r.state, `SELECT provider, status, detail FROM classify_results WHERE call_id = ${call.id} ORDER BY provider`)).toEqual([
    { provider: 'claude', status: 'ok', detail: 'r' },
    { provider: 'clef', status: 'skipped', detail: 'no-key' },
    { provider: 'clefflash', status: 'skipped', detail: 'no-key' },
    { provider: 'openai', status: 'skipped', detail: 'no-key' },
    { provider: 'typesafe', status: 'skipped', detail: 'no-key' },
  ])
  expect(q(r.state, 'SELECT count(*) n FROM classify_calls')[0].n).toBe(1)
  // the first skipped call is not logged again
  expect(r.stderr.split('classifier: openai skipped').length - 1).toBe(1)
}, 20000)
