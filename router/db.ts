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
  last_seen?: string | null
  /** Marked by /router session rotate: stop the worker once it is idle. */
  rotate_pending?: number
}

/** Everyone the bot has seen (plan 03 資料表 people). */
export type Person = { uid: string; name: string | null; username: string | null; photo_file_id: string | null; photo_checked_at: string | null; first_seen: string; last_seen: string; last_chat_id: string | null }

/** /router perm overrides on top of a conversation's role template. */
export type OverrideKind = 'tool-allow' | 'tool-deny' | 'path-read' | 'path-write' | 'net' | 'mcp' | 'send' | 'pkg'
export type Override = { conv: string; kind: OverrideKind; value: string }

/** Cross-conversation send requests (plan 03 Grants). */
export type Grant = { id: number; from_conv: string; target: string; mode: 'owner' | 'target'; reason: string | null; status: 'pending' | 'approved' | 'denied'; created_at: string; decided_by: string | null; decided_at: string | null }

/** Per-bot first-run setup (plan 03 初次設定): persona interview, approvals group. */
export type BotSetup = {
  bot: string
  /** The owner finished the persona interview (save_bot_profile). */
  persona_done: number
  persona: string | null
  /** Forum group for notices and approval requests; null = the owner's DM. */
  approvals_chat: string | null
  approvals_topic: number | null
  notices_topic: number | null
  /** Topic for the elevation log (提權紀錄). */
  elevlog_topic: number | null
  /** Topic for each use of an approved authorization (執行授權). */
  authuse_topic: number | null
  /** The owner chose DM instead of a group. */
  group_skipped: number
}

/** Messages that carry approve/deny buttons, so every copy shows the outcome. */
export type ApprovalMsg = { kind: string; ref: number; bot: string; chat_id: string; message_id: number; text: string }

/** Package install review (plan 07 power 安裝套件). */
export type PkgVerdict = { eco: string; name: string; risk: 'low' | 'medium' | 'high'; reason: string; at: string }
export type PkgRequest = { id: number; conv: string; pkgs: string; reason: string; status: 'pending' | 'approved' | 'denied'; created_at: string; decided_by: string | null }

/** Elevation requests (plan 07 提權): passive = the router asked after a block, active = request_elevation. */
export type Elevation = {
  id: number; conv: string; kind: 'passive' | 'active'; sender: string | null; action: string; reason: string
  status: 'pending' | 'approved' | 'denied' | 'expired'; decided_by: string | null; decided_role: string | null; created_at: string
}
/** What an approved request granted (router/authz.ts), so it can be revoked. */
export type ApprovalGrant = { id: number; kind: string; ref: number; conv: string; choice: string; overrides: string; status: 'active' | 'revoked'; revoked_by: string | null }

