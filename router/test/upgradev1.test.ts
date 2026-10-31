// deploy/upgrade-v1.sh, the upgrade from v1 (README 「從 v1 升級」, docs/operations.md 「從 v1 升級」):
// the dry run writes nothing (the home tree is byte for byte the same, its temporary copy of
// messages.db is gone) and lists what comes from v1 (the token only as 有 and its bot id), the
// defaults and the questions with the parameter that answers each, then how many are left and the
// command to run again; answered in full it exits 0 and prints the command to run; a real run with a
// question left stops before writing anything; a session started with --channels
// plugin:telegram@claude-plugins-official running the script is stopped at once (exit 3), before any
// check, while one in the router's home (a legacy worker) is not taken for v1; a v1 session or poller
// still running is reported, a token Telegram refuses is an error with its fix (exit 1); the exit codes
// are the ones the script's header and README give. Everything runs in a temporary home with made-up
// systemctl, loginctl and claude, a local fake Bot API and a made-up process tree; nothing reaches
// Telegram or the user's systemd. Keep in sync with those sections and docs/testing.md 「從 v1 升級驗收對照」.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createHash } from 'crypto'

const REPO = join(import.meta.dir, '..', '..')
const SCRIPT = join(REPO, 'deploy', 'upgrade-v1.sh')
const TOKEN = `123456789:${'TestOnlyFakeToken'.padEnd(35, 'x')}`
const root = mkdtempSync(join(tmpdir(), 'cctr-v1up-'))
const HOME = join(root, 'home'), V1 = join(HOME, '.claude', 'channels', 'telegram')
const SHIMS = join(root, 'shims'), PROC = join(root, 'proc'), TMP = join(root, 'tmp'), CALLS = join(root, 'calls.log')
let api: ReturnType<typeof Bun.serve>, refusing: ReturnType<typeof Bun.serve>

beforeAll(() => {
  for (const d of [V1, join(V1, 'inbox'), SHIMS, PROC, TMP]) mkdirSync(d, { recursive: true })
  writeFileSync(join(V1, '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, { mode: 0o600 })
  writeFileSync(join(V1, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111111111', '222222222'], groups: { '-1001234567890': { requireMention: true, allowFrom: [] } }, pending: { abc123: { senderId: '333333333' } }, mentionPatterns: ['bot'] }))
  writeFileSync(join(V1, 'inbox', 'photo.jpg'), 'x')
  // made in a child process: once it has exited the files stay as they are (in this process a deferred
  // close could checkpoint the WAL later, in the middle of a snapshot)
  const made = Bun.spawnSync([process.execPath, '-e', `
    const { openStore } = await import(${JSON.stringify(join(import.meta.dir, '..', 'telegram', 'store.ts'))})
    const { Database } = require('bun:sqlite')
    const path = ${JSON.stringify(join(V1, 'messages.db'))}
    openStore(path).close()
    const db = new Database(path)
    const ins = db.prepare('INSERT INTO messages (chat_id, message_id, direction, ts, user_id, content, delivered) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('111111111', '1', 'in', '2026-09-15T01:00:00.000Z', '111111111', 'hello', 1)
    ins.run('111111111', '2', 'out', '2026-09-15T01:00:05.000Z', null, 'hi', 1)
    ins.run('-1001234567890', '9', 'in', '2026-09-16T02:30:00.000Z', '222222222', 'group', 1)
  `], { stdout: 'inherit', stderr: 'inherit' })
  if (made.exitCode !== 0) throw new Error('could not make the v1 messages.db')
  const shim = (name: string, body: string) => { writeFileSync(join(SHIMS, name), `#!/bin/bash\necho "${name} $*" >> ${CALLS}\n${body}\n`); chmodSync(join(SHIMS, name), 0o755) }
  shim('systemctl', 'case " $* " in *" show-environment "*) exit 0 ;; *" is-active "*) exit 3 ;; esac\nexit 0')
  shim('loginctl', 'case " $* " in *" show-user "*) echo "Linger=${FAKE_LINGER:-no}" ;; esac\nexit 0')
  shim('claude', '[ "$1" = --version ] && echo "2.1.302 (Claude Code)"\nexit 0')
  api = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => new URL(req.url).pathname.endsWith('/getMe') ? Response.json({ ok: true, result: { id: 123456789, is_bot: true, username: 'example_bot' } }) : Response.json({ ok: true, result: true }) })
  refusing = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 }) })
})
afterAll(() => { api?.stop(true); refusing?.stop(true); rmSync(root, { recursive: true, force: true }) })

