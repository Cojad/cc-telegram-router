// Purpose-driven tests for inbound.ts: the plan.html §04 reply_to meta
// addition, and §05's "record everything, including drops" store wiring.
// buildReplyMeta() covers the pure truncation/extraction logic; the rest
// exercise the real handleInbound with stubbed gate/bot/mcp/store deps and
// assert on what actually got sent/recorded — not just that a helper
// computes the right value in isolation.
// Log lines a test causes on purpose (simulated store failures, a dropped
// duplicate) are checked and printed as 「✅ 預期中 ...」 (expectedLog), see
// docs/testing.md 「執行」.

import { expect, test } from 'bun:test'
import type { Context } from 'grammy'
import { buildReplyMeta, createHandleInbound, extractAttachmentMeta, type InboundDeps } from '../telegram/inbound'
import { type Access, type GateResult } from '../telegram/policy'
import { openStore, type MessageRecord } from '../telegram/store'

/** A log line a test causes on purpose (a simulated store failure, a dropped
 *  duplicate): kept for the test to check, and printed marked as expected,
 *  so the test output never reads like a real error (柯姊 2026-10-17). */
function expectedLog(lines: string[]) {
  return (m: string) => { lines.push(m); process.stderr.write(`✅ 預期中 (測試刻意模擬, 屬正確行為): ${m}\n`) }
}

test('buildReplyMeta: no reply_to_message produces no reply fields', () => {
  expect(buildReplyMeta(undefined)).toEqual({})
})

test('buildReplyMeta: text message includes both id and text', () => {
  expect(buildReplyMeta({ message_id: 42, text: 'original message' })).toEqual({
    reply_to_message_id: '42',
    reply_to_text: 'original message',
  })
})

test('buildReplyMeta: falls back to caption when text is absent (e.g. replying to a photo)', () => {
  expect(buildReplyMeta({ message_id: 7, caption: 'a caption' })).toEqual({
    reply_to_message_id: '7',
    reply_to_text: 'a caption',
  })
})

test('buildReplyMeta: a reply target with neither text nor caption (e.g. a bare sticker) still gives the id', () => {
  expect(buildReplyMeta({ message_id: 9 })).toEqual({ reply_to_message_id: '9' })
})

test('buildReplyMeta: text over 200 chars is truncated with an ellipsis', () => {
  const long = 'x'.repeat(250)
  const result = buildReplyMeta({ message_id: 1, text: long })
  expect(result.reply_to_text!.length).toBe(201) // 200 chars + '…'
  expect(result.reply_to_text!.endsWith('…')).toBe(true)
})

// Cojad 2026-09-15: "why is the replied-to sender's uid missing" — Telegram
// inlines `.from` on the reply_to_message object same as it inlines
// text/caption, but the original type signature never declared the field
// so it was silently dropped. This is the fix.
test('buildReplyMeta: includes reply_to_user_id when Telegram inlines the replied-to sender', () => {
  expect(buildReplyMeta({ message_id: 42, text: 'original message', from: { id: 999 } })).toEqual({
    reply_to_message_id: '42',
    reply_to_text: 'original message',
    reply_to_user_id: '999',
  })
})

test('buildReplyMeta: omits reply_to_user_id when Telegram does not inline a sender (old message)', () => {
  const result = buildReplyMeta({ message_id: 9, text: 'hi' })
  expect('reply_to_user_id' in result).toBe(false)
})

// ---- reply_to_attachment_* (Cojad 2026-09-17: a reply to a message with
// media gave no file_id without a manual lookup_message round-trip) --------

test('extractAttachmentMeta: photo picks the largest of the sizes array', () => {
  expect(extractAttachmentMeta({
    photo: [{ file_id: 'small', file_unique_id: 'u1', width: 90, height: 90 },
            { file_id: 'big', file_unique_id: 'u2', width: 1280, height: 1280, file_size: 40199 }],
  } as never)).toEqual({ kind: 'photo', file_id: 'big', size: 40199 })
})

test('extractAttachmentMeta: document includes mime and sanitized name', () => {
  expect(extractAttachmentMeta({
    document: { file_id: 'doc1', file_unique_id: 'u1', file_name: 'a<b>.pdf', mime_type: 'application/pdf', file_size: 100 },
  } as never)).toEqual({ kind: 'document', file_id: 'doc1', size: 100, mime: 'application/pdf', name: 'a_b_.pdf' })
})

test('extractAttachmentMeta: a plain text message has no attachment', () => {
  expect(extractAttachmentMeta({ text: 'hi' } as never)).toBeUndefined()
})

