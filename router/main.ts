#!/usr/bin/env bun
// cc-telegram-router entry point (plan 03). Polls every configured bot, logs
// every update and every Bot API call, answers /router commands itself,
// queues delivered messages per conversation, wakes the conversation's
// worker session, and serves the worker plugins over a unix socket.
//
// The inbound pipeline (transport -> handleInbound -> gate) is the v1 plugin
// code unchanged; its "MCP server" here is a stand-in whose notification()
// lands the message in the router queue instead of a Claude Code session.

import { AsyncLocalStorage } from 'async_hooks'
import { Bot, InputFile } from 'grammy'
import { randomBytes } from 'crypto'
import { spawn } from 'child_process'
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, copyFileSync, realpathSync, readdirSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { defaultConfigPath, loadConfig, hiddenPaths, botApiRoot, credApiRoot, OFFICIAL_API_ROOT, BACKLOG_SWEEP_FIRST_MS, VAULT_TICK_MS, type BotConfig } from './config'
import { fetchBotFile } from './telegram/files'
import { isSetup, runSetupCli } from './wizard'
import { UNIT_NAME, createWakeTracker, wakeCause, latestPluginLog, pluginFailure, readProjects, trustOf, trustFix, apiAdvice, modelWindowNotes, type ApiFailure } from './diagnose'
import { doctorReport, offlineDoctor, daemonInputs } from './doctor'
import pkg from '../package.json'
import { locatorPath, syncLocator, writeLocator } from '../shared/locate'
import { acquireLock } from './lock'
import { openRouterDb, type Conversation, type ConvSecret } from './db'
import { ensureConversation, ensureBotDir, botDir, convFolder, migrateConversation, findByFolder, projectStore } from './conversations'
import { writeSessionSettings, renderSettings, applyOverrides } from './settings'
import { createSupervisor, bunRunner, isRunning } from './supervisor'
import { readJob, listJobs, strayJobs, readProcs, daemonReport, reportNotices, workerStateNote } from './jobs'
import { createIpc, type Peer } from './ipc'
import { makeAssertAllowedChat, makeAssertSendable } from './guard'
import { buildContext, renderContext, renderLogs, writeContextFile, maskTokens, gmt8 } from './context'
import { isCommand, runCommand, roleOf, decideCredOverwrite, type CommandDeps, type CommandInput } from './commands'
import { runCli } from './cli'
import { importV1Messages } from './importv1'
import { refuseUse, refuseOwnBot, credRoleRefusal, botApiCall, httpApiCall, refuseHeaders, refuseKeyParam, parseHttpScope, placementText, defaultHeadersText, setHeader, readJsonFile, jsonFileAnywhere, createCredStaging, BOT_TOKEN_FULL, httpExample, takeB64, shorten, DEFAULT_CRED_ROLES, type HttpScope } from './credentials'
import { newSecretKey, maskSecretUpdate, openSecret, refuseSecret, secretCred, scrubSecret, servesChat } from './secrets'
import { createVault, claudeAsk, SECRET_TOPIC, SECRET_TOPIC_INTRO } from './rawvault'
import { PAIRING_TOPIC, PAIRING_TOPIC_INTRO, postPairingRequest, decidePairButton, expirePairings, type PairingDeps } from './pairing'
import { installSkill, installRefusal, skillScope, SKILL_SRC } from './skills'
import { fingerprint, noteStart, STALE_NOTE } from './freshness'
import { createAuthz } from './authz'
import { runSkill, skillDirs, describeActions, type SkillRunDeps } from './skillrun'
import { approveSkill } from './skillapprove'
import { pruneEnvs, envNameOf, type EnvDeps } from './skillenv'
import { checkSkill } from './skillcheck'
import { trySkill, type SkillTryDeps } from './skilltry'
import { interfaceAddrs, cloudPublicAddrs } from './sandboxnet'
import { writeSandboxEtc } from './sandboxfs'
import { toolboxCli, toolboxDir, describeToolbox } from './toolbox'
import { limitMode, primeLimitMode, describeLimitMode } from './sandboxlimits'
import { relaunchArgs, ownArgs, fakeService, FAKE_SUBCOMMAND } from './selfpath'
import { runFakeService } from './skilltry-fake'
import { scheduleRefresh, type RefreshDeps } from './skillrefresh'
import { terminalRun, terminalRefresh } from './skillcli'
import { createPoller, type PollEvent } from './poller'
import { startHealthServer, healthReport, countWorkers, scrubPrivate, startNotice, stopNotice, stopSource, systemdJob, type JobRunner, type WakeFailure } from './health'
import { ALLOWED_UPDATES, createReactionBuffer, flushOnStop, reactor, reactionLabel, wanted, type ReactMode } from './reactions'
import { sendWithRetry, htmlOrPlain } from './sendretry'
import { pollNoticeText, describePoll, noticeVia } from './pollnotice'
import { hashSkill, loadManifest, argRoleRefusal } from './privskill'
import { createProgress, type ProgressEvent, type Mirror } from './progress'
import { rotateTick } from './rotate'
import { requestGrant, decideGrant, sendGranted, type GrantDeps } from './grants'
import { postNotice, noticePlace, requestOriginNoter, type ApprovalDeps } from './approvals'
import { createPluginGuard, scheduleDaily } from './pluginguard'
import { resolveChannel, describeMode, launcherRunner, shellLine, pluginSettings, claudeJsonOf } from './claudecmd'
import { prepareMounts, initConfigDir, createDaemonKeeper, migrated, migrateTranscripts, describeMigration, syncBack, migrateCli, agentsCli, attachCli, MANAGED_USAGE } from './managed'
import { createPkgGate, claudeReviewer } from './pkgreview'
import { createClassifier, openClassifyStore, apiJudge, claudeJudge, classifierReport, classifierShow, DEFAULT_CLASSIFIER, API_PROVIDERS } from './classifier'
import { escHtml, htmlToText } from './setup'
import { newClaimCode, isClaim, initBotSetups, adoptBotSetup, tokenBotId, resetNotice, needsPersona, bootstrapNote, GROUP_GUIDE, checkGroup, describeSetup, botSettingsNotice, privacyNotice, B2B_NOTICE, channelJoinNotice } from './setup'
import { createElevation, workerKey, type HookDecision } from './elevation'
import { createToolHistory, hookUse, KEEP_DAYS } from './toolhistory'
import { dmLabel, personLabel } from './commands'
import { parseRelay, mayRelay, relay, codeBlock, ROUTER_CMDS, type Exec, type RelayCmd } from './relay'
import { homedir } from 'os'
import { openStore } from './telegram/store'
import { readAccessFile, allowOwners, gate as policyGate, dmCommandGate as policyDmCommandGate, type Access, type InboundContext } from './telegram/policy'
import { createHandleInbound } from './telegram/inbound'
import { registerTransport } from './telegram/transport'
import { callTool } from './telegram/outbound'
import { chunk } from './telegram/format'
import type { ChannelParams } from '../shared/protocol'
import { iso8, logLine } from '../shared/time'

// log lines carry GMT+8 time (shared/time.ts), never UTC
const log = (msg: string) => process.stderr.write(logLine(msg))
const startedAt = new Date()

// `cc-telegram-router skilltry-fake <log> -- <command...>`: skill_try's fake service, inside its
// sandbox (router/selfpath.ts, router/skilltry-fake.ts): before anything reads config.json, which
// the sandbox hides.
if (ownArgs()[0] === FAKE_SUBCOMMAND) await runFakeService(ownArgs().slice(1))

// `cc-telegram-router toolbox install|status [--state <stateDir>] [--mirror <x>]`: the shared toolbox
// (router/toolbox.ts; deploy/install.sh router runs install), without config.json.
if (ownArgs()[0] === 'toolbox') process.exit(await toolboxCli(ownArgs().slice(1), dirname(process.execPath)))

const configPath = defaultConfigPath(process.argv, process.execPath)
// `cc-telegram-router [--config x] setup`: the setup wizard (router/wizard.ts), before config.json is read (it may not exist yet)
if (isSetup(ownArgs())) process.exit(await runSetupCli(configPath))
// `cc-telegram-router [--config x] doctor`: router/doctor.ts without the running router
if (ownArgs().filter((a, i, all) => a !== '--config' && all[i - 1] !== '--config')[0] === 'doctor') { console.log(await offlineDoctor(configPath, pkg.version)); process.exit(0) }
const cfg = loadConfig(configPath)

// `cc-telegram-router [--config x] cli <子指令...>`: talk to the running router.
const cliAt = process.argv.indexOf('cli')
if (cliAt > 0) process.exit(await runCli(cfg.socket, process.argv.slice(cliAt + 1)))

