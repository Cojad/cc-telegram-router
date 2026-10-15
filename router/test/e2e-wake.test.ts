// Phase 1 acceptance, end to end (plan 10 Phase 1 驗收): the real router,
// a fake Bot API, and a fake claude CLI whose workers are real processes
// connecting to the router socket (fixtures/). Covers:
//   - DM and group each get their own worker; each worker only receives its
//     own conversation's messages
//   - a worker that was reaped is woken again by the next message
//   - a burst of messages while the worker is down wakes it exactly once and
//     every message arrives once, in order
// (every update / payload in the db: e2e.test.ts)

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'cctr-wake-'))
const state = join(dir, '.router')
mkdirSync(state)
const FAKE = join(dir, 'fake-state.json')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// --- fake Bot API: updates are fed by the tests --------------------------
const pendingUpdates: unknown[] = []
let nextUpdate = 1, nextMsg = 100
const now = Math.floor(Date.now() / 1000)
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    const ok = (result: unknown) => Response.json({ ok: true, result })
    if (method === 'getMe') return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot' })
    if (method === 'getUpdates') { await sleep(100); return ok(pendingUpdates.splice(0)) }
    if (method === 'sendMessage') return ok({ message_id: 9000, date: now, chat: { id: 1 }, text: '' })
    return ok(true)
  },
})
function say(chat: { id: number; type: string }, from: number, text: string) {
  pendingUpdates.push({ update_id: nextUpdate++, message: { message_id: nextMsg++, date: now, chat, from: { id: from, is_bot: false, first_name: 'U' + from }, text } })
}
const DM = { id: 111, type: 'private' }
const GROUP = { id: -100777, type: 'supergroup', title: 'G' }

writeFileSync(join(state, 'config.json'), JSON.stringify({
  bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: ['111'],
  claudeBin: join(import.meta.dir, 'fixtures', 'fake-claude.ts'), apiRoot: `http://127.0.0.1:${api.port}`,
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({
  dmPolicy: 'allowlist', allowFrom: ['111', '222'], groups: { '-100777': { requireMention: false, allowFrom: [] } }, pending: {},
}))
const router = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], {
  env: { ...process.env, FAKE_STATE: FAKE, FAKE_SOCKET: join(state, 'router.sock') }, stdout: 'ignore', stderr: 'ignore',
})

afterAll(async () => {
  try { for (const j of Object.values(JSON.parse(readFileSync(FAKE, 'utf8'))) as Array<{ pid: number | null }>) if (j.pid) try { process.kill(j.pid) } catch {} } catch {}
  router.kill('SIGTERM'); await router.exited
  api.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

const lines = (f: string) => existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []
const deliveries = () => lines(FAKE + '.deliveries').map(l => JSON.parse(l) as { dir: string; pid: number; qid: number; content: string })
const cliCalls = () => lines(FAKE + '.log')
/** Strip the <chat_context>/<router_log> header the router prepends. */
const body = (c: string) => c.split('\n').at(-1)!
async function until<T>(fn: () => T | undefined | false, ms = 15000): Promise<T> {
  for (let t = 0; t < ms; t += 100) { const v = fn(); if (v) return v; await sleep(100) }
  throw new Error('timed out')
}
function jobFor(key: string): { id: string; pid: number | null } {
  return (Object.values(JSON.parse(readFileSync(FAKE, 'utf8'))) as Array<{ id: string; cwd: string; pid: number | null }>).find(j => j.cwd.endsWith('/' + key))!
}

test('DM and group each get their own worker, and each worker only receives its own conversation', async () => {
  say(DM, 111, 'dm-1')
  say(GROUP, 222, 'group-1')
  await until(() => deliveries().length >= 2)
  const d = deliveries()
  const dm = d.filter(x => x.dir.endsWith('/dm-111'))
  const gr = d.filter(x => x.dir.endsWith('/group-100777'))
  expect(dm.map(x => body(x.content))).toEqual(['dm-1'])
  expect(gr.map(x => body(x.content))).toEqual(['group-1'])
  expect(dm[0]!.pid).not.toBe(gr[0]!.pid) // two separate worker processes
  expect(cliCalls().filter(l => l.startsWith('--bg')).length).toBe(2)
}, 30000)

test('a reaped worker is woken by the next message, continuing the same session', async () => {
  const before = jobFor('dm-111')
  process.kill(before.pid!, 'SIGTERM') // what the daemon's idle reaping does to the process
  await sleep(500)
  const bgBefore = cliCalls().filter(l => l.startsWith('--bg')).length
  say(DM, 111, 'dm-2 after reap')
  await until(() => deliveries().some(x => body(x.content) === 'dm-2 after reap'))
  const resumed = cliCalls().filter(l => l.startsWith('--bg')).slice(bgBefore)
  expect(resumed).toHaveLength(1)
  expect(resumed[0]).toStartWith('--bg --resume ')
  expect(jobFor('dm-111').id).toBe(before.id) // same session id
  const got = deliveries().filter(x => body(x.content) === 'dm-2 after reap')
  expect(got).toHaveLength(1)
  expect(got[0]!.pid).not.toBe(before.pid) // a new worker process got it
}, 30000)

test('a burst while the worker is down wakes it exactly once and every message arrives once, in order', async () => {
  const before = jobFor('group-100777')
  process.kill(before.pid!, 'SIGTERM')
  await sleep(500)
  const bgBefore = cliCalls().filter(l => l.startsWith('--bg')).length
  const burst = ['b1', 'b2', 'b3', 'b4', 'b5']
  for (const t of burst) say(GROUP, 222, t)
  await until(() => burst.every(t => deliveries().some(x => body(x.content) === t)))
  await sleep(1500) // room for any duplicate or late wake to show up
  expect(cliCalls().filter(l => l.startsWith('--bg')).slice(bgBefore)).toHaveLength(1)
  const got = deliveries().filter(x => x.dir.endsWith('/group-100777') && burst.includes(body(x.content)))
  expect(got.map(x => body(x.content))).toEqual(burst)
  // and none of it leaked to the DM worker
  expect(deliveries().filter(x => x.dir.endsWith('/dm-111')).map(x => body(x.content))).toEqual(['dm-1', 'dm-2 after reap'])
}, 40000)
