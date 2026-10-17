// Permission checks and elevation (plan 07 「權限與隔離」, 「提權」).
//
// Every tool call of a worker passes PreToolUse, which asks the router:
//   1. Checked against the conversation's own role (router/permcheck.ts).
//      Over the line: refused, and the worker is told to find a way within
//      its permissions, or else tell the person it cannot continue and ask
//      whether to request permission from the bot owner (request_elevation).
//   2. If the person whose message started this turn has a higher role than
//      the conversation (the delivery carries sender_role and elevated), the
//      router also asks right there in the chat: 「提權執行」 or 「拒絕」,
//      refused by default after 120 seconds (passive request). A turn typed
//      in the worker's terminal (its prompt hook says no Telegram message)
//      has no sender: only the conversation's role counts and nothing is
//      asked in the chat, until the next Telegram message starts a turn; a
//      message delivered during a terminal turn waits for its own turn.
//   3. The prompt offers 允許一次 / 永久允許 / 拒絕. Whoever presses must have
//      a role above the conversation's that allows the blocked call; the
//      elevation then runs with *their* role, bound to the next subagent the
//      worker starts (one subagent, 10 minutes to start it). 永久允許 also
//      adds the kind of action to the conversation's /router perm overrides
//      (permcheck.permanentRule, spelled out in the prompt) so it is not
//      asked again. The main session never leaves its role.
//   4. request_elevation (active request): in the chat when the sender is
//      elevated, otherwise at the approvals place for owner/admin.
// Everything blocked, every request and every outcome goes to the
// elevation log: router.db, plus the 提權紀錄 topic of the approvals group.
//
// High-risk tools (permcheck.riskyRefusal, 柯姊 2026-10-17): ListAgents,
// RemoteTrigger, CronCreate, CronDelete, ScheduleWakeup, PushNotification,
// and SendMessage to anyone but the conversation's own subagents, are
// refused for power and below like any block above, once only. Own
// subagents: the agent ids SubagentStart reports, and the name of an Agent
// call the router let through, once its SubagentStart arrives (a name whose
// subagent never started stays unknown: a bare name with no in-process
// agent behind it would reach another session). "main" counts only from a
// subagent (reporting back). Kept in router.db own_agents, so a router
// restart keeps them, each bound to the worker process it started under
// (workerKey: session id, the plugin's pid and its start time; no start time,
// as without /proc, and nothing counts for that worker): only the
// worker whose plugin said hello since this router started counts, and a
// hello from another worker process (rotate, restart, a new session) drops
// the conversation's older rows, whose subagents are gone with that process.
// No plugin connected, nothing counts. SubagentStop removes nothing: a
// finished subagent is woken again by a SendMessage to it. Agent calls still
// waiting for their SubagentStart stay in memory only. Rows older than
// 30 days, and rows of conversations that no longer exist, go at start and
// once a day.

import { readFileSync } from 'fs'
import type { Conversation, RouterDb, ElevLogKind } from './db'
import { checkCall, describeCall, rank, permanentRule, riskyRefusal, sendTarget, RISKY_TOOLS, type Call, type Rule } from './permcheck'
import { postApproval, settleApproval, logPlace, messageLink, buttons, parseChoice, CHOICE_WORD, type ApprovalDeps, type About } from './approvals'
import { applyOverrides } from './settings'
import { logKind, type Authz } from './authz'
import { inParens } from './context'

export type HookDecision = { decision?: 'allow' | 'deny'; reason?: string }

/** Who a worker process is: its session, its plugin's pid and when that
 *  process started (/proc/<pid>/stat starttime: a pid used again later is
 *  another process). null when the start time cannot be read (no /proc, the
 *  process gone): that worker cannot be told apart, its own subagents never count. */
export function workerKey(session: string | null | undefined, pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const start = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]
    return start && /^\d+$/.test(start) ? `${session || '?'}:${pid}:${start}` : null
  } catch { return null }
}

/** A tool call in full for the 執行授權 log (only the fields the hook forwards). */
export function callDetail(call: Call): string {
  return `${call.tool_name} ${JSON.stringify(call.tool_input ?? {})}`.slice(0, 1500)
}

