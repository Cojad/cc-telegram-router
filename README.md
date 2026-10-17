# cc-telegram-router

Telegram 對話分流: 一隻 router 接 bot 的所有訊息, 每個 Telegram 對話交給一個獨立的 Claude Code 背景 session (`claude --bg`), 各自住在 `/x/cc/bot<id>/<對話>/` 自己的資料夾, 權限依角色分開設定.

## 結構

| 目錄 | 內容 |
|---|---|
| `router/` | router 本體. `main.ts` 組裝; `config.ts` `lock.ts` `db.ts` `conversations.ts` `settings.ts` `supervisor.ts` `ipc.ts` `guard.ts` `commands.ts` `context.ts` `progress.ts` `relay.ts` `rotate.ts`; `detect.ts` `rawvault.ts` 原始事件與密鑰保護 |
| `router/` (權限) | `permcheck.ts` 依角色檢查工具呼叫; `elevation.ts` 擋下, 提權詢問, 提權紀錄; `grants.ts` 跨對話傳訊申請; `pkgreview.ts` `packages.ts` 套件安裝審核; `classifier.ts` 工具呼叫分類器 (第一階段, 只記錄); `approvals.ts` 審核群組與通知, 三選一按鈕; `authz.ts` 已核准授權的撤銷與使用紀錄; `credentials.ts` 跨 bot 技能的憑證; `skills.ts` 技能安裝範圍; `setup.ts` 新 bot 初次設定 |
| `router/telegram/` | 收發 Telegram 的模組 (沿用 v1 plugin): `transport.ts` `inbound.ts` `policy.ts` `outbound.ts` `store.ts` `format.ts` `rich.ts` |
| `plugin/` | worker 載入的 Telegram plugin v2 (消費者模式): 不持有 token, 透過 unix socket 跟 router 收發. `skills/doc` (/telegram:doc 使用說明), `skills/format` (/telegram:format 排版規則), `skills/bot-skill` (/telegram:bot-skill 建立技能與憑證的 SOP) |
| `hooks/` | worker 的 hook (`cc-hook`): 進度事件, 權限檢查與提權, 壓縮後補回 chat_context |
| `shared/` | router 與 plugin 共用的協定 (`protocol.ts`) 與工具定義 (`tools.ts`) |
| `templates/` | 各對話 settings 的範本 (`base-settings.json`, `roles/<角色>.json`), 共用 CLAUDE.md 範例 (`CLAUDE.md.example`) |
| `deploy/` | `install.sh` 與 systemd user unit |
| `docs/v1/` | v1 (單一 session plugin) 時期的文件, 僅供參考 |

## 運作方式

