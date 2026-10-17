# 密鑰

對話專屬密鑰 (規劃 10b) 讓任何角色的對話登記自己的 token 與 API key; 原始事件與密鑰保護 (規劃 10e) 讓貼進 Telegram 的密鑰不以明文留在 router.db, 也不進 worker.

[README](../README.md) 的文件索引列出所有文件.

## 對話專屬密鑰

- 任何角色的對話都能有自己的 token 或 API key, 不用提權: 在那個對話傳 `/secret set <名稱> <值> [方法...]` (Telegram bot token, 沒寫方法就是全部) 或 `/secret set <名稱> <值> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [--default-header <名稱>:<值>]... [路徑...]` (一般 API key, 結尾 `*` 代表前綴, 沒寫路徑就是全部; `--default-header` 是 worker 沒帶同名標頭時 router 補上的標頭, 見 [預設標頭](credentials-and-skills.md#預設標頭)). 跟全域憑證 (`/router cred`) 的差別: 對話密鑰只屬於那個對話, 任何角色都能登記, 不用授權; 全域憑證由 owner 或 admin 在私訊登記, 預設給 owner 與 admin 角色的對話用 (`/router help secret` 有同樣的說明). 也可以用 `cc /secret ...`.
- bot token 登記前一律用 getMe 驗證, getMe 不接受的值不會存 (沒有略過的開關). 沒帶 `--http` 而值不像 bot token (數字, `:`, 35 字元) 時不呼叫 getMe, 不把它送去 Telegram, 回覆它像哪種 key (Anthropic `sk-ant-`, OpenAI `sk-`, Google `AIza`) 與加上 `--http` 的打法, 訊息照樣刪除 (見下方「登記訊息何時刪除」); `secret_from_handle` 也一樣.
- API key 預設以 `Authorization: Bearer <key>` 送出; `--header x-api-key` 改放進那個標頭且不加前綴, `--scheme Token` 改前綴 (`none` 不加), 兩個可以一起用; `--query key` 改放在網址的 query 參數. 跟全域 http 憑證的寫法與 config.json 的 `header`, `scheme`, `query` 欄位意思相同, 細節與 worker 自帶標頭的規則見 [http 憑證的 key 放哪裡](credentials-and-skills.md#http-憑證的-key-放哪裡). Host, Content-Type, Cookie, Proxy-Authorization 這類標頭不能用.
- router 自己處理, 不轉給 worker. 群組裡任何成員都能登記 (不看角色, 但要是 bot 有開放的群組與發話者). 那則訊息何時刪除見下方「登記訊息何時刪除」.
- 值以 AES-256-GCM 加密存在 `router.db` 的 `conv_secrets` (綁定 bot, 對話, 名稱), 金鑰是 `config.json` 的 `secretKey`, 沒有就在啟動時自動產生. 每個對話最多 20 把, 每把最長 4096 bytes; 名稱 `self` 保留, router 自己的 bot token 不能登記.
- 值不會出現在任何對話: router_log 與回覆引用那則訊息時換成 `<已遮蔽>`, 工具回應裡出現的值換成 `<密鑰>`. events 表裡 `/secret set`, `/router cred add|rotate`, `/router bot add|rotate` 的值換成 `<已遮蔽 #<event id>.<序號>>`, 原文加密存在 `event_raw` (見下方「原始事件與密鑰保護」); 10e 之前已記下的 update 在啟動時遮蔽一次 (migrations 表記 `mask-command-tokens-2026-10`, log 只印筆數), 那些原文沒有保留.
- worker 照樣用 `bot_api` / `http_api`, credential 填名稱: 先找這個對話自己的密鑰, 再找全域憑證. 不檢查角色, 群組裡也不需要授權 (不進「執行授權」話題), 只檢查登記時的方法或網址與路徑 (路徑不能含 `..` 等). 每次使用記在 `outbound` (bot 欄 `secret:<名稱>`); 回應裡過長的字串截斷, base64 可用 `save_b64` 存進對話資料夾.
- 管理: `/secret list` (只列名稱, 種類, 範圍, 預設標頭), `/secret rm <名稱>`, `/secret header <名稱>` (列出預設標頭) | `header <名稱> set <標頭>:<值>` (新增, 同名就更新) | `header <名稱> rm <標頭>` (http 密鑰的預設標頭, 不用重貼 key, 規則見 [預設標頭](credentials-and-skills.md#預設標頭)); owner 與 admin 用 `/router secret list [chat_id]` (不寫就列出所有有密鑰的對話) 與 `/router secret rm <chat_id> [名稱]` (不寫名稱就全部移除).

## 登記訊息何時刪除

- 私訊裡的 `/secret set` (以及 `/router cred add|rotate`, `/router bot add|rotate`) 那則訊息在 router 回覆後 60 秒刪除: router 回一則「⏳ 這則訊息含有 key, 60 秒後 (HH:MM) 刪除」的提示, 附「取消刪除」按鈕, 發訊者本人, owner, admin 能按, 其他人按會回沒有權限; 按了就保留. 細節與排程方式見 [登記訊息的延遲刪除](credentials-and-skills.md#登記訊息的延遲刪除).
- 群組裡合法的 `/secret set` (router 服務的群組) 10 秒後刪除, 提示「⏳ 這則訊息含有 key, 10 秒後 (HH:MM) 刪除.」, 不給取消按鈕 (群組其他人看得到); bot 沒有刪除權限就回覆提醒發送者自己刪. router 沒有服務的對話裡的 `/secret set` 被拒, 立刻刪除.

## 原始事件與密鑰保護

- 每個 update 的所有字串 (文字, 圖片說明, 編輯後的訊息, 按鈕資料, 被引用的訊息) 都會掃描 (`router/detect.ts`): 一眼可認的格式 (Telegram bot token, OpenAI `sk-`, Anthropic `sk-ant-`, GitHub `ghp_` 與 `github_pat_`, AWS `AKIA`, Google `AIza`, Slack `xox`, PEM 私鑰), 登記指令 (`/secret set`, `/router cred add|rotate`, `/router bot add|rotate`) 的值, 以及 router 持有的值 (自己的 bot token, 全域憑證, 對話密鑰; 完全比對, 8 字元以上). 不做「看起來很亂就算密鑰」的猜測. 登記指令的值只在那個字串以指令開頭時才算 (前面可以有 `cc ` 或 `柯柯 `; 被引用的訊息是自己的字串, 一樣看開頭), 而且參數位置真的有值 (一個不含中文等非 ASCII 字元的詞; 只有一個參數時也算, 它可能是沒寫名稱的值). 句子中間提到指令名稱, 例如「教我 /router cred add 的用法」, 不算 (2026-10-17 柯姊這句被誤判成含密鑰); 這種句子裡的 `sk-ant-` 等格式與已登記的值照樣比對. events, router_log 與回覆引用的遮蔽用同一套規則.
- 偵測到時 `events` 存遮蔽版: 值換成 `<已遮蔽 #<event id>.<序號>>` (同一個值同一個序號), `masked` 設為 1. 原始 update 以 AES-256-GCM 加密存在 `event_raw` (沿用 `secretKey`, 綁定 event id, 搬到別列解不開), 連同遮了哪些欄位, 種類, 指紋 (末 4 碼, sha256 前 8 碼) 與等於哪個已登記的值. 沒有明文欄位, dump 或備份都看不到值.
- 送進 worker 與存進 messages 表 (`lookup_message` 讀的那份) 的內容同樣換掉, 附種類與末 4 碼: `<已遮蔽 #12.1: Telegram bot token, 末 4 碼 a1B2>`.
- 每次偵測記在 router.db 的 `secret_log` 與審核群組的第五個話題「🔑 密鑰偵測」(沒有審核群組就私訊 owner): 對話, 發送者, 種類與末 4 碼 (等於哪個已登記的值), 欄位, event id, 處理結果. 已設定的審核群組在 router 啟動時自動補建這個話題, `/router setup group` 也會補.
- router 服務的對話 (允許的私訊與群組) 裡, 發送者自己的訊息 (不算被引用的) 含密鑰時, router 回覆那則訊息提醒, 5 分鐘後刪除; 提醒附「取消刪除」按鈕, 發送者, owner, admin 可以按. 排程存在 `secret_deletions`, router 重啟後照常執行 (停機期間到期的在啟動時刪). bot 沒有刪除權限時只提醒. 登記指令的訊息照「登記訊息何時刪除」處理 (私訊 60 秒, 發送者, owner, admin 能取消; 群組 10 秒, 不能取消); 其他對話, 頻道貼文, 按鈕資料只記錄.
- 請求原文: 發話者或對話角色是 owner 或 admin 的那一輪 (在終端機 attach 進對話打字的那一輪沒有發話者, 只看對話角色), worker 呼叫 `event_raw(event_id, question, [ttl_minutes 或 permanent])`, 任何對話的 event 都可以 (含 owner 對話). router 解密, 把每個值換成代號說明, 例如 «密鑰 h7: Telegram bot token, getMe: @example_bot (123), 末 4 碼 a1B2, 跟全域憑證 eagle相同» (種類, getMe, 是否等於已登記的值都由程式填), 交給固定 system prompt, 沒有工具, 設定與 MCP 的 `claude -p` 回答 (模型是 config 的 `model`, haiku 一律拒絕). agent 從頭到尾看不到值.
- 出口檢查: router 對回答做完全比對 (這個 event 的值, 所有已登記的值) 與格式掃描, 有任何一項就整份擋下, 撤銷這次的代號, 記在話題並發重要通知給 owner. 這是程式保證, 不靠模型自律. 通過時 worker 拿到代號版 update 與回答.
- 代號 (`secret_handles`) 只在申請的對話有效, 預設 10 分鐘, 最多 60 分鐘, 或永久. `secret_from_handle(handle, name, scope)` 把代號登記成這個對話的密鑰 (scope 跟 `/secret set` 值後面的寫法一樣, bot token 用 getMe 驗證, 10b 的限制照樣適用), 之後用 `bot_api` / `http_api`, 每次使用都累計在代號的 uses. 查看與撤銷: 對話裡 `/secret handles`, `/secret revoke <代號>`; owner 與 admin 用 `/router secret handles [chat_id]`, `/router secret revoke <代號>`. 撤銷代號不會移除已登記的密鑰.
- 每次請求與登記記在「🔑 密鑰偵測」話題與 router.db: `secret_requests` (誰, 哪個對話, 哪個 event, 問題, 發出的代號, 結果), `secret_handles` (之後是否登記成密鑰, 使用次數).
- 明文只限 owner 的終端機: `cc-telegram-router cli event raw <id>` 把原始 update 寫進 `<stateDir>/raw/` (目錄 700) 底下權限 600 的檔案, 只印路徑, 由 owner 自己開檔; 也記在話題. Telegram 裡沒有取得明文的途徑, admin 與 Telegram 裡的 `/router event raw` 一律拒絕.
- 文字類附件: router 收到訊息時就檢查, 不等 worker 下載 (柯姊 2026-10-17). 服務中的對話 (允許的私訊與群組) 裡, 訊息或編輯後的訊息帶的文字檔 (`.txt` `.env` `.env.*` `.json` `.yaml` `.yml` `.ini` `.conf` `.cfg` `.toml` `.properties` `.md` `.csv`, 常見原始碼副檔名, 或 mime 是 `text/*`; 1 MB 以內) 立刻下載, 用同一套偵測 (不含 NUL 位元組的才掃). 偵測到時原檔存成 events 的一列 (`update_json` 是 `{"attachment": {file_id, 檔名, 對話, 原訊息, 內容}}`, 遮蔽版, `masked` 1), 原文加密存在 `event_raw`; 原訊息照上面的方式提醒並 5 分鐘後刪除, 「🔑 密鑰偵測」記下檔名 (收到時偵測). 下載結果 (有密鑰就是代號版, 沒有就是原檔) 存在 `<stateDir>/attachments/<bot>/` (權限 600, `attachment_cache` 表), worker 之後呼叫 `download_attachment` 直接沿用, 不重複下載; 還在下載中就等它完成. 保留 30 天 (以最後使用時間算, 每次沿用都重新起算), router 啟動時與每天清一次, 檔案與 `attachment_cache` 的列一起刪. 收到時沒有下載的 (引用的舊附件, 其他對話, 下載失敗) 在 worker 下載時用同樣方式檢查, 同一個檔案只記錄一次. `event_raw` 與 `cli event raw` 也適用這一列.
- 限制: 2026-10-17 已遮蔽的 5 筆舊紀錄原始值已覆寫, 救不回來, 這套只保護之後的資料; 圖片, 二進位檔, 超過 1 MB 的文字檔不偵測; 不認得的格式偵測不到, 已登記的值則一定比對得到.
