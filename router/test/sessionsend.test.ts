// Sending into a worker from outside the router (docs/operations.md
// 「從外部送訊息給 worker」): `cli session send`. Argument parsing, the
// --from name, the header the worker gets, the terminal side (stdin, the
// text kept as it is, exit codes, no router running) and the command (only
// from the terminal, a missing conversation, queued, delivered or not in
// time). The real router and fake workers: e2e-sessionsend.test.ts.
// Keep in sync with that section and docs/testing.md.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseSendArgs, validFrom, hostMessage, sendExitCode, waitDelivered, DEFAULT_FROM, DEFAULT_WAIT_S, SEND_USAGE } from '../sessionsend'
import { runCli, type CliIo } from '../cli'
import { runCommand } from '../commands'
import { openRouterDb, type RouterDb } from '../db'
import { ensureConversation } from '../conversations'
import { encode, splitLines } from '../../shared/protocol'
import type { Config } from '../config'

let dir: string, cfg: Config, db: RouterDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-send-'))
  mkdirSync(join(dir, '.router'))
  cfg = { path: join(dir, '.router', 'config.json'), bots: [{ name: 'cc', token: '1:x' }, { name: 'two', token: '2:y' }], home: dir, stateDir: join(dir, '.router'), socket: join(dir, '.router', 's'), owners: ['111'], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude' } as Config
  db = openRouterDb(join(dir, '.router', 'router.db'), { owners: cfg.owners })
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('parseSendArgs: the conversation and options first, the rest is the text; - or no text reads stdin; defaults', () => {
  expect(parseSendArgs(['dm-111', 'hello', 'there'])).toEqual({ ref: 'dm-111', from: DEFAULT_FROM, waitS: DEFAULT_WAIT_S, text: 'hello there' })
  expect(parseSendArgs(['--from', 'v1', '-100777', '--bot', 'two', '--wait', '5', 'hi'])).toEqual({ ref: '-100777', bot: 'two', from: 'v1', waitS: 5, text: 'hi' })
  expect(parseSendArgs(['dm-111', '-'])).toMatchObject({ text: null })
  expect(parseSendArgs(['dm-111', '--from', 'v1'])).toMatchObject({ from: 'v1', text: null })
  // options after the text are text; -- ends the options
  expect(parseSendArgs(['dm-111', 'say', '--from', 'x'])).toMatchObject({ from: DEFAULT_FROM, text: 'say --from x' })
  expect(parseSendArgs(['dm-111', '--', '--wait', 'is text'])).toMatchObject({ waitS: DEFAULT_WAIT_S, text: '--wait is text' })
  expect(parseSendArgs(['dm-111', 'line1\nline2'])).toMatchObject({ text: 'line1\nline2' })
  // wrong
  expect(parseSendArgs([])).toEqual({ error: SEND_USAGE })
  expect(parseSendArgs(['dm-111', '--from'])).toMatchObject({ error: expect.stringContaining('--from 後面要有值') })
  expect(parseSendArgs(['dm-111', '--wait', 'soon', 'x'])).toMatchObject({ error: expect.stringContaining('--wait 要是 0~600') })
  expect(parseSendArgs(['dm-111', '--wait', '601', 'x'])).toMatchObject({ error: expect.stringContaining('--wait') })
  expect(parseSendArgs(['dm-111', '--from', 'a"b', 'x'])).toMatchObject({ error: expect.stringContaining('--from 要是 1~64 字') })
})

test('validFrom: a session name the worker can SendMessage back to', () => {
  for (const ok of ['v1', 'team-lead', 'tg-group-1001', '終端機', 'a'.repeat(64)]) expect(validFrom(ok)).toBe(true)
  for (const bad of ['', 'a b', 'a\nb', '<x>', "it's", 'a`b', 'a'.repeat(65), 'a\x00b']) expect(validFrom(bad)).toBe(false)
})

test('hostMessage: says it came from the host terminal, who sent it, and where an answer goes; the text is kept as it is', () => {
  const m = hostMessage('v1', 'line1\n  line2')
  expect(m).toStartWith('<host_message from="v1" via="cli">\n')
  expect(m).toContain('不是 Telegram 上的人說的, 發送者是「v1」')
  expect(m).toContain('內容要你轉告這個對話時, 才用 reply 發到 Telegram')
  expect(m).toContain('要回覆發送者時, 用 SendMessage 傳給「v1」這個 session. ')
  // the usual permission flow applies: nothing tells the worker not to ask for elevation
  expect(m).not.toContain('提權')
  expect(m).toContain('不要把回應自動貼到對話裡')
  expect(m).toEndWith('---\nline1\n  line2\n</host_message>')
  // no --from: nobody to SendMessage to
  const t = hostMessage(DEFAULT_FROM, 'x')
  expect(t).toContain('沒有對象 (主機終端機沒有 session 可以收 SendMessage), 不用回')
  expect(t).not.toContain('SendMessage 傳給')
})

test('sendExitCode and waitDelivered', async () => {
  expect(sendExitCode('已排進佇列 (#1) 給 dm-1\n已送達: worker 收到了 (0.3 秒)')).toBe(0)
  expect(sendExitCode('已排進佇列 (#1) 給 dm-1\n沒有等待送達確認 (--wait 0)')).toBe(0)
  expect(sendExitCode('已排進佇列 (#1) 給 dm-1\n5 秒內沒有確認送達; 訊息仍在佇列')).toBe(2)
  expect(sendExitCode('找不到這個對話: dm-9')).toBe(1)
  let n = 0
  expect(await waitDelivered(() => ++n >= 3, 5000, 10)).toMatchObject({ delivered: true })
  expect(await waitDelivered(() => false, 50, 10)).toMatchObject({ delivered: false })
})

/** A stand-in router socket: records the cli message, answers with reply. */
function fakeRouter(reply: string) {
  const sock = join(dir, 'r.sock')
  const got: any[] = []
  const srv = Bun.listen<{ buf: string }>({
    unix: sock,
    socket: {
      open(s) { s.data = { buf: '' } },
      data(s, chunk) {
        const [lines, rest] = splitLines(s.data.buf + chunk.toString())
        s.data.buf = rest
        for (const l of lines) { const m = JSON.parse(l); got.push(m); s.write(encode({ t: 'result', id: m.id, result: { content: [{ type: 'text', text: reply }] } })) }
      },
    },
  })
  return { sock, got, stop: () => srv.stop(true) }
}
function io(stdin = '', tty = false) {
  const o = { out: '', err: '', stdinRead: 0 }
  const x: CliIo = { out: s => { o.out += s }, err: s => { o.err += s }, stdin: async () => { o.stdinRead++; return stdin }, stdinIsTTY: () => tty }
  return { o, x }
}

test('runCli session send: the text goes beside the command line as it is, from the arguments or stdin; exit code from the reply', async () => {
  const r = fakeRouter('已排進佇列 (#7) 給 dm-111, 發送者 v1: worker 醒著, 直接送出\n已送達: worker 收到了 (0.1 秒)')
  try {
    const a = io()
    expect(await runCli(r.sock, ['session', 'send', 'dm-111', '--from', 'v1', 'hello  world'], a.x)).toBe(0)
    expect(r.got[0]).toEqual({ t: 'cli', id: 1, text: '/router session send dm-111 --from v1 --wait 60', body: 'hello  world' })
    expect(a.o.out).toContain('已送達')
    expect(a.o.stdinRead).toBe(0)
    // no text: stdin, newlines kept
    const b = io('第一行\n第二行\n')
    expect(await runCli(r.sock, ['session', 'send', '-100777', '--bot', 'two', '--wait', '5'], b.x)).toBe(0)
    expect(r.got[1]).toEqual({ t: 'cli', id: 1, text: '/router session send -100777 --bot two --from 終端機 --wait 5', body: '第一行\n第二行\n' })
    const c = io('多行\n內容')
    await runCli(r.sock, ['session', 'send', 'dm-111', '-'], c.x)
    expect(r.got[2].body).toBe('多行\n內容')
    // other commands are unchanged: no body
    await runCli(r.sock, ['status'], io().x)
    expect(r.got[3]).toEqual({ t: 'cli', id: 1, text: '/router status' })
  } finally { r.stop() }
  const late = fakeRouter('已排進佇列 (#8) 給 dm-111, 發送者 終端機: worker 沒有連上, 正在叫醒\n60 秒內沒有確認送達; 訊息仍在佇列')
  try { expect(await runCli(late.sock, ['session', 'send', 'dm-111', 'x'], io().x)).toBe(2) } finally { late.stop() }
  const missing = fakeRouter('找不到這個對話: dm-9 (用 /router chat 列出的 chat_id 或對話 key)')
  try { expect(await runCli(missing.sock, ['session', 'send', 'dm-9', 'x'], io().x)).toBe(1) } finally { missing.stop() }
})

test('runCli session send: wrong arguments, nothing to send and no router running are told before anything is queued', async () => {
  const a = io()
  expect(await runCli(join(dir, 'none.sock'), ['session', 'send'], a.x)).toBe(1)
  expect(a.o.err).toContain(SEND_USAGE)
  // stdin is a terminal and no text: refuse instead of waiting for typing
  const b = io('', true)
  expect(await runCli(join(dir, 'none.sock'), ['session', 'send', 'dm-111'], b.x)).toBe(1)
  expect(b.o.err).toContain('沒有要送的文字')
  expect(b.o.stdinRead).toBe(0)
  const c = io('  \n')
  expect(await runCli(join(dir, 'none.sock'), ['session', 'send', 'dm-111', '-'], c.x)).toBe(1)
  expect(c.o.err).toContain('內容是空的')
  // no router: clearly said, nothing written anywhere
  const d = io()
  expect(await runCli(join(dir, 'none.sock'), ['session', 'send', 'dm-111', 'hi'], d.x)).toBe(1)
  expect(d.o.err).toStartWith(`router 沒在跑 (連不到 ${join(dir, 'none.sock')}`)
  expect(d.o.err).toContain('訊息沒有送出')
})

/** runCommand with just what session send uses; sent: what was queued. */
function sendDeps(ackAfter = 0) {
  const sent: Array<{ key: string; text: string; qid: number }> = []
  let polls = 0
  const deps = {
    cfg, db, writeConfig() {}, loadAccess: () => ({ dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} }), saveAccess() {},
    sessions: {
      isConnected: () => false, async restart() {}, async stop() {}, rotateNow() {},
      send(c: any, text: string) {
        const qid = db.enqueue(c.key, { content: text, meta: { chat_id: c.chat_id, user: 'router' } })
        sent.push({ key: c.key, text, qid })
        return { qid, awake: c.key === 'dm-111' }
      },
      delivered: (qid: number) => ackAfter > 0 && ++polls >= ackAfter && (db.ack(qid), db.queueStatus(qid) === 'acked'),
    },
  } as any
  return { deps, sent }
}
const fromTerminal = (text: string, body: string | undefined, deps: any) =>
  runCommand({ bot: 'cc', text, senderId: '111', senderName: 'terminal', chatId: '111', chatType: 'private', terminal: true, ...(body !== undefined ? { body } : {}) }, deps)