1. router 輪詢 bot (getUpdates), 每個 update 寫進 `router.db` 的 `events`; 含密鑰的存遮蔽版, 原文加密存在 `event_raw` (見「原始事件與密鑰保護」).
2. 沿用 v1 的 gate (配對, 允許清單, 群組 mention) 決定要不要送進 Claude. 要送的訊息依 (bot, chat_id) 對應到對話, 第一次出現時建立資料夾與 settings.
3. 訊息進該對話的佇列. worker 不在線就喚醒: 第一次用 `claude --bg` 帶一句 init prompt 開新 session, 之後用 `--resume`.
4. worker 的 plugin 讀 `CLAUDE_PROJECT_DIR` 知道自己是哪個對話, 連 `router.sock` 報到, 收到佇列裡的訊息後轉成 channel 通知並回 ack.
5. 模型呼叫 reply 等工具時, plugin 把呼叫轉給 router; router 檢查目標與附件路徑後代為呼叫 Bot API, 每個呼叫寫進 `outbound`. 群組的 worker 可以不經申請回到提問者的私訊: reply 帶 `on_behalf_of` (提問的那則群組訊息), router 確認發送者就是目標才放行, 不限時間, 私訊開頭標明來自哪個群組與哪則訊息.
6. 每個工具呼叫在 PreToolUse 由 hook 問 router, router 依對話角色的 settings 檢查 (`permcheck.ts`). 越權就擋下並告訴模型改用不越權的方法 (Claude Code 把太長的工具結果存在 `~/.claude/projects/<對話>/<session>/tool-results/`, 非 owner 角色都能讀自己對話的這些檔; 只有唯讀指令白名單的角色, 用 `>` `>>` 等重導向寫檔, 或 `sort -o`, `uniq 輸入 輸出` 這類用選項寫檔也算越權, 跟 Claude Code 一致; 比對白名單時指令依 `&&` `||` `|` `;` 與換行切段, 引號裡與跳脫的字元不算, 所以 `grep -E 'a|b'` 是一個指令); 發話者角色高於對話時, 直接在對話裡貼出「提權執行 / 拒絕」詢問 (120 秒未回應視為拒絕). 發話者綁在那一輪: 在 worker 終端機打的一輪 (prompt hook 沒有 Telegram 訊息) 沒有發話者, 只看對話角色, 不在對話裡詢問, 到下一則 Telegram 訊息開始的那一輪為止. 按下的人角色夠高才算數, 之後的第一個 subagent 以他的角色執行.
7. 「cc /指令」由 router 開一次性的 tmux (`claude attach`) 代打: router 指令直接執行; `/status` `/usage` `/context` `/cost` 有專用報表; 其他指令只取它的輸出交給分身整理; `cc //指令` 直接截當下畫面. 離開前一律關掉留下的選單.
8. power 對話的套件安裝 (pip, npm, bun...) 由 router 查 registry 資料後交給模型判斷風險, low 直接放行, 其餘送 owner 審核. 指令解析認得各工具帶值的選項 (例如 `--only-binary :all:`, `--target pydeps`, `--omit dev`), 值不算套件; 帶了改變來源的選項 (`-i`/`--index-url`, `--extra-index-url`, `-f`/`--find-links`, `--trusted-host`, `--registry`...) 時, 那筆安裝的每個套件都列成自訂來源項目「<套件> (來源 <url>)」, 不查 PyPI/npm 的資料, 一律送人審. 從 URL, 本機路徑安裝與 `-e` 安裝也一樣. 這些項目核准 (允許一次或永久允許都一樣) 只放行下一次完全相同的安裝, 不寫任何權限覆寫, 之後再裝仍要審核 (審核訊息會說明原因; owner 用 `/router perm` 手動加的 `other:` 覆寫仍有效); `uvx --from`, `--with`, `pipx run --spec`, `npx -p` 的值是套件, 這時後面的第一個字是指令.
9. 叫醒 worker 時 router 計算 plugin (`server.js`, `skills/`) 與它看得到的三個技能範圍的雜湊, 記在對話的 `.chat/tools.sha`. 接續舊 session (resume) 而雜湊變了 (部署 plugin, 安裝技能), 下一則訊息的 `<router_log>` 附一次提醒, 請它重新讀取技能 SOP 與工具說明 (`router/freshness.ts`). 新 session 不用提醒.
10. `/router` 指令裡的 `chat_id` 指這隻 bot 的對話, `--bot <名稱>` 指別隻; 對話 key (`router-dm-123`) 到處都能用. 終端機 CLI 會找所有 bot, 多隻都有時列出候選並要求 `--bot`, 不會默默挑一隻.
11. 廣播頻道目前不支援: 頻道貼文 (`channel_post`, `edited_channel_post`) 只寫進 events, 不建立對話也不送 worker (頻道裡的 `/router`, `/secret`, `cc /` 一樣不處理). bot 被加入頻道時通知 owner (重要通知話題, 沒有審核群組就私訊), 說明尚未支援並請有實際應用場景的人到 GitHub issues (https://github.com/Cojad/cc-telegram-router/issues) 提交使用情境與需要的功能.
12. 時間一律 GMT+8, 不出現 UTC 或 Z: router 的 log 每行開頭是 `2026-10-17 08:06:04.919+08:00`, 交給 worker 的訊息時間 (`<channel ts=...>`) 是 `2026-10-17T08:06:04.919+08:00`, 指令輸出, 通知, router_log 與報表顯示的時間都換算成 GMT+8 (`shared/time.ts`, `router/context.ts` 的 `gmt8`). router.db 與訊息紀錄裡存的仍是 UTC 的 ISO 時間 (比較與查詢用), 顯示時才換算.
13. 訊息紀錄 (`router.db` 的 `messages`, `lookup_message`, 回覆引用的補全, `/router log` 讀的那份) 每一筆屬於一隻 bot, 以 (bot, chat_id, message_id) 為唯一鍵, 每隻 bot 只讀寫自己的. 同一個人私訊兩隻 bot 時各自從 1 編號, 群組裡兩隻 bot 收到的是同一個編號, 以前只看 (chat_id, message_id) 會把另一隻 bot 的訊息當成重複而靜默丟掉, 引用也可能拿到另一隻 bot 的訊息. 加欄位前的舊紀錄只在升級時分配一次: 那個 chat 只有一隻 bot 有對話就歸它, 否則看 `events` (收到的) 或 `outbound` (送出的) 是哪隻 bot; 兩隻 bot 都有同號的訊息時看時間: 收到的比對 update 的 `message.date` 是否正好等於紀錄的時間 (到秒), 送出的比對 `outbound` 紀錄的時間是否在 2 分鐘內; 還是判斷不了 (完全沒有紀錄) 就標 `legacy` 歸給第一隻 bot (原本唯一的那隻). 第一版回填 (沒有時間規則) 標成 legacy 的列, 升級時用時間規則重新判斷一次 (migration `messages-legacy-by-time-2026-10`, 會跟該 bot 自己同號的列衝突的就保留原狀). 被當成重複丟掉的訊息一律在 router log 寫一行. `import-v1 <messages.db> [--bot <名稱>]` 匯入的訊息歸給第一隻 bot 或 `--bot` 指定的.
14. 輪詢由 router 自己做 (`poller.ts`, 不用 grammY 的 bot.start), 啟動 (getMe) 與之後收訊都套用同一套規則: 網路錯誤與 Telegram 5xx 以 5 秒, 10 秒, 30 秒, 1 分, 2 分, 5 分逐步拉長, 之後每 5 分鐘一直重試 (429 照 retry_after); 斷線超過 2 分鐘才通知 owner 一次, 恢復時再通知一次. 409 衝突 (別的程式在用這個 token 收訊息) 每 60 秒重試並立刻通知. 401 (token 失效) 不再重試, 立刻通知 owner 用 `/router bot rotate`. 通知經其他還正常的 bot 送到它的重要通知話題或 owner 私訊; 409 與恢復通知也可以由那隻 bot 自己送 (409 只停收訊, 送訊息仍正常, 所以只有一隻 bot 時也收得到); 沒有 bot 送得出去, 或沒有 owner 與審核群組時只記 log. `/router status` 每隻 bot 後面標狀態: 收訊中, 重試中 (從幾點開始, 原因), token 失效.
15. `/router` 指令的回覆遇到網路錯誤, Telegram 5xx 或 429 (照 retry_after) 時, 第一次送出後 1 分鐘內最多再試 3 次 (間隔 2 秒, 5 秒, 15 秒; `sendretry.ts`), 其他 4xx 不重試, 最後還是失敗就在 router log 記一行.

### 目錄

```
/x/cc/CLAUDE.md                 共用規則 (FORCED / GENERAL / Default suggestions 三層)
/x/cc/bot<id>/CLAUDE.md         該 bot 的人設 (初次設定訪談產生)
/x/cc/bot<id>/<type>-<chat>/    一個對話: CLAUDE.md, memory/, attachments/, .chat/
/x/cc/.router/                  router 執行檔, config.json, access.json, router.db, sessions/ (各對話 settings)
```

Claude Code 從工作目錄往上讀 CLAUDE.md, 三層自然疊加. bot 資料夾以 Telegram bot id 命名, 換 token 不會變. 舊版放在 `/x/cc/<對話>/` 的資料夾, router 啟動時會先停掉該 worker, 連同 `~/.claude/projects` 的對話紀錄搬進 bot 資料夾.

### 審核按鈕, 撤銷, 執行授權

- 申請 (跨對話傳訊, 套件安裝, 提權) 都是「允許一次 / 永久允許 / 拒絕」 (跨對話傳訊的允許一次叫「允許這個對話」: 之後這個對話都可以傳到那裡; 已存在的覆寫不受影響), 申請訊息寫明永久允許的範圍: 跨對話是 `send *` (可送往 bot 所在的任何對話), 套件是 `pkg *` (PyPI 與 npm 不用審核, URL 與自訂來源仍審核), 提權是把被擋的那類動作寫成權限覆寫 (`Bash(python3)` 與 `Bash(python3 *)` 一對, 不帶參數的 `hostname` 這類指令也涵蓋; 讀寫某個資料夾, 某個工具或 MCP); 跳出 sandbox 與重導向寫檔不能永久允許.
- 申請有了結果後, worker 處理結果的那一輪, 進度回覆當初提出申請的那則訊息; 在其他地方按下按鈕時, 那裡也同步一份進度 (開頭標明對話). 在 worker 終端機打的那一輪提出的申請 (跨對話傳訊, 套件審核, 提權) 沒有對應的 Telegram 訊息, 結果不回覆任何訊息, 也不會綁到上一則.
- 允許過的申請在審核群組留「🚫 撤銷」按鈕. 每一次動用已核准的權限都記在 `auth_uses` 與「🧾 執行授權」話題, 附工具呼叫內容與撤銷按鈕. 撤銷會移除權限覆寫 (一對 Bash 規則一起移除), 丟掉尚未使用的提權, 輪替 worker 並通知它; 授權出現過的每則訊息 (申請的每一份, 每次使用, 提權紀錄話題裡那則「✅ 提權成功」) 都拿掉按鈕並標「🚫 已撤銷」.

### 技能與憑證

- 技能範圍: `/x/cc/.claude/skills` (全部 bot), `/x/cc/bot<id>/.claude/skills` (一隻 bot), 對話資料夾的 `.claude/skills` (單一對話). worker 寫不進任何 `.claude` (Claude Code 內建保護, 只有 owner 對話例外), 所以技能先寫在對話資料夾的 `skills/<名稱>/`, 再用 `install_skill` 由 router 複製: scope `conversation` (power 以上) 裝到該對話的 `.claude/skills`, `bot` 與 `all` (owner 與 admin) 裝到前兩個範圍; 角色不夠時跟其他越權動作一樣走提權. router 會拒絕含 token 或符號連結的技能.
- 跨 bot 技能需要的 token 存在 `config.json` 的 `credentials` (token, 允許的方法, 允許的角色), 由 owner 或 admin 在私訊用 `/router cred add` 登記 (訊息會被刪), 或在終端機用 `cc-telegram-router cred-import <名稱> <檔案> <變數> [方法,...]` 從檔案搬進來. worker 用 `bot_api` 工具使用, 看不到 token; owner 在終端機可用 `cc-telegram-router cli botapi`. 對話角色不在憑證允許的角色 (含 `self`) 時跟其他越權動作一樣擋下並走提權 (發話者角色較高就在對話裡詢問, 只能允許一次); 憑證不存在或方法, 路徑沒開放則直接拒絕.
- 一般 API key (例如 OpenAI) 也存成憑證, 種類 http: `cred-import <名稱> <檔案> <變數> <路徑,...> --http <網址>`, worker 用 `http_api`, 回應裡的 base64 可直接存成對話資料夾裡的檔案. 路徑先擋掉 `..`, `.`, `%2e`, 編碼過的 `/` 與 `\`, `#` 再比對前綴 (fetch 會把 `/v1/images/../files` 解析成 `/v1/files`), 對話密鑰也一樣. `bot_api` 與 `http_api` 的回應若回顯了 token 或 key (例如回聲 API), router 先遮蔽成 `<密鑰>` 才交給 worker.
- 放在 bot 或全部 bot 範圍的技能, sandbox 裡的角色可以讀與執行, 不能改.
- owner 與 admin 的對話用 `bot_api` 的 credential `self` 以這隻 bot 自己的身分呼叫任何 Bot API (getUpdates, setWebhook, deleteWebhook, logOut, close 除外).
- 特權技能 (技能的 sudo bit): 技能帶 `privileged.json` 列出動作, owner 或 admin 以 `/router skill approve` 核准 (記下檔案雜湊, 改了自動暫停). 對話用 `run_skill` 呼叫, router 以 bwrap 專屬沙箱執行: 只讀技能與憑證資料夾 (`/x/cc/.router/creds/`), 只寫對話資料夾, 隱藏 /x 其他部分與 $HOME; 輸出掃描憑證內容; 憑證被拒時執行 internal 的更新動作一次再重試; 每個對話每小時 10 次. 動作可以帶 http API 憑證 (`http`, 腳本拿到授權標頭的環境變數, key 會從輸出遮蔽); 單一參數可以限定角色 (`args.<名稱>.roles`), 較低角色帶這個參數就照一般流程觸發提權申請. 每天固定時間 (config `skillRefreshAt`, 預設 `"05:00"` GMT+8, `"off"` 關閉) router 對所有已核准技能執行一次被 `refresh` 指到的 internal 動作 (同樣的沙箱, 掛載, env 與雜湊檢查, 在 `/x/cc/.router/skill-refresh/<技能>/` 執行), 讓 cookie 不會放到過期: 雜湊不符就略過並通知 owner, 失敗通知 owner (輸出遮蔽憑證), 成功只記在 router log 與 `skill_runs` (對話欄位 `router:refresh`, 不算進任何對話每小時 10 次的限額). router 啟動一分鐘後補跑: 上次成功的每日更新超過 24 小時 (或從沒成功過) 的技能執行一次, 之後照每天的時間; 每次執行依序排隊, 不會重疊.
- worker 端的 SOP 在 `/telegram:bot-skill`.

### 對話專屬密鑰

- 任何角色的對話都能有自己的 token 或 API key, 不用提權: 在那個對話傳 `/secret set <名稱> <值> [方法...]` (Telegram bot token, 沒寫方法就是全部) 或 `/secret set <名稱> <值> --http <網址> [--header <標頭>] [--scheme <前綴>] [路徑...]` (一般 API key, 結尾 `*` 代表前綴, 沒寫路徑就是全部). 也可以用 `cc /secret ...`.
- bot token 登記前一律用 getMe 驗證, getMe 不接受的值不會存 (沒有略過的開關).
- API key 預設以 `Authorization: Bearer <key>` 送出; `--header x-api-key` 改放進那個標頭且不加前綴, `--scheme Token` 改前綴, 兩個可以一起用. 對應全域 http 憑證在 config.json 的 `header` 與 `scheme` 欄位, 意思相同. Host, Content-Type, Cookie 這類標頭不能用.
- router 自己處理, 不轉給 worker. 私訊裡立刻刪掉那則訊息; 群組裡任何成員都能登記 (不看角色, 但要是 bot 有開放的群組與發話者), bot 有刪除權限就刪, 沒有就回覆提醒發送者自己刪.
- 值以 AES-256-GCM 加密存在 `router.db` 的 `conv_secrets` (綁定 bot, 對話, 名稱), 金鑰是 `config.json` 的 `secretKey`, 沒有就在啟動時自動產生. 每個對話最多 20 把, 每把最長 4096 bytes; 名稱 `self` 保留, router 自己的 bot token 不能登記.
- 值不會出現在任何對話: router_log 與回覆引用那則訊息時換成 `<已遮蔽>`, 工具回應裡出現的值換成 `<密鑰>`. events 表裡 `/secret set`, `/router cred add`, `/router bot add|rotate` 的值換成 `<已遮蔽 #<event id>.<序號>>`, 原文加密存在 `event_raw` (見「原始事件與密鑰保護」); 10e 之前已記下的 update 在啟動時遮蔽一次 (migrations 表記 `mask-command-tokens-2026-10`, log 只印筆數), 那些原文沒有保留.
- worker 照樣用 `bot_api` / `http_api`, credential 填名稱: 先找這個對話自己的密鑰, 再找全域憑證. 不檢查角色, 群組裡也不需要授權 (不進「執行授權」話題), 只檢查登記時的方法或網址與路徑 (路徑不能含 `..` 等). 每次使用記在 `outbound` (bot 欄 `secret:<名稱>`); 回應裡過長的字串截斷, base64 可用 `save_b64` 存進對話資料夾.
- 管理: `/secret list` (只列名稱, 種類, 範圍), `/secret rm <名稱>`; owner 與 admin 用 `/router secret list [chat_id]` (不寫就列出所有有密鑰的對話) 與 `/router secret rm <chat_id> [名稱]` (不寫名稱就全部移除).

### 原始事件與密鑰保護

- 每個 update 的所有字串 (文字, 圖片說明, 編輯後的訊息, 按鈕資料, 被引用的訊息) 都會掃描 (`router/detect.ts`): 一眼可認的格式 (Telegram bot token, OpenAI `sk-`, Anthropic `sk-ant-`, GitHub `ghp_` 與 `github_pat_`, AWS `AKIA`, Google `AIza`, Slack `xox`, PEM 私鑰), 登記指令 (`/secret set`, `/router cred add`, `/router bot add|rotate`) 的值, 以及 router 持有的值 (自己的 bot token, 全域憑證, 對話密鑰; 完全比對, 8 字元以上). 不做「看起來很亂就算密鑰」的猜測.
- 偵測到時 `events` 存遮蔽版: 值換成 `<已遮蔽 #<event id>.<序號>>` (同一個值同一個序號), `masked` 設為 1. 原始 update 以 AES-256-GCM 加密存在 `event_raw` (沿用 `secretKey`, 綁定 event id, 搬到別列解不開), 連同遮了哪些欄位, 種類, 指紋 (末 4 碼, sha256 前 8 碼) 與等於哪個已登記的值. 沒有明文欄位, dump 或備份都看不到值.
- 送進 worker 與存進 messages 表 (`lookup_message` 讀的那份) 的內容同樣換掉, 附種類與末 4 碼: `<已遮蔽 #12.1: Telegram bot token, 末 4 碼 a1B2>`.
- 每次偵測記在 router.db 的 `secret_log` 與審核群組的第五個話題「🔑 密鑰偵測」(沒有審核群組就私訊 owner): 對話, 發送者, 種類與末 4 碼 (等於哪個已登記的值), 欄位, event id, 處理結果. 已設定的審核群組在 router 啟動時自動補建這個話題, `/router setup group` 也會補.
- router 服務的對話 (允許的私訊與群組) 裡, 發送者自己的訊息 (不算被引用的) 含密鑰時, router 回覆那則訊息提醒, 5 分鐘後刪除; 提醒附「取消刪除」按鈕, 發送者, owner, admin 可以按. 排程存在 `secret_deletions`, router 重啟後照常執行 (停機期間到期的在啟動時刪). bot 沒有刪除權限時只提醒. 登記指令維持立刻刪除; 其他對話, 頻道貼文, 按鈕資料只記錄.
- 請求原文: 發話者或對話角色是 owner 或 admin 的那一輪 (在終端機 attach 進對話打字的那一輪沒有發話者, 只看對話角色), worker 呼叫 `event_raw(event_id, question, [ttl_minutes 或 permanent])`, 任何對話的 event 都可以 (含 owner 對話). router 解密, 把每個值換成代號說明, 例如 «密鑰 h7: Telegram bot token, getMe: @example_bot (123), 末 4 碼 a1B2, 跟全域憑證 eagle相同» (種類, getMe, 是否等於已登記的值都由程式填), 交給固定 system prompt, 沒有工具, 設定與 MCP 的 `claude -p` 回答 (模型是 config 的 `model`, haiku 一律拒絕). agent 從頭到尾看不到值.
- 出口檢查: router 對回答做完全比對 (這個 event 的值, 所有已登記的值) 與格式掃描, 有任何一項就整份擋下, 撤銷這次的代號, 記在話題並發重要通知給 owner. 這是程式保證, 不靠模型自律. 通過時 worker 拿到代號版 update 與回答.
- 代號 (`secret_handles`) 只在申請的對話有效, 預設 10 分鐘, 最多 60 分鐘, 或永久. `secret_from_handle(handle, name, scope)` 把代號登記成這個對話的密鑰 (scope 跟 `/secret set` 值後面的寫法一樣, bot token 用 getMe 驗證, 10b 的限制照樣適用), 之後用 `bot_api` / `http_api`, 每次使用都累計在代號的 uses. 查看與撤銷: 對話裡 `/secret handles`, `/secret revoke <代號>`; owner 與 admin 用 `/router secret handles [chat_id]`, `/router secret revoke <代號>`. 撤銷代號不會移除已登記的密鑰.
- 每次請求與登記記在「🔑 密鑰偵測」話題與 router.db: `secret_requests` (誰, 哪個對話, 哪個 event, 問題, 發出的代號, 結果), `secret_handles` (之後是否登記成密鑰, 使用次數).
- 明文只限 owner 的終端機: `cc-telegram-router cli event raw <id>` 把原始 update 寫進 `<stateDir>/raw/` (目錄 700) 底下權限 600 的檔案, 只印路徑, 由 owner 自己開檔; 也記在話題. Telegram 裡沒有取得明文的途徑, admin 與 Telegram 裡的 `/router event raw` 一律拒絕.
- 文字類附件: router 收到訊息時就檢查, 不等 worker 下載 (柯姊 2026-10-17). 服務中的對話 (允許的私訊與群組) 裡, 訊息或編輯後的訊息帶的文字檔 (`.txt` `.env` `.env.*` `.json` `.yaml` `.yml` `.ini` `.conf` `.cfg` `.toml` `.properties` `.md` `.csv`, 常見原始碼副檔名, 或 mime 是 `text/*`; 1 MB 以內) 立刻下載, 用同一套偵測 (不含 NUL 位元組的才掃). 偵測到時原檔存成 events 的一列 (`update_json` 是 `{"attachment": {file_id, 檔名, 對話, 原訊息, 內容}}`, 遮蔽版, `masked` 1), 原文加密存在 `event_raw`; 原訊息照上面的方式提醒並 5 分鐘後刪除, 「🔑 密鑰偵測」記下檔名 (收到時偵測). 下載結果 (有密鑰就是代號版, 沒有就是原檔) 存在 `<stateDir>/attachments/<bot>/` (權限 600, `attachment_cache` 表), worker 之後呼叫 `download_attachment` 直接沿用, 不重複下載; 還在下載中就等它完成. 保留 30 天 (以最後使用時間算, 每次沿用都重新起算), router 啟動時與每天清一次, 檔案與 `attachment_cache` 的列一起刪. 收到時沒有下載的 (引用的舊附件, 其他對話, 下載失敗) 在 worker 下載時用同樣方式檢查, 同一個檔案只記錄一次. `event_raw` 與 `cli event raw` 也適用這一列.
- 限制: 2026-10-17 已遮蔽的 5 筆舊紀錄原始值已覆寫, 救不回來, 這套只保護之後的資料; 圖片, 二進位檔, 超過 1 MB 的文字檔不偵測; 不認得的格式偵測不到, 已登記的值則一定比對得到.

### 工具呼叫分類器 (第一階段, 只記錄)

- 是什麼: 角色範本與 `permcheck.ts` 是程式規則, 表達不到「指令合法但目的可疑」這類情況. 分類器是另外問判斷型模型「這個工具呼叫該不該擋下交給人審核」. 第一階段五家並用: OpenAI Decisions API (`openai`), TypeSafe Jev (`typesafe`), Cloudflare Clef 27B (`clef`) 與 Clef Flash 9B (`clefflash`), 以及固定 prompt 的 `claude -p` (`claude`, 其他四家都跟它比), **結果只寫進 router.db, 不影響放行**, 用來比較速度, 結果與費用.
- 送哪些: 對話角色 user 與 power, PreToolUse 規則判斷後放行的呼叫 (含套件審核通過的安裝). 不送: owner 與 admin 對話, 規則擋下的, 提權 subagent 的呼叫.
- Telegram plugin 工具 (reply, react, edit_message, send_sticker, download_attachment, bot_api, http_api, run_skill...) 在 router 端執行, hook 看不到, 所以在 router 執行完且沒有錯誤 (router 的檢查都通過) 後判斷, 角色以這次呼叫實際使用的為準 (提權 subagent 帶 ticket 的不判斷). 只問人或只讀 router 狀態的 `get_chat_context`, `request_elevation`, `request_send_grant`, `save_bot_profile` 不判斷. 題目的說明改成「要送到 Telegram 的內容」, 重點是有沒有洩漏不該在那裡講的資料 (密鑰, 私人檔案, 其他對話或人, 系統內部) 或內容不恰當. config 的 `telegramTools: false` 可單獨關掉這一類.
- 不拖慢放行: hook 先回答, 判斷在背景跑. 每家同時最多 4 個 (claude 2 個), 等待超過 20 筆就略過那家 (busy); 逾時 15 秒 (claude 60 秒), 不重試. 任何錯誤只記錄.
- 外送內容 (每家同一份): 角色與說明, 對話類型, 觸發這一輪的使用者訊息 (遮蔽後前 500 字; 在 worker 終端機打字的那一輪沒有), 工具名稱與參數. hook 本來就只轉送 command, description, 路徑, pattern, url, query 這些欄位 (Write/Edit 的檔案內容不離開 worker), Telegram 工具則是整份參數 (例如要送出的文字). 訊息與參數先用 10e 的密鑰偵測遮蔽 (已知格式加 router 持有的 bot token, 全域憑證, 對話密鑰, 完全比對), 再把對話資料夾換成 `<conversation-folder>`, router home 換成 `<router-home>`, 家目錄換成 `~`, router 知道的 chat id (含群組 id 去掉負號的寫法) 換成 `<chat-id>`; 每個字串最多 1500 字, 整份最多 6000 字. 使用者的訊息不送.
- 題目 (英文, Jev 英文最準): (1) 是非題「該擋下交給人審核嗎」的機率 `p_block`; (2) 風險 4 級 (none, low, medium, high) 的加權分數 `risk` (0~3). Decisions 與 Jev 預設都走 OpenRouter 的 Decisions router (`POST https://openrouter.ai/api/alpha/decisions`, Jev 式請求: `state` 加 `questions` map, `noul` + `score`), 模型分別是 `openai/gpt-6-luna-decisions` 與 `typesafe/jev-1.13`; Clef 兩家也走同一個端點與同樣兩題, 模型 `cloudflare/clef` 與 `cloudflare/clef-flash` (OpenRouter 的文件說 Workers AI 會把太長的 state 截在約 2K tokens, 所以長的工具參數在 Clef 兩家可能只看到前段); claude 用固定 system prompt, 沒有工具, 設定與 MCP 的 `claude -p` (模型是 config 的 `model`, 含 haiku 就不跑), 只回 JSON.
- 紀錄: `classify_calls` (時間, 對話, 角色, 工具, 摘要, 實際外送的內容, 遮蔽數) 與 `classify_results` (每家一列: 實際模型版本, `ok` / `error` / `refusal` / `skipped`, 延遲 ms, `p_block`, `risk`, `confidence`, tokens, 費用, 說明或略過原因 `no-key` / `model` / `budget` / `busy`). 保留 30 天, 啟動時與每天清一次.
- 費用: 走 OpenRouter 時直接記回應的 `usage.cost` (OpenRouter 實際收的錢, 不自己換算; 回應沒有這欄就記 0 並在說明寫 `no usage.cost in the response`). 走 OrcaRouter (`api: "systemone"`, baseUrl 在 orcarouter.ai) 時, 請求帶 `X-OrcaRouter-Include-Cost: true`, 記回應的 `usage.cost_usd` (Orca 實際收的錢; 沒有就記 0 並註明), 回應標頭的 `X-Orca-Request-Id` 寫進說明, 事後可用 Orca 的 `GET /v1/generation?id=<id>` 對帳. 走原生路徑 (OpenAI `/v1/decisions`, TypeSafe `/v1/systemone`) 時才用 input tokens 乘單價 (Decisions $0.10 / 1M, Jev $0.042 / 1M, output 不收費). claude 走訂閱 (`claude -p`), 記的是它回報的 `total_cost_usd`, 這是 API 價格換算的估計, 不是實際支出; 報表標成「訂閱用量 (API 換算)」, 與實際費用分開. 每家每天 (GMT+8 日界) 上限預設 openai, typesafe, clef, clefflash 各 $0.5, claude $50 (以換算值計), 到了當天就停 (記 `budget`, router log 記一次).
- 金鑰與路徑: 每家由 `api`, `credential`, `model` 決定, router 自己呼叫 (worker 的路徑清單不用加任何路徑). 分類器用的憑證路徑與角色都留空, worker 用不到. 沒有憑證的那家記 `no-key`, 其他照跑.
  - `api: "openrouter"` (預設): 全域憑證 `openrouter` (baseUrl `https://openrouter.ai`), `POST <baseUrl>/api/alpha/decisions`. OpenRouter 帳號的允許供應商設定要包含 openai 與 typesafe.
  - `api: "openai"`: OpenAI 原生 `POST <baseUrl>/v1/decisions` (predicate + score, 模型 `gpt-6-luna`), 例如全域憑證 `openai`.
  - `api: "systemone"`: `POST <baseUrl>/v1/systemone` (noul + score). TypeSafe 原生是 `https://api.typesafe.ai` (模型 `jev-latest`); OrcaRouter 是 `https://api.orcarouter.ai` (模型 `typesafe/jev-1.13`, 2026-10-17 實測 `jev-latest` 在那裡沒有容量; Orca 沒有 Decisions).
- 開關與設定 (config.json): 選配功能, 預設關閉, 只有明確寫 `"classifier": {"enabled": true, ...}` 或 `"classifier": true` 才開; 沒寫, `{}`, 或區塊裡沒寫 `enabled` 都是關閉. 區塊格式錯 (型別不對, 負數, 不認得的 `api`) 時 router 照常啟動, 分類器關閉, router log 寫一行說明是哪個欄位. 開啟時啟動 log 列出兩家的 api 與模型.
- 每家需要什麼, 沒有就略過那一家 (記 `skipped`, 啟動時 log 一次, 其他家照跑, 工具呼叫的放行完全不受影響):
  - openai (Decisions), typesafe (Jev), clef, clefflash: 各自 `credential` 指定的全域憑證 (config.json 的 `credentials`), 預設四家都是 `openrouter`; 各自的 `enabled: false` 可單獨關掉那一家 (不跑也不留紀錄); 沒有這個憑證記 `no-key`.
  - claude: config 的 `claudeBin` 找得到 claude CLI (沒有記 `no-cli`), 且 `model` 不是 haiku (是的話記 `model`).
- 設定範例:

  ```json
  "classifier": { "enabled": true, "telegramTools": true, "dailyUsd": { "openai": 0.5, "typesafe": 0.5, "clef": 0.5, "clefflash": 0.5, "claude": 50 }, "clefflash": { "enabled": false }, "keepDays": 30 }
  ```

  (上例關掉 clefflash.) openai, typesafe, clef, clefflash 預設 `{ "enabled": true, "api": "openrouter", "credential": "openrouter" }` 與上面的模型, 每家每天上限預設 $0.5; Clef 兩家只能走 OpenRouter. openai 與 typesafe 也可改走原生, 例如 `"openai": { "api": "openai", "credential": "openai", "model": "gpt-6-luna" }`, `"typesafe": { "api": "systemone", "credential": "orcarouter", "model": "typesafe/jev-1.13" }`. 另可設 `usdPerMTok` (原生路徑的單價), 以及 `skipTools` (前綴比對, Telegram 工具寫全名 `mcp__plugin_telegram_telegram__<工具>`). 其他欄位沒寫就用預設值.
- 看結果 (只限 owner, 群組裡下會改私訊回覆): `/router classifier [天數]` (預設 7 天, 1~90; 終端機 `cc-telegram-router cli classifier 7`) 分「一般工具」與「Telegram 工具」兩類, 各列出每家的成功, 錯誤, 拒答, 略過, 延遲 p50/p95, 費用 (claude 是訂閱用量), 以 claude 為基準的一致率 (`p_block` 以 0.5 為界), `p_block` 與 `risk` 平均差, 每家一行 (這段期間沒跑的不列), 接著是實際費用 (有跑的 API 各家合計與各家金額) 與 claude 訂閱用量 (API 換算) 兩個合計, 以及最近 10 筆意見不同的; `/router classifier show <編號>` 看單筆 (含外送內容). 時間一律 GMT+8.
- 第二階段 (還沒做): 分類器只能把「規則放行」改成「擋下並走提權」, 只套用在 user 與 power, 連不上時照規則放行.

### bot 設定提醒

- `/router bot add` 與 `rotate` 等 getMe 完成才回覆, 之後馬上 `/router bot list` 就看得到新 bot. 某隻 bot 的資訊還沒取得時 (例如 router 剛啟動連不上 Telegram), `bot list` 與 `status` 顯示「讀取中」, getMe 照輪詢的重試規則 (運作方式 14) 重試到成功.
- 新增 bot (`/router bot add`), 新 bot 初次設定 (審核群組說明那則), `/router setup group` (設定成功或不符條件都附), 以及 bot 被加入群組時 (通知送到重要通知話題或 owner 私訊), router 會附上這隻 bot 的設定提醒.
- 群組隱私模式: 說明開啟與關閉的差別, 依 getMe 的 `can_read_all_group_messages` 顯示目前設定 (true 是關閉, 符合建議; 其他是開啟, 建議關閉), 關閉方式 (@BotFather `/setprivacy`). 重點一定寫出: 改完要把 bot 從群組移除再重新加入才生效; bot 是群組管理員就不受限制 (以管理員身分加入群組時不附這段).
- Bot-to-Bot Communication Mode (@BotFather 的設定): Bot API 的 getMe 沒有對應欄位, 查不到開了沒, 只附固定說明: 開與關的差別, 設定方式 (@BotFather `/setbot2bot` 或 BotFather Mini App), 以及風險 (router 不分辨發話者是人還是 bot, 其他 bot 的訊息與 /secret 這類指令會照常處理; 可能互相回覆停不下來).
- 兩段文字由柯姊定稿, 依她 review 草稿的標記加粗 (兩段的標題, 「開啟 (預設):」「關閉:」等清單開頭, 「關閉方式:」「設定方式:」「開啟的風險:」, 「兩件很重要的事:」與兩點的重點句; emoji, 目前設定那行與最後的建議段落不加粗), 以 parse_mode HTML 送出. 同一則訊息裡的其他文字, 以及帶入的群組名稱, bot 名稱一律做 HTML 跳脫, 名稱裡有 < > & 也送得出去; 萬一 Telegram 仍拒收 HTML (can't parse entities), 同一則改用純文字 (去掉標籤) 重送一次並記 log; 在終端機 CLI 下的指令印成純文字.

### 審核群組與新 bot 初次設定

- config 沒有 owners 時, router log 會印出一次性認領碼; 私訊 bot `/start <碼>` 的人成為 owner.
- owner 第一次私訊一隻還沒設定的 bot, worker 會先訪談名字, 個性, 說話風格, 用途, 用 `save_bot_profile` 寫進 `bot<id>/CLAUDE.md`.
- 接著引導設定審核群組: 開了話題的 supergroup, bot 是管理員且能管理話題, 在群組裡下 `/router setup group`. router 建立「🔔 重要通知」「🔐 權限審核」「📜 提權紀錄」「🧾 執行授權」「🔑 密鑰偵測」五個話題 (已設定的群組再下一次會補上缺的話題). 可以略過, 之後通知與申請都私訊 owner (提權紀錄只留在 router.db).
- 設定存在 `bot_setup`, 以 bot 名稱為 key, 並記下它屬於哪個 Telegram bot id (`bot_id`, 跟 `bot<id>` 資料夾一樣是 token 冒號前那段; 啟動時補上現有 bot 的 id). `/router bot add` 時, 同名的設定屬於同一個 bot id 才沿用 (舊紀錄沒有 id 時, 看 `bot<id>` 資料夾在不在): 已完成人設的話, 回覆說明沿用既有人設與審核群組 (或照舊私訊 owner, 或提醒審核群組還沒設定), 不會再說要做初次設定. 名稱給了另一隻 bot 就當新 bot, 設定重置, 回覆照新 bot 的初次設定. 啟動時也一樣: `config.json` 裡某個名稱的 token 換成另一隻 bot (紀錄的 `bot_id` 跟 token 的 id 不同), 那個名稱的設定重置, router log 留一行, 並通知 owner 哪個名稱換了 bot (先用那隻 bot 送, 送不到再用其他 bot). 要重做人設用 `/router setup persona`. `/router bot rotate` 只接受同一隻 bot 的新 token (bot 資訊還沒取得時用舊 token 的 id 比對).

## 部署

```bash
deploy/install.sh router   # 編譯到 /x/cc/.router/cc-telegram-router, 複製 templates
deploy/install.sh plugin   # 打包 plugin v2 到官方 plugin 快取路徑 (第一次會備份原內容)
deploy/install.sh unit     # 安裝 systemd user unit
systemctl --user enable --now cc-telegram-router
```

共用的 `/x/cc/CLAUDE.md` 可以從範例開始: `cp templates/CLAUDE.md.example /x/cc/CLAUDE.md`. worker 端的使用說明在 plugin 的 `/telegram:doc` skill (`plugin/skills/doc/SKILL.md`).

`/x/cc/.router/config.json` (權限 600) 與 `access.json` 要手動建立一次:

```json
{
  "bots": [{ "name": "cc", "token": "<bot token>" }],
  "home": "/x/cc",
  "stateDir": "/x/cc/.router",
  "owners": [],
  "model": "claude-opus-5-5",
  "autoCompactWindow": 750000,
  "claudeBin": "/home/<user>/.local/bin/claude",
  "skillRefreshAt": "05:00"
}
```

`owners` 可以留空, 用 log 裡的認領碼認領 (見上方). 套件審核用的模型就是 `model`. `skillRefreshAt` 是特權技能每日更新憑證的時間 (GMT+8 `"HH:MM"`, `"off"` 關閉, 不寫就是 `"05:00"`), 改了要重啟 router; 格式寫錯只會關閉每日更新並在 log 寫一行 `config.json: ...`, router 照常啟動. 沒有特權技能, 或技能沒有 refresh 動作時, 每日更新什麼都不做.

## 測試

```bash
bun test router/test
```

輸出裡以「✅ 預期中 (測試刻意模擬, 屬正確行為)」開頭的行, 是測試刻意製造的錯誤 (例如模擬 db locked, disk full, 重複的訊息), 用來驗證 router 遇到這些狀況仍正常運作, 不是真的錯誤.

| 檔案 | 對應 |
|---|---|
| `router/test/phase1.test.ts` | 規劃 03, 04, 05, 07 的模組行為: 對話資料夾, settings 範本, 佇列, 送出檢查, 單一實例, IPC, supervisor (含 resume 後的說明更新提醒 freshness), plugin MCP, router 離線告知 |
| `router/test/phase2.test.ts` | 規劃 03 的 /router 指令表與拒絕訊息 (含 chat_id 跨 bot 指定, --bot, 對話 key), 06 chat_context, router_log, hook, 「cc /」代打, 即時進度訊息, bot list 與 status 對資訊還沒取得的 bot 顯示讀取中, GMT+8 時間格式 (`iso8`, log 行) |
| `router/test/e2e.test.ts` | 真的 router + 假 Bot API: 每個 update 與送出的 payload 都在 db, 回覆送出與紀錄, 群組回到提問者的私訊 (on_behalf_of), /router 指令不轉給 worker, CLI, bot add 後立刻 bot list 就有新 bot 的資訊, log 行與 worker 收到的訊息時間是 GMT+8 |
| `router/test/phase3.test.ts` | 規劃 03, 07: 角色範本, /router perm, 權限檢查, 跨對話傳訊申請, 審核頻道, 提權 (詢問, 核准, 逾時, 主動申請, 紀錄), hook, bot 資料夾與搬遷 |
| `router/test/phase3-cred.test.ts` | 憑證的角色與方法限制, Bot API 呼叫 (含上傳), install_skill 的來源, 範圍與檢查, /router cred 與 botapi |
| `router/test/secrets.test.ts` | 規劃 10b 對話專屬密鑰: 加密與綁定, 遮蔽, /secret 指令 (私訊, 群組, 拒絕, 上限, getMe 驗證, --header), 使用範圍檢查, /router secret; events 遮蔽與一次性 migration, 全域 http 路徑, bot 設定提醒 |
| `router/test/e2e-secrets.test.ts` | 真的 router + 假 Bot API 與 HTTP API: secretKey 自動產生, 舊 events 遮蔽, 私訊登記與刪訊息, 群組登記與提醒, getMe 驗證, 引用遮蔽, http_api (含 --header) 與 bot_api 使用, 其他對話用不到, list / rm, 加入群組, 初次設定與 setup group 的設定提醒 |
| `router/test/rawvault.test.ts` | 規劃 10e 原始事件與密鑰保護: 偵測 (格式, 指令的值, 已登記的值, 不猜熵), 掃描範圍, event_raw 加密與綁定, events 遮蔽與 worker 代號, 🔑 話題紀錄, 提醒與 5 分鐘刪除 (取消, 誰能按, 沒權限, 重啟後), event_raw (角色, 代號, 固定 agent, 出口檢查, haiku, 語言), secret_from_handle, cli event raw, /secret handles, /router secret handles, 文字類附件, 文件與工具說明 |
| `router/test/e2e-rawvault.test.ts` | 真的 router + 假 Bot API 與假 claude: 啟動時補建 🔑 話題與補刪到期的訊息, 私訊貼 token (events, event_raw, messages, worker 都沒有明文), 提醒與取消刪除, 編輯訊息, /secret set, event_raw (user 對話被拒, owner 對話拿到代號與回答), secret_from_handle 後 bot_api 用到真值, cli event raw 寫 600 檔, 下載含 key 的 .env 附件 |
| `router/test/phase3-privskill.test.ts` | 規劃 10d 特權技能: 參數比對與逐一傳入 (不經 shell), 沙箱的 HOME 與 PATH, 核准與雜湊暫停, 角色與 internal 動作, 憑證不外流 (回傳與寫出的檔案, 通知 owner), 憑證被拒時更新一次再重試, 額外掛載只給 internal 動作, 參數限角色走提權, http API 憑證, 每日更新 (GMT+8 時間計算與 `skillRefreshAt`, 啟動時補跑超過 24 小時沒成功的技能, 執行與寫入憑證, 不佔對話限額, 雜湊不符略過並通知, 失敗通知且遮蔽憑證) |
| `router/test/classifier.test.ts` | 選配 1 工具呼叫分類器 (第一階段, 只記錄): config 預設與覆寫 (含 `telegramTools`, claude $50), 遮蔽 (格式, 已登記的值, 資料夾, chat id, 截斷), 外送內容與題目, 觸發的訊息 (遮蔽, 500 字, 終端機那一輪沒有), Telegram 工具 (角色, 不判斷的工具, 開關, 自己的說明), 舊表補 kind, hub 回報的費用, OpenRouter Decisions router (兩個模型, `usage.cost`, 沒有就記 0) 與依 `api` 選路徑, OrcaRouter 的費用標頭與 `usage.cost_usd`, Clef 與 Clef Flash 兩家 (預設, 單獨關閉, 報表), Decisions / Jev / claude 三種呼叫 (假 API 與假 claude), 只送 user 與 power, 不等判斷, 錯誤與逾時, no-key 與 haiku, 每天上限 (GMT+8), 併發與略過, 報表與單筆, 30 天清除, `/router classifier` |
| `router/test/e2e-classifier-off.test.ts` | 真的 router + 假 Bot API: classifier 區塊格式錯時 router 照常啟動並服務, log 寫明欄位, 分類器關閉; 開啟但沒有憑證時兩家在啟動時各 log 一次略過, 工具呼叫照常放行或擋下, 紀錄是 no-key |
| `router/test/e2e-classifier.test.ts` | 真的 router + 假 Bot API, 假 OpenRouter Decisions router (四個模型), 假 claude: hook 立刻放行後五家都記錄, 外送內容 (含觸發的訊息) 沒有已登記的值, 資料夾與 chat id; 擋下的, owner 對話與 hook 裡的 telegram 工具不送; user 對話的 reply 在 router 端判斷 (Telegram 類), owner 的不判斷; 終端機 `cli classifier` |
| `router/test/phase3-pkg.test.ts` | 規劃 07 套件安裝審核: 指令解析, manifest, 審核快取, 送審與核准, 慢審核, 審核模型的呼叫方式, hook |
| `router/test/e2e-setup.test.ts` | 真的 router + 假 Bot API, 從沒有 owner 開始: 認領碼, 人設訪談與 bot CLAUDE.md, 審核群組的檢查與話題, 略過 |
| `router/test/phase4.test.ts` | 規劃 10 Phase 4: v1 訊息紀錄匯入 (`import-v1`, 歸給哪隻 bot), 三層 CLAUDE.md 範例, /telegram:doc 與 /telegram:format |
| `router/test/poller.test.ts` | 運作方式 14 的輪詢: 重試間隔, 2 分鐘才通知與恢復通知, 409, 401, 429, 啟動時的 getMe, status 與通知文字 (e2e 另測 token 失效時經其他 bot 通知與 /router status); 運作方式 15 的指令回覆重試 (e2e 另測 502 後重送) |
| `router/test/store.test.ts`, `router/test/inbound.test.ts` | 訊息紀錄 (運作方式 13): 每隻 bot 各自一份 (私訊撞號, 同群組同一則), 舊紀錄分配 bot 一次 (對話, events, outbound, 時間, legacy), legacy 列用時間重新判斷一次, 重複丟掉時寫 log, 引用不跨 bot |
| `router/test/role-live.test.ts` | `LIVE=1` 才跑: 真的 claude 依各角色範本執行, 驗證 Claude Code 實際放行與擋下的事 |
| `router/test/e2e-wake.test.ts` | 真的 router + 假 claude CLI (`fixtures/`, 假 worker 是真的程序): 私訊與群組各自一個 worker 且不串線, 被回收後自動喚醒, worker 不在時連發多則只喚醒一次且不掉訊息 |
| `router/test/channel.test.ts` | 頻道 (運作方式 11): 加入頻道的通知內容, /telegram:doc 的頻道一節 |
| `router/test/e2e-channel.test.ts` | 真的 router + 假 Bot API 送 channel_post: 頻道貼文 (含編輯, 指令) 只進 events, 就算列在 access.json 也不建立對話不送 worker, bot 不在頻道發言; 加入頻道時通知 owner |

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

### Phase 3 驗收對照

| 驗收項目 | 測試 |
|---|---|
| 每個角色: 能做的做得到, 不能做的被擋且原因正確 | phase3「five role templates…」「permcheck: each role template…」; 真的 claude 執行: role-live (LIVE=1) |
| 越權被擋時告訴模型改用不越權的方法, 做不到就問要不要向 owner 申請 | phase3「elevation: a plain user turn is refused with advice…」 |
| 唯讀白名單的角色用重導向寫檔視為寫入: 擋下, 記錄, 發話者較高時提權 (只能允許一次) | phase3「permcheck: each role template…」「writesFile: …」「elevation: a user conversation writing a file through a redirection…」 |
| 白名單比對的切段尊重引號與跳脫 (`grep -E 'a|b'` 放行); user 可用 cut, sort, uniq, 但 `sort -o`, `uniq 輸入 輸出` 視為寫入 | phase3「subcommands: split at &&, ||, |, ; and newlines…」 |
| user 另可用 which, tr, seq, hostname (不帶參數), cd; 非 owner 角色可讀自己對話在 `~/.claude/projects/<對話>/*/tool-results/` 的工具結果檔, 其他對話與對話紀錄不行 | phase3「user allow-list A…」 |
| 終端機打的一輪沒有發話者: 只看對話角色, 不在對話裡詢問; 它提出的申請不綁上一則 Telegram 訊息 | phase3「elevation: a turn typed in the worker's terminal has no sender…」「request origin: …」 |
| 發話者角色較高時在對話裡詢問, 120 秒預設拒絕 | phase3「…in-chat 提權執行/拒絕 prompt…」「nobody answers within the time limit…」 |
| 按下的人角色要夠高, 以他的角色執行; 只有下一個 subagent, 主 session 與其他 subagent 照舊被擋 | phase3「…only a role high enough may approve…」, phase3「cc-hook asks the router…」 |
| 主動申請 (request_elevation) 送 owner | phase3「request_elevation from a plain user turn…」 |
| 提權紀錄: 被擋, 申請, 成功 (附原申請連結), 群組話題 | phase3「…approval runs the next subagent…」(紀錄與連結), 「elevation log: with an approvals group…」 |
| 跨對話傳訊: owner 審核, 目標對話與 owner 同時詢問; 目標就是審核處時只有一份, 由 owner 或 admin 決定, 文字照實說明 | phase3「grants: owner mode…」「grants: target mode…」「grants: a target request whose target is the approvals group…」 |
| 群組回到提問者的私訊 (reply on_behalf_of): 不用申請, 不限時間, 標明來源, 其他人一律擋 | e2e「a group worker answers the asker in their DM…」 |
| power 安裝套件: 低風險放行, 其餘送審, 核准後可裝; 選項的值不算套件; 自訂來源的套件不查 registry, 一律送審; URL, 本機路徑, 自訂來源核准只放行一次且不寫覆寫 | phase3-pkg 全部 |
| 新 bot 初次設定與審核群組; 同一隻 bot 加回時沿用既有設定, 名稱給了另一隻 bot 就重置 | e2e-setup 全部; phase2「bot add: a new bot gets the first-run line…」「bot setup follows the Telegram bot id…」; e2e「bot add answers once its getMe is in…」「a name whose token is now another bot's…」 |
| /router perm 與覆寫 | phase3「/router perm: show…」「admin cannot touch…」「overrides lay paths…」 |
| 三選一按鈕與永久允許的範圍 | phase3 grants 兩條, 「永久允許 runs it this time…」; phase3-pkg「永久允許 lets the conversation…」 |
| 撤銷與執行授權 (含提權紀錄的成功訊息標已撤銷), 無參數指令的永久允許 | phase3「authz: …」三條,「elevation: a command without arguments (hostname)…」; phase3-pkg「installing an approved package is a use…」 |
| 跨 bot 技能的憑證, 技能範圍 | phase3-cred 全部; e2e-setup「credentials end to end…」「http credentials end to end…」(回顯的 key 被遮蔽); phase3「elevation for a credential…」(角色不夠走提權, admin 核准); phase3「elevation for install_skill…」, e2e-setup「install_skill end to end…」; role-live「skills: …」(LIVE=1, 真的 claude 寫不進 .claude, 寫得進 skills/); phase4「/telegram:bot-skill…」 |

### 10b 對話專屬密鑰驗收對照

| 驗收項目 | 測試 |
|---|---|
| 存在 router.db conv_secrets, 值加密 (AES-256-GCM), 金鑰在 config.json, 沒有就產生 | secrets「seal/open…」; e2e-secrets「the router generates config.json secretKey…」「DM: a user registers…」 |
| 每個對話最多 20 把, 每把最長 4 KB | secrets「/secret set refusals…」 |
| 私訊登記: router 處理不轉給 worker, 訊息立刻刪除, log 裡值遮蔽 | e2e-secrets「DM: a user registers…」; secrets「masking…」 |
| 群組登記: 任何成員, 不看角色; 有權限就刪, 沒有就提醒 | secrets「/secret in a group…」; e2e-secrets「group: any member registers…」 |
| 使用: bot_api / http_api 先找對話密鑰再找全域憑證, 不檢查角色, 群組不需授權, 只檢查網址與路徑或方法 | secrets「refuseSecret…」; e2e-secrets「DM: …」(user 對話使用, 其他對話用不到)「group: …」(無 auth_uses) |
| 每次使用寫 router.db, 回應截斷, 回傳內容遮蔽密鑰值 | e2e-secrets「DM: …」(outbound secret:img, 截斷, `<密鑰>`)「group: …」 |
| 管理: /secret list / rm, owner 與 admin 的 /router secret list / rm | secrets「/secret set in a DM…」「/router secret list|rm…」; e2e-secrets「list and rm…」 |
| bot token 登記前用 getMe 驗證, 假值不存 | secrets「telegram-bot secrets are checked with getMe…」; e2e-secrets「group: …」(401 不存) |
| --header / --scheme, 預設 Authorization: Bearer, 欄位同全域 http 憑證 | secrets「--header / --scheme…」; e2e-secrets「--header: …」 |
| events 表遮蔽 /secret, /router cred add, /router bot add/rotate; 舊資料一次性遮蔽, 只印筆數 | secrets「events masking covers…」「one-time events migration…」; e2e-secrets「the router generates config.json secretKey…」 |
| 全域 http 憑證路徑擋 .., ., %2e, \ | secrets「global http credentials: dot segments…」 |
| bot add, 初次設定, setup group, 加入群組時的隱私模式提醒 (重新加入才生效, 管理員不受限) 與 bot-to-bot 說明; 照柯姊草稿加粗 (HTML), 名稱含 < > & 仍送得出去, HTML 被拒時改純文字重送 | secrets「group privacy notice…」「the settings notices are bold…」「/router bot add: …」; e2e-secrets「added to a group…」「bot settings notices on first-run…」 (假 Telegram 拒收不合法的 HTML) |

### 頻道驗收對照

| 驗收項目 | 測試 |
|---|---|
| 頻道貼文 (含 edited_channel_post) 只寫進 events (/secret 值遮蔽), 不建立對話, 不送 worker, 頻道裡的指令不回應 | e2e-channel「channel posts only go to events…」 |
| bot 被加入頻道時通知 owner: 頻道名稱與 id, 尚未支援, GitHub issues 連結 | channel「channelJoinNotice: …」; e2e-channel「added to a channel: …」 |
| 實際頻道: 加 bot 為管理員, 發貼文 | 上線實測 (測試帳號) |

### 10e 原始事件與密鑰保護驗收對照

| 驗收項目 | 測試 |
|---|---|
| events 加 masked, 存 `<已遮蔽 #代號>`; event_raw 以 AES-256-GCM 加密並綁定 event id, 記欄位, 原因與指紋, 沒有明文 | rawvault「record: …」「event_raw sealing…」; e2e-rawvault「a token pasted in a DM…」 |
| 偵測範圍: 文字, 圖片說明, 編輯後的訊息, 按鈕資料 | rawvault「scanning covers…」; e2e-rawvault「an edited message…」 |
| 已知格式加已登記的全域憑證與對話密鑰 (完全比對), 不做熵值猜測 | rawvault「detection: …」 |
| 每次偵測記在第五個話題「🔑 密鑰偵測」, 沒有審核群組私訊 owner; 既有群組自動補建話題 | rawvault「a served chat…」「no right to delete…」; e2e-rawvault「startup: …」; e2e-setup「approvals group: …five topics…」 |
| 送進 worker 的訊息換成代號, 附種類與末 4 碼 | rawvault「record: …」; e2e-rawvault「a token pasted in a DM…」(含 messages 表) |
| 一般對話: 回覆提醒, 5 分鐘後刪除, 取消刪除 (發送者, owner, admin), 沒有刪除權限只提醒; 登記指令立刻刪除 | rawvault「a served chat…」「no right to delete…」「取消刪除…」; e2e-rawvault「a token pasted in a DM…」「an edited message…」 |
| 刪除排程撐過 router 重啟 | rawvault「the deletion schedule survives a restart…」; e2e-rawvault「startup: …」 |
| event_raw: 只限發話者或對話角色 owner/admin, 任何對話 (含 owner 對話); 代號說明由程式填 (種類, getMe, 是否等於已登記的值); 固定 system prompt, 沒有工具的 claude -p, config 的 model, 不用 haiku | rawvault「event_raw: only when…」「the fixed agent is claude -p…」「event_raw exit check…」; e2e-rawvault「event_raw: …」「event_raw goes by who started the turn…」(終端機那一輪只看對話角色) |
| 出口檢查: 回答有明文或疑似密鑰就整份擋下並通知 owner | rawvault「event_raw exit check…」 |
| 代號只在申請的對話有效, 預設 10 分鐘, 最多 1 小時或永久; 永久代號可查看與撤銷 | rawvault「event_raw: only when…」「secret_from_handle…」(過期, 撤銷)「/secret handles | revoke…」 |
| secret_from_handle 登記成對話密鑰 (10b 範圍規則與 getMe), 之後 bot_api / http_api 使用 | rawvault「secret_from_handle…」; e2e-rawvault「event_raw: …」(bot_api 送出真值) |
| 每次請求與登記記在話題與 router.db | rawvault「event_raw: only when…」「secret_from_handle…」; e2e-rawvault「event_raw: …」 |
| 明文: 只限 owner 終端機 `cli event raw`, 寫進 600 檔只印路徑, 記在話題; 不提供私訊明文 | rawvault「cli event raw…」「/secret handles | revoke…」(Telegram 與 admin 被拒); e2e-rawvault「event_raw: …」 |
| 文字類附件 (副檔名或 text/*, 1 MB 以內): 收到訊息時就下載並偵測, 提醒並 5 分鐘後刪除原訊息, 話題記檔名, 原檔加密保存; 下載結果留著 (遮蔽版), download_attachment 沿用不重複下載, 沒有密鑰也留著, 最後使用 30 天後清除; 圖片與二進位檔不做 | rawvault「text attachments: …」「download_attachment of a text file…」「text attachments are downloaded and checked as they come in…」「kept attachment copies go 30 days…」; e2e-rawvault「a .env file with a key is checked as it comes in…」 |
| 固定 agent 一律台灣正體中文與半形標點 | rawvault「the fixed agent answers in Taiwan…」 |
| 工具說明, /telegram:doc 與 README 同步 | rawvault「docs: …」 |

### 工具呼叫分類器 (第一階段) 驗收對照

| 驗收項目 | 測試 |
|---|---|
| 選配功能預設關閉, 只有 `"enabled": true` 或 `true` 才開, `{}` 與沒寫 enabled 都是關閉; 設定錯不讓 router 啟動失敗 (分類器關閉, log 寫明欄位) | classifier「config: on only with…」「config.json: loadConfig…」; e2e-classifier-off「an unusable classifier block…」 |
| 開啟但缺憑證, claude CLI 不在或 haiku: 那家記 skipped, 啟動時 log 一次, 放行不受影響; 關閉時不保留任何訊息 | classifier「check at start…」「no key and haiku are skipped…」「off: the turn message is not kept」; e2e-classifier-off「on with no credentials…」; e2e-classifier「a user call the rules allow…」(啟動 log) |
| 只送 user 與 power 規則放行的呼叫; owner/admin, 擋下的不送; 沒開就不送 | classifier「only user and power…」; e2e-classifier「not sent: …」 |
| Telegram 工具在 router 端判斷: user/power (以實際角色), 不含只問人的工具, 說明是要送到 Telegram 的內容, `telegramTools` 可單獨關 | classifier「Telegram tools (router-side)…」「the message that started the turn…」; e2e-classifier「Telegram tools are judged router-side…」 |
| 一併送觸發這一輪的使用者訊息 (遮蔽密鑰與 chat id, 前 500 字) | classifier「the message that started the turn…」「Telegram tools (router-side)…」(終端機那一輪沒有); e2e-classifier「a user call the rules allow…」 |
| 不影響放行也不拖慢: hook 立刻回答, 判斷在背景; 錯誤, 逾時只記錄 | classifier「submit returns at once…」「a judge that throws or hangs…」; e2e-classifier「a user call the rules allow…」 |
| 外送前遮蔽密鑰 (格式與已登記的值), 對話資料夾, router home, 家目錄, chat id; 長度上限 | classifier「masking: …」「what is sent: …」; e2e-classifier「a user call the rules allow…」 |
| Decisions (`/v1/decisions`, predicate + score), Jev (`/v1/systemone`, noul + score), claude -p (config 的 model, 不用 haiku, 沒有工具) 用同一份內容與同樣兩題 | classifier「questions: …」「Decisions judge: …」「Jev judge: …」「claude judge: …」「no key and haiku…」 |
| 記錄延遲, 結果 (機率, 分數, 信心), tokens, 費用 | classifier「submit returns at once…」; e2e-classifier「a user call the rules allow…」 |
| Cloudflare Clef 與 Clef Flash 是各自獨立的兩家 (OpenRouter, 自己的模型與上限), 可單獨關閉 (不跑不留紀錄), 報表各一行, 一致率與意見不同的也列 | classifier「config: …」「Clef and Clef Flash: …」; e2e-classifier「a user call the rules allow…」「/router classifier from the owner terminal…」; e2e-classifier-off「on with no credentials…」 |
| 每家每天上限 (GMT+8 日界; claude 預設 $50, 以 total_cost_usd 換算值計), 超過當天停; 併發上限與略過 | classifier「config: …」「daily cap per provider…」「busy: …」 |
| 走 OrcaRouter 時要求並記錄實際費用 (`usage.cost_usd`, 沒有記 0 並註明), 說明裡留 `X-Orca-Request-Id`; TypeSafe 原生不帶這個標頭 | classifier「Jev through OrcaRouter: …」「Jev judge: …」 |
| Decisions 與 Jev 預設走 OpenRouter 的 `/api/alpha/decisions` (Jev 式請求, `usage.cost` 當實際費用, 不換算); 原生 `/v1/decisions` 與 `/v1/systemone` (TypeSafe, OrcaRouter) 由 config `api` 選 | classifier「config: …」「OpenRouter judge: …」「Decisions judge: …」「Jev judge: …」; e2e-classifier「a user call the rules allow…」 |
| 報表: 一般工具與 Telegram 工具分開, 各家數字與跟 claude 的差異, 實際費用與 claude 訂閱用量 (API 換算) 分開, 單筆詳情, 只限 owner | classifier「report: …」「/router classifier: …」; e2e-classifier「/router classifier from the owner terminal…」 |
| 保留 30 天 | classifier「purge: …」 |

### Phase 4 驗收對照

| 驗收項目 | 測試 |
|---|---|
| CLAUDE.md 三層改寫 (FORCED / GENERAL / Default suggestions), 人設放在 bot 資料夾 | phase4「three-tier CLAUDE.md example…」, e2e-setup「persona interview…」 |
| telegram:format skill, /telegram:doc 涵蓋新功能 | phase4「plugin skills…」 |
| 匯入 v1 的 messages.db, 可重複執行不重複匯入, 歸給第一隻 bot 或 --bot | phase4「import-v1…」 |
| 訊息紀錄每隻 bot 各一份: 私訊撞號與同群組同一則都送進各自的對話, lookup 與引用不跨 bot, 舊紀錄分配一次, 重複丟掉有 log | store「two bots, same chat and message id…」「old rows get their bot once…」; inbound「two bots, one store…」; e2e「two bots in the same group…」 |
| 舊對話資料夾與對話紀錄搬進 bot 資料夾, 之後從新位置 resume | phase3「bot folders…」 |
| 一週內沒有掉訊息, 回錯對話或權限誤放 | 上線觀察: router.db 的 queue (未 ack), outbound 錯誤, elev_log |

