// The daemon's jobs end to end (docs/operations.md 「背景 session 的 job 與
// daemon」): the real router with a fake claude (agents from a file, every
// call logged) and a fake jobs folder (CLAUDE_CONFIG_DIR), started on a
// router.db of the version before (conversations without worker_flags). At
// startup the jobs of our conversation that are not its current session are
// stopped (when running) and removed, other jobs are left alone; a message
// wakes the conversation whose job was saved with another model: the job is
// removed and the session resumed with the router's flags, which are recorded.
// The real daemon is never touched. Module level: jobs.test.ts.
import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { openRouterDb } from '../db'
import { ensureConversation } from '../conversations'

const dir = mkdtempSync(join(tmpdir(), 'cctr-jobs-e2e-'))
const state = join(dir, '.router')
mkdirSync(state)
const config = join(dir, 'claude-config')
const jobs = join(config, 'jobs')
mkdirSync(jobs, { recursive: true })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const USER = { id: 666, is_bot: false, first_name: 'U', username: 'u' }
const updates: unknown[] = []
const now = Math.floor(Date.now() / 1000)
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    const ok = (result: unknown) => Response.json({ ok: true, result })
    if (method === 'getMe') return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot' })
    if (method === 'getUpdates') { await sleep(100); return ok(updates.splice(0)) }
    if (method === 'sendMessage') return ok({ message_id: 900, date: now, chat: { id: 1 }, text: '' })
    return ok(true)
  },
})
// fake claude: `agents --json --all` prints agents.json; every call is logged
const fakeClaude = join(dir, 'fake-claude')
const callLog = join(dir, 'calls.log')
writeFileSync(join(dir, 'agents.json'), '[]')
writeFileSync(fakeClaude, `#!/bin/bash
echo "$*" >> "${callLog}"
case "$1" in
  agents) cat "${join(dir, 'agents.json')}" ;;
  --bg) echo "backgrounded · aaaa1111 · tg-dm-666 (idle)" ;;
esac
`)
chmodSync(fakeClaude, 0o755)
writeFileSync(join(state, 'config.json'), JSON.stringify({
  bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: ['555'],
  model: 'claude-new', claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}`,
}))
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['555', '666'], groups: {}, pending: {} }))
const cfgLite = { bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state } as any
let folder = ''
// router.db of the version before: a conversation with its session, no worker_flags column
{
  const old = openRouterDb(join(state, 'router.db'))
  old.updateBotSetup('cc', { persona_done: 1, group_skipped: 1, bot_id: '123' })
  const c = ensureConversation(cfgLite, old, 'cc', '666', 'private', () => {})
  folder = c.folder
  old.setSession(c.key, 'sess-1')
  old.close()
  const raw = new Database(join(state, 'router.db'))
  raw.exec('ALTER TABLE conversations DROP COLUMN worker_flags')
  raw.close()
}
const job = (id: string, j: Record<string, unknown>) => { mkdirSync(join(jobs, id), { recursive: true }); writeFileSync(join(jobs, id, 'state.json'), JSON.stringify(j)) }
const settings = join(state, 'sessions', 'dm-666.json')
const oldFlags = ['--allow-dangerously-skip-permissions', '--name', 'tg-dm-666', '--setting-sources', 'project,local', '--settings', settings, '--channels', 'plugin:telegram@claude-plugins-official', '--model', 'claude-old']
job('aaaa1111', { name: 'tg-dm-666', sessionId: 'sess-1', cwd: folder, state: 'done', respawnFlags: oldFlags })
job('old00001', { name: 'tg-dm-666', sessionId: 'sess-0', cwd: folder, state: 'blocked', respawnFlags: oldFlags })
job('old00002', { name: 'tg-dm-666', sessionId: 'sess-00', cwd: folder, state: 'done', respawnFlags: oldFlags })
job('else0001', { name: 'my-work', sessionId: 'sess-x', cwd: '/home/someone/project', state: 'done', respawnFlags: [] })
writeFileSync(join(dir, 'agents.json'), JSON.stringify([
  { id: 'aaaa1111', sessionId: 'sess-1', name: 'tg-dm-666', cwd: folder, kind: 'background', state: 'done' },
  { id: 'old00002', sessionId: 'sess-00', name: 'tg-dm-666', cwd: folder, kind: 'background', pid: 4242, status: 'idle', state: 'done' },
  { id: 'else0001', sessionId: 'sess-x', name: 'my-work', cwd: '/home/someone/project', kind: 'background', pid: 4343, status: 'busy' },
]))

const router = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], {
  env: { ...process.env, CLAUDE_CONFIG_DIR: config }, stdout: 'ignore', stderr: 'pipe',
})
let stderr = ''
void (async () => { for await (const c of router.stderr) stderr += new TextDecoder().decode(c) })()
afterAll(async () => {
  router.kill('SIGTERM')
  await router.exited
  api.stop(true)
  rmSync(dir, { recursive: true, force: true })
})
async function until<T>(fn: () => T | undefined | false, ms = 15000): Promise<T> {
  for (let t = 0; t < ms; t += 50) {
    try { const v = fn(); if (v) return v } catch {}
    await sleep(50)
  }
  throw new Error('timed out')
}
const calls = () => existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(l => !l.startsWith('agents')) : []
const q = (sql: string) => {
  const db = new Database(join(state, 'router.db'), { readonly: true })
  try { return db.query(sql).all() as any[] } finally { db.close() }
}

test('startup on the version before: the column is added; jobs of our conversation that are not its session are stopped and removed, others left alone', async () => {
  await until(() => calls().includes('rm old00002'))
  expect(calls()).toEqual(['rm old00001', 'stop old00002', 'rm old00002'])
  expect(stderr).toContain('job old00001 of dm-666 is not its current session (sess-0), removing it')
  expect(stderr).toContain('job old00002 of dm-666 is not its current session (sess-00, running), removing it')
  expect(q("SELECT session_id, worker_flags FROM conversations WHERE key = 'dm-666'")[0]).toEqual({ session_id: 'sess-1', worker_flags: null })
}, 20000)

test('a wake of a job saved with another model: claude rm, then resume with the router\'s flags, recorded', async () => {
  const before = calls().length
  updates.push({ update_id: 1, message: { message_id: 1, date: now, chat: { id: USER.id, type: 'private' }, from: USER, text: 'hi' } })
  const resume = await until(() => calls().slice(before).find(l => l.startsWith('--bg')))
  const after = calls().slice(before)
  expect(after.indexOf('rm aaaa1111')).toBeGreaterThanOrEqual(0)
  expect(after.indexOf('rm aaaa1111')).toBeLessThan(after.indexOf(resume))
  expect(resume).toStartWith('--bg --resume sess-1 --allow-dangerously-skip-permissions --name tg-dm-666 --model claude-new ')
  expect(resume).toContain(`--settings ${settings} --channels plugin:telegram@claude-plugins-official`)
  expect(stderr).toContain('dm-666: job aaaa1111 was started with other flags (--model claude-old → claude-new); removing it to resume with the new ones')
  const rec = await until(() => q("SELECT worker_flags FROM conversations WHERE key = 'dm-666'")[0].worker_flags)
  expect(JSON.parse(rec)).toContain('claude-new')
  expect(calls().some(l => l.includes('else0001'))).toBe(false)
}, 30000)