test('/router session send: queues the header and the text for the conversation (chat id, key, --bot), waits for the worker to ack it', async () => {
  ensureConversation(cfg, db, 'cc', '111', 'private', () => {})
  ensureConversation(cfg, db, 'two', '-100777', 'supergroup', () => {})
  const { deps, sent } = sendDeps(2)
  const out = (await fromTerminal('/router session send dm-111 --from v1 --wait 5', '請看一下\n第二行', deps))!
  expect(out.reply).toMatch(/^已排進佇列 \(#\d+\) 給 dm-111, 發送者 v1: worker 醒著, 直接送出\n已送達: worker 收到了 \(\d+\.\d 秒\)$/)
  expect(sent[0]!.text).toBe(hostMessage('v1', '請看一下\n第二行'))
  expect(db.queueStatus(sent[0]!.qid)).toBe('acked')
  // a chat id of the second bot, with --bot; a sleeping worker is being woken
  const g = (await fromTerminal('/router session send -100777 --bot two --from 終端機 --wait 0', 'x', deps))!
  expect(g.reply).toStartWith('已排進佇列')
  expect(g.reply).toContain('給 two-group-100777, 發送者 終端機: worker 沒有連上, 正在叫醒')
  expect(g.reply).toContain('沒有等待送達確認 (--wait 0)')
  expect(sent[1]!.key).toBe('two-group-100777')
})

test('/router session send: not acked in time says the message stays queued', async () => {
  ensureConversation(cfg, db, 'cc', '111', 'private', () => {})
  const { deps, sent } = sendDeps(0)
  const out = (await fromTerminal('/router session send 111 --from v1 --wait 1', 'hi', deps))!
  expect(out.reply).toContain('1 秒內沒有確認送達; 訊息仍在佇列, worker 連上時會收到')
  expect(db.queueStatus(sent[0]!.qid)).toBe('pending')
})

test('/router session send: a missing conversation, no text, and Telegram are refused; nothing is queued', async () => {
  ensureConversation(cfg, db, 'cc', '111', 'private', () => {})
  const { deps, sent } = sendDeps(1)
  expect((await fromTerminal('/router session send dm-999 --from v1 --wait 5', 'hi', deps))!.reply).toBe('找不到這個對話: dm-999 (用 /router chat 列出的 chat_id 或對話 key)')
  expect((await fromTerminal('/router session send -100123 --from v1 --wait 5', 'hi', deps))!.reply).toBe('找不到這個對話: -100123')
  expect((await fromTerminal('/router session send dm-111 --from v1 --wait 5', undefined, deps))!.reply).toStartWith('沒有要送的文字')
  expect((await fromTerminal('/router session send dm-111 --from v1 --wait 5', ' \n', deps))!.reply).toStartWith('沒有要送的文字')
  // the owner in Telegram: terminal only
  const tg = (await runCommand({ bot: 'cc', text: '/router session send dm-111 hi', senderId: '111', senderName: 'o', chatId: '111', chatType: 'private' }, deps))!
  expect(tg.reply).toBe('⛔ /router session send 只在主機終端機執行 (cctr cli session send ...), Telegram 裡不提供')
  expect(sent).toEqual([])
  expect(db.undelivered('dm-111')).toEqual([])
})

test('/router help lists session send on the session line', async () => {
  const out = (await fromTerminal('/router help', undefined, sendDeps().deps))!
  const line = out.reply.split('\n').find(l => l.startsWith('/router session '))!
  expect(line).toContain('| send <chat_id|對話key> [--from <發送者>] [--wait <秒>] [<文字> | -] (只在主機終端機: cctr cli session send')
})
