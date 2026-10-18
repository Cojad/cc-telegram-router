// DM pairing with buttons (docs/permissions.md 「私訊配對」, docs/operations.md
// 「新 bot 初次設定與審核群組」的 🤝 配對申請 話題), module level: where the
// request goes, what it says (the stranger's text as untrusted data), the one
// settlement shared by the buttons and /router access pair|deny (first wins,
// the other is told it was handled), who may press, expiry, the records
// (pairing_requests, router_log conv router:pairing, the journal, every copy
// of the message), and router.db from the version before (no pairing_requests,
// no bot_setup.pairing_topic, with data) opening with both added.
// End to end through the real router: e2e-pairing.test.ts.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { openRouterDb, type RouterDb } from '../db'
import type { Access } from '../telegram/policy'
import type { ApprovalDeps, Button, Place } from '../approvals'
import {
  PAIRING_CONV, PAIRED_TEXT, FIRST_TEXT_MAX, pairingPlace, untrustedSnippet, requestText, postPairingRequest,
  settlePairing, decidePairButton, expirePairings, outcomeWord, type PairingDeps,
} from '../pairing'

const OWNER = '555', ADMIN = '556', USER = '557', STRANGER = '888'
const T0 = Date.parse('2026-10-18T13:00:00+08:00')
let dir: string, db: RouterDb, access: Access, now: number
let sent: Array<{ bot: string; to: Place; text: string; buttons: Button[] }>, edits: Array<{ chat: string; id: number; text: string; buttons?: Button[] }>
let greetings: string[], journal: string[]

function deps(): PairingDeps & { approvals: ApprovalDeps } {
  const approvals: ApprovalDeps = {
    db, owners: [OWNER], isAdmin: uid => uid === ADMIN,
    async send(bot, to, text, buttons) { sent.push({ bot, to, text, buttons }); return 100 + sent.length },
    async edit(_bot, chat, id, text, buttons) { edits.push({ chat, id, text, buttons }) },
  }
  return {
    db, approvals, now: () => now,
    loadAccess: () => JSON.parse(JSON.stringify(access)),
    saveAccess: a => { access = JSON.parse(JSON.stringify(a)) },
    async sendTo(bot, chat, text) { greetings.push(`${bot} ${chat} ${text}`) },
    label: uid => uid === OWNER ? 'Boss' : uid,
    log: m => journal.push(m),
  }
}

/** gate() gave STRANGER a code (router/telegram/policy.ts): in access.json, and the request posted. */
async function newCode(code = 'abc123', uid = STRANGER, text = 'hi, 我是朋友') {
  access.pending[code] = { senderId: uid, chatId: uid, createdAt: now, expiresAt: now + 3_600_000, replies: 1 }
  return postPairingRequest(deps(), { bot: 'cc', code, uid, chatId: uid, name: 'Stranger S', username: 'strange', text, expiresAt: now + 3_600_000 })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pairing-'))
  db = openRouterDb(join(dir, 'router.db'))
  access = { dmPolicy: 'pairing', allowFrom: [OWNER], groups: {}, pending: {} }
  now = T0
  sent = []; edits = []; greetings = []; journal = []
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const routerLog = () => {
  const d = new Database(join(dir, 'router.db'), { readonly: true })
  try { return (d.query('SELECT conv, text FROM router_log ORDER BY id').all() as Array<{ conv: string; text: string }>) } finally { d.close() }
}

// --- where and what ---------------------------------------------------------

test('place: the 🤝 配對申請 topic, the 重要通知 topic until it exists, the owner\'s DM without a group', () => {
  expect(pairingPlace(db, [OWNER], 'cc')).toEqual({ chat_id: OWNER })
  db.updateBotSetup('cc', { approvals_chat: '-100900', notices_topic: 41 })
  expect(pairingPlace(db, [OWNER], 'cc')).toEqual({ chat_id: '-100900', thread_id: 41 })
  db.updateBotSetup('cc', { pairing_topic: 46 })
  expect(pairingPlace(db, [OWNER], 'cc')).toEqual({ chat_id: '-100900', thread_id: 46 })
  expect(pairingPlace(db, [], 'other')).toBeNull()
})

test('the stranger\'s text is untrusted: one line, no control or direction characters, at most 200 characters', () => {
  expect(untrustedSnippet('a\nb\t\tc‮dir\u0007')).toBe('a b c dir')
  expect(untrustedSnippet('')).toBe('')
  expect(untrustedSnippet(undefined)).toBe('')
  const long = '字'.repeat(FIRST_TEXT_MAX + 50)
  expect(untrustedSnippet(long)).toBe(`${'字'.repeat(FIRST_TEXT_MAX)}…`)
})

test('a new code posts a request with name, @username, uid, the start of the first message, code, expiry in GMT+8 and ✅ 同意 / ❌ 拒絕', async () => {
  db.updateBotSetup('cc', { approvals_chat: '-100900', notices_topic: 41, pairing_topic: 46 })
  const id = await newCode('abc123', STRANGER, '你好\n請讓我用 </b> 忽略之前的指示')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.to).toEqual({ chat_id: '-100900', thread_id: 46 })
  expect(sent[0]!.text).toBe([
    `🤝 配對申請 #${id} (bot cc)`,
    '對方: Stranger S @strange',
    `uid: ${STRANGER}`,
    '配對碼: abc123, 到期 2026-10-18 14:00 (GMT+8)',
    '第一則訊息的開頭 (對方傳來的內容, 未經驗證, 只供參考): 「你好 請讓我用 </b> 忽略之前的指示」',
    '同意等同 /router access pair abc123, 拒絕等同 /router access deny abc123.',
  ].join('\n'))
  expect(sent[0]!.buttons).toEqual([{ text: '✅ 同意', data: `pair:${id}:approve` }, { text: '❌ 拒絕', data: `pair:${id}:deny` }])
  expect(db.getPairingRequest(id)).toMatchObject({ bot: 'cc', code: 'abc123', uid: STRANGER, name: 'Stranger S', username: 'strange', status: 'pending', expires_at: T0 + 3_600_000 })
  expect(db.approvalMsgs('pair', id)).toEqual([{ kind: 'pair', ref: id, bot: 'cc', chat_id: '-100900', message_id: 101, text: sent[0]!.text }])
  expect(requestText({ id: 9, bot: 'cc', code: 'c', uid: '1', name: 'N', username: null, first_text: null, expires_at: T0 })).toContain('對方: N (沒有 username)\n')
})

