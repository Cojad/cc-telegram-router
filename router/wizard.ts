// `cctr [--config x] setup`: the setup wizard (docs/operations.md
// 「設定嚮導」, README How to install). Without config.json it makes one; with
// one it is the edit mode: every answer defaults to the current value, Enter
// keeps it, and only what was changed is written (fields the wizard does not
// ask about stay as they are). Each bot: its token (one * per character,
// never shown), the official Bot API or a self-hosted one (apiRoot), checked
// with getMe on that server before anything is written. Owners go into
// access.json's allowFrom (made with the defaults when missing). Written
// through a temporary file, mode 600. A terminal only: no TTY, no wizard.
// Tests: router/test/wizard.test.ts, e2e-wizard.test.ts, e2e-compiled.test.ts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'
import { OFFICIAL_API_ROOT, parseApiRoot } from './config'
import { isOfficialApi } from './telegram/files'
import { allowOwners } from './telegram/policy'
import { BOT_TOKEN_FULL, botApiCall } from './credentials'
import { tokenBotId } from './setup'
import { maskTokens } from './context'
import { grantTrust, modelWindow, modelWindowNotes, readProjects, trustFix, trustOf, unitPathCheck } from './diagnose'
import { offlineDoctor } from './doctor'

export const LOCAL_API_DEFAULT = 'http://127.0.0.1:8081'
const DEFAULT_MODEL = 'claude-opus-5-5'
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

/** Ctrl-C (or the input ending): the wizard stops and writes nothing. */
export class Cancelled extends Error { constructor() { super('cancelled') } }

/** Keystrokes as they come (a terminal in raw mode, or a test), one character at a time. */
export class KeyQueue {
  private buf: string[] = []
  private ended = false
  private wake: (() => void) | null = null
  push(s: string): void { this.buf.push(...s); this.wake?.() }
  end(): void { this.ended = true; this.wake?.() }
  /** Drop the next character if it is ch and already here (the \n of a \r\n). */
  dropIf(ch: string): void { if (this.buf[0] === ch) this.buf.shift() }
  async take(): Promise<string | null> {
    while (!this.buf.length) {
      if (this.ended) return null
      await new Promise<void>(r => { this.wake = r })
      this.wake = null
    }
    return this.buf.shift()!
  }
}

/** One answer from the keys: printable characters are kept and echoed (or
 *  one * each when masked, a paste of many as many *), Backspace takes the
 *  last one off and erases it, Ctrl-U clears them all, Enter ends; escape
 *  sequences (arrows, bracketed paste marks) and other control keys are
 *  ignored. null: Ctrl-C or the end of input. */
export async function readField(keys: KeyQueue, echo: (s: string) => void, mask: boolean): Promise<string | null> {
  const chars: string[] = []
  for (;;) {
    const ch = await keys.take()
    if (ch === null || ch === '\x03') return null
    if (ch === '\r' || ch === '\n') { if (ch === '\r') keys.dropIf('\n'); return chars.join('') }
    if (ch === '\x7f' || ch === '\b') { if (chars.length) { chars.pop(); echo('\b \b') } continue }
    if (ch === '\x15') { if (chars.length) echo('\b \b'.repeat(chars.length)); chars.length = 0; continue }
    if (ch === '\x1b') {
      const next = await keys.take()
      if (next === null) return null
      // CSI (ESC [ ... final byte @ to ~, e.g. arrows and ESC[200~ of a paste) or SS3 (ESC O x)
      if (next === '[') { for (let c = await keys.take(); c !== null && !(c >= '@' && c <= '~'); c = await keys.take()) {} }
      else if (next === 'O') await keys.take()
      continue
    }
    if (ch < ' ') continue
    chars.push(ch)
    echo(mask ? '*' : ch)
  }
}

export interface WizardIo {
  print(s: string): void
  /** A line, echoed; throws Cancelled on Ctrl-C. */
  ask(prompt: string): Promise<string>
  /** A secret: one * per character, never echoed; throws Cancelled on Ctrl-C. */
  secret(prompt: string): Promise<string>
}

