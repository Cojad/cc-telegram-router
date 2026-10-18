// The four tools Claude calls to talk back to Telegram — reply, react,
// download_attachment, edit_message — plus the static schema ListTools
// returns for them. No inbound/policy/poller concerns here: this module
// only ever sends things Claude asked it to send, to a chat_id the caller
// has already checked is allowed.

import { InputFile, type Bot } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { mkdirSync, statSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
import { CAPTION_LIMIT, captionLength, chunk, formatMessageRow, formatMessageRows } from './format'
import type { Access } from './policy'
import type { Store } from './store'

export { TOOL_DEFINITIONS } from '../../shared/tools'

// .jpg/.jpeg/.png/.gif/.webp go as photos (Telegram compresses + shows inline);
// everything else goes as documents (raw file, no compression).
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
/** sendMediaGroup: 2-10 items. */
const MAX_ALBUM = 10

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export interface OutboundDeps {
  bot: Bot
  token: string
  inboxDir: string
  loadAccess: () => Access
  /** Throws if chat_id isn't one the inbound gate would ever deliver from. */
  assertAllowedChat: (chat_id: string) => void
  /** Throws if a file path being sent as an attachment reaches into plugin state. */
  assertSendable: (path: string) => void
  store: Pick<Store, 'record' | 'lookup' | 'recent'>
  /** Bot API server (tests); default https://api.telegram.org. */
  apiRoot?: string
  /** A downloaded file before it is written (plan 10e: secrets in text files
   *  become markers); returns the bytes to write. */
  scanDownload?: (buf: Buffer, file: { file_id: string; file_path: string }) => Promise<Buffer>
  /** A text attachment the router already downloaded (and checked) when it came in; null: download it now. */
  cachedDownload?: (file_id: string) => Promise<{ buf: Buffer; file_path: string; file_unique_id: string } | null>
}

type FileGroup = { kind: 'photo' | 'document'; files: string[] }

/** reply's files as Telegram messages: photos together and documents
 *  together (sendMediaGroup takes 2-10 items, and documents only group
 *  with documents), each kind in the order of its first file, at most 10
 *  per album; a group of one is sent on its own (sendPhoto / sendDocument). */
export function groupFiles(files: string[]): FileGroup[] {
  const byKind = new Map<FileGroup['kind'], string[]>()
  for (const f of files) {
    const kind = PHOTO_EXTS.has(extname(f).toLowerCase()) ? 'photo' : 'document'
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind)!.push(f)
  }
  const out: FileGroup[] = []
  for (const [kind, fs] of byKind) for (let i = 0; i < fs.length; i += MAX_ALBUM) out.push({ kind, files: fs.slice(i, i + MAX_ALBUM) })
  return out
}

/** Telegram refused a caption as too long (400 "message caption is too long"). */
function isCaptionTooLong(e: unknown): boolean {
  const err = e as { error_code?: number; description?: string; message?: string }
  return /caption is too long/i.test(String(err?.description ?? err?.message ?? ''))
}

const DEFAULT_LOOKUP_LIMIT = 10
const MAX_LOOKUP_LIMIT = 100

