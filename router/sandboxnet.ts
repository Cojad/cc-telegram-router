// A sandboxed run's network (docs/skill-runtime.md 「網路」): the internet, but
// nothing on the host or its private networks. Every privileged action runs
// here: run_skill, the terminal's cli skill run, the daily and terminal
// refresh, skill_try. bwrap gets its own network namespace (--unshare-net)
// and waits (--block-fd) while the router, from outside, finds the user
// namespace that owns that network namespace (ioctl NS_GET_USERNS: bwrap may
// move the sandbox into a nested one meanwhile), (1) loads nft rules through
// nsenter into those two (the sandboxed process never holds CAP_NET_ADMIN, so
// it cannot change them), (2) starts slirp4netns on them by path to give it a
// tap device with a route out, and only then lets the command start.
// Refused destinations: the host's loopback and every private, shared,
// link-local (cloud metadata 169.254.169.254) and multicast range, IPv6
// loopback, unique-local and link-local, and the host's own addresses (its
// interfaces, and the public IPv4 the cloud metadata reports, looked up once).
// Internet ports: tcp and udp only to 80, 443, 53 and 22 (OUT_PORTS), except
// for the router's own internal actions (any port). The host itself: only the
// ports an internal action declared (privileged.json host.ports, owner
// approval), at slirp's host alias 10.0.2.2 (slirp maps it to the host's
// 127.0.0.1 only then; otherwise --disable-host-loopback). The namespace's own
// loopback stays open (a fake service may listen there). DNS goes to slirp's
// resolver (10.0.2.3, forwarded by slirp on the host), never the host's
// 127.0.0.53: the sandbox's /etc/resolv.conf says so.
// Unix sockets reach the host too, past any network namespace: the
// whitelisted file system (router/sandboxfs.ts) shows no /run and no socket
// file, and a seccomp filter refuses creating an AF_UNIX socket (socket(2);
// socketpair(2) still works) and io_uring_setup (io_uring can create sockets
// past that filter), so no path anywhere can be connected to. An internal
// action that declared host mounts (an ssh agent's socket) may create AF_UNIX
// sockets; it sees only the socket files it declared.
// When any piece is missing the run is refused: never all open, never all closed.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs'
import { networkInterfaces } from 'os'
import { join } from 'path'
import { dlopen, FFIType } from 'bun:ffi'

export const SLIRP_DNS = '10.0.2.3'
/** slirp's alias for the host: its 127.0.0.1, reachable only on an internal action's declared host ports. */
export const SLIRP_HOST = '10.0.2.2'
/** The internet ports every action but the router's own internal ones may reach (柯姊 2026-10-18). */
export const OUT_PORTS = [80, 443, 53, 22]
export const BLOCKED_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/3']
export const BLOCKED_V6 = ['::/128', '::1/128', '::ffff:0:0/96', 'fc00::/7', 'fe80::/10', 'ff00::/8']
const TOOLS = ['bwrap', 'nsenter', 'nft', 'slirp4netns']

const DIRS = () => [...(process.env.PATH ?? '').split(':'), '/usr/sbin', '/sbin', '/usr/bin', '/bin']
/** Which of the tools this needs are missing (PATH and the system bin folders), or null when all are there. */
export function netMissing(dirs: string[] = DIRS()): string | null {
  const miss = TOOLS.filter(t => !dirs.some(d => d && existsSync(join(d, t))))
  return miss.length ? miss.join(', ') : null
}
const which = (t: string) => DIRS().map(d => d && join(d, t)).find(p => p && existsSync(p)) ?? t

/** The host's own addresses: every interface's, but loopback (blocked anyway). */
export function interfaceAddrs(): string[] {
  return Object.values(networkInterfaces()).flat().filter(a => a && !a.internal).map(a => a!.address.replace(/%.*$/, ''))
}

