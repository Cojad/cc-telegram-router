// 「cc /xxx」slash command relay (plan 10c, 柯姊 2026-10-16). A background
// worker has no terminal to type into, so the router opens one: a hidden,
// one-off tmux session running `claude attach <worker>` on the router's own
// tmux server (TMUX_TMPDIR under stateDir), never the user's.
//
//   cc /router ..., /restart, /id   router commands: never typed into the worker
//   cc /status, /usage              v1's privacy-filtered report scripts
//   cc /context                     the session's own context report + donut chart
//   cc /cost                        the session's own cost section
//   cc /other                       run it, cut out just its output, and hand
//                                   that to the worker to tidy up (v1 style);
//                                   an unknown command is said so directly
//   cc //other                      one-off screenshot: run it, send the screen
//
// Whatever was run, menus and views left open (Esc to close, pick lists) are
// closed before leaving, so the worker never stays blocked on one.

import { mkdirSync } from 'fs'
import { join } from 'path'

export type Exec = (args: string[], env?: Record<string, string>) => Promise<{ code: number; stdout: string }>
export type RelayCmd = { cmd: string; args: string; raw: boolean }
export type RelayOut =
  | { kind: 'text'; text: string }
  | { kind: 'photo'; path: string; text: string }
  | { kind: 'handoff'; output: string }

const RELAY_RE = /^(?:cc|柯柯)\s*(\/\/?)([a-z][\w-]*)(?:\s+([\s\S]*))?$/i

/** These belong to the router: answered as if typed directly, never sent to a terminal. */
export const ROUTER_CMDS = new Set(['/router', '/restart', '/id', '/info'])
/** Commands with a dedicated report (scripts / parsers below). */
export const DEDICATED = new Set(['/status', '/usage', '/context', '/cost'])

/** "cc /x args" or "cc //x args" (raw screenshot). A command that has its
 *  own "/" handling (router command or dedicated report) always gets that,
 *  even when asked with "//" (柯姊 2026-10-16). */
export function parseRelay(text: string | undefined): RelayCmd | null {
  const m = text ? RELAY_RE.exec(text.trim()) : null
  if (!m) return null
  const cmd = `/${m[2]!.toLowerCase()}`
  return { cmd, args: (m[3] ?? '').trim(), raw: m[1] === '//' && !ROUTER_CMDS.has(cmd) && !DEDICATED.has(cmd) }
}

/** owner/admin may relay anything; /status and /usage are open to everyone in groups (v1 rule). */
export function mayRelay(role: string, cmd: string, chatType: string): boolean {
  if (role === 'owner' || role === 'admin') return true
  return (cmd === '/status' || cmd === '/usage') && chatType !== 'private'
}

/** MarkdownV2 code block: inside pre only ` and \ need escaping. */
export function codeBlock(text: string): string {
  return '```\n' + text.replace(/[`\\]/g, m => '\\' + m) + '\n```'
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Poll until the screen is unchanged for quietMs (or maxMs passes); return it. */
export async function settle(capture: () => Promise<string>, quietMs: number, maxMs: number, stepMs = 500): Promise<string> {
  let last = await capture(), since = Date.now()
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    await sleep(stepMs)
    const now = await capture()
    if (now !== last) { last = now; since = Date.now(); continue }
    if (Date.now() - since >= quietMs) break
  }
  return last
}

// --- reading the screen -------------------------------------------------------

const RULE = /^[\s─━▔▁]+$/
/** The last n non-blank-tail lines of a screen (a 50-row pane ends in blank rows). */
export function bottom(screen: string, n = 15): string {
  const lines = screen.split('\n')
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  return lines.slice(-n).join('\n')
}

/** A menu or view waiting for a key (Esc closes it). */
export const MENU_RE = /Esc to (cancel|close|go back|exit)|Enter to (confirm|select)|^\s*❯\s*\d+\.\s/im

/** The screen without the input box and status bar at the bottom. */
export function stripChrome(screen: string): string[] {
  const lines = screen.split('\n').map(l => l.replace(/\s+$/, ''))
  // the input box: a rule line, the ❯ prompt, a rule line, then status lines
  let end = lines.length
  for (let i = lines.length - 1; i >= 1; i--) {
    if (lines[i]!.trim() === '❯' && RULE.test(lines[i - 1]!)) { end = i - 1; break }
  }
  const kept = lines.slice(0, end)
  while (kept.length && (!kept.at(-1)!.trim() || RULE.test(kept.at(-1)!))) kept.pop()
  while (kept.length && !kept[0]!.trim()) kept.shift()
  return kept
}

/** Just the output of `cmd`: what follows its echo ("❯ /cmd ...") in the transcript. */
export function afterEcho(screen: string, cmd: string): string[] | null {
  const lines = stripChrome(screen)
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.replace(/^\s*[❯>]\s*/, '').startsWith(cmd) && /^\s*[❯>]\s/.test(lines[i]!)) { at = i; break }
  if (at < 0) return null
  return lines.slice(at + 1).filter(l => !RULE.test(l))
}

/** A full-screen view (/cost, pickers): from its top border to before the key hints. */
export function viewLines(screen: string): string[] {
  const lines = screen.split('\n').map(l => l.replace(/\s+$/, ''))
  let top = -1
  lines.forEach((l, i) => { if (/^▔{8,}/.test(l)) top = i }) // the view's top border is the last one
  const body = (top >= 0 ? lines.slice(top + 1) : lines).filter(l => !/Esc to (cancel|close|go back|exit)/i.test(l))
  while (body.length && !body.at(-1)!.trim()) body.pop()
  return body
}

/** Drop the common indentation, keep alignment. */
export function dedent(lines: string[]): string {
  const ind = Math.min(...lines.filter(l => l.trim()).map(l => /^\s*/.exec(l)![0].length))
  return lines.map(l => l.slice(Number.isFinite(ind) ? ind : 0)).join('\n').trim()
}

// --- /context -----------------------------------------------------------------

const num = (s: string) => { const m = /^([\d.]+)\s*([km])?$/i.exec(s.trim()); return m ? Number(m[1]) * (m[2]?.toLowerCase() === 'm' ? 1e6 : m[2] ? 1e3 : 1) : NaN }
const short = (n: number) => n >= 1e6 ? `${+(n / 1e6).toFixed(2)}m` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n)

