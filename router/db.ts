// Router-owned tables (plan 03 「資料表」). The messages table stays in
// ./telegram/store.ts, opened on the same db file. The router is the only
// writer; plugins and hooks never open this file.

import { Database } from 'bun:sqlite'
import { randomBytes } from 'crypto'

export type ConvType = 'dm' | 'group' | 'channel'

export type Conversation = {
  key: string          // folder name, e.g. dm-137438526
  bot: string
  chat_id: string
  type: ConvType
  folder: string
  /** Groups and channels: the conversation's own role. DMs: the user's role
   *  (userRole), resolved on every read; the stored column only mirrors it. */
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
  /** Which message reactions reach the worker (router/reactions.ts); null = config receiveReact. */
  react?: string | null
  /** JSON of the flags the worker's daemon job was last started with (router/jobs.ts): what to compare with when its state.json cannot be read. */
  worker_flags?: string | null
}

/** Everyone the bot has seen (plan 03 資料表 people). */
export type Person = { uid: string; name: string | null; username: string | null; photo_file_id: string | null; photo_checked_at: string | null; first_seen: string; last_seen: string; last_chat_id: string | null }

/** /router perm overrides on top of a conversation's role template. */
export type OverrideKind = 'tool-allow' | 'tool-deny' | 'path-read' | 'path-write' | 'net' | 'mcp' | 'send' | 'pkg'
export type Override = { conv: string; kind: OverrideKind; value: string }
/** The kinds a user's own overrides take (/router perm user): the ones that go into a worker's settings. */
export type UserOverrideKind = 'tool-allow' | 'tool-deny' | 'path-read' | 'path-write' | 'net' | 'mcp'

/** Cross-conversation send requests (plan 03 Grants). */
export type Grant = { id: number; from_conv: string; target: string; mode: 'owner' | 'target'; reason: string | null; status: 'pending' | 'approved' | 'denied'; created_at: string; decided_by: string | null; decided_at: string | null }

/** Per-bot first-run setup (plan 03 初次設定): persona interview, approvals group. */
export type BotSetup = {
  bot: string
  /** The Telegram bot id (the token's part before the colon) this setup belongs to; null in rows from before it was kept. */
  bot_id: string | null
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
  /** Topic for secret detections, raw requests and handles (🔑 密鑰偵測, plan 10e). */
  secret_topic: number | null
  /** Topic for DM pairing requests with approve/deny buttons (🤝 配對申請, router/pairing.ts). */
  pairing_topic: number | null
  /** The owner chose DM instead of a group. */
  group_skipped: number
}

/** A DM pairing request (router/pairing.ts): a code gate() issued, posted
 *  with approve/deny buttons; the record of how it was settled. */