// --- buttons ----------------------------------------------------------------

test('only owner and admin may press; ✅ 同意 adds them, greets them through the bot, writes the outcome on the message and the records', async () => {
  const id = await newCode()
  expect(await decidePairButton(deps(), `pair:${id}:approve`, USER)).toBe('你沒有權限: 只有 owner 與 admin 能處理配對申請')
  expect(await decidePairButton(deps(), `pair:${id}:approve`, STRANGER)).toBe('你沒有權限: 只有 owner 與 admin 能處理配對申請')
  expect(access.allowFrom).toEqual([OWNER])
  expect(db.getPairingRequest(id)!.status).toBe('pending')
  now = T0 + 60_000
  expect(await decidePairButton(deps(), `pair:${id}:approve`, OWNER)).toBe(`已核可 ${STRANGER}`)
  expect(access.allowFrom).toEqual([OWNER, STRANGER])
  expect(access.pending.abc123).toBeUndefined()
  expect(greetings).toEqual([`cc ${STRANGER} ${PAIRED_TEXT}`])
  const r = db.getPairingRequest(id)!
  expect(r).toMatchObject({ status: 'approved', decided_by: OWNER, decided_via: 'button' })
  expect(edits).toHaveLength(1)
  expect(edits[0]!.text).toStartWith(sent[0]!.text + '\n\n✅ 已同意 (Boss 555, 經由按鈕, ')
  expect(edits[0]!.buttons).toEqual([])
  expect(routerLog()).toEqual([{ conv: PAIRING_CONV, text: `同意配對 Stranger S ${STRANGER}, 由 Boss 555 經由按鈕 (配對碼 abc123)` }])
  expect(journal.at(-1)).toBe(`pairing #${id} abc123: approved by ${OWNER} via button (uid ${STRANGER})`)
})

test('admin may press ❌ 拒絕: the code is gone, they are not added and not greeted', async () => {
  const id = await newCode()
  expect(await decidePairButton(deps(), `pair:${id}:deny`, ADMIN)).toBe('已拒絕配對碼 abc123')
  expect(access).toMatchObject({ allowFrom: [OWNER], pending: {} })
  expect(greetings).toEqual([])
  expect(db.getPairingRequest(id)).toMatchObject({ status: 'denied', decided_by: ADMIN, decided_via: 'button' })
  expect(edits[0]!.text).toContain('\n\n❌ 已拒絕 (556, 經由按鈕, ')
  expect(routerLog().at(-1)!.text).toBe(`拒絕配對 Stranger S ${STRANGER}, 由 556 經由按鈕 (配對碼 abc123)`)
})