export function keyIo(keys: KeyQueue, write: (s: string) => void): WizardIo {
  const field = async (prompt: string, mask: boolean) => {
    write(prompt)
    const v = await readField(keys, write, mask)
    write('\n')
    if (v === null) throw new Cancelled()
    return v.trim()
  }
  return { print: write, ask: p => field(p, false), secret: p => field(p, true) }
}

export type GetMe = (apiRoot: string, token: string) => Promise<{ ok: true; id: number; username: string } | { ok: false; error: string }>

export interface WizardOpts {
  configPath: string
  io: WizardIo
  getMe: GetMe
  /** claudeBin's default for a new config (the claude on PATH). */
  claudeDefault: string
  userHome?: string
  /** After the wizard (written or not): the doctor's report, or without a
   *  config yet whether bun and claude are on the unit's PATH (router/doctor.ts, unitPathCheck). */
  finalCheck?: (claudeBin: string, written: boolean) => Promise<string[]> | string[]
  /** ~/.claude.json (folder trust); default under userHome. */
  claudeJson?: string
  /** grantTrust's wait before its second check (tests: no wait). */
  wait?: (ms: number) => Promise<void>
}

export type WizardResult = 'written' | 'unchanged' | 'declined'

type RawBot = { name: string; token: string; apiRoot?: string; localFilesDir?: string; [k: string]: unknown }

const tail = (t: string) => t.slice(-4)
const yes = (v: string, dflt: boolean) => v ? /^y(es)?$/i.test(v) : dflt