export type ElevLogKind = 'blocked' | 'request' | 'approved' | 'denied' | 'expired'

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
  /** The conversation moved to another folder (bot folders); bumps ctx_v. */
  setFolder(key: string, folder: string): Conversation
  /** Update some conversation fields; bumps ctx_v. Returns the new row. */
  updateConversation(key: string, fields: Partial<Pick<Conversation, 'role' | 'title' | 'compact' | 'model'>>): Conversation
  enqueue(conv: string, params: unknown): number
  markDelivered(qid: number): void
  ack(qid: number): void
  /** pending + delivered-but-unacked, oldest first. */
  undelivered(conv: string): QueueRow[]
  /** Conversations with anything not yet acked. */
  convsWithBacklog(): string[]
  /** Upsert from an update: name, @username, last seen, where. */
  seePerson(p: { uid: string; name: string | null; username: string | null; chat_id: string | null }, at?: string): Person
  /** Fill the people table from logged updates for anyone not in it yet. */
  backfillPeople(): number
  setPersonPhoto(uid: string, file_id: string | null): void
  getPerson(uid: string): Person | null
  findPersonByUsername(username: string): Person | null
  /** Conversations: refresh title and last activity. */
  touchConversation(key: string, title: string | null): void
  setRotate(key: string, on: boolean): void
  listOverrides(conv: string): Override[]
  addOverride(o: Override): boolean
  removeOverride(conv: string, kinds: OverrideKind[], value: string): number
  clearOverrides(conv: string): number
  addGrant(g: Pick<Grant, 'from_conv' | 'target' | 'mode' | 'reason'>): number
  getGrant(id: number): Grant | null
  decideGrant(id: number, status: 'approved' | 'denied', by: string): boolean
  rotatePending(): Conversation[]
  /** chat_context changed for every conversation of a bot (persona saved). */
  bumpContext(bot: string): void
  addElevation(e: Pick<Elevation, 'conv' | 'kind' | 'sender' | 'action' | 'reason'>): number
  getElevation(id: number): Elevation | null
  pendingElevation(conv: string): Elevation | null
  decideElevation(id: number, status: 'approved' | 'denied' | 'expired', by: string | null, role: string | null): boolean
  addElevLog(conv: string, kind: ElevLogKind, text: string, ref: number | null): void
  /** The Telegram message a conversation was handling when it made request kind#ref. */
  setRequestOrigin(kind: string, ref: number, conv: string, message_id: number): void
  requestOrigin(kind: string, ref: number): number | null
  addApprovalGrant(g: Pick<ApprovalGrant, 'kind' | 'ref' | 'conv' | 'choice' | 'overrides'>): number
  approvalGrantsFor(kind: string, ref: number): ApprovalGrant[]
  activeApprovalGrants(conv: string): ApprovalGrant[]
  revokeApprovalGrant(id: number, by: string): boolean
  /** One use of an approval; msg: where it was posted (so a revoke can update it). */
  addAuthUse(grant: number, conv: string, text: string, msg?: { bot: string; chat_id: string; message_id: number }): void
  authUses(grant: number): Array<{ ts: string; text: string; bot: string | null; chat_id: string | null; message_id: number | null }>
  elevLog(conv: string | null, limit: number): Array<{ ts: string; conv: string; kind: ElevLogKind; text: string; ref: number | null }>
  getBotSetup(bot: string): BotSetup | null
  /** Create the row if missing, then set the given fields. */
  updateBotSetup(bot: string, fields: Partial<Omit<BotSetup, 'bot'>>): BotSetup
  addApprovalMsg(m: ApprovalMsg): void
  approvalMsgs(kind: string, ref: number): ApprovalMsg[]
  getPkgVerdict(eco: string, name: string): PkgVerdict | null
  setPkgVerdict(v: Omit<PkgVerdict, 'at'>): void
  addPkgRequest(r: Pick<PkgRequest, 'conv' | 'pkgs' | 'reason'>): number
  getPkgRequest(id: number): PkgRequest | null
  decidePkgRequest(id: number, status: 'approved' | 'denied', by: string): boolean
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
    CREATE TABLE IF NOT EXISTS people (
      uid TEXT PRIMARY KEY, name TEXT, username TEXT, photo_file_id TEXT, photo_checked_at TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, last_chat_id TEXT
    );
    CREATE INDEX IF NOT EXISTS people_username ON people (lower(username));
    CREATE TABLE IF NOT EXISTS overrides (conv TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (conv, kind, value));
    CREATE TABLE IF NOT EXISTS grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_conv TEXT NOT NULL, target TEXT NOT NULL, mode TEXT NOT NULL,
      reason TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS bot_setup (
      bot TEXT PRIMARY KEY, persona_done INTEGER NOT NULL DEFAULT 0, persona TEXT,
      approvals_chat TEXT, approvals_topic INTEGER, notices_topic INTEGER,
      group_skipped INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS elevations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, kind TEXT NOT NULL, sender TEXT, action TEXT NOT NULL, reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_role TEXT, created_at TEXT NOT NULL, decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS request_origin (kind TEXT NOT NULL, ref INTEGER NOT NULL, conv TEXT NOT NULL, message_id INTEGER NOT NULL, PRIMARY KEY (kind, ref));
    CREATE TABLE IF NOT EXISTS approval_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref INTEGER NOT NULL, conv TEXT NOT NULL, choice TEXT NOT NULL,
      overrides TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, revoked_by TEXT, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_uses (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, grant_id INTEGER NOT NULL, conv TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS elev_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, conv TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, ref INTEGER);
    CREATE TABLE IF NOT EXISTS approval_msgs (kind TEXT NOT NULL, ref INTEGER NOT NULL, bot TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pkg_verdicts (eco TEXT NOT NULL, name TEXT NOT NULL, risk TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (eco, name));
    CREATE TABLE IF NOT EXISTS pkg_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, pkgs TEXT NOT NULL, reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS progress_msgs (key TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, PRIMARY KEY (key, message_id));
  `)
  // Columns added after Phase 1.
  const cols = new Set((db.query('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(c => c.name))
  const setupCols = new Set((db.query('PRAGMA table_info(bot_setup)').all() as Array<{ name: string }>).map(c => c.name))
  if (!setupCols.has('elevlog_topic')) db.exec('ALTER TABLE bot_setup ADD COLUMN elevlog_topic INTEGER')
  if (!setupCols.has('authuse_topic')) db.exec('ALTER TABLE bot_setup ADD COLUMN authuse_topic INTEGER')
  const useCols = new Set((db.query('PRAGMA table_info(auth_uses)').all() as Array<{ name: string }>).map(c => c.name))
  for (const [n, t] of [['bot', 'TEXT'], ['chat_id', 'TEXT'], ['message_id', 'INTEGER']]) if (!useCols.has(n!)) db.exec(`ALTER TABLE auth_uses ADD COLUMN ${n} ${t}`)
  for (const [name, type] of [['title', 'TEXT'], ['compact', 'INTEGER'], ['model', 'TEXT'], ['ctx_v', 'INTEGER NOT NULL DEFAULT 1'], ['last_seen', 'TEXT'], ['rotate_pending', 'INTEGER NOT NULL DEFAULT 0']]) {
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
  const qPeopleUp = db.prepare(`INSERT INTO people (uid, name, username, first_seen, last_seen, last_chat_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET name = excluded.name, username = excluded.username, last_seen = excluded.last_seen, last_chat_id = coalesce(excluded.last_chat_id, last_chat_id)`)
  const qPeopleGet = db.prepare('SELECT * FROM people WHERE uid = ?')
  const qPeopleByName = db.prepare('SELECT * FROM people WHERE lower(username) = lower(?) ORDER BY last_seen DESC LIMIT 1')
  const qPeoplePhoto = db.prepare('UPDATE people SET photo_file_id = ?, photo_checked_at = ? WHERE uid = ?')
  const qConvTouch = db.prepare('UPDATE conversations SET last_seen = ?, title = coalesce(?, title) WHERE key = ?')
  const qOvList = db.prepare('SELECT conv, kind, value FROM overrides WHERE conv = ? ORDER BY kind, value')
  const qOvAdd = db.prepare('INSERT OR IGNORE INTO overrides (conv, kind, value, created_at) VALUES (?, ?, ?, ?)')
  const qOvClear = db.prepare('DELETE FROM overrides WHERE conv = ?')
  const qRotSet = db.prepare('UPDATE conversations SET rotate_pending = ? WHERE key = ?')
  const qRotAll = db.prepare('SELECT * FROM conversations WHERE rotate_pending = 1 ORDER BY key')
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
    setFolder: (key, folder) => { db.prepare('UPDATE conversations SET folder = ?, ctx_v = ctx_v + 1 WHERE key = ?').run(folder, key); return get(key)! },
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
    seePerson(p, at) {
      const t = at ?? now()
      qPeopleUp.run(p.uid, p.name, p.username, t, t, p.chat_id)
      return qPeopleGet.get(p.uid) as Person
    },
    backfillPeople() {
      const known = new Set((db.query('SELECT uid FROM people').all() as Array<{ uid: string }>).map(r => r.uid))
      const filled = new Set<string>()
      // Oldest first, so the newest name/username and last_seen win.
      for (const row of db.query('SELECT ts, update_json FROM events ORDER BY id').iterate() as Iterable<{ ts: string; update_json: string }>) {
        let u: any
        try { u = JSON.parse(row.update_json) } catch { continue }
        const m = u.message ?? u.edited_message ?? u.callback_query
        const from = m?.from
        if (!from?.id) continue
        const uid = String(from.id)
        if (known.has(uid)) continue
        filled.add(uid)
        const chat = m.chat ?? m.message?.chat
        qPeopleUp.run(uid, [from.first_name, from.last_name].filter(Boolean).join(' ') || null, from.username ?? null, row.ts, row.ts, chat?.id != null ? String(chat.id) : null)
      }
      return filled.size
    },
    setPersonPhoto: (uid, file_id) => { qPeoplePhoto.run(file_id, now(), uid) },
    getPerson: uid => (qPeopleGet.get(uid) as Person | null) ?? null,
    findPersonByUsername: u => (qPeopleByName.get(u.replace(/^@/, '')) as Person | null) ?? null,
    touchConversation: (key, title) => { qConvTouch.run(now(), title, key) },
    listOverrides: conv => qOvList.all(conv) as Override[],
    addOverride: o => qOvAdd.run(o.conv, o.kind, o.value, now()).changes > 0,
    removeOverride(conv, kinds, value) {
      let n = 0
      for (const k of kinds) n += db.prepare('DELETE FROM overrides WHERE conv = ? AND kind = ? AND value = ?').run(conv, k, value).changes
      return n
    },
    addGrant: g => Number(db.prepare('INSERT INTO grants (from_conv, target, mode, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(g.from_conv, g.target, g.mode, g.reason, now()).lastInsertRowid),
    getGrant: id => (db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as Grant | null) ?? null,
    decideGrant: (id, status, by) => db.prepare("UPDATE grants SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, by, now(), id).changes > 0,
    clearOverrides: conv => qOvClear.run(conv).changes,
    setRotate: (key, on) => { qRotSet.run(on ? 1 : 0, key) },
    rotatePending: () => qRotAll.all() as Conversation[],
    setRequestOrigin: (kind, ref, conv, mid) => { db.prepare('INSERT OR REPLACE INTO request_origin (kind, ref, conv, message_id) VALUES (?, ?, ?, ?)').run(kind, ref, conv, mid) },
    requestOrigin: (kind, ref) => ((db.prepare('SELECT message_id FROM request_origin WHERE kind = ? AND ref = ?').get(kind, ref) as { message_id: number } | null)?.message_id) ?? null,
    addApprovalGrant: g => Number(db.prepare('INSERT INTO approval_grants (kind, ref, conv, choice, overrides, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(g.kind, g.ref, g.conv, g.choice, g.overrides, now()).lastInsertRowid),
    approvalGrantsFor: (kind, ref) => db.prepare('SELECT id, kind, ref, conv, choice, overrides, status, revoked_by FROM approval_grants WHERE kind = ? AND ref = ? ORDER BY id').all(kind, ref) as ApprovalGrant[],
    activeApprovalGrants: conv => db.prepare("SELECT id, kind, ref, conv, choice, overrides, status, revoked_by FROM approval_grants WHERE conv = ? AND status = 'active' ORDER BY id").all(conv) as ApprovalGrant[],
    revokeApprovalGrant: (id, by) => db.prepare("UPDATE approval_grants SET status = 'revoked', revoked_by = ?, revoked_at = ? WHERE id = ? AND status = 'active'").run(by, now(), id).changes > 0,
    addAuthUse: (grant, conv, text, msg) => { db.prepare('INSERT INTO auth_uses (ts, grant_id, conv, text, bot, chat_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now(), grant, conv, text, msg?.bot ?? null, msg?.chat_id ?? null, msg?.message_id ?? null) },
    authUses: grant => db.prepare('SELECT ts, text, bot, chat_id, message_id FROM auth_uses WHERE grant_id = ? ORDER BY id').all(grant) as any,
    addElevation: e => Number(db.prepare('INSERT INTO elevations (conv, kind, sender, action, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(e.conv, e.kind, e.sender, e.action, e.reason, now()).lastInsertRowid),
    getElevation: id => (db.prepare('SELECT id, conv, kind, sender, action, reason, status, decided_by, decided_role, created_at FROM elevations WHERE id = ?').get(id) as Elevation | null) ?? null,
    pendingElevation: conv => (db.prepare("SELECT id, conv, kind, sender, action, reason, status, decided_by, decided_role, created_at FROM elevations WHERE conv = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(conv) as Elevation | null) ?? null,
    decideElevation: (id, status, by, role) => db.prepare("UPDATE elevations SET status = ?, decided_by = ?, decided_role = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, by, role, now(), id).changes > 0,
    addElevLog: (conv, kind, text, ref) => { db.prepare('INSERT INTO elev_log (ts, conv, kind, text, ref) VALUES (?, ?, ?, ?, ?)').run(now(), conv, kind, text, ref) },
    elevLog: (conv, limit) => (conv
      ? db.prepare('SELECT ts, conv, kind, text, ref FROM elev_log WHERE conv = ? ORDER BY id DESC LIMIT ?').all(conv, limit)
      : db.prepare('SELECT ts, conv, kind, text, ref FROM elev_log ORDER BY id DESC LIMIT ?').all(limit)) as any,
    bumpContext: bot => { db.prepare('UPDATE conversations SET ctx_v = ctx_v + 1 WHERE bot = ?').run(bot) },
    getBotSetup: bot => (db.prepare('SELECT bot, persona_done, persona, approvals_chat, approvals_topic, notices_topic, elevlog_topic, authuse_topic, group_skipped FROM bot_setup WHERE bot = ?').get(bot) as BotSetup | null) ?? null,
    updateBotSetup(bot, fields) {
      db.prepare('INSERT OR IGNORE INTO bot_setup (bot, updated_at) VALUES (?, ?)').run(bot, now())
      const keys = Object.keys(fields).filter(k => ['persona_done', 'persona', 'approvals_chat', 'approvals_topic', 'notices_topic', 'elevlog_topic', 'authuse_topic', 'group_skipped'].includes(k))
      if (keys.length) db.prepare(`UPDATE bot_setup SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE bot = ?`).run(...keys.map(k => ((fields as any)[k] ?? null) as string | number | null), now(), bot)
      return db.prepare('SELECT bot, persona_done, persona, approvals_chat, approvals_topic, notices_topic, elevlog_topic, authuse_topic, group_skipped FROM bot_setup WHERE bot = ?').get(bot) as BotSetup
    },
    addApprovalMsg: m => { db.prepare('INSERT INTO approval_msgs (kind, ref, bot, chat_id, message_id, text) VALUES (?, ?, ?, ?, ?, ?)').run(m.kind, m.ref, m.bot, m.chat_id, m.message_id, m.text) },
    approvalMsgs: (kind, ref) => db.prepare('SELECT * FROM approval_msgs WHERE kind = ? AND ref = ?').all(kind, ref) as ApprovalMsg[],
    getPkgVerdict: (eco, name) => (db.prepare('SELECT * FROM pkg_verdicts WHERE eco = ? AND name = ?').get(eco, name) as PkgVerdict | null) ?? null,
    setPkgVerdict: v => { db.prepare('INSERT OR REPLACE INTO pkg_verdicts (eco, name, risk, reason, at) VALUES (?, ?, ?, ?, ?)').run(v.eco, v.name, v.risk, v.reason, now()) },
    addPkgRequest: r => Number(db.prepare('INSERT INTO pkg_requests (conv, pkgs, reason, created_at) VALUES (?, ?, ?, ?)').run(r.conv, r.pkgs, r.reason, now()).lastInsertRowid),
    getPkgRequest: id => (db.prepare('SELECT id, conv, pkgs, reason, status, created_at, decided_by FROM pkg_requests WHERE id = ?').get(id) as PkgRequest | null) ?? null,
    decidePkgRequest: (id, status, by) => db.prepare("UPDATE pkg_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, by, now(), id).changes > 0,
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