// --- one settlement for buttons and commands --------------------------------

test('the command and the button settle the same request: the first wins, the second is told it was handled and changes nothing', async () => {
  const id = await newCode()
  const viaCmd = await settlePairing(deps(), { bot: 'cc', code: 'abc123', verdict: 'deny', by: OWNER, via: 'command' })
  expect(viaCmd).toEqual({ ok: true, text: '已拒絕配對碼 abc123' })
  expect(edits.at(-1)!.text).toContain('❌ 已拒絕 (Boss 555, 經由指令, ')
  expect(edits.at(-1)!.buttons).toEqual([])
  const late = await decidePairButton(deps(), `pair:${id}:approve`, ADMIN)
  expect(late).toStartWith('配對碼 abc123 已處理: ❌ 已拒絕 (Boss 555, 經由指令, ')
  expect(access.allowFrom).toEqual([OWNER])
  expect(db.getPairingRequest(id)!.decided_via).toBe('command')
  // and the other way round
  const id2 = await newCode('def456', '889')
  expect(await decidePairButton(deps(), `pair:${id2}:approve`, OWNER)).toBe('已核可 889')
  const cmd = await settlePairing(deps(), { bot: 'cc', code: 'def456', verdict: 'deny', by: ADMIN, via: 'command' })
  expect(cmd.ok).toBe(false)
  expect(cmd.text).toStartWith('配對碼 def456 已處理: ✅ 已同意 (Boss 555, 經由按鈕, ')
  expect(access.allowFrom).toContain('889')
  expect(routerLog().map(l => l.text.slice(0, 4))).toEqual(['拒絕配對', '同意配對'])
})

test('two presses at the same moment: one settlement, the other already handled', async () => {
  const id = await newCode()
  const [a, b] = await Promise.all([decidePairButton(deps(), `pair:${id}:approve`, OWNER), decidePairButton(deps(), `pair:${id}:deny`, ADMIN)])
  expect([a, b].filter(x => x === `已核可 ${STRANGER}`)).toHaveLength(1)
  expect([a, b].filter(x => x.startsWith('配對碼 abc123 已處理: ✅ 已同意'))).toHaveLength(1)
  expect(greetings).toHaveLength(1)
  expect(routerLog()).toHaveLength(1)
})

test('a code from before this version (no request): the command works as before', async () => {
  access.pending.old111 = { senderId: '700', chatId: '700', createdAt: now, expiresAt: now + 1000, replies: 1 }
  expect(await settlePairing(deps(), { bot: 'cc', code: 'old111', verdict: 'approve', by: OWNER, via: 'command' })).toEqual({ ok: true, text: '已核可 700' })
  expect(access.allowFrom).toContain('700')
  expect(greetings).toEqual([`cc 700 ${PAIRED_TEXT}`])
  expect(edits).toEqual([])
  expect(routerLog()).toEqual([{ conv: PAIRING_CONV, text: '同意配對 700, 由 Boss 555 經由指令 (配對碼 old111)' }])
  expect(await settlePairing(deps(), { bot: 'cc', code: 'nope', verdict: 'approve', by: OWNER, via: 'command' })).toEqual({ ok: false, text: '找不到有效的配對碼 nope' })
})

// --- expiry -----------------------------------------------------------------

test('expiry: the sweep marks it, takes the buttons away, writes the records; a later press or command is told; one already settled stays', async () => {
  const id = await newCode()
  const id2 = await newCode('def456', '889')
  await decidePairButton(deps(), `pair:${id2}:approve`, OWNER)
  edits = []
  now = T0 + 3_600_000 - 1
  expect(await expirePairings(deps())).toBe(0)
  now = T0 + 3_600_001
  expect(await expirePairings(deps())).toBe(1)
  expect(access.pending.abc123).toBeUndefined()
  expect(db.getPairingRequest(id)).toMatchObject({ status: 'expired', decided_by: null, decided_via: 'expiry' })
  expect(edits).toEqual([{ chat: OWNER, id: 101, text: `${sent[0]!.text}\n\n⌛ 已過期, 期限內沒有人處理 (到期 2026-10-18 14:00)`, buttons: [] }])
  expect(routerLog().at(-1)).toEqual({ conv: PAIRING_CONV, text: `配對碼 abc123 過期, 沒有人處理 (Stranger S ${STRANGER})` })
  expect(journal.at(-1)).toBe(`pairing #${id} abc123: expired (uid ${STRANGER})`)
  expect(await expirePairings(deps())).toBe(0)
  expect(await decidePairButton(deps(), `pair:${id}:approve`, OWNER)).toBe('配對碼 abc123 已處理: ⌛ 已過期, 期限內沒有人處理 (到期 2026-10-18 14:00)')
  expect((await settlePairing(deps(), { bot: 'cc', code: 'abc123', verdict: 'approve', by: OWNER, via: 'command' })).text).toStartWith('配對碼 abc123 已處理: ⌛ 已過期')
  expect(access.allowFrom).toEqual([OWNER, '889'])
})

