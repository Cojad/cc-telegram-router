// Live role matrix (plan 10 Phase 3 驗收: 每個角色能做的做得到, 不能做的被擋).
// Runs the real claude CLI with each role's rendered settings, the way a
// worker gets them, and checks what Claude Code itself lets through. Hooks
// are left out: this is the role templates alone (the router's own check is
// phase3 permcheck). Opt-in, it costs real model calls:
//   LIVE=1 bun test router/test/role-live.test.ts
// Keep in sync with templates/roles/*.json and docs/testing.md Phase 3 驗收對照.

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderSettings } from '../settings'

const LIVE = process.env.LIVE === '1'
const TEMPLATES = join(import.meta.dir, '..', '..', 'templates')
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude'
const MODEL = process.env.LIVE_MODEL ?? 'claude-opus-5-5'
let root: string

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'cctr-live-')) })
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

type Run = { text: string; denied: string[] }

async function asRole(role: string, prompt: string): Promise<Run & { folder: string }> {
  const folder = join(root, `${role}-${Math.random().toString(36).slice(2, 8)}`)
  for (const d of ['memory', 'attachments', '.chat']) mkdirSync(join(folder, d), { recursive: true })
  writeFileSync(join(folder, 'attachments', 'note.txt'), 'ATTACHMENT-OK')
  const skill = join(root, 'bot1', '.claude', 'skills', 'probe')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'run.sh'), 'echo SKILL-OK\n')
  const s = renderSettings(TEMPLATES, role, { folder, home: root, botDir: join(root, 'bot1'), autoCompactWindow: 750000, hooksDir: '/nonexistent' }) as any
  delete s.hooks
  delete s.enabledPlugins
  const settings = join(root, `${role}-${Date.now()}.json`)
  writeFileSync(settings, JSON.stringify(s))
  const p = Bun.spawn([CLAUDE, '-p', '--model', MODEL, '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json'], {
    cwd: folder, stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'pipe',
  })
  const out = await new Response(p.stdout).text()
  await p.exited
  const j = JSON.parse(out)
  const r = Array.isArray(j) ? j.find((x: any) => x.type === 'result') : j
  return { folder, text: String(r?.result ?? ''), denied: (r?.permission_denials ?? []).map((d: any) => String(d.tool_name)) }
}

const ONE = '只做這一件事, 失敗或被拒絕就停下, 不要嘗試其他方法. 最後一行原樣輸出指令的輸出 (失敗就輸出 FAILED).'
const bash = (cmd: string) => `用 Bash 工具執行這個指令: ${cmd}\n${ONE}`

test.skipIf(!LIVE)('owner: runs anything, outside the folder too', async () => {
  const r = await asRole('owner', bash('cat /etc/hostname && echo OWNER-OK'))
  expect(r.denied).toEqual([])
  expect(r.text).toContain('OWNER-OK')
}, 180_000)

test.skipIf(!LIVE)('power: runs python in the sandbox and writes its folder; cannot read /x, cannot write .chat', async () => {
  const [py, write, x, chat] = await Promise.all([
    asRole('power', bash(`python3 -c "print('PY', 6*7)"`)),
    asRole('power', `用 Write 工具在目前資料夾寫一個檔案 out.txt, 內容是 WRITE-OK. ${ONE}`),
    // the sandbox shows /x as an empty folder: read something real under it
    asRole('power', bash('ls /x/cc/.router')),
    asRole('power', `用 Write 工具寫入 .chat/context.json, 內容是 {}. ${ONE}`),
  ])
  expect(py.text).toContain('PY 42')
  expect(existsSync(join(write.folder, 'out.txt')) && readFileSync(join(write.folder, 'out.txt'), 'utf8')).toContain('WRITE-OK')
  expect(x.text).not.toContain('router.db')
  expect(chat.denied).toContain('Write')
  expect(existsSync(join(chat.folder, '.chat', 'context.json'))).toBe(false)
}, 300_000)

test.skipIf(!LIVE)('power: scripts of a bot-wide skill are readable and runnable from the sandbox, but not writable', async () => {
  const run = join(root, 'bot1', '.claude', 'skills', 'probe', 'run.sh')
  const [ok, write] = await Promise.all([
    asRole('power', bash(`bash ${run}`)),
    asRole('power', bash(`echo HACKED > ${run} && echo WROTE`)),
  ])
  expect(ok.text).toContain('SKILL-OK')
  expect(write.text).not.toContain('WROTE')
  expect(readFileSync(run, 'utf8')).toBe('echo SKILL-OK\n')
}, 300_000)

test.skipIf(!LIVE)('user: read-only Bash works; running code and reading outside the folder are refused', async () => {
  const [ls, py, out] = await Promise.all([
    asRole('user', bash('ls attachments')),
    asRole('user', bash(`python3 -c "print('PY', 6*7)"`)),
    asRole('user', `用 Read 工具讀 /etc/hostname. ${ONE}`),
  ])
  expect(ls.text).toContain('note.txt')
  expect(py.denied).toContain('Bash')
  expect(py.text).not.toContain('PY 42')
  expect(out.denied).toContain('Read')
}, 300_000)

test.skipIf(!LIVE)('guest: can read its attachments; no Bash', async () => {
  const [att, sh] = await Promise.all([
    asRole('guest', `用 Read 工具讀 attachments/note.txt. ${ONE}`),
    asRole('guest', bash('sha256sum attachments/note.txt')),
  ])
  expect(att.text).toContain('ATTACHMENT-OK')
  // in dontAsk mode guest has no Bash tool at all, so nothing shows up as denied: check the output instead
  const sum = new Bun.CryptoHasher('sha256').update('ATTACHMENT-OK').digest('hex')
  expect(sh.text).not.toContain(sum.slice(0, 16))
}, 300_000)

// Why install_skill copies from <folder>/skills: Claude Code itself refuses a
// worker below owner any write under .claude (dontAsk denies it; no allow rule
// or hook lifts that), while skills/ in its folder is writable.
test.skipIf(!LIVE)('skills: admin, power and user cannot write .claude/skills in their folder, but can write skills/', async () => {
  const roles = ['admin', 'power', 'user']
  const dot = await Promise.all(roles.map(r => asRole(r, `用 Write 工具寫入 .claude/skills/probe/SKILL.md, 內容是 PROBE. ${ONE}`)))
  const src = await Promise.all(roles.map(r => asRole(r, `用 Write 工具寫入 skills/probe/SKILL.md, 內容是 PROBE. ${ONE}`)))
  for (const r of dot) {
    expect(r.denied).toContain('Write')
    expect(existsSync(join(r.folder, '.claude', 'skills', 'probe', 'SKILL.md'))).toBe(false)
  }
  for (const r of src) expect(readFileSync(join(r.folder, 'skills', 'probe', 'SKILL.md'), 'utf8')).toContain('PROBE')
}, 300_000)
