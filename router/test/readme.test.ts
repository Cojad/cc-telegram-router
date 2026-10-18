// README and docs/operations.md keep up with the code: every config.json
// field router/config.ts reads is in operations.md 「設定欄位」 (and no field
// that is not), with the credential fields; README's install has the official
// plugin's install command, linger and the link to the fields; README 「How to
// upgrade」 and operations.md 「升級」 give the steps; the feature highlights
// cover what came after 2.11; docs/secrets.md explains secretKey; every
// relative link in README, operations.md and secrets.md reaches a file and a
// heading that exist; operations.md 「自架 Bot API server」 states what
// local-bot-api.test.ts and e2e-localapi.test.ts check, and the first
// interactive claude in <home> (資料夾信任) comes before the router starts.
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
  expect(README).toContain('完整欄位 (含沒寫在範例裡的 `apiRoot`, `secretKey`, `classifier`, `receiveReact`, `reactFlushMs` 等) 見 [部署與維運: 設定欄位](docs/operations.md#設定欄位)')
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
