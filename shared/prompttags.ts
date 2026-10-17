// The <channel> tags of a prompt (docs/permissions.md 「這一輪的發話者」):
// Claude Code hands the UserPromptSubmit hook the prompt it starts a turn
// with, one <channel source="plugin:telegram:telegram" ...> tag per message
// (its meta as attributes, values escaped). The hook sends the router only
// the attributes it needs to tell who the turn's messages came from; the
// router believes a tag only when its delivery tag names a message the
// router itself delivered to that conversation (router/elevation.ts).

/** The attributes a tag is reduced to; anything else stays on the worker's machine. */
export const TAG_FIELDS = ['chat_id', 'message_id', 'user_id', 'kind', 'delivery'] as const
export type PromptTag = Partial<Record<typeof TAG_FIELDS[number], string>> & {
  /** not one attribute list as Claude Code writes it (the same name twice, text left over): not to be believed */
  bad?: true
}
/** At most this many tags, each value cut to this length: a prompt of a few hundred messages still makes a small hook request. */
export const MAX_TAGS = 100
const MAX_VALUE = 64

const TAG = /<channel source="[^"]*telegram[^"]*"([^>]*)>/g
const ATTR = /\s+([A-Za-z_][\w-]*)="([^"]*)"/y

/** Every Telegram <channel> tag in a prompt, reduced to TAG_FIELDS; true in
 *  the second place when there were more than MAX_TAGS (the rest left out). */
export function promptTags(prompt: string): { tags: PromptTag[]; more: boolean } {
  const tags: PromptTag[] = []
  let more = false
  for (const m of prompt.matchAll(TAG)) {
    if (tags.length >= MAX_TAGS) { more = true; break }
    tags.push(parseAttrs(m[1]!))
  }
  return { tags, more }
}

function parseAttrs(text: string): PromptTag {
  const seen = new Set<string>()
  const out: PromptTag = {}
  let at = 0
  ATTR.lastIndex = 0
  for (let m = ATTR.exec(text); m; m = ATTR.exec(text)) {
    at = ATTR.lastIndex
    const [, name, value] = m
    if (seen.has(name!)) out.bad = true
    seen.add(name!)
    if ((TAG_FIELDS as readonly string[]).includes(name!)) (out as any)[name!] = value!.slice(0, MAX_VALUE)
  }
  if (text.slice(at).trim()) out.bad = true
  return out
}
