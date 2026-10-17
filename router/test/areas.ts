// Test areas and the std set (docs/testing.md 「測試分區」). Read by tiers.ts
// (bun run test:std | test:area | test:changed) and checked by areas.test.ts:
// every test file belongs to an area, every listed file and path exists.
// Keep in sync with that section.
//
// tests: file names under router/test. paths: globs from the repo root
// (Bun.Glob); a changed file matching one runs that area. A changed test file
// runs the areas that list it. A path may sit in several areas.

export interface Area { name: string; title: string; tests: string[]; paths: string[] }

export const AREAS: Area[] = [
  {
    name: 'perm', title: '權限與提權',
    tests: ['phase3.test.ts', 'risky.test.ts', 'autoelev.test.ts', 'dmrole.test.ts', 'toolhistory.test.ts', 'e2e-autoelev.test.ts', 'e2e-dmrole.test.ts', 'e2e-ownagents.test.ts', 'e2e-toolhistory.test.ts', 'role-live.test.ts', 'retry.test.ts', 'e2e-retry.test.ts'],
    paths: ['router/permcheck.ts', 'router/elevation.ts', 'router/approvals.ts', 'router/authz.ts', 'router/grants.ts', 'router/guard.ts', 'router/settings.ts', 'router/toolhistory.ts', 'router/context.ts', 'router/conversations.ts', 'shared/tools.ts', 'templates/**'],
  },
  {
    name: 'pkg', title: '套件安裝審核',
    tests: ['phase3-pkg.test.ts'],
    paths: ['router/packages.ts', 'router/pkgreview.ts', 'router/approvals.ts', 'router/authz.ts'],
  },
  {
    name: 'skills', title: '憑證與特權技能',
    tests: ['phase3-cred.test.ts', 'phase3-privskill.test.ts', 'cred-http.test.ts'],
    paths: ['router/credentials.ts', 'router/skills.ts', 'router/privskill.ts', 'router/skillrefresh.ts', 'router/skillrun.ts', 'plugin/skills/bot-skill/**'],
  },
  {
    name: 'sandbox', title: '沙箱與安裝位置',
    tests: ['portability.test.ts'],
    paths: ['shared/locate.ts', 'deploy/**', 'router/settings.ts', 'router/privskill.ts', 'router/cli.ts', 'plugin/server.ts', 'templates/roles/**'],
  },
  {
    name: 'secrets', title: '密鑰保護',
    tests: ['secrets.test.ts', 'e2e-secrets.test.ts', 'rawvault.test.ts', 'e2e-rawvault.test.ts'],
    paths: ['router/secrets.ts', 'router/rawvault.ts', 'router/detect.ts', 'router/rotate.ts', 'router/credentials.ts', 'router/setup.ts', 'shared/tools.ts'],
  },
  {
    name: 'telegram', title: 'Telegram 收發與訊息紀錄',
    tests: ['format.test.ts', 'inbound.test.ts', 'outbound.test.ts', 'policy.test.ts', 'rich.test.ts', 'store.test.ts', 'poller.test.ts', 'phase4.test.ts', 'channel.test.ts', 'e2e-channel.test.ts'],
    paths: ['router/telegram/**', 'router/poller.ts', 'router/pollnotice.ts', 'router/sendretry.ts', 'router/importv1.ts', 'router/setup.ts', 'plugin/skills/doc/**', 'plugin/skills/format/**', 'templates/CLAUDE.md.example', 'shared/tools.ts'],
  },
  {
    name: 'reactions', title: '表情回應',
    tests: ['reactions.test.ts', 'e2e-reactions.test.ts'],
    paths: ['router/reactions.ts', 'router/telegram/transport.ts', 'router/telegram/inbound.ts'],
  },
  {
    name: 'classifier', title: '工具呼叫分類器',
    tests: ['classifier.test.ts', 'e2e-classifier.test.ts', 'e2e-classifier-off.test.ts'],
    paths: ['router/classifier.ts'],
  },
  {
    name: 'core', title: '對話生命週期與指令',
    tests: ['phase1.test.ts', 'phase2.test.ts', 'e2e.test.ts', 'e2e-wake.test.ts', 'e2e-setup.test.ts'],
    paths: ['router/supervisor.ts', 'router/lock.ts', 'router/conversations.ts', 'router/context.ts', 'router/progress.ts', 'router/relay.ts', 'router/freshness.ts', 'router/rotate.ts', 'router/setup.ts', 'router/cli.ts', 'router/guard.ts', 'router/settings.ts', 'plugin/server.ts', 'plugin/skills/**', 'shared/time.ts', 'templates/**'],
  },
  {
    name: 'repo', title: '報表腳本與 repo 檢查',
    tests: ['context-chart.test.ts', 'usage-report.test.ts', 'requirements.test.ts', 'areas.test.ts'],
    paths: ['scripts/**', 'README.md', 'CHANGELOG.md', 'plugin/package.json', 'deploy/**', 'router/relay.ts', 'router/test/areas.ts', 'router/test/tiers.ts'],
  },
]

// Files every part of the router goes through (the router itself, its db,
// config, socket protocol, command table, the hook, the plugin client) and
// the build and test setup: a change here runs the whole suite.
export const RUN_ALL = ['router/main.ts', 'router/db.ts', 'router/config.ts', 'router/ipc.ts', 'router/commands.ts', 'hooks/**', 'plugin/client.ts', 'shared/protocol.ts', 'shared/retry.ts', 'router/test/fixtures/**', 'package.json', 'bun.lock', 'bunfig.toml', '.npmrc']

// No test reads these: a change here runs std only.
export const STD_ONLY = ['docs/**', 'LICENSE', '.gitignore', '.gitattributes']

// std: the security checks (permission checks, elevation, role templates and
// the sandbox settings they make, secret masking, cross-conversation grants)
// plus one end-to-end pass from an update to the reply. filter is a bun
// test -t pattern (a regex on the test name); without one the whole file runs.
export interface StdEntry { file: string; filter?: string }

export const STD: StdEntry[] = [
  { file: 'areas.test.ts' },
  { file: 'requirements.test.ts' },
  { file: 'phase3.test.ts' },
  { file: 'risky.test.ts' },
  { file: 'autoelev.test.ts' },
  { file: 'dmrole.test.ts' },
  { file: 'policy.test.ts' },
  { file: 'secrets.test.ts' },
  { file: 'rawvault.test.ts' },
  { file: 'phase1.test.ts', filter: '^(user settings|owner settings|user worker may only target|files: user only)' },
  { file: 'portability.test.ts', filter: '^(config sandboxDenyRead|hiddenPaths|fill splices|role templates follow|skill bwrap)' },
  { file: 'e2e.test.ts', filter: '^(every update is logged|a plugin for the conversation gets the queued message)' },
]
