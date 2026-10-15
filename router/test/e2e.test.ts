// End-to-end Phase 1 acceptance (plan 10 Phase 1 驗收; flows in 03 邏輯流程):
// the real router process against a fake Bot API and a fake claude CLI.
// Every update lands in events, delivered messages are queued per
// conversation and woken, a plugin-side client receives them, and its reply
// goes out through the Bot API and is logged in outbound.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'

const dir = mkdtempSync(join(tmpdir(), 'cctr-e2e-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// --- fake Bot API ---------------------------------------------------------
const calls: Array<{ method: string; body: any }> = []
let updatesServed = false
const now = Math.floor(Date.now() / 1000)
const UPDATES = [
  { update_id: 1, message: { message_id: 10, date: now, chat: { id: 111, type: 'private' }, from: { id: 111, is_bot: false, first_name: 'O', username: 'owner' }, text: 'hello router' } },
  { update_id: 2, message: { message_id: 11, date: now, chat: { id: -100777, type: 'supergroup', title: 'G' }, from: { id: 222, is_bot: false, first_name: 'U', username: 'user' }, text: 'hi group' } },
  { update_id: 3, message: { message_id: 12, date: now, chat: { id: 333, type: 'private' }, from: { id: 333, is_bot: false, first_name: 'X', username: 'stranger' }, text: 'let me in' } },
]
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    const body = req.headers.get('content-type')?.includes('json') ? await req.json() : {}
    calls.push({ method, body })
    const ok = (result: unknown) => Response.json({ ok: true, result })
    switch (method) {
      case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot' })
      case 'getUpdates':
        if (!updatesServed) { updatesServed = true; return ok(UPDATES) }
        await sleep(200)
        return ok([])
      case 'sendMessage': return ok({ message_id: 900 + calls.length, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
      default: return ok(true)
    }
  },
})

// --- fake claude CLI --------------------------------------------------------
const argLog = join(dir, 'claude-args.log')
const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash
echo "$*" >> '${argLog}'
case "$*" in
  *agents*) echo '[]' ;;
  *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;;
esac
`)
chmodSync(fakeClaude, 0o755)

writeFileSync(join(state, 'config.json'), JSON.stringify({
  bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: ['111'],
  model: 'claude-opus-5-5', claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}`,
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({
  dmPolicy: 'allowlist', allowFrom: ['111', '222'], groups: { '-100777': { requireMention: false, allowFrom: [] } }, pending: {},
}))

const router = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { stdout: 'ignore', stderr: 'pipe' })

afterAll(async () => {
  router.kill('SIGTERM')
  await router.exited
  api.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

async function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  for (let t = 0; t < ms; t += 50) {
    try { const v = fn(); if (v) return v } catch {}
    await sleep(50)
  }
  throw new Error('timed out')
}
const q = (sql: string) => {
  const db = new Database(join(state, 'router.db'), { readonly: true })
  try { return db.query(sql).all() as any[] } finally { db.close() }
}

test('every update is logged; allowlisted messages become conversations, settings and a worker spawn; strangers are dropped', async () => {
  await until(() => q("SELECT count(*) n FROM events")[0].n >= 3)
  await until(() => q("SELECT count(*) n FROM queue")[0].n >= 2)
  const convs = q('SELECT key, role FROM conversations ORDER BY key')
  expect(convs).toEqual([{ key: 'dm-111', role: 'owner' }, { key: 'group-100777', role: 'user' }])
  for (const k of ['dm-111', 'group-100777']) {
    expect(existsSync(join(dir, k, 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(state, 'sessions', `${k}.json`))).toBe(true)
  }
  expect(JSON.parse(readFileSync(join(state, 'sessions', 'group-100777.json'), 'utf8')).permissions.defaultMode).toBe('dontAsk')
  expect(JSON.parse(readFileSync(join(state, 'sessions', 'dm-111.json'), 'utf8')).permissions.defaultMode).toBe('bypassPermissions')
  const spawned = await until(() => { const l = readFileSync(argLog, 'utf8'); return l.includes('tg-dm-111') && l.includes('tg-group-100777') && l })
  expect(spawned).toContain('--channels plugin:telegram@claude-plugins-official')
  // the stranger (333) is in events but never queued
  expect(q("SELECT count(*) n FROM queue WHERE params LIKE '%let me in%'")[0].n).toBe(0)
})

test('a plugin for the conversation gets the queued message, and its reply goes out and is logged', async () => {
  const delivered: string[] = []
  const client = connectRouter({
    socketPath: join(state, 'router.sock'),
    hello: { t: 'hello', project_dir: join(dir, 'dm-111'), pid: 1 },
    onMessage(m) { if (m.t === 'deliver') { delivered.push(m.params.content); client.send({ t: 'ack', qid: m.qid }) } },
  })
  await until(() => delivered.length >= 1)
  // first delivery on a connection carries the chat_context (plan 06)
  expect(delivered).toHaveLength(1)
  expect(delivered[0]).toStartWith('<chat_context v="')
  expect(delivered[0]).toContain('role: owner')
  expect(delivered[0]).toEndWith('\nhello router')
  const r = await client.call('reply', { chat_id: '111', text: 'pong' })
  expect(r.isError).toBeFalsy()
  expect(calls.some(c => c.method === 'sendMessage' && c.body.text === 'pong')).toBe(true)
  const out = await until(() => q("SELECT conv, method, payload_json, error FROM outbound WHERE method = 'sendMessage'")[0])
  expect(out.conv).toBe('dm-111')
  expect(JSON.parse(out.payload_json)).toMatchObject({ chat_id: '111', text: 'pong' })
  expect(out.error).toBeNull()
  // a user-role conversation cannot write to another chat
  const g = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: join(dir, 'group-100777'), pid: 2 }, onMessage(m) { if (m.t === 'deliver') g.send({ t: 'ack', qid: m.qid }) } })
  await until(() => g.state().kind === 'ready')
  const denied = await g.call('reply', { chat_id: '111', text: 'leak' })
  expect(denied.isError).toBe(true)
  expect(calls.some(c => c.body?.text === 'leak')).toBe(false)
  await until(() => q("SELECT count(*) n FROM queue WHERE status != 'acked'")[0].n === 0)
  client.close(); g.close()
  expect(q("SELECT count(*) n FROM outbound WHERE method = 'getUpdates'")[0].n).toBe(0)
}, 15000)
