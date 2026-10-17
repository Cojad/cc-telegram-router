// Tool call history (docs/operations.md 「工具呼叫紀錄」, docs/permissions.md
// 「工具呼叫紀錄」; router/toolhistory.ts). Keep in sync with those sections and
// docs/testing.md 驗收對照. End to end through the real router: e2e-toolhistory.test.ts.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import type { Config } from '../config'
import { openRouterDb, type RouterDb } from '../db'
import { createToolHistory, hookUse, maskShort, toolReport, KEEP_DAYS } from '../toolhistory'
import { runCommand, type CommandDeps } from '../commands'

const OWNER = '137438526', ADMIN = '500', POWER = '600'
let dir: string, db: RouterDb, logs: string[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-th-'))
  mkdirSync(join(dir, '.router'))
  db = openRouterDb(join(dir, '.router', 'router.db'))
  logs = []
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
const rows = () => {
  const d = new Database(join(dir, '.router', 'router.db'), { readonly: true })
  try { return d.query('SELECT conv, conv_role, eff_role, tool, decision, reason, target, subagent FROM tool_history ORDER BY id').all() as any[] } finally { d.close() }
}
const conv = (key: string, role: string) => ({ key, role })

test('hookUse: the tool, the decision, a reason only for deny or an explicit allow, a recipient only for SendMessage, subagent from agent_id; no arguments', () => {
  expect(hookUse(conv('group-1', 'user'), { tool_name: 'Bash', tool_input: { command: 'cat secret.txt' } }, {}, null))
    .toEqual({ conv: 'group-1', conv_role: 'user', eff_role: null, tool: 'Bash', decision: 'allow', reason: null, target: null, subagent: false })
  expect(hookUse(conv('group-1', 'user'), { tool_name: 'ListAgents', tool_input: {}, agent_id: 'a1' }, { decision: 'deny', reason: '權限不足' }, null))
    .toMatchObject({ decision: 'deny', reason: '權限不足', subagent: true })
  expect(hookUse(conv('group-1', 'user'), { tool_name: 'SendMessage', tool_input: { to: 'worker [3fa9c1]', message: '秘密內容' } }, {}, null).target).toBe('worker [3fa9c1]')
  expect(hookUse(conv('group-1', 'user'), { tool_name: 'Bash', tool_input: { command: 'ls /x' }, agent_id: 'A' }, { decision: 'allow', reason: '提權 #1, 以 owner 角色執行' }, 'owner'))
    .toMatchObject({ eff_role: 'owner', decision: 'allow', reason: '提權 #1, 以 owner 角色執行', subagent: true })
})

test('record: writes one row per call, reasons and recipients masked and cut short; arguments never stored', () => {
  const h = createToolHistory({ db, log: m => logs.push(m) })
  const key = 'sk-ant-' + 'a'.repeat(40)
  h.record(hookUse(conv('dm-1', 'owner'), { tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }, {}, null))
  h.record(hookUse(conv('group-1', 'user'), { tool_name: 'Bash', tool_input: { command: `curl -H "x-api-key: ${key}" x` } }, { decision: 'deny', reason: `user 的 Bash 只能跑唯讀指令, 這個不在允許範圍: curl -H "x-api-key: ${key}" ${'x'.repeat(300)}` }, null))
  h.record(hookUse(conv('group-1', 'user'), { tool_name: 'SendMessage', tool_input: { to: `${key} [3fa9c1]`, message: 'hi' } }, { decision: 'deny', reason: 'power 以下的角色不能傳訊給其他 session' }, null))
  const r = rows()
  expect(r).toHaveLength(3)
  expect(r[0]).toEqual({ conv: 'dm-1', conv_role: 'owner', eff_role: null, tool: 'Read', decision: 'allow', reason: null, target: null, subagent: 0 })
  expect(r[1].reason).toContain('<已遮蔽>')
  expect(r[1].reason).not.toContain(key)
  expect(r[1].reason.length).toBeLessThanOrEqual(160)
  expect(r[2].target).toBe('<已遮蔽> [3fa9c1]')
  expect(JSON.stringify(r)).not.toContain('/etc/hosts')
  expect(JSON.stringify(r)).not.toContain('"hi"')
  expect(logs).toEqual([])
})

test('record: a failing write is only logged, never thrown (the hook answer does not depend on it)', () => {
  const broken = { ...db, addToolUse: () => { throw new Error('disk full (simulated)') } } as RouterDb
  const h = createToolHistory({ db: broken, log: m => logs.push(m) })
  expect(() => h.record(hookUse(conv('dm-1', 'owner'), { tool_name: 'Read' }, {}, null))).not.toThrow()
  expect(logs).toEqual(['tool_history: Error: disk full (simulated)'])
})

test('maskShort: known secret formats replaced, whitespace folded, cut with …', () => {
  expect(maskShort('token 123456789:' + 'A'.repeat(35) + ' end', 200)).toBe('token <已遮蔽> end')
  expect(maskShort('a\n  b', 10)).toBe('a b')
  expect(maskShort('x'.repeat(20), 10)).toBe('x'.repeat(9) + '…')
})

test(`purge: rows older than ${KEEP_DAYS} days go, newer stay`, () => {
  const t = Date.parse('2026-10-17T04:00:00Z')
  const h = createToolHistory({ db, log: m => logs.push(m), now: () => t })
  const add = (daysAgo: number) => db.addToolUse({ ts: new Date(t - daysAgo * 86_400_000).toISOString(), conv: 'c', conv_role: 'user', eff_role: null, tool: 'Read', decision: 'allow', reason: null, target: null, subagent: false })
  add(31); add(30.5); add(29); add(1)
  expect(h.purge()).toBe(2)
  expect(rows()).toHaveLength(2)
  expect(h.purge()).toBe(0)
})

/** Example data for the report (docs/operations.md shows this output). */
function seed(at: number) {
  const add = (conv_role: string, tool: string, decision: 'allow' | 'deny' | 'error', n: number, eff_role: string | null = null, daysAgo = 1) => {
    for (let i = 0; i < n; i++) db.addToolUse({ ts: new Date(at - daysAgo * 86_400_000).toISOString(), conv: `c-${conv_role}`, conv_role, eff_role, tool, decision, reason: null, target: null, subagent: !!eff_role })
  }
  add('owner', 'Bash', 'allow', 40); add('power', 'Bash', 'allow', 12); add('user', 'Bash', 'deny', 3); add('user', 'Bash', 'allow', 1, 'owner')
  add('user', 'Read', 'allow', 20); add('guest', 'Read', 'deny', 1)
  add('user', 'mcp__plugin_telegram_telegram__reply', 'allow', 15); add('owner', 'mcp__plugin_telegram_telegram__reply', 'allow', 9); add('user', 'mcp__plugin_telegram_telegram__reply', 'error', 1)
  add('user', 'SendMessage', 'deny', 2); add('power', 'ListAgents', 'deny', 1)
  add('owner', 'Glob', 'allow', 5, null, 10) // outside 7 days
}

test('toolReport: per tool, most used first, counts by conversation role, elevated, blocked, errors; the window in GMT+8', () => {
  const at = Date.parse('2026-10-17T04:00:00Z') // 12:00 GMT+8
  seed(at)
  const out = toolReport(db, 7, at)
  expect(out.split('\n')).toEqual([
    '工具呼叫統計: 近 7 天 (2026-10-10 12:00 起, GMT+8)',
    'Bash 56 次: owner 40, power 12, user 4; 提權 1, 被擋 3',
    'mcp__plugin_telegram_telegram__reply 25 次: owner 9, user 16; 錯誤 1',
    'Read 21 次: user 20, guest 1; 被擋 1',
    'SendMessage 2 次: user 2; 被擋 2',
    'ListAgents 1 次: power 1; 被擋 1',
    '合計 105 次: owner 49, power 13, user 42, guest 1; 提權 1, 被擋 7, 錯誤 1',
    '角色是對話角色; 提權: 已提權的 subagent 以較高角色執行; 被擋: router 擋下 (原因見提權紀錄); 錯誤: router 端執行的 Telegram 工具被拒或 API 失敗',
  ])
  expect(toolReport(db, 30, at)).toContain('Glob 5 次: owner 5')
  expect(toolReport(db, 1, at + 3 * 86_400_000)).toEndWith('(沒有紀錄)')
})

// --- /router tools ------------------------------------------------------------

function cmdDeps(): CommandDeps {
  const cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, 's'), owners: [OWNER], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude' } as Config
  db.setUserRole(ADMIN, 'admin'); db.setUserRole(POWER, 'power')
  return { cfg, db } as unknown as CommandDeps
}
const run = (deps: CommandDeps, senderId: string, text: string, extra: object = {}) =>
  runCommand({ bot: 'cc', text, senderId, senderName: 'n', chatId: senderId, chatType: 'private', ...extra }, deps)

test('/router tools [天數]: owner and admin (and the terminal CLI, as owner); default 7 days, 1~30; power is refused; private in a group', async () => {
  const deps = cmdDeps()
  seed(Date.now())
  const o = await run(deps, OWNER, '/router tools')
  expect(o!.reply).toStartWith('工具呼叫統計: 近 7 天')
  expect(o!.reply).toContain('Bash 56 次')
  expect(o!.private).toBe(true)
  expect((await run(deps, ADMIN, '/router tools 30'))!.reply).toContain('Glob 5 次')
  expect((await run(deps, OWNER, '/router tools', { terminal: true }))!.reply).toContain('合計 105 次')
  expect((await run(deps, POWER, '/router tools'))!.reply).toBe('⛔ /router 只開放 owner 與 admin, 你的角色是 power')
  for (const bad of ['/router tools 0', '/router tools 31', '/router tools x', '/router tools 7 9'])
    expect([bad, (await run(deps, OWNER, bad))!.reply]).toEqual([bad, '用法: /router tools [天數 1~30]'])
  expect((await run(deps, OWNER, '/router help'))!.reply).toContain('/router tools [天數 1~30]')
})
