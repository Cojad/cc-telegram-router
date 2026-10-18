// Live role matrix (plan 10 Phase 3 驗收: 每個角色能做的做得到, 不能做的被擋).
// Runs the real claude CLI with each role's rendered settings, the way a
// worker gets them, and checks what Claude Code itself lets through. Hooks
// are left out: this is the role templates alone (the router's own check is
// phase3 permcheck), except the last test, which keeps a user conversation's
// hooks to see the high-risk tools reach PreToolUse. Opt-in, it costs real model calls:
//   LIVE=1 bun test router/test/role-live.test.ts
// Keep in sync with templates/roles/*.json and docs/testing.md Phase 3 驗收對照.

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { renderSettings, applyOverrides } from '../settings'
import { hiddenPaths } from '../config'
import { openRouterDb } from '../db'
import { ensureConversation } from '../conversations'
import { createElevation } from '../elevation'
import { createIpc } from '../ipc'
import { createToolHistory, hookUse } from '../toolhistory'
import { RISKY_TOOLS } from '../permcheck'

const LIVE = process.env.LIVE === '1'
const TEMPLATES = join(import.meta.dir, '..', '..', 'templates')
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude'
const MODEL = process.env.LIVE_MODEL ?? 'claude-opus-5-5'
// An install outside /x: root is the router home, its state dir elsewhere
// (hidden through the template's {{hidden}}, like config sandboxDenyRead).
let root: string
let state: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cctr-live-'))
  state = mkdtempSync(join(tmpdir(), 'cctr-live-state-'))
  writeFileSync(join(state, 'router.db'), 'STATE-DB')
  mkdirSync(join(root, 'bot1', 'dm-other'), { recursive: true })
  writeFileSync(join(root, 'bot1', 'dm-other', 'diary.txt'), 'OTHER-CONVERSATION')
  mkdirSync(join(root, 'bot1', 'memory'), { recursive: true })
  writeFileSync(join(root, 'bot1', 'memory', 'facts.md'), 'BOT-MEMORY-OK\n')
})
afterAll(() => { for (const d of [root, state]) if (d) rmSync(d, { recursive: true, force: true }) })

type Run = { text: string; denied: string[] }

async function asRole(role: string, prompt: string, hidden = [root, state], botDir = join(root, 'bot1')): Promise<Run & { folder: string }> {
  const folder = join(root, `${role}-${Math.random().toString(36).slice(2, 8)}`)
  for (const d of ['memory', 'attachments', '.chat']) mkdirSync(join(folder, d), { recursive: true })
  writeFileSync(join(folder, 'attachments', 'note.txt'), 'ATTACHMENT-OK')
  const skill = join(root, 'bot1', '.claude', 'skills', 'probe')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'run.sh'), 'echo SKILL-OK\n')
  const s = renderSettings(TEMPLATES, role, { folder, home: root, hidden, botDir, autoCompactWindow: 750000, hooksDir: '/nonexistent' }) as any
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

test.skipIf(!LIVE)('power: runs python in the sandbox and writes its folder; cannot read other conversations or the state dir, cannot write .chat', async () => {
  const [py, write, other, st, chat] = await Promise.all([
    asRole('power', bash(`python3 -c "print('PY', 6*7)"`)),
    asRole('power', `用 Write 工具在目前資料夾寫一個檔案 out.txt, 內容是 WRITE-OK. ${ONE}`),
    // the sandbox hides the router home (but its own folder) and the state dir
    asRole('power', bash(`cat ${join(root, 'bot1', 'dm-other', 'diary.txt')}`)),
    asRole('power', bash(`cat ${join(state, 'router.db')}`)),
    asRole('power', `用 Write 工具寫入 .chat/context.json, 內容是 {}. ${ONE}`),
  ])
  expect(py.text).toContain('PY 42')
  expect(existsSync(join(write.folder, 'out.txt')) && readFileSync(join(write.folder, 'out.txt'), 'utf8')).toContain('WRITE-OK')
  expect(other.text).not.toContain('OTHER-CONVERSATION')
  expect(st.text).not.toContain('STATE-DB')
  expect(chat.denied).toContain('Write')
  expect(existsSync(join(chat.folder, '.chat', 'context.json'))).toBe(false)
}, 300_000)