test('extractAttachmentMeta: undefined message has no attachment', () => {
  expect(extractAttachmentMeta(undefined)).toBeUndefined()
})

test('buildReplyMeta: includes reply_to_attachment_* when the replied-to message has a photo', () => {
  expect(buildReplyMeta({
    message_id: 55,
    photo: [{ file_id: 'AgADabc', file_unique_id: 'u1', width: 1280, height: 1280, file_size: 40199 }],
  } as never)).toEqual({
    reply_to_message_id: '55',
    reply_to_attachment_kind: 'photo',
    reply_to_attachment_file_id: 'AgADabc',
    reply_to_attachment_size: '40199',
  })
})

test('buildReplyMeta: a text-only reply target gets no reply_to_attachment_* fields', () => {
  const result = buildReplyMeta({ message_id: 55, text: 'plain text' } as never)
  expect('reply_to_attachment_kind' in result).toBe(false)
  expect('reply_to_attachment_file_id' in result).toBe(false)
})

test('handleInbound includes reply_to_attachment_file_id in the notification meta for a reply to a photo', async () => {
  const { handleInbound, notifications } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const ctx = ctxFor({
    message_id: 100,
    reply_to_message: {
      message_id: 55,
      photo: [{ file_id: 'AgADabc', file_unique_id: 'u1', width: 1280, height: 1280, file_size: 40199 }],
    },
  })

  await handleInbound(ctx, 'nice photo', undefined)

  const meta = notifications[0].params.meta as Record<string, unknown>
  expect(meta.reply_to_attachment_kind).toBe('photo')
  expect(meta.reply_to_attachment_file_id).toBe('AgADabc')
  expect(meta.reply_to_attachment_size).toBe('40199')
})

test('handleInbound: the worker gets the message time in GMT+8 (+08:00, no Z); the store keeps it in UTC', async () => {
  const { handleInbound, notifications, recorded } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const date = Date.parse('2026-10-17T00:06:04Z') / 1000 // 08:06:04 GMT+8
  await handleInbound(ctxFor({ message_id: 101, date }), 'hi', undefined)
  const meta = notifications[0].params.meta as Record<string, unknown>
  expect(meta.ts).toBe('2026-10-17T08:06:04.000+08:00')
  expect(Date.parse(String(meta.ts))).toBe(date * 1000)
  expect(recorded[0]!.ts).toBe('2026-10-17T00:06:04.000Z')
})

test('reply_to_attachment_file_id falls back to the store when Telegram omits the whole replied-to message (old message)', async () => {
  const { handleInbound, notifications } = harness(
    { action: 'deliver', access: accessAllowingEveryone() },
    { '1:55': { chat_id: '1', message_id: '55', direction: 'in', ts: '2026-01-01T00:00:00.000Z', attachment_kind: 'photo', attachment_file_id: 'AgADold', delivered: true } },
  )
  // Telegram gives only the id — the shape it sends when the replied-to
  // message is too old to inline (no text, no caption, no photo array).
  const ctx = ctxFor({ message_id: 100, reply_to_message: { message_id: 55 } })

  await handleInbound(ctx, 'my answer', undefined)

  const meta = notifications[0].params.meta as Record<string, unknown>
  expect(meta.reply_to_attachment_kind).toBe('photo')
  expect(meta.reply_to_attachment_file_id).toBe('AgADold')
})

test('a text-only reply does not trigger the store fallback lookup (no attachment to recover)', async () => {
  // Guards against re-introducing the regression this fix hit once already:
  // widening the fallback trigger to "text missing OR attachment missing"
  // made every plain text reply (which never has an attachment) consult the
  // store, doubling store.lookup() calls for the overwhelmingly common case.
  let lookupCalls = 0
  const deps: InboundDeps = {
    gate: () => ({ action: 'deliver', access: accessAllowingEveryone() }),
    bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
    mcp: { notification: async () => undefined } as never,
    store: { record: () => {}, lookup: () => { lookupCalls++; return null } },
  }
  const handleInbound = createHandleInbound(deps)
  const ctx = ctxFor({ message_id: 104, reply_to_message: { message_id: 55, text: 'already inlined' } })

  await handleInbound(ctx, 'my answer', undefined)

  expect(lookupCalls).toBe(1) // only the unconditional dedup check
})

// ---- wired into handleInbound: notification payload + store recording --

function accessAllowingEveryone(): Access {
  return { dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: {} }
}

