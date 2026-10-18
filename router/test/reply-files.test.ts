// reply with files (docs/architecture.md「回覆與附件」): the text as the
// caption of the first file when it fits Telegram's caption limit, whole as
// its own message(s) first when it does not, several files as albums
// (sendMediaGroup). A real grammY Bot talks to a local fake Bot API, so the
// test sees the method and the multipart fields that would reach Telegram
// (caption, parse_mode, media, reply_parameters). Nothing goes to Telegram.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { Bot } from 'grammy'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { callTool, groupFiles, type OutboundDeps } from '../telegram/outbound'
import { CAPTION_LIMIT, captionLength, markdownV2Visible } from '../telegram/format'
import { openStore, type Store } from '../telegram/store'
import { TOOL_DEFINITIONS } from '../../shared/tools'

const dir = mkdtempSync(join(tmpdir(), 'reply-files-'))
const file = (name: string) => { const p = join(dir, name); writeFileSync(p, `bytes of ${name}`); return p }
const A = file('a.png'), B = file('b.jpg'), C = file('c.pdf'), D = file('d.txt'), E = file('e.webp')

// --- fake Bot API ---------------------------------------------------------
type Call = { method: string; body: Record<string, any> }
let calls: Call[] = []
let nextId = 500
/** Telegram's answer for the next call of this method, instead of success (once). */
const refuse = new Map<string, { error_code: number; description: string }>()
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    const type = req.headers.get('content-type') ?? ''
    const body: Record<string, any> = type.includes('json') ? await req.json()
      : type.includes('multipart') ? Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { file: v.name, size: v.size }]))
      : {}
    for (const k of ['media', 'reply_parameters']) if (typeof body[k] === 'string') body[k] = JSON.parse(body[k])
    // grammY uploads a single file as attach://<part> too: show the part itself
    for (const k of ['photo', 'document']) if (String(body[k]).startsWith('attach://')) body[k] = body[String(body[k]).slice('attach://'.length)]
    calls.push({ method, body })
    const no = refuse.get(method)
    if (no) { refuse.delete(method); return Response.json({ ok: false, ...no }) }
    const msg = () => ({ message_id: nextId++, date: 0, chat: { id: Number(body.chat_id), type: 'private' } })
    if (method === 'sendMediaGroup') return Response.json({ ok: true, result: (body.media as unknown[]).map(msg) })
    return Response.json({ ok: true, result: msg() })
  },
})

const stores: Store[] = []
let replyToMode: 'off' | 'first' | 'all' = 'first'
function deps(): OutboundDeps {
  const store = openStore(':memory:').forBot('cc')
  stores.push(store)
  return {
    bot: new Bot('123:test', { client: { apiRoot: `http://127.0.0.1:${api.port}` } }),
    token: '123:test', inboxDir: join(dir, 'inbox'), store,
    loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: ['111'], groups: {}, pending: {}, replyToMode }),
    assertAllowedChat: () => {}, assertSendable: () => {},
  }
}
const reply = async (args: Record<string, unknown>, d = deps()) => {
  const r = await callTool('reply', { chat_id: '111', ...args }, d)
  return { text: r.content[0]!.text, isError: r.isError, store: d.store }
}
const methods = () => calls.map(c => c.method)
beforeEach(() => { calls = []; refuse.clear(); replyToMode = 'first' })
afterEach(() => { for (const s of stores.splice(0)) s.close() })
afterAll(() => { api.stop(true); rmSync(dir, { recursive: true, force: true }) })

// --- one file ---------------------------------------------------------------

test('one photo and a short text: one sendPhoto with the text as its caption, no separate text message', async () => {
  const r = await reply({ text: '這是截圖', files: [A] })
  expect(methods()).toEqual(['sendPhoto'])
  expect(calls[0]!.body).toMatchObject({ chat_id: '111', caption: '這是截圖', photo: { file: 'a.png' } })
  expect(calls[0]!.body.parse_mode).toBeUndefined()
  expect(r.isError).toBeUndefined()
  expect(r.text).toMatch(/^sent 1 message \(id: \d+\): 1 photo with the text as the caption$/)
  // the record keeps both: which file, and the text
  const id = r.text.match(/id: (\d+)/)![1]!
  expect(r.store.lookup('111', id)?.content).toBe(`(photo: ${A})\n這是截圖`)
})

test('one document with format markdownv2: the caption goes with parse_mode MarkdownV2, as the text does', async () => {
  const r = await reply({ text: '*報表* v2\\.0', files: [C], format: 'markdownv2' })
  expect(methods()).toEqual(['sendDocument'])
  expect(calls[0]!.body).toMatchObject({ caption: '*報表* v2\\.0', parse_mode: 'MarkdownV2', document: { file: 'c.pdf' } })
  expect(r.text).toContain('1 document with the text as the caption')
})