// `cc-telegram-router [--config x] cred-import <名稱> <env 檔> <變數> [方法,...]`:
// move a token from a file into config.json credentials without it ever
// being printed (router/credentials.ts). Tells a running router to reload.
const credAt = process.argv.indexOf('cred-import')
if (credAt > 0) {
  const usage = '用法: cc-telegram-router cred-import <名稱> <env 檔> <變數> [方法或路徑,...] [--http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [--default-header <名稱>:<值>]...]'
  const rest = process.argv.slice(credAt + 1)
  const [name, file, varName] = rest
  if (!name || !file || !varName || [name, file, varName].some(a => a.startsWith('--'))) { console.error(usage); process.exit(2) }
  // the list of methods or paths is one comma-separated word
  const words = rest.slice(3).flatMap(w => w.startsWith('--') || /^https?:/.test(w) ? [w] : w.split(',').filter(Boolean))
  let http: HttpScope | undefined, methods: string[] | undefined = words.length ? words : undefined
  if (words.includes('--http')) {
    const h = parseHttpScope(words)
    if ('error' in h) { console.error(`${h.error}\n${usage}`); process.exit(2) }
    http = { baseUrl: h.baseUrl, ...h.placement, ...(Object.keys(h.defaultHeaders).length ? { defaultHeaders: h.defaultHeaders } : {}) }
    // no paths: every path under the URL (only the host is fixed)
    methods = h.paths.length ? h.paths : ['*']
  } else if (words.some(w => w.startsWith('--'))) { console.error(`${words.find(w => w.startsWith('--'))} 只能跟 --http 一起用\n${usage}`); process.exit(2) }
  const line = readFileSync(file, 'utf8').split('\n').find(l => l.startsWith(`${varName}=`))
  const token = line?.slice(varName.length + 1).trim().replace(/^["']|["']$/g, '')
  if (!token) { console.error(`${file} 裡沒有 ${varName}`); process.exit(1) }
  let label: string
  if (http) label = `http ${http.baseUrl}`
  else if (!BOT_TOKEN_FULL.test(token)) {
    // not a bot token: never sent to getMe
    const ex = httpExample(token)
    console.error(`${varName} 看起來不是 Telegram bot token${ex.what ? ` (像是 ${ex.what})` : ''}, 沒有存入. API key 要加 --http <網址>, 例如:\ncc-telegram-router cred-import ${name} ${file} ${varName} ${ex.flags} (沒寫路徑就是全部)`)
    process.exit(1)
  } else {
    const me = await new Bot(token, apiOpts(credApiRoot(cfg, cfg.credentials[name]))).api.getMe().catch(e => { console.error(`token 驗證失敗: ${e}`); process.exit(1) })
    label = `@${me.username} (${me.id})`
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8'))
  raw.credentials ??= {}
  const { header: _h, scheme: _s, query: _q, defaultHeaders: _d, ...old } = raw.credentials[name] ?? {}
  raw.credentials[name] = { ...old, token, label, ...(http ? { kind: 'http', ...http } : {}), methods: methods ?? (raw.credentials[name]?.methods ?? []), roles: raw.credentials[name]?.roles ?? DEFAULT_CRED_ROLES, addedBy: raw.credentials[name]?.addedBy ?? 'terminal' }
  writeFileSync(configPath + '.tmp', JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  renameSync(configPath + '.tmp', configPath)
  console.log(`已存入憑證 ${name}: ${label}${http ? `${placementText(http)}${defaultHeadersText(http.defaultHeaders)}` : ''}, ${http ? '路徑' : '方法'} ${raw.credentials[name].methods.join(', ') || '(無)'}`)
  if (existsSync(cfg.socket)) await runCli(cfg.socket, ['cred', 'reload'])
  process.exit(0)
}

// `cc-telegram-router [--config x] import-v1 <messages.db>`: copy the v1 message log in.
const importAt = process.argv.indexOf('import-v1')
if (importAt > 0) {
  const src = process.argv[importAt + 1]
  const botAt = process.argv.indexOf('--bot')
  const bot = botAt > 0 ? process.argv[botAt + 1] : cfg.bots[0]!.name
  if (!src || src === '--bot' || !bot || !cfg.bots.some(b => b.name === bot)) { console.error('用法: cc-telegram-router import-v1 <messages.db> [--bot <名稱>] (預設第一隻 bot)'); process.exit(2) }
  openStore(join(cfg.stateDir, 'router.db'), { legacyBot: cfg.bots[0]!.name }).close() // make sure the messages table exists, keyed by bot
  const r = importV1Messages(join(cfg.stateDir, 'router.db'), src, bot)
  console.log(`匯入 ${r.imported} 則, 略過已存在的 ${r.skipped} 則`)
  process.exit(0)
}

// `cc-telegram-router [--config x] managed migrate [--dry-run] [--user-config <dir>] [--force]`: copy the
// conversations' transcripts into the router's own config folder (docs/managed-channel.md 「對話紀錄的遷移」);
// the router does it by itself at its first managed start, this is for a planned switch and rehearsals.
// `cc-telegram-router [--config x] managed agents|attach ...`: claude agents and claude attach in the router's
// environment (bwrap and its config folder in managed mode), so the owner's terminal needs no CLAUDE_CONFIG_DIR;
// attach also takes a conversation key or chat_id. `managed` alone or `managed help`: the list.
const managedAt = process.argv.indexOf('managed')
if (managedAt > 0) {
  const sub = process.argv[managedAt + 1], rest = process.argv.slice(managedAt + 2)
  const { Database } = await import('bun:sqlite')
  const convs = () => {
    if (!existsSync(join(cfg.stateDir, 'router.db'))) return [] as Conversation[]
    const d = new Database(join(cfg.stateDir, 'router.db'), { readonly: true })
    try { return d.query('SELECT * FROM conversations').all() as Conversation[] } finally { d.close() }
  }
  if (sub === 'migrate') {
    const { managedPaths } = await import('./claudecmd')
    process.exit(await migrateCli(rest, {
      cfg, paths: managedPaths(cfg.stateDir), convs,
      lock: () => acquireLock(configPath + '.lock'),
      removeJob: async id => {
        await bunRunner([cfg.claudeBin, 'stop', id], cfg.home)
        return (await bunRunner([cfg.claudeBin, 'rm', id], cfg.home)).code === 0
      },
    }))
  }
  if (sub === 'agents' || sub === 'attach') {
    const l = resolveChannel(cfg, { prepare: prepareMounts }).launcher
    const deps = {
      launcher: l, convs,
      runTty: async (argv: string[], env: Record<string, string | undefined>) => {
        // the terminal belongs to claude now: Ctrl-C and the like go to it, not to us
        for (const s of ['SIGINT', 'SIGQUIT', 'SIGTSTP'] as const) process.on(s, () => {})
        const p = Bun.spawn(argv, { cwd: existsSync(cfg.home) ? cfg.home : undefined, env, stdio: ['inherit', 'inherit', 'inherit'] })
        return await p.exited
      },
      agents: async () => { try { return JSON.parse((await launcherRunner(l)([cfg.claudeBin, 'agents', '--json', '--all'], cfg.home)).stdout) } catch { return [] } },
    }
    process.exit(sub === 'agents' ? await agentsCli(rest, deps) : await attachCli(rest, deps))
  }
  console.error(MANAGED_USAGE)
  process.exit(sub === undefined || sub === 'help' ? 0 : 2)
}

// `cc-telegram-router [--config x] register`: write the locator file the
// plugin and the worker hook find this router by (shared/locate.ts);
// deploy/install.sh router runs it.
if (process.argv.indexOf('register') > 0) {
  writeLocator({ home: cfg.home, stateDir: cfg.stateDir, socket: cfg.socket })
  console.log(`已寫入 ${locatorPath()}: home ${cfg.home}, socket ${cfg.socket}`)
  process.exit(0)
}

const release = acquireLock(configPath + '.lock')
{
  // The plugin and the hook find this router through the locator file.
  const loc = syncLocator({ home: cfg.home, stateDir: cfg.stateDir, socket: cfg.socket })
  if (loc === 'updated') log(`locator ${locatorPath()} 已更新為目前的 home 與 socket`)
  else if (loc !== 'ok') log(`locator ${locatorPath()} ${loc === 'missing' ? '不存在' : '指向另一個 router'}: worker 的 plugin 與 hook 找不到這個 router, 要用時執行 cc-telegram-router register`)
}
mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
mkdirSync(cfg.home, { recursive: true })

// How workers get their channel (router/claudecmd.ts, docs/managed-channel.md): managed (every claude
// in bwrap with the router's own config folder and plugin) or legacy, decided once here.
const channel = resolveChannel(cfg, { prepare: prepareMounts })
const launcher = channel.launcher
const managedMode = launcher.mode === 'managed'
log(`channel mode: ${describeMode(channel.decision, channel.shareSessions)}`)
/** Every claude the router runs goes through this (the launcher: bwrap and the config folder in managed mode). */
const claudeRun = launcherRunner(launcher)

// Templates ship next to the source in dev and next to the binary when deployed.
// Where workers load the plugin from (deploy/install.sh plugin puts it there): the router's marketplace in managed mode
const PLUGIN_DIR = managedMode ? channel.paths.pluginDir : join(homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.7')
const TEMPLATES = [join(import.meta.dir, '..', 'templates'), join(cfg.stateDir, 'templates')].find(d => existsSync(join(d, 'base-settings.json')))
if (!TEMPLATES) throw new Error('templates/base-settings.json not found')
const HOOKS_DIR = join(cfg.stateDir, 'hooks')
// The cc /status, /usage, /context report scripts: scripts/ in dev, <stateDir>/scripts when deployed (deploy/install.sh router).
const SCRIPTS_DIR = [join(import.meta.dir, '..', 'scripts'), join(cfg.stateDir, 'scripts')].find(d => existsSync(join(d, 'tg-usage-report.sh'))) ?? join(cfg.stateDir, 'scripts')

const DB_FILE = join(cfg.stateDir, 'router.db')
// owners by reference: a DM's role is its user's role, and config owners are owner (docs/permissions.md 角色)
const db = openRouterDb(DB_FILE, { owners: cfg.owners })
/** Every tool call a hook reports, and the Telegram tools the router runs (router/toolhistory.ts). */
const toolHistory = createToolHistory({ db, log })
{
  const purge = () => { const n = toolHistory.purge(); if (n) log(`tool_history: removed ${n} rows older than 30 days`) }
  purge()
  setInterval(purge, 86_400_000).unref()
}
// Updates logged before every token-carrying command was masked (router/secrets.ts): mask them once.
{ const n = db.maskEventsOnce('mask-command-tokens-2026-10', maskSecretUpdate); if (n != null) log(`masked tokens in ${n} logged updates`) }
// messages are kept per bot; rows from before that go to the bot they show up under, else the first bot (store.ts)
const store = openStore(DB_FILE, { legacyBot: cfg.bots[0]!.name, log })
const ACCESS_FILE = join(cfg.stateDir, 'access.json')
const INBOX = join(cfg.stateDir, 'inbox')

function loadAccess(): Access { return readAccessFile(ACCESS_FILE) }
function saveAccess(a: Access): void {
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}
// owners reach the bot in a DM without pairing (the gate reads only allowFrom):
// config owners and users given the owner role, however they got it (hand-edited config.json too)
{
  const a = loadAccess()
  const added = allowOwners(a, [...cfg.owners, ...db.listUsers().filter(u => u.role === 'owner').map(u => u.uid)])
  if (added.length) { saveAccess(a); log(`access.json: owner ${added.join(', ')} 加入 allowFrom (owner 私訊不用配對)`) }
}
function writeConfig(mutate: (raw: Record<string, unknown>) => void): void {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'))
  mutate(raw)
  const tmp = configPath + '.tmp'
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, configPath)
}

// Conversation secrets are sealed with this key (router/secrets.ts).
if (!cfg.secretKey) {
  const k = newSecretKey()
  writeConfig(r => { r.secretKey = k })
  cfg.secretKey = k
  log('generated config.json secretKey for conversation secrets')
}

// a name whose token is now another bot's: its setup starts over (told to the owner once the bots are up)
const setupResets = initBotSetups(db, cfg.bots.map(b => ({ name: b.name, id: tokenBotId(b.token) })))
for (const r of setupResets) log(`bot ${r.name}: token is another bot (${r.was} -> ${r.now}), setup starts over`)
for (const b of cfg.bots) ensureBotDir(cfg, b.name)
const ctxFile = (c: Conversation) => writeContextFile(cfg, c)
const ctxOf = (c: Conversation) => buildContext(cfg, c)

// No owner yet: the first person to DM "/start <code>" to a bot becomes it.
let claimCode: string | null = cfg.owners.length ? null : newClaimCode()

// home and botDir: skills shared by all bots / by this bot are readable (templates/roles);
// hidden: what the sandbox hides besides ~ (home, stateDir, config sandboxDenyRead)
const settingsVars = (c: Conversation) => ({ folder: c.folder, home: cfg.home, hidden: hiddenPaths(cfg), botDir: botDir(cfg, c.bot), autoCompactWindow: c.compact ?? cfg.autoCompactWindow, hooksDir: HOOKS_DIR, transcripts: projectStore(c.folder, join(launcher.configDir, 'projects')) })
/** A conversation's /router perm overrides; a DM's user's own (/router perm user) go first (docs/permissions.md 使用者覆寫). */
const userOverridesOf = (c: Conversation) => c.type === 'dm' ? db.listUserOverrides(c.chat_id) : []
const overridesOf = (c: Conversation) => [...userOverridesOf(c), ...db.listOverrides(c.key)]
const settingsFor = (c: Conversation) =>
  writeSessionSettings(cfg.stateDir, TEMPLATES, c.key, c.role, settingsVars(c), overridesOf(c), pluginSettings(launcher.mode, channel.paths))

// A DM's stored role from before it followed its user's role (or from before
// config owners changed): align it, and rotate the worker so it picks up the
// user's role (written by the loop below).
for (const { conv, from } of db.syncDmRoles()) {
  log(`dm role ${conv.key}: ${from} -> ${conv.role} (the user's role)`)
  db.setRotate(conv.key, true)
}

// Templates may have changed since the last run: rewrite every
// conversation's settings and context file. Running workers pick settings up
// on their next resume (live sessions do not reload settings).
for (const c of db.listConversations()) { settingsFor(c); ctxFile(c) }

// Which conversation a Bot API call is made on behalf of, for the outbound log.
const callConv = new AsyncLocalStorage<string>()
// Telegram chat type and title per chat_id, captured from updates (the
// channel notification itself only carries chat_id).
const chats = new Map<string, { type: string; title: string | null }>()

type BotHandle = { cfg: BotConfig; bot: Bot; info: { id: number; username: string; first_name: string } | null; poller: ReturnType<typeof createPoller>; stop(): Promise<void> }
const bots = new Map<string, BotHandle>()
// getMe of each bot (privacy mode: can_read_all_group_messages), from bot add / rotate and polling start
const meOf = new Map<string, { username: string; can_read_all_group_messages?: boolean }>()


type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

/** bot_api / http_api with the conversation's own secret (router/secrets.ts):
 *  no role check and no authorization, only its methods or URL and paths;
 *  logged in router.db (outbound, bot "secret:<名稱>"); the value is scrubbed
 *  from whatever goes back to the worker; long strings cut, base64 can be saved. */
async function convSecretCall(live: Peer, conv: Conversation, s: ConvSecret, tool: 'bot_api' | 'http_api', args: Record<string, unknown>): Promise<ToolResult> {
  const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true })
  const http = tool === 'http_api'
  const method = http ? String(args.method ?? 'POST').toUpperCase() : String(args.method ?? '')
  const path = String(args.path ?? '')
  const why = refuseSecret(s, http ? path : method, http ? 'http' : 'telegram-bot')
  if (why) return fail(why)
  let value: string
  try { value = openSecret(cfg.secretKey!, s.bot, s.chat_id, s.name, s.value) } catch { return fail(`密鑰 ${s.name} 解不開 (router 的 secretKey 換過?), 請重新 /secret set`) }
  const files = Object.fromEntries(Object.entries((args.files ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
  try { for (const p of Object.values(files)) makeAssertSendable(live, cfg.stateDir)(p) } catch (e) { return fail(String(e instanceof Error ? e.message : e)) }
  const label = `secret:${s.name}`
  vault.used(s.source)
  if (!http) {
    const params = (args.params ?? {}) as Record<string, unknown>
    const res = await botApiCall({ apiRoot: cfg.apiRoot, token: value, method, params, files }).catch(e => ({ ok: false, description: String(e) }))
    const out = scrubSecret(JSON.stringify(shorten(res)), value)
    db.logApiCall(label, method, { params: shorten(params), files }, JSON.parse(out), res.ok ? null : `${res.error_code ?? ''}: ${scrubSecret(String(res.description), value)}`, conv.key)
    return { content: [{ type: 'text', text: out }], isError: !res.ok }
  }
  const cred = secretCred(s, value)
  const badHeaders = refuseHeaders(cred, args.headers) ?? refuseKeyParam(cred, path)
  if (badHeaders) return fail(badHeaders)
  const headers = args.headers as Record<string, string> | undefined
  // json_file: a file sent as the JSON body (owner and admin: anywhere but router state; others: their folder)
  const jf = readJsonFile(args, conv.folder, { wide: jsonFileAnywhere(live.role), stateDir: cfg.stateDir })
  if (jf && 'error' in jf) return fail(jf.error)
  const save = args.save_b64 as { at?: string; to?: string } | undefined
  const dest = save?.to ? (save.to.startsWith('/') ? save.to : join(conv.folder, save.to)) : null
  if (dest && (!dest.startsWith(conv.folder + '/') || dest.startsWith(join(conv.folder, '.chat') + '/'))) return fail('save_b64.to 要在這個對話的資料夾裡 (不能是 .chat)')
  const res = await httpApiCall({ cred, method, path, json: args.json, ...(jf ? { jsonText: jf.text } : {}), form: args.form as Record<string, unknown> | undefined, files, headers }).catch(e => ({ status: 0, body: String(e) }))
  let body = res.body
  if (dest && save?.at && res.status < 300) {
    const t = takeB64(body, save.at)
    if (t.bytes) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, t.bytes); body = { saved: dest, bytes: t.bytes.length, response: t.body } }
  }
  db.logApiCall(label, `${method} ${path}`, { json: shorten(args.json), ...(jf ? { json_file: { path: jf.path, bytes: jf.bytes } } : {}), form: shorten(args.form), files, ...(headers ? { headers } : {}) }, { status: res.status }, res.status >= 300 || res.status === 0 ? `HTTP ${res.status}` : null, conv.key)
  return { content: [{ type: 'text', text: scrubSecret(JSON.stringify({ status: res.status, body: shorten(body) }), value) }], isError: res.status === 0 || res.status >= 300 }
}

/** Live progress events from a worker's hooks (router/progress.ts). */
function ipcOnProgress(peer: Peer, ev: Record<string, unknown>): void {
  const c = peer.conv
  if (!c) return
  if (ev.event === 'stop' && ev.failure) apiFailed(db.getConversation(c.key) ?? c, ev.failure as ApiFailure)
  if (ev.event === 'stop' || (ev.event === 'prompt' && ev.telegram)) log(`progress ${c.key} ${ev.event}`)
  let replyTo: number | undefined, mirrors: Mirror[] | undefined
  // a turn started by reactions alone (hooks/hook.ts) shows no 🤔 in the chat; the previous turn's progress still closes
  if (ev.event === 'prompt' && ev.telegram && ev.reactions) ev = { ...ev, telegram: false }
  if (ev.event === 'prompt' && ev.telegram) {
    replyTo = replyNext.get(c.key); replyNext.delete(c.key)
    mirrors = pendingMirrors.get(c.key); pendingMirrors.delete(c.key)
  }
  void callConv.run(c.key, () => progress.handle(c.key, c.chat_id, ev as ProgressEvent, { replyTo, mirrors })).catch(e => log(`progress ${c.key}: ${e}`))
}

// The official plugin's cache against what deploy/install.sh plugin recorded
// (router/pluginguard.ts): at every worker's hello and daily at pluginCheckAt.
const pluginGuard = createPluginGuard({ stateDir: cfg.stateDir, notify: noticeEveryBot, log, ...(managedMode ? { marketplacePluginDir: channel.paths.pluginDir } : {}) })

/** One machine-wide notice to each bot's notices place (重要通知), once per place. */
async function noticeEveryBot(text: string): Promise<void> {
  const seen = new Set<string>()
  for (const b of cfg.bots) {
    const place = noticePlace(db, cfg.owners, b.name)
    if (!place) continue
    const k = `${place.chat_id}:${place.thread_id ?? ''}`
    if (seen.has(k)) continue
    seen.add(k)
    await approvalDeps.send(b.name, place, text, [])
  }
}

const ipc = createIpc({
  cfg, db, log,
  identify(projectDir): Peer | null {
    let dir = projectDir
    try { dir = realpathSync(projectDir) } catch {}
    const home = realpathSync(cfg.home)
    if (dir === home) return { mode: 'terminal', conv: null, role: 'owner' }
    if (!dir.startsWith(home + '/')) return null
    // Any path inside a conversation folder belongs to that conversation.
    const conv = findByFolder(db, dir)
    return conv ? { mode: 'worker', conv, role: conv.role } : null
  },
  // Telegram plugin tools run here: the stage 1 classifier judges a call the checks let through (router/classifier.ts)
  onCall: judgedTelegram(async (peer, tool, args) => {
    // Role or settings may have changed since this plugin said hello. An
    // elevated subagent's call carries the elevated role (router/elevation.ts tickets).
    const conv = peer.conv ? db.getConversation(peer.conv.key) : null
    const role = conv ? (elevation.takeTicket(conv.key, tool, args) ?? conv.role) : peer.role
    const live: Peer = conv ? { ...peer, conv, role } : peer
    if (tool === 'request_send_grant') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal session: send anywhere directly' }] }
      const text = await callConv.run(conv.key, () => requestGrant(grantDeps, conv, String(args.chat_id ?? ''), args.mode === 'target' ? 'target' : 'owner', String(args.reason ?? '')))
      return { content: [{ type: 'text', text }] }
    }
    if (tool === 'bot_api') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal: 用 cc-telegram-router cli botapi' }], isError: true }
      const name = String(args.credential ?? ''), method = String(args.method ?? '')
      const secret = db.getConvSecret(conv.bot, conv.chat_id, name)
      if (secret) return convSecretCall(live, conv, secret, 'bot_api', args)
      // "self" (or the bot's own name): this conversation's own bot, for owner/admin
      const own = (name === 'self' || name === conv.bot) && !cfg.credentials[name]
      const cred = own ? { token: cfg.bots.find(b => b.name === conv.bot)!.token, methods: [] } : cfg.credentials[name]
      // the conversation's role is too low for this credential: elevation, as for a hook block
      const call = { tool_name: 'mcp__plugin_telegram_telegram__bot_api', tool_input: args }
      const roleWhy = elevation.extraCheck(conv, call, role)
      if (roleWhy) return { content: [{ type: 'text', text: (await elevation.refuse(conv, call, roleWhy)).reason ?? roleWhy }], isError: true }
      const why = own ? refuseOwnBot(role, method) : refuseUse(cred, name, role, method)
      if (why) return { content: [{ type: 'text', text: why }], isError: true }
      const files = Object.fromEntries(Object.entries((args.files ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      try { for (const p of Object.values(files)) makeAssertSendable(live, cfg.stateDir)(p) } catch (e) { return { content: [{ type: 'text', text: String(e instanceof Error ? e.message : e) }], isError: true } }
      const params = (args.params ?? {}) as Record<string, unknown>
      const res = await botApiCall({ apiRoot: own ? botApiRoot(cfg, conv.bot) : credApiRoot(cfg, cred), token: cred!.token, method, params, files }).catch(e => ({ ok: false, description: String(e) }))
      db.logApiCall(own ? conv.bot : `cred:${name}`, method, { params, files }, res, res.ok ? null : `${res.error_code ?? ''}: ${res.description}`, conv.key)
      if (own) noteSent(conv.bot, method, params, res)
      // an API may echo what it was sent: the token never goes back to the worker
      return { content: [{ type: 'text', text: scrubSecret(JSON.stringify(res), cred!.token) }], isError: !res.ok }
    }
    if (tool === 'http_api') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal: 直接呼叫 API' }], isError: true }
      const name = String(args.credential ?? ''), method = String(args.method ?? 'POST').toUpperCase(), path = String(args.path ?? '')
      const secret = db.getConvSecret(conv.bot, conv.chat_id, name)
      if (secret) return convSecretCall(live, conv, secret, 'http_api', args)
      const cred = cfg.credentials[name]
      const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })
      const call = { tool_name: 'mcp__plugin_telegram_telegram__http_api', tool_input: args }
      const roleWhy = elevation.extraCheck(conv, call, role)
      if (roleWhy) return fail((await elevation.refuse(conv, call, roleWhy)).reason ?? roleWhy)
      const why = refuseUse(cred, name, role, path, 'http') ?? refuseHeaders(cred!, args.headers) ?? refuseKeyParam(cred!, path)
      if (why) return fail(why)
      const headers = args.headers as Record<string, string> | undefined
      const files = Object.fromEntries(Object.entries((args.files ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      try { for (const p of Object.values(files)) makeAssertSendable(live, cfg.stateDir)(p) } catch (e) { return fail(String(e instanceof Error ? e.message : e)) }
      // json_file: a file sent as the JSON body (owner and admin: anywhere but router state; others: their folder)
      const jf = readJsonFile(args, conv.folder, { wide: jsonFileAnywhere(live.role), stateDir: cfg.stateDir })
      if (jf && 'error' in jf) return fail(jf.error)
      const save = args.save_b64 as { at?: string; to?: string } | undefined
      const dest = save?.to ? (save.to.startsWith('/') ? save.to : join(conv.folder, save.to)) : null
      if (dest && (!dest.startsWith(conv.folder + '/') || dest.startsWith(join(conv.folder, '.chat') + '/'))) return fail('save_b64.to 要在這個對話的資料夾裡 (不能是 .chat)')
      const res = await httpApiCall({ cred: cred!, method, path, json: args.json, ...(jf ? { jsonText: jf.text } : {}), form: args.form as Record<string, unknown> | undefined, files, headers }).catch(e => ({ status: 0, body: String(e) }))
      let body = res.body
      if (dest && save?.at && res.status < 300) {
        const t = takeB64(body, save.at)
        if (t.bytes) { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, t.bytes); body = { saved: dest, bytes: t.bytes.length, response: t.body } }
      }
      db.logApiCall(`cred:${name}`, `${method} ${path}`, { json: shorten(args.json), ...(jf ? { json_file: { path: jf.path, bytes: jf.bytes } } : {}), form: args.form, files, ...(headers ? { headers } : {}) }, { status: res.status }, res.status >= 300 || res.status === 0 ? `HTTP ${res.status}` : null, conv.key)
      // an API may echo the auth header (httpbin /anything does): the key never goes back to the worker
      return { content: [{ type: 'text', text: scrubSecret(JSON.stringify({ status: res.status, body: shorten(body) }), cred!.token) }], isError: res.status === 0 || res.status >= 300 }
    }
    // plan 10e: the original of a masked event, through the fixed agent (owner or admin turns)
    if (tool === 'event_raw') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal: 用 cc-telegram-router cli event raw <id>' }], isError: true }
      const r = await callConv.run(conv.key, () => vault.requestRaw(conv, elevation.senderOf(conv), args))
      return { content: [{ type: 'text', text: r.text }], isError: !r.ok }
    }
    if (tool === 'secret_from_handle') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal: 沒有對話' }], isError: true }
      const r = await callConv.run(conv.key, () => vault.fromHandle(conv, args))
      return { content: [{ type: 'text', text: r.text }], isError: !r.ok }
    }
    if (tool === 'run_skill') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal: 直接執行技能的腳本' }], isError: true }
      // an argument limited to higher roles (a video over 15 minutes): elevation, as for a hook block
      const call = { tool_name: 'mcp__plugin_telegram_telegram__run_skill', tool_input: args }
      const argWhy = elevation.extraCheck(conv, call, role)
      if (argWhy) return { content: [{ type: 'text', text: (await elevation.refuse(conv, call, argWhy)).reason ?? argWhy }], isError: true }
      const r = await callConv.run(conv.key, () => runSkill(skillDeps, conv, role, String(args.skill ?? ''), String(args.action ?? ''), (args.args ?? {}) as Record<string, unknown>))
      return { content: [{ type: 'text', text: r.text }], isError: !r.ok }
    }
    if (tool === 'skill_check') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal: 沒有對話資料夾, 直接看技能的檔案' }], isError: true }
      // guest cannot write files: there is nothing of its own to check
      if (role === 'guest') return { content: [{ type: 'text', text: 'guest 角色的對話不能寫檔, 也就沒有技能可以檢查' }], isError: true }
      const r = checkSkill(conv.folder, String(args.path ?? ''), role, { cred: n => cfg.credentials[n] })
      return { content: [{ type: 'text', text: r.text }], isError: !r.ok }
    }
    if (tool === 'skill_try') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal: 用 cc-telegram-router cli skill run --trial' }], isError: true }
      const r = await callConv.run(conv.key, () => trySkill(tryDeps, conv, role, args))
      return { content: [{ type: 'text', text: r.text }], isError: !r.ok }
    }
    if (tool === 'install_skill') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal: 直接把技能放進對應的 .claude/skills' }], isError: true }
      const scope = skillScope(args.scope)
      const name = String(args.name ?? '')
      // a role too low for the scope: elevation, as for a hook block
      const call = { tool_name: 'mcp__plugin_telegram_telegram__install_skill', tool_input: args }
      const roleWhy = elevation.extraCheck(conv, call, role)
      if (roleWhy) return { content: [{ type: 'text', text: (await elevation.refuse(conv, call, roleWhy)).reason ?? roleWhy }], isError: true }
      try {
        const dest = installSkill({ convFolder: conv.folder, role, name, scope, scopeDir: scope === 'all' ? cfg.home : scope === 'bot' ? botDir(cfg, conv.bot) : conv.folder, replace: args.replace === true })
        log(`${conv.key}: installed skill ${name} (${scope}) -> ${dest}`)
        if (scope === 'conversation') {
          // skills are read when a session starts: this worker picks it up on its next wake
          db.setRotate(conv.key, true)
          void rotate()
          return { content: [{ type: 'text', text: `已安裝到 ${dest} (只有這個對話). 這個 worker 這一輪結束, 閒置後會重新叫醒並載入它; 之後要改, 改 ${SKILL_SRC}/${name}/ 再用 install_skill 帶 replace: true.` }] }
        }
        const others = db.listConversations().filter(c => c.key !== conv.key && (scope === 'all' || c.bot === conv.bot))
        for (const c of others) db.setRotate(c.key, true)
        void rotate()
        void postNotice(approvalDeps, conv.bot, `🧩 ${conv.key} 安裝了技能 ${name} (${scope === 'all' ? '全部 bot' : '這隻 bot'} 共用): ${dest}`)
        return { content: [{ type: 'text', text: `已安裝到 ${dest}. 其他 ${others.length} 個對話下次叫醒時就有這個技能.` }] }
      } catch (e) {
        return { content: [{ type: 'text', text: String(e instanceof Error ? e.message : e) }], isError: true }
      }
    }
    if (tool === 'request_elevation') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal session: already owner' }] }
      const text = await callConv.run(conv.key, () => elevation.request(conv, String(args.reason ?? ''), String(args.action ?? '')))
      return { content: [{ type: 'text', text }] }
    }
    if (tool === 'save_bot_profile') {
      if (!conv || conv.type !== 'dm' || !cfg.owners.includes(conv.chat_id)) return { content: [{ type: 'text', text: '只有 owner 私訊的對話能設定 bot 人設' }], isError: true }
      const name = String(args.name ?? '').trim()
      const md = `# ${name || conv.bot} 的人設\n\n<!-- owner 初次設定訪談的結果 (save_bot_profile). 這隻 bot 的所有對話都會讀到這份. -->\n\n- **名字:** ${name}\n\n${String(args.persona ?? '').trim().slice(0, 3000)}\n`
      writeFileSync(join(ensureBotDir(cfg, conv.bot), 'CLAUDE.md'), md)
      db.updateBotSetup(conv.bot, { persona_done: 1 })
      // CLAUDE.md is read when a session starts: every worker of this bot picks it up on its next wake
      const others = db.listConversations().filter(c => c.bot === conv.bot && c.key !== conv.key)
      for (const c of others) db.setRotate(c.key, true)
      void rotate()
      log(`${conv.bot}: persona saved to ${botDir(cfg, conv.bot)}/CLAUDE.md, ${others.length} other worker(s) marked for rotation`)
      const s = db.getBotSetup(conv.bot)
      if (!s?.approvals_chat && !s?.group_skipped) {
        setTimeout(() => void approvalDeps.send(conv.bot, { chat_id: conv.chat_id }, `${escHtml(GROUP_GUIDE)}\n\n${botSettingsNotice(meOf.get(conv.bot) ?? null)}`, [{ text: '略過, 用私訊接收', data: `setup:${conv.bot}:skip` }], { html: true }), 3000)
      }
      return { content: [{ type: 'text', text: `已儲存人設到 ${botDir(cfg, conv.bot)}/CLAUDE.md, 這隻 bot 的其他對話會在下次叫醒時套用 (這個對話在下次重啟後生效, 現在就照新人設說話即可). router 會接著私訊 owner 審核群組的設定步驟, 你不用再說明.` }] }
    }
    if (tool === 'get_chat_context') {
      if (!conv) return { content: [{ type: 'text', text: 'terminal session: no conversation' }] }
      return { content: [{ type: 'text', text: JSON.stringify(ctxOf(conv), null, 2) }] }
    }
    const botName = conv?.bot ?? cfg.bots[0]!.name
    const h = bots.get(botName)
    if (!h) return { content: [{ type: 'text', text: `bot ${botName} is not running` }], isError: true }
    const inboxDir = conv ? join(conv.folder, 'attachments') : join(cfg.home, '.terminal-attachments')
    const target = String(args.chat_id ?? '')
    // a group worker answering someone in their own DM, tied to the message in
    // this group that asked (on_behalf_of): no grant needed, no time limit
    // (a reminder for tomorrow is fine); the DM says which group and message
    let onBehalf = false
    if (tool === 'reply' && conv && conv.type === 'group' && args.on_behalf_of != null && target && target !== conv.chat_id) {
      const asked = store.forBot(conv.bot).lookup(conv.chat_id, String(args.on_behalf_of))
      if (!asked || asked.direction !== 'in' || asked.user_id !== target) {
        return { content: [{ type: 'text', text: `on_behalf_of ${String(args.on_behalf_of)} 不是 ${target} 在這個群組傳給 bot 的訊息: 只能回到提出要求的那個人的私訊. 其他對象要用 request_send_grant 申請.` }], isError: true }
      }
      onBehalf = true
      const said = (asked.content ?? '').replace(/\s+/g, ' ').trim()
      const quote = said ? `: ${said.length > 40 ? said.slice(0, 40) + '…' : said}` : ''
      const { on_behalf_of: _, reply_to: __, ...rest } = args
      const head = `(回覆你在群組「${conv.title || conv.chat_id}」的訊息${quote})`
      args = { ...rest, text: `${args.format === 'markdownv2' ? head.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&') : head}\n\n${String(args.text ?? '')}` }
    }
    // sending to another chat on a send grant is a use of it (執行授權)
    if (conv && target && target !== conv.chat_id && !onBehalf && role !== 'owner' && role !== 'admin') {
      for (const g of authz.covering(conv, o => o.some(x => x.kind === 'send' && (x.value === target || x.value === '*')))) {
        await authz.use(conv, g, `${tool} → ${label(target)}: ${String(args.text ?? args.emoji ?? args.file_id ?? '').replace(/\s+/g, ' ').slice(0, 300)}`)
      }
    }
    return callConv.run(conv?.key ?? 'terminal', () => callTool(tool, args, {
      bot: h.bot, token: h.cfg.token, inboxDir, loadAccess, store: store.forBot(botName),
      // this bot's Bot API server; a --local one's attachments come from disk (router/telegram/files.ts)
      apiRoot: botApiRoot(cfg, h.cfg), localFilesDir: h.cfg.localFilesDir, forbidden: [cfg.stateDir, cfg.home],
      // plan 10e: secrets in a downloaded text file become markers
      scanDownload: (buf, file) => vault.attachment(botName, file, buf),
      cachedDownload: fileId => vault.cached(botName, fileId),
      assertAllowedChat: makeAssertAllowedChat(live, loadAccess, chatId => (onBehalf && chatId === target) || !!conv && sendGranted(db.listOverrides(conv.key).filter(o => o.kind === 'send').map(o => o.value), chatId, id => { const a = loadAccess(); return a.allowFrom.includes(id) || id in a.groups })),
      assertSendable: makeAssertSendable(live, cfg.stateDir),
    }))
  }),
  async onHook(peer, ev, deadline) {
    const c = peer.conv ? db.getConversation(peer.conv.key) : null
    if (!c) {
      // the router home's own terminal session (owner), when it has the hook
      if (ev.event === 'pre' && peer.mode === 'terminal') toolHistory.record(hookUse({ key: 'terminal', role: 'owner' }, ev as Record<string, any>, {}, null))
      return {}
    }
    const d = await hookDecision(peer, c, ev, deadline)
    // a subagent's Telegram tool (quiet) is recorded when the router runs it, unless refused here
    const { effRole, ...out } = d
    if (ev.event === 'pre' && (!ev.quiet || d.decision === 'deny')) toolHistory.record(hookUse(c, ev as Record<string, any>, d, effRole ?? elevation.boundRole(c.key, ev.agent_id ? String(ev.agent_id) : undefined)))
    return out
  },
  onProgress(peer, ev) { ipcOnProgress(peer, ev) },
  // the conversation's own subagents count for the worker process that started them (router/elevation.ts)
  // a worker that cannot be told apart (no process start time) gets none
  onWorker: (c, h) => {
    pluginGuard.check('hello')
    wakeRecovered(c)
    const w = workerKey(h.session_id ?? db.getConversation(c.key)?.session_id, h.pid)
    if (w) elevation.workerConnected(c.key, w)
    else { elevation.workerGone(c.key); log(`own_agents ${c.key}: no start time for pid ${h.pid}, own subagents do not count`) }
  },
  onWorkerGone: key => elevation.workerGone(key),
  async onCli(text, body) {
    const owner = cfg.owners[0]
    if (!owner) return 'config 沒有 owners'
    const out = await runCommand({ bot: cfg.bots[0]!.name, text, senderId: owner, senderName: 'terminal', chatId: owner, chatType: 'private', terminal: true, ...(body !== undefined ? { body } : {}) }, commandDeps)
    if (!out) return `不是 /router 指令: ${text}`
    for (const l of out.logs) db.addLog(l.conv, l.text)
    out.after?.()
    return out.html ? htmlToText(out.reply) : out.reply
  },
  decorate(key, qid, params, conn) {
    const c = db.getConversation(key)
    if (!c) return params
    const parts: string[] = []
    const v = c.ctx_v ?? 1
    if (conn.ctxV !== v) { parts.push(renderContext(ctxOf(c))); conn.ctxV = v }
    const logs = renderLogs(db.bindLogs(key, qid))
    if (logs) parts.push(logs)
    // reactions alone carry no user_id: nobody is added to the turn (router/reactions.ts)
    const who = elevation.onDeliver(c, params.meta.user_id)
    if (params.meta.message_id && params.meta.user !== 'router') currentMsg.set(key, Number(params.meta.message_id))
    // the message that starts the turn goes with the classifier's judgements (masked, first 500 characters)
    if (params.meta.user !== 'router') classifier.noteMessage(key, String(params.content ?? ''))
    if (c.type === 'dm' && cfg.owners.includes(c.chat_id) && params.meta.user_id === c.chat_id && needsPersona(db.getBotSetup(c.bot))) parts.push(bootstrapNote(c.bot))
    // delivery: names this delivery in the prompt's <channel> tag, so the router can tell who a turn is from (router/elevation.ts promptSenders)
    let delivery: Record<string, string> = {}
    try { delivery = { delivery: db.deliveryTag(qid) } } catch (e) { log(`delivery tag ${key}: ${e}`) }
    return {
      content: parts.length ? `${parts.join('\n')}\n${params.content}` : params.content,
      meta: { ...params.meta, ...who, ctx_v: String(v), ...delivery },
    }
  },
})

