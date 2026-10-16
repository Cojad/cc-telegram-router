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
//      refused by default after 120 seconds (passive request).
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

import type { Conversation, RouterDb, ElevLogKind } from './db'
import { checkCall, describeCall, rank, permanentRule, type Call, type Rule } from './permcheck'
import { postApproval, settleApproval, logPlace, messageLink, buttons, parseChoice, CHOICE_WORD, type ApprovalDeps, type About } from './approvals'
import { applyOverrides } from './settings'
import type { Authz } from './authz'

export type HookDecision = { decision?: 'allow' | 'deny'; reason?: string }

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

export function createElevation(deps: ElevationDeps) {
  const { db } = deps
  const askTimeout = deps.askTimeoutMs ?? 120_000
  const ttl = deps.grantTtlMs ?? 600_000
  const lastSender = new Map<string, string>()
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

  const senderOf = (conv: Conversation) => lastSender.get(conv.key) ?? null
  const elevatedSender = (conv: Conversation) => {
    const s = senderOf(conv)
    return s && rank(deps.roleOf(s)) > rank(conv.role) ? s : null
  }

  async function record(conv: Conversation, kind: ElevLogKind, text: string, ref: number | null): Promise<void> {
    db.addElevLog(conv.key, kind, text, ref)
    const place = logPlace(db, conv.bot)
    if (place) await deps.approvals.send(conv.bot, place, text, []).catch(() => null)
  }

  function linkOf(id: number): string {
    const m = db.approvalMsgs('elev', id)[0]
    return m ? (messageLink(m.chat_id, m.message_id) ?? `${m.chat_id} 訊息 ${m.message_id}`) : `#${id}`
  }

  const who = (uid: string | null) => uid ? `${deps.label(uid)} [${deps.roleOf(uid)}]` : '(不明)'

  /** What 永久允許 would add for this call in this conversation. */
  function ruleFor(conv: Conversation, call: Call | null): Rule | { none: string } {
    if (!call) return { none: '主動申請沒有具體的動作, 只能一次一次允許' }
    const lay = (s: any, o: Rule['overrides']) => applyOverrides(s, o.map(x => ({ conv: conv.key, ...x })))
    return permanentRule(deps.settingsAs(conv, conv.role), call, conv.folder, lay)
  }

  /** Post an elevation request (in the chat, or at the approvals place). */
  async function ask(conv: Conversation, kind: 'passive' | 'active', action: string, reason: string, call: Call | null): Promise<{ id: number; where: 'chat' | 'owner' | 'none' }> {
    const sender = senderOf(conv)
    const inChat = !!elevatedSender(conv)
    const id = db.addElevation({ conv: conv.key, kind, sender, action: call ? JSON.stringify(call) : action, reason })
    deps.approvals.noteRequest?.('elev', id, conv)
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

  async function finish(id: number, status: 'approved' | 'denied' | 'expired', uid: string | null, role: string | null, permanent?: Rule): Promise<void> {
    const e = db.getElevation(id)!
    const conv = db.getConversation(e.conv)
    clearTimeout(timers.get(id)); timers.delete(id)
    const word = status === 'approved' ? `${permanent ? CHOICE_WORD.always : CHOICE_WORD.once} (${who(uid)}, 以 ${role} 角色執行)` : status === 'denied' ? `${CHOICE_WORD.deny} (${who(uid)})` : '⌛ 逾時, 預設拒絕'
    if (status === 'approved' && conv) deps.authz?.record('elev', id, conv, permanent ? 'always' : 'once', permanent?.overrides ?? [], word)
    await settleApproval(deps.approvals, 'elev', id, word, status === 'approved')
    if (!conv) return
    await record(conv, status, `${status === 'approved' ? `✅ 提權成功${permanent ? ' (永久允許)' : ''}` : status === 'denied' ? '❌ 提權被拒' : '⌛ 提權逾時'} #${id} ${conv.key}${status === 'approved' ? `: 由 ${who(uid)} 核准, 以 ${role} 角色執行` : ''}${permanent ? `\n永久允許: ${permanent.desc} (權限覆寫 ${permanent.overrides.map(o => `${o.kind} ${o.value}`).join(', ')})` : ''}\n原始請求: ${linkOf(id)}`, id)
    if (status === 'approved') {
      granted.set(conv.key, { id, role: role!, by: uid!, until: Date.now() + ttl })
      deps.notify(conv, `<router_status>\n提權 #${id} 已核准 (${who(uid)}): 以 ${role} 角色執行.${permanent ? `\n另外永久允許: 之後可以${permanent.desc}, worker 下次重啟後生效.` : ''}\n用 Agent 工具開「一個」general-purpose subagent 去完成被擋下的工作, prompt 寫清楚要做什麼; subagent 的 Bash 需要跳出 sandbox 時帶 dangerouslyDisableSandbox: true. 只有接下來開的第一個 subagent 有這個權限, ${Math.round(ttl / 60000)} 分鐘內要開始, 它結束就失效. 主 session 自己不要做越權的事.\n</router_status>`, { kind: 'elev', ref: id })
    } else {
      deps.notify(conv, `<router_status>\n提權 #${id} ${status === 'denied' ? `被拒絕 (${who(uid)})` : '逾時沒有回應, 視為拒絕'}. 不要用越權的方法繼續; 告訴對方這個請求無法完成.\n</router_status>`, { kind: 'elev', ref: id })
    }
  }

  async function expire(id: number): Promise<void> {
    if (db.decideElevation(id, 'expired', null, null)) await finish(id, 'expired', null, null)
  }

  async function blocked(conv: Conversation, call: Call, why: string, agent: string | undefined): Promise<HookDecision> {
    const action = describeCall(call)
    const sender = senderOf(conv)
    await record(conv, 'blocked', `⛔ ${conv.key} 被擋: ${action}\n${why}${agent ? ` (subagent ${agent})` : ''}\n發起者 ${who(sender)}`, null)
    const guide = `權限不足 (本對話角色 ${conv.role}): ${why}.`
    const elevated = elevatedSender(conv)
    if (elevated && checkCall(deps.settingsAs(conv, deps.roleOf(elevated)), call, conv.folder).ok) {
      const pending = db.pendingElevation(conv.key)
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
        case 'subagent-start': {
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
            const c = checkCall(deps.settingsAs(conv, b.role), call, conv.folder, b.role)
            if (!c.ok) return blocked(conv, call, `即使提權為 ${b.role} 也不允許: ${c.why}`, agent)
            const g = db.approvalGrantsFor('elev', b.id).find(x => x.status === 'active')
            if (g) await deps.authz?.use(conv, g, `subagent ${agent} 以 ${b.role} 角色: ${callDetail(call)}`)
            if (call.tool_name.startsWith(TG_TOOL)) tickets.set(ticketKey(conv.key, call.tool_name.slice(TG_TOOL.length), call.tool_input), { role: b.role, id: b.id, until: Date.now() + 60_000 })
            return { decision: 'allow', reason: `提權 #${b.id}, 以 ${b.role} 角色執行` }
          }
          if (call.tool_name === 'SendMessage' && !elevatedSender(conv)) {
            const to = String(call.tool_input.to ?? call.tool_input.recipient ?? '')
            if ([...bound.keys()].some(id => to.includes(id))) return { decision: 'deny', reason: '非提權的一輪不能指揮已提權的 subagent' }
          }
          const c = checkCall(deps.settingsAs(conv, conv.role), call, conv.folder, conv.role)
          if (!c.ok) return blocked(conv, call, c.why, agent)
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
        if (!c.ok) return `你的角色 (${role}) 也不允許這個動作`
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

    /** Something refused elsewhere (package review) still belongs in the log. */
    note: (conv: Conversation, kind: ElevLogKind, text: string) => record(conv, kind, text, null),

    state: () => ({ granted: [...granted.entries()].map(([conv, g]) => ({ conv, ...g })), bound: [...bound.entries()].map(([agent, b]) => ({ agent, ...b })) }),
    stop() { for (const t of timers.values()) clearTimeout(t) },
  }
}
