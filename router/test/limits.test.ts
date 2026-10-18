// Resource limits and the phase 2 fixes (docs/skill-runtime.md 「資源上限」「exit code
// 與輸出」「時區」; router/sandboxlimits.ts, router/skillrun.ts):
//   - limits: the defaults, what privileged.json may raise and to where, the
//     raised ones need owner (admin refused; the approval lists them); the words
//     put before bwrap with cgroup delegation (systemd-run scope + prlimit) and
//     without (prlimit only), /router status says which
//   - real runs on this host (cgroup delegated: else those items are skipped):
//     memory (killed, said so), tasks (forks fail), one file's size (SIGXFSZ,
//     said so), output (killed past it), time (killed, said so); degraded to
//     prlimit: memory still bounded, the size of a file too
//   - stop_exits: a declared exit code is a normal stop (ok, "正常停止", skill_runs
//     stopped, databases not written back); others are failures
//   - router paths (its stateDir) masked in what goes back; the sandbox's time zone
//     Asia/Taipei by default (config sandboxTimezone); a refresh's result carries
//     its whole output (start and end when long), also in the owner's notice
//   - /router status says how sandboxes are limited and what the toolbox has
// Keep in sync with those sections.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openRouterDb, type RouterDb, type Conversation } from '../db'
import { hashSkill, loadManifest, ownerOnly } from '../privskill'
import { runSkill, approveRefusal, describeActions, maskPaths, summary, type SkillRunDeps } from '../skillrun'
import { refreshAll, type RefreshDeps } from '../skillrefresh'
import { limitsOf, limitPrefix, raisedLimits, limitMode, describeLimitMode, endNote, DEFAULT_LIMITS, MAX_LIMITS } from '../sandboxlimits'
import { parseTimezone } from '../config'
import { sandboxDeps } from './fixtures/sandbox'

const CGROUP = limitMode().kind === 'cgroup'
let dir: string, db: RouterDb, deps: SkillRunDeps, conv: Conversation, skill: string, told: string[]

function writeSkill(actions: Record<string, unknown>, approve = true) {
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: lim\ndescription: x\n---\n')
  writeFileSync(join(skill, 'privileged.json'), JSON.stringify({ actions }))
  if (approve) db.approveSkill(skill, 'lim', hashSkill(skill), 'owner')
}
const sh = (script: string, extra: Record<string, unknown> = {}) => ({ run: ['bash', '-c', script], ...extra })

