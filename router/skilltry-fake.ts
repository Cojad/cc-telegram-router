// Runs inside skill_try's sandbox (router/skilltry.ts), in its own network
// namespace (router/sandboxnet.ts): a fake service on that namespace's
// 127.0.0.1 standing in for every credential the action declares, then the
// action itself. Every "__CCTR_FAKE__" in the environment becomes this
// service's base URL ($<ENV>_URL = .../http/<ENV>, $<ENV>_API = .../bot<fake
// token>). Bot API calls get {"ok":true,"result":true}, http calls
// {"fake":true}; each request is logged (method, path, header names, body
// size and its first 200 characters) as a JSON line in the file the router
// reads afterwards. Standalone on purpose: no imports (it runs from wherever
// the router is installed, inside a sandbox that hides most of the disk).
//   bun skilltry-fake.ts <log file> -- <command...>

import { appendFileSync } from 'fs'

const [log, sep, ...cmd] = process.argv.slice(2)
if (!log || sep !== '--' || !cmd.length) { console.error('usage: skilltry-fake.ts <log> -- <command...>'); process.exit(2) }

const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(req) {
    const u = new URL(req.url)
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text().catch(() => '')
    try { appendFileSync(log!, JSON.stringify({ method: req.method, path: u.pathname + u.search, headers: [...req.headers.keys()].sort(), bytes: Buffer.byteLength(body), head: body.slice(0, 200) }) + '\n') } catch {}
    if (/^\/bot[^/]+\//.test(u.pathname)) return Response.json({ ok: true, result: true })
    return Response.json({ fake: true })
  },
})
const base = `http://127.0.0.1:${server.port}`
const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v.split('__CCTR_FAKE__').join(base)
const p = Bun.spawn(cmd, { env, stdio: ['ignore', 'inherit', 'inherit'] })
const code = await p.exited
server.stop(true)
process.exit(code)
