# 架構與運作方式

Telegram 對話分流: 一隻 router 接 bot 的所有訊息, 每個 Telegram 對話交給一個獨立的 Claude Code 背景 session (`claude --bg`), 各自住在 `<home>/bot<id>/<對話>/` 自己的資料夾 (`<home>` 是 router 的家目錄, 安裝位置可自選, 見 [部署與維運](operations.md#安裝位置)), 權限依角色分開設定.

[README](../README.md) 的文件索引列出所有文件.

## 結構

| 目錄 | 內容 |
|---|---|
| `router/` | router 本體. `main.ts` 組裝; `config.ts` `lock.ts` `db.ts` `conversations.ts` `settings.ts` `supervisor.ts` `ipc.ts` `guard.ts` `commands.ts` `context.ts` `progress.ts` `relay.ts` `rotate.ts`; `reactions.ts` 表情回應的篩選與累積; `detect.ts` `rawvault.ts` 原始事件與密鑰保護 |
| `router/` (權限) | `permcheck.ts` 依角色檢查工具呼叫; `elevation.ts` 擋下, 提權詢問, 提權紀錄; `grants.ts` 跨對話傳訊申請; `pkgreview.ts` `packages.ts` 套件安裝審核; `classifier.ts` 工具呼叫分類器 (第一階段, 只記錄); `approvals.ts` 審核群組與通知, 三選一按鈕; `authz.ts` 已核准授權的撤銷與使用紀錄; `credentials.ts` 跨 bot 技能的憑證; `skills.ts` 技能安裝範圍; `setup.ts` 新 bot 初次設定 |
| `router/telegram/` | 收發 Telegram 的模組 (沿用 v1 plugin): `transport.ts` `inbound.ts` `policy.ts` `outbound.ts` `store.ts` `format.ts` `rich.ts` |
| `plugin/` | worker 載入的 Telegram plugin v2 (消費者模式): 不持有 token, 透過 unix socket 跟 router 收發. `skills/doc` (/telegram:doc 使用說明), `skills/format` (/telegram:format 排版規則), `skills/bot-skill` (/telegram:bot-skill 建立技能與憑證的 SOP) |
| `hooks/` | worker 的 hook (`cc-hook`): 進度事件, 權限檢查與提權, 壓縮後補回 chat_context |
| `shared/` | router 與 plugin 共用的協定 (`protocol.ts`), 工具定義 (`tools.ts`), 找 router 的位置檔 (`locate.ts`), hook 從 prompt 取出 channel 標籤的發話者欄位 (`prompttags.ts`) |
| `templates/` | 各對話 settings 的範本 (`base-settings.json`, `roles/<角色>.json`), 共用 CLAUDE.md 範例 (`CLAUDE.md.example`) |
| `scripts/` | `cc /status`, `cc /usage`, `cc /context` 的報表腳本 (`deploy/install.sh router` 裝到 `<stateDir>/scripts`) |
| `deploy/` | `install.sh` 與 systemd user unit |
| `docs/` | 技術文件 (本檔與其他主題, 見 README 的文件索引) |

## 運作方式

1. router 輪詢 bot (getUpdates), 每個 update 寫進 `router.db` 的 `events`; 含密鑰的存遮蔽版, 原文加密存在 `event_raw` (見 [密鑰](secrets.md#原始事件與密鑰保護)).
2. 沿用 v1 的 gate (配對, 允許清單, 群組 mention) 決定要不要送進 Claude. 要送的訊息依 (bot, chat_id) 對應到對話, 第一次出現時建立資料夾與 settings.
3. 訊息進該對話的佇列. worker 不在線就喚醒: 第一次用 `claude --bg` 帶一句 init prompt 開新 session, 之後用 `--resume`.
4. worker 的 plugin 讀 `CLAUDE_PROJECT_DIR` 知道自己是哪個對話, 從位置檔 (`~/.config/cc-telegram-router/router.json`) 找到 `router.sock` 連上報到, 收到佇列裡的訊息後轉成 channel 通知並回 ack. router 投遞時在 meta 加上發話者角色與一個隨機的 `delivery` 標記; 一輪開始時 prompt hook 把 channel 標籤的發話者欄位送回來, router 重啟後就靠它對照自己的投遞紀錄認出這一輪的發話者 (見 [這一輪的發話者](permissions.md#權限檢查與提權)).
5. 模型呼叫 reply 等工具時, plugin 把呼叫轉給 router; router 檢查目標與附件路徑後代為呼叫 Bot API, 每個呼叫寫進 `outbound`. 群組的 worker 可以不經申請回到提問者的私訊: reply 帶 `on_behalf_of` (提問的那則群組訊息), router 確認發送者就是目標才放行, 不限時間, 私訊開頭標明來自哪個群組與哪則訊息.
6. 每個工具呼叫在 PreToolUse 由 hook 問 router, router 依對話角色的 settings 檢查, 越權就擋下, 發話者角色較高時在對話裡詢問提權 (細節見 [權限, 提權與審核](permissions.md#權限檢查與提權)). 已核准的提權與綁定的 subagent 存在 `router.db` 的 `elev_binds`, 綁定 worker 程序, router 重啟後同一個 worker 回來仍有效. router 重啟中連不到時, PreToolUse 與 SubagentStart 的 hook 照時間表重試最多 45 秒 (見 [router 連不到時](permissions.md#router-連不到時)).
7. 「cc /指令」由 router 開一次性的 tmux (`claude attach`) 代打: router 指令直接執行; `/status` `/usage` `/context` `/cost` 有專用報表; 其他指令只取它的輸出交給分身整理; `cc //指令` 直接截當下畫面. 離開前一律關掉留下的選單.
8. power 對話的套件安裝 (pip, npm, bun...) 由 router 查 registry 資料後交給模型判斷風險, low 直接放行, 其餘送 owner 審核 (細節見 [權限, 提權與審核](permissions.md#套件安裝審核)).
9. 叫醒 worker 時 router 計算 plugin (`server.js`, `skills/`) 與它看得到的三個技能範圍的雜湊, 記在對話的 `.chat/tools.sha`. 接續舊 session (resume) 而雜湊變了 (部署 plugin, 安裝技能), 下一則訊息的 `<router_log>` 附一次提醒, 請它重新讀取技能 SOP 與工具說明 (`router/freshness.ts`). 新 session 不用提醒.
10. 表情回應 (message reaction) 不直接送 worker: router 依對話的設定 (`all`, `botself_only`, `disable`) 篩選後累積, 附在下一則訊息前面, 或最後一個表情之後一分鐘沒有動靜時單獨送出; router 停止時先把還沒送的全部單獨送出再結束 (細節見 [部署與維運](operations.md#表情回應-reaction)).
11. `/router` 指令裡的 `chat_id` 指這隻 bot 的對話, `--bot <名稱>` 指別隻; 對話 key (`router-dm-123`) 到處都能用. 終端機 CLI 會找所有 bot, 多隻都有時列出候選並要求 `--bot`, 不會默默挑一隻.

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

## 回覆與附件

worker 的 reply 帶 `files` 時 (`router/telegram/outbound.ts`):

- 副檔名 `.jpg` `.jpeg` `.png` `.gif` `.webp` 當照片送 (sendPhoto, 有預覽), 其他當文件送 (sendDocument). 每個檔最大 50 MB.
- 文字放得進 Telegram 的 caption 上限時, 當成第一個檔的 caption, 只送一則 (不再先送一則文字再送檔案). 上限是官方文件的「0-1024 characters after entities parsing」: 以 UTF-16 code unit 計 (與 MessageEntity 相同, emoji 多半算 2), `markdownv2` 時算 Telegram 解析後顯示的文字, 跳脫的反斜線, 粗體斜體等標記, 連結網址與引用開頭的 `>` 不算. 這是 router 的估算; 萬一 Telegram 仍回 `message caption is too long` (此時什麼都還沒送出), 自動改用下一點的方式送.
- 文字超過上限: 先把完整的文字照原本的規則送出 (超過 4096 字依 `textChunkLimit` 與 `chunkMode` 切段, 第一段接 `reply_to`), 再送檔案, 檔案不帶 caption. 不採「檔案帶前段 caption, 剩下的另外補送」: 那樣要在 1024 字附近切開文字, 容易切斷句子或 `markdownv2` 的粗體, 程式碼區塊與連結 (切開的標記 Telegram 會整則拒收), 讀者還得在檔案下方與下一則之間接著讀; 先送文字則文字完整, 檔案緊接在後.
- 多個檔: 用 sendMediaGroup 送成相簿 (一組 2~10 個). 照片與照片一組, 文件與文件一組 (Telegram 規定文件只能與文件同組, 所以照片與文件一定分開), 各類依它第一個檔在 `files` 裡出現的順序先後送, 同類保持原順序; 同類超過 10 個時每 10 個一組, 某類只有 1 個 (或分組後剩 1 個) 就單獨用 sendPhoto / sendDocument. caption 放在第一組的第一個檔.
- `format` 是 `markdownv2` 時 caption 一樣帶 `parse_mode: MarkdownV2` (相簿只有帶 caption 的那一項帶). 跳脫照舊由 worker 負責 (`/telegram:format`); Telegram 拒收 (`can't parse entities`) 時錯誤回給 worker, 此時 caption 所在的訊息沒有送出, worker 改用 `text` 整則重送即可.
- `reply_to`: 檔案 (含相簿) 照舊接在 `reply_to` 下, `replyToMode` 是 `off` 時不接. sendMediaGroup 不支援按鈕; reply 本來就沒有按鈕.
- 文字是空的只送檔案. 沒有 `files` 時與以前完全相同.
- 每則送出的訊息都以 Telegram 回傳的 id 寫進訊息紀錄: 檔案記 `(photo: <路徑>)` 或 `(document: <路徑>)`, 帶 caption 的那則下一行接著文字.
- 回給 worker 的結果: 沒有檔案時照舊 (`sent (id: N)`, `sent N parts (ids: ...)`); 有檔案時寫明送了幾則與內容, 例如 `sent 1 message (id: 501): 1 photo with the text as the caption`, `sent 3 messages (ids: ...): an album of 3 photos with the text as the caption of the first photo`, `sent 2 messages (ids: ...): the text, then 1 photo (the text is over the 1024-character caption limit, so it went as its own message first)`. 相簿的每個檔各算一則 (各有自己的 id). 失敗時寫明失敗前已送出幾則.

## 廣播頻道

廣播頻道目前不支援: 頻道貼文 (`channel_post`, `edited_channel_post`) 只寫進 events, 不建立對話也不送 worker (頻道裡的 `/router`, `/secret`, `cc /` 一樣不處理). bot 被加入頻道時通知 owner (重要通知話題, 沒有審核群組就私訊), 說明尚未支援並請有實際應用場景的人到 GitHub issues (https://github.com/Cojad/cc-telegram-router/issues) 提交使用情境與需要的功能.
