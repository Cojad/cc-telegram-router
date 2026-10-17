# 技能與憑證

[README](../README.md) 的文件索引列出所有文件.

## 技能範圍

- 技能範圍: `<home>/.claude/skills` (全部 bot), `<home>/bot<id>/.claude/skills` (一隻 bot), 對話資料夾的 `.claude/skills` (單一對話). worker 寫不進任何 `.claude` (Claude Code 內建保護, 只有 owner 對話例外), 所以技能先寫在對話資料夾的 `skills/<名稱>/`, 再用 `install_skill` 由 router 複製: scope `conversation` (power 以上) 裝到該對話的 `.claude/skills`, `bot` 與 `all` (owner 與 admin) 裝到前兩個範圍; 角色不夠時跟其他越權動作一樣走提權. router 會拒絕含 token 或符號連結的技能.
- 放在 bot 或全部 bot 範圍的技能, sandbox 裡的角色可以讀與執行, 不能改.

## 憑證

- 跨 bot 技能需要的 token 存在 `config.json` 的 `credentials` (token, 允許的方法, 允許的角色), 由 owner 或 admin 在私訊用 `/router cred add <名稱> <token> [方法...]` 登記 (訊息會被刪), 或在終端機用 `cc-telegram-router cred-import <名稱> <檔案> <變數> [方法,...]` 從檔案搬進來. 只有像 bot token 的值 (數字, `:`, 35 字元) 才用 getMe 驗證; 沒帶 `--http` 又不像 bot token 時兩處都不呼叫 getMe (不把 API key 送去 Telegram), 回覆它像哪種 key (Anthropic `sk-ant-`, OpenAI `sk-`, Google `AIza`) 與加上 `--http` 的打法, `/router cred add` 那則訊息照樣刪除. 沒寫方法就是還沒開放任何方法. worker 用 `bot_api` 工具使用, 看不到 token; owner 在終端機可用 `cc-telegram-router cli botapi`. 對話角色不在憑證允許的角色 (含 `self`) 時跟其他越權動作一樣擋下並走提權 (發話者角色較高就在對話裡詢問, 只能允許一次); 憑證不存在或方法, 路徑沒開放則直接拒絕.
- 一般 API key (例如 OpenAI, Anthropic) 也存成憑證, 種類 http: 私訊 `/router cred add <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [路徑...]` 或終端機 `cred-import <名稱> <檔案> <變數> [路徑,...] --http <網址> [同樣的選項]`, worker 用 `http_api`. 只能打那個網址 (同一個 host); 沒寫路徑就是網址底下全部路徑 (存成 `*`), 寫了就只開放那些 (結尾 `*` 代表前綴). `/router cred list` 的路徑 `全部` 是 `*`, `(無, 全部擋下)` 是空清單, 每次呼叫都會被拒; 角色 `(無, 沒有對話能用)` 是空的角色清單. 回應裡的 base64 可直接存成對話資料夾裡的檔案. 路徑先擋掉 `..`, `.`, `%2e`, 編碼過的 `/` 與 `\`, `#` 再比對前綴 (fetch 會把 `/v1/images/../files` 解析成 `/v1/files`), 對話密鑰也一樣. `bot_api` 與 `http_api` 的回應若回顯了 token 或 key (例如回聲 API), router 先遮蔽成 `<密鑰>` 才交給 worker.
- owner 與 admin 的對話用 `bot_api` 的 credential `self` 以這隻 bot 自己的身分呼叫任何 Bot API (getUpdates, setWebhook, deleteWebhook, logOut, close 除外).

