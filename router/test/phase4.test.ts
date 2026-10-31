// Phase 4 (plan 10 Phase 4 搬遷與收尾): importing the v1 message log, and its
// order and file handling (docs/operations.md 「從 v1 升級」).
// Keep in sync with docs/testing.md Phase 4 驗收對照.

import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { openStore } from '../telegram/store'
import { importV1Messages } from '../importv1'

test('import-v1: copies the v1 messages into router.db, skips ones already there, and is safe to run twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctr4-'))
  let keep: Database | null = null
  try {
    const v1 = join(dir, 'messages.db'), routerDb = join(dir, 'router.db')
    openStore(v1).close()
    // held open through the import: s.close() is then not the last connection, nothing checkpoints,
    // and the rows stay in v1's -wal (as with a v1 plugin still running, or one that never checkpointed)
    keep = new Database(v1)
    const s = new Database(v1)
    const ins = s.prepare('INSERT INTO messages (chat_id, message_id, direction, ts, user_id, content, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('137438526', '1', 'in', '2026-09-15T01:18:17.000Z', '137438526', 'v1 hello', 1)
    ins.run('137438526', '2', 'out', '2026-09-15T01:18:20.000Z', null, 'v1 reply', 1)
    ins.run('-100555', '9', 'in', '2026-09-16T00:00:00.000Z', '42', 'dropped', 0)
    s.close()
    expect(statSync(v1 + '-wal').size).toBeGreaterThan(0) // the rows are still in v1's -wal: the import reads it too
    const store = openStore(routerDb)
    store.close()
    const r = new Database(routerDb)
    r.prepare('INSERT INTO messages (bot, chat_id, message_id, direction, ts, content, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)').run('cc', '137438526', '2', 'out', '2026-09-15T01:18:20.000Z', 'already here', 1)
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
    // v1 ran one bot: the rows are the first bot's (or --bot's)
    expect(db.query('SELECT DISTINCT bot FROM messages').all()).toEqual([{ bot: 'cc' }])
    db.close()
    const bad = Bun.spawn(['bun', join(import.meta.dir, '..', 'main.ts'), '--config', join(dir, 'config.json'), 'import-v1', v1, '--bot', 'nope'], { stdout: 'pipe', stderr: 'pipe' })
    expect(await bad.exited).toBe(2)
    expect(rows).toEqual([
      { chat_id: '137438526', message_id: '1', direction: 'in', content: 'v1 hello', delivered: 1 },
      { chat_id: '137438526', message_id: '2', direction: 'out', content: 'already here', delivered: 1 },
      { chat_id: '-100555', message_id: '9', direction: 'in', content: 'dropped', delivered: 0 },
    ])
  } finally { keep?.close(); rmSync(dir, { recursive: true, force: true }) }
}, 30000)

