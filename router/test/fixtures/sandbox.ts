// What a privileged skill's sandbox needs from the router in tests (router/skillrun.ts SkillRunDeps):
// the generated /etc files, a folder for each run's network files, the host's addresses to refuse.
// hostPorts: host ports a test's own fake services listen on (127.0.0.1), reached from the sandbox at
// slirp's host alias (sandboxnet SLIRP_HOST), like an internal action's host.ports; nothing else of
// the host. Tests only: the router itself never adds host ports (but the terminal's --api).

import { join } from 'path'
import { writeSandboxEtc } from '../../sandboxfs'
import { interfaceAddrs, runIsolated, SLIRP_HOST } from '../../sandboxnet'
import type { SkillRunDeps } from '../../skillrun'

export const HOST = SLIRP_HOST

export function sandboxDeps(state: string, hostPorts: () => number[] = () => []): Pick<SkillRunDeps, 'etcDir' | 'runRoot' | 'hostAddrs' | 'extraRo' | 'isolated'> {
  return {
    etcDir: writeSandboxEtc(join(state, 'sandbox-etc')),
    runRoot: join(state, 'sandbox-run'),
    hostAddrs: async () => interfaceAddrs(),
    extraRo: [],
    isolated: o => runIsolated({ ...o, hostPorts: [...(o.hostPorts ?? []), ...hostPorts()] }),
  }
}