// Live "🤔 思考中…" message per Telegram-triggered turn (v1 hooks, now router-owned).
// Mirrors can go to an approvals group, which is no conversation: find its bot by setup.
const progressBot = (chatId: string) => {
  const c = db.listConversations().find(x => x.chat_id === chatId)
  const viaSetup = c ? null : cfg.bots.find(b => db.getBotSetup(b.name)?.approvals_chat === chatId)
  return bots.get(c?.bot ?? viaSetup?.name ?? cfg.bots[0]!.name)?.bot.api
}
const progress = createProgress({
  async send(chatId, text, o) {
    return (await progressBot(chatId)?.sendMessage(chatId, text, {
      ...(o?.thread ? { message_thread_id: o.thread } : {}),
      ...(o?.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
    }))?.message_id ?? null
  },
  async edit(chatId, id, text) { await progressBot(chatId)?.editMessageText(chatId, id, text) },
  async remove(chatId, id) { await progressBot(chatId)?.deleteMessage(chatId, id) },
  track: (key, chatId, id) => db.trackProgress(key, chatId, id),
  untrack: (key, id) => db.untrackProgress(key, id),
})

// Managed mode: the router's own claude daemon, inside bwrap, checked before every wake and every
// minute, started or put right when needed (router/managed.ts, docs/managed-channel.md 「daemon 的看管」).
const daemonKeeper = managedMode ? createDaemonKeeper({
  launcher, paths: channel.paths, logFile: join(cfg.stateDir, 'logs', 'daemon-run.log'), log,
  notify: text => noticeEveryBot(text),
}) : null
if (daemonKeeper) setInterval(() => void daemonKeeper.ensure().catch(e => log(`daemon keeper: ${e}`)), 60_000).unref()
if (managedMode) {
  // the config folder ready for background sessions (bypass warning accepted, home trusted)
  const init = initConfigDir(channel.paths, [cfg.home])
  if (init.changed.length) log(`managed: ${channel.paths.configDir}: wrote ${init.changed.join(', ')}`)
  // the first managed start: the conversations' sessions copied over, their jobs in the user's daemon removed
  if (!migrated(channel.paths.configDir)) {
    const r = await migrateTranscripts({
      convs: db.listConversations(), from: channel.paths.userConfigDir, to: channel.paths.configDir,
      fromClaudeJson: claudeJsonOf(channel.paths.userConfigDir), home: cfg.home,
      removeJob: async id => {
        await bunRunner([cfg.claudeBin, 'stop', id], cfg.home)
        return (await bunRunner([cfg.claudeBin, 'rm', id], cfg.home)).code === 0
      },
    })
    log(`managed: transcripts migrated: ${describeMigration(r, false).split('\n').join(' / ')}`)
  }
  void daemonKeeper!.ensure().catch(e => log(`daemon keeper: ${e}`))
} else if (migrated(channel.paths.configDir)) {
  // back in legacy after managed: the newer sessions copied back to the user's config folder
  const back = syncBack({ convs: db.listConversations(), from: channel.paths.configDir, to: channel.paths.userConfigDir })
  if (back.length) log(`legacy: copied ${back.length} newer session(s) back to ${channel.paths.userConfigDir}: ${back.map(b => b.key).join(', ')}`)
}

const supervisor = createSupervisor({
  cfg, db, log, run: claudeRun,
  channel: launcher.channel,
  ...(daemonKeeper ? { beforeWake: () => daemonKeeper.ensure() } : {}),
  isConnected: ipc.isConnected,
  waitConnected: ipc.waitConnected,
  settingsPath: settingsFor,
  // a resumed worker still has the old tool descriptions and skill SOPs in its context: remind it once when they changed
  onStart: (c, resumed) => {
    try {
      const fp = fingerprint([join(PLUGIN_DIR, 'server.js'), join(PLUGIN_DIR, 'skills'), join(cfg.home, '.claude', 'skills'), join(botDir(cfg, c.bot), '.claude', 'skills'), join(c.folder, '.claude', 'skills')])
      if (noteStart(c.folder, fp, resumed)) { db.addLog(c.key, STALE_NOTE); log(`${c.key}: plugin or skills changed since its last start, reminder queued`) }
    } catch (e) { log(`${c.key}: freshness check failed: ${e}`) }
  },
  onWakeFail: (c, info) => wakeFailed(c, info.spawnOut),
  holdUntil: key => wakes.until(key),
  release: key => wakes.release(key),
  // the flags the daemon saved for the job: when they are not the router's now, the job is removed first
  jobFlags: id => readJob(JOBS_DIR, id)?.respawnFlags ?? null,
})

// Daemon jobs and processes (router/jobs.ts): jobs of our conversations that
// are not their current session are removed; a daemon started elsewhere and
// spares without a daemon are told to the owner (once each). At startup and every 10 minutes.
const JOBS_DIR = join(launcher.configDir, 'jobs')
const toldDaemon = new Set<string>()
async function jobSweep(): Promise<void> {
  const agents = await supervisor.listAgents()
  for (const s of strayJobs({ agents, jobs: listJobs(JOBS_DIR), convs: db.listConversations() })) {
    log(`job ${s.id} of ${s.key} is not its current session (${s.sessionId ?? '?'}${s.running ? ', running' : ''}), removing it`)
    if (s.running) await claudeRun([cfg.claudeBin, 'stop', s.id], cfg.home)
    const r = await claudeRun([cfg.claudeBin, 'rm', s.id], cfg.home)
    if (r.code !== 0) log(`claude rm ${s.id}: ${(r.stderr || r.stdout).trim()}`)
  }
  // managed mode: the daemon is the router's own (the keeper checks it); the user's daemon is none of our business
  if (managedMode) return
  let claudeDir: string | undefined
  try { claudeDir = dirname(realpathSync(Bun.which(cfg.claudeBin) ?? cfg.claudeBin)) } catch { return }
  for (const t of reportNotices(daemonReport(readProcs(), [cfg.home, cfg.stateDir], claudeDir))) {
    if (toldDaemon.has(t)) continue
    toldDaemon.add(t)
    log(t.split('\n')[0]!)
    void noticeEveryBot(t).catch(e => log(`daemon notice: ${e}`))
  }
}
setTimeout(() => void jobSweep().catch(e => log(`job sweep: ${e}`)), 5_000).unref()
setInterval(() => void jobSweep().catch(e => log(`job sweep: ${e}`)), 600_000).unref()

// --- why workers fail (router/diagnose.ts): told to the owner once per cause, kept for /router status ---
const CLAUDE_JSON = launcher.claudeJson
const wakes = createWakeTracker()
/** The last trouble of each conversation (memory only), for /router status. */
const lastTrouble = new Map<string, { at: number; text: string }>()
/** The last wake that failed, any conversation, for the health endpoint: by bot name, the cause without who it was about (router/health.ts). */
let lastWakeFailure: WakeFailure | null = null
const convTitle = (c: Conversation) => `${c.key}${c.title ? ` (${c.title})` : ''}`

/** A worker that did not wake: why (claude --bg's words, the plugin's own log, folder trust), when to try again. */
function wakeFailed(c: Conversation, spawnOut?: string): void {
  const logFile = latestPluginLog(c.folder, homedir(), Date.now() - 10 * 60_000)
  let pluginLog: string | null = null
  try { pluginLog = logFile ? pluginFailure(readFileSync(logFile, 'utf8')) : null } catch {}
  const projects = readProjects(CLAUDE_JSON)
  const w = wakeCause({ spawnOut, pluginLog, home: cfg.home, folder: c.folder, logFile, trust: projects ? trustOf(projects, c.folder, homedir()) : null })
  const r = wakes.fail(c.key, w.cause)
  lastTrouble.set(c.key, { at: Date.now(), text: w.cause })
  lastWakeFailure = { at: Date.now(), bot: c.bot, failures: r.failures, cause: scrubPrivate(w.cause, [c.folder, c.key, c.chat_id, c.title, ...[...bots.values()].map(h => h.info?.username)]) }
  log(`${c.key}: wake failed (${r.failures} in a row): ${w.cause}; next try ${gmt8(new Date(r.retryAt))}`)
  if (r.notify) void postNotice(approvalDeps, c.bot, [
    `⚠️ ${convTitle(c)} 的 worker 叫不醒, 訊息還在佇列裡.`,
    `原因: ${w.cause}`,
    `修法: ${w.fix}`,
    `下次自動重試 ${gmt8(new Date(r.retryAt))}; 連續失敗會拉長間隔 (最長 30 分鐘), 同一原因只通知這一次. 修好後可用 /router session restart ${c.chat_id} 立刻重試.`,
  ].join('\n'))
}

/** A plugin said hello: a conversation that kept failing is back. */
function wakeRecovered(c: Conversation): void {
  const r = wakes.ok(c.key)
  if (r.recovered) void postNotice(approvalDeps, c.bot, `✅ ${convTitle(c)} 的 worker 恢復連線 (之前連續失敗 ${r.failures} 次).`)
}

const apiNoted = new Map<string, number>()
/** A turn that ended on an API error (StopFailure hook): the owner learns why and what to do (once per 30 minutes and cause), the chat that nothing is coming (once per 5 minutes). */
function apiFailed(c: Conversation, f: ApiFailure): void {
  const model = c.model ?? cfg.model
  const a = apiAdvice(f, model)
  const said = maskTokens(String(f.message || f.details || '')).replace(/\s+/g, ' ').slice(0, 300)
  lastTrouble.set(c.key, { at: Date.now(), text: a.reason })
  log(`${c.key}: turn ended on an API error (${f.error || '?'}): ${said}`)
  const now = Date.now()
  const k = `${c.key}|${f.error}|${a.short}`
  if (now - (apiNoted.get(k) ?? 0) > 30 * 60_000) {
    apiNoted.set(k, now)
    void postNotice(approvalDeps, c.bot, [`⚠️ ${convTitle(c)} 這一輪因 API 錯誤結束, 沒有回覆.`, `原因: ${a.reason}`, ...(said ? [`原始訊息: ${said}`] : []), `修法: ${a.fix}`].join('\n'))
  }
  if (now - (apiNoted.get(`${c.key}|chat`) ?? 0) > 5 * 60_000) {
    apiNoted.set(`${c.key}|chat`, now)
    const replyTo = currentMsg.get(c.key)
    void bots.get(c.bot)?.bot.api.sendMessage(c.chat_id, `⚠️ 暫時無法回應: ${a.short}. 已通知管理員.`, replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}).catch(e => log(`${c.key}: could not say the turn failed: ${e}`))
  }
}

