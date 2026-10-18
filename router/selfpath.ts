// Where this program is, for code that starts it again or runs part of it
// elsewhere. Built with `bun build --compile` (deploy/install.sh), every
// module's import.meta.dir is the virtual /$bunfs/root: files next to the
// source do not exist on disk, process.execPath is the router itself (not
// bun), and process.argv[1] is the virtual path of the entry point. Run from
// source (tests, `bun router/main.ts`), process.execPath is bun and argv[1]
// is main.ts.

import { join } from 'path'

/** True in the compiled router (deploy/install.sh), false when run from source. */
export const COMPILED = import.meta.dir.startsWith('/$bunfs/')

/** The words after the program, to start it again as it was started (compiled: argv[1] is the virtual entry point, not an argument). */
export function relaunchArgs(argv: string[] = process.argv): string[] {
  return argv[1]?.startsWith('/$bunfs/') ? argv.slice(2) : argv.slice(1)
}

/** The words the user gave, after the program and its entry point (the same index in both ways of running). */
export function ownArgs(argv: string[] = process.argv): string[] {
  return argv.slice(2)
}

/** The subcommand the compiled router runs skill_try's fake service with (router/skilltry-fake.ts). */
export const FAKE_SUBCOMMAND = 'skilltry-fake'

/** How a sandbox starts skill_try's fake service, and what it must see read-only for that:
 *  compiled, the router's own executable with the subcommand; from source, bun with the script. */
export function fakeService(compiled = COMPILED, execPath = process.execPath, dir = import.meta.dir): { cmd: string[]; ro: string[] } {
  if (compiled) return { cmd: [execPath, FAKE_SUBCOMMAND], ro: [execPath] }
  const script = join(dir, 'skilltry-fake.ts')
  return { cmd: [execPath, script], ro: [execPath, script] }
}
