# cc-telegram-router

Telegram 對話分流: 一隻 router 接 bot 的所有訊息, 每個 Telegram 對話交給一個獨立的 Claude Code 背景 session (`claude --bg`), 各自住在 `/x/cc/<對話>/` 自己的資料夾, 權限依角色分開設定.

## 結構

| 目錄 | 內容 |
|---|---|
| `router/` | router 本體. `main.ts` 組裝; `config.ts` `lock.ts` `db.ts` `conversations.ts` `settings.ts` `supervisor.ts` `ipc.ts` `guard.ts` |
| `router/telegram/` | 收發 Telegram 的模組 (沿用 v1 plugin): `transport.ts` `inbound.ts` `policy.ts` `outbound.ts` `store.ts` `format.ts` `rich.ts` |
| `plugin/` | worker 載入的 Telegram plugin v2 (消費者模式): 不持有 token, 透過 unix socket 跟 router 收發 |
| `shared/` | router 與 plugin 共用的協定 (`protocol.ts`) 與工具定義 (`tools.ts`) |
| `templates/` | 各對話 settings 的範本 (`base-settings.json`, `roles/<角色>.json`), 共用 CLAUDE.md 範例 (`CLAUDE.md.example`) |
| `deploy/` | `install.sh` 與 systemd user unit |
| `docs/v1/` | v1 (單一 session plugin) 時期的文件, 僅供參考 |

## 運作方式

1. router 輪詢 bot (getUpdates), 每個 update 原樣寫進 `router.db` 的 `events`.
2. 沿用 v1 的 gate (配對, 允許清單, 群組 mention) 決定要不要送進 Claude. 要送的訊息依 (bot, chat_id) 對應到對話, 第一次出現時建立資料夾與 settings.
3. 訊息進該對話的佇列. worker 不在線就喚醒: 第一次用 `claude --bg` 帶一句 init prompt 開新 session, 之後用 `--resume`.
4. worker 的 plugin 讀 `CLAUDE_PROJECT_DIR` 知道自己是哪個對話, 連 `router.sock` 報到, 收到佇列裡的訊息後轉成 channel 通知並回 ack.
5. 模型呼叫 reply 等工具時, plugin 把呼叫轉給 router; router 檢查目標與附件路徑後代為呼叫 Bot API, 每個呼叫寫進 `outbound`.

## 部署

```bash
deploy/install.sh router   # 編譯到 /x/cc/.router/cc-telegram-router, 複製 templates
deploy/install.sh plugin   # 打包 plugin v2 到官方 plugin 快取路徑 (第一次會備份原內容)
deploy/install.sh unit     # 安裝 systemd user unit
systemctl --user enable --now cc-telegram-router
```

共用的 `/x/cc/CLAUDE.md` 可以從範例開始: `cp templates/CLAUDE.md.example /x/cc/CLAUDE.md`, 再把 `<...>` 的欄位換成自己的內容. worker 端的使用說明在 plugin 的 `/telegram:doc` skill (`plugin/skills/doc/SKILL.md`).

`/x/cc/.router/config.json` (權限 600) 與 `access.json` 要手動建立一次:

```json
{
  "bots": [{ "name": "cc", "token": "<bot token>" }],
  "home": "/x/cc",
  "stateDir": "/x/cc/.router",
  "owners": ["<owner telegram uid>"],
  "model": "claude-opus-5-5",
  "autoCompactWindow": 750000,
  "claudeBin": "/home/<user>/.local/bin/claude"
}
```

## 測試

```bash
bun test router/test
```

| 檔案 | 對應 |
|---|---|
| `router/test/phase1.test.ts` | 規劃 03, 04, 05, 07 的模組行為: 對話資料夾, settings 範本, 佇列, 送出檢查, 單一實例, IPC, supervisor, plugin MCP, router 離線告知 |
| `router/test/phase2.test.ts` | 規劃 03 的 /router 指令表與拒絕訊息, 06 chat_context, router_log, hook, 「cc /」代打, 即時進度訊息 |
| `router/test/e2e.test.ts` | 真的 router + 假 Bot API: 每個 update 與送出的 payload 都在 db, 回覆送出與紀錄, /router 指令不轉給 worker, CLI |
| `router/test/e2e-wake.test.ts` | 真的 router + 假 claude CLI (`fixtures/`, 假 worker 是真的程序): 私訊與群組各自一個 worker 且不串線, 被回收後自動喚醒, worker 不在時連發多則只喚醒一次且不掉訊息 |

### Phase 1 驗收對照

| 驗收項目 | 測試 |
|---|---|
| 私訊與群組各自一個背景 session, 回覆不會跑錯對話 | e2e-wake「DM and group each get their own worker…」, e2e「a plugin for the conversation gets…」(user 對話送往別的 chat 被擋) |
| worker 被回收後再傳訊會自動喚醒 | e2e-wake「a reaped worker is woken by the next message…」 |
| 連續快速傳多則只喚醒一次, 不掉訊息 | e2e-wake「a burst while the worker is down…」, phase1「unacked deliveries are sent again…」 |
| 每個 update 與送出的 payload 都在 db | e2e「every update is logged…」, e2e「…its reply goes out and is logged」 |

### Phase 2 驗收對照

| 驗收項目 | 測試 |
|---|---|
| 指令的權限與拒絕訊息符合規劃 03 指令表 | phase2 的指令測試 (users 被拒, admin 的限制, bot token 只限 owner 私訊, access, chat, session, config, 列表) |
| bot rotate 不斷線 | e2e「bot rotate (owner DM)…」: 輪詢換到新 token, 含 token 的訊息被刪, 換線後的訊息照常送達 |
| 指令執行後下一則訊息帶 router_log | e2e「a /router command is answered by the router…」 |
| compact 與喚醒後 chat_context 會補回 | phase2「SessionStart hook puts the chat_context back after compact」, e2e-wake「a reaped worker is woken…」(新連線帶 chat_context) |