/** Put a router-originated message in front of a conversation's worker. */
/** The Telegram message each conversation is handling (set as messages are delivered). */
const currentMsg = new Map<string, number>()
/** Per update: its secret findings, and how to record them (plan 10e). */
const secretOf = new WeakMap<object, { rec: import('./rawvault').Recorded; note(command: boolean): void }>()
/** Conversations whose next turn answers a request: its progress replies to the message that asked. */
const replyNext = new Map<string, number>()
/** Where the button being handled was pressed (callback handler), for mirrored progress. */
const decisionOrigin = new AsyncLocalStorage<Omit<Mirror, 'label'>>()
const pendingMirrors = new Map<string, Mirror[]>()

/** Put a router-originated message in front of a conversation's worker.
 *  about: it answers request kind#ref, so the turn it starts shows its
 *  progress as a reply to the message that led to the request. */
function notifyConversation(c: Conversation, text: string, about?: { kind: string; ref: number }): { qid: number; awake: boolean } {
  const origin = about ? db.requestOrigin(about.kind, about.ref) : null
  if (origin != null && !progress.active(c.key)) replyNext.set(c.key, origin)
  // pressed in another chat (approvals group, target chat): mirror the progress there too
  const pressed = decisionOrigin.getStore()
  if (pressed && pressed.chatId !== c.chat_id) {
    const m: Mirror = { ...pressed, label: `↪ ${c.type === 'dm' ? dmLabel(db, c.chat_id) : (c.title ?? c.key)} (${c.key}) 收到結果, 處理中:` }
    if (!progress.attach(c.key, m)) pendingMirrors.set(c.key, [...(pendingMirrors.get(c.key) ?? []), m])
  }
  const qid = db.enqueue(c.key, { content: text, meta: { chat_id: c.chat_id, user: 'router', ts: iso8() } })
  const awake = ipc.isConnected(c.key)
  if (awake) ipc.pushQueue(c.key)
  else void supervisor.ensureAwake(c)
  return { qid, awake }
}

const approvalDeps: ApprovalDeps = {
  db, owners: cfg.owners,
  isAdmin: uid => roleOf(commandDeps, uid) === 'admin',
  async send(bot, to, text, buttons, opts) {
    const api = bots.get(bot)?.bot.api
    if (!api) return null
    const send = (t: string, html: boolean) => api.sendMessage(to.chat_id, t, {
      ...(to.thread_id ? { message_thread_id: to.thread_id } : {}),
      ...(html ? { parse_mode: 'HTML' as const } : {}),
      ...(buttons.length ? { reply_markup: { inline_keyboard: [buttons.map(b => ({ text: b.text, callback_data: b.data }))] } } : {}),
    })
    // HTML refused (an escape missed): the same text without tags, so it still arrives
    const sent = opts?.html ? htmlOrPlain(() => send(text, true), () => send(htmlToText(text), false), { what: `send to ${to.chat_id}`, log }) : send(text, false)
    return sent.then(m => m.message_id, e => { log(`send to ${to.chat_id}: ${e}`); return null })
  },
  // the message a request answers; none for a terminal turn (elevation.ts)
  noteRequest: requestOriginNoter({ db, currentMsg: k => currentMsg.get(k), terminalTurn: k => elevation.terminalTurn(k) }),
  async edit(bot, chatId, messageId, text, buttons) {
    await bots.get(bot)?.bot.api.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: buttons?.length ? [buttons.map(b => ({ text: b.text, callback_data: b.data }))] : [] } })
  },
}

// DM pairing requests with buttons in the 🤝 配對申請 topic (router/pairing.ts)
const pairingDeps: PairingDeps & { approvals: ApprovalDeps } = {
  db, loadAccess, saveAccess, approvals: approvalDeps,
  async sendTo(bot, chatId, text) { await bots.get(bot)?.bot.api.sendMessage(chatId, text) },
  label: uid => personLabel(db, uid),
  log,
}

const label = (id: string) => {
  const c = db.listConversations().find(x => x.chat_id === id)
  if (c?.type === 'dm' || (!c && !id.startsWith('-'))) return `${dmLabel(db, id)} (${id})`
  return `${c?.title ?? id} (${id})`
}

const authz = createAuthz({
  db, approvals: approvalDeps, notify: notifyConversation, label, log,
  applyPermissions: c => commandDeps.applyPermissions(c),
  dropElevation: ref => elevation.drop(ref),
})

const grantDeps: GrantDeps = { db, approvals: approvalDeps, notify: notifyConversation, label, authz }

/** Privileged skill actions (router/skillrun.ts): sandboxed, credentials never reach the worker. */
// each run's network files: whatever a crash left behind goes
rmSync(join(cfg.stateDir, 'sandbox-run'), { recursive: true, force: true })
const skillDeps: SkillRunDeps = {
  db, home: cfg.home, credsRoot: join(cfg.stateDir, 'creds'), userHome: homedir(), hidden: hiddenPaths(cfg),
  // the whitelisted sandbox (docs/skill-runtime.md): config sandboxExtraRo, generated /etc files, each run's network files
  extraRo: cfg.sandboxExtraRo ?? [],
  etcDir: writeSandboxEtc(join(cfg.stateDir, 'sandbox-etc')),
  runRoot: join(cfg.stateDir, 'sandbox-run'),
  hostAddrs: async () => [...interfaceAddrs(), ...await cloudPublicAddrs()],
  botDir: b => botDir(cfg, b),
  httpCred: name => cfg.credentials[name],
  botCred: name => cfg.credentials[name],
  apiRoot: cfg.apiRoot,
  storeRoot: join(cfg.stateDir, 'skill-store'),
  // the shared toolbox (deploy/install.sh router) and the skills' Python environments (router/skillenv.ts)
  toolbox: toolboxDir(cfg.stateDir),
  // 8a, 8b (柯姊 2026-10-18): router paths masked in what goes back; the sandbox's clock in GMT+8 unless configured
  privatePaths: [cfg.stateDir],
  timezone: cfg.sandboxTimezone,
  envRoot: join(cfg.stateDir, 'skill-env'),
  notifyOwner: (c, text) => void postNotice(approvalDeps, c.bot, text),
  log,
}
/** Building a skill's Python environment at approval (router/skillenv.ts), the same folders as a run's. */
const envDeps: EnvDeps = { toolbox: skillDeps.toolbox!, envRoot: skillDeps.envRoot!, etcDir: skillDeps.etcDir, runRoot: skillDeps.runRoot, hostAddrs: skillDeps.hostAddrs, log }
/** skill_try (router/skilltry.ts): a draft's action with fake credentials, in its own network (router/sandboxnet.ts). */
const tryDeps: SkillTryDeps = {
  ...skillDeps, stateDir: cfg.stateDir,
  cred: n => cfg.credentials[n],
  reviewPkgs: pkgs => pkgGate.review(pkgs),
  // compiled: the router's own executable runs the fake service; from source: bun and the script (router/selfpath.ts)
  fake: fakeService(),
}
/** The daily refresh (router/skillrefresh.ts) and the terminal's skill refresh. */
const refreshDeps: RefreshDeps = {
  ...skillDeps, stateDir: cfg.stateDir,
  botOf: dir => cfg.bots.find(b => dir.startsWith(botDir(cfg, b.name) + '/'))?.name ?? cfg.bots[0]!.name,
  notify: (bot, text) => void postNotice(approvalDeps, bot, text).catch(e => log(`skill refresh notice: ${e}`)),
}
/** The daily refresh's queue, once it is scheduled: a terminal refresh waits its turn. */
let refreshQueue: (<T>(fn: () => Promise<T>) => Promise<T>) | undefined

