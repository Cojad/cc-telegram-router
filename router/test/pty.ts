// A program in a pseudo terminal (util-linux script), for the setup wizard's
// end-to-end tests (e2e-wizard.test.ts, e2e-compiled.test.ts): answer(prompt,
// keys) waits for the prompt to appear on the screen, then types the keys.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function inTerminal(argv: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(['script', '-qec', argv.map(a => `'${a}'`).join(' '), '/dev/null'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  let out = '', from = 0
  void (async () => { for await (const c of p.stdout as ReadableStream<Uint8Array>) out += new TextDecoder().decode(c) })()
  return {
    get out() { return out },
    async answer(prompt: string, keys: string | string[]) {
      for (let t = 0; !out.slice(from).includes(prompt); t += 20) {
        if (t > 15000) throw new Error(`no prompt ${JSON.stringify(prompt)}; screen:\n${out.slice(-1500)}`)
        await sleep(20)
      }
      from = out.indexOf(prompt, from) + prompt.length
      for (const k of Array.isArray(keys) ? keys : [keys]) { p.stdin.write(k); await p.stdin.flush(); await sleep(30) }
    },
    exited: p.exited,
    close() { p.stdin.end() },
  }
}

