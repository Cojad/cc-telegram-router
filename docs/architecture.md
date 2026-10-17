# 架構與運作方式

Telegram 對話分流: 一隻 router 接 bot 的所有訊息, 每個 Telegram 對話交給一個獨立的 Claude Code 背景 session (`claude --bg`), 各自住在 `<home>/bot<id>/<對話>/` 自己的資料夾 (`<home>` 是 router 的家目錄, 安裝位置可自選, 見 [部署與維運](operations.md#安裝位置)), 權限依角色分開設定.

[README](../README.md) 的文件索引列出所有文件.

## 結構

| 目錄 | 內容 |
|---|---|
| `router/` | router 本體. `main.ts` 組裝; `config.ts` `lock.ts` `db.ts` `conversations.ts` `settings.ts` `supervisor.ts` `ipc.ts` `guard.ts` `commands.ts` `context.ts` `progress.ts` `relay.ts` `rotate.ts`; `detect.ts` `rawvault.ts` 原始事件與密鑰保護 |
| `router/` (權限) | `permcheck.ts` 依角色檢查工具呼叫; `elevation.ts` 擋下, 提權詢問, 提權紀錄; `grants.ts` 跨對話傳訊申請; `pkgreview.ts` `packages.ts` 套件安裝審核; `classifier.ts` 工具呼叫分類器 (第一階段, 只記錄); `approvals.ts` 審核群組與通知, 三選一按鈕; `authz.ts` 已核准授權的撤銷與使用紀錄; `credentials.ts` 跨 bot 技能的憑證; `skills.ts` 技能安裝範圍; `setup.ts` 新 bot 初次設定 |
| `router/telegram/` | 收發 Telegram 的模組 (沿用 v1 plugin): `transport.ts` `inbound.ts` `policy.ts` `outbound.ts` `store.ts` `format.ts` `rich.ts` |
| `plugin/` | worker 載入的 Telegram plugin v2 (消費者模式): 不持有 token, 透過 unix socket 跟 router 收發. `skills/doc` (/telegram:doc 使用說明), `skills/format` (/telegram:format 排版規則), `skills/bot-skill` (/telegram:bot-skill 建立技能與憑證的 SOP) |
| `hooks/` | worker 的 hook (`cc-hook`): 進度事件, 權限檢查與提權, 壓縮後補回 chat_context |
| `shared/` | router 與 plugin 共用的協定 (`protocol.ts`), 工具定義 (`tools.ts`), 找 router 的位置檔 (`locate.ts`) |
| `templates/` | 各對話 settings 的範本 (`base-settings.json`, `roles/<角色>.json`), 共用 CLAUDE.md 範例 (`CLAUDE.md.example`) |
| `scripts/` | `cc /status`, `cc /usage`, `cc /context` 的報表腳本 (`deploy/install.sh router` 裝到 `<stateDir>/scripts`) |
| `deploy/` | `install.sh` 與 systemd user unit |
| `docs/` | 技術文件 (本檔與其他主題, 見 README 的文件索引) |

## 運作方式

1. router 輪詢 bot (getUpdates), 每個 update 寫進 `router.db` 的 `events`; 含密鑰的存遮蔽版, 原文加密存在 `event_raw` (見 [密鑰](secrets.md#原始事件與密鑰保護)).
2. 沿用 v1 的 gate (配對, 允許清單, 群組 mention) 決定要不要送進 Claude. 要送的訊息依 (bot, chat_id) 對應到對話, 第一次出現時建立資料夾與 settings.
3. 訊息進該對話的佇列. worker 不在線就喚醒: 第一次用 `claude --bg` 帶一句 init prompt 開新 session, 之後用 `--resume`.
4. worker 的 plugin 讀 `CLAUDE_PROJECT_DIR` 知道自己是哪個對話, 從位置檔 (`~/.config/cc-telegram-router/router.json`) 找到 `router.sock` 連上報到, 收到佇列裡的訊息後轉成 channel 通知並回 ack.
5. 模型呼叫 reply 等工具時, plugin 把呼叫轉給 router; router 檢查目標與附件路徑後代為呼叫 Bot API, 每個呼叫寫進 `outbound`. 群組的 worker 可以不經申請回到提問者的私訊: reply 帶 `on_behalf_of` (提問的那則群組訊息), router 確認發送者就是目標才放行, 不限時間, 私訊開頭標明來自哪個群組與哪則訊息.
6. 每個工具呼叫在 PreToolUse 由 hook 問 router, router 依對話角色的 settings 檢查, 越權就擋下, 發話者角色較高時在對話裡詢問提權 (細節見 [權限, 提權與審核](permissions.md#權限檢查與提權)).
7. 「cc /指令」由 router 開一次性的 tmux (`claude attach`) 代打: router 指令直接執行; `/status` `/usage` `/context` `/cost` 有專用報表; 其他指令只取它的輸出交給分身整理; `cc //指令` 直接截當下畫面. 離開前一律關掉留下的選單.
8. power 對話的套件安裝 (pip, npm, bun...) 由 router 查 registry 資料後交給模型判斷風險, low 直接放行, 其餘送 owner 審核 (細節見 [權限, 提權與審核](permissions.md#套件安裝審核)).
9. 叫醒 worker 時 router 計算 plugin (`server.js`, `skills/`) 與它看得到的三個技能範圍的雜湊, 記在對話的 `.chat/tools.sha`. 接續舊 session (resume) 而雜湊變了 (部署 plugin, 安裝技能), 下一則訊息的 `<router_log>` 附一次提醒, 請它重新讀取技能 SOP 與工具說明 (`router/freshness.ts`). 新 session 不用提醒.
10. `/router` 指令裡的 `chat_id` 指這隻 bot 的對話, `--bot <名稱>` 指別隻; 對話 key (`router-dm-123`) 到處都能用. 終端機 CLI 會找所有 bot, 多隻都有時列出候選並要求 `--bot`, 不會默默挑一隻.

## 目錄

```
<home>/CLAUDE.md                共用規則 (FORCED / GENERAL / Default suggestions 三層)
<home>/bot<id>/CLAUDE.md        該 bot 的人設 (初次設定訪談產生)
<home>/bot<id>/<type>-<chat>/   一個對話: CLAUDE.md, memory/, attachments/, .chat/
<home>/.router/                 stateDir (可放在 home 以外): router 執行檔, config.json, access.json, router.db, sessions/ (各對話 settings)
```

Claude Code 從工作目錄往上讀 CLAUDE.md, 三層自然疊加. bot 資料夾以 Telegram bot id 命名, 換 token 不會變. 舊版放在 `<home>/<對話>/` 的資料夾, router 啟動時會先停掉該 worker, 連同 `~/.claude/projects` 的對話紀錄搬進 bot 資料夾.

## 訊息紀錄

訊息紀錄 (`router.db` 的 `messages`, `lookup_message`, 回覆引用的補全, `/router log` 讀的那份) 每一筆屬於一隻 bot, 以 (bot, chat_id, message_id) 為唯一鍵, 每隻 bot 只讀寫自己的. 同一個人私訊兩隻 bot 時各自從 1 編號, 群組裡兩隻 bot 收到的是同一個編號, 以前只看 (chat_id, message_id) 會把另一隻 bot 的訊息當成重複而靜默丟掉, 引用也可能拿到另一隻 bot 的訊息. 加欄位前的舊紀錄只在升級時分配一次: 那個 chat 只有一隻 bot 有對話就歸它, 否則看 `events` (收到的) 或 `outbound` (送出的) 是哪隻 bot; 兩隻 bot 都有同號的訊息時看時間: 收到的比對 update 的 `message.date` 是否正好等於紀錄的時間 (到秒), 送出的比對 `outbound` 紀錄的時間是否在 2 分鐘內; 還是判斷不了 (完全沒有紀錄) 就標 `legacy` 歸給第一隻 bot (原本唯一的那隻). 第一版回填 (沒有時間規則) 標成 legacy 的列, 升級時用時間規則重新判斷一次 (migration `messages-legacy-by-time-2026-10`, 會跟該 bot 自己同號的列衝突的就保留原狀). 被當成重複丟掉的訊息一律在 router log 寫一行. `import-v1 <messages.db> [--bot <名稱>]` 匯入的訊息歸給第一隻 bot 或 `--bot` 指定的.

## 廣播頻道

廣播頻道目前不支援: 頻道貼文 (`channel_post`, `edited_channel_post`) 只寫進 events, 不建立對話也不送 worker (頻道裡的 `/router`, `/secret`, `cc /` 一樣不處理). bot 被加入頻道時通知 owner (重要通知話題, 沒有審核群組就私訊), 說明尚未支援並請有實際應用場景的人到 GitHub issues (https://github.com/Cojad/cc-telegram-router/issues) 提交使用情境與需要的功能.
