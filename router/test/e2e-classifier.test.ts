// Tool call classifier end to end (選配 1 工具呼叫自動分類器, stage 1 record
// only; router/classifier.ts): the real router, its hook path, a fake Bot
// API, fake Decisions and Jev servers and a fake claude. Keep in sync with
// README 「工具呼叫分類器」; unit level in classifier.test.ts.
//   a user conversation's call the rules allow: the hook answers at once (the
//   judges are slow), then all three are recorded; what reached the APIs has
//   no held value, no conversation folder and no chat id; a call the rules
//   block and an owner conversation's call are not sent; telegram plugin
//   tools are not judged in the hook; the message that started the turn goes
//   along, masked; a Telegram reply of a user conversation is judged
//   router-side (kind telegram), an owner's is not; /router classifier from
//   the terminal CLI.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { connectRouter } from '../../plugin/client'

const dir = mkdtempSync(join(tmpdir(), 'cctr-cls-e2e-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const OWNER = { id: 55500001, is_bot: false, first_name: 'Boss', username: 'boss' }
const USER = { id: 66600001, is_bot: false, first_name: 'U', username: 'u' }
const OR_KEY = 'sk-or-fake-classifier-e2e-0001'

const apiSeen: Array<{ path: string; body: any; auth: string | null }> = []
const updates: unknown[] = []
const now = Math.floor(Date.now() / 1000)
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const body = (req.headers.get('content-type') ?? '').includes('json') ? await req.json() : {}
    // the classifier APIs answer slowly: the hook must not wait for them
    // OpenRouter's Decisions router: one endpoint, the model picks Decisions or Jev
    if (url.pathname === '/api/alpha/decisions') {
      apiSeen.push({ path: url.pathname, body, auth: req.headers.get('authorization') })
      await sleep(1500)
      const m = String(body.model)
      return Response.json(m.startsWith('openai/')
        ? { model: 'openai/gpt-6-luna-decisions-20261006', provider: 'OpenAI', answers: { block: { type: 'noul', noul: 0.05 }, risk: { type: 'score', score: 0.2, confidence: 0.9, legend: {}, probabilities: {} } }, usage: { input_tokens: 800, output_tokens: 0, cost: 0.0000286 } }
        : m === 'cloudflare/clef' ? { model: 'cloudflare/clef', provider: 'PrimeIntellect', answers: { block: { type: 'noul', noul: 0.15 }, risk: { type: 'score', score: 0.6, legend: {}, probabilities: {}, confidence: 0.7 } }, usage: { input_tokens: 810, output_tokens: 20, cost: 0.00000995 } }
        : m === 'cloudflare/clef-flash' ? { model: 'cloudflare/clef-flash', provider: 'DeepInfra', answers: { block: { type: 'noul', noul: 0.25 }, risk: { type: 'score', score: 0.9, legend: {}, probabilities: {}, confidence: 0.5 } }, usage: { input_tokens: 810, output_tokens: 20, cost: 0.0000045 } }
        : { model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', answers: { block: { type: 'noul', noul: 0.85 }, risk: { type: 'score', score: 2.1, legend: {}, probabilities: {}, confidence: 0.6 } }, usage: { input_tokens: 820, output_tokens: 20, cost: 0.0000146 } })
    }
    const parts = url.pathname.split('/')
    const method = parts.pop()!
    const ok = (result: unknown) => Response.json({ ok: true, result })
    switch (method) {
      case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot', can_read_all_group_messages: true })
      case 'getUpdates': await sleep(100); return ok(updates.splice(0))
      case 'sendMessage': return ok({ message_id: 900, date: now, chat: { id: Number(body.chat_id) }, text: body.text })
      default: return ok(true)
    }
  },
})

const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash
if [ "$1" = "-p" ]; then cat >> ${dir}/claude-stdin; echo >> ${dir}/claude-stdin; sleep 1; echo '{"type":"result","result":"{\\"p_block\\":0.1,\\"risk\\":0.5,\\"reason\\":\\"一般讀檔\\"}","total_cost_usd":0.002,"usage":{"input_tokens":3,"cache_read_input_tokens":2900,"output_tokens":40}}'; exit 0; fi
case "$*" in *agents*) echo '[]' ;; *--bg*) echo "backgrounded · abcd1234 · tg-x (idle)" ;; esac
`)
chmodSync(fakeClaude, 0o755)
writeFileSync(join(state, 'config.json'), JSON.stringify({
  bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: [String(OWNER.id)],
  model: 'claude-opus-5-5', claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}`,
  credentials: {
    openrouter: { token: OR_KEY, kind: 'http', baseUrl: `http://127.0.0.1:${api.port}`, methods: [], roles: [] },
  },
  classifier: { enabled: true },
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(OWNER.id), String(USER.id)], groups: {}, pending: {} }))

