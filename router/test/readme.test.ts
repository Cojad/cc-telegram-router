// README and docs/operations.md keep up with the code: every config.json
// field router/config.ts reads is in operations.md 「設定欄位」 (and no field
// that is not), with the credential fields; README's install has the official
// plugin's install command, linger and the link to the fields; README 「How to
// upgrade」 and operations.md 「升級」 give the steps; the feature highlights
// cover what came after 2.11; docs/secrets.md explains secretKey; every
// relative link in README, operations.md and secrets.md reaches a file and a
// heading that exist; operations.md 「自架 Bot API server」 states what
// local-bot-api.test.ts and e2e-localapi.test.ts check, and the first
// interactive claude in <home> (資料夾信任) comes before the router starts;
// README and operations.md describe the setup wizard (wizard.test.ts,
// e2e-wizard.test.ts) and the DM and group access rules (policy.test.ts,
// owners-access.test.ts) as the code has them; the install order (bun,
// clone, bun install, the official plugin, install.sh), install.sh's checks
// and the unit's PATH (preflight.test.ts), and 疑難排解 for plugin did not connect;
// operations.md 「從外部送訊息給 worker」 and its README line (sessionsend.test.ts).
// Keep in sync with those sections.

import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { loadConfig } from '../config'

const ROOT = join(import.meta.dir, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const README = read('README.md'), OPS = read('docs/operations.md')
/** One section of a markdown file: from its heading to the next heading of the same or a higher level. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`\n${heading}\n`)
  if (start < 0) throw new Error(`no ${heading}`)
  const level = heading.match(/^#+/)![0].length
  const rest = md.slice(start + heading.length + 2)
  const end = rest.search(new RegExp(`\\n#{1,${level}} `))
  return end < 0 ? rest : rest.slice(0, end)
}
/** GitHub's anchor for a heading. */
const slug = (h: string) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')

test('operations.md 「設定欄位」 lists exactly the fields config.json is read for, and the credential fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctr-readme-'))
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ bots: [{ name: 'cc', token: 'x' }] }))
    const fields = Object.keys(loadConfig(join(dir, 'config.json'))).filter(k => k !== 'path' && k !== 'warnings').sort()
    const rows = [...section(OPS, '## 設定欄位').matchAll(/^\| `(\w+)` \|/gm)].map(m => m[1]!).sort()
    expect(rows).toEqual(fields)
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const src = read('router/config.ts')
  const credFields = [...src.slice(src.indexOf('export type Credential = {'), src.indexOf('\n}', src.indexOf('export type Credential = {'))).matchAll(/^  (\w+)\??:/gm)].map(m => m[1]!)
  expect(credFields.length).toBeGreaterThan(5)
  const credRow = section(OPS, '## 設定欄位').split('\n').find(l => l.startsWith('| `credentials` |'))!
  for (const f of credFields) expect(credRow).toContain(f)
  expect(README).toContain('嚮導沒有問的欄位 (例如 `credentials`, `secretKey`, `classifier`, `receiveReact`, `sandboxDenyRead`, `skillRefreshAt`) 原封不動, 要改見 [部署與維運: 設定欄位](docs/operations.md#設定欄位)')
})

test('install: the official plugin\'s install command (Claude Code 2.1.302), and linger with how to check it', () => {
  for (const md of [README, OPS]) {
    expect(md).toContain('claude plugin install telegram@claude-plugins-official')
    expect(md).toContain('claude plugin marketplace add anthropics/claude-plugins-official')
    expect(md).toContain('sudo loginctl enable-linger <使用者>')
    expect(md).toContain('loginctl show-user <使用者> -p Linger')
  }
  expect(section(OPS, '### 登出後繼續執行 (linger)')).toContain('`Linger=yes`')
  // the plugin is installed before install.sh plugin overwrites its cache path
  const install = section(README, '## How to install')
  expect(install.indexOf('claude plugin install')).toBeLessThan(install.indexOf('deploy/install.sh plugin   #'))
  expect(install.indexOf('enable-linger')).toBeLessThan(install.indexOf('systemctl --user enable --now'))
})

test('docs/secrets.md explains secretKey: what it encrypts, losing it makes stored secrets unreadable, back it up with router.db, never let it out; linked to the field list', () => {
  const s = section(read('docs/secrets.md'), '## 加密金鑰 secretKey')
  for (const t of ['AES-256', '`conv_secrets`', '`event_raw`', '**遺失或換掉就解不開已存的密鑰與原文**', '**要跟 router.db 一起備份**', '**不可外流**', '[部署與維運: 設定欄位](operations.md#設定欄位)']) expect(s).toContain(t)
  // the message the router really gives when the key changed
  expect(read('router/main.ts')).toContain('解不開 (router 的 secretKey 換過?), 請重新 /secret set')
  expect(s).toContain('解不開 (router 的 secretKey 換過?), 請重新 /secret set')
  expect(section(OPS, '## 設定欄位').split('\n').find(l => l.startsWith('| `secretKey` |'))).toContain('見[密鑰](secrets.md)')
})