test('the caption threads under reply_to like the text did; replyToMode off sends no reply_parameters', async () => {
  await reply({ text: 'answer', files: [A], reply_to: '42' })
  expect(calls[0]!.body.reply_parameters).toEqual({ message_id: 42 })
  calls = []
  replyToMode = 'off'
  await reply({ text: 'answer', files: [A], reply_to: '42' })
  expect(calls[0]!.body.reply_parameters).toBeUndefined()
})

// --- the caption limit --------------------------------------------------------

test('the limit is 1024 as Telegram counts: exactly 1024 is a caption, 1025 is not; emoji count two (UTF-16)', async () => {
  expect(CAPTION_LIMIT).toBe(1024)
  await reply({ text: 'x'.repeat(1024), files: [A] })
  expect(methods()).toEqual(['sendPhoto'])
  expect(calls[0]!.body.caption).toHaveLength(1024)
  calls = []
  await reply({ text: 'x'.repeat(1025), files: [A] })
  expect(methods()).toEqual(['sendMessage', 'sendPhoto'])
  calls = []
  await reply({ text: '😀'.repeat(512), files: [A] })
  expect(methods()).toEqual(['sendPhoto'])
  calls = []
  await reply({ text: '😀'.repeat(513), files: [A] })
  expect(methods()).toEqual(['sendMessage', 'sendPhoto'])
})

test('markdownv2: escapes and markup do not count, only the text Telegram shows', async () => {
  // 1000 visible characters, 2000 as written (every one escaped)
  const escaped = '\\.'.repeat(1000)
  expect(captionLength(escaped, 'markdownv2')).toBe(1000)
  expect(captionLength(escaped, 'text')).toBe(2000)
  await reply({ text: escaped, files: [A], format: 'markdownv2' })
  expect(methods()).toEqual(['sendPhoto'])
  expect(calls[0]!.body).toMatchObject({ caption: escaped, parse_mode: 'MarkdownV2' })
})

test('markdownV2Visible: escapes, bold/italic/underline/strike/spoiler, code, pre with a language, links, custom emoji, quotes', () => {
  expect(markdownV2Visible('*bold \\*text* _it_ __u__ ~s~ ||sp||')).toBe('bold *text it u s sp')
  expect(markdownV2Visible('`a\\`b` x')).toBe('a`b x')
  expect(markdownV2Visible('```python\nprint(1)\n```')).toBe('print(1)\n')
  expect(markdownV2Visible('[site](http://example.com/a\\)b) end')).toBe('site end')
  expect(markdownV2Visible('![👍](tg://emoji?id=1)')).toBe('👍')
  expect(markdownV2Visible('>quote\n**>more||\na > b')).toBe('quote\nmore\na > b')
})

test('a text over the limit goes first, whole, as its own message(s) (format and reply_to as before); the file follows with no caption', async () => {
  const long = '第一段.\n\n' + 'y'.repeat(1100)
  const r = await reply({ text: long, files: [A], reply_to: '7', format: 'markdownv2' })
  expect(methods()).toEqual(['sendMessage', 'sendPhoto'])
  expect(calls[0]!.body).toMatchObject({ text: long, parse_mode: 'MarkdownV2', reply_parameters: { message_id: 7 } })
  expect(calls[1]!.body.caption).toBeUndefined()
  expect(calls[1]!.body.reply_parameters).toEqual({ message_id: 7 })
  expect(r.text).toMatch(/^sent 2 messages \(ids: \d+, \d+\): the text, then 1 photo \(the text is over the 1024-character caption limit, so it went as its own message first\)$/)
})

test('a text over 4096 is still split into parts as before, then the files', async () => {
  const r = await reply({ text: 'z'.repeat(5000), files: [A, B] })
  expect(methods()).toEqual(['sendMessage', 'sendMessage', 'sendMediaGroup'])
  expect(calls[2]!.body.media.every((m: any) => m.caption === undefined)).toBe(true)
  expect(r.text).toContain('the text in 2 parts, then an album of 2 photos')
})

test('Telegram finds the caption too long anyway: nothing was sent, so the text goes first and the file again without a caption', async () => {
  refuse.set('sendPhoto', { error_code: 400, description: 'Bad Request: message caption is too long' })
  const r = await reply({ text: 'short enough by our count', files: [A] })
  expect(methods()).toEqual(['sendPhoto', 'sendMessage', 'sendPhoto'])
  expect(calls[2]!.body.caption).toBeUndefined()
  expect(r.isError).toBeUndefined()
  expect(r.text).toContain('(Telegram said the text is too long for a caption, so it went as its own message first)')
})

