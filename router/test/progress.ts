// bun run test:full's progress lines (docs/testing.md 「全套」「進度」): one
// line per test file as it finishes, for full.ts to print and log.
//
// Where each piece comes from:
// - a file finished, and how many of its tests ran: progress-preload.ts,
//   loaded into every test file with bun test --preload, appends JSON lines
//   to the file CCTR_TEST_PROGRESS names (start, then done after afterAll);
// - failures: bun's own output. With --reporter=junit under --parallel, bun
//   prints nothing for a file that passed quietly; a file with a failure (or
//   console output) gets a block that starts with its path and a colon, one
//   `(fail) <test>` line per failed test. That block comes a little after
//   the file's afterAll, so a finished file waits GRACE_MS before its line
//   is printed; a failure later than that gets a line of its own.
// - the estimate: per-file times from the timings files (.test-out first,
//   then the committed baseline), what is left divided over the workers, and
//   never less than the longest file left; no line has it when a file left
//   has no time.
// The junit stays the count of record: the summary at the end comes from it.
// Tests: router/test/progress.test.ts.

import { existsSync, readFileSync } from 'fs'
import { basename } from 'path'

export const GRACE_MS = 1000

export interface ProgressEvent { ev: 'start' | 'done'; file: string; ran?: number; at: number }

/** One JSON line from progress-preload.ts, or null for anything else. */
export function parseEvent(line: string): ProgressEvent | null {
  try {
    const o = JSON.parse(line)
    if ((o?.ev !== 'start' && o?.ev !== 'done') || typeof o.file !== 'string' || typeof o.at !== 'number') return null
    return { ev: o.ev, file: o.file, at: o.at, ...(typeof o.ran === 'number' ? { ran: o.ran } : {}) }
  } catch { return null }
}

/** Per-file milliseconds, the first file that has a test file winning (bun's --timings format: { files: { path: ms } }). */
export function loadTimings(paths: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const files = JSON.parse(readFileSync(p, 'utf8'))?.files ?? {}
      for (const [k, v] of Object.entries(files)) if (typeof v === 'number' && !m.has(k)) m.set(k, v)
    } catch {}
  }
  return m
}

/** Milliseconds left: the files not finished (a started one counts what is left of its time), over the workers, at least the longest one; null when a file has no time. */
export function estimateMs(left: Array<{ file: string; startedAt?: number }>, timings: Map<string, number>, jobs: number, now: number): number | null {
  let sum = 0, longest = 0
  for (const f of left) {
    const t = timings.get(f.file)
    if (t === undefined) return null
    const rest = f.startedAt === undefined ? t : Math.max(0, t - (now - f.startedAt))
    sum += rest
    longest = Math.max(longest, rest)
  }
  return Math.max(sum / jobs, longest)
}

export interface LineInput { index: number; total: number; elapsedMs: number; etaMs: number | null; pass: number; fail: number; failed: boolean; file: string }

/** `[ 23/80]  29%  經過 31s  預估剩 64s  pass 241  fail 0   e2e-managed.test.ts`, with ❌ before the name when that file failed. */
export function formatLine(o: LineInput): string {
  const w = Math.max(3, String(o.total).length)
  const pct = o.total ? Math.round((o.index / o.total) * 100) : 100
  const eta = o.etaMs === null ? '' : `  預估剩 ${Math.round(o.etaMs / 1000)}s`
  return `[${String(o.index).padStart(w)}/${o.total}] ${String(pct).padStart(3)}%  經過 ${Math.round(o.elapsedMs / 1000)}s${eta}  pass ${o.pass}  fail ${o.fail}${o.failed ? ' ❌ ' : '   '}${basename(o.file)}`
}

const HEADER = /^(\S+\.test\.ts):$/
const FAIL = /^\(fail\) /

/** Follows the preload's events and bun's output, and says a line per finished file. */
export class Progress {
  private started = new Map<string, number>()
  private ran = new Map<string, number>()
  private pending: Array<{ file: string; at: number }> = []
  private printed = new Set<string>()
  private fails = new Map<string, number>()
  private header = new Map<string, string>()
  private pass = 0

  constructor(private o: { files: string[]; jobs: number; timings: Map<string, number>; t0: number; say: (line: string) => void; graceMs?: number }) {}

  event(e: ProgressEvent): void {
    if (!this.o.files.includes(e.file)) return
    if (e.ev === 'start') { if (!this.started.has(e.file)) this.started.set(e.file, e.at); return }
    if (this.ran.has(e.file)) return
    this.ran.set(e.file, e.ran ?? 0)
    this.pending.push({ file: e.file, at: e.at })
  }

  /** One complete line of bun's output, from the stream named (stdout and stderr keep their own current file). */
  output(stream: string, line: string): void {
    const h = line.match(HEADER)
    if (h) { this.header.set(stream, h[1]!); return }
    const file = this.header.get(stream)
    if (!file || !FAIL.test(line)) return
    this.fails.set(file, (this.fails.get(file) ?? 0) + 1)
    if (this.printed.has(file)) this.o.say(`      ❌ ${basename(file)}: 又一項失敗, fail 共 ${this.failTotal()}`)
  }

  /** Prints the files finished at least the grace period ago (all of them when final). */
  tick(now: number, final = false): void {
    const grace = this.o.graceMs ?? GRACE_MS
    while (this.pending.length && (final || now - this.pending[0]!.at >= grace)) {
      const { file } = this.pending.shift()!
      this.printed.add(file)
      const failed = this.fails.get(file) ?? 0
      this.pass += Math.max(0, (this.ran.get(file) ?? 0) - failed)
      const left = this.o.files.filter(f => !this.ran.has(f)).map(f => ({ file: f, startedAt: this.started.get(f) }))
      this.o.say(formatLine({ index: this.printed.size, total: this.o.files.length, elapsedMs: now - this.o.t0, etaMs: estimateMs(left, this.o.timings, this.o.jobs, now), pass: this.pass, fail: this.failTotal(), failed: failed > 0, file }))
    }
  }

  private failTotal(): number { let n = 0; for (const v of this.fails.values()) n += v; return n }
}
