// The shared toolbox (docs/skill-runtime.md 「工具箱」, 柯姊 2026-10-18): fixed
// versions of ffmpeg (static), deno and uv, downloaded by `router
// toolbox install` (deploy/install.sh router runs it), each file checked
// against its sha256 before it is unpacked, kept in <stateDir>/toolbox/bin and
// mounted read-only at /cctr/tools/bin in every sandbox, first on PATH. A tool
// that fails to download only fails the skills that declare it (privileged.json
// "tools"); the router runs on. installed.json says what is there.
// uv also builds the skills' Python environments (router/skillenv.ts).
// Host tools (HOST_TOOLS: the static bwrap that runs every claude command in
// managed mode, docs/managed-channel.md) go to <stateDir>/toolbox/host instead,
// which no sandbox sees; one that fails puts the router in legacy mode.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { basename, isAbsolute, join } from 'path'

export type Arch = 'x64' | 'arm64'
/** One downloaded file: unpacked (raw: as it is; gz: the file itself; zip, tgz: one member) into bin/<as>. */
export type ToolFile = { url: string; sha256: string; unpack: 'raw' | 'gz' | 'zip' | 'tgz'; member?: string; as: string }
/** host: installed into <toolbox>/host (the router's own use, never mounted in a sandbox). */
export type Tool = { name: string; version: string; files: Partial<Record<Arch, ToolFile[]>>; host?: boolean }

