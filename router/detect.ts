// Secret detection in Telegram updates (plan 10e 原始事件完整保存與密鑰保護).
// Only formats one can tell at a glance (Telegram bot token, OpenAI sk-,
// Anthropic sk-ant-, GitHub ghp_ / github_pat_, AWS AKIA, Google AIza, Slack
// xox, PEM private key blocks), the value of a token-carrying router command
// (/secret set, /router cred add|rotate, /router bot add|rotate; only a message
// that starts with the command, not a sentence naming it), and exact matches
// of values the router already holds (global credentials, its own bot
// tokens, conversation secrets). No entropy guessing.
//
// Pure functions: the router decides what to do with the findings
// (router/rawvault.ts). Values never leave this module except as the
// replacement callers ask for; fingerprints are kind, last 4 and the first 8
// hex of sha256.

import { createHash } from 'crypto'
import { SECRET_CMDS } from './secrets'

/** A value the router holds, with what to call it ("全域憑證 eagle"). */
export type Known = { value: string; label: string }
export type Hit = { start: number; end: number; kind: string; value: string; known?: string }
/** One detected value inside an update. path: keys from the update root; n: the
 *  number of the distinct value in this update (same value, same n). */
export type Finding = { path: Array<string | number>; start: number; end: number; n: number; kind: string; last4: string; hash8: string; known?: string }

export const CMD_KIND = '登記指令裡的值'
export const KNOWN_KIND = '已登記的值'
/** Known values shorter than this are not matched (a short value would hit ordinary text). */
export const MIN_KNOWN = 8

const FORMATS: Array<[string, RegExp]> = [
  ['PEM 私鑰', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ['Telegram bot token', /(?<![\w:])\d{5,12}:[A-Za-z0-9_-]{35}(?![\w-])/g],
  ['Anthropic API key', /(?<![\w-])sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI API key', /(?<![\w-])sk-(?!ant-)[A-Za-z0-9_-]{20,}/g],
  ['GitHub token', /(?<![\w])(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['AWS access key', /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g],
  ['Google API key', /(?<![\w-])AIza[0-9A-Za-z_-]{35}/g],
  ['Slack token', /(?<![\w-])xox[abposr]-[A-Za-z0-9-]{10,}/g],
]

/** Every secret in a text, non-overlapping, in order. */
export function detectSecrets(text: string, known: Known[] = []): Hit[] {
  const all: Hit[] = []
  for (const [kind, re] of FORMATS) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) all.push({ start: m.index!, end: m.index! + m[0].length, kind, value: m[0] })
  }
  // the value of a token-carrying command, whatever it looks like (only a
  // message that starts with the command, see SECRET_CMDS)
  const m = SECRET_CMDS.exec(text)
  if (m) {
    const [, head, a, sp, b] = m as unknown as [string, string, string, string | undefined, string | undefined]
    const start = m.index + head.length + (b ? a.length + sp!.length : 0)
    const value = b ?? a
    all.push({ start, end: start + value.length, kind: CMD_KIND, value })
  }
  for (const k of known) {
    if (k.value.length < MIN_KNOWN) continue
    for (let i = text.indexOf(k.value); i >= 0; i = text.indexOf(k.value, i + k.value.length)) all.push({ start: i, end: i + k.value.length, kind: KNOWN_KIND, value: k.value, known: k.label })
  }
  // longest first at the same start; a known format beats the command and the bare match
  const rank = (h: Hit) => h.kind === KNOWN_KIND ? 2 : h.kind === CMD_KIND ? 1 : 0
  all.sort((x, y) => x.start - y.start || (y.end - y.start) - (x.end - x.start) || rank(x) - rank(y))
  const out: Hit[] = []
  for (const h of all) {
    const last = out[out.length - 1]
    if (last && h.start < last.end) {
      // the same span: keep the better kind, and say which held value it is
      if (h.start === last.start && h.end === last.end) {
        if (rank(h) < rank(last)) out[out.length - 1] = { ...h, known: h.known ?? last.known }
        else if (h.known && !last.known) last.known = h.known
      }
      continue
    }
    out.push({ ...h })
  }
  // a format or command hit that equals a held value
  for (const h of out) if (!h.known) h.known = known.find(k => k.value === h.value)?.label
  return out.map(h => h.known ? h : (({ known: _, ...rest }) => rest)(h))
}

/** Last 4 characters (of the key body for a PEM block). */
export function last4(value: string): string {
  const body = value.startsWith('-----BEGIN') ? value.replace(/-----[A-Z0-9 ]+-----/g, '').replace(/\s+/g, '') : value
  return body.slice(-4)
}
export const hash8 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 8)

function walk(v: unknown, path: Array<string | number>, f: (s: string, path: Array<string | number>) => void): void {
  if (typeof v === 'string') f(v, path)
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i], f))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, k], f)
}

