// Sending into a worker from outside the router, end to end (docs/operations.md
// 「從外部送訊息給 worker」): the real router, a fake Bot API, and a fake
// claude CLI whose workers are real processes on the router socket
// (fixtures/), driven by the real `cli session send`. Covers:
//   - an awake worker gets it at once and the terminal prints 已送達
//   - a worker that is gone is woken and gets it (text from stdin, newlines kept)
//   - a message queued while the worker cannot be woken stays queued over a
//     router restart and arrives after it; with the router down the terminal
//     says so and queues nothing
// (parsing, the header, exit codes, refusals: sessionsend.test.ts)

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

const dir = mkdtempSync(join(tmpdir(), 'cctr-send-e2e-'))
const state = join(dir, '.router')
mkdirSync(state)
const FAKE = join(dir, 'fake-state.json')
const CONFIG = join(state, 'config.json')
const MAIN = join(import.meta.dir, '..', 'main.ts')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// --- fake Bot API: updates are fed by the tests --------------------------
const pendingUpdates: unknown[] = []
let nextUpdate = 1, nextMsg = 100
const now = Math.floor(Date.now() / 1000)
const sent: Array<{ chat_id: unknown; text: string }> = []
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    const ok = (result: unknown) => Response.json({ ok: true, result })
    if (method === 'getMe') return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot' })
    if (method === 'getUpdates') { await sleep(100); return ok(pendingUpdates.splice(0)) }
    if (method === 'sendMessage') { const b = await req.json().catch(() => ({})) as any; sent.push({ chat_id: b.chat_id, text: String(b.text ?? '') }); return ok({ message_id: 9000, date: now, chat: { id: 1 }, text: '' }) }
    return ok(true)
  },
})
function say(chat: { id: number; type: string }, from: number, text: string) {
  pendingUpdates.push({ update_id: nextUpdate++, message: { message_id: nextMsg++, date: now, chat, from: { id: from, is_bot: false, first_name: 'U' + from }, text } })
}
const DM = { id: 111, type: 'private' }

