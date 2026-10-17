# 技能與憑證

[README](../README.md) 的文件索引列出所有文件.

## 技能範圍

- 技能範圍: `<home>/.claude/skills` (全部 bot), `<home>/bot<id>/.claude/skills` (一隻 bot), 對話資料夾的 `.claude/skills` (單一對話). worker 寫不進任何 `.claude` (Claude Code 內建保護, 只有 owner 對話例外), 所以技能先寫在對話資料夾的 `skills/<名稱>/`, 再用 `install_skill` 由 router 複製: scope `conversation` (power 以上) 裝到該對話的 `.claude/skills`, `bot` 與 `all` (owner 與 admin) 裝到前兩個範圍; 角色不夠時跟其他越權動作一樣走提權. router 會拒絕含 token 或符號連結的技能.
- 放在 bot 或全部 bot 範圍的技能, sandbox 裡的角色可以讀與執行, 不能改.

## 憑證

- 跨 bot 技能需要的 token 存在 `config.json` 的 `credentials` (token, 允許的方法, 允許的角色), 由 owner 或 admin 在私訊用 `/router cred add <名稱> <token> [方法...]` 登記 (那則訊息 60 秒後刪除, 見 [登記訊息的延遲刪除](#登記訊息的延遲刪除)), 或在終端機用 `cc-telegram-router cred-import <名稱> <檔案> <變數> [方法,...]` 從檔案搬進來. 只有像 bot token 的值 (數字, `:`, 35 字元) 才用 getMe 驗證; 沒帶 `--http` 又不像 bot token 時兩處都不呼叫 getMe (不把 API key 送去 Telegram), 回覆它像哪種 key (Anthropic `sk-ant-`, OpenAI `sk-`, Google `AIza`) 與加上 `--http` 的打法, `/router cred add` 那則訊息照樣在 60 秒後刪除. 沒寫方法就是還沒開放任何方法. worker 用 `bot_api` 工具使用, 看不到 token; owner 在終端機可用 `cc-telegram-router cli botapi`. 對話角色不在憑證允許的角色 (含 `self`) 時跟其他越權動作一樣擋下並走提權 (發話者角色較高就在對話裡詢問, 只能允許一次); 憑證不存在或方法, 路徑沒開放則直接拒絕.
- 一般 API key (例如 OpenAI, Anthropic) 也存成憑證, 種類 http: 私訊 `/router cred add <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [--default-header <名稱>:<值>]... [路徑...]` 或終端機 `cred-import <名稱> <檔案> <變數> [路徑,...] --http <網址> [同樣的選項]`, worker 用 `http_api`. 只能打那個網址 (同一個 host); 沒寫路徑就是網址底下全部路徑 (存成 `*`), 寫了就只開放那些 (結尾 `*` 代表前綴). `/router cred list` 的路徑 `全部` 是 `*`, `(無, 全部擋下)` 是空清單, 每次呼叫都會被拒; 角色 `(無, 沒有對話能用)` 是空的角色清單. 回應裡的 base64 可直接存成對話資料夾裡的檔案. 路徑先擋掉 `..`, `.`, `%2e`, 編碼過的 `/` 與 `\`, `#` 再比對前綴 (fetch 會把 `/v1/images/../files` 解析成 `/v1/files`), 對話密鑰也一樣. `bot_api` 與 `http_api` 的回應若回顯了 token 或 key (例如回聲 API), router 先遮蔽成 `<密鑰>` 才交給 worker.
- owner 與 admin 的對話用 `bot_api` 的 credential `self` 以這隻 bot 自己的身分呼叫任何 Bot API (getUpdates, setWebhook, deleteWebhook, logOut, close 除外).

對話自己登記的 token 與 API key (不用提權) 見 [密鑰](secrets.md#對話專屬密鑰).

## 登記訊息的延遲刪除

- 含值的登記訊息 (`/router cred add|rotate`, `/router bot add|rotate`, `/secret set`) 在私訊裡不再立刻刪除: router 先回覆結果, 再回一則「⏳ 這則訊息含有 key, 60 秒後 (HH:MM) 刪除」的提示, 附「取消刪除」按鈕, 發訊者本人, owner, admin 能按 (比照密鑰偵測的取消權限), 其他人按會回「沒有權限: 只有發訊者本人, owner, admin 能取消刪除」. 時間到自動刪, 提示改成「🗑 已刪除含 key 的登記訊息」; 按了就保留, 提示改成已取消刪除 (不是發訊者按的會寫是誰) 並提醒不需要時自己刪. 登記失敗 (格式不對, 不像 bot token, getMe 不接受) 的訊息同樣 60 秒後刪, 方便照著改好再傳.
- 群組裡合法的 `/secret set` (router 服務的群組, 登記失敗的也算): 10 秒後刪除, 提示「⏳ 這則訊息含有 key, 10 秒後 (HH:MM) 刪除.」不附取消按鈕 (群組其他人看得到). bot 在群組沒有刪除權限時不排程, 回覆提醒發訊者自己刪.
- 立刻刪除, 不給取消: 被拒的 (`/router cred` 與 `/router bot` 在群組打, 角色不夠, admin 動別人加入的憑證), router 沒有服務的對話. bot 沒有刪除權限時回覆提醒自己刪.
- 排程跟 10e 密鑰偵測共用 router.db 的 `secret_deletions` (`kind` 欄: `detect` 是偵測, `command` 是登記訊息), router 重啟後照常執行, 停機期間到期的在啟動時刪 (每 10 秒檢查一次). 取消與刪除結果也記在「🔑 密鑰偵測」紀錄 (`secret_log`). 偵測紀錄的處理欄寫「登記或 router 指令: router 處理 (登記指令的訊息在私訊 60 秒後刪除, 發送者, owner, admin 可取消; 群組 10 秒後刪除; 被拒的立刻刪除)」.
- 在終端機打的指令 (`cc-telegram-router cli`) 沒有訊息要刪.

## 同名憑證: 覆蓋或取消

- `/router cred add` 遇到已經有的名稱不再直接取代: router 回覆現有設定摘要 (類型, 網址, key 的標頭, 預設標頭, 路徑, 角色, 加入者; 不含值), 附「覆蓋 / 取消」按鈕, 並提示只想換 key 用 `/router cred rotate`.
- 這次 add 的值與設定只暫存在 router 記憶體 2 分鐘 (不寫進任何檔案或 router.db, router 重啟就沒了); 逾時, 按取消, 或按過一次之後就丟棄, 再按會回「已逾時或處理過」. 只有下指令的人能按. 按覆蓋時重新檢查角色, 然後用這次 add 的設定整個取代 (網址, 標頭, 預設標頭, 路徑都換成這次的, 角色回到預設 owner, admin, 加入者換成按的人).
- owner 能覆蓋任何憑證; admin 只能覆蓋自己加入的, 別人加入的同名憑證照舊直接拒絕 (訊息立刻刪除, 不給按鈕).

## 換 key: cred rotate

- `/router cred rotate <名稱> <新的 key 或 token> [--default-header <名稱>:<值>]...`: 只換值, 網址, key 的標頭, scheme, query, 路徑, 角色, 加入者全部保留. 跟 add 一樣只能在自己和 bot 的私訊打, 權限比照 add (owner, 或加入它的 admin), 訊息 60 秒後刪除.
- bot token 憑證換之前先用 getMe 驗證新的 token, 失敗就不換; 新值不像 bot token 時不送 getMe, 直接拒絕. 標籤 (@username) 換成新 token 的.
- http 憑證可以順便帶 `--default-header`, 依名稱新增或取代那幾個預設標頭, 其他預設標頭保留; bot token 憑證不接任何選項. 其他字 (路徑, `--header` 等) 一律拒絕: 要整個換掉用 add 再按覆蓋.

## 預設標頭

- http 憑證可以有預設標頭: worker 呼叫 `http_api` 沒帶同名標頭 (不分大小寫) 時 router 自動補上, worker 有帶就用 worker 的. 例如替 Anthropic 憑證加 `anthropic-version:2023-06-01`, worker 就不必每次自帶.
- 登記時寫 `--default-header <名稱>:<值>` (可多次, 值可以含 `:`): `/router cred add`, `/router cred rotate`, `cred-import`, `/secret set --http` 都支援, `secret_from_handle` 的 scope 也是. 規則跟 worker 自帶的標頭一樣: 不能是 key 所在的標頭, 也不能是 Authorization, Proxy-Authorization, Cookie, Host, Content-Type 這類被擋的標頭.
- 不用重貼 key 調整現有憑證: `/router cred header <名稱>` (不帶參數就列出現有的預設標頭), `/router cred header <名稱> set <標頭>:<值>` (新增; 同名不分大小寫就更新成這次的名稱與值), `/router cred header <名稱> rm <標頭>`. 不含 key, 所以可以在任何對話打, 權限是 owner 或加入它的 admin. bot token 憑證沒有標頭可設.
- 對話密鑰的對等指令: `/secret header <名稱>` (列出), `/secret header <名稱> set <標頭>:<值>`, `/secret header <名稱> rm <標頭>`, 在那個對話打, 跟 `/secret rm` 一樣任何角色都可以. 規則相同 (不能是 key 所在的標頭或被擋的標頭), telegram-bot 密鑰沒有標頭可設; 回覆都是「<名稱> 的預設標頭: ...」, 沒有就是 `(無)`.
- 預設標頭不是秘密: `/router cred list`, `/secret list` 與覆蓋提示都會列出名稱與值. config.json 存在憑證的 `defaultHeaders` 物件, 對話密鑰存在 `conv_secrets.default_headers` (JSON). `cred-import` 重新匯入時跟 `--header` 等一樣以這次的選項為準.
- 替現有的 anthropic 憑證加上版本: `/router cred header anthropic set anthropic-version:2023-06-01`.

## http_api 的 json_file

- `http_api` 的 `json_file`: 檔案路徑 (相對於對話資料夾, 或絕對路徑), router 讀檔當 JSON body 原樣送出 (Content-Type: application/json). 用在很大的請求, 例如量 26 萬 token 的 `count_tokens`: 內容塞進工具參數的成本比實際送出還高.
- 檢查 (都跟著符號連結算): 不論角色都不能在 router 狀態目錄 (stateDir) 裡; owner 與 admin 角色的對話可以讀對話資料夾以外的檔案, user 與 power 必須在這個對話的資料夾裡 (連到外面的不行). 最大 20 MB; 內容要是合法的 JSON, 否則拒絕並說明哪裡錯. `json_file` 與 `json`, `form`, `files` 只能擇一. 任何一項不通過就不送出.
- 讀檔的是 router, 不是 worker: 路徑檢查只看上面的規則, 不看 worker 的 sandbox. 所以 owner 與 admin 的對話能讓 router 讀到 worker 的 sandbox 讀不到的檔案: 只要 router 程序讀得到, 不在 stateDir, 而且是合法 JSON, 內容就會送到憑證的網址. 這跟 `files` 參數對 owner 的放寬同一個道理 (`files` 目前只放寬 owner).
- `outbound` 的請求欄記檔案路徑與大小, 不記內容.

## http 憑證的 key 放哪裡

- 憑證決定 key 放哪裡, worker 改不了: 預設 `Authorization: Bearer <key>`; `--header <標頭>` 改放進那個標頭且不加前綴 (例如 Anthropic 的 `x-api-key`, Google 的 `x-goog-api-key`); `--scheme <前綴>` 改前綴 (`none` 不加前綴, 只寫 `--scheme` 時標頭仍是 Authorization); `--query <參數>` 改放在網址的 query 參數 (少數用 `?key=` 傳 key 的 API), 這時不放任何標頭, 不能跟 `--header`, `--scheme` 一起用. 三個選項在 `/router cred add`, `cred-import`, `/secret set` 寫法相同, 可以放在 `--http <網址>` 後面任何位置. config.json 對應 `header`, `scheme`, `query` 欄位, 對話密鑰存在 `conv_secrets` 同名欄位. Host, Content-Type, Cookie, Proxy-Authorization 這類標頭不能放 key.
- worker 呼叫 `http_api` 時可以用 `headers` 自帶額外標頭 (例如 `anthropic-version: 2023-06-01`, `anthropic-beta`), router 原樣轉送 (最多 20 個, 值是一行文字); 憑證的預設標頭 (見 [預設標頭](#預設標頭)) 在 worker 沒帶同名標頭時補上. 只擋精確的名單 (不看名稱片段, `x-csrf-token`, `Idempotency-Key`, `X-Auth-Token` 這類照樣轉送): key 所在的那個標頭, Authorization, Proxy-Authorization, Cookie, 以及 router 自己設定的 Host, Content-Type (依 json, form 或 multipart 設定), Content-Length, Transfer-Encoding, Connection, Keep-Alive, TE, Trailer, Upgrade, Expect; 用 `--query` 的憑證, path 裡也不能帶那個參數 (含編碼過的寫法). 擋下時回錯誤, 什麼都不送, 避免 worker 把 key 搬到別處或混入別的認證. key 的標頭最後才設, 同名的額外標頭也蓋不掉. 額外標頭記在 `outbound` 的請求欄.
- 網域與路徑限制不變: 只能打憑證的網址, 路徑照允許清單, `..` 等照樣擋. 回應若回顯了 key (含 URL 編碼過的 query 值), 照樣遮蔽成 `<密鑰>`.
- Anthropic 範例: 私訊打 `/router cred add anthropic sk-ant-... --http https://api.anthropic.com --header x-api-key --default-header anthropic-version:2023-06-01`; worker 呼叫 `http_api(credential: "anthropic", path: "/v1/messages", json: {...})`. 沒有預設標頭時 worker 自帶 `headers: {"anthropic-version": "2023-06-01"}`.

## 特權技能

- 特權技能 (技能的 sudo bit): 技能帶 `privileged.json` 列出動作, owner 或 admin 以 `/router skill approve` 核准 (記下檔案雜湊, 改了自動暫停). 對話用 `run_skill` 呼叫, router 以 bwrap 專屬沙箱執行: 只讀技能與憑證資料夾 (`<stateDir>/creds/`), 只寫對話資料夾, 隱藏 router 的家目錄 (其他對話), stateDir, $HOME, config `sandboxDenyRead` 與放在這些位置以外的 router socket 檔 (見 [部署與維運](operations.md#安裝位置)); 輸出掃描憑證內容; 憑證被拒時執行 internal 的更新動作一次再重試; 每個對話每小時 10 次. 動作可以帶 http API 憑證 (`http`, 腳本拿到授權標頭的環境變數, key 會從輸出遮蔽); 單一參數可以限定角色 (`args.<名稱>.roles`), 較低角色帶這個參數就照一般流程觸發提權申請. 每天固定時間 (config `skillRefreshAt`, 預設 `"05:00"` GMT+8, `"off"` 關閉) router 對所有已核准技能執行一次被 `refresh` 指到的 internal 動作 (同樣的沙箱, 掛載, env 與雜湊檢查, 在 `<stateDir>/skill-refresh/<技能>/` 執行), 讓 cookie 不會放到過期: 雜湊不符就略過並通知 owner, 失敗通知 owner (輸出遮蔽憑證), 成功只記在 router log 與 `skill_runs` (對話欄位 `router:refresh`, 不算進任何對話每小時 10 次的限額). router 啟動一分鐘後補跑: 上次成功的每日更新超過 24 小時 (或從沒成功過) 的技能執行一次, 之後照每天的時間; 每次執行依序排隊, 不會重疊.

### 資料庫 store

- 動作可以有自己的資料庫, 讓 user 與 power 對話不用提權就能累積資料 (例如貼圖紀錄). privileged.json 的動作寫 `"store": {"STICKERS": "tg-sticker"}` (環境變數名稱 -> 資料庫名稱, 預設 append 模式), 或 `"store": {"STICKERS": {"name": "tg-sticker", "mode": "full"}}`. 資料庫名稱是小寫英數字與 `-`, 環境變數不能跟同一個動作的 creds, http, bots 重複, 也不能是 PATH, HOME 這類沙箱自己設定的名稱; internal 動作不能用.
- 位置: `<stateDir>/skill-store/<bot 資料夾名稱>/<資料庫名稱>/`, bot 資料夾名稱跟家目錄底下那隻 bot 的資料夾一樣 (`bot<id>`), 同一隻 bot 的所有對話共用一份, 技能裝在全部 bot 範圍時也是每隻 bot 各一份. stateDir 對所有對話與其他特權動作都隱藏, 所以資料庫只有宣告它的動作在執行時看得到.
- 執行時 router 把資料庫複製到 `<stateDir>/skill-store-work/run-*/<環境變數>/` (資料庫不存在就先建空的), 以可寫掛進這次的沙箱, 路徑放在 `$STICKERS`; 憑證被拒重試時重新複製一份. 動作 exit 0 才檢查, 否則整次不寫回 (只在回傳文字註明).
- append 模式的檢查: 原有的檔案與資料夾 (含子目錄) 一個都不能少; 一般檔案內容不能變; `.jsonl` 檔只能在尾端加 (舊內容必須逐位元是新內容的開頭, 舊內容要以換行結尾, 新加的內容要是合法 UTF-8 且以換行結尾, 每一行都是合法 JSON, 不能有空行); 可以新增檔案與資料夾, 新增的 `.jsonl` 一樣每行都要是合法 JSON.
- full 模式: 可以新增, 修改, 刪除, 跑完整個同步回資料庫. 只准用在 roles 只有 owner 與 admin 的動作上 (沒寫 roles 等於全部角色, 也不行); 不符時 privileged.json 讀取失敗, `/router skill approve` 回 privileged.json 有誤, 不接受這個技能.
- 兩種模式共同: symlink, 裝置檔, fifo 等非一般檔案一律不接受; 寫入的單檔上限 5 MB (append 的 `.jsonl` 算新加的部分, 其他算整檔), 一次執行所有資料庫加起來上限 20 MB; 寫入的內容含有這個動作的憑證內容 (cookie, http key, bot token) 也不接受. 全部通過才寫回, 先刪 (full), 再建資料夾, 檔案逐一寫成暫存檔再 rename 蓋上 (每個檔原子替換); 有一項不過就整次作廢, 資料庫不動, 對話收到原因, owner 收到通知 (跟其他特權技能通知同一個地方).
- 同一個資料庫的執行依序排隊 (同一隻 bot 所有對話共用一個鎖), 不會同時寫; 一個動作用多個資料庫時照固定順序全部拿到才執行.

### bot 憑證 bots

- 動作寫 `"bots": {"STICKER_BOT": "baldeagle"}` (環境變數名稱 -> 憑證名稱), 腳本拿到 `$STICKER_BOT_API` = `<apiRoot>/bot<token>` (config `apiRoot`, 預設 `https://api.telegram.org`), 例如 `curl "$STICKER_BOT_API/getMe"`. 只接受 telegram-bot 類憑證 (沒寫 kind 的就是), http 類或不存在時拒絕執行並說明. 跟 `http` 一樣, 憑證本身的 roles 與 methods 不套用在特權動作上 (由技能的核准與動作的 roles 把關); token 不進對話, 出現在回傳文字就遮蔽, 出現在對話資料夾寫出的檔案就刪除, 都會通知 owner; 寫進資料庫的內容含 token 時整次作廢.

## worker 端 SOP

- worker 端的 SOP 在 `/telegram:bot-skill`.

## 驗證

- `router/test/cred-flows.test.ts` (9 項, 模組層級) 與 `router/test/e2e-creds.test.ts` (7 項, 真的 router 對假的 Bot API 與本機假 HTTP 伺服器): 登記訊息的延遲刪除與取消 (私訊 60 秒, 發訊者, owner, admin 能取消, 其他人沒有權限; 群組 10 秒且不附按鈕; 被拒的立刻刪; 重啟後到期照刪), rotate 保留設定, 同名 add 的覆蓋 / 取消與逾時丟棄, 預設標頭 (補上, 被 worker 覆蓋, 不能是被擋的標頭, `/router cred header` 與 `/secret header` 的列出, 更新, rm), json_file (owner 與 admin 可讀資料夾外, user 與 power 限資料夾內, stateDir 一律拒絕, 大小上限, 非法 JSON, 與 json 互斥, 實際送出內容).
- `router/test/cred-http.test.ts`, `router/test/phase3-cred.test.ts`: key 放哪裡, worker 自帶標頭, /router help cred.
- `router/test/skillstore.test.ts` (18 項, 真的 bwrap): [資料庫 store](#資料庫-store) 兩種模式的寫回與每一種整次作廢 (刪檔, 刪資料夾, 改檔, 改 `.jsonl` 舊行, 非法 JSON 行, 空行, 沒以換行結尾, 單檔與單次上限, symlink, fifo, 腳本鎖住讀不到的資料夾), 動作失敗不寫回, full 只准 owner 與 admin 的動作, 其他宣告錯誤, 跨對話排隊, 對對話與其他動作隱藏; [bot 憑證 bots](#bot-憑證-bots) 的 `$<ENV>_API`, 只接受 telegram-bot, token 從輸出, 檔案, 資料庫擋下.