const apiRoot = () => `http://127.0.0.1:${api.port}`
const ALL = () => ['--owner', '111111111', '--home', join(HOME, 'cc'), '--bot-name', 'cc', '--keep-access', '--skip-linger', '--api-root', apiRoot()]

/** Run the script (or argv as given) in the temporary home; out is stdout and stderr together. */
async function run(args: string[], o: { env?: Record<string, string>; argv?: string[]; cwd?: string } = {}) {
  const env = { HOME, PATH: `${SHIMS}:${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: TMP, CCTR_V1UP_PROC_ROOT: PROC, LANG: 'C.UTF-8', ...o.env }
  const p = Bun.spawn(o.argv ?? ['bash', SCRIPT, ...args], { env, cwd: o.cwd ?? root, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: out + err }
}
/** Every file and folder under dir with its size, mtime and content hash. */
function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n), st = statSync(p)
      out.push(`${p} ${st.isDirectory() ? 'dir' : st.size} ${st.mtimeMs}${st.isFile() ? ' ' + createHash('sha256').update(readFileSync(p)).digest('hex') : ''}`)
      if (st.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out
}
const calls = () => existsSync(CALLS) ? readFileSync(CALLS, 'utf8') : ''
const sq = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`
/** argv for a parent that looks like a v1 session (claude --channels plugin:telegram@claude-plugins-official) running the script:
 *  bash -c with a second command stays the parent (no exec), the script's own arguments come through V1UP_RUN. */
const asV1Session = (args: string[]) => ({ argv: ['bash', '-c', 'eval "$V1UP_RUN"; exit $?', 'claude', '--channels', 'plugin:telegram@claude-plugins-official'], env: { V1UP_RUN: ['bash', SCRIPT, ...args].map(sq).join(' ') } })

test('dry run with nothing answered: what comes from v1 (token only as its bot id), the defaults, five questions with their parameters, how many are left and the command to run again; exit 3, nothing written', async () => {
  const before = snapshot(HOME)
  rmSync(CALLS, { force: true })
  const r = await run(['--dry-run', '--api-root', apiRoot()])
  expect(r.code).toBe(3)
  expect(r.out).not.toContain(TOKEN)
  expect(r.out).not.toContain(TOKEN.split(':')[1]!)
  for (const t of ['(a) 從 v1 帶入', '(b) 用預設值的項目', '(c) 要問使用者的問題 (5 題)', '(d) 要先處理的問題 (0 項)', '正式執行時的步驟']) expect(r.out).toContain(t)
  expect(r.out).toContain(`bot token: 有, bot id 123456789 (@example_bot, 用 ${apiRoot()} 的 getMe 驗證通過; 來源 ${V1}/.env, 值不顯示)`)
  expect(r.out).toContain('access.json: 私訊模式 allowlist, 允許清單 2 人, 群組 1 個, 待配對 1 個 (不沿用), 其他設定 mentionPatterns')
  expect(r.out).toContain('訊息紀錄 messages.db: 3 則, 2 個對話, 2026-09-15 09:00 ~ 2026-09-16 10:30 (GMT+8)')
  expect(r.out).toContain('照片 inbox/: 1 個檔案')
  expect(r.out).toContain(`家目錄: ${join(HOME, 'cc')} (預設)`)
  expect(r.out).toContain('bot 名稱: cc (預設)')
  const qs = r.out.split('\n').filter(l => l.includes('❓ Q'))
  expect(qs).toHaveLength(5)
  for (const [i, param] of [[0, '--owner <uid>'], [0, '--claim'], [1, '--home <絕對路徑>'], [2, '--bot-name <名稱>'], [3, '--keep-access 或 --no-access'], [4, '--skip-linger']] as const) expect(qs[i]).toContain(param)
  expect(qs[0]).toContain('111111111, 222222222') // v1's allow list as the candidates
  expect(r.out).toContain('還剩 5 題沒答, 0 項錯誤要修, 0 項要人操作.')
  expect(r.out).toContain(`${SCRIPT} --dry-run --api-root ${apiRoot()} --owner <uid> --home ${join(HOME, 'cc')} --bot-name cc --keep-access [--skip-linger]`)
  expect(r.out).toContain('結果: 還有題目沒答或要人操作 (結束碼 3).')
  expect(snapshot(HOME)).toEqual(before)
  expect(readdirSync(TMP)).toEqual([]) // the copy of messages.db is gone
  expect(calls()).not.toMatch(/systemctl .*(enable|start|daemon-reload)/)
}, 60000)

test('dry run with every question answered: exit 0, 還剩 0 題, the command to run (no --dry-run); a real run with one left stops before writing', async () => {
  const before = snapshot(HOME)
  const clean = await run(['--dry-run', ...ALL()])
  expect(clean.code).toBe(0)
  expect(clean.out).toContain('(c) 要問使用者的問題 (0 題)')
  expect(clean.out).toContain('還剩 0 題沒答. 全部通過, 正式執行的指令:')
  expect(clean.out).toContain(`  ${SCRIPT} --owner 111111111 --home ${join(HOME, 'cc')} --bot-name cc --keep-access --skip-linger --api-root ${apiRoot()}\n`)
  expect(clean.out).toContain('結果: dry run 通過, 可以正式執行 (結束碼 0).')
  // linger already on: not a question, no --skip-linger needed
  const linger = await run(['--dry-run', ...ALL().filter(a => a !== '--skip-linger')], { env: { FAKE_LINGER: 'yes' } })
  expect(linger.code).toBe(0)
  expect(linger.out).toContain('linger: 已開')
  // the real run, the owner not given: the same report, stopped before any write
  const real = await run(ALL().filter((a, i, all) => a !== '--owner' && all[i - 1] !== '--owner'))
  expect(real.code).toBe(3)
  expect(real.out).toContain('還剩 1 題沒答')
  expect(real.out).toContain('這次是正式執行: 因為還有沒答的題目或要先處理的問題, 沒有做任何寫入.')
  expect(real.out).not.toContain('[第 1/')
  expect(snapshot(HOME)).toEqual(before)
  expect(existsSync(join(HOME, 'cc'))).toBe(false)
}, 60000)

test('run by the v1 session itself (an ancestor started with --channels plugin:telegram@claude-plugins-official): stopped at once, exit 3, before any check, dry run or not; a legacy worker in the router home is not v1', async () => {
  const before = snapshot(HOME)
  for (const mode of [['--dry-run'], []]) {
    const r = await run([], asV1Session([...mode, ...ALL()]))
    expect(r.code).toBe(3)
    expect(r.out).toContain('執行這支腳本的 Claude Code session 就是 v1 的 Telegram session')
    expect(r.out).toContain('/exit')
    expect(r.out).toContain('不帶 --channels 的普通 claude')
    expect(r.out).toContain('結果: 執行者是 v1 session, 沒有做任何事 (結束碼 3).')
    expect(r.out).not.toContain('(a) 從 v1 帶入')
  }
  // the same arguments, but the parent works in the router's home (legacy mode's workers do): not v1
  mkdirSync(join(HOME, 'cc', 'bot1'), { recursive: true })
  try {
    const w = await run([], { cwd: join(HOME, 'cc', 'bot1'), ...asV1Session(['--dry-run', ...ALL()]) })
    expect(w.out).not.toContain('就是 v1 的 Telegram session')
    expect(w.code).toBe(0)
  } finally { rmSync(join(HOME, 'cc'), { recursive: true, force: true }) }
  expect(snapshot(HOME)).toEqual(before)
}, 60000)

test('v1 still running elsewhere (a --channels session, the bot.pid poller) is something for the user to do (exit 3); a legacy worker in the router home is left out', async () => {
  const fake = (pid: string, args: string[], cwd: string, exe?: string) => {
    mkdirSync(join(PROC, pid), { recursive: true })
    writeFileSync(join(PROC, pid, 'cmdline'), args.join('\0') + '\0')
    symlinkSync(cwd, join(PROC, pid, 'cwd'))
    if (exe) symlinkSync(exe, join(PROC, pid, 'exe'))
  }
  fake('4242', ['claude', '--channels', 'plugin:telegram@claude-plugins-official'], join(HOME, 'proj'))
  fake('4343', ['claude', '--bg', '--channels', 'plugin:telegram@claude-plugins-official'], join(HOME, 'cc', 'bot1', 'dm-1'))
  fake(String(process.pid), ['bun', 'server.ts'], '/somewhere', '/usr/local/bin/bun') // bot.pid's holder: alive (this test), its exe bun
  writeFileSync(join(V1, 'bot.pid'), String(process.pid))
  try {
    const r = await run(['--dry-run', ...ALL()])
    expect(r.code).toBe(3)
    expect(r.out).toContain('(d) 要先處理的問題 (1 項)')
    expect(r.out).toContain('✋ 舊的 v1 還在跑')
    expect(r.out).toContain(`4242 以 --channels plugin:telegram@claude-plugins-official 啟動的 Claude Code session (cwd ${join(HOME, 'proj')})`)
    expect(r.out).toContain(`${process.pid} v1 plugin 的 poller`)
    expect(r.out).not.toContain('4343 ')
    expect(r.out).toContain('還剩 0 題沒答, 0 項錯誤要修, 1 項要人操作.')
  } finally { rmSync(PROC, { recursive: true, force: true }); mkdirSync(PROC); rmSync(join(V1, 'bot.pid'), { force: true }) }
}, 60000)

test('errors to fix come with the fix and exit 1: Telegram refusing the token, no bun; a bad parameter is exit 2', async () => {
  const before = snapshot(HOME)
  const refused = await run(['--dry-run', ...ALL().slice(0, -1), `http://127.0.0.1:${refusing.port}`])
  expect(refused.code).toBe(1)
  expect(refused.out).toContain('❌ Telegram 說 v1 的 token 無效 (401')
  expect(refused.out).toContain('@BotFather 的 /token')
  expect(refused.out).toContain('還剩 0 題沒答, 1 項錯誤要修')
  expect(refused.out).toContain('結果: 有要先修的錯誤 (結束碼 1).')
  expect(refused.out).not.toContain(TOKEN)
  const nobun = await run(['--dry-run', ...ALL()], { env: { PATH: `${SHIMS}:/usr/bin:/bin` } })
  if (!Bun.which('bun', { PATH: '/usr/bin:/bin' })) {
    expect(nobun.code).toBe(1)
    expect(nobun.out).toContain('❌ 找不到 bun. 修法: curl -fsSL https://bun.sh/install | bash')
  }
  const bad = await run(['--dry-run', '--owner', 'someone'])
  expect(bad.code).toBe(2)
  expect(bad.out).toContain('--owner 要是數字 uid')
  expect(snapshot(HOME)).toEqual(before)
}, 60000)

test('the exit codes and the dry-run-first flow are what the script header and README say', () => {
  const sh = readFileSync(SCRIPT, 'utf8'), readme = readFileSync(join(REPO, 'README.md'), 'utf8')
  const head = sh.slice(0, sh.indexOf('set -euo pipefail'))
  for (const t of ['#   0  dry run: 全部通過, 可以正式執行 / 正式執行: 升級完成', '#   1  有要先修的錯誤', '#   2  參數錯誤', '#   3  還有題目沒答, 或要人操作', '不帶 --channels 的普通 claude']) expect(head).toContain(t)
  expect(head).not.toContain('給 v1 使用者自己的 Claude Code session')
  const at = readme.indexOf('\n## 從 v1 升級\n')
  expect(at).toBeGreaterThan(0)
  const sec = readme.slice(at, readme.indexOf('\n## ', at + 5))
  for (const t of ['deploy/upgrade-v1.sh --dry-run', '不帶 `--channels`', '0: dry run 全部通過', '3: 還有題目沒答', '1: 有要先修的錯誤', '2: 參數錯誤', '/exit']) expect(sec).toContain(t)
})
