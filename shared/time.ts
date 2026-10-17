// Times shown to people, written to logs or handed to workers are GMT+8 and
// never carry UTC or Z (柯姊's house rule). Times stored in router.db and the
// message store stay ISO UTC: they are compared and queried, and converted
// when shown (router/context.ts gmt8).

const GMT8 = 8 * 3_600_000

/** ISO 8601 in GMT+8 with its offset, e.g. 2026-10-17T08:06:04.919+08:00
 *  (Date.parse reads it back); sep ' ' for log lines. */
export function iso8(d: Date | number | string = new Date(), sep: 'T' | ' ' = 'T'): string {
  const t = typeof d === 'string' ? Date.parse(d) : typeof d === 'number' ? d : d.getTime()
  const s = new Date(t + GMT8).toISOString()
  return `${s.slice(0, 10)}${sep}${s.slice(11, 23)}+08:00`
}

/** One router log line: 2026-10-17 08:06:04.919+08:00 <msg> */
export function logLine(msg: string, d: Date | number = new Date()): string {
  return `${iso8(d, ' ')} ${msg}\n`
}