const elevation = createElevation({
  db, approvals: approvalDeps, notify: notifyConversation, label, log, authz,
  applyPermissions: c => commandDeps.applyPermissions(c),
  roleOf: uid => roleOf(commandDeps, uid),
  // a worker already running when the router starts may be mid-turn: no sender until its next Stop
  unknownTurns: true,
  settingsAs: (c, role, keep) => applyOverrides(renderSettings(TEMPLATES, role, settingsVars(c)), [...userOverridesOf(c), ...db.listOverrides(c.key).filter(o => !keep || keep(o))]),
  // a skill argument limited to higher roles (privileged.json args.<name>.roles): elevation, like any other block
  // bot_api / http_api with a credential the conversation's role may not use (a conversation's own secret has no role check)
  extraCheck: (c, call, role) => {
    const tool = call.tool_name.replace(/^mcp__plugin_telegram_telegram__/, '')
    if (tool === 'install_skill') return installRefusal(skillScope(call.tool_input?.scope), role)
    if (tool === 'bot_api' || tool === 'http_api') {
      const args = (call.tool_input ?? {}) as Record<string, unknown>
      if (db.getConvSecret(c.bot, c.chat_id, String(args.credential ?? ''))) return null
      return credRoleRefusal(cfg.credentials, c.bot, tool, args, role)
    }
    if (call.tool_name !== 'mcp__plugin_telegram_telegram__run_skill') return null
    const i = call.tool_input ?? {}
    try {
      const dir = skillDirs(skillDeps, c.bot, String(i.skill ?? ''))[0]
      const a = dir ? loadManifest(dir)?.actions[String(i.action ?? '')] : undefined
      return a ? argRoleRefusal(a, (i.args ?? {}) as Record<string, unknown>, role) : null
    } catch { return null }
  },
})

{
  const purge = () => {
    const before = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString()
    const n = elevation.purgeOwnAgents(before)
    if (n) log(`own_agents: removed ${n} old rows`)
    const e = elevation.purgeBinds(before)
    if (e) log(`elev_binds: removed ${e} rows past their time`)
  }
  purge()
  setInterval(purge, 86_400_000).unref()
}

const pkgGate = createPkgGate({
  db, approvals: approvalDeps, notify: notifyConversation, label, log, authz,
  review: claudeReviewer({ claudeBin: cfg.claudeBin, launch: launcher, model: () => cfg.model, cwd: (mkdirSync(join(cfg.stateDir, 'review'), { recursive: true }), join(cfg.stateDir, 'review')) }),
})

/** Tool call classifier, stage 1: record only (router/classifier.ts). */
const classifyStore = openClassifyStore(DB_FILE)
const classifierCfg = () => cfg.classifier ?? DEFAULT_CLASSIFIER
// an unusable config block only turns the classifier off: the router starts as usual
if (classifierCfg().error) log(`classifier: config.json classifier 有誤, 分類器關閉: ${classifierCfg().error}`)
else if (classifierCfg().enabled) log(`classifier: on (record only), ${API_PROVIDERS.map(p => { const a = classifierCfg()[p]; return a.enabled ? `${p} ${a.api} ${a.model}` : `${p} off` }).join(', ')}, telegram tools ${classifierCfg().telegramTools ? 'on' : 'off'}`)
const classifier = createClassifier({
  cfg: classifierCfg,
  store: classifyStore,
  judges: {
    // Decisions and Jev: OpenRouter by default, or the native / systemone paths (config api)
    openai: apiJudge({ cfg: () => classifierCfg().openai, cred: n => cfg.credentials[n] }),
    typesafe: apiJudge({ cfg: () => classifierCfg().typesafe, cred: n => cfg.credentials[n] }),
    clef: apiJudge({ cfg: () => classifierCfg().clef, cred: n => cfg.credentials[n] }),
    clefflash: apiJudge({ cfg: () => classifierCfg().clefflash, cred: n => cfg.credentials[n] }),
    claude: claudeJudge({ claudeBin: cfg.claudeBin, launch: launcher, model: () => cfg.model, cwd: (mkdirSync(join(cfg.stateDir, 'review'), { recursive: true }), join(cfg.stateDir, 'review')) }),
  },
  // the same held values 10e matches exactly, plus every chat id the router knows
  maskEnv: c => ({
    folder: c.folder, routerHome: cfg.home, ownChatId: c.chat_id,
    known: [
      ...cfg.bots.map(b => ({ value: b.token, label: `bot ${b.name}` })),
      ...Object.entries(cfg.credentials).map(([n, x]) => ({ value: x.token, label: `credential ${n}` })),
      ...db.allConvSecrets().flatMap(s => { try { return [{ value: openSecret(cfg.secretKey!, s.bot, s.chat_id, s.name, s.value), label: `secret ${s.name}` }] } catch { return [] } }),
    ],
    chatIds: [...new Set([...db.listConversations().map(x => x.chat_id), ...cfg.owners])],
  }),
  log,
})
for (const line of classifier.check()) log(line)
{
  const purge = () => { try { const n = classifier.purge(); if (n) log(`classifier: removed ${n} old records`) } catch (e) { log(`classifier purge: ${e}`) } }
  purge()
  setInterval(purge, 86_400_000).unref()
}

/** The router's answer to a worker hook event (permissions, elevation, package review). */
async function hookDecision(peer: Peer, c: Conversation, ev: Record<string, any>, deadline?: number): Promise<HookDecision> {
  // progress events ride along (pre/post/stop/...); subagent events and quiet ones are elevation only
  if (!String(ev.event).startsWith('subagent-') && !ev.quiet) ipcOnProgress(peer, ev)
  // a turn typed in the worker's terminal has no Telegram message for the classifier
  if (ev.event === 'prompt' && ev.telegram === false) classifier.noteMessage(c.key, null)
  const d = await elevation.onHook(c, ev as Record<string, any>, deadline)
  if (d.decision) return d
  // power may install packages once they pass review (router/pkgreview.ts)
  if (ev.event === 'pre' && ev.tool_name === 'Bash' && c.role === 'power' && typeof ev.tool_input?.command === 'string') {
    const p = await pkgGate.check(c, ev.tool_input.command)
    if (p.decision === 'deny') await elevation.note(c, 'blocked', `⛔ ${c.key} 套件安裝被擋: ${String(ev.tool_input.command).slice(0, 160)}\n${p.reason}`)
    else classifier.submit(c, ev as Record<string, any>)
    return p
  }
  // the rules let it through: stage 1 classifier only records, after the answer (router/classifier.ts)
  classifier.submit(c, ev as Record<string, any>)
  return d
}

/** onCall, plus the classifier for a Telegram plugin tool the router ran without an error, with the
 *  role it ran with (an elevated subagent's call, which carries a ticket, is not judged). */
function judgedTelegram<T extends { isError?: boolean }>(f: (peer: Peer, tool: string, args: Record<string, any>) => Promise<T>) {
  return async (peer: Peer, tool: string, args: Record<string, any>): Promise<T> => {
    const conv = peer.conv ? db.getConversation(peer.conv.key) : null
    const ticket = conv ? elevation.peekTicket(conv.key, tool, args) : null
    const role = conv ? (ticket ?? conv.role) : null
    const res = await f(peer, tool, args)
    if (conv && role && !res?.isError) classifier.submitTelegram(conv, role, tool, args)
    // the hook leaves these to the router: recorded here (a ticket: an elevated subagent's call)
    toolHistory.record({ conv: conv?.key ?? 'terminal', conv_role: conv?.role ?? peer.role, eff_role: ticket, tool: `mcp__plugin_telegram_telegram__${tool}`, decision: res?.isError ? 'error' : 'allow', reason: null, target: null, subagent: !!ticket })
    return res
  }
}