interface Harness {
  handleInbound: ReturnType<typeof createHandleInbound>
  notifications: Array<{ method: string; params: Record<string, unknown> }>
  recorded: MessageRecord[]
  /** Log lines the run produced (printed marked as expected). */
  logs: string[]
}

function harness(gateResult: GateResult, seeded: Record<string, MessageRecord> = {}): Harness {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  const recorded: MessageRecord[] = []
  const logs: string[] = []
  const deps: InboundDeps = {
    gate: () => gateResult,
    bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
    mcp: { notification: async (n: unknown) => { notifications.push(n as never); return undefined } } as never,
    store: {
      record: (r: MessageRecord) => { recorded.push(r) },
      lookup: (chat_id: string, message_id: string) => seeded[`${chat_id}:${message_id}`] ?? null,
    },
    log: expectedLog(logs),
  }
  return { handleInbound: createHandleInbound(deps), notifications, recorded, logs }
}

function ctxFor(overrides: { message_id: number; date?: number; text?: string; reply_to_message?: unknown; from?: unknown; chat?: unknown; richBlocks?: unknown[] }): Context {
  return {
    from: overrides.from ?? { id: 1, username: 'alice' },
    chat: overrides.chat ?? { id: 1 },
    message: {
      message_id: overrides.message_id,
      date: overrides.date ?? 0,
      text: overrides.text,
      reply_to_message: overrides.reply_to_message,
      rich_message: overrides.richBlocks ? { blocks: overrides.richBlocks } : undefined,
    },
    reply: async () => {},
  } as unknown as Context
}

test('handleInbound skips a (chat_id, message_id) that is already in the store — duplicate delivery guard', async () => {
  const { handleInbound, notifications, recorded, logs } = harness(
    { action: 'deliver', access: accessAllowingEveryone() },
    { '1:1': { chat_id: '1', message_id: '1', direction: 'in', ts: '2026-09-15T00:00:00.000Z', delivered: true } },
  )
  const ctx = ctxFor({ message_id: 1 })
  await handleInbound(ctx, 'already seen', undefined)
  expect(notifications).toHaveLength(0)
  expect(logs).toEqual(['telegram channel: duplicate message dropped (chat 1, message 1): already recorded for this bot'])
  expect(recorded).toHaveLength(0) // not even a second store.record() call
})

test('handleInbound records attachment_file_id even when gate() drops the message — so it can still be fetched later', async () => {
  // Regression for the 2026-09-16 photo gap: transport.ts's message:photo
  // handler didn't pass an attachment param at all (unlike document/voice/
  // audio/video/sticker, which already did), so an undelivered photo had
  // no file_id on record and could never be retrieved via
  // download_attachment once the moment passed. This pins the general
  // contract at the handleInbound level: whatever attachment metadata the
  // caller passes in must reach store.record() regardless of gate()'s
  // decision, not just for delivered messages.
  const { handleInbound, recorded } = harness({ action: 'drop' })
  const ctx = ctxFor({ message_id: 1 })
  await handleInbound(ctx, '(photo)', undefined, { kind: 'photo', file_id: 'AgADabc123' })
  expect(recorded).toHaveLength(1)
  expect(recorded[0].delivered).toBe(false)
  expect(recorded[0].attachment_kind).toBe('photo')
  expect(recorded[0].attachment_file_id).toBe('AgADabc123')
})

test('handleInbound marks meta.rich_message="true" when the message is a Bot API Rich Message', async () => {
  const { handleInbound, notifications } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const ctx = ctxFor({ message_id: 1, richBlocks: [{ type: 'paragraph', text: 'hi' }] })
  await handleInbound(ctx, 'hi', undefined)
  const meta = notifications[0].params.meta as Record<string, unknown>
  expect(meta.rich_message).toBe('true')
})

test('handleInbound omits meta.rich_message entirely for a plain text message', async () => {
  const { handleInbound, notifications } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const ctx = ctxFor({ message_id: 1, text: 'hi from a human' })
  await handleInbound(ctx, 'hi from a human', undefined)
  const meta = notifications[0].params.meta as Record<string, unknown>
  expect('rich_message' in meta).toBe(false)
})

