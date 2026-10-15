// Router-owned tables (plan 03 「資料表」). The messages table stays in
// ./telegram/store.ts, opened on the same db file. The router is the only
// writer; plugins and hooks never open this file.

import { Database } from 'bun:sqlite'

export type ConvType = 'dm' | 'group' | 'channel'

export type Conversation = {
  key: string          // folder name, e.g. dm-137438526
  bot: string
  chat_id: string
  type: ConvType
  folder: string
  role: string
  session_id: string | null
  created_at: string
}

export type QueueRow = { qid: number; conv: string; params: string; status: 'pending' | 'delivered' | 'acked' }

export interface RouterDb {
  logEvent(bot: string, update: unknown): void
  logApiCall(bot: string, method: string, payload: unknown, result: unknown, error: string | null, conv: string | null): void
  getConversation(key: string): Conversation | null
  listConversations(): Conversation[]
  findConversation(bot: string, chat_id: string): Conversation | null
  insertConversation(c: Conversation): void
  setSession(key: string, session_id: string): void
  enqueue(conv: string, params: unknown): number
  markDelivered(qid: number): void
  ack(qid: number): void
  /** pending + delivered-but-unacked, oldest first. */
  undelivered(conv: string): QueueRow[]
  /** Conversations with anything not yet acked. */
  convsWithBacklog(): string[]
  close(): void
}

export function openRouterDb(path: string): RouterDb {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, bot TEXT NOT NULL, update_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbound (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, bot TEXT NOT NULL, conv TEXT, method TEXT NOT NULL,
      payload_json TEXT, result_json TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      key TEXT PRIMARY KEY, bot TEXT NOT NULL, chat_id TEXT NOT NULL,
      type TEXT NOT NULL, folder TEXT NOT NULL, role TEXT NOT NULL,
      session_id TEXT, created_at TEXT NOT NULL,
      UNIQUE (bot, chat_id)
    );
    CREATE TABLE IF NOT EXISTS queue (
      qid INTEGER PRIMARY KEY AUTOINCREMENT,
      conv TEXT NOT NULL, created_at TEXT NOT NULL, params TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', delivered_at TEXT, acked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS queue_conv_status ON queue (conv, status);
  `)
  const now = () => new Date().toISOString()
  const json = (v: unknown) => {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  const qEvent = db.prepare('INSERT INTO events (ts, bot, update_json) VALUES (?, ?, ?)')
  const qApi = db.prepare('INSERT INTO outbound (ts, bot, conv, method, payload_json, result_json, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const qGet = db.prepare('SELECT * FROM conversations WHERE key = ?')
  const qAll = db.prepare('SELECT * FROM conversations ORDER BY key')
  const qFind = db.prepare('SELECT * FROM conversations WHERE bot = ? AND chat_id = ?')
  const qIns = db.prepare('INSERT INTO conversations (key, bot, chat_id, type, folder, role, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const qSess = db.prepare('UPDATE conversations SET session_id = ? WHERE key = ?')
  const qEnq = db.prepare('INSERT INTO queue (conv, created_at, params) VALUES (?, ?, ?)')
  const qDel = db.prepare("UPDATE queue SET status = 'delivered', delivered_at = ? WHERE qid = ? AND status = 'pending'")
  const qAck = db.prepare("UPDATE queue SET status = 'acked', acked_at = ? WHERE qid = ?")
  const qUnd = db.prepare("SELECT qid, conv, params, status FROM queue WHERE conv = ? AND status != 'acked' ORDER BY qid")
  const qBack = db.prepare("SELECT DISTINCT conv FROM queue WHERE status != 'acked'")
  return {
    logEvent: (bot, update) => { qEvent.run(now(), bot, json(update)) },
    logApiCall: (bot, method, payload, result, error, conv) => {
      qApi.run(now(), bot, conv, method, json(payload), result === undefined ? null : json(result), error)
    },
    getConversation: key => (qGet.get(key) as Conversation | null) ?? null,
    listConversations: () => qAll.all() as Conversation[],
    findConversation: (bot, chat_id) => (qFind.get(bot, chat_id) as Conversation | null) ?? null,
    insertConversation: c => { qIns.run(c.key, c.bot, c.chat_id, c.type, c.folder, c.role, c.session_id, c.created_at) },
    setSession: (key, sid) => { qSess.run(sid, key) },
    enqueue: (conv, params) => Number(qEnq.run(conv, now(), json(params)).lastInsertRowid),
    markDelivered: qid => { qDel.run(now(), qid) },
    ack: qid => { qAck.run(now(), qid) },
    undelivered: conv => qUnd.all(conv) as QueueRow[],
    convsWithBacklog: () => (qBack.all() as Array<{ conv: string }>).map(r => r.conv),
    close: () => db.close(),
  }
}
