// What approvals granted, each use of it, and revoking it (柯姊 2026-10-16).
//   record: an approved request (send grant, package review, elevation)
//           remembers the overrides it added, so it can be taken back.
//   use:    every time a worker relies on one of those authorizations (a
//           tool call of an elevated subagent, a call that passes only
//           because of an approved override, a send to a granted chat, an
//           approved package) it is logged with the call's content, in
//           router.db and the approvals group's 執行授權 topic, with a
//           🚫 撤銷 button.
//   revoke: owner or admin presses 🚫 撤銷 (on the settled request or on a
//           use): the overrides go away, the worker's settings are
//           rewritten, a still-pending elevation is dropped, and the worker
//           is told. Every message the authorization appeared in (each copy
//           of the request, each use, the 提權成功 line in 提權紀錄) loses
//           its button and shows 已撤銷;
//           pressing a stale button tidies them up again.

import type { Conversation, RouterDb, OverrideKind, ApprovalGrant } from './db'
import { usePlace, mayDecide, revokeButton, type ApprovalDeps, type About } from './approvals'

export type Granted = Array<{ kind: OverrideKind; value: string }>
type Stored = { o: Granted; outcome: string }

export interface AuthzDeps {
  db: RouterDb
  approvals: ApprovalDeps
  applyPermissions(conv: Conversation): void
  notify(conv: Conversation, text: string, about?: About): void
  label(uid: string): string
  /** An elevation request was revoked: forget its pending or bound subagent. */
  dropElevation?(ref: number): void
  log?(msg: string): void
}

export const KIND_NAME: Record<string, string> = { grant: '跨對話傳訊', pkg: '套件安裝', elev: '提權' }
/** approval_msgs kind of a log message about an approved request (提權紀錄 「✅ 提權成功」): marked on revoke too. */
export const logKind = (kind: string) => `${kind}-log`

export function overridesOf(g: ApprovalGrant): Granted {
  try { return (JSON.parse(g.overrides) as Stored).o ?? [] } catch { return [] }
}
function outcomeOf(g: ApprovalGrant): string {
  try { return (JSON.parse(g.overrides) as Stored).outcome ?? '' } catch { return '' }
}