export type ContextReport = { model: string; used: number; total: number; pct: number; categories: Array<[string, number, number]>; window: number | null; extras: string[] }

export function parseContext(lines: string[]): ContextReport | null {
  const text = lines.join('\n')
  const usage = /([\d.]+[km]?)\s*\/\s*([\d.]+[km]?)\s*tokens\s*\((\d+)%\)/i.exec(text)
  if (!usage) return null
  const categories: Array<[string, number, number]> = []
  // the token grid shares lines with the legend: a category name starts with a letter
  for (const m of text.matchAll(/[⛁⛀⛶⛝]\s+([A-Za-z][^:\n⛁⛀⛶⛝]*):\s+([\d.]+[km]?)(?:\s*tokens)?\s*\(([\d.]+)%\)/g)) categories.push([m[1]!.trim(), num(m[2]!), Number(m[3])])
  const window = /Auto-compact window:\s*([\d.]+[km]?)/i.exec(text)
  const extras: string[] = []
  const mcp = /MCP tools[^\n]*\n\s*└\s*(\d+) tools/.exec(text), mem = /Memory files[^\n]*\n\s*└\s*(\d+) files?/.exec(text), sk = /Skills[^\n]*\n\s*└\s*(\d+) skills?/.exec(text)
  if (mcp) extras.push(`MCP 工具 ${mcp[1]} 個`)
  if (mem) extras.push(`記憶檔 ${mem[1]} 個`)
  if (sk) extras.push(`技能 ${sk[1]} 個`)
  return { model: /(claude-[\w.-]+)/.exec(text)?.[1] ?? '?', used: num(usage[1]!), total: num(usage[2]!), pct: Number(usage[3]), categories, window: window ? num(window[1]!) : null, extras }
}

export function renderContext(r: ContextReport, at: string): string {
  const w = Math.max(...r.categories.map(c => c[0].length), 4)
  return [
    `📊 Context 用量 (${at})`,
    `${r.model}: ${short(r.used)} / ${short(r.total)} (${r.pct}%)`,
    '',
    ...r.categories.map(([n, t, p]) => `${n.padEnd(w)}  ${short(t).padStart(7)}  ${p.toFixed(1).padStart(5)}%`),
    '',
    [r.window ? `自動壓縮門檻 ${short(r.window)}` : '', ...r.extras].filter(Boolean).join(' · '),
  ].join('\n').trim()
}

// --- /cost --------------------------------------------------------------------

const COST_LABELS: Record<string, string> = {
  'Total cost': '總花費', 'Total duration (API)': 'API 時間', 'Total duration (wall)': '實際經過時間',
  'Total code changes': '程式碼變更', 'Usage by model': '各模型用量', 'Prompt cache (main)': 'Prompt 快取',
}

/** The "Session" section of the /cost view: this session's own numbers. */
export function parseCost(lines: string[]): string | null {
  const start = lines.findIndex(l => /^\s*Session\s*$/.test(l))
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && /^\s*Current (session|week)/.test(l))
  const body = lines.slice(start + 1, end < 0 ? undefined : end).filter(l => l.trim())
  if (!body.length) return null
  const out = body.map(l => {
    const m = /^(\s*)([^:]+?):(\s*)(.*)$/.exec(l)
    return m && COST_LABELS[m[2]!.trim()] ? `${m[1]}${COST_LABELS[m[2]!.trim()]}:${m[4] ? ` ${m[4]}` : ''}` : l
  })
  return `💵 這個 session 的用量\n\n${dedent(out)}`
}