/** Every string of an update scanned: text, captions, edited messages,
 *  button data, quoted replies. */
export function scanUpdate(update: unknown, known: Known[] = []): Finding[] {
  const out: Finding[] = []
  const numbers = new Map<string, number>()
  walk(update, [], (s, path) => {
    for (const h of detectSecrets(s, known)) {
      // the same value (any kind) gets the same number
      const fp = hash8(h.value)
      const n = numbers.get(fp) ?? numbers.size + 1
      numbers.set(fp, n)
      out.push({ path, start: h.start, end: h.end, n, kind: h.kind, last4: last4(h.value), hash8: hash8(h.value), ...(h.known ? { known: h.known } : {}) })
    }
  })
  return out
}

export const pathText = (p: Array<string | number>) => p.join('.')

function at(v: unknown, path: Array<string | number>): unknown {
  let x: any = v
  for (const k of path) x = x?.[k]
  return x
}

/** The values the findings point at, by n (from the original update). */
export function valuesOf(update: unknown, findings: Finding[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const f of findings) {
    const s = at(update, f.path)
    if (typeof s === 'string' && !m.has(f.n)) m.set(f.n, s.slice(f.start, f.end))
  }
  return m
}

/** New strings for every path that has findings, each value replaced by render(f). */
function rewritten(update: unknown, findings: Finding[], render: (f: Finding) => string): Array<[Array<string | number>, string]> {
  const byPath = new Map<string, Finding[]>()
  for (const f of findings) byPath.set(JSON.stringify(f.path), [...(byPath.get(JSON.stringify(f.path)) ?? []), f])
  const out: Array<[Array<string | number>, string]> = []
  for (const [, fs] of byPath) {
    let s = at(update, fs[0]!.path)
    if (typeof s !== 'string') continue
    for (const f of [...fs].sort((a, b) => b.start - a.start)) s = (s as string).slice(0, f.start) + render(f) + (s as string).slice(f.end)
    out.push([fs[0]!.path, s as string])
  }
  return out
}

function setAt(v: any, path: Array<string | number>, s: string): void {
  let x = v
  for (const k of path.slice(0, -1)) x = x?.[k]
  if (x && typeof x === 'object') x[path[path.length - 1]!] = s
}

/** A copy of the update with every finding replaced. */
export function replaceFindings<T>(update: T, findings: Finding[], render: (f: Finding) => string): T {
  const copy = structuredClone(update)
  for (const [p, s] of rewritten(update, findings, render)) setAt(copy, p, s)
  return copy
}

/** The same, in place (the update object grammY handlers read). */
export function replaceInPlace(update: unknown, findings: Finding[], render: (f: Finding) => string): void {
  for (const [p, s] of rewritten(update, findings, render)) setAt(update, p, s)
}

/** Markers: the events table, and what a worker sees. */
export const eventMarker = (eventId: number, f: Pick<Finding, 'n'>) => `<已遮蔽 #${eventId}.${f.n}>`
export const workerMarker = (eventId: number, f: Pick<Finding, 'n' | 'kind' | 'last4'>) => `<已遮蔽 #${eventId}.${f.n}: ${f.kind}, 末 4 碼 ${f.last4}>`

const QUOTED = new Set(['reply_to_message', 'external_reply', 'quote', 'pinned_message'])
/** Findings in the message itself (or a text attachment it came with), not in a message it quotes. */
export const ownFindings = (fs: Finding[]) => fs.filter(f => (f.path[0] === 'message' || f.path[0] === 'edited_message' || f.path[0] === 'attachment') && !QUOTED.has(String(f.path[1])))
/** A finding inside a quoted message (a reply, or the message under a pressed button quoting one). */
export const isQuoted = (f: Finding) => f.path.some(k => QUOTED.has(String(k)))
