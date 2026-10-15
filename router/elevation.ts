// Elevation (plan 07 「提權: 交給 subagent 單次執行」). When the owner speaks
// from Telegram in a conversation whose role is below owner, that turn may
// hand work needing more than the conversation's role to a subagent:
//   1. the delivery is marked pending and carries an <elevation> note
//   2. SubagentStart binds the pending elevation to that agent_id (once)
//   3. PreToolUse allows that agent everything, including leaving the Bash
//      sandbox; nobody else may leave the sandbox
//   4. a non-owner turn may not steer an elevated agent via SendMessage
//   5. SubagentStop unbinds it; a turn that ends unused drops the pending mark
// Messages typed in the terminal never come through the router, so they never
// elevate.

export type HookDecision = { decision?: 'allow' | 'deny'; reason?: string }

export function createElevation(owners: string[], log: (m: string) => void = () => {}) {
  const pending = new Map<string, { by: string; at: number }>()
  const bound = new Map<string, { conv: string; by: string }>()
  const lastSender = new Map<string, string>()

  return {
    /** A delivery to a conversation: returns the <elevation> note to prepend, if any. */
    onDeliver(conv: string, convRole: string, senderUid: string | undefined): string | null {
      if (senderUid) lastSender.set(conv, senderUid)
      if (senderUid && owners.includes(senderUid) && convRole !== 'owner') {
        pending.set(conv, { by: senderUid, at: Date.now() })
        return `<elevation>\nrole: owner (elevated by uid#${senderUid}), original role: ${convRole}\n這則訊息來自 owner. 這一輪需要超出 ${convRole} 權限的事 (例如資料夾外的檔案, 跳出 sandbox 的指令), 依 CLAUDE.md 的提權流程交給一個 general-purpose subagent 執行; 主 session 自己仍是 ${convRole}.\n</elevation>`
      }
      pending.delete(conv)
      return null
    },

    onHook(conv: string, ev: Record<string, any>): HookDecision {
      const agent: string | undefined = ev.agent_id || undefined
      switch (ev.event) {
        case 'subagent-start': {
          const p = pending.get(conv)
          if (p && agent) {
            bound.set(agent, { conv, by: p.by })
            pending.delete(conv)
            log(`elevation ${conv}: bound to subagent ${agent}`)
          }
          return {}
        }
        case 'subagent-stop':
          if (agent && bound.delete(agent)) log(`elevation ${conv}: subagent ${agent} done`)
          return {}
        case 'stop':
          pending.delete(conv)
          return {}
        case 'pre': {
          const b = agent ? bound.get(agent) : undefined
          if (b && b.conv === conv) return { decision: 'allow', reason: `elevated by owner uid#${b.by}` }
          const input = ev.tool_input ?? {}
          if (ev.tool_name === 'Bash' && input.dangerouslyDisableSandbox) {
            return { decision: 'deny', reason: '跳出 sandbox 只限 owner 那一輪開出的 subagent' }
          }
          if (ev.tool_name === 'SendMessage' && !owners.includes(lastSender.get(conv) ?? '')) {
            const to = String(input.to ?? input.recipient ?? '')
            if ([...bound.keys()].some(id => to.includes(id))) return { decision: 'deny', reason: '非 owner 的那一輪不能指揮已提權的 subagent' }
          }
          return {}
        }
      }
      return {}
    },

    state: () => ({ pending: [...pending.keys()], bound: [...bound.entries()].map(([a, b]) => ({ agent: a, ...b })) }),
  }
}