const GH = 'https://github.com'
/** Release assets of fixed tags (GitHub keeps them; the sha256 is GitHub's own digest of each asset). */
export const TOOLS: Tool[] = [
  {
    // eugeneware/ffmpeg-static release b6.1.1: johnvansickle's static ffmpeg 7.0.2 (his own URLs move,
    // BtbN's autobuilds get deleted; a GitHub release asset of a fixed tag stays)
    name: 'ffmpeg', version: '7.0.2', files: {
      x64: [
        { url: `${GH}/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz`, sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa', unpack: 'gz', as: 'ffmpeg' },
        { url: `${GH}/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-x64.gz`, sha256: '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067', unpack: 'gz', as: 'ffprobe' },
      ],
      arm64: [
        { url: `${GH}/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-arm64.gz`, sha256: '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0', unpack: 'gz', as: 'ffmpeg' },
        { url: `${GH}/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-linux-arm64.gz`, sha256: '2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8', unpack: 'gz', as: 'ffprobe' },
      ],
    },
  },
  {
    name: 'deno', version: '2.9.7', files: {
      x64: [{ url: `${GH}/denoland/deno/releases/download/v2.9.7/deno-x86_64-unknown-linux-gnu.zip`, sha256: 'c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490', unpack: 'zip', member: 'deno', as: 'deno' }],
      arm64: [{ url: `${GH}/denoland/deno/releases/download/v2.9.7/deno-aarch64-unknown-linux-gnu.zip`, sha256: 'c832298b1ad4422481334855f6003e0f54145762c5a134f20a489511d2f65bbf', unpack: 'zip', member: 'deno', as: 'deno' }],
    },
  },
  {
    name: 'uv', version: '0.12.22', files: {
      x64: [{ url: `${GH}/astral-sh/uv/releases/download/0.12.22/uv-x86_64-unknown-linux-musl.tar.gz`, sha256: 'a50fd68c653b0cfb1c85e0a7db62cb78cf5c22b6f3dcf3ae173e5f222d084470', unpack: 'tgz', member: 'uv-x86_64-unknown-linux-musl/uv', as: 'uv' }],
      arm64: [{ url: `${GH}/astral-sh/uv/releases/download/0.12.22/uv-aarch64-unknown-linux-musl.tar.gz`, sha256: '228bd32c180421a94eef91378a92b2dd63c768bd278430e833250524c4a13382', unpack: 'tgz', member: 'uv-aarch64-unknown-linux-musl/uv', as: 'uv' }],
    },
  },
]
export const TOOL_NAMES = TOOLS.map(t => t.name)

/** The router's own tools: bubblewrap 0.13.1 built static by this repo's .github/workflows/bwrap-static.yml
 *  (Alpine, musl, libcap static), a release asset of a fixed tag; x64 only (no arm64 build yet). */
export const HOST_TOOLS: Tool[] = [
  {
    name: 'bwrap', version: '0.13.1', host: true, files: {
      x64: [{ url: `${GH}/Cojad/cc-telegram-router/releases/download/bwrap-0.13.1/bwrap-0.13.1-x86_64`, sha256: '75385f30c42599fc3bfa5b35a399bf1fdfba79f97b0798e4fcc110d27b08c315', unpack: 'raw', as: 'bwrap' }],
    },
  },
]
/** What toolbox install installs: the sandboxes' tools and the router's own. */
export const ALL_TOOLS: Tool[] = [...TOOLS, ...HOST_TOOLS]

/** Where the toolbox lives: <stateDir>/toolbox. */
export const toolboxDir = (stateDir: string) => join(stateDir, 'toolbox')
export const binDir = (toolbox: string) => join(toolbox, 'bin')
/** Host tools' folder: <toolbox>/host, mounted in no sandbox. */
export const hostDir = (toolbox: string) => join(toolbox, 'host')
const toolDir = (toolbox: string, host?: boolean) => host ? hostDir(toolbox) : binDir(toolbox)
export type Installed = Record<string, { version: string; bins: Record<string, string>; host?: boolean }>

/** What installed.json says, the files checked to be there; {} when nothing is. */
export function installed(toolbox: string): Installed {
  let j: Installed
  try { j = JSON.parse(readFileSync(join(toolbox, 'installed.json'), 'utf8')) } catch { return {} }
  return Object.fromEntries(Object.entries(j).filter(([, t]) => t && Object.keys(t.bins ?? {}).every(b => existsSync(join(toolDir(toolbox, t.host), b)))))
}

/** A host tool's path when installed.json has it and the file's sha256 is still the recorded one; else why not. */
export function hostTool(toolbox: string, name: string, bin = name): { path: string } | { why: string } {
  const t = installed(toolbox)[name]
  if (!t?.host || !t.bins[bin]) return { why: `工具箱沒有 ${name} (cctr toolbox install)` }
  const path = join(hostDir(toolbox), bin)
  let got = ''
  try { got = sha256(readFileSync(path)) } catch (e) { return { why: `讀不到 ${path}: ${e instanceof Error ? e.message : e}` } }
  if (got !== t.bins[bin]) return { why: `${path} 的 sha256 跟安裝時不同 (重跑 cctr toolbox install)` }
  return { path }
}

/** Which of these tools (privileged.json "tools") the toolbox lacks. */
export function missingTools(toolbox: string | undefined, tools: string[] = []): string[] {
  const have = toolbox ? installed(toolbox) : {}
  return tools.filter(t => !have[t])
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** The file's bytes: from a mirror (a folder or a URL holding the files under their own names) or its URL. */
async function fetchFile(f: ToolFile, mirror?: string): Promise<Uint8Array> {
  const name = basename(new URL(f.url).pathname)
  if (mirror && isAbsolute(mirror)) return new Uint8Array(readFileSync(join(mirror, name)))
  const url = mirror ? `${mirror.replace(/\/+$/, '')}/${name}` : f.url
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) })
  if (!r.ok) throw new Error(`下載 ${url} 失敗: HTTP ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

/** One member of the checked archive, written to out. zip and tgz go through python3 and tar
 *  (both required by the router), only ever extracting the named member, never a path from the archive. */
function unpack(f: ToolFile, data: Uint8Array, work: string, out: string) {
  if (f.unpack === 'raw') { writeFileSync(out, data); return }
  if (f.unpack === 'gz') { writeFileSync(out, Bun.gunzipSync(data)); return }
  const arc = join(work, 'archive')
  writeFileSync(arc, data)
  const p = f.unpack === 'zip'
    ? Bun.spawnSync(['python3', '-I', '-c', 'import sys, zipfile\nopen(sys.argv[3], "wb").write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', arc, f.member!, out], { stderr: 'pipe' })
    : Bun.spawnSync(['sh', '-c', 'tar -xzOf "$1" -- "$2" > "$3"', 'sh', arc, f.member!, out], { stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`解開 ${f.member} 失敗: ${p.stderr.toString().trim().slice(-300)}`)
}

export type InstallResult = { name: string; version: string; status: 'installed' | 'kept' | 'failed' | 'unsupported'; why?: string }

/** Install every tool of tools (default ALL_TOOLS) for this CPU into toolbox. A tool already at its version
 *  with the same files is kept; one that fails is left as it was and reported; the rest go on. */
export async function installTools(toolbox: string, o: { mirror?: string; arch?: string; tools?: Tool[] } = {}): Promise<InstallResult[]> {
  const arch = (o.arch ?? process.arch) as Arch
  mkdirSync(binDir(toolbox), { recursive: true, mode: 0o755 })
  const out: InstallResult[] = []
  for (const t of o.tools ?? ALL_TOOLS) {
    const files = t.files[arch]
    if (!files?.length) { out.push({ name: t.name, version: t.version, status: 'unsupported', why: `沒有 ${arch} 的版本` }); continue }
    const dir = toolDir(toolbox, t.host)
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    const have = installed(toolbox)[t.name]
    if (have?.version === t.version && files.every(f => have.bins[f.as] && existsSync(join(dir, f.as)) && sha256(readFileSync(join(dir, f.as))) === have.bins[f.as])) {
      out.push({ name: t.name, version: t.version, status: 'kept' }); continue
    }
    const work = join(toolbox, `.work-${t.name}-${process.pid}`)
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    try {
      const bins: Record<string, string> = {}
      for (const f of files) {
        const data = await fetchFile(f, o.mirror)
        const got = sha256(data)
        if (got !== f.sha256) throw new Error(`${basename(new URL(f.url).pathname)} 的 sha256 不符 (應為 ${f.sha256}, 收到 ${got}), 不安裝`)
        const tmp = join(work, f.as)
        unpack(f, data, work, tmp)
        chmodSync(tmp, 0o755)
        bins[f.as] = sha256(readFileSync(tmp))
      }
      // every file checked: put them in place (each one replaced atomically), then record the version
      for (const f of files) renameSync(join(work, f.as), join(dir, f.as))
      const j = installed(toolbox)
      j[t.name] = { version: t.version, bins, ...(t.host ? { host: true } : {}) }
      writeFileSync(join(toolbox, 'installed.json.new'), JSON.stringify(j, null, 1))
      renameSync(join(toolbox, 'installed.json.new'), join(toolbox, 'installed.json'))
      out.push({ name: t.name, version: t.version, status: 'installed' })
    } catch (e) {
      out.push({ name: t.name, version: t.version, status: 'failed', why: e instanceof Error ? e.message : String(e) })
    } finally { rmSync(work, { recursive: true, force: true }) }
  }
  return out
}

/** The toolbox's state, one line per tool (cctr toolbox status, /router status). */
export function describeToolbox(toolbox: string): string {
  const have = installed(toolbox)
  return ALL_TOOLS.map(t => have[t.name] ? `${t.name} ${have[t.name]!.version}${have[t.name]!.version === t.version ? '' : ` (這版 router 用 ${t.version}, 重跑 toolbox install)`}` : `${t.name}: 沒有安裝 (cctr toolbox install)`).join('\n')
}

/** `cctr toolbox install [--state <stateDir>] [--mirror <folder or URL>]` and
 *  `toolbox status [--state <stateDir>]`: stateDir defaults to the executable's folder (the compiled
 *  router lives there). Exit 1 when a tool failed (the others are installed anyway). */
export async function toolboxCli(args: string[], defaultState: string, print: (s: string) => void = s => console.log(s)): Promise<number> {
  const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  const state = opt('--state') ?? defaultState
  const box = toolboxDir(state)
  if (args[0] === 'status') { print(describeToolbox(box)); return 0 }
  if (args[0] !== 'install') { print('用法: cctr toolbox install|status [--state <stateDir>] [--mirror <資料夾或網址>]'); return 2 }
  const rs = await installTools(box, { mirror: opt('--mirror') })
  for (const r of rs) print(`${r.name} ${r.version}: ${{ installed: '已安裝', kept: '已是這個版本', failed: '失敗', unsupported: '不支援' }[r.status]}${r.why ? ` (${r.why})` : ''}`)
  print(`工具箱: ${box}/bin`)
  return rs.some(r => r.status === 'failed') ? 1 : 0
}