/** Original updates and secrets (router/rawvault.ts, plan 10e). */
const vault = createVault({
  db, owners: cfg.owners, approvals: approvalDeps,
  secretKey: () => cfg.secretKey!,
  // values the router holds: matched exactly in every update
  known: () => [
    ...cfg.bots.map(b => ({ value: b.token, label: `router 的 bot ${b.name}` })),
    ...Object.entries(cfg.credentials).map(([n, c]) => ({ value: c.token, label: `全域憑證 ${n}` })),
    ...db.allConvSecrets().flatMap(s => {
      try { return [{ value: openSecret(cfg.secretKey!, s.bot, s.chat_id, s.name, s.value), label: `對話密鑰 ${s.name} (${db.findConversation(s.bot, s.chat_id)?.key ?? s.chat_id})` }] } catch { return [] }
    }),
  ],
  roleOf: uid => roleOf(commandDeps, uid),
  api(name) {
    const h = bots.get(name)
    if (!h) return null
    const api = h.bot.api
    return {
      send: (chatId, text, o) => api.sendMessage(chatId, text, {
        ...(o?.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
        ...(o?.buttons?.length ? { reply_markup: { inline_keyboard: [o.buttons.map(b => ({ text: b.text, callback_data: b.data }))] } } : {}),
      }).then(m => m.message_id, e => { log(`secret reminder to ${chatId}: ${e}`); return null }),
      remove: (chatId, id) => api.deleteMessage(chatId, id).then(() => true, e => { log(`delete ${chatId}/${id}: ${e}`); return false }),
      edit: async (chatId, id, text) => { await api.editMessageText(chatId, id, text, { reply_markup: { inline_keyboard: [] } }) },
      async canDelete(chatId, type) {
        if (type === 'private') return true
        if (!h.info) return false
        const m = await api.getChatMember(chatId, h.info.id).catch(() => null) as { status: string; can_delete_messages?: boolean } | null
        return !!m && (m.status === 'creator' || (m.status === 'administrator' && !!m.can_delete_messages))
      },
    }
  },
  verifyBot: t => commandDeps.verifyBot(t),
  ask: claudeAsk({ claudeBin: cfg.claudeBin, launch: launcher, model: () => cfg.model, cwd: (mkdirSync(join(cfg.stateDir, 'review'), { recursive: true }), join(cfg.stateDir, 'review')) }),
  model: () => cfg.model,
  secretDeps: { cfg, db, loadAccess, verifyBot: t => commandDeps.verifyBot(t) },
  rawDir: join(cfg.stateDir, 'raw'),
  notice: (bot, text) => postNotice(approvalDeps, bot, text),
  personLabel: uid => personLabel(db, uid),
  chatLabel: (_bot, chatId) => label(chatId),
  served: (type, chatId, uid) => servesChat(loadAccess(), cfg.owners, type, chatId, uid),
  // text attachments are downloaded and checked as they come in (the URL carries the token: never logged)
  async fetchFile(name, fileId) {
    const h = bots.get(name)
    if (!h) throw new Error(`bot ${name} is not running`)
    return fetchBotFile(botFiles(h), fileId)
  },
  cacheDir: join(cfg.stateDir, 'attachments'),
  log,
})

/** Topics added after the first group setups (🔑 密鑰偵測, 🤝 配對申請): created at startup in an approvals group that lacks them. */
const LATER_TOPICS = [
  { field: 'secret_topic', name: SECRET_TOPIC, intro: SECRET_TOPIC_INTRO },
  { field: 'pairing_topic', name: PAIRING_TOPIC, intro: PAIRING_TOPIC_INTRO },
] as const

async function ensureLaterTopics(bot: string): Promise<void> {
  for (const t of LATER_TOPICS) {
    const s = db.getBotSetup(bot)
    const api = bots.get(bot)?.bot.api
    if (!s?.approvals_chat || s[t.field] || !api) continue
    const id = (await api.createForumTopic(s.approvals_chat, t.name)).message_thread_id
    db.updateBotSetup(bot, { [t.field]: id })
    await approvalDeps.send(bot, { chat_id: s.approvals_chat, thread_id: id }, t.intro, [])
    log(`${bot}: created topic ${t.name} in the approvals group`)
  }
}

/** Group setup: /router setup group, run in the forum group itself. The reply is HTML (the bot settings notice). */
async function setupGroup(bot: string, chatId: string): Promise<string> {
  const h = bots.get(bot)
  if (!h?.info) return escHtml('bot 還沒啟動完成, 稍後再試')
  const chat = await h.bot.api.getChat(chatId).catch(() => null)
  if (!chat) return escHtml('查不到這個群組')
  const member = await h.bot.api.getChatMember(chatId, h.info.id).catch(() => null)
  const check = checkGroup(chat as { type: string; is_forum?: boolean }, member as { status: string; can_manage_topics?: boolean } | null)
  // the bot settings notice either way: privacy matters for every group, not only the approvals one
  if (!check.ok) return `⛔ ${escHtml(check.reason)}\n\n${botSettingsNotice(meOf.get(bot) ?? h.info)}`
  const s = db.getBotSetup(bot)
  const same = s?.approvals_chat === chatId
  const reuse = same && !!s.notices_topic && !!s.approvals_topic && !!s.elevlog_topic && !!s.authuse_topic && !!s.secret_topic && !!s.pairing_topic
  const topic = async (have: number | null | undefined, name: string) => (same && have) ? have : (await h.bot.api.createForumTopic(chatId, name)).message_thread_id
  const notices = await topic(s?.notices_topic, '🔔 重要通知')
  const approvals = await topic(s?.approvals_topic, '🔐 權限審核')
  const elevlog = await topic(s?.elevlog_topic, '📜 提權紀錄')
  const authuse = await topic(s?.authuse_topic, '🧾 執行授權')
  const secret = await topic(s?.secret_topic, SECRET_TOPIC)
  const pairing = await topic(s?.pairing_topic, PAIRING_TOPIC)
  const fresh = (have: number | null | undefined) => !(same && have)
  db.updateBotSetup(bot, { approvals_chat: chatId, notices_topic: notices, approvals_topic: approvals, elevlog_topic: elevlog, authuse_topic: authuse, secret_topic: secret, pairing_topic: pairing, group_skipped: 0 })
  if (fresh(s?.authuse_topic)) await approvalDeps.send(bot, { chat_id: chatId, thread_id: authuse }, '執行授權: 每一次動用已核准的權限 (提權的 subagent, 永久允許的動作, 跨對話傳訊, 已核准的套件) 都會記在這裡, 附工具呼叫內容與 🚫 撤銷 按鈕.', [])
  if (fresh(s?.secret_topic)) await approvalDeps.send(bot, { chat_id: chatId, thread_id: secret }, SECRET_TOPIC_INTRO, [])
  if (fresh(s?.pairing_topic)) await approvalDeps.send(bot, { chat_id: chatId, thread_id: pairing }, PAIRING_TOPIC_INTRO, [])
  if (!reuse) {
    await approvalDeps.send(bot, { chat_id: chatId, thread_id: notices }, '這裡會收到重要通知: 新對話, worker 叫不醒等.', [])
    await approvalDeps.send(bot, { chat_id: chatId, thread_id: approvals }, '這裡會收到權限申請: 跨對話傳訊, 套件安裝, 向 owner 的提權申請. owner 與 admin 可以按允許或拒絕.', [])
    await approvalDeps.send(bot, { chat_id: chatId, thread_id: elevlog }, '提權紀錄: 所有被擋下的動作, 所有提權請求 (主動或被動), 以及提權成功 (附原始請求的連結).', [])
  }
  return `${escHtml(`✅ 審核群組設定完成${reuse ? ' (沿用既有話題)' : ''}: 重要通知與權限申請之後都送到這個群組的話題`)}\n\n${botSettingsNotice(meOf.get(bot) ?? h.info)}`
}

/** A message gate() delivered: queue it for its conversation and make sure a worker picks it up. */
function onChannel(botName: string, params: ChannelParams): void {
  const chat_id = params.meta.chat_id
  if (!chat_id) return
  const seen = chats.get(chat_id)
  let conv = ensureConversation(cfg, db, botName, chat_id, seen?.type, c => {
    if (seen?.title) c = db.updateConversation(c.key, { title: seen.title })
    settingsFor(c)
    ctxFile(c)
    log(`new conversation ${c.key} (${c.role})`)
    void postNotice(approvalDeps, botName, `🆕 新對話 ${c.key}${seen?.title ? ` (${seen.title})` : ''}, 角色 ${c.role}`)
  })
  if (seen?.title && seen.title !== conv.title) {
    conv = db.updateConversation(conv.key, { title: seen.title })
    ctxFile(conv)
  }
  // Photos are downloaded into the router's inbox, which workers cannot
  // read; move them into the conversation's own attachments folder.
  if (params.meta.image_path) {
    const dest = join(conv.folder, 'attachments', basename(params.meta.image_path))
    try {
      mkdirSync(dirname(dest), { recursive: true })
      try { renameSync(params.meta.image_path, dest) } catch { copyFileSync(params.meta.image_path, dest) }
      params.meta.image_path = dest
    } catch (e) { log(`move image for ${conv.key} failed: ${e}`) }
  }
  // reactions kept since the last message ride in front of this one
  const block = reactions.take(conv.key)
  if (block) params = { ...params, content: `${block}\n${params.content}` }
  db.enqueue(conv.key, params)
  if (ipc.isConnected(conv.key)) ipc.pushQueue(conv.key)
  else void supervisor.ensureAwake(conv)
}

/** The bot's own messages, for receiveReact botself_only; a failed write never fails the call that sent them. */
function noteSent(bot: string, method: string, payload: unknown, res: unknown): void {
  try { db.noteBotMessages(bot, method, payload, res) } catch (e) { log(`bot_messages ${bot} ${method}: ${e}`) }
}

/** Set once shutdown() starts. */
let stopping = false

/** A conversation's reactions as a router delivery of their own: pushed to a
 *  connected worker, otherwise queued and the worker woken (not while
 *  stopping: the backlog sweep after the next start wakes it). */
function handOverReactions(key: string, block: string): { qid: number; live: boolean } | null {
  const c = db.getConversation(key)
  if (!c) return null
  log(`reactions ${key}: handed over alone`)
  const qid = db.enqueue(c.key, { content: block, meta: { chat_id: c.chat_id, user: 'router', kind: 'reactions', ts: iso8() } })
  const live = ipc.isConnected(c.key)
  if (live) ipc.pushQueue(c.key)
  else if (!stopping) void supervisor.ensureAwake(c)
  return { qid, live }
}

/** Message reactions kept per conversation until its next message, or a minute without more (router/reactions.ts). */
const reactions = createReactionBuffer({
  flushMs: cfg.reactFlushMs,
  onFlush(key, block) { handOverReactions(key, block) },
})

/** A message_reaction update: kept for the conversation's worker when its receiveReact mode wants it. */
function onReaction(botName: string, u: import('grammy/types').MessageReactionUpdated): void {
  const chatId = String(u.chat.id)
  const conv = db.findConversation(botName, chatId)
  const who = reactor(u)
  if (!conv || !who) return
  // the same people whose messages reach the worker (a DM's allowFrom, a group's allowFrom)
  if (!servesChat(loadAccess(), cfg.owners, u.chat.type, chatId, who.id)) return
  const mode = (conv.react ?? cfg.receiveReact) as ReactMode
  const ownMessage = () => db.isBotMessage(botName, chatId, u.message_id) || store.forBot(botName).lookup(chatId, String(u.message_id))?.direction === 'out'
  if (!wanted(mode, ownMessage)) return
  reactions.add(conv.key, { messageId: u.message_id, actorId: who.id, actorName: who.name, reactions: u.new_reaction.map(reactionLabel) })
}

/** grammY's options for a Bot API server (default: the official one). */
function apiOpts(root: string = cfg.apiRoot ?? OFFICIAL_API_ROOT) {
  return root !== OFFICIAL_API_ROOT ? { client: { apiRoot: root } } : undefined
}

/** How a bot's attachments are fetched: its own Bot API server, from disk in --local mode (router/telegram/files.ts). */
function botFiles(h: BotHandle) {
  return { getFile: (id: string) => h.bot.api.getFile(id), token: h.cfg.token, apiRoot: botApiRoot(cfg, h.cfg), localFilesDir: h.cfg.localFilesDir, forbidden: [cfg.stateDir, cfg.home] }
}

// /router cred add for a name that exists: the new value waits here for 覆蓋 or 取消 (router memory only)
const credStaging = createCredStaging({
  onExpire: s => {
    if (s.messageId == null) return
    void bots.get(s.bot)?.bot.api.editMessageText(s.chatId, s.messageId, `已逾時, 沒有覆蓋憑證 ${s.name}, 新的值已丟棄. 要覆蓋請重新 /router cred add`, { reply_markup: { inline_keyboard: [] } }).catch(() => {})
  },
})

const commandDeps: CommandDeps = {
  pairingApprovals: approvalDeps,
  journal: log,
  cfg, db, loadAccess, saveAccess, writeConfig, startedAt,
  bots: {
    async list() {
      return [...bots.values()].map(h => ({ name: h.cfg.name, id: h.info?.id ?? null, username: h.info?.username ?? null, first_name: h.info?.first_name ?? null, poll: describePoll(h.poller.state()) }))
    },
    async add(name, token) {
      if (bots.has(name)) throw new Error(`已經有名為 ${name} 的 bot`)
      const me = await new Bot(token, apiOpts()).api.getMe()
      // the setup under this name is kept only for the same bot (router/setup.ts)
      const hadFolder = existsSync(join(cfg.home, `bot${me.id}`))
      const bc = { name, token }
      writeConfig(r => { (r.bots as BotConfig[]).push(bc) })
      cfg.bots.push(bc)
      ensureBotDir(cfg, name)
      const setup = adoptBotSetup(db, name, String(me.id), hadFolder)
      if (setup === 'reset') log(`bot add ${name}: another bot (${me.id}) than the setup's, setup starts over`)
      meOf.set(name, me)
      startBot(bc).info = me
      return me.username
    },
    async rotate(name, token) {
      const old = bots.get(name)
      if (!old) throw new Error(`沒有名為 ${name} 的 bot`)
      const me = await new Bot(token, apiOpts(botApiRoot(cfg, old.cfg))).api.getMe()
      // the same bot: its id from getMe, or from the old token when getMe is not in yet
      const oldId = old.info ? String(old.info.id) : tokenBotId(old.cfg.token)
      if (oldId && String(me.id) !== oldId) throw new Error(`新 token 屬於另一隻 bot (@${me.username}), rotate 只能換同一隻 bot 的 token`)
      // only the token changes: its apiRoot and localFilesDir stay
      const bc = { ...old.cfg, token }
      writeConfig(r => { r.bots = (r.bots as BotConfig[]).map(b => b.name === name ? { ...b, token } : b) })
      cfg.bots.splice(cfg.bots.findIndex(b => b.name === name), 1, bc)
      // Old poller stops first: Telegram allows one getUpdates consumer per bot.
      await old.stop().catch(() => {})
      meOf.set(name, me)
      startBot(bc).info = me
      return me.username
    },
    async remove(name) {
      const h = bots.get(name)
      if (!h) throw new Error(`沒有名為 ${name} 的 bot`)
      if (cfg.bots.length === 1) throw new Error('不能移除最後一隻 bot')
      await h.stop().catch(() => {})
      bots.delete(name)
      writeConfig(r => { r.bots = (r.bots as BotConfig[]).filter(b => b.name !== name) })
      cfg.bots.splice(cfg.bots.findIndex(b => b.name === name), 1)
    },
  },
  sessions: {
    isConnected: ipc.isConnected,
    restart: (c, opts) => supervisor.restart(c, opts),
    stop: c => supervisor.stop(c),
    rotateNow: () => void rotate(),
    // cli session send (router/sessionsend.ts): queued like the router's own notices, woken when asleep
    send: (c, text) => notifyConversation(c, text),
    delivered: qid => db.queueStatus(qid) === 'acked',
    // /router status: the daemon's state of each worker and its last trouble (router/diagnose.ts)
    async health() {
      const agents = await supervisor.listAgents().catch(() => [])
      const jobs = listJobs(JOBS_DIR)
      const out = new Map<string, string[]>()
      for (const c of db.listConversations()) {
        const a = agents.find(x => c.session_id && x.sessionId === c.session_id)
        const parts: string[] = []
        const note = workerStateNote(a, jobs)
        if (note) parts.push(note)
        if (a && a.pid != null && a.status != null && !ipc.isConnected(c.key)) parts.push('worker 在跑但 plugin 沒連上')
        const t = lastTrouble.get(c.key)
        if (t && Date.now() - t.at < 86_400_000) parts.push(`⚠️ ${gmt8(new Date(t.at)).slice(11, 16)} ${t.text}`)
        if (parts.length) out.set(c.key, parts)
      }
      return out
    },
    doctor: async () => doctorReport({ cfg, conversations: db.listConversations(), agents: await supervisor.listAgents().catch(() => null), isConnected: ipc.isConnected, version: pkg.version, ...daemonInputs(cfg.claudeBin, JOBS_DIR), channel: { ...channel, check: daemonKeeper ? daemonKeeper.check() : null } }),
  },
  async applySettings(c, opts) {
    settingsFor(c)
    ctxFile(c)
    if (await supervisor.liveJob(c)) await supervisor.restart(c, opts)
    else if (opts.dropJob) await supervisor.stop(c, opts)
  },
  applyPermissions(c) {
    settingsFor(c)
    ctxFile(c)
    db.setRotate(c.key, true)
    void rotate()
  },
  // /secret set of a telegram-bot secret: it has to be a bot token (router/secrets.ts)
  async verifyBot(token) {
    const r = await botApiCall({ apiRoot: cfg.apiRoot, token, method: 'getMe', params: {} }).catch(() => ({ ok: false, error_code: 0, description: '連不上 Telegram' }))
    if (!r.ok || !r.result?.is_bot) throw new Error(r.ok ? '不是 bot' : `${r.error_code ?? ''}: ${r.description}`.replace(/^: /, ''))
    return `@${r.result.username} (${r.result.id})`
  },
  botNotice: name => botSettingsNotice(meOf.get(name) ?? null),
  creds: {
    async add(name, token, methods, addedBy, http) {
      let label: string
      if (http) label = `http ${http.baseUrl}`
      else { const me = await new Bot(token, apiOpts()).api.getMe(); label = `@${me.username} (${me.id})` }
      const c = { token, label, methods, roles: DEFAULT_CRED_ROLES, addedBy, ...(http ? { kind: 'http' as const, ...http } : {}) }
      writeConfig(r => { r.credentials = { ...(r.credentials as object ?? {}), [name]: c } })
      cfg.credentials[name] = c
      return label
    },
    async rotate(name, token, defaultHeaders) {
      const old = cfg.credentials[name]
      if (!old) throw new Error(`沒有名為 ${name} 的憑證`)
      // a bot token is checked with getMe before anything changes
      let label = old.label
      if (old.kind !== 'http') { const me = await new Bot(token, apiOpts(credApiRoot(cfg, old))).api.getMe(); label = `@${me.username} (${me.id})` }
      const change = (c: Record<string, any>) => {
        c.token = token
        if (label) c.label = label
        if (defaultHeaders) { const h = { ...c.defaultHeaders }; for (const [k, v] of Object.entries(defaultHeaders)) setHeader(h, k, v); c.defaultHeaders = h }
      }
      writeConfig(r => { change((r.credentials as Record<string, any>)[name]) })
      change(old)
      return label ?? name
    },
    staging: credStaging,
    update(name, change) {
      writeConfig(r => {
        const all = (r.credentials ?? {}) as Record<string, any>
        if (change) change(all[name]); else delete all[name]
        r.credentials = all
      })
      if (change) change(cfg.credentials[name]!); else delete cfg.credentials[name]
    },
    reload() {
      cfg.credentials = JSON.parse(readFileSync(configPath, 'utf8')).credentials ?? {}
      return Object.keys(cfg.credentials).length
    },
    async call(name, method, params, files) {
      const cred = cfg.credentials[name]
      const token = cred?.token ?? cfg.bots.find(b => b.name === name)?.token
      if (!token) throw new Error(`沒有名為 ${name} 的憑證或 bot`)
      const res = await botApiCall({ apiRoot: cred ? credApiRoot(cfg, cred) : botApiRoot(cfg, name), token, method, params, files })
      db.logApiCall(`cred:${name}`, method, { params, files }, res, res.ok ? null : `${res.error_code ?? ''}: ${res.description}`, 'terminal')
      return res
    },
  },
  skills: {
    list(bot) {
      const rows: string[] = []
      for (const [scope, base] of [['這隻 bot', botDir(cfg, bot)], ['全部 bot', cfg.home]] as const) {
        const root = join(base, '.claude', 'skills')
        if (!existsSync(root)) continue
        for (const name of readdirSync(root)) {
          const dir = join(root, name)
          try { if (!loadManifest(dir)) continue } catch (e) { rows.push(`${name} (${scope}): privileged.json 有誤: ${e instanceof Error ? e.message : e}`); continue }
          const a = db.skillApproval(dir)
          const state = !a ? '未核准' : a.hash === hashSkill(dir) ? `已核准 (${a.approved_by})` : '核准後被改過, 暫停中'
          rows.push(`${name} (${scope}): ${state}`)
        }
      }
      return rows.join('\n') || '沒有帶 privileged.json 的技能'
    },
    async approve(bot, name, by, role, code) {
      const dir = skillDirs({ home: cfg.home, botDir: b => botDir(cfg, b) }, bot, name)[0]
      if (!dir) return { text: `找不到帶 privileged.json 的技能 ${name} (只看這隻 bot 與全部 bot 範圍)` }
      // the screen, the uv.lock review (pkgreview's model and cache), the environment, then the approval (router/skillapprove.ts)
      return approveSkill({ db, review: pkgs => pkgGate.review(pkgs), env: envDeps }, dir, name, by, role, code)
    },
    revoke(bot, name) {
      const dir = skillDirs({ home: cfg.home, botDir: b => botDir(cfg, b) }, bot, name)[0]
      return dir && db.revokeSkill(dir) ? `已撤銷技能 ${name} 的特權動作` : `技能 ${name} 沒有核准紀錄`
    },
    run: (conv, o) => terminalRun(skillDeps, conv, o, {
      home: cfg.home, stateDir: cfg.stateDir, storeRoot: skillDeps.storeRoot!,
      protectedDirs: [...cfg.bots.map(b => botDir(cfg, b.name)), ...db.listConversations().map(c => c.folder)],
    }),
    refresh: skill => terminalRefresh(refreshDeps, skill, refreshQueue),
  },
  setup: {
    describe: bot => describeSetup(db.getBotSetup(bot), cfg.owners[0]),
    skip(bot) { db.updateBotSetup(bot, { group_skipped: 1, approvals_chat: null, approvals_topic: null, notices_topic: null }) },
    resetPersona(bot) { db.updateBotSetup(bot, { persona_done: 0 }) },
    group: setupGroup,
  },
  events: { rawToFile: id => vault.rawToFile(id) },
  classifier: { report: (days, qv) => classifierReport(classifyStore, days, new Date(), classifierCfg().enabled, qv), show: id => classifierShow(classifyStore, id) },
  overridesRemoved: (c, uid) => authz.syncRemoved(c, uid),
  effectiveSettings: c => applyOverrides(renderSettings(TEMPLATES, c.role, settingsVars(c)), overridesOf(c)),
  sandboxStatus: () => `${describeLimitMode(limitMode())}\n工具箱:\n${describeToolbox(toolboxDir(cfg.stateDir))}`,
  async sendTo(botName, chatId, text) {
    await bots.get(botName)?.bot.api.sendMessage(chatId, text)
  },
  async botIsAdmin(botName, chatId) {
    const h = bots.get(botName)
    if (!h?.info) return null
    const m = await h.bot.api.getChatMember(chatId, h.info.id).catch(() => null)
    return m ? m.status === 'administrator' || m.status === 'creator' : null
  },
  recentMessages: (bot, chatId, n) => store.forBot(bot).recent(chatId, n),
  restartRouter(by) {
    // Under systemd (Restart=always) exiting is enough; otherwise start a
    // detached copy of ourselves once the lock is released.
    setTimeout(() => void shutdown('/restart', !process.env.INVOCATION_ID, { restart: true, by }), 500)
  },
}

const exec: Exec = async (args, env) => {
  const p = Bun.spawn(args, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
  const stdout = await new Response(p.stdout).text()
  return { code: await p.exited, stdout }
}

/** Run a /router (or /restart, /id) command and send its reply: listings to
 *  the sender's DM when asked in a group, long ones in parts. Also used for
 *  「cc /router ...」. */
async function answerCommand(bot: Bot, input: CommandInput & { messageId: number; eventId?: number }): Promise<void> {
  const chatId = input.chatId, messageId = input.messageId, senderId = input.senderId
  const out = await runCommand(input, commandDeps)
  if (!out) return
  for (const l of out.logs) db.addLog(l.conv, l.text)
  let reply = out.reply
  // a registration command: deleted 60 seconds after this answer in a DM
  // unless its sender, an owner or an admin cancels, 10 seconds in a group
  // (rawvault scheduleCommand); a refusal at once
  const later = !!out.deleteMessage && !!out.deleteLater
  if (out.deleteMessage && !later) {
    // Say what actually happened: in a group the bot can only delete
    // other people's messages when it is an admin there.
    const ok = await bot.api.deleteMessage(chatId, messageId).then(() => true, e => { log(`delete command message failed: ${e}`); return false })
    const what = out.deleteLabel ?? '含 token 的訊息'
    const note = ok ? `\n已刪除${what}` : `\n⚠️ 無法刪除${what} (bot 沒有刪除權限), 請${out.deleteLabel ? '自己刪掉那則訊息' : '手動刪除'}`
    reply += out.html ? escHtml(note) : note
  }
  // Listings name other conversations and people: in a group they go to
  // the sender's DM, the group only hears that they were sent.
  const toDm = out.private && input.chatType !== 'private'
  const target = toDm ? senderId : String(chatId)
  // Long listings (log, chat) can exceed Telegram's 4096 per message.
  const head = toDm ? `(${input.text.trim()} 的結果, 來自群組 ${chats.get(String(chatId))?.title ?? chatId})\n` : ''
  const parts = chunk(`${out.html ? escHtml(head) : head}${reply}`, 4000, 'newline')
  let sent = true, lastId: number | null = null
  for (let i = 0; i < parts.length && sent; i++) {
    // buttons (覆蓋 / 取消) under the last part
    const markup = out.buttons?.length && i === parts.length - 1 ? { reply_markup: { inline_keyboard: [out.buttons.map(b => ({ text: b.text, callback_data: b.data }))] } } : {}
    const part = (t: string, html: boolean) => bot.api.sendMessage(target, t, { ...(html ? { parse_mode: 'HTML' as const } : {}), ...(!toDm && i === 0 ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {}), ...markup })
    // network errors, 5xx and 429 are tried again within a minute; HTML refused: once more as plain text (router/sendretry.ts)
    sent = await sendWithRetry(() => out.html ? htmlOrPlain(() => part(parts[i]!, true), () => part(htmlToText(parts[i]!), false), { what: 'command reply', log }) : part(parts[i]!, false), { what: 'command reply', log })
      .then(m => { lastId = (m as { message_id?: number } | undefined)?.message_id ?? null; return true }, () => false)
  }
  // the question an expiry edits
  if (out.staged != null && lastId != null) credStaging.attach(out.staged, lastId)
  if (later) await vault.scheduleCommand(input.bot, { chatId, chatType: input.chatType, messageId, senderId, eventId: input.eventId ?? null }).catch(e => log(`command message deletion: ${e}`))
  if (toDm) {
    await sendWithRetry(() => bot.api.sendMessage(chatId, sent ? '已私訊給你' : '⛔ 這個指令的結果只會私訊給你, 但我私訊不到你. 請先私訊我一次 (例如 /start) 再試', { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } }), { what: 'command reply', log }).catch(() => {})
  }
  out.after?.()
}

async function handleRelay(botName: string, chatId: string, chatType: string, senderId: string, senderName: string, messageId: number, rel: RelayCmd): Promise<void> {
  const bot = bots.get(botName)!.bot
  const api = bot.api
  const replyOpts = { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } }
  const reply = (text: string, md = false) => api.sendMessage(chatId, text, { ...replyOpts, ...(md ? { parse_mode: 'MarkdownV2' as const } : {}) }).catch(e => log(`relay reply failed: ${e}`))
  // the router's own commands are answered as if typed directly
  if (!rel.raw && ROUTER_CMDS.has(rel.cmd)) {
    await answerCommand(bot, { bot: botName, text: `${rel.cmd}${rel.args ? ' ' + rel.args : ''}`, senderId, senderName, chatId, chatType, messageId, botUsername: bots.get(botName)?.info?.username })
    return
  }
  const role = roleOf(commandDeps, senderId)
  const conv = db.findConversation(botName, chatId)
  const who = `${senderName}(${role})`
  const shown = `${rel.raw ? '/' : ''}${rel.cmd}${rel.args ? ' ' + rel.args : ''}`
  // a raw screenshot shows what the report scripts filter out (email, session id): owner/admin only
  if (!mayRelay(role, rel.raw ? '//' : rel.cmd, chatType)) {
    const why = `⛔ 代打 ${shown} 只開放 owner 與 admin${chatType === 'private' ? '' : ' (群組裡所有人都能用 cc /status 與 cc /usage)'}, 你的角色是 ${role}`
    if (conv) db.addLog(conv.key, `${who} cc ${shown} → ${why}`)
    await reply(why)
    return
  }
  if (!conv) { await reply('這個對話還沒有 worker, 先傳一則一般訊息給我'); return }
  try {
    await supervisor.ensureAwake(conv)
    const job = await supervisor.liveJob(db.getConversation(conv.key)!)
    if (!job) { await reply('叫不醒這個對話的 worker'); return }
    if (!rel.raw && job.status === 'busy') { await reply(`這個對話的分身正在處理中, 等這一輪結束再試 (要看當下的畫面可以用 cc /${rel.cmd})`); return }
    const out = await callConv.run(conv.key, () => relay({ exec, stateDir: cfg.stateDir, claudeBin: cfg.claudeBin, attachCmd: id => shellLine(launcher, ['attach', id]), scriptsDir: SCRIPTS_DIR, now: () => gmt8(new Date()) }, job.id, rel))
    db.addLog(conv.key, `${who} 代打 ${shown}`)
    if (out.kind === 'text') { await reply(codeBlock(out.text), true); return }
    if (out.kind === 'photo') {
      const caption = codeBlock(out.text)
      const fits = caption.length <= 1000
      await api.sendPhoto(chatId, new InputFile(out.path), { ...replyOpts, ...(fits ? { caption, parse_mode: 'MarkdownV2' as const } : {}) }).catch(e => log(`relay photo failed: ${e}`))
      if (!fits) await reply(caption, true)
      return
    }
    // anything else: the worker tidies the cut-out output up and replies (v1 style)
    replyNext.set(conv.key, messageId)
    const since = new Date().toISOString()
    notifyConversation(conv, `<relay_result cmd="${rel.cmd}" message_id="${messageId}">\n${who} 用「cc ${shown}」代打了這個指令, router 已在終端機執行完. 下面是畫面上這個指令的輸出 (已去掉前後的對話內容):\n\n${out.output}\n\n用 /telegram:format 整理成簡短易讀的回覆 (重點與數字, 需要對齊的放 code block), reply_to ${messageId}. 不要原封貼畫面, 也不要再執行一次這個指令.\n</relay_result>`)
    setTimeout(() => {
      const replied = db.recentOutbound(conv.key, 30).some(r => {
        if (r.ts <= since || r.method !== 'sendMessage') return false
        const p = JSON.parse(r.payload_json ?? '{}')
        return String(p.chat_id) === chatId && !String(p.text ?? '').startsWith('🤔')
      })
      if (!replied) void reply(codeBlock(`(分身沒有在 90 秒內整理, 以下是 ${shown} 的原始輸出)\n\n${out.output}`), true)
    }, 90_000)
  } catch (e) {
    await reply(`代打 ${shown} 失敗: ${e}`)
  }
}

