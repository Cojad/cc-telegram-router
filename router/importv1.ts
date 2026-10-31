// One-time import of the v1 plugin's message log (plan 10 Phase 4: 匯入
// messages.db; docs/operations.md 「從 v1 升級」). Same table shape as
// router/telegram/store.ts; the rows belong to one bot (v1 ran a single bot:
// the first configured one by default, or --bot <名稱>); rows already present
// for that bot (same chat and message id, the key of router.db's unique
// index; a message id is unique within a chat whichever way it went) are
// skipped, so running it twice is harmless.
//
// The imported rows go before every row router.db already has: they take ids
// below the smallest one (down into negative ids, which SQLite allows), in
// v1's order. lookup_message's recent list and /router log order by id, so a
// v1 log imported after the router has been running still reads as older
// than what the router recorded, not as the newest messages.
//
// v1's file is read from a copy (with its -wal, where the newest rows may
// still be) in a temporary folder that is removed afterwards: opening the
// file itself, even read-only, would leave -wal and -shm files next to it,
// and reading only the main file would miss what the -wal holds.
// upgrade-v1.sh's dry run reads its counts the same way (openCopy). Opens
// the router db while the router runs (WAL).
//
//   cctr [--config x] import-v1 <messages.db> [--bot <名稱>]

import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const COLS = ['chat_id', 'message_id', 'direction', 'ts', 'user_id', 'content', 'reply_to_message_id', 'attachment_kind', 'attachment_file_id', 'delivered', 'rich_message'] as const

/** A SQLite file (with its -wal) opened from a copy in a temporary folder; nothing is written next to it.
 *  close() closes it and removes the folder. */
export function openCopy(path: string): { db: Database; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'cctr-v1-'))
  try {
    copyFileSync(path, join(dir, 'v1.db'))
    if (existsSync(path + '-wal')) copyFileSync(path + '-wal', join(dir, 'v1.db-wal'))
    const db = new Database(join(dir, 'v1.db'))
    return { db, close() { db.close(); rmSync(dir, { recursive: true, force: true }) } }
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e }
}

export function importV1Messages(routerDb: string, v1Db: string, bot: string): { imported: number; skipped: number } {
  const copy = openCopy(v1Db), src = copy.db
  const dst = new Database(routerDb)
  dst.exec('PRAGMA busy_timeout = 5000')
  try {
    const have = new Set((src.query("SELECT name FROM pragma_table_info('messages')").all() as Array<{ name: string }>).map(r => r.name))
    const cols = COLS.filter(c => have.has(c))
    const exists = dst.prepare('SELECT 1 FROM messages WHERE bot = ? AND chat_id = ? AND message_id = ? LIMIT 1')
    const ins = dst.prepare(`INSERT INTO messages (id, bot, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
    let imported = 0, skipped = 0
    dst.transaction(() => {
      const fresh = (src.query(`SELECT ${cols.join(', ')} FROM messages ORDER BY id`).all() as Array<Record<string, any>>)
        .filter(row => { const dup = !!exists.get(bot, row.chat_id, row.message_id); if (dup) skipped++; return !dup })
      const low = (dst.query('SELECT min(id) AS m FROM messages').get() as { m: number | null }).m
      let id = Math.min(low ?? 1, 1) - fresh.length
      for (const row of fresh) {
        ins.run(id++, bot, ...cols.map(c => row[c] ?? null))
        imported++
      }
    })()
    return { imported, skipped }
  } finally {
    copy.close(); dst.close()
  }
}
