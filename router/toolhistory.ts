// Tool call history (柯姊 2026-10-17: 先觀察日常會用到哪些工具, 不做白名單).
// Every tool call a worker's PreToolUse hook reports to the router is one
// row of router.db tool_history: when, conversation, its role, the elevated
// role when an elevated subagent made it, the tool, the router's decision
// (allow / deny) and, when denied, why. The arguments are not kept (a
// command or a file can hold a key): only SendMessage's recipient, which is
// what matters for cross-session messages. Reasons and recipients are masked
// (router/detect.ts formats) and cut short.
//
// Telegram plugin tools the main session calls never reach the hook (the
// hook leaves them to the router, which runs them): the router records those
// when it runs them, allow or error (error: a refusal or a failed API call).
// Recording never decides anything: a write that fails is only logged.
// Rows older than 30 days are removed at start and once a day.
//
// Report: /router tools [天數] and `cli tools [天數]` (owner, admin).

import type { RouterDb, ToolUse } from './db'
import { detectSecrets } from './detect'
import { gmt8 } from './context'

export const KEEP_DAYS = 30
const REASON_MAX = 160
const TARGET_MAX = 80
const DAY = 86_400_000
const ROLE_ORDER = ['owner', 'admin', 'power', 'user', 'guest']

/** Secrets of known formats replaced, whitespace folded, cut to max. */
export function maskShort(text: string, max: number): string {
  let out = text
  for (const h of detectSecrets(text).reverse()) out = out.slice(0, h.start) + '<已遮蔽>' + out.slice(h.end)
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > max ? out.slice(0, max - 1) + '…' : out
}

export type HookEvent = { tool_name?: unknown; tool_input?: Record<string, any>; agent_id?: unknown }

/** The row for one PreToolUse event and the router's answer. effRole: an elevated subagent's role. */
export function hookUse(conv: { key: string; role: string }, ev: HookEvent, d: { decision?: string; reason?: string }, effRole: string | null): ToolUse {
  const tool = String(ev.tool_name ?? '')
  const deny = d.decision === 'deny'
  return {
    conv: conv.key, conv_role: conv.role, eff_role: effRole, tool,
    decision: deny ? 'deny' : 'allow',
    reason: deny || d.decision === 'allow' ? d.reason ?? null : null,
    target: tool === 'SendMessage' ? String(ev.tool_input?.to ?? ev.tool_input?.recipient ?? '') : null,
    subagent: !!ev.agent_id,
  }
}

export function createToolHistory(deps: { db: RouterDb; log(msg: string): void; now?: () => number }) {
  const now = deps.now ?? Date.now
  return {
    /** Never throws: the hook's answer does not depend on this. */
    record(u: ToolUse): void {
      try {
        deps.db.addToolUse({
          ...u,
          reason: u.reason ? maskShort(u.reason, REASON_MAX) : null,
          target: u.target ? maskShort(u.target, TARGET_MAX) : null,
        })
      } catch (e) { deps.log(`tool_history: ${e}`) }
    },
    /** Rows older than KEEP_DAYS removed; how many. */
    purge(): number {
      try { return deps.db.purgeToolHistory(new Date(now() - KEEP_DAYS * DAY).toISOString()) } catch (e) { deps.log(`tool_history purge: ${e}`); return 0 }
    },
  }
}

/** /router tools [天數]: calls per tool, by conversation role, elevated, blocked. */
export function toolReport(db: RouterDb, days: number, at = Date.now()): string {
  const since = new Date(at - days * DAY)
  const rows = db.toolStats(since.toISOString())
  const head = `工具呼叫統計: 近 ${days} 天 (${gmt8(since)} 起, GMT+8)`
  if (!rows.length) return `${head}\n(沒有紀錄)`
  type Agg = { total: number; roles: Map<string, number>; elevated: number; deny: number; error: number }
  const by = new Map<string, Agg>()
  const all: Agg = { total: 0, roles: new Map(), elevated: 0, deny: 0, error: 0 }
  for (const r of rows) {
    const a = by.get(r.tool) ?? { total: 0, roles: new Map(), elevated: 0, deny: 0, error: 0 }
    for (const x of [a, all]) {
      x.total += r.n
      x.roles.set(r.conv_role, (x.roles.get(r.conv_role) ?? 0) + r.n)
      if (r.elevated) x.elevated += r.n
      if (r.decision === 'deny') x.deny += r.n
      if (r.decision === 'error') x.error += r.n
    }
    by.set(r.tool, a)
  }
  const roleKey = (r: string) => { const i = ROLE_ORDER.indexOf(r); return i < 0 ? 99 : i }
  const line = (name: string, a: Agg) => {
    const roles = [...a.roles].sort((x, y) => roleKey(x[0]) - roleKey(y[0]) || x[0].localeCompare(y[0])).map(([r, n]) => `${r} ${n}`).join(', ')
    const extra = [a.elevated ? `提權 ${a.elevated}` : '', a.deny ? `被擋 ${a.deny}` : '', a.error ? `錯誤 ${a.error}` : ''].filter(Boolean).join(', ')
    return `${name} ${a.total} 次: ${roles}${extra ? `; ${extra}` : ''}`
  }
  const tools = [...by].sort((x, y) => y[1].total - x[1].total || x[0].localeCompare(y[0]))
  return [head, ...tools.map(([t, a]) => line(t, a)), line('合計', all),
    '角色是對話角色; 提權: 已提權的 subagent 以較高角色執行; 被擋: router 擋下 (原因見提權紀錄); 錯誤: router 端執行的 Telegram 工具被拒或 API 失敗'].join('\n')
}
