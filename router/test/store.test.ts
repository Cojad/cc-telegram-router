// Purpose-driven tests for store.ts, per plan.html §05: the two things
// this module exists for are (chat_id, message_id) O(1) lookup, and
// recording delivered=false rows so a dropped message isn't a total
// blackout. Each test below maps to one of those, plus the upsert
// behavior the UNIQUE index implies and basic recent()-pagination
// correctness — not an exhaustive SQL spec. Rows belong to a bot (柯姊
// 2026-10-17): two bots' messages with the same chat and message id are
// two rows, each bot sees only its own, and old rows are placed once
// (conversation, events, outbound, else legacy to the original bot).
// Keep in sync with README 「運作方式」 and the store.ts header.

import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { unlinkSync } from 'fs'
import { openStore, type MessageRecord, type Store } from '../telegram/store'

const stores: Store[] = []
function freshStore(): Store {
  const s = openStore(':memory:').forBot('cc')
  stores.push(s)
  return s
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})

function rec(overrides: Partial<MessageRecord>): MessageRecord {
  return {
    chat_id: '-100',
    message_id: '1',
    direction: 'in',
    ts: '2026-09-15T00:00:00.000Z',
    delivered: true,
    // toRecord() always coerces this to a concrete boolean (row.rich_message
    // === 1), never leaves it undefined — matching that here so a
    // round-trip .toEqual() isn't comparing a record shape lookup() can
    // never actually return.
    rich_message: false,
    ...overrides,
  }
}

test('record then lookup by (chat_id, message_id) round-trips every field', () => {
  const store = freshStore()
  store.record(rec({
    message_id: '42', user_id: '137438526', content: 'hello',
    reply_to_message_id: '10', attachment_kind: 'photo', attachment_file_id: 'ABC123',
  }))
  const found = store.lookup('-100', '42')
  expect(found).toEqual(rec({
    message_id: '42', user_id: '137438526', content: 'hello',
    reply_to_message_id: '10', attachment_kind: 'photo', attachment_file_id: 'ABC123',
  }))
})

test('rich_message flag round-trips as true when set', () => {
  const store = freshStore()
  store.record(rec({ message_id: '43', rich_message: true }))
  const found = store.lookup('-100', '43')
  expect(found?.rich_message).toBe(true)
})

test('lookup on an id that was never recorded returns null, not throw', () => {
  const store = freshStore()
  expect(store.lookup('-100', '999')).toBeNull()
})

test('a message gate() dropped is still recorded, with delivered: false', () => {
  const store = freshStore()
  store.record(rec({ message_id: '5', delivered: false, content: 'not mentioned, dropped' }))
  const found = store.lookup('-100', '5')
  expect(found?.delivered).toBe(false)
  expect(found?.content).toBe('not mentioned, dropped')
})

test('recording the same (chat_id, message_id) again replaces the row, not duplicates it', () => {
  const store = freshStore()
  store.record(rec({ message_id: '1', delivered: false }))
  store.record(rec({ message_id: '1', delivered: true, content: 'now delivered' }))
  expect(store.lookup('-100', '1')?.delivered).toBe(true)
  expect(store.recent('-100', 10)).toHaveLength(1)
})

test('the same message_id in two different chats does not collide', () => {
  const store = freshStore()
  store.record(rec({ chat_id: '-100', message_id: '1', content: 'group A' }))
  store.record(rec({ chat_id: '-200', message_id: '1', content: 'group B' }))
  expect(store.lookup('-100', '1')?.content).toBe('group A')
  expect(store.lookup('-200', '1')?.content).toBe('group B')
})

test('recent() returns newest first and respects the limit', () => {
  const store = freshStore()
  for (let i = 1; i <= 5; i++) store.record(rec({ message_id: String(i), content: `msg ${i}` }))
  const top3 = store.recent('-100', 3)
  expect(top3.map(r => r.message_id)).toEqual(['5', '4', '3'])
})