beforeEach(() => {
  told = []
  dir = mkdtempSync(join(tmpdir(), 'cctr-lim-'))
  mkdirSync(join(dir, 'state', 'creds', 'jar'), { recursive: true })
  db = openRouterDb(join(dir, 'state', 'router.db'))
  skill = join(dir, 'home', 'bot1', '.claude', 'skills', 'lim')
  const folder = join(dir, 'home', 'bot1', 'dm-7')
  mkdirSync(join(folder, '.chat'), { recursive: true })
  conv = { key: 'dm-7', bot: 'cc', chat_id: '7', type: 'dm', folder, role: 'owner', session_id: null, created_at: '' }
  deps = {
    db, home: join(dir, 'home'), credsRoot: join(dir, 'state', 'creds'), userHome: join(dir, 'fakehome'), hidden: [join(dir, 'home'), join(dir, 'state')],
    botDir: () => join(dir, 'home', 'bot1'), storeRoot: join(dir, 'state', 'skill-store'), privatePaths: [join(dir, 'state')], timezone: 'Asia/Taipei',
    ...sandboxDeps(join(dir, 'state')),
    notifyOwner: (_c, t) => told.push(t),
  }
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('limits: the defaults, raised within the maximums by privileged.json, refused past them; raised ones need owner and the approval lists them', () => {
  expect(DEFAULT_LIMITS).toEqual({ timeout: 600, memory_mb: 1024, tasks: 256, file_mb: 512, output_kb: 2048 })
  expect(MAX_LIMITS).toEqual({ timeout: 3600, memory_mb: 8192, tasks: 1024, file_mb: 8192, output_kb: 16384 })
  expect(limitsOf({ timeout: 900, limits: { memory_mb: 3072, file_mb: 4096 } })).toEqual({ timeout: 900, memory_mb: 3072, tasks: 256, file_mb: 4096, output_kb: 2048 })
  const load = (a: Record<string, unknown>) => { writeSkill({ a: { run: ['true'], ...a } }, false); return () => loadManifest(skill) }
  expect(load({ limits: { memory_mb: 9000 } })).toThrow('動作 a 的 limits.memory_mb 要是 1 到 8192 的整數')
  expect(load({ limits: { cpu: 2 } })).toThrow('動作 a 的 limits 不認得 cpu (有: memory_mb, tasks, file_mb, output_kb; 時間寫在 timeout)')
  expect(load({ timeout: 7200 })).toThrow('動作 a 的 timeout 最多 3600 秒')
  expect(load({ limits: [] })).toThrow('動作 a 的 limits 要是物件')
  writeSkill({ extract: { run: ['true'], timeout: 900, limits: { memory_mb: 3072, file_mb: 4096 } }, list: { run: ['true'], limits: { memory_mb: 512 } } }, false)
  expect(raisedLimits(loadManifest(skill)!.actions.list!)).toEqual([]) // lower is not raised
  expect(ownerOnly(loadManifest(skill)!)).toEqual(['動作 extract 放寬了資源上限 (時間 (秒) 900 (預設 600), 記憶體 (MB) 3072 (預設 1024), 單檔大小 (MB) 4096 (預設 512))'])
  expect(approveRefusal(skill, 'lim', 'admin')).toStartWith('技能 lim 只有 owner 能核准: 動作 extract 放寬了資源上限')
  expect(approveRefusal(skill, 'lim', 'owner')).toBeNull()
  expect(describeActions(skill)).toContain('⚠️ 放寬資源上限 時間 (秒) 900 (預設 600), 記憶體 (MB) 3072 (預設 1024), 單檔大小 (MB) 4096 (預設 512) (只有 owner 能核准)')
})

test('how a run is held: systemd-run scope and prlimit with cgroup delegation, prlimit alone without (said so), nothing but time and output without prlimit', () => {
  const l = limitsOf({})
  expect(limitPrefix({ kind: 'cgroup', systemdRun: '/usr/bin/systemd-run', prlimit: '/usr/bin/prlimit', env: '/usr/bin/env', runtimeDir: '/run/user/1000' }, l)).toEqual(['/usr/bin/env', 'XDG_RUNTIME_DIR=/run/user/1000', '/usr/bin/systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=1024M', '-p', 'MemorySwapMax=0', '-p', 'TasksMax=256', '--', '/usr/bin/env', '-u', 'XDG_RUNTIME_DIR', '/usr/bin/prlimit', `--fsize=${512 * 1048576}`, '--core=0', '--'])
  expect(limitPrefix({ kind: 'rlimit', prlimit: '/usr/bin/prlimit', why: 'x' }, l)).toEqual(['/usr/bin/prlimit', `--fsize=${512 * 1048576}`, '--core=0', `--data=${1024 * 1048576}`, '--cpu=600', '--'])
  expect(limitPrefix({ kind: 'none', why: 'x' }, l)).toEqual([])
  expect(describeLimitMode({ kind: 'rlimit', prlimit: 'p', why: '沒有 systemd-run' })).toBe('資源上限: 降級為 prlimit (記憶體只是近似值, 沒有程序數上限, /tmp 不受限): 沒有 systemd-run')
  expect(limitMode({ refresh: true, probe: () => false }).kind).toBe('rlimit')
  limitMode({ refresh: true })
  expect(endNote(137, l, {}, { kind: 'cgroup', systemdRun: '', prlimit: '' })).toBe('被 SIGKILL 結束, 可能超過記憶體上限 1024 MB')
  expect(endNote(153, l, {}, { kind: 'none', why: '' })).toBe('寫入的單檔超過上限 512 MB (SIGXFSZ)')
  expect(endNote(1, l, {}, { kind: 'none', why: '' })).toBeNull()
})

test.skipIf(!CGROUP)('real runs (cgroup): memory, tasks, one file\'s size, output and time each end the run, and the reply says which limit', async () => {
  writeSkill({
    mem: sh('exec python3 -c "b = bytearray(400 * 1024 * 1024); print(len(b))"', { limits: { memory_mb: 128 } }),
    tasks: sh(`exec python3 -c "
import threading, time
n = 0
try:
    for i in range(200):
        threading.Thread(target=time.sleep, args=(3,), daemon=True).start(); n += 1
except RuntimeError as e:
    print('stopped at', n, e)
"`, { limits: { tasks: 32 } }),
    file: sh('exec head -c 3000000 /dev/zero > big.bin', { limits: { file_mb: 1 } }),
    out: sh('exec yes 0123456789abcdef', { limits: { output_kb: 64 } }),
    slow: sh('sleep 30', { timeout: 2 }),
    fine: sh('python3 -c "b = bytearray(50 * 1024 * 1024); print(\'ok\', len(b))"', { limits: { memory_mb: 128 } }),
  })
  const run = async (a: string) => (await runSkill(deps, conv, 'owner', 'lim', a, {})).text
  const mem = await run('mem')
  expect(mem).toStartWith('exit 137\n(被 SIGKILL 結束, 可能超過記憶體上限 128 MB)')
  expect(await run('fine')).toContain('ok 52428800')
  const tasks = await run('tasks')
  const started = Number(/stopped at (\d+) can't start new thread/.exec(tasks)?.[1] ?? -1)
  expect(started, tasks).toBeGreaterThan(0)
  expect(started).toBeLessThan(32)
  const file = await run('file')
  expect(file).toStartWith('exit 153\n(寫入的單檔超過上限 1 MB (SIGXFSZ))')
  const out = await run('out')
  expect(out).toStartWith('exit 137\n(輸出超過上限 64 KB, 被終止)')
  const t0 = Date.now()
  expect(await run('slow')).toStartWith('exit 137\n(超過時間上限 2 秒, 被終止)')
  expect(Date.now() - t0).toBeLessThan(15_000)
}, 120_000)

test('degraded (no cgroup delegation): prlimit still bounds memory (approximately) and one file\'s size', async () => {
  const d = { ...deps, limitMode: () => limitMode({ refresh: true, probe: () => false }) }
  writeSkill({
    mem: sh('exec python3 -c "b = bytearray(400 * 1024 * 1024); print(len(b))"', { limits: { memory_mb: 128 } }),
    file: sh('exec head -c 3000000 /dev/zero > big.bin', { limits: { file_mb: 1 } }),
  })
  try {
    expect((await runSkill(d, conv, 'owner', 'lim', 'mem', {})).text).toContain('MemoryError')
    expect((await runSkill(d, conv, 'owner', 'lim', 'file', {})).text).toStartWith('exit 153\n(寫入的單檔超過上限 1 MB (SIGXFSZ))')
  } finally { limitMode({ refresh: true }) }
}, 60_000)

test('stop_exits: a declared exit code is a normal stop (ok, said so, recorded as stopped, no write-back); an undeclared one fails; only 1 to 125 with a reason', async () => {
  writeSkill({
    long: sh('echo "RESULT reason=too_long"; exit 4', { stop_exits: { 4: '影片超過長度上限, 沒有下載' }, store: { DB: 'lim' } }),
    bad: sh('exit 3', { stop_exits: { 4: '影片太長' } }),
  })
  const r = await runSkill(deps, conv, 'user', 'lim', 'long', {})
  expect(r.ok).toBe(true)
  expect(r.text).toStartWith('exit 4 (正常停止: 影片超過長度上限, 沒有下載)\n(正常停止, 資料庫 lim 未寫回)')
  expect(r.text).toContain('RESULT reason=too_long')
  const b = await runSkill(deps, conv, 'user', 'lim', 'bad', {})
  expect(b.ok).toBe(false)
  expect(b.text).toStartWith('exit 3\n')
  expect(db.lastSkillRunAt('dm-7', 'lim', 'stopped')).not.toBeNull()
  expect(db.lastSkillRunAt('dm-7', 'lim', 'failed')).not.toBeNull()
  expect(db.lastSkillRunAt('dm-7', 'lim', 'ok')).toBeNull()
  expect(describeActions(skill)).toContain('正常停止 exit 4 (影片超過長度上限, 沒有下載)')
  writeSkill({ a: { run: ['true'], stop_exits: { 0: 'x' } } }, false)
  expect(() => loadManifest(skill)).toThrow('動作 a 的 stop_exits 的 0 不行: 要是 1 到 125 的 exit code')
  writeSkill({ a: { run: ['true'], stop_exits: { 4: '' } } }, false)
  expect(() => loadManifest(skill)).toThrow('動作 a 的 stop_exits.4 要寫說明')
}, 60_000)

test('the router\'s paths never go back (masked whole), the sandbox\'s clock is Asia/Taipei unless configured otherwise', async () => {
  const state = join(dir, 'state')
  writeSkill({ say: { run: ['bash', '-c', 'echo "copy at $1/creds/jar/c.txt, see $1"; echo "XDG=${XDG_RUNTIME_DIR:-unset}"; echo "TZ=$TZ"; date +%Z; readlink /etc/localtime', 'x', '{p}'], args: { p: { pattern: '\\S+' } } } })
  const r = await runSkill(deps, conv, 'owner', 'lim', 'say', { p: state })
  expect(r.text).toContain('copy at <router 私有路徑>, see <router 私有路徑>')
  expect(r.text).not.toContain(state)
  expect(r.text).toContain('TZ=Asia/Taipei\nCST\n/usr/share/zoneinfo/Asia/Taipei')
  expect(maskPaths(`a ${state}/x/y.txt b "${state}" ${state}-other`, [state])).toBe(`a <router 私有路徑> b "<router 私有路徑>" ${state}-other`)
  const w: string[] = []
  expect(parseTimezone(undefined, w)).toBe('Asia/Taipei')
  expect(parseTimezone('Europe/Paris', w)).toBe('Europe/Paris')
  expect(parseTimezone('Mars/Base', w)).toBe('Asia/Taipei')
  expect(parseTimezone('../../etc/passwd', w)).toBe('Asia/Taipei')
  expect(w).toEqual(['sandboxTimezone 要是 /usr/share/zoneinfo 裡的時區名稱 (例如 Asia/Taipei), 收到 "Mars/Base"; 用 Asia/Taipei', 'sandboxTimezone 要是 /usr/share/zoneinfo 裡的時區名稱 (例如 Asia/Taipei), 收到 "../../etc/passwd"; 用 Asia/Taipei'])
}, 30_000)

test('a refresh brings back its whole output (start and end when long), masked; a failing one tells the owner all of it', async () => {
  writeSkill({
    go: { run: ['true'], creds: { JAR: 'jar' }, auth_failure: 'x', refresh: 'fix' },
    fix: sh('for i in $(seq 1 400); do echo "line $i of the refresh, in ' + join(dir, 'state') + '"; done; exit 2', { internal: true, creds: { JAR: 'jar' } }),
  })
  const rd: RefreshDeps = { ...deps, stateDir: join(dir, 'state'), botOf: () => 'cc', notify: (_b, t) => told.push(t) }
  const [r] = await refreshAll(rd)
  expect(r!.status).toBe('failed')
  expect(r!.tail).toContain('line 1 of the refresh')
  expect(r!.tail).toContain('line 400 of the refresh')
  expect(r!.tail).toMatch(/\.\.\.\(中間略過 \d+ 字\)\.\.\./)
  expect(r!.tail).not.toContain(join(dir, 'state'))
  expect(told[0]).toStartWith('⚠️ 技能 lim 的每日憑證更新 (fix) 失敗, exit 2:\nline 1 of the refresh')
  expect(told[0]).toContain('line 400')
  expect(summary('x'.repeat(100), 3500)).toBe('x'.repeat(100))
}, 60_000)

test('/router status ends with how privileged sandboxes are limited and the toolbox', async () => {
  const { runCommand } = await import('../commands')
  const cfg = { path: join(dir, 'state', 'config.json'), bots: [{ name: 'cc', token: '1:x' }], home: join(dir, 'home'), stateDir: join(dir, 'state'), socket: join(dir, 's'), owners: ['111'], model: 'm', autoCompactWindow: 750000, claudeBin: 'claude', credentials: {} }
  const cdeps = { cfg, db, startedAt: new Date(), bots: { list: async () => [] }, sessions: { isConnected: () => false }, sandboxStatus: () => '資源上限: cgroup (...)\n工具箱:\nffmpeg 7.0.2' } as any
  const r = await runCommand({ bot: 'cc', text: '/router status', senderId: '111', senderName: 'n', chatId: '111', chatType: 'private' }, cdeps)
  expect(r!.reply).toEndWith('\n\n特權技能的沙箱:\n資源上限: cgroup (...)\n工具箱:\nffmpeg 7.0.2')
})

test('the router\'s start probes without blocking and every run then reads the same answer', async () => {
  const before = limitMode({ refresh: true })
  const { primeLimitMode } = await import('../sandboxlimits')
  limitMode({ refresh: true, probe: () => false })
  expect((await primeLimitMode()).kind).toBe('rlimit') // already known: kept
  limitMode({ refresh: true })
  expect((await primeLimitMode()).kind).toBe(before.kind)
})
