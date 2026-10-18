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

/** The subcommands the executable takes (docs/operations.md 「終端機 CLI」); FAKE_SUBCOMMAND is internal. */
export const SUBCOMMANDS = ['cli', 'managed', 'cred-import', 'toolbox', 'setup', 'doctor', 'register', 'import-v1', FAKE_SUBCOMMAND]

/** What `cctr --help` prints (to stderr, with exit 2, for an unknown first word). */
export const USAGE = [
  '用法: cctr [--config <config.json>] [<子指令> ...]',
  '不帶子指令: 啟動 router (systemd unit 就是這樣執行; 沒有 --config 時用執行檔旁邊的 config.json).',
  '',
  '子指令:',
  '  cli <子指令...>                 經 router socket 交給執行中的 router, 跟 Telegram 的 /router 一樣 (例如 cli status, cli doctor, cli session send)',
  '  managed agents|attach|migrate|help',
  '                                  不經 router: 在 router 的環境執行 claude agents 與 claude attach, 或遷移對話紀錄',
  '  cred-import <名稱> <env 檔> <變數> [方法或路徑,...] [--http <網址> ...]',
  '                                  從檔案登記憑證, 值不印出',
  '  toolbox install|status [--state <stateDir>] [--mirror <資料夾或網址>]',
  '                                  技能用的工具箱 (ffmpeg, deno, uv, bwrap)',
  '  setup                           設定嚮導 (要在終端機執行)',
  '  doctor                          不經 router 檢查環境與設定',
  '  register                        寫入位置檔, 讓 plugin 與 hook 找到 router',
  '  import-v1 <messages.db> [--bot <名稱>]',
  '                                  匯入 v1 的訊息紀錄',
  '  help, --help, -h                顯示這份說明',
].join('\n')

/** What the executable does with the words the user gave (ownArgs): no subcommand (only --config <path>
 *  or nothing, as the systemd unit starts it) runs the router; help, --help or -h prints the usage;
 *  a known subcommand runs it; any other first word is refused, never starting the router. */
export function entryAction(args: string[]): { run: 'router' } | { run: 'help' } | { run: 'sub'; name: string } | { run: 'unknown'; word: string } {
  const words = args.filter((a, i) => a !== '--config' && args[i - 1] !== '--config')
  const first = words[0]
  if (first === undefined) return { run: 'router' }
  if (first === 'help' || first === '--help' || first === '-h') return { run: 'help' }
  if (SUBCOMMANDS.includes(first)) return { run: 'sub', name: first }
  return { run: 'unknown', word: first }
}
