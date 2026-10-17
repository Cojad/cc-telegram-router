// The only module that touches SQLite. Every other module reaches the
// database exclusively through record()/lookup()/recent() — nobody else
// prepares a statement or sees a raw row. Uses bun:sqlite (built into Bun,
// no dependency to add).
//
// Two things this fixes that plan.html called out as gaps:
//   - inbound.ts records every message it sees, including ones gate()
//     drops (delivered: false) — previously a dropped message left no
//     trace anywhere, not even in a debug log.
//   - lookup() gives inbound.ts a fallback for reply_to_text when
//     Telegram doesn't inline the replied-to message (old messages) —
//     not wired up yet (plan.html phase 4), this module just makes it
//     possible.
//
// Every row belongs to one bot (柯姊 2026-10-17): two bots number their
// messages separately in the same private chat (a person DMs both), and a
// group's message ids are shared by every bot in it, so (chat_id,
// message_id) alone made one bot's message look like a duplicate of the
// other's (dropped without a trace) and let lookup_message or a reply's
// quoted text cross bots. Rows are keyed (bot, chat_id, message_id); each
// bot reads and writes only its own through forBot(bot). Rows from before
// the bot column were assigned once (backfillBots): a chat only one bot has
// a conversation in goes to that bot; otherwise the bot seen in events (in)
// or outbound (out) for that message; what stays unclear is marked legacy
// and given to the original bot (the first configured), the only one that
// existed before a second bot was added.

import { Database } from 'bun:sqlite'

export type Direction = 'in' | 'out'

export interface MessageRecord {
  chat_id: string
  message_id: string
  direction: Direction
  ts: string
  user_id?: string
  content?: string
  reply_to_message_id?: string
  attachment_kind?: string
  attachment_file_id?: string
  /** Whether gate() actually delivered this to Claude. Always true for direction 'out'. */
  delivered: boolean
  /** True if this message's content came from a Bot API 10.x Rich Message
   *  (rich_message.blocks) rather than a plain text/caption field — see
   *  rich.ts. Content itself is already flattened into `content` above;
   *  this is only a marker so a reader (or lookup_message's caller) knows
   *  the original was structured, not written as plain text. Cojad,
   *  2026-09-16. */
  rich_message?: boolean
}

// What SQLite hands back from a row — integers for the boolean, undefined
// fields as null. Kept private; toRecord() below is the only place this
// shape is seen.
interface MessageRow {
  chat_id: string
  message_id: string
  direction: string
  ts: string
  user_id: string | null
  content: string | null
  reply_to_message_id: string | null
  attachment_kind: string | null
  attachment_file_id: string | null
  delivered: number
  rich_message: number | null
}

function toRecord(row: MessageRow): MessageRecord {
  return {
    chat_id: row.chat_id,
    message_id: row.message_id,
    direction: row.direction as Direction,
    ts: row.ts,
    user_id: row.user_id ?? undefined,
    content: row.content ?? undefined,
    reply_to_message_id: row.reply_to_message_id ?? undefined,
    attachment_kind: row.attachment_kind ?? undefined,
    attachment_file_id: row.attachment_file_id ?? undefined,
    delivered: row.delivered === 1,
    rich_message: row.rich_message === 1,
  }
}

/** One bot's messages (MessageStore.forBot). */
export interface Store {
  /** Insert or, for the same (bot, chat_id, message_id), replace. */
  record(r: MessageRecord): void
  /** O(1) — backed by a UNIQUE index on (bot, chat_id, message_id). */
  lookup(chat_id: string, message_id: string): MessageRecord | null
  /** Most recent first. `beforeId`, when given, pages older than that message_id. */
  recent(chat_id: string, limit: number, beforeId?: string): MessageRecord[]
  /** Closes the whole database (MessageStore.close). */
  close(): void
}

export interface MessageStore {
  forBot(bot: string): Store
  close(): void
}

/** Rows without a bot (from before the column): assign each once, see the header.
 *  Returns how many went to each way. */