const router = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { stdout: 'ignore', stderr: 'pipe' })
let stderr = ''
void (async () => { for await (const c of router.stderr) stderr += new TextDecoder().decode(c) })()

afterAll(async () => {
  router.kill('SIGTERM')
  await router.exited
  api.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

async function until<T>(fn: () => T | undefined | false, ms = 10000): Promise<T> {
  for (let t = 0; t < ms; t += 50) {
    try { const v = fn(); if (v) return v } catch {}
    await sleep(50)
  }
  throw new Error(`timed out\n${stderr.slice(-2000)}`)
}
const q = (sql: string) => {
  const db = new Database(join(state, 'router.db'), { readonly: true })
  try { return db.query(sql).all() as any[] } finally { db.close() }
}
let mid = 1
const dm = (from: typeof OWNER, text: string) => { const id = mid++; updates.push({ update_id: id, message: { message_id: id, date: now, chat: { id: from.id, type: 'private' }, from, text } }); return id }
const folder = (key: string) => join(dir, 'bot123', key)

/** The worker's PreToolUse hook (hooks/hook.ts progress pre); the decision it printed and how long it took. */
/** A connected worker (the plugin side): acks what it is delivered. */
const worker = (key: string, pid: number, delivered: string[] = []) => {
  const c = connectRouter({ socketPath: join(state, 'router.sock'), hello: { t: 'hello', project_dir: folder(key), pid }, onMessage(m) { if (m.t === 'deliver') { delivered.push(JSON.stringify(m.params)); c.send({ t: 'ack', qid: m.qid }) } } })
  return c
}

async function hook(key: string, tool_name: string, tool_input: object): Promise<{ out: any; ms: number }> {
  const t0 = performance.now()
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'hooks', 'hook.ts'), 'progress', 'pre'], {
    stdin: new Blob([JSON.stringify({ cwd: folder(key), tool_name, tool_input })]), stdout: 'pipe',
    env: { ...process.env, CC_TELEGRAM_ROUTER_SOCKET: join(state, 'router.sock'), CLAUDE_PROJECT_DIR: folder(key) },
  })
  const text = await new Response(p.stdout).text()
  await p.exited
  return { out: text ? JSON.parse(text).hookSpecificOutput : null, ms: performance.now() - t0 }
}

test('a user call the rules allow: the hook answers at once; every provider (Decisions, Jev, Clef, Clef Flash, claude) is recorded afterwards; nothing held, no folder, no chat id left the machine', async () => {
  dm(USER, `幫我找筆記, 找到跟 ${OWNER.id} 說`)
  dm(OWNER, 'hi')
  const ukey = `dm-${USER.id}`, okey = `dm-${OWNER.id}`
  await until(() => q(`SELECT key FROM conversations WHERE key IN ('${ukey}', '${okey}')`).length === 2)
  // the workers connect and get their message: the classifier keeps it for this turn
  const got: string[] = []
  worker(ukey, 11, got)
  worker(okey, 12)
  await until(() => got.some(g => g.includes('幫我找筆記')))
  // a Grep in its own folder: allowed for user; the pattern carries a held value and the chat ids
  const r = await hook(ukey, 'Grep', { pattern: `${OR_KEY}|${USER.id}|${OWNER.id}`, path: join(folder(ukey), 'notes') })
  expect(r.out).toBeNull()
  expect(r.ms).toBeLessThan(1400)
  expect(stderr).toContain('classifier: on (record only), openai openrouter openai/gpt-6-luna-decisions, typesafe openrouter typesafe/jev-1.13, clef openrouter cloudflare/clef, clefflash openrouter cloudflare/clef-flash, telegram tools on')
  const call = await until(() => q("SELECT * FROM classify_calls")[0])
  expect(call).toMatchObject({ conv: ukey, role: 'user', tool: 'Grep', masked: 1 })
  await until(() => q(`SELECT count(*) n FROM classify_results WHERE call_id = ${call.id}`)[0].n === 5, 15000)
  const rs = Object.fromEntries(q(`SELECT * FROM classify_results WHERE call_id = ${call.id}`).map(x => [x.provider, x]))
  // the billed cost from OpenRouter's usage.cost
  expect(rs.openai).toMatchObject({ status: 'ok', model: 'openai/gpt-6-luna-decisions-20261006', p_block: 0.05, risk: 0.2, input_tokens: 800, cost_usd: 0.0000286 })
  expect(rs.typesafe).toMatchObject({ status: 'ok', model: 'typesafe/jev-1.13-20260917', p_block: 0.85, risk: 2.1, confidence: 0.6, cost_usd: 0.0000146 })
  expect(rs.clef).toMatchObject({ status: 'ok', model: 'cloudflare/clef', p_block: 0.15, cost_usd: 0.00000995 })
  expect(rs.clefflash).toMatchObject({ status: 'ok', model: 'cloudflare/clef-flash', p_block: 0.25, cost_usd: 0.0000045 })
  expect(rs.claude).toMatchObject({ status: 'ok', model: 'claude-opus-5-5', p_block: 0.1, risk: 0.5, cost_usd: 0.002, detail: '一般讀檔' })
  for (const p of ['openai', 'typesafe', 'clef', 'clefflash']) expect(rs[p].latency_ms).toBeGreaterThanOrEqual(1400)
  expect(apiSeen.map(s => [s.path, s.auth, s.body.model]).sort()).toEqual(['cloudflare/clef', 'cloudflare/clef-flash', 'openai/gpt-6-luna-decisions', 'typesafe/jev-1.13'].map(m => ['/api/alpha/decisions', `Bearer ${OR_KEY}`, m]))
  const outgoing = [...apiSeen.map(s => JSON.stringify(s.body)), await Bun.file(join(dir, 'claude-stdin')).text(), call.sent]
  for (const o of outgoing) {
    expect(o).toContain('Grep')
    expect(o).not.toContain(OR_KEY)
    expect(o).not.toContain(String(USER.id))
    expect(o).not.toContain(String(OWNER.id))
    expect(o).not.toContain(dir)
    expect(o).toContain('<conversation-folder>/notes')
    expect(o).toContain('幫我找筆記, 找到跟 <chat-id> 說')
  }
}, 30000)