// --- running --------------------------------------------------------------------

export interface RelayDeps {
  /** Screen must be unchanged this long to count as done (default 3s). */
  settleMs?: number
  maxWaitMs?: number
  exec: Exec
  stateDir: string
  claudeBin: string
  /** ~/.claude/bin, holding tg-status-report.sh, tg-usage-report.sh, tg-context-chart.py */
  scriptsDir: string
  /** Where the /context chart is written. */
  outDir?: string
  /** "2026-10-16 09:40" (GMT+8) */
  now?: () => string
}

export async function relay(deps: RelayDeps, workerId: string, r: RelayCmd): Promise<RelayOut> {
  const env = { TMUX_TMPDIR: join(deps.stateDir, 'tmux') }
  mkdirSync(env.TMUX_TMPDIR, { recursive: true, mode: 0o700 })
  const name = `relay-${workerId}`
  const tmux = (...a: string[]) => deps.exec(['tmux', ...a], env)
  const visible = () => tmux('capture-pane', '-p', '-t', name).then(x => x.stdout)
  const withScroll = () => tmux('capture-pane', '-p', '-t', name, '-S', '-200').then(x => x.stdout)
  await tmux('kill-session', '-t', name)
  await tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '50', `${deps.claudeBin} attach ${workerId}`)
  try {
    let ready = false
    for (let t = 0; t < 15_000 && !ready; t += 300) {
      await sleep(300)
      ready = (await visible()).includes('❯')
    }
    if (!ready) return { kind: 'text', text: '連不上這個 worker 的畫面' }
    if (!r.raw && (r.cmd === '/status' || r.cmd === '/usage')) {
      const script = join(deps.scriptsDir, r.cmd === '/status' ? 'tg-status-report.sh' : 'tg-usage-report.sh')
      const out = await deps.exec([script, name], env)
      return { kind: 'text', text: out.stdout.trim() || `${r.cmd} 沒有輸出` }
    }
    await tmux('send-keys', '-t', name, r.args ? `${r.cmd} ${r.args}` : r.cmd, 'Enter')
    // Some commands run for a while (/compact summarises the whole
    // conversation): wait until the screen stops changing instead of a fixed delay.
    const screen = await settle(r.raw ? visible : withScroll, deps.settleMs ?? 3000, deps.maxWaitMs ?? 120_000)
    if (r.raw) return { kind: 'text', text: stripChrome(screen).slice(-45).join('\n') || `${r.cmd} 沒有輸出` }
    if (/Unknown command:/.test(bottom(screen))) {
      return { kind: 'text', text: `${r.cmd} 不是 Claude Code 的指令. 要看終端機的畫面可以用 cc /${r.cmd}` }
    }
    const view = MENU_RE.test(bottom(screen))
    const lines = view ? viewLines(screen) : (afterEcho(screen, r.cmd) ?? stripChrome(screen).slice(-30))
    if (r.cmd === '/cost') {
      const cost = parseCost(view ? lines : viewLines(screen))
      return { kind: 'text', text: cost ?? dedent(lines) }
    }
    if (r.cmd === '/context') {
      const c = parseContext(lines)
      if (!c) return { kind: 'text', text: dedent(lines) || '/context 沒有輸出' }
      const text = renderContext(c, deps.now?.() ?? '')
      const path = join(deps.outDir ?? env.TMUX_TMPDIR, `context-${workerId}.png`)
      const chart = await deps.exec(['sh', '-c', 'printf "%s" "$TG_CHART_JSON" | python3 "$0" "$1"', join(deps.scriptsDir, 'tg-context-chart.py'), path], { ...env, TG_CHART_JSON: JSON.stringify({ total_tokens: c.total, used_tokens: c.used, pct_used: c.pct, model: c.model, ts_gmt8: `${deps.now?.() ?? ''} GMT+8`, categories: c.categories.map(([n, t]) => [n, t]) }) })
      return chart.code === 0 ? { kind: 'photo', path, text } : { kind: 'text', text }
    }
    return { kind: 'handoff', output: dedent(lines) || `(${r.cmd} 沒有輸出)` }
  } finally {
    // never leave the worker on a menu or a view: close them, then leave
    for (let i = 0; i < 5; i++) {
      const s = await visible()
      if (!MENU_RE.test(bottom(s))) break
      await tmux('send-keys', '-t', name, 'Escape')
      await sleep(600)
    }
    await tmux('kill-session', '-t', name)
  }
}