export function backfillBots(db: Database, legacyBot: string | undefined): { conversation: number; evidence: number; legacy: number } {
  const has = (t: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
  const out = { conversation: 0, evidence: 0, legacy: 0 }
  db.transaction(() => {
    if (has('conversations')) {
      out.conversation = db.prepare(`UPDATE messages SET bot = (SELECT min(c.bot) FROM conversations c WHERE c.chat_id = messages.chat_id)
        WHERE bot IS NULL AND (SELECT count(DISTINCT c.bot) FROM conversations c WHERE c.chat_id = messages.chat_id) = 1`).run().changes
    }
    const ev = has('events') ? `SELECT DISTINCT e.bot FROM events e WHERE m.direction = 'in'
        AND CAST(json_extract(e.update_json, '$.message.chat.id') AS TEXT) = m.chat_id AND CAST(json_extract(e.update_json, '$.message.message_id') AS TEXT) = m.message_id` : null
    const ob = has('outbound') ? `SELECT DISTINCT o.bot FROM outbound o WHERE m.direction = 'out'
        AND CAST(json_extract(o.payload_json, '$.chat_id') AS TEXT) = m.chat_id AND CAST(json_extract(o.result_json, '$.result.message_id') AS TEXT) = m.message_id` : null
    const seen = [ev, ob].filter(Boolean).join(' UNION ')
    if (seen) {
      out.evidence = db.prepare(`UPDATE messages AS m SET bot = (SELECT min(bot) FROM (${seen}))
        WHERE m.bot IS NULL AND (SELECT count(*) FROM (${seen})) = 1`).run().changes
    }
    out.legacy = db.prepare('UPDATE messages SET bot = ?, legacy = 1 WHERE bot IS NULL').run(legacyBot ?? null).changes
  })()
  return out
}

/** legacyBot: the original bot, which gets the rows backfillBots cannot place (the first configured bot). */
export function openStore(dbPath: string, opts: { legacyBot?: string; log?: (msg: string) => void } = {}): MessageStore {
  const db = new Database(dbPath, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      ts TEXT NOT NULL,
      user_id TEXT,
      content TEXT,
      reply_to_message_id TEXT,
      attachment_kind TEXT,
      attachment_file_id TEXT,
      delivered INTEGER NOT NULL DEFAULT 1
    )
  `)
  // Migration for databases created before the `rich_message` column
  // existed — SQLite has no "ADD COLUMN IF NOT EXISTS", so this just
  // tries and swallows the "duplicate column" error on every boot after
  // the first.
  try {
    db.exec('ALTER TABLE messages ADD COLUMN rich_message INTEGER')
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err
  }
  // Migration dropping `raw`/`mtproto` — both existed only to serve
  // mtproto.ts (removed 2026-09-16: Bot-to-Bot Communication Mode made its
  // original purpose redundant, and it couldn't decode Bot API 10.x Rich
  // Messages at all, so its dedup-losing empty arrivals were actively
  // masking the Bot API side's correctly-flattened content). DROP COLUMN
  // needs SQLite 3.35+ (Bun's bundled version is well past that); the
  // catch below silently no-ops on a DB already migrated or created fresh
  // after this removal, mirroring the ADD COLUMN pattern above.
  for (const ddl of ['ALTER TABLE messages DROP COLUMN raw', 'ALTER TABLE messages DROP COLUMN mtproto']) {
    try {
      db.exec(ddl)
    } catch (err) {
      if (!(err instanceof Error) || !/no such column/i.test(err.message)) throw err
    }
  }
  // Rows belong to a bot (see the header): add the column, place the old rows once, key by (bot, chat_id, message_id).
  const cols = new Set((db.query('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(c => c.name))
  if (!cols.has('bot')) {
    db.exec('ALTER TABLE messages ADD COLUMN bot TEXT')
    db.exec('ALTER TABLE messages ADD COLUMN legacy INTEGER')
    const r = backfillBots(db, opts.legacyBot)
    if (r.conversation + r.evidence + r.legacy) opts.log?.(`messages: bot filled in for old rows: ${r.conversation} by conversation, ${r.evidence} by events/outbound, ${r.legacy} legacy (${opts.legacyBot ?? 'no bot'})`)
  }
  db.exec('DROP INDEX IF EXISTS idx_messages_chat_msg')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_bot_chat_msg ON messages(bot, chat_id, message_id)')

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO messages
      (bot, chat_id, message_id, direction, ts, user_id, content, reply_to_message_id, attachment_kind, attachment_file_id, delivered, rich_message)
    VALUES
      ($bot, $chat_id, $message_id, $direction, $ts, $user_id, $content, $reply_to_message_id, $attachment_kind, $attachment_file_id, $delivered, $rich_message)
  `)
  const lookupStmt = db.prepare('SELECT * FROM messages WHERE bot = $bot AND chat_id = $chat_id AND message_id = $message_id')
  const recentStmt = db.prepare('SELECT * FROM messages WHERE bot = $bot AND chat_id = $chat_id ORDER BY id DESC LIMIT $limit')
  const recentBeforeStmt = db.prepare(`
    SELECT * FROM messages
    WHERE bot = $bot AND chat_id = $chat_id
      AND id < COALESCE((SELECT id FROM messages WHERE bot = $bot AND chat_id = $chat_id AND message_id = $before_id), 9223372036854775807)
    ORDER BY id DESC LIMIT $limit
  `)

  const forBot = (bot: string): Store => ({
    record(r) {
      insertStmt.run({
        $bot: bot,
        $chat_id: r.chat_id,
        $message_id: r.message_id,
        $direction: r.direction,
        $ts: r.ts,
        $user_id: r.user_id ?? null,
        $content: r.content ?? null,
        $reply_to_message_id: r.reply_to_message_id ?? null,
        $attachment_kind: r.attachment_kind ?? null,
        $attachment_file_id: r.attachment_file_id ?? null,
        $delivered: r.delivered ? 1 : 0,
        $rich_message: r.rich_message ? 1 : null,
      })
    },
    lookup(chat_id, message_id) {
      const row = lookupStmt.get({ $bot: bot, $chat_id: chat_id, $message_id: message_id }) as MessageRow | null
      return row ? toRecord(row) : null
    },
    recent(chat_id, limit, beforeId) {
      const rows = (beforeId
        ? recentBeforeStmt.all({ $bot: bot, $chat_id: chat_id, $before_id: beforeId, $limit: limit })
        : recentStmt.all({ $bot: bot, $chat_id: chat_id, $limit: limit })) as MessageRow[]
      return rows.map(toRecord)
    },
    close() {
      db.close()
    },
  })
  return { forBot, close: () => db.close() }
}