export async function callTool(name: string, args: Record<string, unknown>, deps: OutboundDeps): Promise<ToolResult> {
  const { bot, token, inboxDir, loadAccess, assertAllowedChat, assertSendable, store } = deps
  try {
    switch (name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
        const files = (args.files as string[] | undefined) ?? []
        const format = (args.format as string | undefined) ?? 'text'
        const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : undefined

        assertAllowedChat(chat_id)

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
          }
        }

        const access = loadAccess()
        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        const chunks = chunk(text, limit, mode)
        const sentIds: number[] = []
        const recordSent = (message_id: number, content: string): void => {
          try {
            store.record({
              chat_id, message_id: String(message_id), direction: 'out',
              ts: new Date().toISOString(), content, delivered: true,
              ...(reply_to != null ? { reply_to_message_id: String(reply_to) } : {}),
            })
          } catch (err) {
            process.stderr.write(`telegram channel: store.record (outbound) failed: ${err}\n`)
          }
        }

        // The text: as the caption of the first file when there are files and
        // it fits (one message instead of two); otherwise its own message(s)
        // first, whole, then the files without a caption (docs/architecture.md
        // 回覆與附件). An empty text with files sends only the files.
        const hasText = text.trim() !== ''
        const groups = groupFiles(files)
        let captioned = groups.length > 0 && hasText && captionLength(text, format) <= CAPTION_LIMIT
        let captionRefused = false
        let textParts = 0
        const total = (): number => sentIds.length

        const sendText = async (): Promise<void> => {
          const before = sentIds.length
          try {
            for (let i = 0; i < chunks.length; i++) {
              const shouldReplyTo =
                reply_to != null &&
                replyMode !== 'off' &&
                (replyMode === 'all' || i === 0)
              const sent = await bot.api.sendMessage(chat_id, chunks[i], {
                ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
                ...(parseMode ? { parse_mode: parseMode } : {}),
              })
              sentIds.push(sent.message_id)
              recordSent(sent.message_id, chunks[i])
            }
            textParts = chunks.length
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(
              `reply failed after ${sentIds.length - before} of ${chunks.length} chunk(s) sent: ${msg}`,
            )
          }
        }

        // Files thread under reply_to unless replyToMode is off (as before).
        const fileReply = reply_to != null && replyMode !== 'off'
          ? { reply_parameters: { message_id: reply_to } }
          : {}
        const sendGroup = async (g: FileGroup, caption: string | null): Promise<void> => {
          const cap = caption != null ? { caption, ...(parseMode ? { parse_mode: parseMode } : {}) } : {}
          const label = (f: string, i: number) => `(${g.kind}: ${f})${caption != null && i === 0 ? `\n${caption}` : ''}`
          if (g.files.length === 1) {
            const f = g.files[0]!
            const opts = { ...fileReply, ...cap }
            const sent = g.kind === 'photo'
              ? await bot.api.sendPhoto(chat_id, new InputFile(f), opts)
              : await bot.api.sendDocument(chat_id, new InputFile(f), opts)
            sentIds.push(sent.message_id)
            recordSent(sent.message_id, label(f, 0))
            return
          }
          const media = g.files.map((f, i) => ({ type: g.kind, media: new InputFile(f), ...(i === 0 ? cap : {}) }))
          const sent = await bot.api.sendMediaGroup(chat_id, media as Parameters<Bot['api']['sendMediaGroup']>[1], fileReply)
          sent.forEach((m, i) => { sentIds.push(m.message_id); recordSent(m.message_id, label(g.files[i] ?? '', i)) })
        }

        if (!captioned && (groups.length === 0 || hasText)) await sendText()
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi]!
          try {
            try {
              await sendGroup(g, gi === 0 && captioned ? text : null)
            } catch (err) {
              // our length estimate let through a caption Telegram finds too
              // long: nothing is sent yet, so send it the long way instead
              if (!(gi === 0 && captioned && isCaptionTooLong(err))) throw err
              captioned = false
              captionRefused = true
              await sendText()
              await sendGroup(g, null)
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg.startsWith('reply failed')) throw err
            throw new Error(`reply failed after ${total()} message(s) sent: ${msg}`)
          }
        }

        if (groups.length === 0) {
          const result =
            sentIds.length === 1
              ? `sent (id: ${sentIds[0]})`
              : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
          return { content: [{ type: 'text', text: result }] }
        }
        const what: string[] = []
        if (textParts) what.push(textParts === 1 ? 'the text' : `the text in ${textParts} parts`)
        groups.forEach((g, gi) => {
          const n = g.files.length
          const name = n === 1 ? `1 ${g.kind}` : `an album of ${n} ${g.kind}s`
          what.push(gi === 0 && captioned ? `${name} with the text as the caption${n > 1 ? ` of the first ${g.kind}` : ''}` : name)
        })
        const why = captionRefused
          ? ' (Telegram said the text is too long for a caption, so it went as its own message first)'
          : textParts
            ? ` (the text is over the ${CAPTION_LIMIT}-character caption limit, so it went as its own message first)`
            : !hasText ? ' (no text)' : ''
        const n = sentIds.length
        const result = `sent ${n} message${n === 1 ? '' : 's'} (id${n === 1 ? '' : 's'}: ${sentIds.join(', ')}): ${what.join(', then ')}${why}`
        return { content: [{ type: 'text', text: result }] }
      }
      case 'send_sticker': {
        const chat_id = args.chat_id as string
        const file_id = args.file_id as string | undefined
        const filePath = args.file as string | undefined
        const reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
        const emoji = args.emoji as string | undefined

        assertAllowedChat(chat_id)

        if (!file_id && !filePath) throw new Error('send_sticker requires either file_id or file')
        if (file_id && filePath) throw new Error('send_sticker: pass only one of file_id or file, not both')

        let sticker: string | InputFile
        if (filePath) {
          assertSendable(filePath)
          const st = statSync(filePath)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${filePath} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
          }
          sticker = new InputFile(filePath)
        } else {
          sticker = file_id as string
        }

        const access = loadAccess()
        const replyMode = access.replyToMode ?? 'first'
        const opts = {
          ...(reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : {}),
          ...(emoji ? { emoji } : {}),
        }

        const sent = await bot.api.sendSticker(chat_id, sticker, opts)
        try {
          store.record({
            chat_id, message_id: String(sent.message_id), direction: 'out',
            ts: new Date().toISOString(), content: `(sticker: ${file_id ?? filePath})`, delivered: true,
            ...(reply_to != null ? { reply_to_message_id: String(reply_to) } : {}),
          })
        } catch (err) {
          process.stderr.write(`telegram channel: store.record (send_sticker) failed: ${err}\n`)
        }
        return { content: [{ type: 'text', text: `sent (id: ${sent.message_id})` }] }
      }
      case 'react': {
        assertAllowedChat(args.chat_id as string)
        await bot.api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
          { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
        ])
        return { content: [{ type: 'text', text: 'reacted' }] }
      }
      case 'download_attachment': {
        const file_id = args.file_id as string
        const cached = deps.cachedDownload ? await deps.cachedDownload(file_id) : null
        let buf: Buffer, file: { file_path: string; file_unique_id?: string }
        if (cached) {
          buf = cached.buf
          file = cached
        } else {
          const got = await bot.api.getFile(file_id)
          if (!got.file_path) throw new Error('Telegram returned no file_path — file may have expired')
          file = { file_path: got.file_path, file_unique_id: got.file_unique_id }
          const url = `${deps.apiRoot ?? 'https://api.telegram.org'}/file/bot${token}/${file.file_path}`
          const res = await fetch(url)
          if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
          buf = Buffer.from(await res.arrayBuffer())
          if (deps.scanDownload) buf = await deps.scanDownload(buf, { file_id, file_path: file.file_path })
        }
        // file_path is from Telegram (trusted), but strip to safe chars anyway
        // so nothing downstream can be tricked by an unexpected extension.
        const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
        const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
        const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
        const path = join(inboxDir, `${Date.now()}-${uniqueId}.${ext}`)
        mkdirSync(inboxDir, { recursive: true })
        writeFileSync(path, buf)
        return { content: [{ type: 'text', text: path }] }
      }
      case 'edit_message': {
        const chat_id = args.chat_id as string
        assertAllowedChat(chat_id)
        const editFormat = (args.format as string | undefined) ?? 'text'
        const editParseMode = editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined
        const edited = await bot.api.editMessageText(
          chat_id,
          Number(args.message_id),
          args.text as string,
          ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
        )
        const id = typeof edited === 'object' ? edited.message_id : Number(args.message_id)
        // The edit replaces what this message_id means — INSERT OR REPLACE
        // on the same (chat_id, message_id) is exactly "this is now current".
        try {
          store.record({ chat_id, message_id: String(id), direction: 'out', ts: new Date().toISOString(), content: args.text as string, delivered: true })
        } catch (err) {
          process.stderr.write(`telegram channel: store.record (edit) failed: ${err}\n`)
        }
        return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
      }
      case 'lookup_message': {
        const chat_id = args.chat_id as string
        assertAllowedChat(chat_id)
        if (args.message_id != null) {
          const found = store.lookup(chat_id, String(args.message_id))
          return { content: [{ type: 'text', text: found ? formatMessageRow(found) : 'not found' }] }
        }
        const limit = Math.max(1, Math.min(Number(args.limit) || DEFAULT_LOOKUP_LIMIT, MAX_LOOKUP_LIMIT))
        const beforeId = args.before_message_id != null ? String(args.before_message_id) : undefined
        const rows = store.recent(chat_id, limit, beforeId)
        return { content: [{ type: 'text', text: formatMessageRows(rows) }] }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${name} failed: ${msg}` }],
      isError: true,
    }
  }
}