/** Keep the people table current; refresh the profile photo at most daily. */
function notePerson(bot: Bot, from: { id: number; first_name: string; last_name?: string; username?: string }, chatId: string | null): void {
  const uid = String(from.id)
  const p = db.seePerson({ uid, name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null, username: from.username ?? null, chat_id: chatId })
  if (p.photo_checked_at && Date.now() - Date.parse(p.photo_checked_at) < 86_400_000) return
  db.setPersonPhoto(uid, p.photo_file_id) // mark checked now, whatever happens next
  void bot.api.getUserProfilePhotos(from.id, { limit: 1 }).then(r => {
    const sizes = r.photos[0]
    db.setPersonPhoto(uid, sizes?.length ? sizes[sizes.length - 1]!.file_id : null)
  }).catch(() => {})
}

/** A bot's polling trouble (router/poller.ts) to the owner, through another
 *  bot that still works (its notices topic or the owner's DM); a recovery
 *  may go through the bot itself. None left: only the log. */
function pollNotice(name: string, e: PollEvent): void {
  const text = pollNoticeText(name, bots.get(name)?.info?.username ?? null, e, cfg.bots.length)
  log(`${name}: ${text.split('\n')[0]}`)
  const via = noticeVia(name, e.kind, cfg.bots.map(b => ({ name: b.name, ok: bots.get(b.name)?.poller.state().kind === 'ok' })))
  void (async () => {
    for (const b of via) if (await postNotice(approvalDeps, b, text).catch(() => false)) return
    log(`${name}: polling notice reached no one (no bot that can send, or no owner to send to)`)
  })()
}

