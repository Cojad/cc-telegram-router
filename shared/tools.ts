// MCP tool schemas the worker-side plugin advertises. Pure data, shared by
// router (which executes the calls) and plugin (which lists them to Claude
// Code and forwards calls over the router socket).

export const TOOL_DEFINITIONS = [
  {
    name: 'reply',
    description:
      'Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents. The result says how many messages were sent and whether the text went as a caption.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        reply_to: {
          type: 'string',
          description: 'Message ID to thread under. Use message_id from the inbound <channel> block.',
        },
        on_behalf_of: {
          type: 'string',
          description: 'From a group: message_id of the message in this group that asked for a DM answer. chat_id is then that sender\'s user id (their DM with the bot); no grant needed, no time limit (e.g. a reminder tomorrow). The router adds a first line saying which group and message it answers. Only the person who sent that message can be the target.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths to attach. Images (.jpg .jpeg .png .gif .webp) send as photos (inline preview); other types as documents. Max 50MB each. The text goes as the caption of the first file when it fits Telegram\'s caption limit (1024 characters as shown, i.e. MarkdownV2 escapes and markup not counted): one message, not two. A longer text goes first, whole, as its own message(s), then the files without a caption. Several files go as albums: photos together, documents together (documents only group with documents), at most 10 per album, each kind in the order of its first file; a lone file of its kind goes on its own. An empty text sends only the files.',
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
    description: 'Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB. A text file (.env, .json, .yaml, .txt, source code, text/*; up to 1 MB) was already downloaded and checked for secrets when the message came in (you get that copy): any found are replaced with <已遮蔽 #<event id>.<n>: kind, 末 4 碼 xxxx> (use event_raw / secret_from_handle as for a message).',
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
    name: 'bot_api',
    description: 'Call the Telegram Bot API. credential "self": as this bot itself, any method (e.g. deleteMessage, pinChatMessage, getChat), owner and admin conversations only (getUpdates/setWebhook/deleteWebhook/logOut/close are blocked). Any other name: this conversation\'s own secret (registered by a user with /secret set in this chat; any role, only the methods given then) if there is one, else a credential the owner stored in the router (cross-bot skills, e.g. another bot\'s sticker set), checked against its roles and methods. The token never reaches you. files maps a form field to an absolute path inside your folder (use "attach://<field>" in params to refer to it). See /telegram:bot-skill.',
    inputSchema: {
      type: 'object',
      properties: {
        credential: { type: 'string', description: '"self" for this bot, a secret of this conversation (/secret list), or a credential name (/router cred list)' },
        method: { type: 'string', description: 'Bot API method, e.g. addStickerToSet' },
        params: { type: 'object', description: 'Method parameters' },
        files: { type: 'object', description: 'Form field -> absolute file path to upload' },
      },
      required: ['credential', 'method'],
    },
  },
  {
    name: 'http_api',
    description: 'Call an HTTP API (e.g. OpenAI image generation) with this conversation\'s own secret (/secret set <名稱> <key> --http <網址> [路徑...] in this chat; any role, only that URL and those paths) or else an API-key credential the owner stored in the router; the key never reaches you (it is replaced with <密鑰> in responses). path must be one the credential allows. json for a JSON body, or json_file (a file relative to your folder or absolute, up to 20 MB; the router reads it: inside your folder, or anywhere but router state for an owner or admin conversation) whose content is sent as the JSON body (use it for large requests instead of writing them out as json), or form + files (field -> absolute path in your folder) for multipart; only one of them. save_b64 {at: "data.0.b64_json", to: "stickers/raw.png"} writes a base64 field of the response to a file in your folder instead of returning it. headers: extra request headers passed on as they are (e.g. {"anthropic-version": "2023-06-01"}); a credential may have default headers the router adds when you send none of that name (yours win); the router puts the key where the credential says (a header or a query parameter), so never send the header the key goes in, Authorization, Proxy-Authorization, Cookie, Host, Content-Type or other transport headers, and never put the key parameter of a --query credential in path (refused). See /telegram:bot-skill.',
    inputSchema: {
      type: 'object',
      properties: {
        credential: { type: 'string' },
        method: { type: 'string', description: 'GET or POST (default POST)' },
        path: { type: 'string', description: 'e.g. /v1/images/generations' },
        json: { type: 'object' },
        json_file: { type: 'string', description: 'A JSON file (relative to your folder or absolute, up to 20 MB) sent as the body; inside your folder unless this is an owner or admin conversation; not with json, form or files' },
        form: { type: 'object' },
        files: { type: 'object' },
        save_b64: { type: 'object', properties: { at: { type: 'string' }, to: { type: 'string' } } },
        headers: { type: 'object', description: 'Extra headers, name -> value (no auth headers)' },
      },
      required: ['credential', 'path'],
    },
  },
  {
    name: 'event_raw',
    description: 'Ask what a masked message originally was (plan 10e). A secret in a message reaches you as <已遮蔽 #<event id>.<n>: 種類, 末 4 碼 xxxx>; the original update is kept encrypted. Only in a turn whose sender, or this conversation, is owner or admin (a turn typed in the terminal has no sender: only the conversation\'s role counts) (any conversation\'s event, the owner\'s DM too). The router swaps each value for a handle with what it can tell (kind, the bot getMe finds, whether it equals a stored credential) and a fixed-prompt agent with no tools answers your question; you get that handle version and the answer, never a value. Handles work only in this conversation: ttl_minutes (default 10, at most 60) or permanent (listed and revoked with /secret handles, /secret revoke). Logged in the 🔑 密鑰偵測 topic. To use a handle call secret_from_handle.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'number', description: 'The event id: the number after # in <已遮蔽 #id.n ...>' },
        question: { type: 'string', description: 'What you want to know, e.g. 這則訊息原本是什麼, 遮掉的是什麼, 可以怎麼用' },
        ttl_minutes: { type: 'number', description: 'How long the handles stay valid, 1 to 60 (default 10)' },
        permanent: { type: 'boolean', description: 'Handles that stay until revoked' },
      },
      required: ['event_id', 'question'],
    },
  },
  {
    name: 'secret_from_handle',
    description: 'Register a handle from event_raw (h<數字>) as this conversation\'s own secret, as /secret set would (a Telegram bot token is checked with getMe; same limits), without the value ever reaching you. Then call bot_api / http_api with credential = name. Logged in the 🔑 密鑰偵測 topic.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'e.g. h7' },
        name: { type: 'string', description: 'Secret name: lowercase letters, digits, - or _' },
        scope: { type: 'string', description: 'What follows the value in /secret set: Bot API methods ("sendMessage get*", empty = all), or "--http <網址> [--header <標頭>] [--scheme <前綴>] [--default-header <名稱>:<值>]... [路徑...]" for an API key' },
      },
      required: ['handle', 'name'],
    },
  },
  {
    name: 'run_skill',
    description: 'Run an approved privileged action of a skill (its privileged.json, e.g. web-instagram extract): the router runs it in its own sandbox with the credentials it needs (cookies...), which never reach you; output files land in your folder. Works for user and power conversations without elevation. args must match the action\'s argument patterns; an argument limited to higher roles (e.g. force for a long video) triggers an elevation request instead. Limited to 10 runs per hour per conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string' },
        action: { type: 'string' },
        args: { type: 'object', description: 'Action arguments, e.g. {"url": "https://..."}' },
      },
      required: ['skill', 'action'],
    },
  },
  {
    name: 'skill_check',
    description: 'Check a skill you wrote in your folder (e.g. skills/<name>) before it is installed or approved: the router reads SKILL.md and privileged.json with its own parser (nothing is run) and tells you what is wrong and how to fix it, what install_skill would refuse, what /router skill approve would list, and what your role can do next. Every role but guest. See /telegram:bot-skill.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The skill folder, relative to your folder (e.g. skills/signup) or a bare name meaning skills/<name>' },
      },
      required: ['path'],
    },
  },
  {
    name: 'install_skill',
    description: 'Install a skill you wrote in <your folder>/skills/<name>/ (you cannot write under .claude yourself): scope "conversation" puts it in this conversation\'s .claude/skills (power and up), "bot" makes every conversation of this bot get it, "all" every bot (owner/admin). A role too low is refused like any other block (elevation). Skills must not contain tokens. See /telegram:bot-skill.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        scope: { type: 'string', enum: ['conversation', 'bot', 'all'] },
        replace: { type: 'boolean', description: 'Overwrite an installed skill of the same name' },
      },
      required: ['name', 'scope'],
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
