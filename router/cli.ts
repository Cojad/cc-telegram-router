// Terminal side of the /router commands (plan 03 CLI): `cc-telegram-router cli
// <子指令...>` hands the command to the running router over its socket and
// prints the reply. The socket is reachable only from outside the worker
// sandbox, i.e. the owner's own terminal (TUI = owner).

import { encode, splitLines, type RouterToPlugin } from '../shared/protocol'

export async function runCli(socketPath: string, words: string[]): Promise<number> {
  const text = words[0] === 'restart' ? '/restart' : `/router ${words.join(' ')}`.trim()
  return new Promise(resolve => {
    let buf = ''
    const timer = setTimeout(() => { process.stderr.write('router did not answer\n'); resolve(1) }, 120_000)
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) { s.write(encode({ t: 'cli', id: 1, text })) },
        data(s, chunk) {
          const [lines, rest] = splitLines(buf + chunk.toString())
          buf = rest
          for (const line of lines) {
            const m = JSON.parse(line) as RouterToPlugin
            if (m.t === 'result' && m.id === 1) {
              process.stdout.write(m.result.content.map(c => c.text).join('\n') + '\n')
              clearTimeout(timer)
              s.end()
              resolve(0)
            }
          }
        },
        close() {},
        error() {},
      },
    }).catch(e => { clearTimeout(timer); process.stderr.write(`cannot reach router at ${socketPath}: ${e}\n`); resolve(1) })
  })
}