test('Telegram refuses the caption\'s MarkdownV2: the error goes back to the worker and nothing was sent (resend with format text)', async () => {
  refuse.set('sendPhoto', { error_code: 400, description: "Bad Request: can't parse entities: Character '.' is reserved" })
  const r = await reply({ text: 'v2.0', files: [A], format: 'markdownv2' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('reply failed after 0 message(s) sent')
  expect(r.text).toContain("can't parse entities")
  expect(methods()).toEqual(['sendPhoto'])
})

test('an empty text with files sends only the files', async () => {
  const r = await reply({ text: '', files: [A] })
  expect(methods()).toEqual(['sendPhoto'])
  expect(calls[0]!.body.caption).toBeUndefined()
  expect(r.text).toMatch(/: 1 photo \(no text\)$/)
})

// --- several files --------------------------------------------------------------

test('several photos: one sendMediaGroup, the caption (and parse_mode) on the first item only, reply_to on the album', async () => {
  const r = await reply({ text: '*三張*', files: [A, B, E], format: 'markdownv2', reply_to: '9' })
  expect(methods()).toEqual(['sendMediaGroup'])
  const { media, reply_parameters } = calls[0]!.body
  expect(media).toHaveLength(3)
  expect(media.map((m: any) => m.type)).toEqual(['photo', 'photo', 'photo'])
  expect(media.every((m: any) => String(m.media).startsWith('attach://'))).toBe(true)
  expect(media[0]).toMatchObject({ caption: '*三張*', parse_mode: 'MarkdownV2' })
  expect(media[1].caption).toBeUndefined()
  expect(media[2].parse_mode).toBeUndefined()
  expect(reply_parameters).toEqual({ message_id: 9 })
  // the uploaded parts are the files themselves
  const attached = media.map((m: any) => String(m.media).slice('attach://'.length))
  expect(attached.map((k: string) => calls[0]!.body[k]?.file)).toEqual(['a.png', 'b.jpg', 'e.webp'])
  expect(r.text).toMatch(/^sent 3 messages \(ids: \d+, \d+, \d+\): an album of 3 photos with the text as the caption of the first photo$/)
  // each album message is recorded, the caption with the first
  const ids = r.text.match(/ids: ([\d, ]+)\)/)![1]!.split(', ')
  expect(ids.map(id => r.store.lookup('111', id)?.content)).toEqual([`(photo: ${A})\n*三張*`, `(photo: ${B})`, `(photo: ${E})`])
})

test('photos and documents never share an album: photos together, documents together, in the order of each kind\'s first file', async () => {
  expect(groupFiles([C, A, D, B])).toEqual([{ kind: 'document', files: [C, D] }, { kind: 'photo', files: [A, B] }])
  const r = await reply({ text: '資料', files: [C, A, D, B] })
  expect(methods()).toEqual(['sendMediaGroup', 'sendMediaGroup'])
  expect(calls[0]!.body.media.map((m: any) => [m.type, m.caption])).toEqual([['document', '資料'], ['document', undefined]])
  expect(calls[1]!.body.media.map((m: any) => [m.type, m.caption])).toEqual([['photo', undefined], ['photo', undefined]])
  expect(r.text).toContain(': an album of 2 documents with the text as the caption of the first document, then an album of 2 photos')
})

test('one of a kind is sent on its own (an album needs 2); more than 10 of a kind are split into albums of at most 10', async () => {
  await reply({ text: 'mixed', files: [A, C] })
  expect(methods()).toEqual(['sendPhoto', 'sendDocument'])
  expect(calls[0]!.body.caption).toBe('mixed')
  expect(calls[1]!.body.caption).toBeUndefined()
  calls = []
  const twelve = Array.from({ length: 12 }, (_, i) => file(`p${i}.jpg`))
  expect(groupFiles(twelve).map(g => g.files.length)).toEqual([10, 2])
  const eleven = twelve.slice(0, 11)
  const r = await reply({ text: 'many', files: eleven })
  expect(methods()).toEqual(['sendMediaGroup', 'sendPhoto'])
  expect(calls[0]!.body.media).toHaveLength(10)
  expect(calls[0]!.body.media[0].caption).toBe('many')
  expect(calls[1]!.body.caption).toBeUndefined()
  expect(r.text).toMatch(/^sent 11 messages .*: an album of 10 photos with the text as the caption of the first photo, then 1 photo$/)
})

// --- unchanged without files --------------------------------------------------------

test('no files: the text goes as before, one message or parts', async () => {
  const one = await reply({ text: 'hello' })
  expect(one.text).toMatch(/^sent \(id: \d+\)$/)
  const two = await reply({ text: 'w'.repeat(5000) })
  expect(two.text).toMatch(/^sent 2 parts \(ids: \d+, \d+\)$/)
  expect(methods()).toEqual(['sendMessage', 'sendMessage', 'sendMessage'])
})

// --- the tool description and the doc say the same --------------------------------------

test('the reply tool description and docs/architecture.md describe captions, the limit and albums', () => {
  const tool = TOOL_DEFINITIONS.find(t => t.name === 'reply')!
  const filesDesc = (tool.inputSchema.properties as Record<string, { description?: string }>).files!.description!
  for (const s of ['caption', '1024', 'album', 'documents only']) expect(filesDesc).toContain(s)
  const doc = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'architecture.md'), 'utf8')
  const section = doc.slice(doc.indexOf('## 回覆與附件'))
  expect(section.length).toBeGreaterThan(20)
  for (const s of ['caption', '1024', 'sendMediaGroup', '10', 'parse_mode']) expect(section).toContain(s)
})
