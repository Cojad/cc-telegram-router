// MCP tool schemas the worker-side plugin advertises. Pure data, shared by
// router (which executes the calls) and plugin (which lists them to Claude
// Code and forwards calls over the router socket).

export const TOOL_DEFINITIONS = [
  {
    name: 'reply',
    description:
      'Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        reply_to: {
          type: 'string',
          description: 'Message ID to thread under. Use message_id from the inbound <channel> block.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each.',
        },
        format: {
          type: 'string',
          enum: ['text', 'markdownv2'],
          description: "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'react',
    description: 'Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        emoji: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'download_attachment',
    description: 'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit a message the bot previously sent. Useful for interim progress updates. Edits don\'t trigger push notifications — send a new reply when a long task completes so the user\'s device pings.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
        format: {
          type: 'string',
          enum: ['text', 'markdownv2'],
          description: "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",
        },
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  },
  {
    name: 'send_sticker',
    description:
      'Send a Telegram sticker. Pass chat_id from the inbound message, and either file_id (a sticker already on Telegram servers, e.g. from lookup_message or a sticker set) or file (an absolute local path to a .webp/.tgs/.webm to upload directly, not yet part of any set). Optionally reply_to (message_id) for threading.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        file_id: { type: 'string', description: 'Sticker file_id already known to Telegram. Mutually exclusive with file.' },
        file: { type: 'string', description: 'Absolute path to a local .webp/.tgs/.webm sticker file to upload. Mutually exclusive with file_id.' },
        reply_to: {
          type: 'string',
          description: 'Message ID to thread under. Use message_id from the inbound <channel> block.',
        },
        emoji: { type: 'string', description: 'Emoji associated with the sticker. Only applies when uploading via file; ignored for file_id.' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'lookup_message',
    description: 'Look up messages this plugin has seen (sent or received) in a chat, from the local SQLite log — not the Telegram API, which has no history endpoint. Pass message_id for one exact message (e.g. to resolve a reply_to_message_id that had no reply_to_text), or omit it and use limit for the most recent messages in that chat. Includes messages gate() dropped (delivered: false) and nothing else about them.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string', description: 'Exact message to look up. Omit to list recent messages instead.' },
        limit: { type: 'string', description: 'Max messages to return when message_id is omitted. Default 10, max 100.' },
        before_message_id: { type: 'string', description: 'With limit: page to messages older than this one.' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'request_send_grant',
    description: 'Ask for permission to send to another Telegram conversation after reply refused it. mode "owner": ask the owner for a permanent grant (they get approve/deny buttons). mode "target": ask the target conversation to accept messages from this one. You get a <router_status> message when it is decided; send again then.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The conversation you want to send to' },
        mode: { type: 'string', enum: ['owner', 'target'] },
        reason: { type: 'string', description: 'One line: why, shown to whoever decides' },
      },
      required: ['chat_id', 'mode', 'reason'],
    },
  },
  {
    name: 'request_elevation',
    description: 'Ask for permission above this conversation\'s role, after a tool call was refused for lack of permission and the person agreed to ask. If the person who started this turn has a higher role, they are asked right in the chat; otherwise the bot owner is asked. You get a <router_status> message with the outcome; when approved it tells you how to run the work.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What needs to be done that was refused, e.g. the command or the path' },
        reason: { type: 'string', description: 'One line: why it is needed, shown to whoever decides' },
      },
      required: ['action', 'reason'],
    },
  },
  {
    name: 'save_bot_profile',
    description: 'First-run setup only (when a <bootstrap> note asks for it, in the owner\'s DM): save the bot\'s name and persona after interviewing the owner. The persona then applies to every conversation of this bot.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'What the owner wants the bot to be called' },
        persona: { type: 'string', description: 'Second-person settings for the bot itself ("你是..."): personality, speaking style, purpose. Under 300 characters.' },
      },
      required: ['name', 'persona'],
    },
  },
  {
    name: 'get_chat_context',
    description: 'Current information about this Telegram conversation: chat id, type, title, your role and what it allows, folder, model, autoCompactWindow. The same data arrives as <chat_context> with messages; call this when unsure.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const