function startBot(bc: BotConfig): BotHandle {
  const bot = new Bot(bc.token, apiOpts(botApiRoot(cfg, bc)))
  const h = { cfg: bc, bot, info: null } as BotHandle
  bots.set(bc.name, h)

  bot.api.config.use(async (prev, method, payload, signal) => {
    try {
      const res = await prev(method, payload, signal)
      const apiErr = res.ok ? null : `${res.error_code}: ${res.description}`
      if (method !== 'getUpdates') db.logApiCall(bc.name, method, payload, res, apiErr, callConv.getStore() ?? null)
      noteSent(bc.name, method, payload, res)
      return res
    } catch (e) {
      db.logApiCall(bc.name, method, payload, undefined, String(e), callConv.getStore() ?? null)
      throw e
    }
  })
  // plan 10e: every update masked into events (the original sealed in
  // event_raw) and each detection recorded in 🔑 密鑰偵測; the handlers below
  // say whether the router took it as a command (secretOf).
  bot.use(async (ctx, next) => {
    const rec = vault.record(bc.name, ctx.update)
    let noted = false
    const note = (command: boolean) => {
      if (!rec.findings.length || noted) return
      noted = true
      const chatId = ctx.chat ? String(ctx.chat.id) : null, senderId = ctx.from ? String(ctx.from.id) : null
      const msg = ctx.message ?? ctx.editedMessage
      void vault.detected(bc.name, rec, {
        chatId, chatType: ctx.chat?.type ?? null, messageId: msg?.message_id ?? null, senderId, command,
        served: !!chatId && !!senderId && servesChat(loadAccess(), cfg.owners, ctx.chat!.type, chatId, senderId),
      }).catch(e => log(`secret detection ${rec.id}: ${e}`))
    }
    secretOf.set(ctx, { rec, note })
    // a text attachment is checked as it comes in (plan 10e)
    if (ctx.chat && ctx.from) void vault.prefetch(bc.name, ctx.update, servesChat(loadAccess(), cfg.owners, ctx.chat.type, String(ctx.chat.id), String(ctx.from.id)))
    try { await next() } finally { note(false) }
  })
  bot.use(async (ctx, next) => {
    if (ctx.from) notePerson(bot, ctx.from, ctx.chat ? String(ctx.chat.id) : null)
    if (ctx.chat) {
      const title = ctx.chat.type === 'private'
        ? [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null
        : ('title' in ctx.chat ? ctx.chat.title ?? null : null)
      chats.set(String(ctx.chat.id), { type: ctx.chat.type, title })
      const conv = db.findConversation(bc.name, String(ctx.chat.id))
      if (conv) db.touchConversation(conv.key, ctx.chat.type === 'private' ? null : title)
    }
    // Added to a group: tell the owner what this bot's settings mean there
    // (privacy mode unless it came in as admin, bot-to-bot).
    const mcm = ctx.myChatMember
    if (mcm && (mcm.chat.type === 'group' || mcm.chat.type === 'supergroup') && ['left', 'kicked'].includes(mcm.old_chat_member.status) && ['member', 'administrator', 'restricted'].includes(mcm.new_chat_member.status)) {
      const admin = mcm.new_chat_member.status === 'administrator'
      const notice = [admin ? null : privacyNotice(meOf.get(bc.name) ?? null), B2B_NOTICE].filter(Boolean).join('\n\n')
      // the notices are HTML (bold): the group's title and the bot's name are escaped
      void postNotice(approvalDeps, bc.name, `${escHtml(`➕ @${h.info?.username ?? bc.name} 被加入群組 ${mcm.chat.title ?? mcm.chat.id}${admin ? ' (管理員)' : ''}`)}\n\n${notice}`, { html: true }).catch(e => log(`group join notice: ${e}`))
    }
    // Added to a broadcast channel: not supported (posts only go to events); tell the owner.
    if (mcm && mcm.chat.type === 'channel' && ['left', 'kicked'].includes(mcm.old_chat_member.status) && ['member', 'administrator'].includes(mcm.new_chat_member.status)) {
      void postNotice(approvalDeps, bc.name, channelJoinNotice(h.info?.username ?? bc.name, mcm.chat)).catch(e => log(`channel join notice: ${e}`))
    }
    // Buttons: send grants, package reviews, setup. Each settles every copy itself.
    const data = ctx.callbackQuery?.data
    if (data && ctx.from && /^(grant|pkg|elev|setup|sdel|credow|pair):/.test(data)) {
      const uid = String(ctx.from.id)
      let answer = null as string | null
      // the request message that was pressed: the turn this decision starts mirrors its progress there
      const pressed = ctx.callbackQuery!.message
      const origin = { chatId: String(ctx.chat?.id ?? ''), ...(pressed && 'message_thread_id' in pressed && pressed.message_thread_id ? { thread: pressed.message_thread_id } : {}), ...(pressed ? { replyTo: pressed.message_id } : {}) }
      await decisionOrigin.run(origin, async () => {
        if (data.endsWith(':revoke')) answer = await authz.revoke(data, uid)
        else if (data.startsWith('grant:')) answer = await decideGrant(grantDeps, data, uid, String(ctx.chat?.id ?? ''))
        else if (data.startsWith('pkg:')) answer = await pkgGate.decide(data, uid)
        else if (data.startsWith('elev:')) answer = await elevation.decide(data, uid)
        else if (data.startsWith('sdel:')) answer = await vault.cancel(data, uid)
        else if (data.startsWith('pair:')) answer = await decidePairButton(pairingDeps, data, uid)
        else if (data.startsWith('credow:')) {
          // 覆蓋 / 取消 under a /router cred add for a name that exists
          const r = await decideCredOverwrite(data, uid, commandDeps)
          answer = r.answer
          if (r.text != null) await ctx.editMessageText(r.text, { reply_markup: { inline_keyboard: [] } }).catch(() => {})
        }
      })
      if (data === `setup:${bc.name}:skip`) {
        if (!cfg.owners.includes(uid)) answer = '只有 owner 能決定'
        else {
          commandDeps.setup.skip(bc.name)
          answer = '已略過, 通知與申請都會私訊給你'
          const edited = `${escHtml(GROUP_GUIDE)}\n\n${botSettingsNotice(meOf.get(bc.name) ?? null)}\n\n${escHtml(answer)}`
          await htmlOrPlain(() => ctx.editMessageText(edited, { parse_mode: 'HTML' }), () => ctx.editMessageText(htmlToText(edited)), { what: 'group guide edit', log }).catch(() => {})
        }
      }
      await ctx.answerCallbackQuery({ text: answer ?? '' }).catch(() => {})
      return
    }
    // A router without owners: "/start <code>" in a DM claims it (router/setup.ts).
    if (claimCode && ctx.chat?.type === 'private' && ctx.from && isClaim(ctx.message?.text, claimCode)) {
      const uid = String(ctx.from.id)
      claimCode = null
      writeConfig(r => { r.owners = [uid] })
      cfg.owners.push(uid)
      for (const { conv } of db.syncDmRoles()) commandDeps.applyPermissions(conv)
      const a = loadAccess()
      if (!a.allowFrom.includes(uid)) { a.allowFrom.push(uid); saveAccess(a) }
      log(`owner claimed by ${uid}`)
      await ctx.reply('✅ 你現在是這個 router 的 owner. 傳任何一句話給我, 我們從 bot 的名字與個性開始設定.').catch(() => {})
      return
    }
    const text = ctx.message?.text
    // 「cc /xxx」: type a slash command into this conversation's worker.
    const rel = parseRelay(text)
    if (rel && ctx.chat && ctx.from && loadAccess().allowFrom.concat(Object.keys(loadAccess().groups)).some(x => x === String(ctx.chat!.id) || x === String(ctx.from!.id))) {
      secretOf.get(ctx)?.note(true)
      void handleRelay(bc.name, String(ctx.chat.id), ctx.chat.type, String(ctx.from.id), ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name, ctx.message!.message_id, rel)
      return
    }
    // /router and /restart are the router's own: answered here, never
    // forwarded. Handled off the update loop so a slow command (getMe for a
    // new token, ...) never holds up other chats' messages.
    if (ctx.chat && ctx.from && isCommand(text)) {
      const chatId = ctx.chat.id, messageId = ctx.message!.message_id
      const replied = ctx.message!.reply_to_message
      const senderId = String(ctx.from.id)
      const input = {
        bot: bc.name, text: text!, senderId,
        senderName: ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name,
        chatId: String(chatId), chatType: ctx.chat.type, messageId, botUsername: h.info?.username,
        ...(replied?.from ? { reply: { uid: String(replied.from.id), messageId: replied.message_id } } : {}),
      }
      const sec = secretOf.get(ctx)
      sec?.note(true)
      void answerCommand(bot, { ...input, ...(sec ? { eventId: sec.rec.id } : {}) }).catch(e => log(`command failed: ${e}`))
      return
    }
    // from here on (store, worker) the values are markers with kind and last 4
    { const sec = secretOf.get(ctx); if (sec) vault.maskForWorker(ctx.update, sec.rec) }
    await next()
  })

  const fakeMcp = {
    async notification(n: { method: string; params?: unknown }) {
      if (n.method === 'notifications/claude/channel') onChannel(bc.name, n.params as ChannelParams)
    },
    setNotificationHandler() {},
  }
  const gate = (ctx: InboundContext) => policyGate(ctx, loadAccess(), h.info?.username ?? '', saveAccess, () => randomBytes(3).toString('hex'))
  const dmCommandGate = (ctx: InboundContext) => policyDmCommandGate(ctx, loadAccess(), saveAccess)
  const handleInbound = createHandleInbound({
    gate, bot, mcp: fakeMcp as never, store: store.forBot(bc.name), log: m => log(`${bc.name}: ${m}`),
    // a new pairing code: the request with ✅ 同意 / ❌ 拒絕 goes to the 🤝 配對申請 topic (router/pairing.ts)
    onPairCode: p => {
      const expiresAt = loadAccess().pending[p.code]?.expiresAt ?? Date.now() + 3_600_000
      void postPairingRequest(pairingDeps, { bot: bc.name, ...p, expiresAt }).catch(e => log(`${bc.name}: pairing request: ${e}`))
    },
  })
  registerTransport({ bot, mcp: fakeMcp as never, dmCommandGate, loadAccess, handleInbound, fetchFile: id => fetchBotFile(botFiles(h), id), inboxDir: INBOX })
  bot.on('message_reaction', ctx => onReaction(bc.name, ctx.messageReaction))
  bot.catch(err => log(`${bc.name}: handler error: ${err.error}`))

  // our own long polling with the retry and notice policy (router/poller.ts), at start and later on
  h.poller = createPoller({
    getMe: signal => bot.api.getMe(signal),
    deleteWebhook: signal => bot.api.deleteWebhook({}, signal),
    // message_reaction has to be asked for by name; the rest is what an empty list gives (router/reactions.ts)
    getUpdates: (offset, first, signal) => bot.api.getUpdates({ offset, timeout: 30, ...(first ? { allowed_updates: [...ALLOWED_UPDATES] } : {}) }, signal),
    onInfo: info => {
      bot.botInfo = info
      h.info = info
      meOf.set(bc.name, info)
      // The bot itself never appears as a sender in its own updates; record it so /id shows its name.
      db.seePerson({ uid: String(info.id), name: info.first_name, username: info.username, chat_id: null })
      log(`${bc.name}: polling as @${info.username}`)
      // the first bot that can send: the start's environment checks go out (router/diagnose.ts)
      if (!startupChecked) { startupChecked = true; void startupChecks().catch(e => log(`startup checks: ${e}`)) }
    },
    handle: u => bot.handleUpdate(u),
    notify: e => { if (bots.get(bc.name) === h) pollNotice(bc.name, e) },
    log: m => log(`${bc.name}: ${m}`),
  })
  h.stop = async () => {
    const offset = h.poller.stop()
    // confirm what was handled, like grammY's stop
    if (offset > 0) await bot.api.getUpdates({ offset, limit: 1 }).catch(() => {})
  }
  void h.poller.start().catch(e => log(`${bc.name}: polling ended: ${e}`))
  return h
}

// Conversations from before bot folders (<home>/<key>): stop each worker,
// move the folder and its transcripts to <home>/bot<id>/<type>-<chat>, and
// let the next message resume it there. Done before polling starts.
for (const c of db.listConversations()) {
  if (c.folder === convFolder(cfg, c.bot, c.chat_id, c.type)) continue
  await supervisor.stop(c, { dropJob: true }).catch(e => log(`stop ${c.key} before move: ${e}`))
  const moved = migrateConversation(cfg, db, c, join(launcher.configDir, 'projects'))
  if (moved) { settingsFor(moved); ctxFile(moved); log(`moved ${c.key}: ${c.folder} -> ${moved.folder}`) }
}

// The health endpoint for outside monitors (router/health.ts, docs/operations.md 「健康檢查端點」): optional, loopback only.
// Which workers the daemon runs comes from claude agents, asked at most every 30 seconds.
let daemonRunning: { at: number; keys: Set<string> | null } = { at: 0, keys: null }
let daemonAsking: Promise<Set<string> | null> | null = null
function runningKeys(): Promise<Set<string> | null> {
  if (Date.now() - daemonRunning.at < 30_000) return Promise.resolve(daemonRunning.keys)
  // requests at the same time share one claude agents
  return daemonAsking ??= (async () => {
    const agents = await Promise.race([supervisor.listAgents().catch(() => null), Bun.sleep(5_000).then(() => null)])
    const bySession = new Map(db.listConversations().filter(c => c.session_id).map(c => [c.session_id!, c.key]))
    const keys = agents ? new Set(agents.filter(a => a.sessionId && isRunning(a) && bySession.has(a.sessionId)).map(a => bySession.get(a.sessionId!)!)) : null
    daemonRunning = { at: Date.now(), keys }
    return keys
  })().finally(() => { daemonAsking = null })
}
const health = cfg.health ? startHealthServer(cfg.health, async () => {
  const now = Date.now()
  return healthReport({
    now, version: pkg.version, startedAt: startedAt.getTime(), staleAfterS: cfg.health!.staleAfterS,
    bots: [...bots.values()].map(h => ({ name: h.cfg.name, state: h.poller.state().kind, lastOk: h.poller.lastOk(), since: h.poller.createdAt() })),
    workers: countWorkers(db.listConversations().map(c => c.key), { isConnected: ipc.isConnected, heldUntil: wakes.until, running: await runningKeys(), now }),
    lastWakeFailure,
    channel: { mode: launcher.mode, ...(channel.decision.reason ? { reason: channel.decision.reason } : {}), managedOk: daemonKeeper ? (c => !!c.daemon && !c.bad.length)(daemonKeeper.check()) : null },
  })
}, log) : null

for (const bc of cfg.bots) startBot(bc)
// through that bot to the owner's DM; when it cannot reach the owner (never started by them), through the others
for (const r of setupResets) {
  void (async () => {
    for (const b of [r.name, ...cfg.bots.map(x => x.name).filter(n => n !== r.name)]) if (await postNotice(approvalDeps, b, resetNotice(r)).catch(() => false)) return
    log(`bot ${r.name}: setup reset notice reached no one`)
  })()
}

// 🔑 密鑰偵測 for approvals groups set up before it existed; deletions due
// while the router was down go now, the rest as they come due.
for (const bc of cfg.bots) void ensureLaterTopics(bc.name).catch(e => log(`${bc.name}: approvals group topics: ${e}`))
// pairing codes nobody settled: marked expired, their request messages lose the buttons (router/pairing.ts)
setInterval(() => void expirePairings(pairingDeps).catch(e => log(`pairing expiry: ${e}`)), 60_000).unref()
let vaultTicking = false
const vaultTick = () => {
  if (vaultTicking) return
  vaultTicking = true
  void vault.tick().catch(e => log(`secret deletions: ${e}`)).finally(() => { vaultTicking = false })
}
vaultTick()
setInterval(vaultTick, cfg.vaultTickMs ?? VAULT_TICK_MS).unref()
// kept copies of text attachments unused for 30 days go, at startup and daily
{
  const purge = () => { try { const n = vault.purgeAttachments(); if (n) log(`attachments: removed ${n} kept file(s) unused for 30 days`) } catch (e) { log(`attachment purge: ${e}`) } }
  purge()
  setInterval(purge, 86_400_000).unref()
}

// People seen before the people table existed: fill them in from the event log.
{
  const n = db.backfillPeople()
  if (n) log(`people: backfilled ${n} from the event log`)
}

// Conversations created before titles were tracked (or quiet since): ask
// Telegram once for the group's title.
for (const c of db.listConversations()) {
  if (c.title || c.type === 'dm') continue
  const api = bots.get(c.bot)?.bot.api
  if (!api) continue
  void api.getChat(c.chat_id).then(ch => {
    if ('title' in ch && ch.title) { const u = db.updateConversation(c.key, { title: ch.title }); ctxFile(u) }
  }).catch(e => log(`getChat ${c.key}: ${e}`))
}

// A restart (deploy, /restart, crash) drops in-flight progress messages on
// the floor; remove the ones the previous process left in the chats.
{
  const orphans = db.orphanProgress()
  if (orphans.length) {
    log(`removing ${orphans.length} progress message(s) left by the previous run`)
    void progress.cleanup(orphans)
  }
}

// Backlog sweep: anything queued for a conversation whose worker is not
// connected (missed wake, worker reaped mid-delivery) gets another wake.
function sweepBacklog(): void {
  for (const key of db.convsWithBacklog()) {
    if (ipc.isConnected(key)) { ipc.pushQueue(key); continue }
    const c = db.getConversation(key)
    if (c) void supervisor.ensureAwake(c)
  }
}
setInterval(sweepBacklog, 60_000).unref()

// Workers marked by /router session rotate: stop each once it is idle.
let rotating = false
async function rotate(): Promise<void> {
  if (rotating) return
  rotating = true
  try {
    await rotateTick({ db, liveJob: c => supervisor.liveJob(c), stop: c => supervisor.stop(c), ensureAwake: c => supervisor.ensureAwake(c), log })
  } catch (e) { log(`rotate: ${e}`) } finally { rotating = false }
}
setInterval(() => void rotate(), 60_000).unref()
// After a router restart, give already-running workers a moment to
// reconnect before deciding they need waking.
setTimeout(sweepBacklog, cfg.backlogSweepFirstMs ?? BACKLOG_SWEEP_FIRST_MS).unref()
// how privileged sandboxes are limited on this host (a degraded host is said once, here and in /router status)
void primeLimitMode().then(m => log(`skill sandbox: ${describeLimitMode(m)}`))
// Python environments no approved skill uses and unused for 30 days (router/skillenv.ts): at start, then daily.
const pruneSkillEnvs = () => {
  try {
    const inUse = new Set(db.listSkillApprovals().map(x => envNameOf(x.dir, skillDeps.toolbox!)).filter((n): n is string => !!n))
    const gone = pruneEnvs(skillDeps.envRoot!, inUse)
    if (gone.length) log(`skill env: removed ${gone.join(', ')}`)
  } catch (e) { log(`skill env prune: ${e}`) }
}
setTimeout(pruneSkillEnvs, 120_000).unref()
setInterval(pruneSkillEnvs, 86_400_000).unref()
// What every worker needs, checked once at start when the first bot is up (router/diagnose.ts), to 🔔 重要通知 (or the owner's DM):
// bun for the workers' telegram plugin on the router's own PATH (the unit's), home trusted by Claude Code, the model against autoCompactWindow
let startupChecked = false
async function startupChecks(): Promise<void> {
  // every start is announced: the version, and the health endpoint with how far it reaches (router/health.ts)
  const hello = startNotice(pkg.version, cfg.health, !!health, describeMode(channel.decision, channel.shareSessions))
  log(`start notice: ${hello.split('\n').join(' / ')}`)
  await noticeEveryBot(hello).catch(e => log(`start notice: ${e}`))
  const notes: string[] = []
  if (!Bun.which('bun')) notes.push(`⚠️ router 的 PATH 找不到 bun: worker 的 telegram plugin 要用 bun 執行, 每個 worker 都會叫不醒 (plugin did not connect).\n修法: deploy/install.sh unit (把 bun 的資料夾加進 unit 的 PATH), 再 systemctl --user restart cc-telegram-router.\n目前的 PATH: ${process.env.PATH ?? '(空)'}`)
  const projects = readProjects(CLAUDE_JSON)
  if (projects) {
    const t = trustOf(projects, cfg.home, homedir())
    if (!t.trusted) notes.push(`⚠️ router 的 home ${cfg.home} 沒有被 Claude Code 信任: 新的 worker 會起不來 (Workspace not trusted).\n修法: ${trustFix(cfg.home, t)}`)
  } else notes.push(`⚠️ 讀不到 ${CLAUDE_JSON}: 無法確認 home ${cfg.home} 是否被 Claude Code 信任. 在 router 的使用者下互動執行一次 cd ${cfg.home} && claude, 接受信任後 /exit.`)
  const mw = modelWindowNotes(cfg.model, cfg.autoCompactWindow)
  if (mw.length) notes.push(`ℹ️ ${mw.join('\n')}`)
  for (const n of notes) { log(`startup check: ${n.split('\n')[0]}`); await noticeEveryBot(n) }
}
// Privileged skills' credentials refreshed daily (router/skillrefresh.ts); at start, those not refreshed in 24 hours.
if (cfg.skillRefreshAt) {
  const sched = scheduleRefresh(refreshDeps, cfg.skillRefreshAt)
  refreshQueue = sched.enqueue
  log(`skill refresh: daily at ${cfg.skillRefreshAt} GMT+8, next ${gmt8(new Date(sched.next()))}`)
}
if (cfg.pluginCheckAt) {
  const sched = scheduleDaily(cfg.pluginCheckAt, () => { pluginGuard.check('daily') })
  log(`plugin guard: daily at ${cfg.pluginCheckAt} GMT+8, next ${gmt8(new Date(sched.next()))}`)
}


/** systemctl for systemdJob: killed when its time is up. */
const jobRunner: JobRunner = async (args, signal) => {
  const p = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
  signal.addEventListener('abort', () => p.kill(9), { once: true })
  const stdout = await new Response(p.stdout).text()
  return { code: await p.exited, stdout }
}
/** How long the stop notice may hold up a stop. */
const STOP_NOTICE_MS = 5_000
async function shutdown(sig: string, respawn = false, o: { restart?: boolean; by?: string } = {}) {
  if (stopping) return
  stopping = true
  log(`shutdown (${sig})`)
  health?.stop()
  // the stop notice, with who asked, before the bots stop; never longer than STOP_NOTICE_MS.
  // A SIGTERM under systemd: its job for the unit tells a restart from a stop (2 seconds at most).
  const systemd = !!process.env.INVOCATION_ID
  const job = !o.by && sig === 'SIGTERM' && systemd ? await systemdJob(UNIT_NAME, jobRunner) : null
  const bye = stopNotice(pkg.version, !!o.restart || job === 'restart', stopSource({ by: o.by, signal: sig, systemd, job }))
  log(`stop notice: ${bye}`)
  const told = await Promise.race([noticeEveryBot(bye).then(() => true, e => { log(`stop notice: ${e}`); return false }), Bun.sleep(STOP_NOTICE_MS).then(() => false)])
  if (!told) log(`stop notice: not confirmed within ${STOP_NOTICE_MS / 1000}s, stopping anyway`)
  await Promise.allSettled([...bots.values()].map(h => h.stop()))
  // no more updates: reactions still kept go to their workers while the socket is up
  await flushOnStop(reactions.drain(), { handOver: handOverReactions, acked: (key, qid) => !db.undelivered(key).some(r => r.qid === qid), log }).catch(e => log(`reactions at stop: ${e}`))
  ipc.stop()
  elevation.stop()
  reactions.stop()
  try { db.close(); store.close() } catch {}
  release()
  if (respawn) spawn(process.execPath, relaunchArgs(), { detached: true, stdio: 'ignore' }).unref()
  process.exit(0)
}
// One failed Bot API call or a bad message must never take the router (and
// with it every conversation's delivery) down.
process.on('unhandledRejection', e => log(`unhandled rejection: ${e instanceof Error ? e.stack ?? e.message : e}`))
process.on('uncaughtException', e => log(`uncaught exception: ${e.stack ?? e.message}`))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
log(`router up: config ${configPath}, home ${cfg.home}, ${cfg.bots.length} bot(s)`)
// optional settings that were wrong: turned off, the router runs on (config.ts warnings)
for (const w of cfg.warnings ?? []) log(`config.json: ${w}`)
if (claimCode) log(`沒有 owner: 私訊任一隻 bot「/start ${claimCode}」認領 owner (這個碼只在這次執行有效)`)
