// The shared toolbox (docs/skill-runtime.md 「工具箱」, router/toolbox.ts): fixed
// versions, each file checked against its sha256 before it is unpacked (gz,
// zip, tgz: only the named member), installed into <stateDir>/toolbox/bin
// with installed.json; the same version again is kept; a file whose sha256
// does not match fails that tool only (the rest are installed, the old one
// stays); a CPU without a build is unsupported; from a mirror folder or URL.
// In the sandbox (real bwrap): the toolbox at /cctr/tools/bin, first on PATH;
// an action declaring a tool the toolbox lacks is refused, saying which and
// how to install it; privileged.json "tools" only names toolbox tools. The
// real table: every tool for x64 and arm64, GitHub release assets of fixed
// tags with sha256; LIVE=1 installs the real ones and runs them in a sandbox.
// Keep in sync with that section and deploy/install.sh router.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { TOOLS, TOOL_NAMES, installTools, installed, missingTools, describeToolbox, toolboxCli, binDir, type Tool } from '../toolbox'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { hashSkill, loadManifest } from '../privskill'
import { runSkill, type SkillRunDeps } from '../skillrun'
import { sandboxDeps } from './fixtures/sandbox'

const ROOT = join(import.meta.dir, '..', '..')
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
let dir: string, mirror: string, box: string

/** A fake tool: a shell script printing its name and arguments. */
const script = (name: string) => `#!/bin/sh\necho "fake ${name} $*"\n`