/** Write a file through a temporary one, mode 600. */
function writeSecretFile(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

export async function runWizard(o: WizardOpts): Promise<WizardResult> {
  const { io } = o
  const userHome = resolve(o.userHome ?? homedir())
  const exists = existsSync(o.configPath)
  const raw: Record<string, any> = exists ? JSON.parse(readFileSync(o.configPath, 'utf8')) : {}
  const base = dirname(o.configPath)
  const stateDir = resolve(base, raw.stateDir ?? '.')
  const changes: string[] = []
  const globalRoot = parseApiRoot(raw.apiRoot, 'apiRoot', [])
  const rootOf = (b: Partial<RawBot>) => parseApiRoot(b.apiRoot, 'bot', []) ?? globalRoot ?? OFFICIAL_API_ROOT
  const apiText = (root: string) => isOfficialApi(root) ? '官方 (api.telegram.org)' : `自架 ${root}`
  const choose = async (prompt: string, options: string[], dflt: string) => {
    for (;;) {
      const v = (await io.ask(prompt)) || dflt
      if (options.includes(v)) return v
      io.print(`  請輸入 ${options.join(' 或 ')}\n`)
    }
  }

  io.print(exists
    ? `修改模式: ${o.configPath}\n每一題 [ ] 裡是目前的值, 直接按 Enter 保留, 只會寫入你改過的欄位.\n\n`
    : `建立新的設定: ${o.configPath}\n每一題 [ ] 裡是預設值, 直接按 Enter 採用. 任何時候按 Ctrl-C 取消, 不會寫入.\n\n`)
  if (!exists) raw.stateDir = stateDir

  /** A text field: Enter keeps the current value (a new config writes it). */
  const text = async (key: string, label: string, current: string, check?: (v: string) => string | null) => {
    for (;;) {
      const v = await io.ask(`${label} [${current}]: `)
      const why = v && check ? check(v) : null
      if (why) { io.print(`  ${why}\n`); continue }
      if (v && v !== current) { changes.push(`${key}: ${current} → ${v}`); raw[key] = v }
      else if (!exists) raw[key] = current
      return
    }
  }

  const homeNow = resolve(base, raw.home ?? '..')
  await text('home', 'router 的家目錄 home (每個對話一個資料夾)', homeNow, v => {
    if (!isAbsolute(v)) return '要是絕對路徑'
    if (resolve(v) === userHome) return 'home 不能是使用者的家目錄: 在家目錄接受的資料夾信任不會存下來, worker 會啟動失敗; 請用它底下的資料夾, 例如 ~/cc'
    return null
  })
  if (typeof raw.home === 'string') raw.home = resolve(raw.home)

  const ownersNow: string[] = (raw.owners ?? []).map(String)
  for (;;) {
    const v = await io.ask(`owner 的 Telegram uid, 多個用逗號分開 (不填: 啟動後用 log 裡的認領碼認領${exists ? '; 輸入 - 清空' : ''}) [${ownersNow.join(', ') || '無'}]: `)
    if (!v) { if (!exists) raw.owners = ownersNow; break }
    const list = v === '-' ? [] : [...new Set(v.split(/[\s,]+/).filter(Boolean))]
    if (list.some(x => !/^\d{1,20}$/.test(x))) { io.print('  uid 是一串數字 (私訊 @userinfobot 之類的 bot 可以查到自己的)\n'); continue }
    if (list.join(',') !== ownersNow.join(',')) changes.push(`owners: ${ownersNow.join(', ') || '無'} → ${list.join(', ') || '無'}`)
    raw.owners = list
    break
  }
  io.print('模型: claude-opus-5-5 這類 Opus 4.7 以上, Sonnet 5 以上, Fable 與 Haiku 5.5 本身就是 1M context. 名稱後面加 [1m] (例如 claude-sonnet-4-6[1m]) 才會用 1M 的版本, 要帳號有 1M context 的額度: Sonnet 4.6 的 1M 在所有方案都要 usage credits, Opus 4.6 的 1M 在 Max, Team, Enterprise 內含. 沒有額度時每一輪都會 API 錯誤 (Usage credits required for 1M context).\n')
  await text('model', 'worker 用的模型 model', raw.model ?? DEFAULT_MODEL)
  // autoCompactWindow against the model (router/diagnose.ts modelWindow): a 200K model compacts at 200000 whatever it says
  {
    const model = String(raw.model ?? DEFAULT_MODEL), win = Number(raw.autoCompactWindow ?? 750_000)
    const notes = modelWindowNotes(model, win)
    if (notes.length) io.print(`${notes.map(n => `  ⚠️ ${n}`).join('\n')}\n`)
    if (modelWindow(model).window === 200_000 && win > 200_000 && yes(await io.ask(`  把 autoCompactWindow 從 ${win} 改成 200000? [Y/n]: `), true)) {
      changes.push(`autoCompactWindow: ${win} → 200000`)
      raw.autoCompactWindow = 200_000
    }
  }
  await text('claudeBin', 'claude 執行檔 claudeBin', raw.claudeBin ?? o.claudeDefault)

  const bots: RawBot[] = Array.isArray(raw.bots) ? raw.bots : []

  /** One bot: name, token, Bot API, then getMe on that server; cur is the bot being changed (null: a new one). */
  const configureBot = async (cur: RawBot | null): Promise<RawBot> => {
    const b: RawBot = cur ? { ...cur } : { name: '', token: '' }
    const dfltName = cur?.name ?? (bots.some(x => x.name === 'cc') ? '' : 'cc')
    for (;;) {
      const v = (await io.ask(`  名稱 (只用英數, - 與 _)${dfltName ? ` [${dfltName}]` : ''}: `)) || dfltName
      if (!NAME_RE.test(v)) { io.print('  名稱只能用英數, - 與 _, 最多 32 字\n'); continue }
      if (bots.some(x => x !== cur && x.name === v)) { io.print(`  已經有名為 ${v} 的 bot\n`); continue }
      b.name = v
      break
    }
    let step: 'token' | 'api' = 'token'
    for (;;) {
      if (step === 'token') {
        for (;;) {
          const v = await io.secret(b.token ? `  bot token [已設定, 末 4 碼 ${tail(b.token)}; Enter 保留]: ` : '  bot token (向 @BotFather 取得, 輸入時每個字顯示一個 *): ')
          if (!v && b.token) break
          if (!v) { io.print('  一定要有 token\n'); continue }
          if (!BOT_TOKEN_FULL.test(v)) { io.print('  格式不像 bot token (<數字>:<35 個字元>), 請重新輸入\n'); continue }
          if (cur && tokenBotId(v) !== tokenBotId(cur.token)) { io.print('  這個 token 屬於另一隻 bot: 修改只能換同一隻 bot 的 token, 要改用別的 bot 請移除這隻後新增\n'); continue }
          b.token = v
          break
        }
      }
      const root = rootOf(b)
      const local = !isOfficialApi(root)
      const c = await choose(`  Bot API: 1) 官方 (api.telegram.org)  2) 自架的本機 Bot API server [${local ? 2 : 1}]: `, ['1', '2'], local ? '2' : '1')
      if (c === '1') {
        // the config's apiRoot is self-hosted: this bot says official itself
        if (local) { if (globalRoot && !isOfficialApi(globalRoot)) b.apiRoot = OFFICIAL_API_ROOT; else delete b.apiRoot }
        delete b.localFilesDir
      } else {
        for (;;) {
          const shown = local ? root : LOCAL_API_DEFAULT
          const v = await io.ask(`  Bot API server 的網址 [${shown}]: `)
          const url = parseApiRoot(v || shown, 'url', [])
          if (!url) { io.print('  要是 http(s) 網址, 例如 http://127.0.0.1:8081\n'); continue }
          if (url !== root) b.apiRoot = url
          break
        }
        for (;;) {
          const now = b.localFilesDir
          const v = await io.ask(`  server 的 --dir (--local 模式時附件只從這裡讀; 可不填${now ? ', 輸入 - 清除' : ''}) [${now ?? '不限制'}]: `)
          if (!v) break
          if (v === '-') { delete b.localFilesDir; break }
          if (!isAbsolute(v) || resolve(v) === '/') { io.print('  要是絕對路徑 (不能是 /)\n'); continue }
          b.localFilesDir = resolve(v)
          break
        }
      }
      if (cur && b.token === cur.token && rootOf(b) === rootOf(cur)) return b
      io.print(`  用 ${rootOf(b)} 驗證 token (getMe)...\n`)
      const r = await o.getMe(rootOf(b), b.token)
      if (r.ok) { io.print(`  驗證成功: @${r.username} (id ${r.id})\n`); return b }
      io.print(`  驗證失敗: ${maskTokens(r.error.split(b.token).join('<token>'))}\n`)
      const next = await choose('  1) 重新輸入 token  2) 重新選 Bot API server  3) 放棄, 不寫入任何設定 [1]: ', ['1', '2', '3'], '1')
      if (next === '3') throw new Cancelled()
      step = next === '1' ? 'token' : 'api'
    }
  }

  /** What changed in a bot, for the summary (the token only as 更換). */
  const botChanges = (a: RawBot, b: RawBot): string[] => {
    const out: string[] = []
    if (a.name !== b.name) out.push(`名稱 ${a.name} → ${b.name}`)
    if (a.token !== b.token) out.push('token 更換')
    if (rootOf(a) !== rootOf(b)) out.push(`Bot API ${apiText(rootOf(a))} → ${apiText(rootOf(b))}`)
    if (a.localFilesDir !== b.localFilesDir) out.push(`localFilesDir ${a.localFilesDir ?? '不限制'} → ${b.localFilesDir ?? '不限制'}`)
    return out
  }

  if (exists && bots.length) {
    for (const b of [...bots]) {
      io.print(`\nbot ${b.name}: token 已設定 (末 4 碼 ${tail(String(b.token ?? ''))}), Bot API ${apiText(rootOf(b))}${b.localFilesDir ? `, localFilesDir ${b.localFilesDir}` : ''}\n`)
      const c = await choose('  1) 保留  2) 修改  3) 移除 [1]: ', ['1', '2', '3'], '1')
      if (c === '2') {
        const nb = await configureBot(b)
        const d = botChanges(b, nb)
        if (d.length) { changes.push(`bot ${b.name}: ${d.join(', ')}`); bots.splice(bots.indexOf(b), 1, nb) }
      } else if (c === '3') {
        if (bots.length === 1) { io.print('  最後一隻 bot 不能移除, 保留\n'); continue }
        bots.splice(bots.indexOf(b), 1)
        changes.push(`移除 bot ${b.name}`)
      }
    }
  }
  const addBot = async () => {
    io.print(`\n新增 bot:\n`)
    const nb = await configureBot(null)
    bots.push(nb)
    changes.push(`新增 bot ${nb.name}: Bot API ${apiText(rootOf(nb))}${nb.localFilesDir ? `, localFilesDir ${nb.localFilesDir}` : ''}`)
  }
  if (!bots.length) await addBot()
  while (yes(await io.ask('\n要再加一隻 bot 嗎? [y/N]: '), false)) await addBot()
  raw.bots = bots

  // owners always reach the bot in a DM: they go into allowFrom (access.json is otherwise left as it is)
  const accessPath = join(stateDir, 'access.json')
  const owners: string[] = (raw.owners ?? []).map(String)
  let access: Record<string, unknown> | null = null, accessNote = ''
  if (!existsSync(accessPath)) {
    access = { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
    allowOwners(access, owners)
    accessNote = `建立 access.json: 私訊用配對碼 (pairing)${owners.length ? `, owner ${owners.join(', ')} 直接可以私訊` : ''}`
  } else if (owners.length) {
    try {
      const a = JSON.parse(readFileSync(accessPath, 'utf8'))
      const added = allowOwners(a, owners)
      if (added.length) { access = a; accessNote = `access.json 的 allowFrom 加入 owner ${added.join(', ')} (其他內容不動)` }
    } catch { io.print(`\n⚠️ ${accessPath} 讀不懂 (不是 JSON), 不動它; owner 請之後用 /router access allow <uid> 加入\n`) }
  }
  if (accessNote) changes.push(accessNote)

  const finish = async (r: WizardResult): Promise<WizardResult> => {
    if (r !== 'declined') await trustStep()
    const lines = await o.finalCheck?.(String(raw.claudeBin ?? 'claude'), r === 'written' || exists) ?? []
    if (lines.length) io.print(`\n${lines.join('\n')}\n`)
    return r
  }
  /** home not trusted by Claude Code: say how, and write it only when the owner types y (router/diagnose.ts grantTrust). */
  const trustStep = async () => {
    const home = resolve(String(raw.home ?? homeNow))
    const claudeJson = o.claudeJson ?? join(userHome, '.claude.json')
    const projects = readProjects(claudeJson)
    if (!projects) { io.print(`\n讀不到 ${claudeJson}: 無法確認 ${home} 的資料夾信任. 第一次請互動執行 cd ${home} && claude, 接受信任後 /exit.\n`); return }
    const t = trustOf(projects, home, userHome)
    if (t.trusted) { io.print(`\n資料夾信任: ${home} 已被 Claude Code 信任${t.key !== home ? ` (上層 ${t.key})` : ''}.\n`); return }
    io.print(`\n資料夾信任: ${home} 還沒被 Claude Code 信任, worker 會起不來 (Workspace not trusted).\n官方建議的做法: ${trustFix(home, t)}\n`)
    if (t.why === 'home') return
    const running = existsSync(resolve(base, raw.socket ?? join(stateDir, 'router.sock')))
    io.print(`也可以由嚮導代寫: 在 ${claudeJson} 把 projects["${t.key}"].hasTrustDialogAccepted 設成 true (官方文件的手動做法). 會先備份, 只改這一個設定; 但每個執行中的 Claude Code 都會改寫這個檔, 寫完可能被蓋掉, 嚮導會再確認一次.\n`)
    if (running) io.print('⚠️ router 正在執行, 它的 worker 隨時會寫這個檔: 建議先 systemctl --user stop cc-telegram-router, 或改用上面的互動做法.\n')
    if ((await io.ask('要由嚮導代寫信任嗎? 確定請輸入 y [y/N]: ')).toLowerCase() !== 'y') { io.print('沒有代寫.\n'); return }
    const g = await grantTrust(claudeJson, t.key, { wait: o.wait })
    if (g.ok) io.print(`已寫入信任 (備份在 ${g.backup}), 3 秒後再讀一次仍在.\n`)
    else io.print(`沒有寫成: ${g.why}${g.backup ? ` (備份在 ${g.backup})` : ''}. 請改用互動做法: ${trustFix(home, t)}\n`)
  }
  if (exists && !changes.length) { io.print('\n沒有任何變更, 不寫入.\n'); return await finish('unchanged') }
  io.print(`\n${exists ? '要寫入的變更' : '要建立的設定'}:\n${(exists ? changes : [`config.json: home ${raw.home}, owners ${owners.join(', ') || '無 (用認領碼)'}, model ${raw.model}, claudeBin ${raw.claudeBin}`, ...changes]).map(c => `  - ${c}`).join('\n')}\n`)
  if (!yes(await io.ask(`寫入 ${o.configPath}? [Y/n]: `), true)) { io.print('沒有寫入.\n'); return await finish('declined') }
  mkdirSync(dirname(o.configPath), { recursive: true, mode: 0o700 })
  writeSecretFile(o.configPath, JSON.stringify(raw, null, 2) + '\n')
  if (access) writeSecretFile(accessPath, JSON.stringify(access, null, 2) + '\n')
  io.print(`已寫入 ${o.configPath} (權限 600)${access ? ` 與 ${accessPath}` : ''}.\n`)
  const socket = resolve(base, raw.socket ?? join(stateDir, 'router.sock'))
  if (existsSync(socket)) io.print('router 正在執行: 要重啟才會套用 (systemctl --user restart cc-telegram-router).\n')
  else if (!exists) io.print(`\n下一步:\n  1. ${join(stateDir, 'cctr')} register (deploy/install.sh setup 會自動做)\n  2. 第一次: cd ${raw.home} && claude, 接受資料夾信任後離開\n  3. sudo loginctl enable-linger <使用者>, 然後 systemctl --user enable --now cc-telegram-router\n`)
  return await finish('written')
}

export { unitFile, unitBasePath, unitPathCheck } from './diagnose'

/** getMe on a Bot API server, with what went wrong as text (never the token). */
export const liveGetMe: GetMe = async (apiRoot, token) => {
  try {
    const r = await botApiCall({ apiRoot, token, method: 'getMe', params: {} })
    if (r?.ok && r.result?.is_bot) return { ok: true, id: r.result.id, username: r.result.username }
    return { ok: false, error: r?.ok ? '不是 bot' : `${r?.error_code ?? ''} ${r?.description ?? '沒有回應'}`.trim() }
  } catch (e) {
    return { ok: false, error: `連不上 ${apiRoot}: ${e instanceof Error ? e.message : e}` }
  }
}

/** The setup subcommand: a terminal only; returns the exit code (0 written or unchanged, 2 no terminal, 130 cancelled). */
export async function runSetupCli(configPath: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('cctr setup 是互動式嚮導, 要在終端機執行 (這裡沒有 TTY); 不能互動時請照 docs/operations.md 「設定欄位」手寫 config.json.\n')
    return 2
  }
  const keys = new KeyQueue()
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.setEncoding('utf8')
  const onData = (d: string) => keys.push(d)
  stdin.on('data', onData)
  stdin.on('end', () => keys.end())
  stdin.resume()
  // raw mode: a new line needs its carriage return
  const write = (s: string) => { process.stdout.write(s.replace(/\r?\n/g, '\r\n')) }
  try {
    const userHome = homedir()
    await runWizard({
      configPath, io: keyIo(keys, write), getMe: liveGetMe, claudeDefault: Bun.which('claude') ?? 'claude', userHome,
      // the end: the doctor on the config as it is now (router/doctor.ts), or only the unit's PATH without one
      finalCheck: async (claudeBin, written) => written && existsSync(configPath)
        ? ['cc-telegram-router doctor:', ...(await offlineDoctor(configPath).catch(e => `doctor 失敗: ${e instanceof Error ? e.message : e}`)).split('\n').slice(1)]
        : unitPathCheck({ userHome, claudeBin, bun: Bun.which('bun'), claude: Bun.which(claudeBin) }),
    })
    return 0
  } catch (e) {
    if (e instanceof Cancelled) { write('\n已取消, 沒有寫入任何設定.\n'); return 130 }
    write(`\n嚮導失敗, 沒有寫入: ${maskTokens(e instanceof Error ? e.message : String(e))}\n`)
    return 1
  } finally {
    stdin.off('data', onData)
    stdin.setRawMode(false)
    stdin.pause()
  }
}

/** argv (after the executable) asks for the wizard: setup, besides --config <path>. */
export function isSetup(args: string[]): boolean {
  return args.filter((a, i) => a !== '--config' && args[i - 1] !== '--config')[0] === 'setup'
}