test.skipIf(!LIVE)('power: a router socket outside home and the state dir (config socket elsewhere) is hidden by the sandbox: the file itself, its folder stays readable', async () => {
  const run = mkdtempSync(join(tmpdir(), 'cctr-live-run-'))
  const sock = join(run, 'router.sock')
  writeFileSync(join(run, 'neighbour.txt'), 'NEIGHBOUR-OK')
  const srv = Bun.listen({ unix: sock, socket: { open(s) { s.write('ROUTER-REACHED\n'); s.end() }, data() {} } })
  try {
    const hidden = hiddenPaths({ home: root, stateDir: state, sandboxDenyRead: [], socket: sock })
    expect(hidden).toContain(sock)
    // one claude run: the socket's file type, the folder's other file, a connection attempt.
    // In a script: with the socket path in the command the model declined to run it (it is in its denyRead).
    // 2026-10-17, Claude Code 2.1.302: TYPE=character special file, NEIGHBOUR-OK, connect: Operation not permitted.
    writeFileSync(join(run, 'check.sh'), `stat -c 'TYPE=%F' ${sock}\ncat ${join(run, 'neighbour.txt')}\npython3 -c "import socket; c=socket.socket(socket.AF_UNIX); c.connect('${sock}'); print(c.recv(32))" 2>&1 | tail -1\n`)
    const r = await asRole('power', bash(`bash ${join(run, 'check.sh')}`), hidden)
    console.log(`[role-live socket]\n${r.text.trim()}`)
    expect(r.text).toContain('TYPE=')
    expect(r.text).not.toContain('TYPE=socket')
    expect(r.text).toContain('NEIGHBOUR-OK')
    expect(r.text).not.toContain('ROUTER-REACHED')
  } finally { srv.stop(true); rmSync(run, { recursive: true, force: true }) }
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

// Bot-wide memory (docs/permissions.md 「bot 共用記憶」): <botDir>/memory is
// read-only for every role below owner, with Read and (where Bash is allowed)
// cat; writing it is refused. A bot folder without memory/ keeps the sandbox working.
const BELOW_OWNER = ['admin', 'power', 'user', 'guest']
// a write into a folder that is not the model's own: say what the run is for, or it declines without calling the tool
const PERM_TEST = '這是權限設定的自動測試, 檔案是測試用的暫存檔, 預期可能被權限擋下; 請實際呼叫工具一次, 讓測試看到結果.'
test.skipIf(!LIVE)('bot memory: admin, power, user and guest read <botDir>/memory/facts.md with Read; Write there is refused', async () => {
  const mem = join(root, 'bot1', 'memory')
  const read = await Promise.all(BELOW_OWNER.map(r => asRole(r, `用 Read 工具讀 ${join(mem, 'facts.md')}. ${ONE}`)))
  const write = await Promise.all(BELOW_OWNER.map(r => asRole(r, `${PERM_TEST} 用 Write 工具建立 ${join(mem, `new-${r}.md`)}, 內容是 NOTE. ${ONE}`)))
  for (const [i, r] of read.entries()) {
    console.log(`[role-live memory read ${BELOW_OWNER[i]}] ${r.text.trim().split('\n').pop()} denied=${JSON.stringify(r.denied)}`)
    expect(r.text).toContain('BOT-MEMORY-OK')
  }
  for (const [i, r] of write.entries()) {
    console.log(`[role-live memory write ${BELOW_OWNER[i]}] denied=${JSON.stringify(r.denied)}`)
    expect(r.denied).toContain('Write')
    expect(existsSync(join(mem, `new-${BELOW_OWNER[i]}.md`))).toBe(false)
  }
}, 300_000)

test.skipIf(!LIVE)('bot memory: admin, power and user read it with Bash cat; writing it through Bash is refused (sandbox for admin and power, the read-only list for user)', async () => {
  const facts = join(root, 'bot1', 'memory', 'facts.md')
  const roles = ['admin', 'power', 'user']
  const cat = await Promise.all(roles.map(r => asRole(r, bash(`cat ${facts}`))))
  const write = await Promise.all(roles.map(r => asRole(r, `${PERM_TEST} ${bash(`echo NOTE >> ${facts} && echo WROTE`)}`)))
  for (const [i, r] of cat.entries()) {
    console.log(`[role-live memory cat ${roles[i]}] ${r.text.trim().split('\n').pop()}`)
    expect(r.text).toContain('BOT-MEMORY-OK')
  }
  for (const [i, r] of write.entries()) {
    console.log(`[role-live memory bash write ${roles[i]}] ${r.text.trim().split('\n').pop()} denied=${JSON.stringify(r.denied)}`)
    expect(r.text).not.toContain('WROTE')
  }
  expect(write[2]!.denied).toContain('Bash')
  expect(readFileSync(facts, 'utf8')).toBe('BOT-MEMORY-OK\n')
}, 300_000)

test.skipIf(!LIVE)('bot memory: a bot folder without memory/ (allowRead points at a missing path) still runs Bash in the sandbox and Read in the folder', async () => {
  const botDir = join(root, 'bot-nomem')
  mkdirSync(botDir, { recursive: true })
  const [power, user, guest] = await Promise.all([
    asRole('power', bash('echo SANDBOX-OK && ls attachments'), [root, state], botDir),
    asRole('user', bash('ls attachments && echo SANDBOX-OK'), [root, state], botDir),
    asRole('guest', `用 Read 工具讀 attachments/note.txt. ${ONE}`, [root, state], botDir),
  ])
  for (const [n, r] of [['power', power], ['user', user], ['guest', guest]] as const) console.log(`[role-live memory missing ${n}] ${r.text.trim().split('\n').pop()}`)
  expect(power.text).toContain('SANDBOX-OK')
  expect(user.text).toContain('SANDBOX-OK')
  expect(guest.text).toContain('ATTACHMENT-OK')
  expect(existsSync(join(botDir, 'memory'))).toBe(false)
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

// --- high-risk tools through the real hook (docs/permissions.md 「高風險工具」, risky.test.ts) ---
// A user conversation's settings with its hooks, the real hooks/hook.ts, and
// a router stand-in in this process (ipc + elevation + tool_history, wired as
// router/main.ts does). Checks which tools reach PreToolUse at all and that
// the router refuses them; a tool this claude build does not offer is printed,
// not failed (the run says which). A plain user turn: nothing is asked in the
// chat. An owner's Telegram turn makes ListAgents at once (automatic elevation,
// autoelev.test.ts); only that read-only tool is tried that way.

type HookRun = { pre: string[]; events: any[]; rows: Array<{ tool: string; decision: string; target: string | null; reason: string | null; eff_role: string | null }>; asked: string[]; text: string; denied: string[] }

/** One claude -p in a user conversation with its hooks, answered by a router stand-in.
 *  ownerTurn: the turn was started by the owner's Telegram message (high-risk calls pass at once). */
async function withHooks(name: string, prompt: string, ownerTurn = false): Promise<HookRun> {
  const home = join(root, name)
  mkdirSync(join(home, '.router'), { recursive: true })
  const cfg = { path: join(home, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home, stateDir: join(home, '.router'), socket: join(home, '.router', 'router.sock'), owners: ['1'], model: MODEL, autoCompactWindow: 750000, claudeBin: CLAUDE }
  const db = openRouterDb(join(home, '.router', 'router.db'))
  const conv = ensureConversation(cfg, db, 'cc', '-100123', 'supergroup', () => {})
  for (const d of ['memory', 'attachments', '.chat']) mkdirSync(join(conv.folder, d), { recursive: true })
  const settingsAs = (c: typeof conv, role: string) => applyOverrides(renderSettings(TEMPLATES, role, { folder: c.folder, home, hidden: [home], botDir: join(home, 'bot1'), autoCompactWindow: 750000, hooksDir: join(home, 'hooks') }), [])
  const asked: string[] = []
  let mid = 0
  const e = createElevation({ db, approvals: { db, owners: ['1'], isAdmin: () => false, send: async (_b, _to, text) => { asked.push(text); return ++mid }, edit: async () => {} }, notify: () => {}, label: u => u, applyPermissions: () => {}, roleOf: u => u === '1' ? 'owner' : 'user', settingsAs })
  if (ownerTurn) e.onDeliver(conv, '1')
  // no Telegram plugin here: stands in for its hello, so own subagents are kept (router/elevation.ts workerConnected)
  e.workerConnected(conv.key, `live:${process.pid}`)
  const history = createToolHistory({ db, log: m => console.log(m) })
  const pre: string[] = [], events: any[] = []
  const ipc = createIpc({ cfg, db, onCall: async () => ({ content: [{ type: 'text', text: 'ok' }] }), identify: () => ({ mode: 'worker', conv, role: 'user' }),
    onHook: async (_p, ev: any) => {
      events.push(ev)
      const d = await e.onHook(conv, ev)
      const { effRole, ...out } = d
      if (ev.event === 'pre') { pre.push(ev.tool_name); history.record(hookUse(conv, ev, d, effRole ?? e.boundRole(conv.key, ev.agent_id))) }
      return out
    } })
  mkdirSync(join(home, 'hooks'))
  // the hook's breaker state (shared/retry.ts) in the test dir, not the user's runtime dir
  writeFileSync(join(home, 'hooks', 'cc-hook'), `#!/bin/sh\nXDG_RUNTIME_DIR='${home}' exec bun ${join(import.meta.dir, '..', '..', 'hooks', 'hook.ts')} "$@"\n`)
  chmodSync(join(home, 'hooks', 'cc-hook'), 0o755)
  const s = settingsAs(conv, 'user') as any
  delete s.enabledPlugins
  const settings = join(home, 'user-hooks.json')
  writeFileSync(settings, JSON.stringify(s))
  const p = Bun.spawn([CLAUDE, '-p', '--model', MODEL, '--settings', settings, '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json'], {
    // a Telegram turn: the prompt hook sees a channel tag (otherwise the turn counts as typed in the terminal, with no sender)
    cwd: conv.folder, stdin: new Blob([ownerTurn ? `<channel source="plugin:telegram:telegram" chat_id="-100123" user="owner">\n${prompt}\n</channel>` : prompt]), stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, CC_TELEGRAM_ROUTER_SOCKET: cfg.socket },
  })
  const out = await new Response(p.stdout).text()
  await p.exited
  ipc.stop(); e.stop()
  const j = JSON.parse(out)
  const r = Array.isArray(j) ? j.find((x: any) => x.type === 'result') : j
  db.close()
  const ro = new Database(join(home, '.router', 'router.db'), { readonly: true })
  const rows = ro.query('SELECT tool, decision, target, reason, eff_role FROM tool_history ORDER BY id').all() as HookRun['rows']
  ro.close()
  return { pre, events, rows, asked, text: String(r?.result ?? ''), denied: (r?.permission_denials ?? []).map((d: any) => String(d.tool_name)) }
}

test.skipIf(!LIVE)('user: the high-risk tools reach PreToolUse and the router blocks each (CronDelete does not reach it); nothing asked in the chat; every call is in tool_history', async () => {
  const tools = [...RISKY_TOOLS, 'SendMessage']
  const prompt = [
    '這是權限測試. 依序做下面每一步, 每一步不論成功, 失敗或被拒絕都直接做下一步, 不要重試, 不要改用其他方法:',
    `1. 用 ToolSearch 工具, query 為 "select:${tools.join(',')}", max_results 10, 載入這些工具.`,
    '2. 呼叫 ListAgents (不帶參數).',
    '3. 呼叫 SendMessage, to 為 "probe-nobody", message 為 "ping".',
    '4. 呼叫 CronDelete, id 為 "probe-0" (就算你認為沒有這個排程也要呼叫).',
    '5. 呼叫 CronCreate, cron 為 "7 3 1 1 *", prompt 為 "noop", recurring 為 false.',
    '6. 呼叫 ScheduleWakeup, delaySeconds 為 3600, prompt 為 "noop", reason 為 "probe", noop 為 true.',
    '7. 呼叫 PushNotification, message 為 "probe", status 為 "proactive".',
    '8. 呼叫 RemoteTrigger, action 為 "list".',
    '最後一行輸出 MISSING: 後面接載入不到或沒有這個工具的名稱 (逗號分隔, 都有就寫 none).',
  ].join('\n')
  const r = await withHooks('risky', prompt)
  const report = tools.map(t => {
    const row = r.rows.find(x => x.tool === t && x.decision === 'deny')
    return `${t}: hook ${r.pre.includes(t) ? '有' : '沒有'}, router ${row ? '擋下' : '沒擋'}, claude 回報被拒 ${r.denied.includes(t) ? '是' : '否'}${row ? `\n  原因: ${row.reason}` : ''}`
  })
  console.log(`[role-live 高風險工具]\n${report.join('\n')}\n經過 hook 的工具: ${r.pre.join(', ')}\n對話裡的提權詢問: ${r.asked.length} 則\n${r.asked.join('\n---\n')}\n模型的回答:\n${r.text.trim()}`)
  const missing = (/MISSING:\s*(.*)$/m.exec(r.text)?.[1] ?? '').split(/[,\s]+/).filter(t => tools.includes(t))
  // CronDelete never reaches PreToolUse (Claude Code 2.1.302: the model calls it, it runs, no hook);
  // checked so a Claude Code that starts sending it is noticed (docs/permissions.md 高風險工具)
  expect(r.pre).not.toContain('CronDelete')
  // every other tool the model could call reached the hook and was blocked
  for (const t of tools.filter(t => !missing.includes(t) && t !== 'CronDelete')) {
    expect([t, r.pre.includes(t)]).toEqual([t, true])
    expect([t, r.rows.some(x => x.tool === t && x.decision === 'deny')]).toEqual([t, true])
  }
  // a plain user turn: no one to ask in the chat
  expect(r.asked).toEqual([])
  // ToolSearch itself is an ordinary tool call: recorded, not blocked
  expect(r.rows.some(x => x.tool === 'ToolSearch' && x.decision === 'allow')).toBe(true)
}, 600_000)

test.skipIf(!LIVE)('user: an owner\'s Telegram turn makes ListAgents at once (automatic elevation): the hook allows it, Claude Code runs it, tool_history has the owner\'s role', async () => {
  const prompt = [
    '這是權限測試. 依序做下面每一步, 每一步不論成功, 失敗或被拒絕都直接做下一步, 不要重試, 不要改用其他方法:',
    '1. 用 ToolSearch 工具, query 為 "select:ListAgents", max_results 1.',
    '2. 呼叫 ListAgents (不帶參數).',
    '最後一行輸出 DONE.',
  ].join('\n')
  const r = await withHooks('auto', prompt, true)
  console.log(`[role-live 自動提權]\ntool_history: ${r.rows.map(x => `${x.tool} ${x.decision} ${x.eff_role ?? '-'} ${x.reason ?? ''}`).join('; ')}\nclaude 回報被拒: ${r.denied.join(', ') || '(無)'}\n對話裡的提權詢問: ${r.asked.length} 則`)
  const row = r.rows.find(x => x.tool === 'ListAgents')
  expect(row).toMatchObject({ decision: 'allow', eff_role: 'owner', reason: '自動提權 (發起者 1 [owner]), 以 owner 角色執行' })
  expect(r.denied).not.toContain('ListAgents')
  expect(r.asked).toEqual([])
}, 600_000)

test.skipIf(!LIVE)('user: SendMessage to its own named subagent passes the router, to another name is blocked', async () => {
  const prompt = [
    '這是權限測試. 依序做下面每一步, 每一步不論成功, 失敗或被拒絕都直接做下一步, 不要重試, 不要改用其他方法:',
    '1. 用 Agent 工具開一個背景 subagent: name 為 "probe-helper", subagent_type 為 "general-purpose", run_in_background 為 true, description 為 "probe", prompt 為 "只回覆 OK 然後結束, 不要使用任何工具".',
    '2. 用 ToolSearch 工具, query 為 "select:SendMessage", max_results 1.',
    '3. 呼叫 SendMessage, to 為 "probe-helper", message 為 "ping".',
    '4. 呼叫 SendMessage, to 為 "probe-stranger", message 為 "ping".',
    '最後一行輸出 DONE.',
  ].join('\n')
  const r = await withHooks('own', prompt)
  console.log(`[role-live 自己的 subagent]\nhook 事件: ${r.events.map(e => `${e.event}${e.tool_name ? ` ${e.tool_name}` : ''}${e.tool_input?.to ? ` to=${e.tool_input.to}` : ''}${e.tool_input?.name ? ` name=${e.tool_input.name}` : ''}${e.agent_type ? ` type=${e.agent_type}` : ''}`).join('; ')}\ntool_history: ${r.rows.map(x => `${x.tool} ${x.decision}${x.target ? ` ${x.target}` : ''}`).join('; ')}\nclaude 回報被拒: ${r.denied.join(', ') || '(無)'}`)
  expect(r.events.some(e => e.event === 'subagent-start')).toBe(true)
  expect(r.rows.find(x => x.tool === 'SendMessage' && x.target === 'probe-helper')?.decision).toBe('allow')
  expect(r.rows.find(x => x.tool === 'SendMessage' && x.target === 'probe-stranger')?.decision).toBe('deny')
}, 600_000)