test('handleInbound includes reply_to_message_id/text/user_id in the notification meta when the message is a reply', async () => {
  const { handleInbound, notifications } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const ctx = ctxFor({
    message_id: 100,
    reply_to_message: { message_id: 55, text: 'earlier question', from: { id: 137438526 } },
  })

  await handleInbound(ctx, 'here is my answer', undefined)

  expect(notifications).toHaveLength(1)
  const meta = notifications[0].params.meta as Record<string, unknown>
  expect(meta.reply_to_message_id).toBe('55')
  expect(meta.reply_to_text).toBe('earlier question')
  expect(meta.reply_to_user_id).toBe('137438526')
})

test('handleInbound omits reply_to fields entirely for a non-reply message', async () => {
  const { handleInbound, notifications } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const ctx = ctxFor({ message_id: 101 })

  await handleInbound(ctx, 'a fresh message', undefined)

  const meta = notifications[0].params.meta as Record<string, unknown>
  expect('reply_to_message_id' in meta).toBe(false)
  expect('reply_to_text' in meta).toBe(false)
})

test('a delivered message is recorded with delivered: true, matching what was sent', async () => {
  const { handleInbound, recorded } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const ctx = ctxFor({ message_id: 200, text: 'hello there' })

  await handleInbound(ctx, 'hello there', undefined)

  expect(recorded).toHaveLength(1)
  expect(recorded[0]).toMatchObject({
    chat_id: '1', message_id: '200', direction: 'in', user_id: '1',
    content: 'hello there', delivered: true,
  })
})

test('a message gate() drops is still recorded, with delivered: false — closing the "no trace" gap', async () => {
  const { handleInbound, notifications, recorded } = harness({ action: 'drop' })
  const ctx = ctxFor({ message_id: 201, text: 'not mentioned' })

  await handleInbound(ctx, 'not mentioned', undefined)

  expect(notifications).toHaveLength(0) // never reached Claude
  expect(recorded).toHaveLength(1) // but it's not invisible either
  expect(recorded[0]).toMatchObject({ chat_id: '1', message_id: '201', delivered: false })
})

test('a pairing-code response is recorded as delivered: false (nothing reached Claude yet)', async () => {
  const { handleInbound, recorded } = harness({ action: 'pair', code: 'abc123', isResend: false })
  const ctx = ctxFor({ message_id: 202, text: 'hi' })

  await handleInbound(ctx, 'hi', undefined)

  expect(recorded).toHaveLength(1)
  expect(recorded[0].delivered).toBe(false)
})

test('a store.record failure never blocks message delivery to Claude', async () => {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  const logs: string[] = []
  const handleInbound = createHandleInbound({
    gate: () => ({ action: 'deliver', access: accessAllowingEveryone() }),
    bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
    mcp: { notification: async (n: unknown) => { notifications.push(n as never); return undefined } } as never,
    store: { record: () => { throw new Error('disk full (simulated)') }, lookup: () => null },
    log: expectedLog(logs),
  })
  const ctx = ctxFor({ message_id: 300, text: 'still gets through' })

  await handleInbound(ctx, 'still gets through', undefined)

  expect(notifications).toHaveLength(1) // store blowing up didn't swallow the real delivery
  expect(logs).toEqual(['telegram channel: store.record (inbound) failed: Error: disk full (simulated)'])
})

// ---- reply_to_text fallback to the store (plan.html §06 phase 4) --------

test('reply_to_text falls back to the store when Telegram omits it (e.g. replying to a caption-less photo)', async () => {
  const { handleInbound, notifications } = harness(
    { action: 'deliver', access: accessAllowingEveryone() },
    { '1:55': { chat_id: '1', message_id: '55', direction: 'in', ts: '2026-01-01T00:00:00.000Z', content: 'from the store', delivered: true } },
  )
  // reply_to_message has an id but no text/caption — the exact shape Telegram
  // sends for a reply to a photo with no caption.
  const ctx = ctxFor({ message_id: 100, reply_to_message: { message_id: 55 } })

  await handleInbound(ctx, 'my answer', undefined)

  const meta = notifications[0].params.meta as Record<string, unknown>
  expect(meta.reply_to_message_id).toBe('55')
  expect(meta.reply_to_text).toBe('from the store')
})

test('reply_to_text stays absent when neither Telegram nor the store has it — no crash', async () => {
  const { handleInbound, notifications } = harness({ action: 'deliver', access: accessAllowingEveryone() })
  const ctx = ctxFor({ message_id: 101, reply_to_message: { message_id: 999 } }) // never recorded

  await handleInbound(ctx, 'my answer', undefined)

  const meta = notifications[0].params.meta as Record<string, unknown>
  expect(meta.reply_to_message_id).toBe('999')
  expect('reply_to_text' in meta).toBe(false)
})