export type PairingRequest = {
  id: number; bot: string; code: string; uid: string; chat_id: string; name: string; username: string | null; first_text: string | null
  created_at: string; expires_at: number; status: 'pending' | 'approved' | 'denied' | 'expired'
  decided_by: string | null; decided_via: 'button' | 'command' | 'expiry' | null; decided_at: string | null
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

export type ElevLogKind = 'blocked' | 'request' | 'approved' | 'denied' | 'expired' | 'auto'

/** Conversation secrets (router/secrets.ts): value is sealed (AES-256-GCM),
 *  allowed is a JSON list of Bot API methods or URL paths ("*" = all). */
export type ConvSecret = {
  bot: string; chat_id: string; name: string; kind: 'telegram-bot' | 'http'; value: string
  base_url: string | null; allowed: string; added_by: string; created_at: string
  /** http: header carrying the key and its scheme (null: Authorization, Bearer), as Credential. */
  header: string | null; scheme: string | null
  /** http: query parameter carrying the key instead of a header (null: in the header). */
  query?: string | null
  /** telegram-bot: "@username (id)" from getMe at registration. */
  label: string | null
  /** Registered from a handle (secret_from_handle, plan 10e): its code; null for /secret set. */
  source?: string | null
  /** http: JSON object of default headers (--default-header), as Credential defaultHeaders; null: none. */
  default_headers?: string | null
}

/** Plan 10e 原始事件: events rows with masked = 1 have their original update in
 *  event_raw, sealed (AES-256-GCM) and bound to the event id; fields is a JSON
 *  list of findings (path, kind, last 4, hash, held value it equals). */
export type EventRow = { id: number; ts: string; bot: string; update_json: string; masked: number }
export type EventRaw = { event_id: number; sealed: string; fields: string; created_at: string }
/** A text attachment downloaded on arrival (plan 10e): path holds what a worker gets (markers if it held a secret). */
export type AttachmentCache = { bot: string; file_id: string; file_unique_id: string; file_path: string; path: string; event_id: number | null }
/** A handle given to one conversation for one value of an event (secret_from_handle). expires_at null: permanent. */
export type SecretHandle = {
  id: number; code: string; event_id: number; n: number; kind: string; last4: string
  bot: string; chat_id: string; conv: string; request_id: number | null; expires_at: string | null
  uses: number; registered: string | null; revoked_by: string | null; revoked_at: string | null; created_at: string
}
export type SecretRequest = { id: number; ts: string; conv: string; sender: string | null; event_id: number; question: string; handles: string | null; status: 'pending' | 'answered' | 'blocked' | 'no-answer' | 'refused'; note: string | null }
/** A message with a secret, deleted 5 minutes after the reminder unless someone cancels (survives restarts).
 *  kind command: a registration command's own message (/secret set, /router cred add|rotate,
 *  /router bot add|rotate), deleted 60 seconds after the router answered; only the sender may cancel. */
export type SecretDeletion = {
  id: number; event_id: number; bot: string; chat_id: string; message_id: number; sender: string; kind: 'detect' | 'command'
  notice_id: number | null; log_chat: string | null; log_msg: number | null; log_text: string | null
  due_at: string; status: 'pending' | 'deleted' | 'failed' | 'cancelled'; decided_by: string | null; done_at: string | null
}

/** One tool call seen in PreToolUse (router/toolhistory.ts): no arguments, only the tool,
 *  the outcome and, for SendMessage, the recipient. eff_role: an elevated subagent's role. */
export type ToolUse = {
  ts?: string; conv: string; conv_role: string; eff_role: string | null; tool: string
  decision: 'allow' | 'deny' | 'error'; reason: string | null; target: string | null; subagent: boolean
}
export type ToolStat = { tool: string; conv_role: string; elevated: number; decision: string; n: number }

export type QueueRow = { qid: number; conv: string; params: string; status: 'pending' | 'delivered' | 'acked' }
/** An elevation kept across router restarts (router/elevation.ts): kind grant, approved and waiting for the
 *  worker's next subagent (agent ''), until epoch ms; kind bound, the subagent it went to. worker: workerKey, null not known yet. */
export type ElevBind = { kind: 'grant' | 'bound'; conv: string; agent: string; worker: string | null; elev: number; role: string; by: string; until: number | null; at: string }
export type LogRow = { id: number; conv: string; ts: string; text: string; qid: number | null }

export interface RouterDb {
  /** The new events row id. */
  logEvent(bot: string, update: unknown): number
  /** An update with secrets (plan 10e): build gets the row id and returns the
   *  masked update, the sealed original and its findings; one transaction. */
  logMaskedEvent(bot: string, build: (id: number) => { update: unknown; sealed: string; fields: string }): number
  getEvent(id: number): EventRow | null
  getEventRaw(id: number): EventRaw | null
  /** Updates that mention a Telegram file_id, newest first (the message an attachment came with). */
  eventsWithFile(fileId: string, limit?: number): EventRow[]
  /** The events row a text attachment was stored as (plan 10e, update_json {"attachment": ...}). */
  attachmentEvent(fileId: string): EventRow | null
  /** Text attachments the router downloaded when they came in (masked when they held a secret). */
  cacheAttachment(a: AttachmentCache): void
  cachedAttachment(bot: string, fileId: string): AttachmentCache | null
  /** A worker got the kept copy: it stays another keepDays from now. */
  touchAttachment(bot: string, fileId: string): void
  /** Kept copies not used since beforeIso (oldest first). */
  staleAttachments(beforeIso: string): AttachmentCache[]
  removeAttachment(bot: string, fileId: string): void
  addHandle(h: Pick<SecretHandle, 'event_id' | 'n' | 'kind' | 'last4' | 'bot' | 'chat_id' | 'conv' | 'request_id' | 'expires_at'>): SecretHandle
  getHandle(code: string): SecretHandle | null
  /** bot and chat null: every conversation's. */
  listHandles(bot: string | null, chat_id: string | null): SecretHandle[]
  /** One use: registered as a secret (name), or a call with that secret. */
  useHandle(code: string, registered?: string): void
  revokeHandle(code: string, by: string): boolean
  addSecretRequest(r: Pick<SecretRequest, 'conv' | 'sender' | 'event_id' | 'question'>): number
  settleSecretRequest(id: number, status: SecretRequest['status'], handles: string[], note: string | null): void
  getSecretRequest(id: number): SecretRequest | null
  /** The 🔑 密鑰偵測 record in router.db (also posted to the topic). */
  addSecretLog(bot: string, kind: string, text: string, ref: number | null): void
  secretLog(limit: number): Array<{ ts: string; bot: string; kind: string; text: string; ref: number | null }>
  scheduleDeletion(d: Pick<SecretDeletion, 'event_id' | 'bot' | 'chat_id' | 'message_id' | 'sender' | 'notice_id' | 'due_at'> & { kind?: SecretDeletion['kind'] }): number
  getDeletion(id: number): SecretDeletion | null
  dueDeletions(nowIso: string): SecretDeletion[]
  updateDeletion(id: number, fields: Partial<Pick<SecretDeletion, 'notice_id' | 'log_chat' | 'log_msg' | 'log_text'>>): void
  /** pending -> deleted | failed | cancelled; false when it was already settled. */
  settleDeletion(id: number, status: 'deleted' | 'failed' | 'cancelled', by: string | null): boolean
  logApiCall(bot: string, method: string, payload: unknown, result: unknown, error: string | null, conv: string | null): void
  recentOutbound(conv: string, limit: number): Array<{ ts: string; method: string; payload_json: string; error: string | null }>
  getConversation(key: string): Conversation | null
  listConversations(): Conversation[]
  findConversation(bot: string, chat_id: string): Conversation | null
  insertConversation(c: Conversation): void
  setSession(key: string, session_id: string | null): void
  /** The flags the worker's job was started with (router/jobs.ts); null forgets them. */
  setWorkerFlags(key: string, flags: string[] | null): void
  /** The conversation moved to another folder (bot folders); bumps ctx_v. */
  setFolder(key: string, folder: string): Conversation
  /** Update some conversation fields; bumps ctx_v. Returns the new row.
   *  A DM's role cannot be set here: it is its user's role (setUserRole). */
  updateConversation(key: string, fields: Partial<Pick<Conversation, 'role' | 'title' | 'compact' | 'model'>>): Conversation
  /** /router chat react: all | botself_only | disable, null = config default. No ctx_v bump (the worker's context does not show it). */
  setReact(key: string, mode: string | null): Conversation
  /** Messages a bot sent (any Bot API call that returned one), for receiveReact botself_only. */
  noteBotMessages(bot: string, method: string, payload: unknown, result: unknown): void
  isBotMessage(bot: string, chat_id: string, message_id: number): boolean
  enqueue(conv: string, params: unknown): number
  markDelivered(qid: number): void
  ack(qid: number): void
  /** pending + delivered-but-unacked, oldest first. */
  undelivered(conv: string): QueueRow[]
  /** The delivery's random tag (meta delivery, router/elevation.ts prompt tags): made the first time, the same on a redelivery. */
  deliveryTag(qid: number): string
  /** The queue row of conv delivered with this tag; null when there is none. */
  deliveryByTag(conv: string, tag: string): { qid: number; params: string; delivered_at: string | null; prompted_at: string | null } | null
  /** A prompt named these deliveries (the first time counts). */
  markPrompted(conv: string, tags: string[]): void
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
  /** A user's own overrides (/router perm user, docs/permissions.md 使用者覆寫); conv is "user:<uid>". */
  listUserOverrides(uid: string): Override[]
  addUserOverride(uid: string, kind: UserOverrideKind, value: string): boolean
  removeUserOverride(uid: string, kinds: UserOverrideKind[], value: string): number
  clearUserOverrides(uid: string): number
  addGrant(g: Pick<Grant, 'from_conv' | 'target' | 'mode' | 'reason'>): number
  getGrant(id: number): Grant | null
  decideGrant(id: number, status: 'approved' | 'denied', by: string): boolean
  rotatePending(): Conversation[]
  /** chat_context changed for every conversation of a bot (persona saved). */
  bumpContext(bot: string): void
  addElevation(e: Pick<Elevation, 'conv' | 'kind' | 'sender' | 'action' | 'reason'>): number
  getElevation(id: number): Elevation | null
  pendingElevation(conv: string): Elevation | null
  pendingElevations(): Elevation[]
  decideElevation(id: number, status: 'approved' | 'denied' | 'expired', by: string | null, role: string | null): boolean
  addElevLog(conv: string, kind: ElevLogKind, text: string, ref: number | null): void
  /** Privileged skills (router/privskill.ts): approvals pin the skill's hash. */
  approveSkill(dir: string, skill: string, hash: string, by: string): void
  skillApproval(dir: string): { skill: string; hash: string; approved_by: string; at: string } | null
  revokeSkill(dir: string): boolean
  listSkillApprovals(): Array<{ dir: string; skill: string; hash: string; approved_by: string; at: string }>
  addSkillRun(conv: string, skill: string, action: string, status: string): void
  skillRunsSince(conv: string, sinceIso: string): number
  /** When conv last ran skill with this status (ISO), or null: the daily refresh's catch-up. */
  lastSkillRunAt(conv: string, skill: string, status: string): string | null
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
  addPairingRequest(r: Pick<PairingRequest, 'bot' | 'code' | 'uid' | 'chat_id' | 'name' | 'username' | 'first_text' | 'expires_at'>): number
  getPairingRequest(id: number): PairingRequest | null
  /** The newest request for a code (codes are random, a later one may repeat an old). */
  pairingRequestByCode(code: string): PairingRequest | null
  /** Settle a pending request; false when it was no longer pending (another path got there first). */
  settlePairingRequest(id: number, status: 'approved' | 'denied' | 'expired', by: string | null, via: 'button' | 'command' | 'expiry'): boolean
  /** Pending requests whose code expired before now (ms). */
  expiredPairingRequests(now: number): PairingRequest[]
  approvalMsgs(kind: string, ref: number): ApprovalMsg[]
  getPkgVerdict(eco: string, name: string): PkgVerdict | null
  setPkgVerdict(v: Omit<PkgVerdict, 'at'>): void
  addPkgRequest(r: Pick<PkgRequest, 'conv' | 'pkgs' | 'reason'>): number
  getPkgRequest(id: number): PkgRequest | null
  decidePkgRequest(id: number, status: 'approved' | 'denied', by: string): boolean
  /** An approved request lets these items through once (custom sources, no override). */
  grantPkgOnce(id: number, items: string[]): void
  /** Use up the oldest unused once-grant of conv covering every item; its request id, or null. */
  takePkgOnce(conv: string, items: string[]): number | null
  getUserRole(uid: string): string | null
  /** The DM conversations whose role changed with it (their settings need rewriting). */
  setUserRole(uid: string, role: string | null): Conversation[]
  /** A person's effective role: owner when in config owners, else users.role, else user.
   *  A DM conversation's role is this for its chat_id. */
  userRole(uid: string): string
  /** Bring the stored role of every DM in line with its user's role (startup,
   *  config owners changed); bumps ctx_v of the ones that changed and returns them with the old value. */
  syncDmRoles(): Array<{ conv: Conversation; from: string }>
  listUsers(): Array<{ uid: string; role: string }>
  /** /router activity to show the conversation's worker with its next message (plan 03). */
  addLog(conv: string, text: string): void
  /** Logs to attach to queue item qid: ones already bound to it, plus any not yet bound. */
  bindLogs(conv: string, qid: number): LogRow[]
  /** Live progress messages, so ones orphaned by a router restart get cleaned up. */
  trackProgress(key: string, chat_id: string, message_id: number): void
  untrackProgress(key: string, message_id: number): void
  orphanProgress(): Array<{ key: string; chat_id: string; message_id: number }>
  /** Rewrite logged updates that may carry a token (text with /secret or
   *  /router); returns how many rows changed. Run once by name (migrations
   *  table): null when it already ran. */
  maskEventsOnce(name: string, mask: (update: unknown) => unknown): number | null
  setConvSecret(s: ConvSecret): void
  getConvSecret(bot: string, chat_id: string, name: string): ConvSecret | null
  listConvSecrets(bot: string, chat_id: string): ConvSecret[]
  /** Every conversation secret (sealed), for exact-match detection. */
  allConvSecrets(): ConvSecret[]
  /** Every conversation that has secrets, with their count. */
  convSecretChats(): Array<{ bot: string; chat_id: string; n: number }>
  /** name null: all of the conversation's secrets. Returns how many went. */
  removeConvSecret(bot: string, chat_id: string, name: string | null): number
  /** tool_history (router/toolhistory.ts). */
  addToolUse(u: ToolUse): void
  /** Counts since an ISO time, by tool, conversation role, elevated or not, decision. */
  toolStats(since: string): ToolStat[]
  /** Rows before an ISO time removed; returns how many. */
  purgeToolHistory(before: string): number
  /** own_agents (router/elevation.ts): a conversation's own subagents (agent ids, names),
   *  each bound to the worker process it started under. Keeps the newest max per worker. */
  addOwnAgent(conv: string, worker: string, name: string, max: number): void
  isOwnAgent(conv: string, worker: string, name: string): boolean
  /** A row for name under any worker (a plugin not back yet may be the same process). */
  hasOwnAgent(conv: string, name: string): boolean
  /** Oldest first. */
  ownAgents(conv: string, worker: string): string[]
  /** The conversation's rows of every worker but keep (null: all); returns how many went. */
  dropOwnAgents(conv: string, keep: string | null): number
  /** Rows added before an ISO time, and rows of conversations that no longer exist, removed; how many. */
  purgeOwnAgents(before: string): number
  /** elev_binds (router/elevation.ts): approved elevations kept across router restarts. */
  setElevBind(b: Omit<ElevBind, 'at'>): void
  dropElevBind(kind: ElevBind['kind'], conv: string, agent: string): void
  /** Every row of an elevation (revoked); how many went. */
  dropElevBindsOf(elev: number): number
  elevBinds(): ElevBind[]
  /** Grants past their time (epoch ms), bound rows added before an ISO time, rows of conversations gone; how many. */
  purgeElevBinds(nowMs: number, before: string): number
  close(): void
}

/** owners: config owners (the array config.ts loaded, changed in place by
 *  /router config set owners); they are owner in their DMs. */
export function openRouterDb(path: string, opts: { owners?: readonly string[] } = {}): RouterDb {
  const owners = opts.owners ?? []
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
    CREATE TABLE IF NOT EXISTS user_overrides (uid TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (uid, kind, value));
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
    CREATE TABLE IF NOT EXISTS skill_approvals (dir TEXT PRIMARY KEY, skill TEXT NOT NULL, hash TEXT NOT NULL, approved_by TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS skill_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, conv TEXT NOT NULL, skill TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL);
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
    CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, at TEXT NOT NULL, changed INTEGER);
    CREATE TABLE IF NOT EXISTS conv_secrets (
      bot TEXT NOT NULL, chat_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
      base_url TEXT, allowed TEXT NOT NULL, added_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (bot, chat_id, name)
    );
    CREATE TABLE IF NOT EXISTS attachment_cache (
      bot TEXT NOT NULL, file_id TEXT NOT NULL, file_unique_id TEXT NOT NULL, file_path TEXT NOT NULL, path TEXT NOT NULL,
      event_id INTEGER, created_at TEXT NOT NULL, last_used TEXT, PRIMARY KEY (bot, file_id)
    );
    CREATE TABLE IF NOT EXISTS event_raw (event_id INTEGER PRIMARY KEY, sealed TEXT NOT NULL, fields TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secret_handles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, event_id INTEGER NOT NULL, n INTEGER NOT NULL, kind TEXT NOT NULL, last4 TEXT NOT NULL,
      bot TEXT NOT NULL, chat_id TEXT NOT NULL, conv TEXT NOT NULL, request_id INTEGER, expires_at TEXT,
      uses INTEGER NOT NULL DEFAULT 0, registered TEXT, revoked_by TEXT, revoked_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secret_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, conv TEXT NOT NULL, sender TEXT, event_id INTEGER NOT NULL,
      question TEXT NOT NULL, handles TEXT, status TEXT NOT NULL DEFAULT 'pending', note TEXT
    );
    CREATE TABLE IF NOT EXISTS secret_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, bot TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, ref INTEGER);
    CREATE TABLE IF NOT EXISTS secret_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, bot TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, sender TEXT NOT NULL,
      notice_id INTEGER, log_chat TEXT, log_msg INTEGER, log_text TEXT, due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, done_at TEXT
    );
    CREATE TABLE IF NOT EXISTS progress_msgs (key TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, PRIMARY KEY (key, message_id));
    CREATE TABLE IF NOT EXISTS tool_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, conv TEXT NOT NULL, conv_role TEXT NOT NULL, eff_role TEXT,
      tool TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, target TEXT, subagent INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS tool_history_ts ON tool_history (ts);
    CREATE TABLE IF NOT EXISTS own_agents (conv TEXT NOT NULL, worker TEXT NOT NULL, name TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (conv, worker, name));
    CREATE TABLE IF NOT EXISTS elev_binds (
      kind TEXT NOT NULL, conv TEXT NOT NULL, agent TEXT NOT NULL, worker TEXT, elev INTEGER NOT NULL,
      role TEXT NOT NULL, by TEXT NOT NULL, until INTEGER, at TEXT NOT NULL, PRIMARY KEY (kind, conv, agent)
    );
    CREATE TABLE IF NOT EXISTS bot_messages (bot TEXT NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (bot, chat_id, message_id));
    CREATE TABLE IF NOT EXISTS pairing_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot TEXT NOT NULL, code TEXT NOT NULL, uid TEXT NOT NULL, chat_id TEXT NOT NULL,
      name TEXT NOT NULL, username TEXT, first_text TEXT, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_via TEXT, decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS pairing_requests_code ON pairing_requests (code);
  `)
  // Columns added after Phase 1.
  const cols = new Set((db.query('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(c => c.name))
  const setupCols = new Set((db.query('PRAGMA table_info(bot_setup)').all() as Array<{ name: string }>).map(c => c.name))
  const secCols = new Set((db.query('PRAGMA table_info(conv_secrets)').all() as Array<{ name: string }>).map(c => c.name))
  for (const n of ['header', 'scheme', 'label', 'source', 'query', 'default_headers']) if (!secCols.has(n)) db.exec(`ALTER TABLE conv_secrets ADD COLUMN ${n} TEXT`)
  const delCols = new Set((db.query('PRAGMA table_info(secret_deletions)').all() as Array<{ name: string }>).map(c => c.name))
  if (!delCols.has('kind')) db.exec("ALTER TABLE secret_deletions ADD COLUMN kind TEXT NOT NULL DEFAULT 'detect'")
  if (!setupCols.has('elevlog_topic')) db.exec('ALTER TABLE bot_setup ADD COLUMN elevlog_topic INTEGER')
  if (!setupCols.has('authuse_topic')) db.exec('ALTER TABLE bot_setup ADD COLUMN authuse_topic INTEGER')
  if (!setupCols.has('secret_topic')) db.exec('ALTER TABLE bot_setup ADD COLUMN secret_topic INTEGER')
  if (!setupCols.has('pairing_topic')) db.exec('ALTER TABLE bot_setup ADD COLUMN pairing_topic INTEGER')
  // which Telegram bot the setup belongs to (setup.ts adoptBotSetup): a name reused for another bot starts over
  if (!setupCols.has('bot_id')) db.exec('ALTER TABLE bot_setup ADD COLUMN bot_id TEXT')
  // custom-source packages an approval lets through once (pkgreview.ts): no override, used up by one install
  const pkgReqCols = new Set((db.query('PRAGMA table_info(pkg_requests)').all() as Array<{ name: string }>).map(c => c.name))
  if (!pkgReqCols.has('once_items')) { db.exec('ALTER TABLE pkg_requests ADD COLUMN once_items TEXT'); db.exec('ALTER TABLE pkg_requests ADD COLUMN once_used_at TEXT') }
  // a delivery's random tag (meta delivery): a prompt's <channel> tag names the delivery it came from (router/elevation.ts)
  const queueCols = new Set((db.query('PRAGMA table_info(queue)').all() as Array<{ name: string }>).map(c => c.name))
  if (!queueCols.has('tag')) db.exec('ALTER TABLE queue ADD COLUMN tag TEXT')
  // when a prompt's tag named the delivery: a copy of the tag in a later prompt is not believed
  if (!queueCols.has('prompted_at')) db.exec('ALTER TABLE queue ADD COLUMN prompted_at TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS queue_tag ON queue (tag)')
  const cacheCols = new Set((db.query('PRAGMA table_info(attachment_cache)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cacheCols.has('last_used')) db.exec('ALTER TABLE attachment_cache ADD COLUMN last_used TEXT')
  const evCols = new Set((db.query('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(c => c.name))
  if (!evCols.has('masked')) db.exec('ALTER TABLE events ADD COLUMN masked INTEGER NOT NULL DEFAULT 0')
  const useCols = new Set((db.query('PRAGMA table_info(auth_uses)').all() as Array<{ name: string }>).map(c => c.name))
  for (const [n, t] of [['bot', 'TEXT'], ['chat_id', 'TEXT'], ['message_id', 'INTEGER']]) if (!useCols.has(n!)) db.exec(`ALTER TABLE auth_uses ADD COLUMN ${n} ${t}`)
  for (const [name, type] of [['title', 'TEXT'], ['compact', 'INTEGER'], ['model', 'TEXT'], ['ctx_v', 'INTEGER NOT NULL DEFAULT 1'], ['last_seen', 'TEXT'], ['rotate_pending', 'INTEGER NOT NULL DEFAULT 0'], ['react', 'TEXT'], ['worker_flags', 'TEXT']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${type}`)
  }

  const now = () => new Date().toISOString()
  const json = (v: unknown) => {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  const qEvent = db.prepare('INSERT INTO events (ts, bot, update_json) VALUES (?, ?, ?)')
  const qApi = db.prepare('INSERT INTO outbound (ts, bot, conv, method, payload_json, result_json, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const qRecentOut = db.prepare('SELECT ts, method, payload_json, error FROM outbound WHERE conv = ? ORDER BY id DESC LIMIT ?')
  const qBotMsg = db.prepare('INSERT OR IGNORE INTO bot_messages (bot, chat_id, message_id, ts) VALUES (?, ?, ?, ?)')
  const qIsBotMsg = db.prepare('SELECT 1 FROM bot_messages WHERE bot = ? AND chat_id = ? AND message_id = ?')
  const qGet = db.prepare('SELECT * FROM conversations WHERE key = ?')
  const qAll = db.prepare('SELECT * FROM conversations ORDER BY key')
  const qFind = db.prepare('SELECT * FROM conversations WHERE bot = ? AND chat_id = ?')
  const qIns = db.prepare('INSERT INTO conversations (key, bot, chat_id, type, folder, role, session_id, created_at, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const qSess = db.prepare('UPDATE conversations SET session_id = ? WHERE key = ?')
  const qEnq = db.prepare('INSERT INTO queue (conv, created_at, params) VALUES (?, ?, ?)')
  const qDel = db.prepare("UPDATE queue SET status = 'delivered', delivered_at = ? WHERE qid = ? AND status = 'pending'")
  const qAck = db.prepare("UPDATE queue SET status = 'acked', acked_at = ? WHERE qid = ?")
  const qUnd = db.prepare("SELECT qid, conv, params, status FROM queue WHERE conv = ? AND status != 'acked' ORDER BY qid")
  const qTagGet = db.prepare('SELECT tag FROM queue WHERE qid = ?')
  const qTagSet = db.prepare('UPDATE queue SET tag = ? WHERE qid = ? AND tag IS NULL')
  const qByTag = db.prepare('SELECT qid, params, delivered_at, prompted_at FROM queue WHERE conv = ? AND tag = ?')
  const qPrompted = db.prepare('UPDATE queue SET prompted_at = ? WHERE conv = ? AND tag = ? AND prompted_at IS NULL')
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
  const qToolAdd = db.prepare('INSERT INTO tool_history (ts, conv, conv_role, eff_role, tool, decision, reason, target, subagent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const qToolStats = db.prepare('SELECT tool, conv_role, eff_role IS NOT NULL AS elevated, decision, COUNT(*) AS n FROM tool_history WHERE ts >= ? GROUP BY tool, conv_role, elevated, decision')
  const qToolPurge = db.prepare('DELETE FROM tool_history WHERE ts < ?')
  const qOwnAdd = db.prepare('INSERT OR REPLACE INTO own_agents (conv, worker, name, at) VALUES (?, ?, ?, ?)')
  const qOwnTrim = db.prepare('DELETE FROM own_agents WHERE conv = ?1 AND worker = ?2 AND rowid NOT IN (SELECT rowid FROM own_agents WHERE conv = ?1 AND worker = ?2 ORDER BY rowid DESC LIMIT ?3)')
  const qOwnHas = db.prepare('SELECT 1 FROM own_agents WHERE conv = ? AND worker = ? AND name = ?')
  const qOwnAny = db.prepare('SELECT 1 FROM own_agents WHERE conv = ? AND name = ? LIMIT 1')
  const qOwnList = db.prepare('SELECT name FROM own_agents WHERE conv = ? AND worker = ? ORDER BY rowid')
  const qOwnDrop = db.prepare('DELETE FROM own_agents WHERE conv = ? AND worker IS NOT ?')
  const qBindSet = db.prepare('INSERT OR REPLACE INTO elev_binds (kind, conv, agent, worker, elev, role, by, until, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const qBindDrop = db.prepare('DELETE FROM elev_binds WHERE kind = ? AND conv = ? AND agent = ?')
  const qBindDropOf = db.prepare('DELETE FROM elev_binds WHERE elev = ?')
  const qBindAll = db.prepare('SELECT * FROM elev_binds ORDER BY at')
  const qBindPurge = db.prepare("DELETE FROM elev_binds WHERE (kind = 'grant' AND (until IS NULL OR until <= ?)) OR (kind = 'bound' AND at < ?) OR conv NOT IN (SELECT key FROM conversations)")
  const qOwnPurge = db.prepare('DELETE FROM own_agents WHERE at < ? OR conv NOT IN (SELECT key FROM conversations)')
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
  const userRole = (uid: string) => owners.includes(uid) ? 'owner' : ((qUserGet.get(uid) as { role: string } | null)?.role ?? 'user')
  // A DM has no role of its own (docs/permissions.md 角色): every read takes its user's.
  const conv = (r: Conversation | null): Conversation | null => r && r.type === 'dm' ? { ...r, role: userRole(r.chat_id) } : r
  const convs = (rows: Conversation[]) => rows.map(r => conv(r)!)
  const get = (key: string) => conv((qGet.get(key) as Conversation | null) ?? null)
  const qDmRole = db.prepare("UPDATE conversations SET role = ?, ctx_v = ctx_v + 1 WHERE key = ? AND type = 'dm'")
  const syncDmRoles = (uid?: string) => {
    const out: Array<{ conv: Conversation; from: string }> = []
    const rows = (uid == null ? db.prepare("SELECT * FROM conversations WHERE type = 'dm' ORDER BY key").all() : db.prepare("SELECT * FROM conversations WHERE type = 'dm' AND chat_id = ? ORDER BY key").all(uid)) as Conversation[]
    for (const r of rows) {
      const role = userRole(r.chat_id)
      if (r.role === role) continue
      qDmRole.run(role, r.key)
      out.push({ conv: get(r.key)!, from: r.role })
    }
    return out
  }
  return {
    logEvent: (bot, update) => Number(qEvent.run(now(), bot, json(update)).lastInsertRowid),
    logMaskedEvent(bot, build) {
      return db.transaction(() => {
        const ts = now()
        const id = Number(db.prepare("INSERT INTO events (ts, bot, update_json, masked) VALUES (?, ?, '{}', 1)").run(ts, bot).lastInsertRowid)
        const b = build(id)
        db.prepare('UPDATE events SET update_json = ? WHERE id = ?').run(json(b.update), id)
        db.prepare('INSERT INTO event_raw (event_id, sealed, fields, created_at) VALUES (?, ?, ?, ?)').run(id, b.sealed, b.fields, ts)
        return id
      })()
    },
    getEvent: id => (db.prepare('SELECT id, ts, bot, update_json, masked FROM events WHERE id = ?').get(id) as EventRow | null) ?? null,
    eventsWithFile: (fileId, limit = 20) => db.prepare(`SELECT id, ts, bot, update_json, masked FROM events WHERE instr(update_json, ?) > 0 AND update_json NOT LIKE '{"attachment":%' ORDER BY id DESC LIMIT ?`).all(`"file_id":${JSON.stringify(fileId)}`, limit) as EventRow[],
    attachmentEvent: fileId => (db.prepare('SELECT id, ts, bot, update_json, masked FROM events WHERE substr(update_json, 1, ?) = ? ORDER BY id DESC LIMIT 1').get(`{"attachment":{"file_id":${JSON.stringify(fileId)}`.length, `{"attachment":{"file_id":${JSON.stringify(fileId)}`) as EventRow | null) ?? null,
    cacheAttachment: a => { const t = now(); db.prepare('INSERT OR REPLACE INTO attachment_cache (bot, file_id, file_unique_id, file_path, path, event_id, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(a.bot, a.file_id, a.file_unique_id, a.file_path, a.path, a.event_id, t, t) },
    touchAttachment: (bot, fileId) => { db.prepare('UPDATE attachment_cache SET last_used = ? WHERE bot = ? AND file_id = ?').run(now(), bot, fileId) },
    staleAttachments: before => db.prepare('SELECT bot, file_id, file_unique_id, file_path, path, event_id FROM attachment_cache WHERE coalesce(last_used, created_at) < ? ORDER BY coalesce(last_used, created_at)').all(before) as AttachmentCache[],
    removeAttachment: (bot, fileId) => { db.prepare('DELETE FROM attachment_cache WHERE bot = ? AND file_id = ?').run(bot, fileId) },
    cachedAttachment: (bot, fileId) => (db.prepare('SELECT bot, file_id, file_unique_id, file_path, path, event_id FROM attachment_cache WHERE bot = ? AND file_id = ?').get(bot, fileId) as AttachmentCache | null) ?? null,
    getEventRaw: id => (db.prepare('SELECT * FROM event_raw WHERE event_id = ?').get(id) as EventRaw | null) ?? null,
    addHandle(h) {
      const id = Number(db.prepare('INSERT INTO secret_handles (event_id, n, kind, last4, bot, chat_id, conv, request_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(h.event_id, h.n, h.kind, h.last4, h.bot, h.chat_id, h.conv, h.request_id, h.expires_at, now()).lastInsertRowid)
      db.prepare('UPDATE secret_handles SET code = ? WHERE id = ?').run(`h${id}`, id)
      return db.prepare('SELECT * FROM secret_handles WHERE id = ?').get(id) as SecretHandle
    },
    getHandle: code => (db.prepare('SELECT * FROM secret_handles WHERE code = ?').get(code) as SecretHandle | null) ?? null,
    listHandles: (bot, chat_id) => (bot == null
      ? db.prepare('SELECT * FROM secret_handles ORDER BY id').all()
      : db.prepare('SELECT * FROM secret_handles WHERE bot = ? AND chat_id = ? ORDER BY id').all(bot, chat_id)) as SecretHandle[],
    useHandle: (code, registered) => { db.prepare('UPDATE secret_handles SET uses = uses + 1, registered = coalesce(?, registered) WHERE code = ?').run(registered ?? null, code) },
    revokeHandle: (code, by) => db.prepare('UPDATE secret_handles SET revoked_by = ?, revoked_at = ? WHERE code = ? AND revoked_at IS NULL').run(by, now(), code).changes > 0,
    addSecretRequest: r => Number(db.prepare('INSERT INTO secret_requests (ts, conv, sender, event_id, question) VALUES (?, ?, ?, ?, ?)').run(now(), r.conv, r.sender, r.event_id, r.question).lastInsertRowid),
    settleSecretRequest: (id, status, handles, note) => { db.prepare('UPDATE secret_requests SET status = ?, handles = ?, note = ? WHERE id = ?').run(status, JSON.stringify(handles), note, id) },
    getSecretRequest: id => (db.prepare('SELECT * FROM secret_requests WHERE id = ?').get(id) as SecretRequest | null) ?? null,
    addSecretLog: (bot, kind, text, ref) => { db.prepare('INSERT INTO secret_log (ts, bot, kind, text, ref) VALUES (?, ?, ?, ?, ?)').run(now(), bot, kind, text, ref) },
    secretLog: limit => db.prepare('SELECT ts, bot, kind, text, ref FROM secret_log ORDER BY id DESC LIMIT ?').all(limit) as any,
    scheduleDeletion: d => Number(db.prepare('INSERT INTO secret_deletions (event_id, bot, chat_id, message_id, sender, notice_id, due_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.event_id, d.bot, d.chat_id, d.message_id, d.sender, d.notice_id, d.due_at, d.kind ?? 'detect').lastInsertRowid),
    getDeletion: id => (db.prepare('SELECT * FROM secret_deletions WHERE id = ?').get(id) as SecretDeletion | null) ?? null,
    dueDeletions: at => db.prepare("SELECT * FROM secret_deletions WHERE status = 'pending' AND due_at <= ? ORDER BY id").all(at) as SecretDeletion[],
    updateDeletion(id, fields) {
      const keys = Object.keys(fields).filter(k => ['notice_id', 'log_chat', 'log_msg', 'log_text'].includes(k))
      if (keys.length) db.prepare(`UPDATE secret_deletions SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => ((fields as any)[k] ?? null) as string | number | null), id)
    },
    settleDeletion: (id, status, by) => db.prepare("UPDATE secret_deletions SET status = ?, decided_by = ?, done_at = ? WHERE id = ? AND status = 'pending'").run(status, by, now(), id).changes > 0,
    logApiCall: (bot, method, payload, result, error, conv) => {
      qApi.run(now(), bot, conv, method, json(payload), result === undefined ? null : json(result), error)
    },
    recentOutbound: (conv, limit) => qRecentOut.all(conv, limit) as any,
    setReact: (key, mode) => { db.prepare('UPDATE conversations SET react = ? WHERE key = ?').run(mode, key); return get(key)! },
    noteBotMessages(bot, method, payload, result) {
      // send*, forward*, copy*, edit*: a Message, a list of them, or a MessageId (chat from the payload)
      if (!/^(send|forward|copy|edit)/.test(method)) return
      const r = (result as { ok?: boolean; result?: unknown } | undefined)
      if (!r?.ok) return
      const to = (payload as { chat_id?: unknown } | null)?.chat_id
      for (const m of (Array.isArray(r.result) ? r.result : [r.result]) as Array<{ message_id?: unknown; chat?: { id?: unknown } } | null>) {
        const chat = m?.chat?.id ?? to
        if (typeof m?.message_id === 'number' && chat != null) qBotMsg.run(bot, String(chat), m.message_id, now())
      }
    },
    isBotMessage: (bot, chat_id, message_id) => !!qIsBotMsg.get(bot, chat_id, message_id),
    getConversation: get,
    listConversations: () => convs(qAll.all() as Conversation[]),
    findConversation: (bot, chat_id) => conv((qFind.get(bot, chat_id) as Conversation | null) ?? null),
    insertConversation: c => { qIns.run(c.key, c.bot, c.chat_id, c.type, c.folder, c.type === 'dm' ? userRole(c.chat_id) : c.role, c.session_id, c.created_at, c.title ?? null) },
    setSession: (key, sid) => { qSess.run(sid, key) },
    setWorkerFlags: (key, flags) => { db.prepare('UPDATE conversations SET worker_flags = ? WHERE key = ?').run(flags ? JSON.stringify(flags) : null, key) },
    setFolder: (key, folder) => { db.prepare('UPDATE conversations SET folder = ?, ctx_v = ctx_v + 1 WHERE key = ?').run(folder, key); return get(key)! },
    updateConversation(key, fields) {
      if ('role' in fields && get(key)?.type === 'dm') throw new Error(`${key}: a DM's role is its user's role (setUserRole)`)
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
    deliveryTag: qid => {
      const had = (qTagGet.get(qid) as { tag: string | null } | null)?.tag
      if (had) return had
      qTagSet.run(randomBytes(9).toString('hex'), qid)
      return (qTagGet.get(qid) as { tag: string }).tag
    },
    deliveryByTag: (conv, tag) => (qByTag.get(conv, tag) as { qid: number; params: string; delivered_at: string | null; prompted_at: string | null } | null) ?? null,
    markPrompted: (conv, tags) => { const at = now(); for (const t of tags) qPrompted.run(at, conv, t) },
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
    listUserOverrides: uid => (db.prepare('SELECT kind, value FROM user_overrides WHERE uid = ? ORDER BY kind, value').all(uid) as Array<{ kind: OverrideKind; value: string }>).map(o => ({ conv: `user:${uid}`, ...o })),
    addUserOverride: (uid, kind, value) => db.prepare('INSERT OR IGNORE INTO user_overrides (uid, kind, value, created_at) VALUES (?, ?, ?, ?)').run(uid, kind, value, now()).changes > 0,
    removeUserOverride(uid, kinds, value) {
      let n = 0
      for (const k of kinds) n += db.prepare('DELETE FROM user_overrides WHERE uid = ? AND kind = ? AND value = ?').run(uid, k, value).changes
      return n
    },
    clearUserOverrides: uid => db.prepare('DELETE FROM user_overrides WHERE uid = ?').run(uid).changes,
    setRotate: (key, on) => { qRotSet.run(on ? 1 : 0, key) },
    rotatePending: () => convs(qRotAll.all() as Conversation[]),
    approveSkill: (dir, skill, hash, by) => { db.prepare('INSERT OR REPLACE INTO skill_approvals (dir, skill, hash, approved_by, at) VALUES (?, ?, ?, ?, ?)').run(dir, skill, hash, by, now()) },
    skillApproval: dir => (db.prepare('SELECT skill, hash, approved_by, at FROM skill_approvals WHERE dir = ?').get(dir) as any) ?? null,
    revokeSkill: dir => db.prepare('DELETE FROM skill_approvals WHERE dir = ?').run(dir).changes > 0,
    listSkillApprovals: () => db.prepare('SELECT dir, skill, hash, approved_by, at FROM skill_approvals ORDER BY skill').all() as any,
    addSkillRun: (conv, skill, action, status) => { db.prepare('INSERT INTO skill_runs (ts, conv, skill, action, status) VALUES (?, ?, ?, ?, ?)').run(now(), conv, skill, action, status) },
    skillRunsSince: (conv, since) => (db.prepare("SELECT count(*) n FROM skill_runs WHERE conv = ? AND ts > ? AND status != 'refused'").get(conv, since) as { n: number }).n,
    lastSkillRunAt: (conv, skill, status) => (db.prepare('SELECT max(ts) ts FROM skill_runs WHERE conv = ? AND skill = ? AND status = ?').get(conv, skill, status) as { ts: string | null }).ts,
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
    pendingElevations: () => db.prepare("SELECT id, conv, kind, sender, action, reason, status, decided_by, decided_role, created_at FROM elevations WHERE status = 'pending' ORDER BY id").all() as Elevation[],
    decideElevation: (id, status, by, role) => db.prepare("UPDATE elevations SET status = ?, decided_by = ?, decided_role = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, by, role, now(), id).changes > 0,
    addElevLog: (conv, kind, text, ref) => { db.prepare('INSERT INTO elev_log (ts, conv, kind, text, ref) VALUES (?, ?, ?, ?, ?)').run(now(), conv, kind, text, ref) },
    elevLog: (conv, limit) => (conv
      ? db.prepare('SELECT ts, conv, kind, text, ref FROM elev_log WHERE conv = ? ORDER BY id DESC LIMIT ?').all(conv, limit)
      : db.prepare('SELECT ts, conv, kind, text, ref FROM elev_log ORDER BY id DESC LIMIT ?').all(limit)) as any,
    bumpContext: bot => { db.prepare('UPDATE conversations SET ctx_v = ctx_v + 1 WHERE bot = ?').run(bot) },
    getBotSetup: bot => (db.prepare('SELECT bot, bot_id, persona_done, persona, approvals_chat, approvals_topic, notices_topic, elevlog_topic, authuse_topic, secret_topic, pairing_topic, group_skipped FROM bot_setup WHERE bot = ?').get(bot) as BotSetup | null) ?? null,
    updateBotSetup(bot, fields) {
      db.prepare('INSERT OR IGNORE INTO bot_setup (bot, updated_at) VALUES (?, ?)').run(bot, now())
      const keys = Object.keys(fields).filter(k => ['bot_id', 'persona_done', 'persona', 'approvals_chat', 'approvals_topic', 'notices_topic', 'elevlog_topic', 'authuse_topic', 'secret_topic', 'pairing_topic', 'group_skipped'].includes(k))
      if (keys.length) db.prepare(`UPDATE bot_setup SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE bot = ?`).run(...keys.map(k => ((fields as any)[k] ?? null) as string | number | null), now(), bot)
      return db.prepare('SELECT bot, bot_id, persona_done, persona, approvals_chat, approvals_topic, notices_topic, elevlog_topic, authuse_topic, secret_topic, pairing_topic, group_skipped FROM bot_setup WHERE bot = ?').get(bot) as BotSetup
    },
    addApprovalMsg: m => { db.prepare('INSERT INTO approval_msgs (kind, ref, bot, chat_id, message_id, text) VALUES (?, ?, ?, ?, ?, ?)').run(m.kind, m.ref, m.bot, m.chat_id, m.message_id, m.text) },
    approvalMsgs: (kind, ref) => db.prepare('SELECT * FROM approval_msgs WHERE kind = ? AND ref = ?').all(kind, ref) as ApprovalMsg[],
    addPairingRequest: r => Number(db.prepare('INSERT INTO pairing_requests (bot, code, uid, chat_id, name, username, first_text, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.bot, r.code, r.uid, r.chat_id, r.name, r.username, r.first_text, now(), r.expires_at).lastInsertRowid),
    getPairingRequest: id => (db.prepare('SELECT * FROM pairing_requests WHERE id = ?').get(id) as PairingRequest | null) ?? null,
    pairingRequestByCode: code => (db.prepare('SELECT * FROM pairing_requests WHERE code = ? ORDER BY id DESC LIMIT 1').get(code) as PairingRequest | null) ?? null,
    settlePairingRequest: (id, status, by, via) => db.prepare("UPDATE pairing_requests SET status = ?, decided_by = ?, decided_via = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, by, via, now(), id).changes > 0,
    expiredPairingRequests: t => db.prepare("SELECT * FROM pairing_requests WHERE status = 'pending' AND expires_at < ? ORDER BY id").all(t) as PairingRequest[],
    getPkgVerdict: (eco, name) => (db.prepare('SELECT * FROM pkg_verdicts WHERE eco = ? AND name = ?').get(eco, name) as PkgVerdict | null) ?? null,
    setPkgVerdict: v => { db.prepare('INSERT OR REPLACE INTO pkg_verdicts (eco, name, risk, reason, at) VALUES (?, ?, ?, ?, ?)').run(v.eco, v.name, v.risk, v.reason, now()) },
    addPkgRequest: r => Number(db.prepare('INSERT INTO pkg_requests (conv, pkgs, reason, created_at) VALUES (?, ?, ?, ?)').run(r.conv, r.pkgs, r.reason, now()).lastInsertRowid),
    getPkgRequest: id => (db.prepare('SELECT id, conv, pkgs, reason, status, created_at, decided_by FROM pkg_requests WHERE id = ?').get(id) as PkgRequest | null) ?? null,
    decidePkgRequest: (id, status, by) => db.prepare("UPDATE pkg_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, by, now(), id).changes > 0,
    grantPkgOnce: (id, items) => { db.prepare('UPDATE pkg_requests SET once_items = ? WHERE id = ?').run(JSON.stringify(items), id) },
    takePkgOnce(conv, items) {
      const rows = db.prepare("SELECT id, once_items FROM pkg_requests WHERE conv = ? AND status = 'approved' AND once_items IS NOT NULL AND once_used_at IS NULL ORDER BY id").all(conv) as Array<{ id: number; once_items: string }>
      const hit = rows.find(r => { const have = new Set(JSON.parse(r.once_items) as string[]); return items.every(i => have.has(i)) })
      if (!hit) return null
      return db.prepare('UPDATE pkg_requests SET once_used_at = ? WHERE id = ? AND once_used_at IS NULL').run(now(), hit.id).changes > 0 ? hit.id : null
    },
    getUserRole: uid => ((qUserGet.get(uid) as { role: string } | null)?.role) ?? null,
    setUserRole: (uid, role) => {
      if (role) qUserSet.run(uid, role, now()); else qUserDel.run(uid)
      return syncDmRoles(uid).map(x => x.conv)
    },
    userRole,
    syncDmRoles: () => syncDmRoles(),
    listUsers: () => qUsers.all() as Array<{ uid: string; role: string }>,
    addLog: (conv, text) => { qLogAdd.run(conv, now(), text) },
    bindLogs(conv, qid) {
      qLogBind.run(qid, conv)
      return qLogFor.all(conv, qid) as LogRow[]
    },
    trackProgress: (key, chat_id, id) => { qPAdd.run(key, chat_id, id) },
    untrackProgress: (key, id) => { qPDel.run(key, id) },
    orphanProgress: () => qPAll.all() as Array<{ key: string; chat_id: string; message_id: number }>,
    maskEventsOnce(name, mask) {
      if (db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name)) return null
      let changed = 0
      const upd = db.prepare('UPDATE events SET update_json = ? WHERE id = ?')
      db.transaction(() => {
        for (const r of db.prepare("SELECT id, update_json FROM events WHERE update_json LIKE '%/secret%' OR update_json LIKE '%/router%'").all() as Array<{ id: number; update_json: string }>) {
          let v: unknown
          try { v = JSON.parse(r.update_json) } catch { continue }
          const out = JSON.stringify(mask(v))
          if (out !== r.update_json) { upd.run(out, r.id); changed++ }
        }
        db.prepare('INSERT INTO migrations (name, at, changed) VALUES (?, ?, ?)').run(name, now(), changed)
      })()
      return changed
    },
    setConvSecret: s => {
      db.prepare('INSERT OR REPLACE INTO conv_secrets (bot, chat_id, name, kind, value, base_url, allowed, header, scheme, query, label, added_by, created_at, source, default_headers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(s.bot, s.chat_id, s.name, s.kind, s.value, s.base_url, s.allowed, s.header ?? null, s.scheme ?? null, s.query ?? null, s.label ?? null, s.added_by, s.created_at, s.source ?? null, s.default_headers ?? null)
    },
    getConvSecret: (bot, chat_id, name) => (db.prepare('SELECT * FROM conv_secrets WHERE bot = ? AND chat_id = ? AND name = ?').get(bot, chat_id, name) as ConvSecret | null) ?? null,
    listConvSecrets: (bot, chat_id) => db.prepare('SELECT * FROM conv_secrets WHERE bot = ? AND chat_id = ? ORDER BY name').all(bot, chat_id) as ConvSecret[],
    allConvSecrets: () => db.prepare('SELECT * FROM conv_secrets ORDER BY bot, chat_id, name').all() as ConvSecret[],
    convSecretChats: () => db.prepare('SELECT bot, chat_id, count(*) n FROM conv_secrets GROUP BY bot, chat_id ORDER BY bot, chat_id').all() as any,
    removeConvSecret: (bot, chat_id, name) => name == null
      ? db.prepare('DELETE FROM conv_secrets WHERE bot = ? AND chat_id = ?').run(bot, chat_id).changes
      : db.prepare('DELETE FROM conv_secrets WHERE bot = ? AND chat_id = ? AND name = ?').run(bot, chat_id, name).changes,
    addToolUse: u => { qToolAdd.run(u.ts ?? now(), u.conv, u.conv_role, u.eff_role, u.tool, u.decision, u.reason, u.target, u.subagent ? 1 : 0) },
    toolStats: since => qToolStats.all(since) as ToolStat[],
    purgeToolHistory: before => qToolPurge.run(before).changes,
    // INSERT OR REPLACE gives a re-added name a new rowid: the newest are kept
    addOwnAgent: (conv, worker, name, max) => { qOwnAdd.run(conv, worker, name, now()); qOwnTrim.run(conv, worker, max) },
    isOwnAgent: (conv, worker, name) => !!qOwnHas.get(conv, worker, name),
    hasOwnAgent: (conv, name) => !!qOwnAny.get(conv, name),
    ownAgents: (conv, worker) => (qOwnList.all(conv, worker) as Array<{ name: string }>).map(r => r.name),
    dropOwnAgents: (conv, keep) => qOwnDrop.run(conv, keep).changes,
    purgeOwnAgents: before => qOwnPurge.run(before).changes,
    setElevBind: b => { qBindSet.run(b.kind, b.conv, b.agent, b.worker, b.elev, b.role, b.by, b.until, now()) },
    dropElevBind: (kind, conv, agent) => { qBindDrop.run(kind, conv, agent) },
    dropElevBindsOf: elev => qBindDropOf.run(elev).changes,
    elevBinds: () => qBindAll.all() as ElevBind[],
    purgeElevBinds: (nowMs, before) => qBindPurge.run(nowMs, before).changes,
    close: () => db.close(),
  }
}