test('upgrade: README 「How to upgrade」 and operations.md 「升級」 give backup, install, restart, rotate; the schema only grows', () => {
  const short = section(README, '## How to upgrade'), long = section(OPS, '## 升級')
  for (const s of ['deploy/install.sh router', 'deploy/install.sh plugin', 'router.db', 'config.json', 'systemctl --user stop cc-telegram-router', 'systemctl --user start cc-telegram-router', 'session rotate all', '只新增資料表與欄位']) {
    expect(short).toContain(s)
    expect(long).toContain(s)
  }
  expect(short).toContain('[部署與維運: 升級](docs/operations.md#升級)')
  expect(long).toContain('cp -a <home>/.router/router.db* <home>/.router/config.json <備份資料夾>/')
  expect(long).toContain('退版')
})

test('feature highlights cover what came after 2.11: store, bots, terminal runs, skill_check, skill_try, the trial sandbox network, captions and albums', () => {
  const f = section(README, '## Feature highlights')
  for (const s of ['**每隻 bot 的資料庫**', '**特權動作的 bot 憑證**', '`cli skill run`', '`cli skill refresh`', '**skill_check 與 skill_try**', '**試跑沙箱的網路隔離**', 'unix socket', '**附件用 caption 與相簿**']) expect(f).toContain(s)
})