writeFileSync(CONFIG, JSON.stringify({
  bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: ['111'],
  claudeBin: join(import.meta.dir, 'fixtures', 'fake-claude.ts'), apiRoot: `http://127.0.0.1:${api.port}`,
  // the first backlog sweep 2 s after start (tests only; the router's own waits 15 s)
  backlogSweepFirstMs: 2000,
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111'], groups: {}, pending: {} }))
const env = { ...process.env, FAKE_STATE: FAKE, FAKE_SOCKET: join(state, 'router.sock') }
const startRouter = () => Bun.spawn(['bun', MAIN, '--config', CONFIG], { env, stdout: 'ignore', stderr: 'ignore' })
let router = startRouter()

afterAll(async () => {
  try { for (const j of jobs()) if (j.pid) try { process.kill(j.pid) } catch {} } catch {}
  router.kill('SIGTERM'); await router.exited
  api.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

const lines = (f: string) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []
const deliveries = () => lines(FAKE + '.deliveries').map(l => JSON.parse(l) as { dir: string; pid: number; qid: number; content: string })
async function until<T>(fn: () => T | undefined | false, ms = 15000): Promise<T> {
  for (let t = 0; t < ms; t += 100) { const v = fn(); if (v) return v; await sleep(100) }
  throw new Error('timed out')
}
function jobs(): Array<{ id: string; cwd: string; pid: number | null }> {
  const d = FAKE + '.jobs'
  return existsSync(d) ? readdirSync(d).map(f => JSON.parse(readFileSync(join(d, f), 'utf8'))) : []
}
const jobFor = (key: string) => jobs().find(j => j.cwd.endsWith('/' + key))!
const alive = (pid: number | null) => { try { return !!pid && (process.kill(pid, 0), true) } catch { return false } }

/** The real terminal command; stdin is piped (a non-terminal) unless given. */
async function send(args: string[], stdin = ''): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(['bun', MAIN, '--config', CONFIG, 'cli', 'session', 'send', ...args], { env, stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}
const queueRow = (qid: number) => {
  const d = new Database(join(state, 'router.db'), { readonly: true })
  try { return d.query('SELECT status FROM queue WHERE qid = ?').get(qid) as { status: string } | null } finally { d.close() }
}
const qidOf = (out: string) => Number(/已排進佇列 \(#(\d+)\)/.exec(out)?.[1])

test('an awake worker gets it at once, with the host header; the terminal prints 已送達 and exits 0', async () => {
  say(DM, 111, 'hello')
  await until(() => deliveries().some(d => d.content.endsWith('hello')))
  const r = await send(['dm-111', '--from', 'v1', '--wait', '20', '請整理今天的待辦'])
  console.log(`[e2e-sessionsend awake]\n${r.out.trim()}`)
  expect(r.code).toBe(0)
  expect(r.out).toContain('給 dm-111, 發送者 v1: worker 醒著, 直接送出')
  expect(r.out).toMatch(/已送達: worker 收到了/)
  const got = deliveries().filter(d => d.content.includes('<host_message from="v1" via="cli">'))
  expect(got).toHaveLength(1)
  expect(got[0]!.pid).toBe(jobFor('dm-111').pid!)
  expect(got[0]!.content).toContain('---\n請整理今天的待辦\n</host_message>')
  expect(queueRow(qidOf(r.out))?.status).toBe('acked')
  // nothing was posted to the chat by the router itself
  expect(sent.some(s => s.text.includes('請整理今天的待辦'))).toBe(false)
}, 40000)

test('a worker that is gone is woken and gets it; the text comes from stdin with its newlines', async () => {
  const before = jobFor('dm-111')
  process.kill(before.pid!, 'SIGTERM') // the daemon reaping it, or a rotation
  await until(() => !alive(before.pid))
  await sleep(500)
  const r = await send(['dm-111', '--from', 'v1', '--wait', '30'], '第一行\n第二行\n')
  console.log(`[e2e-sessionsend asleep]\n${r.out.trim()}`)
  expect(r.code).toBe(0)
  expect(r.out).toContain('worker 沒有連上, 正在叫醒')
  expect(r.out).toMatch(/已送達: worker 收到了/)
  const got = deliveries().find(d => d.content.includes('---\n第一行\n第二行\n\n</host_message>'))!
  expect(got).toBeDefined()
  expect(got.pid).not.toBe(before.pid) // a new worker process
  expect(jobFor('dm-111').id).toBe(before.id) // same session continues
}, 60000)

test('queued while the worker cannot be woken: stays queued over a router restart and arrives after it; with the router down nothing is queued', async () => {
  writeFileSync(FAKE + '.hold', '') // the fake claude starts no worker
  const before = jobFor('dm-111')
  process.kill(before.pid!, 'SIGTERM')
  await until(() => !alive(before.pid))
  await sleep(500)
  const r = await send(['dm-111', '--from', 'v1', '--wait', '3', '重啟後也要收到'])
  console.log(`[e2e-sessionsend held]\n${r.out.trim()}`)
  expect(r.code).toBe(2)
  expect(r.out).toContain('worker 沒有連上, 正在叫醒')
  expect(r.out).toContain('3 秒內沒有確認送達; 訊息仍在佇列')
  const qid = qidOf(r.out)
  expect(queueRow(qid)?.status).not.toBe('acked')
  // the router goes down
  router.kill('SIGTERM'); await router.exited
  const down = await send(['dm-111', '--from', 'v1', 'router 不在'])
  console.log(`[e2e-sessionsend down] exit ${down.code}: ${down.err.trim()}`)
  expect(down.code).toBe(1)
  expect(down.err).toContain('router 沒在跑')
  expect(down.err).toContain('訊息沒有送出')
  // back up, and the worker can be started again: the backlog sweep wakes it
  rmSync(FAKE + '.hold')
  router = startRouter()
  const got = await until(() => deliveries().find(d => d.content.includes('---\n重啟後也要收到\n</host_message>')), 60000)
  console.log(`[e2e-sessionsend restart] qid ${got.qid} delivered to pid ${got.pid} after the restart`)
  expect(got.qid).toBe(qid)
  await until(() => queueRow(qid)?.status === 'acked')
  expect(deliveries().some(d => d.content.includes('router 不在'))).toBe(false)
  const d = new Database(join(state, 'router.db'), { readonly: true })
  try { expect((d.query("SELECT COUNT(*) AS n FROM queue WHERE params LIKE '%router 不在%'").get() as { n: number }).n).toBe(0) } finally { d.close() }
}, 120000)