export function createAuthz(deps: AuthzDeps) {
  const { db } = deps

  /** Everywhere this authorization shows: the request (keeps its outcome) and
   *  each use in 執行授權, and its 「✅ 成功」 line in a log topic (提權紀錄). Buttons go, 已撤銷 is added. */
  async function markRevoked(kind: string, ref: number, g: ApprovalGrant, who: string): Promise<void> {
    const stamp = `🚫 已撤銷 (${who})`
    for (const msg of db.approvalMsgs(kind, ref)) {
      await deps.approvals.edit(msg.bot, msg.chat_id, msg.message_id, `${msg.text}\n\n${outcomeOf(g)}\n${stamp}`, []).catch(() => {})
    }
    for (const msg of db.approvalMsgs(logKind(kind), ref)) {
      await deps.approvals.edit(msg.bot, msg.chat_id, msg.message_id, `${msg.text}\n\n${stamp}`, []).catch(() => {})
    }
    for (const u of db.authUses(g.id)) {
      if (u.bot && u.chat_id && u.message_id != null) await deps.approvals.edit(u.bot, u.chat_id, u.message_id, `${u.text}\n\n${stamp}`, []).catch(() => {})
    }
  }

  return {
    /** An approved request: remember what it added (and the outcome line shown under it). */
    record(kind: string, ref: number, conv: Conversation, choice: string, overrides: Granted, outcome: string): number {
      return db.addApprovalGrant({ kind, ref, conv: conv.key, choice, overrides: JSON.stringify({ o: overrides, outcome } satisfies Stored) })
    },

    /** Active authorizations of this conversation whose overrides pass the test. */
    covering(conv: Conversation, test: (o: Granted, g: ApprovalGrant) => boolean): ApprovalGrant[] {
      return db.activeApprovalGrants(conv.key).filter(g => test(overridesOf(g), g))
    },

    /** Overrides that came from approvals (to tell them apart from /router perm ones). */
    approvedOverrides(conv: Conversation): Set<string> {
      return new Set(db.activeApprovalGrants(conv.key).flatMap(g => overridesOf(g).map(o => `${o.kind}\u0000${o.value}`)))
    },

    /** One use of an authorization: logged, and posted to 執行授權 with a revoke button. */
    async use(conv: Conversation, g: ApprovalGrant, text: string): Promise<void> {
      const line = `🧾 ${KIND_NAME[g.kind] ?? g.kind}授權 (審核 #${g.ref}) 使用於 ${conv.key}${conv.title ? ` (${conv.title})` : ''}\n${text}`
      const place = usePlace(db, conv.bot)
      const id = place ? await deps.approvals.send(conv.bot, place, line, [revokeButton(g.kind, g.ref)]).catch(() => null) : null
      db.addAuthUse(g.id, conv.key, line, id != null && place ? { bot: conv.bot, chat_id: place.chat_id, message_id: id } : undefined)
    },

    /** Overrides were removed by hand (/router perm rm or reset): an
     *  authorization none of whose overrides is left counts as revoked, and
     *  its messages say so. Returns how many. */
    async syncRemoved(conv: Conversation, uid: string): Promise<number> {
      const left = new Set(db.listOverrides(conv.key).map(o => `${o.kind}\u0000${o.value}`))
      let n = 0
      for (const g of db.activeApprovalGrants(conv.key)) {
        const o = overridesOf(g)
        if (!o.length || o.some(x => left.has(`${x.kind}\u0000${x.value}`))) continue
        db.revokeApprovalGrant(g.id, uid)
        if (g.kind === 'elev') deps.dropElevation?.(g.ref)
        await markRevoked(g.kind, g.ref, g, `${deps.label(uid)}, 用 /router perm 移除`)
        n++
      }
      return n
    },

    /** A 🚫 撤銷 press "<kind>:<ref>:revoke". */
    async revoke(data: string, uid: string): Promise<string | null> {
      const m = /^(grant|pkg|elev):(\d+):revoke$/.exec(data)
      if (!m) return null
      if (!mayDecide(deps.approvals, uid)) return '只有 owner 或 admin 能撤銷'
      const [kind, ref] = [m[1]!, Number(m[2])]
      const all = db.approvalGrantsFor(kind, ref)
      const active = all.filter(g => g.status === 'active')
      if (!active.length) {
        // a stale button (an edit that failed, or a message posted before the revoke finished): tidy up again
        for (const g of all) await markRevoked(kind, ref, g, deps.label(g.revoked_by ?? uid))
        return all.length ? '這個授權已經撤銷了' : '找不到這個授權'
      }
      const who = deps.label(uid)
      for (const g of active) {
        db.revokeApprovalGrant(g.id, uid)
        const conv = db.getConversation(g.conv)
        const o = overridesOf(g)
        for (const x of o) db.removeOverride(g.conv, [x.kind], x.value)
        if (kind === 'elev') deps.dropElevation?.(ref)
        if (conv) {
          if (o.length) deps.applyPermissions(conv)
          deps.notify(conv, `<router_status>\n${KIND_NAME[kind]}授權 (審核 #${ref}) 已被 ${who} 撤銷${o.length ? `: 移除 ${o.map(x => `${x.kind} ${x.value}`).join(', ')}` : ''}. 之後這類動作會再被擋下, 需要的話重新申請.\n</router_status>`, { kind, ref })
        }
        deps.log?.(`revoked ${kind} #${ref} (${g.conv}) by ${uid}`)
        await markRevoked(kind, ref, g, who)
      }
      return '已撤銷'
    },
  }
}

export type Authz = ReturnType<typeof createAuthz>