function testTools(): Tool[] {
  // gz: the file itself
  writeFileSync(join(mirror, 'ffmpeg-linux-x64.gz'), Bun.gzipSync(Buffer.from(script('ffmpeg'))))
  writeFileSync(join(mirror, 'ffprobe-linux-x64.gz'), Bun.gzipSync(Buffer.from(script('ffprobe'))))
  // zip: one member, by python3 (the router reads it the same way)
  writeFileSync(join(dir, 'deno'), script('deno'))
  Bun.spawnSync(['python3', '-I', '-c', 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1], "w"); z.write(sys.argv[2], "deno"); z.writestr("../evil", "x"); z.close()', join(mirror, 'deno.zip'), join(dir, 'deno')])
  // tgz: one member out of a folder
  mkdirSync(join(dir, 'uv-x'), { recursive: true })
  writeFileSync(join(dir, 'uv-x', 'uv'), script('uv'))
  writeFileSync(join(dir, 'uv-x', 'other'), 'not taken')
  Bun.spawnSync(['tar', '-czf', join(mirror, 'uv.tar.gz'), '-C', dir, 'uv-x'])
  const f = (n: string) => sha(readFileSync(join(mirror, n)))
  return [
    { name: 'ffmpeg', version: '1.0', files: { x64: [
      { url: 'https://example.com/r/ffmpeg-linux-x64.gz', sha256: f('ffmpeg-linux-x64.gz'), unpack: 'gz', as: 'ffmpeg' },
      { url: 'https://example.com/r/ffprobe-linux-x64.gz', sha256: f('ffprobe-linux-x64.gz'), unpack: 'gz', as: 'ffprobe' },
    ] } },
    { name: 'deno', version: '2.0', files: { x64: [{ url: 'https://example.com/r/deno.zip', sha256: f('deno.zip'), unpack: 'zip', member: 'deno', as: 'deno' }] } },
    { name: 'uv', version: '0.1', files: { x64: [{ url: 'https://example.com/r/uv.tar.gz', sha256: f('uv.tar.gz'), unpack: 'tgz', member: 'uv-x/uv', as: 'uv' }] } },
  ]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctr-tools-'))
  mirror = join(dir, 'mirror'); mkdirSync(mirror)
  box = join(dir, 'state', 'toolbox')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('install: gz, zip and tgz checked by sha256 and unpacked (only the named member) into bin, executable, with installed.json; the same version again is kept', async () => {
  const tools = testTools()
  const r = await installTools(box, { mirror, arch: 'x64', tools })
  expect(r.map(x => `${x.name} ${x.status}`)).toEqual(['ffmpeg installed', 'deno installed', 'uv installed'])
  for (const b of ['ffmpeg', 'ffprobe', 'deno', 'uv']) {
    expect(readFileSync(join(binDir(box), b), 'utf8')).toBe(script(b))
    expect(statSync(join(binDir(box), b)).mode & 0o111).toBeTruthy()
  }
  expect(existsSync(join(binDir(box), 'other'))).toBe(false)
  expect(existsSync(join(box, 'evil'))).toBe(false)
  expect(installed(box)).toEqual({ ffmpeg: { version: '1.0', bins: { ffmpeg: sha(script('ffmpeg')), ffprobe: sha(script('ffprobe')) } }, deno: { version: '2.0', bins: { deno: sha(script('deno')) } }, uv: { version: '0.1', bins: { uv: sha(script('uv')) } } })
  expect((await installTools(box, { mirror, arch: 'x64', tools })).map(x => x.status)).toEqual(['kept', 'kept', 'kept'])
  expect(missingTools(box, ['ffmpeg', 'deno'])).toEqual([])
  // a file gone: no longer installed, installed again
  rmSync(join(binDir(box), 'ffprobe'))
  expect(missingTools(box, ['ffmpeg'])).toEqual(['ffmpeg'])
  expect((await installTools(box, { mirror, arch: 'x64', tools }))[0]!.status).toBe('installed')
})

test('install: a sha256 that does not match fails that tool only (nothing of it written, the old version kept); the others install; a CPU without a build is unsupported; from a URL mirror too', async () => {
  const tools = testTools()
  await installTools(box, { mirror, arch: 'x64', tools: [tools[1]!] })
  writeFileSync(join(mirror, 'ffprobe-linux-x64.gz'), Bun.gzipSync(Buffer.from('tampered')))
  const bad = { ...tools[1]!, version: '2.1', files: { x64: [{ ...tools[1]!.files.x64![0]!, sha256: '0'.repeat(64) }] } }
  const r = await installTools(box, { mirror, arch: 'x64', tools: [tools[0]!, bad, tools[2]!] })
  expect(r[0]).toMatchObject({ name: 'ffmpeg', status: 'failed', why: expect.stringContaining('ffprobe-linux-x64.gz 的 sha256 不符') })
  expect(r[1]).toMatchObject({ name: 'deno', status: 'failed', why: expect.stringContaining('deno.zip 的 sha256 不符') })
  expect(r[2]).toMatchObject({ name: 'uv', status: 'installed' })
  expect(existsSync(join(binDir(box), 'ffmpeg'))).toBe(false) // nothing of a failed tool lands
  expect(installed(box).deno!.version).toBe('2.0') // the old one stays
  expect(missingTools(box, ['ffmpeg', 'deno', 'uv'])).toEqual(['ffmpeg'])
  expect((await installTools(box, { mirror, arch: 'arm64', tools: [tools[2]!] }))[0]).toMatchObject({ status: 'unsupported', why: '沒有 arm64 的版本' })
  // a mirror served over http
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => new Response(Bun.file(join(mirror, new URL(req.url).pathname.split('/').pop()!))) })
  try {
    const box2 = join(dir, 'state2', 'toolbox')
    expect((await installTools(box2, { mirror: `http://127.0.0.1:${srv.port}/m/`, arch: 'x64', tools: [tools[2]!] }))[0]!.status).toBe('installed')
  } finally { srv.stop(true) }
})

test('toolbox status and the CLI: one line per tool, what is missing and how to install it; usage on anything else', async () => {
  expect(describeToolbox(box)).toBe(TOOLS.map(t => `${t.name}: 沒有安裝 (cc-telegram-router toolbox install)`).join('\n'))
  const out: string[] = []
  expect(await toolboxCli(['status', '--state', join(dir, 'state')], '/nowhere', s => out.push(s))).toBe(0)
  expect(out[0]).toContain('ffmpeg: 沒有安裝')
  expect(await toolboxCli(['nope'], '/nowhere', s => out.push(s))).toBe(2)
  expect(out.at(-1)).toStartWith('用法: cc-telegram-router toolbox install|status')
})

test('the real table: ffmpeg, deno and uv for x64 and arm64, GitHub release assets of fixed tags, each with its sha256; install.sh runs the install and only warns', () => {
  expect(TOOL_NAMES).toEqual(['ffmpeg', 'deno', 'uv'])
  for (const t of TOOLS) for (const arch of ['x64', 'arm64'] as const) {
    const fs = t.files[arch]!
    expect(fs.length).toBeGreaterThan(0)
    for (const f of fs) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(f.url).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w.-]+\/[\w.-]+$/)
      expect(f.url).not.toContain('/latest/')
    }
  }
  const sh = readFileSync(join(ROOT, 'deploy', 'install.sh'), 'utf8')
  expect(sh).toContain('if ! "$STATE/cc-telegram-router" toolbox install --state "$STATE"; then')
})