對話自己登記的 token 與 API key (不用提權) 見 [密鑰](secrets.md#對話專屬密鑰).

## http 憑證的 key 放哪裡

- 憑證決定 key 放哪裡, worker 改不了: 預設 `Authorization: Bearer <key>`; `--header <標頭>` 改放進那個標頭且不加前綴 (例如 Anthropic 的 `x-api-key`, Google 的 `x-goog-api-key`); `--scheme <前綴>` 改前綴 (`none` 不加前綴, 只寫 `--scheme` 時標頭仍是 Authorization); `--query <參數>` 改放在網址的 query 參數 (少數用 `?key=` 傳 key 的 API), 這時不放任何標頭, 不能跟 `--header`, `--scheme` 一起用. 三個選項在 `/router cred add`, `cred-import`, `/secret set` 寫法相同, 可以放在 `--http <網址>` 後面任何位置. config.json 對應 `header`, `scheme`, `query` 欄位, 對話密鑰存在 `conv_secrets` 同名欄位. Host, Content-Type, Cookie, Proxy-Authorization 這類標頭不能放 key.
- worker 呼叫 `http_api` 時可以用 `headers` 自帶額外標頭 (例如 `anthropic-version: 2023-06-01`, `anthropic-beta`), router 原樣轉送 (最多 20 個, 值是一行文字). 只擋精確的名單 (不看名稱片段, `x-csrf-token`, `Idempotency-Key`, `X-Auth-Token` 這類照樣轉送): key 所在的那個標頭, Authorization, Proxy-Authorization, Cookie, 以及 router 自己設定的 Host, Content-Type (依 json, form 或 multipart 設定), Content-Length, Transfer-Encoding, Connection, Keep-Alive, TE, Trailer, Upgrade, Expect; 用 `--query` 的憑證, path 裡也不能帶那個參數 (含編碼過的寫法). 擋下時回錯誤, 什麼都不送, 避免 worker 把 key 搬到別處或混入別的認證. key 的標頭最後才設, 同名的額外標頭也蓋不掉. 額外標頭記在 `outbound` 的請求欄.
- 網域與路徑限制不變: 只能打憑證的網址, 路徑照允許清單, `..` 等照樣擋. 回應若回顯了 key (含 URL 編碼過的 query 值), 照樣遮蔽成 `<密鑰>`.
- Anthropic 範例: 私訊打 `/router cred add anthropic sk-ant-... --http https://api.anthropic.com --header x-api-key`; worker 呼叫 `http_api(credential: "anthropic", path: "/v1/messages", headers: {"anthropic-version": "2023-06-01"}, json: {...})`.

## 特權技能

- 特權技能 (技能的 sudo bit): 技能帶 `privileged.json` 列出動作, owner 或 admin 以 `/router skill approve` 核准 (記下檔案雜湊, 改了自動暫停). 對話用 `run_skill` 呼叫, router 以 bwrap 專屬沙箱執行: 只讀技能與憑證資料夾 (`<stateDir>/creds/`), 只寫對話資料夾, 隱藏 router 的家目錄 (其他對話), stateDir, $HOME, config `sandboxDenyRead` 與放在這些位置以外的 router socket 檔 (見 [部署與維運](operations.md#安裝位置)); 輸出掃描憑證內容; 憑證被拒時執行 internal 的更新動作一次再重試; 每個對話每小時 10 次. 動作可以帶 http API 憑證 (`http`, 腳本拿到授權標頭的環境變數, key 會從輸出遮蔽); 單一參數可以限定角色 (`args.<名稱>.roles`), 較低角色帶這個參數就照一般流程觸發提權申請. 每天固定時間 (config `skillRefreshAt`, 預設 `"05:00"` GMT+8, `"off"` 關閉) router 對所有已核准技能執行一次被 `refresh` 指到的 internal 動作 (同樣的沙箱, 掛載, env 與雜湊檢查, 在 `<stateDir>/skill-refresh/<技能>/` 執行), 讓 cookie 不會放到過期: 雜湊不符就略過並通知 owner, 失敗通知 owner (輸出遮蔽憑證), 成功只記在 router log 與 `skill_runs` (對話欄位 `router:refresh`, 不算進任何對話每小時 10 次的限額). router 啟動一分鐘後補跑: 上次成功的每日更新超過 24 小時 (或從沒成功過) 的技能執行一次, 之後照每天的時間; 每次執行依序排隊, 不會重疊.

## worker 端 SOP

- worker 端的 SOP 在 `/telegram:bot-skill`.
