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
  /** Telegram chat title (groups) or the other party's name (DMs). */
  title?: string | null
  /** Per-conversation autoCompactWindow; null = config default. */
  compact?: number | null
  /** Per-conversation model; null = config default. */
  model?: string | null
  /** chat_context version, bumped on every change (plan 06). */
  ctx_v?: number
}

export type QueueRow = { qid: number; conv: string; params: string; status: 'pending' | 'delivered' | 'acked' }
export type LogRow = { id: number; conv: string; ts: string; text: string; qid: number | null }

export interface RouterDb {
  logEvent(bot: string, update: unknown): void
  logApiCall(bot: string, method: string, payload: unknown, result: unknown, error: string | null, conv: string | null): void
  recentOutbound(conv: string, limit: number): Array<{ ts: string; method: string; payload_json: string; error: string | null }>
  getConversation(key: string): Conversation | null
  listConversations(): Conversation[]
  findConversation(bot: string, chat_id: string): Conversation | null
  insertConversation(c: Conversation): void
  setSession(key: string, session_id: string | null): void
  /** Update some conversation fields; bumps ctx_v. Returns the new row. */
  updateConversation(key: string, fields: Partial<Pick<Conversation, 'role' | 'title' | 'compact' | 'model'>>): Conversation
  enqueue(conv: string, params: unknown): number
  markDelivered(qid: number): void
  ack(qid: number): void
  /** pending + delivered-but-unacked, oldest first. */
  undelivered(conv: string): QueueRow[]
  /** Conversations with anything not yet acked. */
  convsWithBacklog(): string[]
  getUserRole(uid: string): string | null
  setUserRole(uid: string, role: string | null): void
  listUsers(): Array<{ uid: string; role: string }>
  /** /router activity to show the conversation's worker with its next message (plan 03). */
  addLog(conv: string, text: string): void
  /** Logs to attach to queue item qid: ones already bound to it, plus any not yet bound. */
  bindLogs(conv: string, qid: number): LogRow[]
  /** Live progress messages, so ones orphaned by a router restart get cleaned up. */
  trackProgress(key: string, chat_id: string, message_id: number): void
  untrackProgress(key: string, message_id: number): void
  orphanProgress(): Array<{ key: string; chat_id: string; message_id: number }>
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
    CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, role TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS router_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv TEXT NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL, qid INTEGER
    );
    CREATE INDEX IF NOT EXISTS router_log_conv ON router_log (conv, qid);
    CREATE TABLE IF NOT EXISTS progress_msgs (key TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, PRIMARY KEY (key, message_id));
  `)
  // Columns added after Phase 1.
  const cols = new Set((db.query('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(c => c.name))
  for (const [name, type] of [['title', 'TEXT'], ['compact', 'INTEGER'], ['model', 'TEXT'], ['ctx_v', 'INTEGER NOT NULL DEFAULT 1']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${type}`)
  }

  const now = () => new Date().toISOString()
  const json = (v: unknown) => {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  const qEvent = db.prepare('INSERT INTO events (ts, bot, update_json) VALUES (?, ?, ?)')
  const qApi = db.prepare('INSERT INTO outbound (ts, bot, conv, method, payload_json, result_json, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const qRecentOut = db.prepare('SELECT ts, method, payload_json, error FROM outbound WHERE conv = ? ORDER BY id DESC LIMIT ?')
  const qGet = db.prepare('SELECT * FROM conversations WHERE key = ?')
  const qAll = db.prepare('SELECT * FROM conversations ORDER BY key')
  const qFind = db.prepare('SELECT * FROM conversations WHERE bot = ? AND chat_id = ?')
  const qIns = db.prepare('INSERT INTO conversations (key, bot, chat_id, type, folder, role, session_id, created_at, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const qSess = db.prepare('UPDATE conversations SET session_id = ? WHERE key = ?')
  const qEnq = db.prepare('INSERT INTO queue (conv, created_at, params) VALUES (?, ?, ?)')
  const qDel = db.prepare("UPDATE queue SET status = 'delivered', delivered_at = ? WHERE qid = ? AND status = 'pending'")
  const qAck = db.prepare("UPDATE queue SET status = 'acked', acked_at = ? WHERE qid = ?")
  const qUnd = db.prepare("SELECT qid, conv, params, status FROM queue WHERE conv = ? AND status != 'acked' ORDER BY qid")
  const qBack = db.prepare("SELECT DISTINCT conv FROM queue WHERE status != 'acked'")
  const qUserGet = db.prepare('SELECT role FROM users WHERE uid = ?')
  const qUserSet = db.prepare('INSERT INTO users (uid, role, updated_at) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at')
  const qUserDel = db.prepare('DELETE FROM users WHERE uid = ?')
  const qUsers = db.prepare('SELECT uid, role FROM users ORDER BY uid')
  const qLogAdd = db.prepare('INSERT INTO router_log (conv, ts, text) VALUES (?, ?, ?)')
  const qLogBind = db.prepare('UPDATE router_log SET qid = ? WHERE conv = ? AND qid IS NULL')
  const qLogFor = db.prepare('SELECT * FROM router_log WHERE conv = ? AND qid = ? ORDER BY id')

  const qPAdd = db.prepare('INSERT OR REPLACE INTO progress_msgs (key, chat_id, message_id) VALUES (?, ?, ?)')
  const qPDel = db.prepare('DELETE FROM progress_msgs WHERE key = ? AND message_id = ?')
  const qPAll = db.prepare('SELECT key, chat_id, message_id FROM progress_msgs')
  const get = (key: string) => (qGet.get(key) as Conversation | null) ?? null
  return {
    logEvent: (bot, update) => { qEvent.run(now(), bot, json(update)) },
    logApiCall: (bot, method, payload, result, error, conv) => {
      qApi.run(now(), bot, conv, method, json(payload), result === undefined ? null : json(result), error)
    },
    recentOutbound: (conv, limit) => qRecentOut.all(conv, limit) as any,
    getConversation: get,
    listConversations: () => qAll.all() as Conversation[],
    findConversation: (bot, chat_id) => (qFind.get(bot, chat_id) as Conversation | null) ?? null,
    insertConversation: c => { qIns.run(c.key, c.bot, c.chat_id, c.type, c.folder, c.role, c.session_id, c.created_at, c.title ?? null) },
    setSession: (key, sid) => { qSess.run(sid, key) },
    updateConversation(key, fields) {
      const sets: string[] = []
      const vals: Array<string | number | null> = []
      for (const [k, v] of Object.entries(fields)) {
        if (!['role', 'title', 'compact', 'model'].includes(k)) continue
        sets.push(`${k} = ?`)
        vals.push((v ?? null) as string | number | null)
      }
      if (sets.length) db.prepare(`UPDATE conversations SET ${sets.join(', ')}, ctx_v = ctx_v + 1 WHERE key = ?`).run(...vals, key)
      return get(key)!
    },
    enqueue: (conv, params) => Number(qEnq.run(conv, now(), json(params)).lastInsertRowid),
    markDelivered: qid => { qDel.run(now(), qid) },
    ack: qid => { qAck.run(now(), qid) },
    undelivered: conv => qUnd.all(conv) as QueueRow[],
    convsWithBacklog: () => (qBack.all() as Array<{ conv: string }>).map(r => r.conv),
    getUserRole: uid => ((qUserGet.get(uid) as { role: string } | null)?.role) ?? null,
    setUserRole: (uid, role) => { if (role) qUserSet.run(uid, role, now()); else qUserDel.run(uid) },
    listUsers: () => qUsers.all() as Array<{ uid: string; role: string }>,
    addLog: (conv, text) => { qLogAdd.run(conv, now(), text) },
    bindLogs(conv, qid) {
      qLogBind.run(qid, conv)
      return qLogFor.all(conv, qid) as LogRow[]
    },
    trackProgress: (key, chat_id, id) => { qPAdd.run(key, chat_id, id) },
    untrackProgress: (key, id) => { qPDel.run(key, id) },
    orphanProgress: () => qPAll.all() as Array<{ key: string; chat_id: string; message_id: number }>,
    close: () => db.close(),
  }
}
