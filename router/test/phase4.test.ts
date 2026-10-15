// Phase 4 (plan 10 Phase 4 搬遷與收尾): importing the v1 message log.
// Keep in sync with README Phase 4 驗收對照.

import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { openStore } from '../telegram/store'

test('import-v1: copies the v1 messages into router.db, skips ones already there, and is safe to run twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctr4-'))
  try {
    const v1 = join(dir, 'messages.db'), routerDb = join(dir, 'router.db')
    openStore(v1).close()
    const s = new Database(v1)
    const ins = s.prepare('INSERT INTO messages (chat_id, message_id, direction, ts, user_id, content, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('137438526', '1', 'in', '2026-09-15T01:18:17.000Z', '137438526', 'v1 hello', 1)
    ins.run('137438526', '2', 'out', '2026-09-15T01:18:20.000Z', null, 'v1 reply', 1)
    ins.run('-100555', '9', 'in', '2026-09-16T00:00:00.000Z', '42', 'dropped', 0)
    s.close()
    const store = openStore(routerDb)
    store.close()
    const r = new Database(routerDb)
    r.prepare('INSERT INTO messages (chat_id, message_id, direction, ts, content, delivered) VALUES (?, ?, ?, ?, ?, ?)').run('137438526', '2', 'out', '2026-09-15T01:18:20.000Z', 'already here', 1)
    r.close()
    // through the real entry point, like the deploy step does
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ bots: [{ name: 'cc', token: '1:x' }], home: dir, stateDir: dir, owners: ['137438526'] }))
    const run = async () => {
      const p = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(dir, 'config.json'), 'import-v1', v1], { stdout: 'pipe', stderr: 'pipe' })
      const out = await new Response(p.stdout).text()
      expect(await p.exited).toBe(0)
      return out.trim()
    }
    expect(await run()).toBe('匯入 2 則, 略過已存在的 1 則')
    expect(await run()).toBe('匯入 0 則, 略過已存在的 3 則')
    const db = new Database(routerDb, { readonly: true })
    const rows = db.query('SELECT chat_id, message_id, direction, content, delivered FROM messages ORDER BY ts, id').all()
    db.close()
    expect(rows).toEqual([
      { chat_id: '137438526', message_id: '1', direction: 'in', content: 'v1 hello', delivered: 1 },
      { chat_id: '137438526', message_id: '2', direction: 'out', content: 'already here', delivered: 1 },
      { chat_id: '-100555', message_id: '9', direction: 'in', content: 'dropped', delivered: 0 },
    ])
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30000)