export interface ElevationDeps {
  db: RouterDb
  approvals: ApprovalDeps
  roleOf(uid: string): string
  /** Effective settings this conversation would have under another role
   *  (keep: which of its overrides to lay on; default all). */
  settingsAs(conv: Conversation, role: string, keep?: (o: { kind: string; value: string }) => boolean): any
  notify(conv: Conversation, text: string, about?: About): void
  /** Overrides changed: rewrite settings, rotate the worker. */
  applyPermissions(conv: Conversation): void
  /** Remembers what an approval granted, logs each use (revoke, 執行授權). */
  authz?: Authz
  label(uid: string): string
  log?(msg: string): void
  /** A further check beyond the role's permission settings (a skill
   *  argument limited to higher roles): why role may not make this call, or null. */
  extraCheck?(conv: Conversation, call: Call, role: string): string | null
  askTimeoutMs?: number
  grantTtlMs?: number
}

type Grant = { id: number; role: string; by: string; until: number }

/** Same JSON for the same arguments, whatever the key order. */
export function stableArgs(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableArgs).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stableArgs((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const TG_TOOL = 'mcp__plugin_telegram_telegram__'
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const MAX_OWN = 500
const isRisky = (call: Call) => RISKY_TOOLS.has(call.tool_name) || call.tool_name === 'SendMessage'

export function createElevation(deps: ElevationDeps) {
  const { db } = deps
  const askTimeout = deps.askTimeoutMs ?? 120_000
  const ttl = deps.grantTtlMs ?? 600_000
  const lastSender = new Map<string, string>()
  /** conversations whose current turn was typed in the terminal (prompt hook, telegram false) */
  const terminalTurn = new Set<string>()
  /** approved, waiting for the worker's next subagent */
  const granted = new Map<string, Grant>()
  /** agent_id -> conversation and the role it runs with */
  const bound = new Map<string, { conv: string; role: string; id: number }>()
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  /** Telegram tools run router-side (bot_api...): an elevated subagent's call,
   *  seen in its PreToolUse, leaves a one-use ticket the router's tool
   *  execution picks up to use the elevated role. */
  const tickets = new Map<string, { role: string; id: number; until: number }>()
  const ticketKey = (conv: string, tool: string, args: unknown) => `${conv}\u0000${tool}\u0000${stableArgs(args ?? {})}`
  /** conv -> the worker process its plugin said hello from since this router started (workerKey) */
  const workers = new Map<string, string>()
  /** conv -> Agent calls the router let through, waiting for their SubagentStart */
  const spawning = new Map<string, Array<{ name: string; type: string }>>()
  /** One of conv's own subagents (agent id or name), bound to its current worker: SendMessage to it is not cross-session. */
  const addOwn = (conv: string, id: string) => {
    const w = workers.get(conv)
    if (!w) { deps.log?.(`own subagent ${id} of ${conv} not kept: no worker plugin connected`); return }
    try { db.addOwnAgent(conv, w, id, MAX_OWN) } catch (e) { deps.log?.(`own_agents: ${e}`) }
  }
  /** An Agent call is let through: its name becomes the conversation's once the subagent starts. */
  const noteSpawn = (conv: string, call: Call) => {
    if (!AGENT_TOOLS.has(call.tool_name)) return
    const q = spawning.get(conv) ?? []
    q.push({ name: String(call.tool_input?.name ?? ''), type: String(call.tool_input?.subagent_type ?? '') })
    spawning.set(conv, q.slice(-20))
  }
  /** SendMessage's recipient is one of this conversation's own subagents (a subagent's "main" is its parent). */
  const isOwnTarget = (conv: string, call: Call, agent?: string) => {
    const to = sendTarget(call)
    if (!to) return false
    if (to === 'main') return !!agent
    const w = workers.get(conv)
    try { return !!w && db.isOwnAgent(conv, w, to) } catch { return false }
  }

  const senderOf = (conv: Conversation) => terminalTurn.has(conv.key) ? null : lastSender.get(conv.key) ?? null
  /** Would role be allowed this call: its permission settings, then extraCheck. */
  const allowedAs = (conv: Conversation, role: string, call: Call, agent?: string) => {
    const c = checkCall(deps.settingsAs(conv, role), call, conv.folder, role)
    if (!c.ok) return c
    const why = riskyRefusal(call, role, isOwnTarget(conv.key, call, agent)) ?? deps.extraCheck?.(conv, call, role)
    return why ? { ok: false as const, why } : c
  }
  const elevatedSender = (conv: Conversation) => {
    const s = senderOf(conv)
    return s && rank(deps.roleOf(s)) > rank(conv.role) ? s : null
  }

  async function record(conv: Conversation, kind: ElevLogKind, text: string, ref: number | null): Promise<void> {
    db.addElevLog(conv.key, kind, text, ref)
    const place = logPlace(db, conv.bot)
    if (!place) return
    const mid = await deps.approvals.send(conv.bot, place, text, []).catch(() => null)
    // the 提權成功 line shows the authorization: a revoke marks it (authz.ts markRevoked)
    if (mid != null && kind === 'approved' && ref != null) db.addApprovalMsg({ kind: logKind('elev'), ref, bot: conv.bot, chat_id: place.chat_id, message_id: mid, text })
  }

  function linkOf(id: number): string {
    const m = db.approvalMsgs('elev', id)[0]
    return m ? (messageLink(m.chat_id, m.message_id) ?? `${m.chat_id} 訊息 ${m.message_id}`) : `#${id}`
  }

  const who = (uid: string | null) => uid ? `${deps.label(uid)} [${deps.roleOf(uid)}]` : '(不明)'

  /** What 永久允許 would add for this call in this conversation. */
  function ruleFor(conv: Conversation, call: Call | null): Rule | { none: string } {
    if (!call) return { none: '主動申請沒有具體的動作, 只能一次一次允許' }
    if (isRisky(call)) return { none: '高風險工具 (傳訊給其他 session, ListAgents, 排程, 遠端觸發, 推播) 只能一次一次允許' }
    if (deps.extraCheck?.(conv, call, conv.role)) {
      const none = call.tool_name.endsWith('__run_skill') ? '技能參數的角色限制沒辦法寫成固定規則, 只能一次一次允許'
        : call.tool_name.endsWith('__install_skill') ? '安裝技能的角色限制跟著對話角色, 要長期開放請 owner 調整對話角色 (/router perm role; 私訊是使用者角色, 用 /router role), 這裡只能一次一次允許'
        : '憑證開放給哪些角色要由 owner 用 /router cred roles 調整, 這裡只能一次一次允許'
      return { none }
    }
    const lay = (s: any, o: Rule['overrides']) => applyOverrides(s, o.map(x => ({ conv: conv.key, ...x })))
    return permanentRule(deps.settingsAs(conv, conv.role), call, conv.folder, lay)
  }

  /** Post an elevation request (in the chat, or at the approvals place). */
  async function ask(conv: Conversation, kind: 'passive' | 'active', action: string, reason: string, call: Call | null): Promise<{ id: number; where: 'chat' | 'owner' | 'none' }> {
    const sender = senderOf(conv)
    const inChat = !!elevatedSender(conv)
    const id = db.addElevation({ conv: conv.key, kind, sender, action: call ? JSON.stringify(call) : action, reason })
    // a terminal turn answers no Telegram message: the result is not a reply to the last one
    if (!terminalTurn.has(conv.key)) deps.approvals.noteRequest?.('elev', id, conv)
    const rule = ruleFor(conv, call)
    const text = [
      `🔐 提權請求 #${id}${kind === 'active' ? ' (主動申請)' : ''}`,
      `${who(sender)} 在 ${conv.key}${conv.title ? ` (${conv.title})` : ''} 的請求需要超過本對話角色 (${conv.role}) 的權限:`,
      action,
      `原因: ${reason || '(未說明)'}`,
      `✅ 允許一次: 下一個 subagent 以按下的人的角色執行這一次.`,
      'overrides' in rule
        ? `♾️ 永久允許的範圍: ${conv.key} 之後可以${rule.desc}, 不用再問 (權限覆寫 ${rule.overrides.map(o => `${o.kind} ${o.value}`).join(', ')}); 這次也會照樣執行.`
        : `♾️ 不能永久允許: ${rule.none}.`,
      inChat ? `${Math.round(askTimeout / 1000)} 秒內沒有回應視為拒絕.` : '',
    ].filter(Boolean).join('\n')
    let ok = false
    if (inChat) {
      const mid = await deps.approvals.send(conv.bot, { chat_id: conv.chat_id }, text, buttons('elev', id, 'overrides' in rule))
      if (mid != null) { db.addApprovalMsg({ kind: 'elev', ref: id, bot: conv.bot, chat_id: conv.chat_id, message_id: mid, text }); ok = true }
      timers.set(id, setTimeout(() => void expire(id), askTimeout))
    } else {
      ok = (await postApproval(deps.approvals, conv.bot, 'elev', id, text, [], 'overrides' in rule)).length > 0
    }
    await record(conv, 'request', `🙋 ${kind === 'active' ? '主動' : '被動'}提權請求 #${id} ${conv.key}: ${action}\n發起者 ${who(sender)}, 原因: ${reason || '(未說明)'}\n${linkOf(id)}`, id)
    return { id, where: ok ? (inChat ? 'chat' : 'owner') : 'none' }
  }

  async function finish(id: number, status: 'approved' | 'denied' | 'expired', uid: string | null, role: string | null, permanent?: Rule, quiet = false): Promise<void> {
    const e = db.getElevation(id)!
    const conv = db.getConversation(e.conv)
    clearTimeout(timers.get(id)); timers.delete(id)
    const word = status === 'approved' ? `${permanent ? CHOICE_WORD.always : CHOICE_WORD.once} ${inParens(`${who(uid)}, 以 ${role} 角色執行`)}` : status === 'denied' ? `${CHOICE_WORD.deny} ${inParens(who(uid))}` : '⌛ 逾時, 預設拒絕'
    if (status === 'approved' && conv) deps.authz?.record('elev', id, conv, permanent ? 'always' : 'once', permanent?.overrides ?? [], word)
    await settleApproval(deps.approvals, 'elev', id, word, status === 'approved')
    if (!conv) return
    await record(conv, status, `${status === 'approved' ? `✅ 提權成功${permanent ? ' (永久允許)' : ''}` : status === 'denied' ? '❌ 提權被拒' : '⌛ 提權逾時'} #${id} ${conv.key}${status === 'approved' ? `: 由 ${who(uid)} 核准, 以 ${role} 角色執行` : ''}${permanent ? `\n永久允許: ${permanent.desc} (權限覆寫 ${permanent.overrides.map(o => `${o.kind} ${o.value}`).join(', ')})` : ''}\n原始請求: ${linkOf(id)}`, id)
    if (status === 'approved') {
      granted.set(conv.key, { id, role: role!, by: uid!, until: Date.now() + ttl })
      deps.notify(conv, `<router_status>\n提權 #${id} 已核准 ${inParens(who(uid))}: 以 ${role} 角色執行.${permanent ? `\n另外永久允許: 之後可以${permanent.desc}, worker 下次重啟後生效.` : ''}\n用 Agent 工具開「一個」general-purpose subagent 去完成被擋下的工作, prompt 寫清楚要做什麼; subagent 的 Bash 需要跳出 sandbox 時帶 dangerouslyDisableSandbox: true. 只有接下來開的第一個 subagent 有這個權限, ${Math.round(ttl / 60000)} 分鐘內要開始, 它結束就失效. 主 session 自己不要做越權的事.\n</router_status>`, { kind: 'elev', ref: id })
    } else if (!quiet) {
      deps.notify(conv, `<router_status>\n提權 #${id} ${status === 'denied' ? `被拒絕 ${inParens(who(uid))}` : '逾時沒有回應, 視為拒絕'}. 不要用越權的方法繼續; 告訴對方這個請求無法完成.\n</router_status>`, { kind: 'elev', ref: id })
    }
  }

  async function expire(id: number): Promise<void> {
    if (db.decideElevation(id, 'expired', null, null)) await finish(id, 'expired', null, null)
  }

  // Timers live in memory: after a restart, a request asked in the chat gets
  // what is left of its time, or expires now. Expiring now tells no worker:
  // the turn that asked is long over. (Requests sent to the owner have no time limit.)
  for (const p of db.pendingElevations()) {
    const conv = db.getConversation(p.conv)
    if (!conv || !db.approvalMsgs('elev', p.id).some(m => m.chat_id === conv.chat_id)) continue
    const left = Date.parse(p.created_at) + askTimeout - Date.now()
    if (left > 0) timers.set(p.id, setTimeout(() => void expire(p.id), left))
    else if (db.decideElevation(p.id, 'expired', null, null)) void finish(p.id, 'expired', null, null, undefined, true).catch(e => deps.log?.(`elevation #${p.id}: ${e}`))
  }

  async function blocked(conv: Conversation, call: Call, why: string, agent: string | undefined): Promise<HookDecision> {
    const action = describeCall(call)
    const sender = senderOf(conv)
    await record(conv, 'blocked', `⛔ ${conv.key} 被擋: ${action}\n${why}${agent ? ` (subagent ${agent})` : ''}\n發起者 ${who(sender)}`, null)
    const guide = `權限不足 (本對話角色 ${conv.role}): ${why}.`
    const elevated = elevatedSender(conv)
    if (elevated && allowedAs(conv, deps.roleOf(elevated), call, agent).ok) {
      // one question in the chat at a time; a request waiting for the owner elsewhere does not hold up a new one
      const pending = db.pendingElevations().find(p => p.conv === conv.key && db.approvalMsgs('elev', p.id).some(m => m.chat_id === conv.chat_id))
      if (pending) return { decision: 'deny', reason: `${guide} 已在對話裡詢問是否提權 (#${pending.id}), 等 <router_status> 的結果; 這段時間不要用越權的方法繞過.` }
      const reason = String(call.tool_input?.description ?? '')
      const { id, where } = await ask(conv, 'passive', action, reason, call)
      if (where !== 'none') return { decision: 'deny', reason: `${guide} 發起者 ${who(elevated)} 的角色較高, router 已在對話裡詢問是否提權 (#${id}, ${Math.round(askTimeout / 1000)} 秒內沒人回應視為拒絕). 先不要用越權的方法繞過; 等 <router_status> 的結果: 核准就照指示交給 subagent, 拒絕或逾時就告訴對方無法完成.` }
    }
    return { decision: 'deny', reason: `${guide} 請改用不越權的方法完成. 如果在不越權的情況下無法合理完成, 告訴對方這個請求無法繼續, 並問對方是否要向 bot owner 申請權限; 對方同意後呼叫 request_elevation 說明原因.` }
  }

  return {
    /** A delivery: remember who started the turn; meta to add to the message. */
    onDeliver(conv: Conversation, senderUid: string | undefined): Record<string, string> {
      if (!senderUid) return {}
      lastSender.set(conv.key, senderUid)
      const role = deps.roleOf(senderUid)
      return { sender_role: role, ...(rank(role) > rank(conv.role) ? { elevated: 'true' } : {}) }
    },

    async onHook(conv: Conversation, ev: Record<string, any>): Promise<HookDecision> {
      const agent: string | undefined = ev.agent_id || undefined
      switch (ev.event) {
        // a turn starts: from a Telegram message (its delivery named the sender) or typed in the terminal
        case 'prompt':
          if (ev.telegram) terminalTurn.delete(conv.key); else terminalTurn.add(conv.key)
          return {}
        case 'subagent-start': {
          if (agent) {
            addOwn(conv.key, agent)
            const q = spawning.get(conv.key) ?? []
            const type = String(ev.agent_type ?? '')
            const i = type ? q.findIndex(x => x.type === type || (!x.type && type === 'general-purpose')) : 0
            const [s] = q.splice(i >= 0 ? i : 0, 1)
            if (s?.name) addOwn(conv.key, s.name)
          }
          const g = granted.get(conv.key)
          if (g && agent && g.until > Date.now()) {
            bound.set(agent, { conv: conv.key, role: g.role, id: g.id })
            deps.log?.(`elevation #${g.id} ${conv.key}: bound to subagent ${agent} as ${g.role}`)
          }
          granted.delete(conv.key)
          return {}
        }
        case 'subagent-stop':
          if (agent && bound.delete(agent)) deps.log?.(`elevation ${conv.key}: subagent ${agent} done`)
          return {}
        case 'pre': {
          const call: Call = { tool_name: String(ev.tool_name ?? ''), tool_input: ev.tool_input ?? {} }
          const b = agent ? bound.get(agent) : undefined
          if (b && b.conv === conv.key) {
            const c = allowedAs(conv, b.role, call, agent)
            if (!c.ok) return blocked(conv, call, `即使提權為 ${b.role} 也不允許: ${c.why}`, agent)
            noteSpawn(conv.key, call)
            const g = db.approvalGrantsFor('elev', b.id).find(x => x.status === 'active')
            if (g) await deps.authz?.use(conv, g, `subagent ${agent} 以 ${b.role} 角色: ${callDetail(call)}`)
            if (call.tool_name.startsWith(TG_TOOL)) tickets.set(ticketKey(conv.key, call.tool_name.slice(TG_TOOL.length), call.tool_input), { role: b.role, id: b.id, until: Date.now() + 60_000 })
            return { decision: 'allow', reason: `提權 #${b.id}, 以 ${b.role} 角色執行` }
          }
          if (call.tool_name === 'SendMessage' && !elevatedSender(conv)) {
            const to = String(call.tool_input.to ?? call.tool_input.recipient ?? '')
            if ([...bound.keys()].some(id => to.includes(id))) return { decision: 'deny', reason: '非提權的一輪不能指揮已提權的 subagent' }
          }
          const c = allowedAs(conv, conv.role, call, agent)
          if (!c.ok) return blocked(conv, call, c.why, agent)
          noteSpawn(conv.key, call)
          // passes only thanks to an approved override (永久允許 earlier): a use of it
          if (deps.authz) {
            const approved = deps.authz.approvedOverrides(conv)
            if (approved.size) {
              const base = deps.settingsAs(conv, conv.role, o => !approved.has(`${o.kind}\u0000${o.value}`))
              if (!checkCall(base, call, conv.folder).ok) {
                const lay = (o: Rule['overrides']) => applyOverrides(base, o.map(x => ({ conv: conv.key, ...x })))
                for (const g of deps.authz.covering(conv, o => checkCall(lay(o as Rule['overrides']), call, conv.folder).ok)) {
                  await deps.authz.use(conv, g, callDetail(call))
                }
              }
            }
          }
          return {}
        }
      }
      return {}
    },

    /** request_elevation from the worker (active request). */
    async request(conv: Conversation, reason: string, action: string): Promise<string> {
      const pending = db.pendingElevation(conv.key)
      if (pending) return `已有一個提權請求在等待 (#${pending.id})`
      const { id, where } = await ask(conv, 'active', action || '(未指定)', reason, null)
      if (where === 'none') return '提權請求送不出去 (對話與審核頻道都送不到)'
      return where === 'chat' ? `已在對話裡詢問是否提權 (#${id}, ${Math.round(askTimeout / 1000)} 秒內沒人回應視為拒絕), 結果會以 <router_status> 通知` : `已向 bot owner 申請提權 (#${id}), 結果會以 <router_status> 通知`
    },

    /** A button press "elev:<id>:once|always|deny". */
    async decide(data: string, uid: string): Promise<string | null> {
      const p = parseChoice('elev', data)
      if (!p) return null
      const e = db.getElevation(p.ref)
      if (!e) return '找不到這個請求'
      if (e.status !== 'pending') return `這個請求已經${e.status === 'approved' ? '核准' : e.status === 'denied' ? '拒絕' : '逾時'}了`
      const conv = db.getConversation(e.conv)
      if (!conv) return '找不到這個對話'
      const role = deps.roleOf(uid)
      if (rank(role) <= rank(conv.role)) return `你的角色 (${role}) 沒有高於這個對話 (${conv.role}), 不能決定`
      const call = e.action.startsWith('{') ? JSON.parse(e.action) as Call : null
      if (p.choice !== 'deny' && call) {
        const c = checkCall(deps.settingsAs(conv, role), call, conv.folder, role)
        if (!c.ok || riskyRefusal(call, role, false)) return `你的角色 (${role}) 也不允許這個動作`
      }
      let permanent: Rule | undefined
      if (p.choice === 'always') {
        const r = ruleFor(conv, call)
        if (!('overrides' in r)) return `不能永久允許: ${r.none}`
        permanent = r
      }
      const status = p.choice === 'deny' ? 'denied' : 'approved'
      if (!db.decideElevation(e.id, status, uid, status === 'approved' ? role : null)) return '這個請求已經處理過了'
      if (permanent) {
        for (const o of permanent.overrides) db.addOverride({ conv: conv.key, kind: o.kind, value: o.value })
        deps.applyPermissions(db.getConversation(conv.key)!)
      }
      await finish(e.id, status, uid, role, permanent)
      return status === 'approved' ? (permanent ? '已永久允許並提權' : '已提權一次') : '已拒絕'
    },

    /** An elevation was revoked: drop its pending grant and unbind its subagent. */
    drop(id: number): void {
      for (const [k, g] of granted) if (g.id === id) granted.delete(k)
      for (const [a, b] of bound) if (b.id === id) bound.delete(a)
      for (const [k, t] of tickets) if (t.id === id) tickets.delete(k)
    },

    /** The router is about to run tool(args) for conv: the elevated role, when
     *  an elevated subagent just asked for exactly this call. One use. */
    takeTicket(conv: string, tool: string, args: unknown): string | null {
      const k = ticketKey(conv, tool, args)
      const t = tickets.get(k)
      if (!t) return null
      tickets.delete(k)
      return t.until > Date.now() ? t.role : null
    },

    /** The role takeTicket would give, without using the ticket. */
    peekTicket(conv: string, tool: string, args: unknown): string | null {
      const t = tickets.get(ticketKey(conv, tool, args))
      return t && t.until > Date.now() ? t.role : null
    },

    /** A call refused router-side (a Telegram tool the main session called,
     *  which no hook sees): log it and ask for elevation like a hook block. */
    refuse: (conv: Conversation, call: Call, why: string): Promise<HookDecision> => blocked(conv, call, why, undefined),

    /** Something refused elsewhere (package review) still belongs in the log. */
    note: (conv: Conversation, kind: ElevLogKind, text: string) => record(conv, kind, text, null),

    extraCheck: (conv: Conversation, call: Call, role: string): string | null => deps.extraCheck?.(conv, call, role) ?? null,
    /** Who started the conversation's current turn; null for a turn typed in the terminal (event_raw goes by the conversation's role then). */
    senderOf: (conv: Conversation): string | null => senderOf(conv),
    /** The conversation's current turn was typed in the worker's terminal (no Telegram message). */
    terminalTurn: (convKey: string): boolean => terminalTurn.has(convKey),

    /** The role an elevated subagent runs with (tool_history 有效角色); null when not elevated. */
    boundRole: (convKey: string, agent: string | undefined): string | null => {
      const b = agent ? bound.get(agent) : undefined
      return b && b.conv === convKey ? b.role : null
    },
    /** The conversation's own subagents as known now (tests, /router status). */
    ownAgents: (convKey: string): string[] => {
      const w = workers.get(convKey)
      return w ? db.ownAgents(convKey, w) : []
    },
    /** A worker's plugin said hello (worker: workerKey). Another worker process
     *  than the rows were kept for: those rows go, their subagents are gone. */
    workerConnected(convKey: string, worker: string): void {
      if (workers.get(convKey) !== worker) spawning.delete(convKey)
      workers.set(convKey, worker)
      try {
        const n = db.dropOwnAgents(convKey, worker)
        if (n) deps.log?.(`own_agents ${convKey}: dropped ${n} of an earlier worker`)
      } catch (e) { deps.log?.(`own_agents: ${e}`) }
    },
    /** The worker's plugin went away: no own subagent counts until a plugin says hello again. */
    workerGone(convKey: string): void { workers.delete(convKey) },
    /** own_agents rows added before an ISO time, and of conversations gone; how many. */
    purgeOwnAgents(before: string): number {
      try { return db.purgeOwnAgents(before) } catch (e) { deps.log?.(`own_agents purge: ${e}`); return 0 }
    },

    state: () => ({ granted: [...granted.entries()].map(([conv, g]) => ({ conv, ...g })), bound: [...bound.entries()].map(([agent, b]) => ({ agent, ...b })) }),
    stop() { for (const t of timers.values()) clearTimeout(t) },
  }
}