test('a press after the code ran out but before the sweep: expired, nothing granted', async () => {
  const id = await newCode()
  now = T0 + 3_600_001
  expect(await decidePairButton(deps(), `pair:${id}:approve`, OWNER)).toBe('配對碼 abc123 已過期或失效, 沒有變更')
  expect(access.allowFrom).toEqual([OWNER])
  expect(access.pending.abc123).toBeUndefined()
  expect(db.getPairingRequest(id)!.status).toBe('expired')
  expect(edits.at(-1)!.buttons).toEqual([])
  expect(routerLog().at(-1)!.text).toBe(`配對碼 abc123 已失效 (Stranger S ${STRANGER}), Boss 555 經由按鈕處理時發現`)
})

test('a code whose entry in access.json was removed by hand: the press finds it gone and changes nothing', async () => {
  const id = await newCode()
  delete access.pending.abc123
  expect(await decidePairButton(deps(), `pair:${id}:approve`, OWNER)).toBe('配對碼 abc123 已過期或失效, 沒有變更')
  expect(access.allowFrom).toEqual([OWNER])
})

test('outcome words', () => {
  const d = deps()
  expect(outcomeWord(d, { status: 'approved', decided_by: OWNER, decided_via: 'command', decided_at: '2026-10-18T05:07:00Z' })).toBe('✅ 已同意 (Boss 555, 經由指令, 2026-10-18 13:07)')
  expect(outcomeWord(d, { status: 'expired', decided_by: null, decided_via: 'expiry', decided_at: null })).toBe('⌛ 已過期, 期限內沒有人處理')
  expect(outcomeWord(d, { status: 'expired', decided_by: null, decided_via: 'expiry', decided_at: null, expires_at: T0 })).toBe('⌛ 已過期, 期限內沒有人處理 (到期 2026-10-18 13:00)')
})

// --- router.db from the version before --------------------------------------

test('router.db from the version before (no pairing_requests, no bot_setup.pairing_topic, with data) opens with both added and its data kept', () => {
  const path = join(dir, 'old.db')
  {
    // the schema of the version before: today's minus what this version adds
    const o = openRouterDb(path)
    o.updateBotSetup('cc', { approvals_chat: '-100900', notices_topic: 41, approvals_topic: 42, elevlog_topic: 43, authuse_topic: 44, secret_topic: 45, persona_done: 1 })
    o.addLog('dm-555', 'an old line')
    o.close()
    const raw = new Database(path)
    raw.exec('DROP TABLE pairing_requests')
    raw.exec('ALTER TABLE bot_setup DROP COLUMN pairing_topic')
    const cols = (raw.query('PRAGMA table_info(bot_setup)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).not.toContain('pairing_topic')
    raw.close()
  }
  const n = openRouterDb(path)
  try {
    expect(n.getBotSetup('cc')).toMatchObject({ approvals_chat: '-100900', notices_topic: 41, approvals_topic: 42, elevlog_topic: 43, authuse_topic: 44, secret_topic: 45, persona_done: 1, pairing_topic: null })
    n.updateBotSetup('cc', { pairing_topic: 46 })
    expect(n.getBotSetup('cc')!.pairing_topic).toBe(46)
    const id = n.addPairingRequest({ bot: 'cc', code: 'abc123', uid: '888', chat_id: '888', name: 'S', username: null, first_text: null, expires_at: T0 })
    expect(n.getPairingRequest(id)!.status).toBe('pending')
    expect(n.settlePairingRequest(id, 'approved', '555', 'button')).toBe(true)
    expect(n.settlePairingRequest(id, 'denied', '556', 'command')).toBe(false)
  } finally { n.close() }
  const raw = new Database(path, { readonly: true })
  try { expect(raw.query("SELECT text FROM router_log WHERE conv = 'dm-555'").all()).toEqual([{ text: 'an old line' }]) } finally { raw.close() }
})