let cloud: Promise<string[]> | null = null
/** The public IPv4 the cloud metadata service reports (EC2 IMDSv2), once per router; [] when there is none. */
export function cloudPublicAddrs(timeoutMs = 1000): Promise<string[]> {
  cloud ??= (async () => {
    try {
      const sig = () => AbortSignal.timeout(timeoutMs)
      const tok = await fetch('http://169.254.169.254/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal: sig() })
      if (!tok.ok) return []
      const r = await fetch('http://169.254.169.254/latest/meta-data/public-ipv4', { headers: { 'X-aws-ec2-metadata-token': await tok.text() }, signal: sig() })
      const ip = r.ok ? (await r.text()).trim() : ''
      return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? [ip] : []
    } catch { return [] }
  })()
  return cloud
}

/** What a run's network lets through besides the internet: hostPorts, the host's ports an internal
 *  action declared (host.ports, reached at SLIRP_HOST); outPorts, the only internet ports (tcp and udp)
 *  it may use, or null for any port (the router's own internal actions). */
export type NetPolicy = { hostPorts?: number[]; outPorts?: number[] | null }

/** nft rules for the namespace: its own loopback and slirp's DNS open; the declared host ports open;
 *  the blocked ranges and host addresses refused; then, when outPorts is set, every other port. */
export function nftRules(hostAddrs: string[], p: NetPolicy = {}): string {
  const v4 = [...BLOCKED_V4, ...hostAddrs.filter(a => a.includes('.') && !a.includes(':'))]
  const v6 = [...BLOCKED_V6, ...hostAddrs.filter(a => a.includes(':'))]
  const hostPorts = [...new Set(p.hostPorts ?? [])]
  const out = p.outPorts === undefined ? OUT_PORTS : p.outPorts
  return [
    'table inet cctr_sandbox {',
    ' chain out {',
    '  type filter hook output priority 0; policy accept;',
    '  oif "lo" accept',
    `  ip daddr ${SLIRP_DNS} udp dport 53 accept`,
    `  ip daddr ${SLIRP_DNS} tcp dport 53 accept`,
    ...(hostPorts.length ? [`  ip daddr ${SLIRP_HOST} tcp dport { ${hostPorts.join(', ')} } accept`] : []),
    `  ip daddr { ${v4.join(', ')} } reject`,
    `  ip6 daddr { ${v6.join(', ')} } reject`,
    ...(out ? [`  tcp dport != { ${out.join(', ')} } reject`, `  udp dport != { ${out.join(', ')} } reject`] : []),
    ' }',
    '}',
    '',
  ].join('\n')
}

/** Audit arch and socket(2) number per CPU (seccomp sees raw syscall numbers). */
const SECCOMP_ARCH: Record<string, { audit: number; socket: number }> = {
  x64: { audit: 0xc000003e, socket: 41 },
  arm64: { audit: 0xc00000b7, socket: 198 },
}
const IO_URING_SETUP = 425 // the same number on x86_64 and aarch64

/** A classic BPF seccomp program (struct sock_filter[], as bwrap --seccomp reads it): socket(AF_UNIX, ...)
 *  and io_uring_setup fail with EPERM; another architecture's syscalls (32-bit, x32) are refused too;
 *  everything else is allowed. null on a CPU this does not know (the run is then refused).
 *  allowUnix: AF_UNIX sockets work (an internal action that declared host mounts, e.g. an ssh
 *  agent's socket: the whitelisted file system shows it no other socket file, and abstract sockets
 *  stay behind the network namespace); io_uring and other architectures are still refused. */
export function unixBlockFilter(arch: string = process.arch, o: { allowUnix?: boolean } = {}): Buffer | null {
  const a = SECCOMP_ARCH[arch]
  if (!a) return null
  const op = (code: number, jt: number, jf: number, k: number) => { const b = Buffer.alloc(8); b.writeUInt16LE(code, 0); b.writeUInt8(jt, 2); b.writeUInt8(jf, 3); b.writeUInt32LE(k >>> 0, 4); return b }
  const LD = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06, ALLOW = 0x7fff0000, EPERM = 0x00050001
  if (o.allowUnix) return Buffer.concat([
    op(LD, 0, 0, 4), //            0: arch
    op(JEQ, 0, 4, a.audit), //     1: another arch -> 6 refuse
    op(LD, 0, 0, 0), //            2: syscall number
    op(JGE, 2, 0, 0x40000000), //  3: x32 -> 6 refuse
    op(JEQ, 1, 0, IO_URING_SETUP), // 4: -> 6 refuse
    op(RET, 0, 0, ALLOW), //       5
    op(RET, 0, 0, EPERM), //       6
  ])
  return Buffer.concat([
    op(LD, 0, 0, 4), //            0: arch
    op(JEQ, 0, 7, a.audit), //     1: another arch -> 9 refuse
    op(LD, 0, 0, 0), //            2: syscall number
    op(JGE, 5, 0, 0x40000000), //  3: x32 -> 9 refuse
    op(JEQ, 4, 0, IO_URING_SETUP), // 4: -> 9 refuse
    op(JEQ, 0, 2, a.socket), //    5: not socket -> 8 allow
    op(LD, 0, 0, 16), //           6: socket's first argument (domain), low 32 bits
    op(JEQ, 1, 0, 1), //           7: AF_UNIX -> 9 refuse
    op(RET, 0, 0, ALLOW), //       8
    op(RET, 0, 0, EPERM), //       9
  ])
}

const NS_GET_USERNS = 0xb701
let libc: { ioctl(fd: number, req: number): number } | null | undefined
/** The user namespace that owns a network namespace, as an fd (ioctl NS_GET_USERNS), or -1.
 *  An unprivileged bwrap with --dev first maps the user to root (to mount devpts), then moves the
 *  sandbox into a nested user namespace: /proc/<pid>/ns/user changes under us, and nsenter aimed
 *  at the nested one cannot touch the network namespace (EPERM). The owner never changes, and in
 *  it this user is root, so nft and slirp4netns entered there have the capabilities they need. */
function ownerUserns(netFd: number): number {
  if (libc === undefined) {
    libc = null
    for (const lib of ['libc.so.6', `libc.musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`]) {
      try { const l = dlopen(lib, { ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 } }); libc = { ioctl: (fd, req) => l.symbols.ioctl(fd, req) as number }; break } catch {}
    }
  }
  return libc ? libc.ioctl(netFd, NS_GET_USERNS) : -1
}

