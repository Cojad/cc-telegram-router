// Outbound checks for tool calls coming from a plugin (plan 04 工具, 08
// 消費者模式). Enforced here in the router, so a worker cannot bypass them by
// anything it does on its own side of the socket.

import { realpathSync } from 'fs'
import { sep } from 'path'
import type { Access } from './telegram/policy'
import type { Peer } from './ipc'

function inside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep)
}

function real(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/** owner and admin may target any allowlisted chat; everyone else their own
 *  chat plus the targets granted to their conversation (/router perm send). */
export function makeAssertAllowedChat(peer: Peer, loadAccess: () => Access, granted: (chat_id: string) => boolean = () => false) {
  return (chat_id: string): void => {
    if (peer.conv && granted(chat_id)) return
    if (peer.role === 'owner' || peer.role === 'admin') {
      const a = loadAccess()
      if (a.allowFrom.includes(chat_id) || chat_id in a.groups) return
      if (peer.conv && peer.conv.chat_id === chat_id) return
      throw new Error(`chat ${chat_id} is not allowlisted`)
    }
    if (peer.conv && peer.conv.chat_id === chat_id) return
    throw new Error(
      `chat ${chat_id} is not this conversation (${peer.conv?.chat_id ?? 'none'}). ` +
      `Sending to another conversation needs a grant: call request_send_grant to ask the owner for a permanent grant, or to ask that conversation to accept.`,
    )
  }
}

/** Router state is never sendable; non-owners may only send files from their own folder. */
export function makeAssertSendable(peer: Peer, stateDir: string) {
  return (path: string): void => {
    const p = real(path)
    if (inside(p, real(stateDir))) throw new Error(`refusing to send router state: ${path}`)
    if (peer.role === 'owner') return
    if (peer.conv && inside(p, real(peer.conv.folder))) return
    throw new Error(`refusing to send ${path}: only files inside this conversation's folder can be sent`)
  }
}
