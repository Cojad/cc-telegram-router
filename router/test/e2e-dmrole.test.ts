// The startup migration through the real router (docs/permissions.md 「角色」
// 私訊; unit level: dmrole.test.ts): DMs stored with a role of their own (from
// before a DM followed its user's role) are aligned at start, logged, their
// settings and chat context written with the user's role. Groups keep theirs.
// Keep in sync with that section and docs/testing.md 驗收對照.

import { test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import type { Config } from '../config'
import { openRouterDb } from '../db'
import { ensureConversation } from '../conversations'

const dir = mkdtempSync(join(tmpdir(), 'cctr-dmrole-e2e-'))
const state = join(dir, '.router')
mkdirSync(state)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const OWNER = '137438526', MEMBER = '700100200', GROUP = '-1009990000001'

const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    const ok = (result: unknown) => Response.json({ ok: true, result })
    if (method === 'getMe') return ok({ id: 1, is_bot: true, first_name: 'cc', username: 'cc_bot' })
    if (method === 'getUpdates') { await sleep(200); return ok([]) }
    return ok(true)
  },
})
const fakeClaude = join(dir, 'fake-claude')
writeFileSync(fakeClaude, `#!/bin/bash\ncase "$*" in *agents*) echo '[]' ;; esac\n`)
chmodSync(fakeClaude, 0o755)
const config = { bots: [{ name: 'cc', token: '123:test' }], home: dir, stateDir: state, owners: [OWNER], model: 'claude-opus-5-5', claudeBin: fakeClaude, apiRoot: `http://127.0.0.1:${api.port}` }
writeFileSync(join(state, 'config.json'), JSON.stringify(config))
writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [OWNER, MEMBER], groups: {}, pending: {} }))

// router.db as an older router left it: the owner's DM set down to user, a
// member's DM set to power while the member's own role is guest
{
  const cfg = { ...config, path: join(state, 'config.json'), socket: join(state, 'router.sock'), autoCompactWindow: 750000 } as Config
  const pre = openRouterDb(join(state, 'router.db'), { owners: cfg.owners })
  pre.setUserRole(MEMBER, 'guest')
  for (const [chat, type] of [[OWNER, 'private'], [MEMBER, 'private'], [GROUP, 'supergroup']] as const) ensureConversation(cfg, pre, 'cc', chat, type, () => {})
  pre.close()
  const raw = new Database(join(state, 'router.db'))
  raw.run("UPDATE conversations SET role = 'user' WHERE key = ?", [`dm-${OWNER}`])
  raw.run("UPDATE conversations SET role = 'power' WHERE key = ?", [`dm-${MEMBER}`])
  raw.run("UPDATE conversations SET role = 'power' WHERE key = ?", [`group-${GROUP.slice(1)}`])
  raw.close()
}
const router = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(state, 'config.json')], { stdout: 'ignore', stderr: 'pipe' })
let stderr = ''
void (async () => { for await (const c of router.stderr) stderr += new TextDecoder().decode(c) })()

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
  throw new Error(`timed out; router stderr:\n${stderr}`)
}

test('at start a DM\'s stored role is aligned to its user\'s role, logged; its settings and chat context carry the user\'s role; a group keeps its own', async () => {
  await until(() => stderr.includes(`dm role dm-${MEMBER}`))
  expect(stderr).toContain(`dm role dm-${OWNER}: user -> owner (the user's role)`)
  expect(stderr).toContain(`dm role dm-${MEMBER}: power -> guest (the user's role)`)
  const ro = new Database(join(state, 'router.db'), { readonly: true })
  expect(ro.query('SELECT key, role, ctx_v FROM conversations ORDER BY key').all()).toEqual([
    { key: `dm-${OWNER}`, role: 'owner', ctx_v: 2 },
    { key: `dm-${MEMBER}`, role: 'guest', ctx_v: 2 },
    { key: `group-${GROUP.slice(1)}`, role: 'power', ctx_v: 1 },
  ])
  ro.close()
  const settings = (k: string) => JSON.parse(readFileSync(join(state, 'sessions', `${k}.json`), 'utf8'))
  await until(() => settings(`dm-${OWNER}`).permissions.defaultMode === 'bypassPermissions')
  expect(settings(`dm-${MEMBER}`).permissions.allow).not.toContain('Bash') // guest's template, not power's: no shell
  const ctx = (k: string) => JSON.parse(readFileSync(join(dir, 'bot123', k, '.chat', 'context.json'), 'utf8'))
  expect([ctx(`dm-${OWNER}`).role, ctx(`dm-${MEMBER}`).role, ctx(`group-${GROUP.slice(1)}`).role]).toEqual(['owner', 'guest', 'power'])
})