/** Whether the process's user namespace has its uid map written. bwrap (unprivileged) reports child-pid
 *  before the sandbox writes its own map; nsenter into an unmapped namespace leaves nft and slirp4netns
 *  without capabilities (EPERM). The owner's map is written before any nested namespace exists, so a
 *  map seen here means the owner's is in place. */
export function uidMapped(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/uid_map`, 'utf8').trim() !== '' } catch { return false }
}

/** timedOut, outputOver: the router killed the run (its time, or more output than outputMax). */
export type NetRun = { code: number; out: string; timedOut?: boolean; outputOver?: boolean } | { error: string }

/** stdout and stderr read as they come, at most max bytes kept in all; past it, over() once (the run is killed). */
function readCapped(streams: ReadableStream<Uint8Array>[], max: number, over: () => void): Promise<string[]> {
  let total = 0, tripped = false
  return Promise.all(streams.map(async st => {
    const parts: Uint8Array[] = []
    for await (const c of st as unknown as AsyncIterable<Uint8Array>) {
      const room = max - total
      if (room > 0) parts.push(room >= c.length ? c : c.subarray(0, room))
      total += c.length
      if (total > max && !tripped) { tripped = true; over() }
    }
    return Buffer.concat(parts).toString('utf8')
  }))
}

export type IsolatedRun = { argv: string[]; env: Record<string, string>; timeoutMs: number; workDir: string; hostAddrs: string[]; wrap?: string[]; extraRo?: string[]; extraRw?: string[]; allowUnix?: boolean
  /** Words before bwrap (router/sandboxlimits.ts limitPrefix: systemd-run, prlimit). */
  prefix?: string[]
  /** stdout and stderr together, at most this many bytes (default 16 MB): past it the run is killed. */
  outputMax?: number } & NetPolicy

/** Run a bwrap argv (router/privskill.ts sandboxArgv, a whitelisted file system: options, then "--",
 *  then the command) in its own network namespace as above. workDir: a router-private folder for this
 *  run (resolv.conf, rules, fds). wrap: words put before the command (e.g. a fake service that then
 *  runs it); extraRo, extraRw: more paths the command sees (read-only, writable). hostPorts, outPorts:
 *  NetPolicy (slirp maps SLIRP_HOST to the host's loopback only when there are host ports). allowUnix:
 *  unixBlockFilter's. prefix, outputMax: the run's limits (router/sandboxlimits.ts). */
export async function runIsolated(o: IsolatedRun): Promise<NetRun> {
  const missing = netMissing()
  if (missing) return { error: `這台主機缺少網路隔離需要的工具: ${missing}` }
  const i = o.argv.indexOf('--')
  if (o.argv[0] !== 'bwrap' || i < 0) return { error: 'runIsolated: 不是 bwrap 的參數' }
  mkdirSync(o.workDir, { recursive: true, mode: 0o700 })
  const resolv = join(o.workDir, 'resolv.conf'), rules = join(o.workDir, 'rules.nft'), info = join(o.workDir, 'info'), ready = join(o.workDir, 'ready'), fifo = join(o.workDir, 'block')
  writeFileSync(resolv, `nameserver ${SLIRP_DNS}\n`)
  writeFileSync(rules, nftRules(o.hostAddrs, { hostPorts: o.hostPorts, outPorts: o.outPorts }))
  writeFileSync(info, ''); writeFileSync(ready, '')
  if (Bun.spawnSync(['mkfifo', '-m', '600', fifo]).exitCode !== 0) return { error: '建不了等待用的 fifo' }
  const filter = unixBlockFilter(process.arch, { allowUnix: o.allowUnix })
  if (!filter) return { error: `不認得這個 CPU 架構 (${process.arch}), 做不出擋 unix socket 的 seccomp 規則` }
  const bpf = join(o.workDir, 'unix-block.bpf')
  writeFileSync(bpf, filter)
  const ro = [...(o.extraRo ?? []).flatMap(p => ['--ro-bind', p, p]), ...(o.extraRw ?? []).flatMap(p => ['--bind', p, p])]
  const argv = [...o.argv.slice(0, i), '--unshare-net', '--ro-bind', resolv, '/etc/resolv.conf', ...ro, '--info-fd', '3', '--block-fd', '4', '--seccomp', '5', '--', ...(o.wrap ?? []), ...o.argv.slice(i + 1)]
  const infoFd = openSync(info, 'w'), blockFd = openSync(fifo, 'r+'), readyFd = openSync(ready, 'w'), bpfFd = openSync(bpf, 'r')
  let slirp: ReturnType<typeof Bun.spawn> | null = null
  let netFd = -1, userFd = -1
  const p = Bun.spawn([...(o.prefix ?? []), ...argv], { env: o.env, stdio: ['ignore', 'pipe', 'pipe', infoFd, blockFd, bpfFd] })
  let timedOut = false, outputOver = false
  const kill = setTimeout(() => { timedOut = true; p.kill(9) }, o.timeoutMs)
  const output = readCapped([p.stdout as ReadableStream<Uint8Array>, p.stderr as ReadableStream<Uint8Array>], o.outputMax ?? 16 * 1024 * 1024, () => { outputOver = true; p.kill(9) })
  const fail = async (why: string): Promise<NetRun> => { p.kill(9); await p.exited; return { error: why } }
  /** The sandbox ended before its network was set up (bwrap refused an option, a path it mounts is missing): its own words. */
  const ended = async (): Promise<NetRun | null> => {
    await Promise.race([p.exited, Bun.sleep(300)])
    if (p.exitCode === null) return null
    const [out, err] = await output
    return { error: `沙箱在設定網路前就結束了 (exit ${p.exitCode}): ${`${out}${err}`.trim().slice(-500) || '(沒有輸出)'}` }
  }
  try {
    let pid = 0
    for (let t = 0; t < 250 && !pid && p.exitCode === null; t++) { await Bun.sleep(20); pid = Number(/"child-pid":\s*(\d+)/.exec(readFileSync(info, 'utf8'))?.[1] ?? 0) }
    if (!pid) { const [out, err] = await output; return p.exitCode !== null ? { error: `沙箱沒有啟動: ${`${out}${err}`.trim().slice(-500)}` } : await fail('沙箱沒有回報 pid') }
    try { netFd = openSync(`/proc/${pid}/ns/net`, 'r') } catch (e) { return (await ended()) ?? await fail(`讀不到沙箱的網路空間: ${e}`) }
    userFd = ownerUserns(netFd)
    if (userFd < 0) return await fail('找不到擁有沙箱網路空間的 user namespace (ioctl NS_GET_USERNS)')
    for (let t = 0; t < 1000 && !uidMapped(pid) && p.exitCode === null; t++) await Bun.sleep(5)
    if (!uidMapped(pid)) return (await ended()) ?? await fail('沙箱的 user namespace 沒有寫好 uid 對應')
    const fdPath = (fd: number) => `/proc/${process.pid}/fd/${fd}`
    const nft = Bun.spawnSync([which('nsenter'), `--user=${fdPath(userFd)}`, `--net=${fdPath(netFd)}`, '--preserve-credentials', which('nft'), '-f', rules], { stderr: 'pipe' })
    if (nft.exitCode !== 0) return (await ended()) ?? await fail(`套不上網路規則 (nft): ${nft.stderr.toString().trim().slice(-300)}`)
    // the namespaces by path: given a pid, slirp4netns would follow /proc/<pid>/ns/user into the nested one
    slirp = Bun.spawn([which('slirp4netns'), '--configure', '--mtu=65520', ...(o.hostPorts?.length ? [] : ['--disable-host-loopback']), '--ready-fd=3', `--userns-path=${fdPath(userFd)}`, '--netns-type=path', fdPath(netFd), 'tap0'], { stdio: ['ignore', 'ignore', 'pipe', readyFd] })
    for (let t = 0; t < 250 && !readFileSync(ready, 'utf8') && slirp.exitCode === null; t++) await Bun.sleep(20)
    if (!readFileSync(ready, 'utf8')) return await fail(`接不上外網 (slirp4netns): ${(await new Response(slirp.stderr as ReadableStream).text()).trim().slice(-300)}`)
    writeFileSync(fifo, 'go')
    const [out, err] = await output
    const code = await p.exited
    // bwrap's own setup failing after the go (a path it mounts is missing): nothing ran, say it in bwrap's words
    if (code === 1 && !out && /^bwrap: /.test(err.trim()) && !err.trim().includes('\n')) return { error: `沙箱在設定網路前就結束了 (exit 1): ${err.trim().slice(-500)}` }
    return { code, out: `${out}${err}`.trim(), ...(timedOut ? { timedOut } : {}), ...(outputOver ? { outputOver } : {}) }
  } finally {
    clearTimeout(kill)
    slirp?.kill()
    for (const fd of [infoFd, blockFd, readyFd, bpfFd, netFd, userFd]) if (fd >= 0) try { closeSync(fd) } catch {}
  }
}