test('recent() with beforeId pages older messages, excluding beforeId itself', () => {
  const store = freshStore()
  for (let i = 1; i <= 5; i++) store.record(rec({ message_id: String(i), content: `msg ${i}` }))
  const page = store.recent('-100', 10, '3')
  expect(page.map(r => r.message_id)).toEqual(['2', '1'])
})

test('an outbound (direction: out) record round-trips the same as inbound', () => {
  const store = freshStore()
  store.record(rec({ direction: 'out', message_id: '7', content: 'sent by the bot' }))
  expect(store.lookup('-100', '7')?.direction).toBe('out')
})

test('opening a pre-removal DB (raw/mtproto columns still present) migrates cleanly', () => {
  // Simulates a production DB from before mtproto.ts was removed
  // (2026-09-16) — raw/mtproto existed as real columns with real data.
  // openStore() must DROP COLUMN both without error and keep working.
  // A real file, not ':memory:' — openStore() needs to reopen the same
  // database a separate Database instance already seeded.
  const path = `/tmp/store-migration-test-${Date.now()}.db`
  const seed = new Database(path, { create: true })
  seed.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL, message_id TEXT NOT NULL, direction TEXT NOT NULL,
      ts TEXT NOT NULL, user_id TEXT, content TEXT, reply_to_message_id TEXT,
      attachment_kind TEXT, attachment_file_id TEXT,
      delivered INTEGER NOT NULL DEFAULT 1, raw TEXT, mtproto INTEGER
    )
  `)
  seed.exec('CREATE UNIQUE INDEX idx_messages_chat_msg ON messages(chat_id, message_id)')
  seed.exec(
    `INSERT INTO messages (chat_id, message_id, direction, ts, delivered, raw, mtproto)
     VALUES ('-100', '99', 'in', '2026-09-15T00:00:00.000Z', 1, '{"className":"MessageMediaUnsupported"}', 1)`,
  )
  seed.close()

  // its row had no bot: with no other evidence it goes to the original bot, marked legacy
  const store = openStore(path, { legacyBot: 'cc' }).forBot('cc')
  stores.push(store)
  const found = store.lookup('-100', '99')
  expect(found).not.toBeNull()
  expect((found as unknown as { raw?: unknown }).raw).toBeUndefined()
  expect((found as unknown as { mtproto?: unknown }).mtproto).toBeUndefined()
  // New writes still work post-migration.
  store.record(rec({ message_id: '100', content: 'post-migration write' }))
  expect(store.lookup('-100', '100')?.content).toBe('post-migration write')

  store.close()
  stores.pop() // already closed above, don't double-close in afterEach
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(path + suffix) } catch {}
  }
})

test('two bots, same chat and message id (a person DMs both; a group both are in): two rows, each bot sees only its own', () => {
  const root = openStore(':memory:')
  const cc = root.forBot('cc'), two = root.forBot('two')
  cc.record(rec({ chat_id: '700100200', message_id: '127', direction: 'out', content: 'cc reply' }))
  expect(two.lookup('700100200', '127')).toBeNull() // not a duplicate for the other bot
  two.record(rec({ chat_id: '700100200', message_id: '127', direction: 'in', content: '實測 5-2' }))
  expect(cc.lookup('700100200', '127')?.content).toBe('cc reply')
  expect(two.lookup('700100200', '127')?.content).toBe('實測 5-2')
  expect(cc.recent('700100200', 10).map(r => r.content)).toEqual(['cc reply'])
  expect(two.recent('700100200', 10).map(r => r.content)).toEqual(['實測 5-2'])
  // a group's ids are shared: the same message seen by both bots
  cc.record(rec({ chat_id: '-100777', message_id: '50', content: 'hi both' }))
  two.record(rec({ chat_id: '-100777', message_id: '50', content: 'hi both' }))
  expect([cc.lookup('-100777', '50')?.content, two.lookup('-100777', '50')?.content]).toEqual(['hi both', 'hi both'])
  expect(two.recent('-100777', 10, '51')).toHaveLength(1)
  root.close()
})

test('old rows get their bot once: by the only bot with a conversation in the chat, else by events (in) or outbound (out), else legacy to the original bot', () => {
  const path = `/tmp/store-bot-backfill-${Date.now()}.db`
  const seed = new Database(path, { create: true })
  seed.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, direction TEXT NOT NULL,
      ts TEXT NOT NULL, user_id TEXT, content TEXT, reply_to_message_id TEXT, attachment_kind TEXT, attachment_file_id TEXT, delivered INTEGER NOT NULL DEFAULT 1, rich_message INTEGER);
    CREATE UNIQUE INDEX idx_messages_chat_msg ON messages(chat_id, message_id);
    CREATE TABLE conversations (key TEXT PRIMARY KEY, bot TEXT NOT NULL, chat_id TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, bot TEXT NOT NULL, update_json TEXT NOT NULL);
    CREATE TABLE outbound (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, bot TEXT NOT NULL, conv TEXT, method TEXT NOT NULL, payload_json TEXT, result_json TEXT, error TEXT);
    INSERT INTO conversations VALUES ('group-100555', 'cc', '-100555'), ('dm-7', 'cc', '7'), ('router-dm-7', 'router', '7');
    INSERT INTO events (ts, bot, update_json) VALUES ('t', 'router', '{"message":{"message_id":3,"chat":{"id":7}}}'),
      ('t', 'cc', '{"message":{"message_id":4,"chat":{"id":7}}}'), ('t', 'router', '{"message":{"message_id":4,"chat":{"id":7}}}');
    INSERT INTO outbound (ts, bot, method, payload_json, result_json) VALUES ('t', 'router', 'sendMessage', '{"chat_id":"7","text":"x"}', '{"ok":true,"result":{"message_id":5}}');
  `)
  const ins = seed.prepare("INSERT INTO messages (chat_id, message_id, direction, ts, content) VALUES (?, ?, ?, 't', ?)")
  ins.run('-100555', '1', 'in', 'group, only cc there')
  ins.run('7', '3', 'in', 'seen by router in events')
  ins.run('7', '4', 'in', 'both bots got a message 4: unclear')
  ins.run('7', '5', 'out', 'router sent it (outbound)')
  ins.run('7', '6', 'in', 'no trace anywhere')
  seed.close()
  const logs: string[] = []
  const root = openStore(path, { legacyBot: 'cc', log: m => logs.push(m) })
  const db = new Database(path, { readonly: true })
  expect(db.query('SELECT message_id, bot, legacy FROM messages ORDER BY id').all()).toEqual([
    { message_id: '1', bot: 'cc', legacy: null },
    { message_id: '3', bot: 'router', legacy: null },
    { message_id: '4', bot: 'cc', legacy: 1 },
    { message_id: '5', bot: 'router', legacy: null },
    { message_id: '6', bot: 'cc', legacy: 1 },
  ])
  expect(db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all().map((r: any) => r.name)).toEqual(['idx_messages_bot_chat_msg'])
  db.close()
  expect(logs).toEqual(['messages: bot filled in for old rows: 1 by conversation, 2 by events/outbound, 2 legacy (cc)'])
  // legacy rows count for the original bot only
  expect(root.forBot('cc').lookup('7', '6')?.content).toBe('no trace anywhere')
  expect(root.forBot('router').lookup('7', '6')).toBeNull()
  expect(root.forBot('router').recent('7', 10).map(r => r.message_id)).toEqual(['5', '3'])
  root.close()
  // done once: reopening changes nothing
  const again: string[] = []
  openStore(path, { legacyBot: 'router', log: m => again.push(m) }).close()
  expect(again).toEqual([])
  for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(path + suffix) } catch {} }
})