test('Telegram tools are judged router-side: a user conversation\'s reply (kind telegram, the Telegram setting); an owner\'s is not', async () => {
  const before = q("SELECT count(*) n FROM classify_calls WHERE kind = 'telegram'")[0].n
  const u = worker(`dm-${USER.id}`, 21), o = worker(`dm-${OWNER.id}`, 22)
  await sleep(200)
  const t0 = performance.now()
  const res = await u.call('reply', { chat_id: String(USER.id), text: '找到了: notes/a.md' })
  expect(res.isError).toBeFalsy()
  expect(performance.now() - t0).toBeLessThan(1400)
  expect((await o.call('reply', { chat_id: String(OWNER.id), text: 'owner 的回覆' })).isError).toBeFalsy()
  const call = await until(() => q("SELECT * FROM classify_calls WHERE kind = 'telegram'")[before])
  expect(call).toMatchObject({ conv: `dm-${USER.id}`, role: 'user', tool: 'mcp__plugin_telegram_telegram__reply', summary: 'telegram:reply: {"chat_id":"<chat-id>","text":"找到了: notes/a.md"}' })
  expect(JSON.parse(call.sent).setting).toContain('content to be sent to Telegram')
  await until(() => q(`SELECT count(*) n FROM classify_results WHERE call_id = ${call.id}`)[0].n === 5, 15000)
  await sleep(300)
  expect(q("SELECT count(*) n FROM classify_calls WHERE kind = 'telegram'")[0].n).toBe(before + 1)
}, 30000)

test('not sent: a call the rules block, an owner conversation, telegram plugin tools', async () => {
  const before = q('SELECT count(*) n FROM classify_calls')[0].n
  const blocked = await hook(`dm-${USER.id}`, 'Read', { file_path: '/etc/hosts' })
  expect(blocked.out).toMatchObject({ permissionDecision: 'deny' })
  expect((await hook(`dm-${OWNER.id}`, 'Bash', { command: 'ls' })).out).toBeNull()
  expect((await hook(`dm-${USER.id}`, 'mcp__plugin_telegram_telegram__reply', { chat_id: String(USER.id), text: 'hi' })).out).toBeNull()
  await sleep(500)
  expect(q('SELECT count(*) n FROM classify_calls')[0].n).toBe(before)
}, 20000)

test('/router classifier from the owner terminal: the report', async () => {
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json'), 'cli', 'classifier', '7'], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  expect(out).toContain('🧪 工具呼叫分類器 (第一階段, 只記錄): 最近 7 天, 2 筆呼叫')
  expect(out).toContain('【一般工具】 1 筆')
  expect(out).toContain('【Telegram 工具 (要送到 Telegram 的內容)】 1 筆')
  expect(out).toContain('openai (openai/gpt-6-luna-decisions-20261006): 成功 1')
  expect(out).toContain('typesafe (typesafe/jev-1.13-20260917): 成功 1')
  expect(out).toContain('clef (cloudflare/clef): 成功 1')
  expect(out).toContain('clefflash (cloudflare/clef-flash): 成功 1')
  expect(out).toContain('實際費用 (openai + typesafe + clef + clefflash): $0.00012')
  expect(out).toContain('claude (claude-opus-5-5): 成功 1')
  expect(out).toContain('實際費用 (openai + typesafe + clef + clefflash)')
  expect(out).toContain('claude 訂閱用量 (API 換算, 不是實際支出): $0.004')
  // typesafe says block (0.85), claude says allow (0.1)
  expect(out).toContain('最近 2 筆跟 claude 意見不同')
})