test('every relative link in README and operations.md reaches a file and a heading that exist', () => {
  const headings = (p: string) => new Set([...read(p).matchAll(/^#{1,6} (.+)$/gm)].map(m => slug(m[1]!)))
  let anchored = 0
  for (const file of ['README.md', 'docs/operations.md', 'docs/secrets.md']) {
    for (const [, target] of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target!)) continue
      const [path, anchor] = target!.split('#')
      const to = path ? join(dirname(file), path) : file
      expect(existsSync(join(ROOT, to)), `${file}: ${target}`).toBe(true)
      if (anchor) { anchored++; expect(headings(to).has(decodeURIComponent(anchor)), `${file}: ${target}`).toBe(true) }
    }
  }
  expect(anchored).toBeGreaterThan(15)
  expect(slug('登出後繼續執行 (linger)')).toBe('登出後繼續執行-linger')
  expect(slug('新 bot 初次設定與審核群組')).toBe('新-bot-初次設定與審核群組')
})

test('operations.md 「自架 Bot API server」 gives the levels, --local from disk, the checks and the limits; 資料夾信任 comes before the router starts', () => {
  const s = section(OPS, '## 自架 Bot API server')
  for (const t of ['`bots[]` 那一項的 `apiRoot`, 沒寫就用全域 `apiRoot`, 再沒有就是官方 `https://api.telegram.org`', '`localFilesDir`', '`/router bot rotate` 只換 token', '`logOut`', '絕對路徑', '一般檔案, 最大 2000 MB', '`stateDir` 或 `home`', '`<token>`', '2000 MB, 官方 50 MB', 'local-bot-api.test.ts', 'e2e-localapi.test.ts']) expect(s).toContain(t)
  for (const md of [README, OPS]) expect(md).toContain('cd <home> && claude')
  const install = section(README, '## How to install')
  expect(install.indexOf('cd <home> && claude')).toBeLessThan(install.indexOf('systemctl --user enable --now'))
  const deploy = section(OPS, '## 部署')
  expect(deploy.indexOf('cd <home> && claude')).toBeLessThan(deploy.indexOf('systemctl --user enable --now'))
  expect(section(OPS, '### 資料夾信任')).toContain('https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust')
})

test('the setup wizard in README 「How to install」 and operations.md 「設定嚮導」: in the install steps, the * input and its keys, official or self-hosted with getMe, the edit mode, access.json, no terminal', () => {
  const install = section(README, '## How to install'), ops = section(OPS, '### 設定嚮導')
  expect(install).toContain('deploy/install.sh setup')
  expect(install.indexOf('deploy/install.sh setup')).toBeLessThan(install.indexOf('systemctl --user enable --now'))
  for (const t of ['顯示一個 `*`', 'Backspace', 'Ctrl-U', 'Enter', 'Ctrl-C', '`http://127.0.0.1:8081`', 'getMe', '修改模式', 'Enter 保留', '已設定 (末 4 碼)', '`allowFrom`', '權限 600', '沒有終端機']) expect(install).toContain(t)
  for (const t of ['`router/wizard.ts`', '結束碼 2', 'Ctrl-H', 'bracketed paste', '`"apiRoot": "https://api.telegram.org"`', '同一隻 bot 的', '`{"dmPolicy": "pairing", "allowFrom": [<owners>], "groups": {}, "pending": {}}`', '只把還不在 `allowFrom` 的 owner 加進去', '暫存檔 (權限 600) 再改名']) expect(ops).toContain(t)
  // what the code really says
  const wiz = read('router/wizard.ts')
  for (const t of ["LOCAL_API_DEFAULT = 'http://127.0.0.1:8081'", "dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {}", "if (ch === '\\x15')", "if (ch === '\\x7f' || ch === '\\b')", '要在終端機執行 (這裡沒有 TTY)']) expect(wiz).toContain(t)
  expect(read('deploy/install.sh')).toContain('setup) install_setup ;;')
})

test('DM and group access in plain words (README 「私訊與群組的存取」, operations.md): pairing for everyone but owners, 1 hour, 3 waiting, allowlist, disabled, groups; the numbers are the code\'s', () => {
  const r = section(README, '## 私訊與群組的存取'), o = section(OPS, '## 私訊與群組的存取')
  for (const t of ['`pairing`', '**每一個人**', '`/router access pair <碼>`', '1 小時有效', '最多 3 個待核可', 'owner 一律在允許清單裡', '`allowlist`', '不發配對碼', '`disabled`', '`/router access group add <chat_id>`', '`--no-mention`']) expect(r).toContain(t)
  for (const t of ['1 小時有效', '最多 3 個待核可', '`/router config set owners`', '`/router role <uid> owner`', 'router 啟動時', 'owners-access.test.ts']) expect(o).toContain(t)
  const policy = read('router/telegram/policy.ts')
  expect(policy).toContain('expiresAt: now + 60 * 60 * 1000, // 1h')
  expect(policy).toContain('if (Object.keys(access.pending).length >= 3) return { action: \'drop\' }')
  expect(policy).toContain("if (access.dmPolicy === 'disabled') return { action: 'drop' }")
})

test('install order and checks: bun (~/.bun/bin) → clone → bun install --frozen-lockfile → the official plugin → install.sh; what install.sh checks; the unit\'s PATH; 疑難排解 for plugin did not connect', () => {
  const install = section(README, '## How to install')
  const order = ['https://bun.sh/install', '`~/.bun/bin`', 'git clone', 'bun install --frozen-lockfile', 'claude plugin install', 'deploy/install.sh router', 'deploy/install.sh setup', 'cd <home> && claude', 'systemctl --user enable --now']
  const at = order.map(t => install.indexOf(t))
  expect(at.every(i => i >= 0), JSON.stringify(at)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  for (const t of ['`engines`', '自動執行 `bun install --frozen-lockfile`', '不會改用沒鎖版本的 `bun install`', 'claude 找得到並印出版本', '只警告', 'bun 與 claude 所在的資料夾加進 unit 的 PATH', '重跑 `deploy/install.sh unit` 會更新']) expect(install).toContain(t)
  const deploy = section(OPS, '## 部署')
  for (const t of ['`deploy/preflight.ts`', '`engines.bun`', '`bun install --frozen-lockfile`', '`~/.local/bin:~/bin:/usr/local/bin:/usr/bin:/bin`', '`command -v bun`', '`plugin did not connect`']) expect(deploy).toContain(t)
  for (const t of [section(README, '## 疑難排解'), section(OPS, '## 疑難排解')]) {
    for (const k of ['`plugin did not connect`', '`deploy/install.sh unit`', '~/.cache/claude-cli-nodejs/', '/mcp-logs-plugin-telegram-telegram/', '-srv-cc-bot123-dm-555']) expect(t).toContain(k)
  }
  // the unit template and install.sh say the same
  expect(read('deploy/cc-telegram-router.service')).toContain('Environment=PATH=@PATH@')
  expect(read('deploy/install.sh')).toContain('local base="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/bin:/bin"')
})

test('cli doctor and worker status (operations.md, README 疑難排解): what doctor checks, status, the wake backoff, StopFailure notices, the start checks, trust written by the wizard only after y; KillMode=process, 1M credits and old flags', () => {
  const ops = section(OPS, '## cli doctor 與 worker 狀態'), trouble = section(OPS, '## 疑難排解'), readme = section(README, '## 疑難排解'), wizard = section(OPS, '### 設定嚮導')
  for (const t of ['`/router doctor`', 'systemd unit 的 PATH', '位置檔', '被 Claude Code 信任', 'autoCompactWindow', '殘留 job', '`router/jobs.ts`', '暖機 spare', '`blocked`', '不含任何 token', '`cc-telegram-router [--config <路徑>] doctor`', '`worker blocked`', '1, 2, 5, 10, 30 分鐘', '同一個原因只通知一次', 'StopFailure', '30 分鐘內只通知一次', '「⚠️ 暫時無法回應', '5 分鐘內只回一次', '第一隻 bot 取得 getMe 後', 'diagnose.test.ts', 'e2e-diagnose.test.ts']) expect(ops).toContain(t)
  for (const t of ['`KillMode=process`', 'left-over process', '`Usage credits required for 1M context`', '`/usage-credits`', '`--resume`', '`/router chat <chat_id> model <模型>`', '`was started with other flags`', '`cc-telegram-router cli doctor`']) expect(trouble).toContain(t)
  for (const t of ['cli doctor', '`/router status`', '`[1m]`', '`left-over process`', '`KillMode=process`']) expect(readme).toContain(t)
  for (const t of ['只有輸入 `y` 才寫', '`projects["<home>"].hasTrustDialogAccepted`', '`~/.claude.json.cc-router-backup-<GMT+8 時間>`', '3 秒後再讀一次', 'router 本身只讀 `~/.claude.json`, 從不寫', 'cc-telegram-router doctor']) expect(wizard).toContain(t)
  // the numbers are the code's
  const diag = read('router/diagnose.ts')
  expect(diag).toContain('export const WAKE_BACKOFF_MIN = [1, 2, 5, 10, 30]')
  expect(diag).toContain('o.settleMs ?? 3000')
  const main = read('router/main.ts')
  for (const t of ['now - (apiNoted.get(k) ?? 0) > 30 * 60_000', "now - (apiNoted.get(`${c.key}|chat`) ?? 0) > 5 * 60_000"]) expect(main).toContain(t)
  expect(read('deploy/cc-telegram-router.service')).toContain('KillMode=process')
  expect(read('templates/base-settings.json')).toContain('cc-hook progress stop-failure')
})

test('operations.md 「從外部送訊息給 worker」 and README: the command, stdin, --from, the queue and wake, a restart, the output, exit codes, terminal only; the numbers are the code\'s (sessionsend.test.ts, e2e-sessionsend.test.ts)', async () => {
  const ops = section(OPS, '## 從外部送訊息給 worker')
  const { DEFAULT_WAIT_S, MAX_WAIT_S, MAX_TEXT, DEFAULT_FROM, QUEUED, DELIVERED } = await import('../sessionsend')
  for (const t of ['cli session send <chat_id|對話key> [--bot <名稱>] [--from <發送者>] [--wait <秒>] [<文字> | -]', '從 stdin 讀', '不會停下來等輸入', `超過 ${MAX_TEXT} 字`, `「${DEFAULT_FROM}」`, '1~64 字', '`router.db` 的佇列', '就叫醒', 'router 啟動 15 秒後與之後每分鐘', 'router 沒在跑', '`<host_message from="<發送者>" via="cli">`', '才用 reply 發到 Telegram', '用 SendMessage 傳給 `--from` 的名稱', 'power 以下的對話, 這個 SendMessage 要經過提權', '照一般的權限流程由 worker 向 owner 申請', QUEUED, DELIVERED, `預設 ${DEFAULT_WAIT_S}, 可設 0~${MAX_WAIT_S}`, '0 已送達', '2 已排進佇列但時間內沒確認送達', '1 錯誤', 'Telegram 裡的 `/router session send` 一律拒絕']) expect(ops).toContain(t)
  expect(section(OPS, '## 終端機 CLI')).toContain('`session send` 是 `--wait` 再加 30 秒')
  expect(README).toContain('(docs/operations.md#從外部送訊息給-worker)')
  // the numbers are the code's
  const main = read('router/main.ts')
  expect(main).toContain('setTimeout(sweepBacklog, cfg.backlogSweepFirstMs ?? BACKLOG_SWEEP_FIRST_MS)') // backlogSweepFirstMs: tests only
  expect(read('router/config.ts')).toContain('export const BACKLOG_SWEEP_FIRST_MS = 15_000')
  expect(main).toContain('setInterval(sweepBacklog, 60_000)')
  expect(read('router/cli.ts')).toContain('waitMs = (a.waitS + 30) * 1000')
})
