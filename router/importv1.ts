// One-time import of the v1 plugin's message log (plan 10 Phase 4: 匯入
// messages.db). Same table shape as router/telegram/store.ts; rows already
// present (same chat, message id and direction) are skipped, so running it
// twice is harmless. Opens the router db while the router runs (WAL).
//
//   cc-telegram-router [--config x] import-v1 <messages.db>

import { Database } from 'bun:sqlite'

const COLS = ['chat_id', 'message_id', 'direction', 'ts', 'user_id', 'content', 'reply_to_message_id', 'attachment_kind', 'attachment_file_id', 'delivered', 'rich_message'] as const

export function importV1Messages(routerDb: string, v1Db: string): { imported: number; skipped: number } {
  const src = new Database(v1Db, { readonly: true })
  const dst = new Database(routerDb)
  dst.exec('PRAGMA busy_timeout = 5000')
  try {
    const have = new Set((src.query("SELECT name FROM pragma_table_info('messages')").all() as Array<{ name: string }>).map(r => r.name))
    const cols = COLS.filter(c => have.has(c))
    const exists = dst.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND message_id = ? AND direction = ? LIMIT 1')
    const ins = dst.prepare(`INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    let imported = 0, skipped = 0
    dst.transaction(() => {
      for (const row of src.query(`SELECT ${cols.join(', ')} FROM messages ORDER BY id`).iterate() as Iterable<Record<string, any>>) {
        if (exists.get(row.chat_id, row.message_id, row.direction)) { skipped++; continue }
        ins.run(...cols.map(c => row[c] ?? null))
        imported++
      }
    })()
    return { imported, skipped }
  } finally {
    src.close(); dst.close()
  }
}
