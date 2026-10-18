// bun run test:full (docs/testing.md 「全套」): every test file under
// router/test in parallel bun test workers, one log and one junit, then the
// list of files that ran, checked against router/test. Runs from the repo
// root whatever the caller's directory, and stops if that is not this repo.
// CCTR_TEST_JOBS: workers (default 4). CCTR_TEST_OUT: where the log, junit,
// file list and this machine's timings go (default .test-out, gitignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'fs'
import { isAbsolute, join, resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
let pkgName = ''
try { pkgName = JSON.parse(readFileSync('package.json', 'utf8')).name } catch {}
if (process.cwd() !== ROOT || pkgName !== 'claude-channel-telegram' || !existsSync('bunfig.toml') || !existsSync('router/test')) {
  console.error(`not the cc-telegram-router repo: ${process.cwd()}`)
  process.exit(1)
}

const TEST_DIR = 'router/test'
const jobs = Number(process.env.CCTR_TEST_JOBS ?? 4)
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error(`CCTR_TEST_JOBS 要是正整數: ${process.env.CCTR_TEST_JOBS}`)
  process.exit(2)
}
const outEnv = process.env.CCTR_TEST_OUT
const out = outEnv ? (isAbsolute(outEnv) ? outEnv : resolve(outEnv)) : join(ROOT, '.test-out')
mkdirSync(out, { recursive: true })
// GMT+8 in the file names, like every time this project shows
const stamp = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
const log = join(out, `full-${stamp}.log`), junit = join(out, `full-${stamp}.junit.xml`), list = join(out, `full-${stamp}.files.txt`)
// This machine's timings (written after each run) first; the committed baseline fills in what it lacks.
const timings = [join(out, 'timings.json'), join(ROOT, TEST_DIR, 'timings.json')].filter((f, i) => i === 0 || existsSync(f))

const expected = [...new Bun.Glob(`${TEST_DIR}/**/*.test.ts`).scanSync({ cwd: ROOT })].sort()
const args = ['test', TEST_DIR, `--parallel=${jobs}`, ...timings.map(f => `--timings=${f}`), '--update-timings', '--reporter=junit', `--reporter-outfile=${junit}`]
const sink = createWriteStream(log)
const say = (s: string) => { process.stdout.write(s); sink.write(s) }
say(`pwd: ${process.cwd()}\n`)
say(`bun: ${Bun.version} (${Bun.which('bun')})\n`)
say(`測試檔: ${expected.length} 個 (${TEST_DIR}/**/*.test.ts), ${jobs} 個 worker\n`)
say(`bun ${args.join(' ')}\n`)
say(`log: ${log}\njunit: ${junit}\n\n`)

const started = performance.now()
const p = Bun.spawn(['bun', ...args], { stdout: 'pipe', stderr: 'pipe' })
const pump = async (s: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
  for await (const c of s as unknown as AsyncIterable<Uint8Array>) { to.write(c); sink.write(c) }
}
await Promise.all([pump(p.stdout, process.stdout), pump(p.stderr, process.stderr)])
const code = await p.exited
const secs = (performance.now() - started) / 1000

// The junit: one testsuite per file that ran
let xml = ''
try { xml = readFileSync(junit, 'utf8') } catch {}
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
const top = xml.match(/<testsuites\b[^>]*>/)?.[0] ?? ''
// (a describe block nests a testsuite with the same file)
const ran = [...new Set([...xml.matchAll(/<testsuite\b[^>]*>/g)].map(m => attr(m[0], 'file') ?? attr(m[0], 'name') ?? ''))].sort()
const outside = ran.filter(f => !f.startsWith(`${TEST_DIR}/`) || !expected.includes(f))
const missing = expected.filter(f => !ran.includes(f))
writeFileSync(list, ran.join('\n') + '\n')

const n = (k: string) => Number(attr(top, k) ?? NaN)
const problems: string[] = []
if (!top) problems.push('沒有 junit')
if (outside.length) problems.push(`${outside.length} 個檔不在 ${TEST_DIR} 的測試檔裡: ${outside.join(', ')}`)
if (missing.length) problems.push(`${missing.length} 個測試檔沒跑到: ${missing.join(', ')}`)
say(`\n=== 全套 (${jobs} 個 worker)\n`)
say(`測試: ${n('tests')} 項, pass ${n('tests') - n('skipped') - n('failures')}, skip ${n('skipped')}, fail ${n('failures')}\n`)
say(`檔案: 跑了 ${ran.length} 個, ${TEST_DIR} 有 ${expected.length} 個, 清單 ${list}\n`)
for (const p of problems) say(`問題: ${p}\n`)
say(`共 ${secs.toFixed(1)}s, bun test 結束碼 ${code}\n`)
say(`log: ${log}\njunit: ${junit}\n`)
await new Promise(r => sink.end(r))
process.exit(code !== 0 ? code : problems.length ? 1 : 0)
