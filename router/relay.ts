// 「cc /xxx」slash command relay (plan 01 待驗證 1, 10 Phase 2). A background
// worker has no terminal to type into, so the router opens one: a hidden
// tmux session running `claude attach <worker>`, types the command, captures
// the screen and leaves (the worker keeps running). /status and /usage reuse
// the privacy-filtered report scripts from v1. The tmux server is the
// router's own (TMUX_TMPDIR under stateDir), never the user's.

import { mkdirSync } from 'fs'
import { join } from 'path'

export type Exec = (args: string[], env?: Record<string, string>) => Promise<{ code: number; stdout: string }>

const RELAY_RE = /^(?:cc|柯柯)\s*(\/[a-z][\w-]*)(?:\s+([\s\S]*))?$/i

export function parseRelay(text: string | undefined): { cmd: string; args: string } | null {
  const m = text ? RELAY_RE.exec(text.trim()) : null
  return m ? { cmd: m[1]!.toLowerCase(), args: (m[2] ?? '').trim() } : null
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

export interface RelayDeps {
  /** Screen must be unchanged this long to count as done (default 3s). */
  settleMs?: number
  maxWaitMs?: number
  exec: Exec
  stateDir: string
  claudeBin: string
  /** ~/.claude/bin, holding tg-status-report.sh and tg-usage-report.sh */
  scriptsDir: string
}

export async function relay(deps: RelayDeps, workerId: string, cmd: string, args: string): Promise<string> {
  const env = { TMUX_TMPDIR: join(deps.stateDir, 'tmux') }
  mkdirSync(env.TMUX_TMPDIR, { recursive: true, mode: 0o700 })
  const name = `relay-${workerId}`
  const tmux = (...a: string[]) => deps.exec(['tmux', ...a], env)
  await tmux('kill-session', '-t', name)
  await tmux('new-session', '-d', '-s', name, '-x', '160', '-y', '50', `${deps.claudeBin} attach ${workerId}`)
  try {
    let ready = false
    for (let t = 0; t < 15_000 && !ready; t += 300) {
      await sleep(300)
      ready = (await tmux('capture-pane', '-p', '-t', name)).stdout.includes('❯')
    }
    if (!ready) return '連不上這個 worker 的畫面'
    if (cmd === '/status' || cmd === '/usage') {
      const script = join(deps.scriptsDir, cmd === '/status' ? 'tg-status-report.sh' : 'tg-usage-report.sh')
      const r = await deps.exec([script, name], env)
      return r.stdout.trim() || `${cmd} 沒有輸出`
    }
    await tmux('send-keys', '-t', name, args ? `${cmd} ${args}` : cmd, 'Enter')
    // Some commands run for a while (/compact summarises the whole
    // conversation): wait until the screen stops changing instead of a fixed
    // delay, and never press Esc on something still running, Esc cancels it.
    const out = await settle(() => tmux('capture-pane', '-p', '-t', name, '-S', '-60').then(r => r.stdout), deps.settleMs ?? 3000, deps.maxWaitMs ?? 120_000)
    if (/Esc to (cancel|close|go back|exit)/i.test(out)) await tmux('send-keys', '-t', name, 'Escape')
    const lines = out.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l && !/^[▔▁─━]+$/.test(l))
    return lines.slice(-40).join('\n') || `${cmd} 沒有輸出`
  } finally {
    await tmux('kill-session', '-t', name)
  }
}
