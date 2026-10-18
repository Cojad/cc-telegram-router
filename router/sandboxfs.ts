// The whitelisted file system of a privileged skill's sandbox (docs/skill-runtime.md
// 「掛載路徑」, 柯姊 2026-10-18: like a phone app, it sees only what it needs). The
// root is bwrap's own empty tmpfs; on it go only:
//   - /usr read-only (the system's programs, libraries, zoneinfo, locales), and
//     /bin, /sbin, /lib* as the host has them: symlinks into usr/ on a merged-usr
//     host, else the folders themselves read-only (the dynamic loader lives there)
//   - a few /etc files programs need to start, resolve names and check TLS
//     (ETC_FILES; never ssl/private, shadow, sudoers...), and passwd, group and
//     hosts the router writes itself (only the sandbox's user, only localhost)
//   - a private /proc, /dev, /dev/shm, /tmp and /var/tmp
// Everything else (the user's home, /home, /opt, /var, /run, /sys, the router's
// home and state dir, other conversations and skills) does not exist. The
// caller adds the skill folder, the conversation folder and the router's own
// folders (router/privskill.ts sandboxArgv) on top.

import { existsSync, lstatSync, mkdirSync, readlinkSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { outermost } from './settings'

/** /etc entries bound read-only when the host has them: the dynamic loader's cache, TLS
 *  roots, the commands Debian links through alternatives, name lookup, MIME and magic data,
 *  Python's sitecustomize link, the platform's name. Nothing secret. */
export const ETC_FILES = [
  'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d',
  'ssl/certs', 'ssl/openssl.cnf', 'ca-certificates', 'pki/tls/certs', 'pki/ca-trust',
  'alternatives',
  'nsswitch.conf', 'host.conf', 'gai.conf', 'protocols', 'services', 'networks',
  'mime.types', 'magic', 'magic.mime',
  'python3', 'python3.10', 'python3.11', 'python3.12', 'python3.13', 'python3.14',
  'os-release', 'lsb-release', 'debian_version',
  'locale.alias',
]
/** The top-level system folders besides /usr. */
const TOP = ['bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32']

/** Where the router keeps the files it writes for every sandbox's /etc. */
export const ETC_DIR = 'etc'

/** passwd, group and hosts for the sandbox (the sandbox's user is the router's uid,
 *  HOME /tmp; ssh refuses to run without a passwd entry). Written once into dir. */
export function writeSandboxEtc(dir: string, uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const put = (n: string, s: string) => writeFileSync(join(dir, n), s, { mode: 0o644 })
  put('passwd', `root:x:0:0:root:/root:/usr/sbin/nologin\n${uid === 0 ? '' : `sandbox:x:${uid}:${gid}:sandbox:/tmp:/bin/sh\n`}nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n`)
  put('group', `root:x:0:\n${gid === 0 ? '' : `sandbox:x:${gid}:\n`}nogroup:x:65534:\n`)
  put('hosts', '127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n')
  return dir
}

/** A time zone name the sandbox can use (a file under /usr/share/zoneinfo), or null. */
export function zoneOk(tz: string): boolean {
  if (!/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false
  try { return statSync(join('/usr/share/zoneinfo', tz)).isFile() } catch { return false }
}

/** bwrap options for the system part: /usr, the top-level folders, /etc, /proc, /dev, the
 *  private temporary folders, then what extraRo adds (config sandboxExtraRo, an internal
 *  action's host mounts), then covers for the hidden paths inside anything bound so far
 *  (tmpfs over a folder, /dev/null over a file). etcDir: writeSandboxEtc's folder. */
export function systemArgs(o: { etcDir: string; timezone?: string; extraRo?: string[]; hidden?: string[]; root?: string }): string[] {
  const root = o.root ?? '/'
  const b: string[] = ['--ro-bind', join(root, 'usr'), '/usr']
  for (const t of TOP) {
    const p = join(root, t)
    let st
    try { st = lstatSync(p) } catch { continue }
    if (st.isSymbolicLink()) b.push('--symlink', readlinkSync(p), `/${t}`)
    else if (st.isDirectory()) b.push('--ro-bind', p, `/${t}`)
  }
  b.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp', '--tmpfs', '/dev/shm', '--dir', '/etc')
  for (const f of ETC_FILES) if (existsSync(join(root, 'etc', f))) b.push('--ro-bind', join(root, 'etc', f), `/etc/${f}`)
  for (const f of ['passwd', 'group', 'hosts']) b.push('--ro-bind', join(o.etcDir, f), `/etc/${f}`)
  const tz = o.timezone && zoneOk(o.timezone) ? o.timezone : null
  if (tz) b.push('--symlink', `/usr/share/zoneinfo/${tz}`, '/etc/localtime')
  const bound = ['/usr', ...(o.extraRo ?? []).filter(p => existsSync(p))]
  for (const p of bound.slice(1)) b.push('--ro-bind', p, p)
  // a hidden path inside something bound read-only (sandboxDenyRead under /usr or an extra path)
  const inside = (p: string, d: string) => p === d || p.startsWith(d.endsWith('/') ? d : `${d}/`)
  for (const h of outermost(o.hidden ?? [])) {
    if (!bound.some(d => inside(h, d)) || !existsSync(h)) continue
    if (statSync(h).isDirectory()) b.push('--tmpfs', h)
    else b.push('--ro-bind', '/dev/null', h)
  }
  return b
}