test('Telegram-inlined reply_to_text is used as-is, without an extra store consult for the fallback', async () => {
  // store.lookup() is called exactly once now — the cross-transport dedup
  // check at the top of handleInbound (unconditional, every message). What
  // this test actually guards: reply_to_text being already inlined means
  // the *second*, reply-fallback lookup (further down, only when Telegram
  // didn't inline it) must NOT also fire — so this stays at 1, not 2.
  let lookupCalls = 0
  const deps: InboundDeps = {
    gate: () => ({ action: 'deliver', access: accessAllowingEveryone() }),
    bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
    mcp: { notification: async () => undefined } as never,
    store: { record: () => {}, lookup: () => { lookupCalls++; return null } },
  }
  const handleInbound = createHandleInbound(deps)
  const ctx = ctxFor({ message_id: 102, reply_to_message: { message_id: 55, text: 'already inlined' } })

  await handleInbound(ctx, 'my answer', undefined)

  expect(lookupCalls).toBe(1)
})

test('a store.lookup failure during the reply fallback never blocks delivery', async () => {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  const logs: string[] = []
  const handleInbound = createHandleInbound({
    gate: () => ({ action: 'deliver', access: accessAllowingEveryone() }),
    bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
    mcp: { notification: async (n: unknown) => { notifications.push(n as never); return undefined } } as never,
    store: { record: () => {}, lookup: () => { throw new Error('db locked (simulated)') } },
    log: expectedLog(logs),
  })
  const ctx = ctxFor({ message_id: 103, reply_to_message: { message_id: 55 } })

  await handleInbound(ctx, 'my answer', undefined)

  expect(notifications).toHaveLength(1)
  expect(logs).toEqual([
    'telegram channel: store.lookup (dedup check) failed: Error: db locked (simulated)',
    'telegram channel: store.lookup (reply fallback) failed: Error: db locked (simulated)',
  ])
})

test('two bots, one store: the same chat and message id reaches each bot\'s worker (a DM to both, a group both are in); a real duplicate for one bot is dropped with a log line, never silently', async () => {
  const root = openStore(':memory:')
  const logs: string[] = []
  const make = (bot: string) => {
    const notifications: Array<{ params: Record<string, unknown> }> = []
    const handle = createHandleInbound({
      gate: () => ({ action: 'deliver', access: accessAllowingEveryone() }),
      bot: { api: { sendChatAction: async () => {}, setMessageReaction: async () => {} } } as never,
      mcp: { notification: async (n: unknown) => { notifications.push(n as never); return undefined } } as never,
      store: root.forBot(bot),
      log: m => logs.push(`${bot}: ${m}`),
    })
    return { handle, notifications }
  }
  const cc = make('cc'), router = make('router')
  // the person DMs both bots; each numbers its own messages, both have a 127
  await cc.handle(ctxFor({ message_id: 127, chat: { id: 700100200 }, text: 'to cc' }), 'to cc', undefined)
  await router.handle(ctxFor({ message_id: 127, chat: { id: 700100200 }, text: '實測 5-2' }), '實測 5-2', undefined)
  expect(cc.notifications.map(n => n.params.content)).toEqual(['to cc'])
  expect(router.notifications.map(n => n.params.content)).toEqual(['實測 5-2'])
  // a group both bots are in: the same message, once for each
  await cc.handle(ctxFor({ message_id: 50, chat: { id: -100777, type: 'supergroup' } as never, text: 'hi' }), 'hi', undefined)
  await router.handle(ctxFor({ message_id: 50, chat: { id: -100777, type: 'supergroup' } as never, text: 'hi' }), 'hi', undefined)
  expect([cc.notifications.length, router.notifications.length]).toEqual([2, 2])
  expect(logs).toEqual([])
  // the same update again for one bot: dropped, and said so
  await router.handle(ctxFor({ message_id: 127, chat: { id: 700100200 }, text: '實測 5-2' }), '實測 5-2', undefined)
  expect(router.notifications).toHaveLength(2)
  expect(logs).toEqual(['router: telegram channel: duplicate message dropped (chat 700100200, message 127): already recorded for this bot'])
  // a reply quoting message 127 gets this bot's text, not the other bot's
  await cc.handle(ctxFor({ message_id: 128, chat: { id: 700100200 }, text: 're', reply_to_message: { message_id: 127 } }), 're', undefined)
  expect((cc.notifications.at(-1)!.params.meta as Record<string, unknown>).reply_to_text).toBe('to cc')
  root.close()
})
