// Terminal side of the /router commands (plan 03 CLI): `cctr cli
// <子指令...>` hands the command to the running router over its socket and
// prints the reply. The socket is reachable only from outside the worker
// sandbox, i.e. the owner's own terminal (TUI = owner).

import { encode, splitLines, type RouterToPlugin } from '../shared/protocol'
import { parseSendArgs, sendExitCode, MAX_TEXT, SEND_USAGE } from './sessionsend'

export type CliIo = {
  out(s: string): void
  err(s: string): void
  /** stdin as text (session send without a text) */
  stdin(): Promise<string>
  /** stdin is a terminal: nothing is piped in */
  stdinIsTTY(): boolean
}
const processIo: CliIo = {
  out: s => void process.stdout.write(s),
  err: s => void process.stderr.write(s),
  stdin: () => Bun.stdin.text(),
  stdinIsTTY: () => !!process.stdin.isTTY,
}

/** cli without a router to talk to: what to look at instead (cli doctor: the offline cctr doctor). */
export function unreachable(socketPath: string, e: unknown, word?: string): string {
  const offline = word === 'doctor' ? '不經 router 的檢查改用 cctr doctor (只看檔案與指令). ' : ''
  return `router 沒在跑 (連不到 ${socketPath}: ${e}). ${offline}看 router 的狀態: systemctl --user status cc-telegram-router, 最近的 log: journalctl --user -u cc-telegram-router -n 50; 啟動: systemctl --user start cc-telegram-router\n`
}

export async function runCli(socketPath: string, words: string[], io: CliIo = processIo): Promise<number> {
  // session send: the text goes as it is (newlines and spaces kept), beside the command line
  const send = words[0] === 'session' && words[1] === 'send'
  let body: string | undefined
  let text = words[0] === 'restart' ? '/restart' : `/router ${words.join(' ')}`.trim()
  // a privileged skill action may take up to its timeout twice plus a refresh (router/skillcli.ts)
  let waitMs = words[0] === 'skill' && (words[1] === 'run' || words[1] === 'refresh') ? 3_600_000 : 120_000
  if (send) {
    const a = parseSendArgs(words.slice(2))
    if ('error' in a) { io.err(a.error + '\n'); return 1 }
    if (a.text === null && io.stdinIsTTY()) { io.err(`沒有要送的文字: 寫在指令後面, 或從 stdin 送進來 (例如 echo 文字 | ... send ${a.ref} -)\n${SEND_USAGE}\n`); return 1 }
    body = a.text ?? (await io.stdin())
    if (!body.trim()) { io.err('沒有要送的文字 (內容是空的)\n'); return 1 }
    if (body.length > MAX_TEXT) { io.err(`文字太長 (${body.length} 字, 上限 ${MAX_TEXT})\n`); return 1 }
    text = `/router session send ${a.ref}${a.bot ? ` --bot ${a.bot}` : ''} --from ${a.from} --wait ${a.waitS}`
    waitMs = (a.waitS + 30) * 1000
  }
  return new Promise(resolve => {
    let buf = ''
    const timer = setTimeout(() => { io.err(`router 沒有回應 (等了 ${Math.round(waitMs / 1000)} 秒): 看 journalctl --user -u cc-telegram-router -n 50\n`); resolve(1) }, waitMs)
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) { s.write(encode({ t: 'cli', id: 1, text, ...(body !== undefined ? { body } : {}) })) },
        data(s, chunk) {
          const [lines, rest] = splitLines(buf + chunk.toString())
          buf = rest
          for (const line of lines) {
            const m = JSON.parse(line) as RouterToPlugin
            if (m.t === 'result' && m.id === 1) {
              const reply = m.result.content.map(c => c.text).join('\n')
              io.out(reply + '\n')
              clearTimeout(timer)
              s.end()
              resolve(send ? sendExitCode(reply) : 0)
            }
          }
        },
        close() {},
        error() {},
      },
    }).catch(e => {
      clearTimeout(timer)
      io.err(send ? `router 沒在跑 (連不到 ${socketPath}: ${e}), 訊息沒有送出\n` : unreachable(socketPath, e, words[0]))
      resolve(1)
    })
  })
}
