// An owner reaches the bot in a DM without a pairing code, however they
// became owner (docs/operations.md 「私訊與群組的存取」, README 「私訊與群組的存取」):
// the DM gate reads only access.json's allowFrom, so every new owner is put
// there. allowOwners adds only those missing and changes nothing else;
// /router config set owners and /router role <uid> owner add them (and say
// so), another role does not, removing an owner takes no one out. At
// router start and through the setup wizard: e2e-wizard.test.ts and
// wizard.test.ts; the claim code (/start <碼>) in e2e-setup.test.ts.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { runCommand, type CommandDeps, type CommandInput } from '../commands'
import { allowOwners, gate, type Access } from '../telegram/policy'

const OWNER = '137438526', ADMIN = '500', NEW = '700100200', OTHER = '700100300'
let dir: string, cfg: Config, db: RouterDb, access: Access

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-owners-'))
  mkdirSync(join(dir, '.router'))
  cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, '.router', 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude' } as Config
  db = openRouterDb(join(dir, '.router', 'router.db'), { owners: cfg.owners })
  db.setUserRole(ADMIN, 'admin')
  access = { dmPolicy: 'pairing', allowFrom: [OWNER, ADMIN], groups: {}, pending: {} }
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

function deps(): CommandDeps {
  return {
    cfg, db,
    loadAccess: () => structuredClone(access),
    saveAccess: (a: Access) => { access = structuredClone(a) },
    bots: { async list() { return [] }, async add() { return '' }, async rotate() { return '' }, async remove() {} },
    sessions: { isConnected: () => false, async restart() {}, async stop() {}, rotateNow() {} },
    async applySettings() {}, applyPermissions() {},
    async sendTo() {}, recentMessages: () => [], writeConfig: () => {}, restartRouter: () => {}, startedAt: new Date(),
  } as unknown as CommandDeps
}
const run = (text: string, senderId: string) => runCommand({ bot: 'cc', text, senderId, senderName: `u${senderId}`, chatId: senderId, chatType: 'private' } as CommandInput, deps())

/** What the DM gate does with a private message from uid. */
const dmGate = (uid: string) => gate({ from: { id: Number(uid) }, chat: { id: Number(uid), type: 'private' } } as never, access, 'cc_bot', () => {}, () => 'abcdef').action

test('allowOwners: only the missing ones, in order, nothing else changes; a missing or odd allowFrom becomes a list', () => {
  const a: Record<string, unknown> = { dmPolicy: 'allowlist', allowFrom: ['1', '2'], groups: { g: 1 }, extra: true }
  expect(allowOwners(a, ['2', '3', '3', '4'])).toEqual(['3', '4'])
  expect(a).toEqual({ dmPolicy: 'allowlist', allowFrom: ['1', '2', '3', '4'], groups: { g: 1 }, extra: true })
  expect(allowOwners(a, ['1'])).toEqual([])
  const b: Record<string, unknown> = {}
  expect(allowOwners(b, ['9'])).toEqual(['9'])
  expect(b.allowFrom).toEqual(['9'])
})

test('/router config set owners: a new owner goes into allowFrom and gets no pairing code; removing one takes no one out', async () => {
  expect(dmGate(NEW)).toBe('pair')
  access.pending = {}
  const out = (await run(`/router config set owners ${OWNER},${NEW}`, OWNER))!.reply
  expect(out).toContain(`${NEW} 加入 access.json 的 allowFrom, 私訊不用配對`)
  expect(access.allowFrom).toEqual([OWNER, ADMIN, NEW])
  expect(dmGate(NEW)).toBe('deliver')
  const again = (await run(`/router config set owners ${OWNER}`, OWNER))!.reply
  expect(again).not.toContain('加入 access.json')
  expect(access.allowFrom).toEqual([OWNER, ADMIN, NEW])
})

test('/router role <uid> owner: into allowFrom; another role does not', async () => {
  const admin = (await run(`/router role ${OTHER} admin`, OWNER))!.reply
  expect(admin).not.toContain('allowFrom')
  expect(access.allowFrom).toEqual([OWNER, ADMIN])
  const owner = (await run(`/router role ${NEW} owner`, OWNER))!.reply
  expect(owner).toContain(`${NEW} 加入 access.json 的 allowFrom, 私訊不用配對`)
  expect(access.allowFrom).toEqual([OWNER, ADMIN, NEW])
})
