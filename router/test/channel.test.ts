// Broadcast channels are not supported (README 運作方式 11, 頻道驗收對照):
// the notice the owner gets when the bot is added to a channel (setup.ts
// channelJoinNotice), and the /telegram:doc channel section
// (plugin/skills/doc/SKILL.md 「頻道」). End to end: e2e-channel.test.ts.
// All ids are example values.

import { expect, test } from 'bun:test'
import { channelJoinNotice } from '../setup'

const ISSUES = 'https://github.com/Cojad/cc-telegram-router/issues'

test('channelJoinNotice: channel name and id, not supported, posts are not handled, GitHub issues', () => {
  const n = channelJoinNotice('cc_bot', { id: -100555, title: 'News' })
  expect(n).toStartWith('📣 @cc_bot 被加入頻道「News」(-100555)')
  expect(n).toContain('目前尚未正式支援 Telegram 頻道, bot 不會處理頻道貼文')
  expect(n).toContain(ISSUES)
  expect(n).toContain('使用情境與需要的功能')
  expect(channelJoinNotice('cc_bot', { id: -100555 })).toContain('「-100555」')
})

test('/telegram:doc says channels are not supported: owner notice only, posts and commands not handled, GitHub issues', async () => {
  const doc = await Bun.file(new URL('../../plugin/skills/doc/SKILL.md', import.meta.url)).text()
  const sec = doc.slice(doc.indexOf('## 頻道'), doc.indexOf('## 審核群組與新 bot 初次設定'))
  for (const s of ['目前不支援', '通知 owner', '不會送進任何 worker', '指令也不處理', ISSUES]) expect(sec).toContain(s)
})