// --- in the sandbox -----------------------------------------------------------

let db: RouterDb, deps: SkillRunDeps, conv: Conversation, skill: string
function sandboxSetup() {
  mkdirSync(join(dir, 'state'), { recursive: true })
  db = openRouterDb(join(dir, 'state', 'router.db'))
  skill = join(dir, 'home', 'bot1', '.claude', 'skills', 'media')
  mkdirSync(skill, { recursive: true })
  const folder = join(dir, 'home', 'bot1', 'dm-7')
  mkdirSync(folder, { recursive: true })
  conv = { key: 'dm-7', bot: 'cc', chat_id: '7', type: 'dm', folder, role: 'user', session_id: null, created_at: '' }
  deps = {
    db, home: join(dir, 'home'), credsRoot: join(dir, 'state', 'creds'), userHome: join(dir, 'fakehome'), hidden: [join(dir, 'home'), join(dir, 'state')],
    botDir: () => join(dir, 'home', 'bot1'), toolbox: box, envRoot: join(dir, 'state', 'skill-env'),
    ...sandboxDeps(join(dir, 'state')),
    notifyOwner: () => {},
  }
}

test('in the sandbox: the toolbox at /cctr/tools/bin, first on PATH (before the system\'s ffmpeg); a declared tool the toolbox lacks refuses the run, saying which; tools names only toolbox tools', async () => {
  sandboxSetup()
  try {
    await installTools(box, { mirror, arch: process.arch, tools: testTools().slice(0, 1).map(t => ({ ...t, files: { [process.arch]: t.files.x64 } })) })
    writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: {
      cut: { run: ['bash', '-c', 'echo "PATH=$PATH"; command -v ffmpeg; ffmpeg -i x; ffprobe y'], tools: ['ffmpeg'] },
      js: { run: ['deno', 'run', 'x.ts'], tools: ['deno'] },
    } }))
    db.approveSkill(skill, 'media', hashSkill(skill), 'owner')
    const r = await runSkill(deps, conv, 'user', 'media', 'cut', {})
    expect(r.text).toContain('PATH=/cctr/tools/bin:/usr/local/bin:/usr/bin:/bin')
    expect(r.text).toContain('/cctr/tools/bin/ffmpeg\nfake ffmpeg -i x\nfake ffprobe y')
    const js = await runSkill(deps, conv, 'user', 'media', 'js', {})
    expect(js.ok).toBe(false)
    expect(js.text).toContain('工具箱缺少這個動作需要的 deno, 沒有執行 (安裝時下載失敗或還沒裝: owner 在主機上執行 cc-telegram-router toolbox install)')
    writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: { a: { run: ['true'], tools: ['ffmpeg', 'yt-dlp'] } } }))
    expect(() => loadManifest(skill)).toThrow('動作 a 的 tools 裡的 yt-dlp 不在工具箱裡 (有: ffmpeg, deno, uv)')
  } finally { db.close() }
}, 30_000)

test.skipIf(!process.env.LIVE)('LIVE=1: the real toolbox downloads, checks out and runs in a sandbox', async () => {
  const r = await installTools(box)
  expect(r.map(x => `${x.name} ${x.status}`)).toEqual(['ffmpeg installed', 'deno installed', 'uv installed'])
  sandboxSetup()
  try {
    writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions: { v: { run: ['bash', '-c', 'ffmpeg -version | head -1; ffprobe -version | head -1; deno --version | head -1; uv --version'], tools: TOOL_NAMES } } }))
    db.approveSkill(skill, 'media', hashSkill(skill), 'owner')
    const v = await runSkill(deps, conv, 'user', 'media', 'v', {})
    expect(v.text).toContain('ffmpeg version 7.0.2-static')
    expect(v.text).toContain('ffprobe version 7.0.2-static')
    expect(v.text).toContain('deno 2.9.7')
    expect(v.text).toContain('uv 0.12.22')
  } finally { db.close() }
}, 600_000)