// docs/operations.md 「從 v1 升級」 (2.33.5): imported after the router has been recording, the v1 rows
// still read as the older ones; v1's file is read without leaving -wal or -shm next to it.
test('import-v1 after the router has run: the v1 rows sort before the router\'s own, paging reaches them, and v1\'s file gets no -wal or -shm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctr4-'))
  try {
    const v1 = join(dir, 'messages.db'), routerDb = join(dir, 'router.db')
    openStore(v1).close()
    const s = new Database(v1)
    const ins = s.prepare('INSERT INTO messages (chat_id, message_id, direction, ts, user_id, content, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('111111111', '1', 'in', '2026-09-15T01:00:00.000Z', '111111111', 'v1 first', 1)
    ins.run('111111111', '2', 'out', '2026-09-15T01:00:05.000Z', null, 'v1 second', 1)
    ins.run('111111111', '3', 'in', '2026-09-15T01:00:09.000Z', '111111111', 'v1 third', 1)
    ins.finalize()
    s.exec('PRAGMA wal_checkpoint(TRUNCATE)') // everything in the main file: the empty -wal and -shm can go
    s.close(true)
    for (const x of ['-wal', '-shm']) rmSync(v1 + x, { force: true })
    const store = openStore(routerDb)
    store.forBot('cc').record({ chat_id: '111111111', message_id: '50', direction: 'in', ts: '2026-10-31T01:00:00.000Z', user_id: '111111111', content: 'v2 first', delivered: true })
    store.forBot('cc').record({ chat_id: '111111111', message_id: '51', direction: 'out', ts: '2026-10-31T01:00:03.000Z', content: 'v2 second', delivered: true })
    store.close()
    expect(importV1Messages(routerDb, v1, 'cc')).toEqual({ imported: 3, skipped: 0 })
    expect(existsSync(v1 + '-wal') || existsSync(v1 + '-shm')).toBe(false)
    const again = openStore(routerDb)
    const cc = again.forBot('cc')
    const ids = (rows: Array<{ message_id: string }>) => rows.map(r => r.message_id)
    expect(ids(cc.recent('111111111', 10))).toEqual(['51', '50', '3', '2', '1'])
    expect(ids(cc.recent('111111111', 2))).toEqual(['51', '50'])
    expect(ids(cc.recent('111111111', 10, '50'))).toEqual(['3', '2', '1'])
    cc.record({ chat_id: '111111111', message_id: '52', direction: 'in', ts: '2026-10-31T01:01:00.000Z', user_id: '111111111', content: 'v2 third', delivered: true })
    expect(ids(cc.recent('111111111', 1))).toEqual(['52'])
    again.close()
    expect(importV1Messages(routerDb, v1, 'cc')).toEqual({ imported: 0, skipped: 3 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('three-tier CLAUDE.md example: FORCED / GENERAL / Default suggestions, with the permission, elevation, package and format rules', async () => {
  const md = await Bun.file(join(import.meta.dir, '..', '..', 'templates', 'CLAUDE.md.example')).text()
  const at = (h: string) => md.indexOf(h)
  expect(at('# FORCED RULES')).toBeGreaterThan(0)
  expect(at('# GENERAL RULES')).toBeGreaterThan(at('# FORCED RULES'))
  expect(at('# Default suggestions')).toBeGreaterThan(at('# GENERAL RULES'))
  const forced = md.slice(at('# FORCED RULES'), at('# GENERAL RULES'))
  for (const s of ['## 權限與提權', 'request_elevation', 'elevated="true"', 'dangerouslyDisableSandbox', '## 套件安裝', '<bootstrap>', 'reply 工具']) expect(forced).toContain(s)
  expect(md).toContain('bot<id>/CLAUDE.md') // the persona lives in the bot folder
  expect(md).toContain('/telegram:format')
  expect(md).not.toMatch(/Cojad|柯姊|\/x\/cc/) // generic: no owner-specific content
})

test('plugin skills: /telegram:doc covers the Phase 3 features, /telegram:format holds the formatting rules', async () => {
  const skill = (n: string) => Bun.file(join(import.meta.dir, '..', '..', 'plugin', 'skills', n, 'SKILL.md')).text()
  const doc = await skill('doc'), fmt = await skill('format')
  expect(doc).toStartWith('---\nname: doc\n')
  for (const s of ['## 權限不足與提權', '## 套件安裝審核', '## 跨對話傳訊', '## 審核群組與新 bot 初次設定', '/router perm', '/router setup']) expect(doc).toContain(s)
  expect(fmt).toStartWith('---\nname: format\n')
  for (const s of ['## MarkdownV2 跳脫', '_ * [ ] ( ) ~', '4096']) expect(fmt).toContain(s)
})

test('/telegram:bot-skill: the skill SOP covers scopes, who installs where, credentials instead of tokens, and cross-bot skills', async () => {
  const md = await Bun.file(join(import.meta.dir, '..', '..', 'plugin', 'skills', 'bot-skill', 'SKILL.md')).text()
  expect(md).toStartWith('---\nname: bot-skill\n')
  for (const s of ['<home>/bot<id>/.claude/skills', '<home>/.claude/skills', 'install_skill', '/router cred add', 'cred-import', 'bot_api', '## 跨 bot 技能', 'attach://', 'cli botapi', '不要叫使用者把 token 貼在對話裡', 'http_api', 'save_b64', '--http']) expect(md).toContain(s)
  const ex = await Bun.file(join(import.meta.dir, '..', '..', 'templates', 'CLAUDE.md.example')).text()
  expect(ex.slice(ex.indexOf('# FORCED RULES'), ex.indexOf('# GENERAL RULES'))).toContain('/telegram:bot-skill')
})
