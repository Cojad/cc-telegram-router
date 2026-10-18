// bun run test:full's progress (docs/testing.md 「全套」「進度」): full.ts
// passes this file to bun test with --preload and sets CCTR_TEST_PROGRESS to
// a file. bun loads a preload once per test file (each file has its own
// global under --parallel), so this appends one JSON line when a file starts
// and one when its tests are over (afterAll), with how many tests ran
// (afterEach). It only writes that file: no test sees or waits on it, and a
// failed write is ignored. Without CCTR_TEST_PROGRESS it registers nothing.
// Tests: router/test/progress.test.ts.

import { afterAll, afterEach } from 'bun:test'
import { appendFileSync } from 'fs'
import { relative } from 'path'

const out = process.env.CCTR_TEST_PROGRESS
if (out) {
  const file = relative(process.cwd(), Bun.main)
  const put = (o: object) => { try { appendFileSync(out, JSON.stringify({ ...o, file, pid: process.pid, at: Date.now() }) + '\n') } catch {} }
  let ran = 0
  put({ ev: 'start' })
  afterEach(() => { ran++ })
  afterAll(() => put({ ev: 'done', ran }))
}
