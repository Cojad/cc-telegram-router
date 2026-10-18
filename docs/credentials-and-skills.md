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

- 特權技能 (技能的 sudo bit): 技能帶 `privileged.json` 列出動作, owner 或 admin 以 `/router skill approve` 核准 (記下檔案雜湊, 改了自動暫停; 有主機存取, 額外的對外 port, 不是 low 的套件或自訂來源的套件時先回確認畫面, 帶確認碼再核准一次; 帶 `pyproject.toml` 與 `uv.lock` 的技能先建好 Python 環境才記核准, 見[執行環境規格: 核准](skill-runtime.md#核准)). 對話用 `run_skill` 呼叫, router 以 bwrap 專屬沙箱執行, 環境見[執行環境規格](skill-runtime.md): 白名單檔案系統 (只有 `/usr`, 少數 `/etc` 檔, 唯讀的技能與憑證資料夾 (`/cctr/creds/<環境變數>`, 實際在 `<stateDir>/creds/`), 可寫的對話資料夾與私有 `/tmp`; router 使用者的家目錄, router 的家目錄 (其他對話), stateDir, 其他技能都不存在), 獨立的網路空間 (外網只開 port 80, 443, 53, 22, 可宣告 `outbound_ports` 多開; 連不到主機本機, 內網, metadata 與主機位址; 不能建 unix socket); internal 動作可以宣告主機存取 (`host`: 主機的 port, 唯讀掛載, 環境變數), 有 `host` 或 `outbound_ports` 的技能只有 owner 能核准; 共用工具箱 (ffmpeg, deno, uv) 在 `/cctr/tools/bin`, 動作用 `tools` 宣告需要的; Python 套件用 `pyproject.toml` 與 `uv.lock`, router 建的環境在 `/cctr/env` ([工具箱](skill-runtime.md#工具箱), [Python 套件](skill-runtime.md#python-套件-uv)); 輸出掃描憑證內容; 憑證被拒時執行 internal 的更新動作一次再重試; 每個對話每小時 10 次. 動作可以帶 http API 憑證 (`http`, 腳本拿到授權標頭的環境變數, key 會從輸出遮蔽); 單一參數可以限定角色 (`args.<名稱>.roles`), 較低角色帶這個參數就照一般流程觸發提權申請. 每天固定時間 (config `skillRefreshAt`, 預設 `"05:00"` GMT+8, `"off"` 關閉) router 對所有已核准技能執行一次被 `refresh` 指到的 internal 動作 (同樣的沙箱, 掛載, env 與雜湊檢查, 在 `<stateDir>/skill-refresh/<技能>/` 執行), 讓 cookie 不會放到過期: 雜湊不符就略過並通知 owner, 失敗通知 owner (附整段輸出的摘要, 遮蔽憑證與 router 的私有路徑), 成功只記在 router log 與 `skill_runs` (對話欄位 `router:refresh`, 不算進任何對話每小時 10 次的限額). router 啟動一分鐘後補跑: 上次成功的每日更新超過 24 小時 (或從沒成功過) 的技能執行一次, 之後照每天的時間; 每次執行依序排隊, 不會重疊.

### 資料庫 store

- 動作可以有自己的資料庫, 讓 user 與 power 對話不用提權就能累積資料 (例如貼圖紀錄). privileged.json 的動作寫 `"store": {"STICKERS": "tg-sticker"}` (環境變數名稱 -> 資料庫名稱, 預設 append 模式), 或 `"store": {"STICKERS": {"name": "tg-sticker", "mode": "full"}}`. 資料庫名稱是小寫英數字與 `-`, 環境變數不能跟同一個動作的 creds, http, bots 重複, 也不能是 PATH, HOME 這類沙箱自己設定的名稱; internal 動作不能用.
- 位置: `<stateDir>/skill-store/<bot 資料夾名稱>/<資料庫名稱>/`, bot 資料夾名稱跟家目錄底下那隻 bot 的資料夾一樣 (`bot<id>`), 同一隻 bot 的所有對話共用一份, 技能裝在全部 bot 範圍時也是每隻 bot 各一份. stateDir 對所有對話與其他特權動作都隱藏, 所以資料庫只有宣告它的動作在執行時看得到.
- 執行時 router 把資料庫複製到 `<stateDir>/skill-store-work/run-*/<環境變數>/` (資料庫不存在就先建空的), 以可寫掛進這次的沙箱, 路徑放在 `$STICKERS`; 憑證被拒重試時重新複製一份. 動作 exit 0 才檢查, 否則整次不寫回 (只在回傳文字註明).
- append 模式的檢查: 原有的檔案與資料夾 (含子目錄) 一個都不能少; 一般檔案內容不能變; `.jsonl` 檔只能在尾端加 (舊內容必須逐位元是新內容的開頭, 舊內容要以換行結尾, 新加的內容要是合法 UTF-8 且以換行結尾, 每一行都是合法 JSON, 不能有空行); 可以新增檔案與資料夾, 新增的 `.jsonl` 一樣每行都要是合法 JSON.
- full 模式: 可以新增, 修改, 刪除, 跑完整個同步回資料庫. 只准用在 roles 只有 owner 與 admin 的動作上 (沒寫 roles 等於全部角色, 也不行); 不符時 privileged.json 讀取失敗, `/router skill approve` 回 privileged.json 有誤, 不接受這個技能.
- 兩種模式共同: symlink, 裝置檔, fifo 等非一般檔案一律不接受; 寫入的單檔上限 5 MB (append 的 `.jsonl` 算新加的部分, 其他算整檔), 一次執行所有資料庫加起來上限 20 MB; 寫入的內容含有這個動作的憑證內容 (cookie, http key, bot token) 也不接受. 全部通過才寫回, 先刪 (full), 再建資料夾, 檔案逐一寫成暫存檔再 rename 蓋上 (每個檔原子替換); 有一項不過就整次作廢, 資料庫不動, 對話收到原因, owner 收到通知 (跟其他特權技能通知同一個地方).
- 同一個資料庫的執行依序排隊 (同一隻 bot 所有對話共用一個鎖), 不會同時寫; 一個動作用多個資料庫時照固定順序全部拿到才執行.

### bot 憑證 bots

- 動作寫 `"bots": {"STICKER_BOT": "baldeagle"}` (環境變數名稱 -> 憑證名稱), 腳本拿到 `$STICKER_BOT_API` = `<apiRoot>/bot<token>` (憑證自己的 `apiRoot`, 沒有就用 config 的 `apiRoot`, 預設 `https://api.telegram.org`; 見[自架 Bot API server](operations.md#自架-bot-api-server)), 例如 `curl "$STICKER_BOT_API/getMe"`. 用到的 apiRoot 在主機本機 (自架的 Bot API server, `http://127.0.0.1:<埠>`) 時, 沙箱在獨立網路裡連不到主機, router 把它換成 `http://10.0.2.2:<埠>` 並只放行那個 port (見[執行環境規格: 網路](skill-runtime.md#網路)). 只接受 telegram-bot 類憑證 (沒寫 kind 的就是), http 類或不存在時拒絕執行並說明. 跟 `http` 一樣, 憑證本身的 roles 與 methods 不套用在特權動作上 (由技能的核准與動作的 roles 把關); token 不進對話, 出現在回傳文字就遮蔽, 出現在對話資料夾寫出的檔案就刪除, 都會通知 owner; 寫進資料庫的內容含 token 時整次作廢.

### 終端機執行特權動作

驗收用: owner 在終端機以「某個對話, 某個角色」的身分跑一次特權動作, 或立刻跑一次某技能的憑證更新. 只有 owner 的終端機能用 (`cc-telegram-router cli`, 經 router socket), 在 Telegram 下 `/router skill run` 或 `refresh` 一律拒絕.

```bash
cc-telegram-router cli skill run <對話 key 或 chat_id> <技能> <動作> --out <資料夾> [--role <角色>] [--trial | --trial-store <資料夾>] [--api <http://127.0.0.1:埠>] ['<JSON 參數>']
cc-telegram-router cli skill refresh <技能>
```

- `skill run` 跟對話的 `run_skill` 走同一條路 (`runSkill`): 從那個對話的 bot 找技能 (這隻 bot 或全部 bot 範圍), 核准雜湊, 動作與參數的角色檢查, 參數格式, 沙箱, `creds`, `http`, `bots`, `store`, 輸出掃描與遮蔽都一樣. 角色預設是對話自己的角色, `--role` 改成扮演的角色 (例如對 owner 群組測 user 能不能跑, remove 會不會被擋). 參數限較高角色時一樣拒絕 (終端機不送提權申請).
- 輸出寫到 `--out` (必填, 絕對路徑, 不存在就建立), 腳本的工作目錄就是它; 不可以是 router 的家目錄本身, 也不可以在 stateDir, 正式資料庫, 任何 bot 資料夾或對話資料夾裡, 所以真的對話資料夾不會被寫到. 回傳文字第一行是 `skill run: ok`, `failed` (動作有執行但沒有成功, 或資料庫寫回被拒) 或 `refused` (沒有執行), 接著是身分與試跑說明, 然後是 run_skill 會回給對話的同一段文字 (`exit <碼>` 開頭).
- 試跑: `--trial` 把這隻 bot 的資料庫 (`<stateDir>/skill-store/<bot 資料夾名稱>/`) 複製一份到 `<stateDir>/skill-store-trial/run-*/`, 動作在複本上跑 (寫回的檢查照舊), 跑完刪掉, 正式資料庫完全不動. `--trial-store <資料夾>` 把複本留在指定的資料夾 (第一次用時從正式資料庫複製), 讓接連幾次執行共用同一份 (例如先 publish 再 remove), 用完由呼叫的人刪除; 位置限制同 `--out`. 試跑的回傳文字最後列出這次複本的變動 (新增, 修改含 `.jsonl` 行數, 刪除). `--api` 只能跟試跑一起用, 只接受本機網址 (`http://127.0.0.1`, `localhost`, `[::1]`): `bots` 憑證的 `$<ENV>_API` 改成 `http://10.0.2.2:<埠>/bot<token>` (沙箱在獨立網路裡, 經 slirp 的主機別名只連得到 `--api` 的那個 port, 所以假 Bot API 要聽在 127.0.0.1), 讓 publish, remove 這類動作用正式的技能檔案對本機假 Bot API 驗證, 不碰真的貼圖包.
- 紀錄與限額: 每次執行記進 `skill_runs`, 對話欄位是 `terminal:<對話 key>`, 跟對話自己的紀錄分得開; 終端機的執行**不算進**對話每小時 10 次的限額, 本身也不受限 (一次完整驗收就超過 10 次, 而終端機只有 owner). 原本要通知 owner 的事 (輸出含有憑證內容, 檔案在核准後被改過, 資料庫寫回被拒) 改附在回傳文字裡 (`[owner 通知]` 開頭), 不送 Telegram.
- `skill refresh <技能>`: 跟每日更新同一條路 (`refreshAll`, 同樣的沙箱, 掛載, env, 雜湊檢查, 在 `<stateDir>/skill-refresh/<技能>/` 執行), 只跑這個技能被 `refresh` 指到的 internal 動作, 其他已核准技能不跑 (以技能名稱比對: 同名技能在不同 bot 或全部 bot 範圍都核准時, 每一份都跑), 排進每日更新的同一個佇列 (不會跟每日更新重疊). `skill_runs` 記成 `terminal:refresh`, 不算每日更新 (啟動時的補跑仍看 `router:refresh`). 回傳每個動作的結果與最後幾行輸出 (遮蔽憑證), 失敗時的 owner 通知同樣附在回傳文字裡.
- 終端機等 router 回答最多 1 小時 (其他 cli 子指令 2 分鐘), 因為一次執行可能是動作的逾時兩次加一次憑證更新.

### 檢查技能草稿

worker 寫特權技能不用讀 router 原始碼: `/telegram:bot-skill` 寫明 privileged.json 的欄位, 執行時的環境 (工作目錄是對話資料夾, 參數整串比對, 技能資料夾唯讀, 私有 HOME, 環境變數名稱, exit code, 輸出掃描, 每小時 10 次, 改檔要重新核准), store 的規則, 各角色能做到哪裡, 以及一個完整範例 (活動報名清單: http 憑證, bots, store 的 append 與 full 一起用); worker 再用 `skill_check` 檢查.

- `skill_check` (path): 技能資料夾, 相對於對話資料夾 (例如 `skills/signup`), 只給名稱時是 `skills/<名稱>`. 只能是這個對話資料夾裡的路徑 (跟著符號連結算, 連到外面的拒絕).
- router 只讀檔案, 不執行任何程式: 用自己的 `loadManifest` 讀 privileged.json (它拒絕的內容就是 `/router skill approve` 會拒絕的, 原樣回報), 再檢查 `loadManifest` 放行但執行時會出錯的地方 (`run` 不是字串陣列, `{名稱}` 在 args 沒有, `{cred:X}` 在 creds 沒有, 技能裡找不到的腳本路徑, 不合法的 pattern 或 auth_failure, refresh 指到不存在的動作, timeout 不是正數), 以及提醒 (黏在其他字裡不會被替換的佔位符, 沒出現在 run 的參數, 沒有 pattern 的參數, 不認得的欄位與可能想寫的名稱, Python 沒加 `-B`, venv 不會被 install_skill 複製, 不是角色的名稱, 非 internal 動作的 mounts 與 env, http 與 bots 指的憑證在 config 裡不存在或類型不對; 只說名稱與類型, 不含值). 也檢查 install_skill 會拒絕的: 沒有 SKILL.md 或 frontmatter 缺 name, description, 資料夾名稱不是小寫英數與 `-`, 符號連結, 像 bot token 的字串. privileged.json 與 SKILL.md 是符號連結時不讀, privileged.json 超過 256 KB 不讀.
- 回傳第一行是 `skill check: ok` (可能附提醒數) 或 `skill check: 有 N 個錯誤要改`, 接著是錯誤與提醒 (每項說明怎麼改), 沒有錯誤時列出 `/router skill approve` 會列出的內容 (`describeActions`), 以及這個角色的下一步 (owner 與 admin: 先 skill_try 試跑, 再 install_skill 到 bot 或 all 範圍並核准; power: 先 skill_try 試跑, 再請 owner 或 admin 安裝並核准; user: 現在還不能安裝, 請 owner 或 admin 處理).
- guest 以外的角色都能用 (guest 不能寫檔, 沒有東西可檢查, router 拒絕). 不需要提權, 不計次, 不記進 `skill_runs`.

### 試跑技能草稿

`skill_try` (path, action, args, 選填 role, session, store_seed) 讓 power 以上的對話不用核准就跑一次草稿 (對話資料夾裡的技能, 同 `skill_check` 的 path) 的動作 (`router/skilltry.ts`). **user 對話一律拒絕** (guest 也是): 試跑的是還沒核准的程式, 要等之後的白名單沙箱才開放給 user, 回覆會這樣說明並建議先用 `skill_check`. 不走提權.

- 跟 `run_skill` 與終端機試跑走同一段 (`runPrepared`: 憑證檢查, 資料庫的鎖, 複本與寫回檢查, `buildArgv`, `sandboxArgv`, 輸出掃描與遮蔽), 不同的是: 沒有核准與雜湊檢查, 技能資料夾是草稿本身 (沙箱裡唯讀, 所以草稿裡的 venv 也用得到; 回傳提醒 install_skill 不複製 venv); internal 動作也能試, 但主機存取 (`host` 的 ports, mounts, env) 一律不給; timeout 最多 600 秒; 網路照正式執行的規則 (下一節).
- 憑證全是假的: http 憑證的 `$<ENV>_URL` 與 bot 憑證的 `$<ENV>_API` 指到沙箱裡 127.0.0.1 上的假服務 (`router/skilltry-fake.ts`, 先在沙箱裡啟動再執行動作; 編譯版 router 用自己的執行檔 `cc-telegram-router skilltry-fake <log> -- <指令>` 啟動它, 因為編譯版的原始檔只在執行檔內的虛擬路徑 `/$bunfs/root`, 不在磁碟上; 從原始碼跑時是 bun 加 `router/skilltry-fake.ts`, 見 `router/selfpath.ts`; Bot API 一律回 `{"ok":true,"result":true}`, http 一律回 `{"fake":true}`, 每個請求記下方法, 路徑, 標頭名稱, 大小與開頭 200 字), key 與 token 是每次隨機的假值 (標頭名稱與 scheme 照真的憑證), 從輸出遮蔽的方式跟真的一樣; creds 資料夾從空的開始. 真的 key, token, cookie 完全不進沙箱. 憑證在 config 裡不存在或類型不對時照樣給假值, 回傳註明核准後正式執行會拒絕.
- 資料庫從空的開始, 不從正式資料庫複製 (草稿可以宣告任何資料庫名稱, 複製等於讓 power 讀到這隻 bot 的共用資料). `store_seed`: 對話資料夾裡的資料夾, 每個子資料夾是一個資料庫, 只能有一般檔案 (符號連結, fifo 拒絕), 合計 20 MB 以內, 第一次建立試跑資料庫時複製進去. `session` (小寫英數與 `-`, 最多 32 字): 試跑資料庫與 creds 資料夾留在 `<stateDir>/skill-try/<對話 key>/s-<名稱>/`, 給之後同名的試跑共用, 最後一次使用後 24 小時清掉; 沒給 session 時用完即刪. 寫回檢查照 append 或 full 套在試跑資料庫上, 正式資料庫完全不動.
- 工作目錄 (唯一可寫的地方) 是 `<對話資料夾>/skill-try/<GMT+8 時間>-<動作>/`.
- `role`: 扮演的角色, 只能等於或低於這個對話 (或提權後) 的角色; 動作的 `roles` 與參數的 `args.roles` 照 run_skill 的規則拒絕, 試跑不送提權申請.
- 限額與紀錄: 每個對話每小時 20 次, 記進 `skill_runs` 的對話欄位 `try:<對話 key>`, 不算進 run_skill 每小時 10 次的限額. 原本要通知 owner 的事 (輸出含有憑證內容等) 附在回傳文字裡 (`[正式執行時會通知 owner]` 開頭), 不送 Telegram.
- 回傳第一行是 `skill try: ok`, `failed` (動作有執行但沒有成功, 或資料庫寫回被拒) 或 `refused` (沒有執行; 沙箱在設定網路前就結束時附上 bwrap 自己的錯誤訊息), 接著是草稿, 動作, 扮演角色, 輸出資料夾, run_skill 會回的同一段文字 (`exit <碼>` 開頭), 試跑資料庫的變動, 假服務收到的請求, 注意事項.

### 試跑的網路

試跑跟所有特權動作用同一個網路模組 (`router/sandboxnet.ts`, 規則與做法見[執行環境規格: 網路](skill-runtime.md#網路)): 外網只開 port 80, 443, 53, 22 與動作宣告的 `outbound_ports` (試跑 internal 動作也一樣, 不像正式執行不限 port), 連不到主機本機, 內網, metadata 與主機位址, 也不能建 unix socket; 沙箱自己的 127.0.0.1 是假服務. 缺少 `slirp4netns`, `nft`, `nsenter` 或設定失敗時 `skill_try` 拒絕執行並說明, 不會改成不隔離, 也不會改成完全不能連網.

## worker 端 SOP

- worker 端的 SOP 在 `/telegram:bot-skill`.

## 驗證

- `router/test/cred-flows.test.ts` (9 項, 模組層級) 與 `router/test/e2e-creds.test.ts` (7 項, 真的 router 對假的 Bot API 與本機假 HTTP 伺服器): 登記訊息的延遲刪除與取消 (私訊 60 秒, 發訊者, owner, admin 能取消, 其他人沒有權限; 群組 10 秒且不附按鈕; 被拒的立刻刪; 重啟後到期照刪), rotate 保留設定, 同名 add 的覆蓋 / 取消與逾時丟棄, 預設標頭 (補上, 被 worker 覆蓋, 不能是被擋的標頭, `/router cred header` 與 `/secret header` 的列出, 更新, rm), json_file (owner 與 admin 可讀資料夾外, user 與 power 限資料夾內, stateDir 一律拒絕, 大小上限, 非法 JSON, 與 json 互斥, 實際送出內容).
- `router/test/skillcli.test.ts` (10 項, 真的 bwrap 與本機假 Bot API): [終端機執行特權動作](#終端機執行特權動作)的參數解析 (JSON 參數含空白, `--out` 必填, `--api` 只限試跑與本機網址), `--out` 與 `--trial-store` 的位置限制, 以對話身分執行 (輸出只在 `--out`, `skill_runs` 記 `terminal:<key>`, 不算也不受對話每小時限額, `--role` 與參數角色檢查照 run_skill 拒絕, failed 與 refused 分開), `--trial` (正式資料庫不變, 複本刪除, 列出變動, 假 Bot API 收到呼叫, token 遮蔽), `--trial-store` (publish 後 remove 共用複本), 核准後被改過時通知附在回傳文字, `skill refresh` (排進佇列, 記 `terminal:refresh` 不算每日更新, 失敗遮蔽; 兩個已核准且有 refresh 的技能只 refresh 其中一個時, 另一個在 `skill_runs` 沒有紀錄, 憑證資料夾不動), `/router skill run|refresh` 只限 owner 終端機 (Telegram 裡 owner 的私訊與群組, admin 的私訊與群組都被拒且完全沒有執行).
- `router/test/skillcheck.test.ts` (7 項, 真的 bwrap 與本機假 API) 與 `router/test/e2e-setup.test.ts` 的 skill_check 一項: [檢查技能草稿](#檢查技能草稿)的每一種錯誤與提醒, install_skill 會拒絕的, 只讀對話資料夾裡的路徑, 不經符號連結讀檔, 憑證只報名稱與類型, 各角色的下一步, 不執行任何程式, guest 被拒; `/telegram:bot-skill` 的「範例: 活動報名清單」從說明書本身抽出, 通過檢查, 核准後照寫的樣子真的執行 (join, 重複報名失敗且不寫回, list, cancel 只限 owner 與 admin, key 與 token 不外流).
- `router/test/limits.test.ts` (9 項): 資源上限, `stop_exits`, 私有路徑遮掉, 時區, refresh 的完整摘要, 見[執行環境規格](skill-runtime.md)的驗證.
- `router/test/toolbox.test.ts` (6 項) 與 `router/test/skillenv.test.ts` (7 項): 工具箱, Python 環境與核准畫面, 見[執行環境規格](skill-runtime.md)的驗證.
- `router/test/whitelist.test.ts` (10 項, 1 項要 `LIVE=1`): [執行環境規格](skill-runtime.md)的白名單檔案系統, 網路, 主機本機的 Bot API, 主機存取 `host`, `outbound_ports` 與只有 owner 能核准, 見那份文件的驗證.
- `router/test/skilltry.test.ts` (12 項, 1 項要 `LIVE=1`; 真的 bwrap, slirp4netns, nft) 與 `router/test/e2e-setup.test.ts` 的 skill_try 一項: [試跑的網路](#試跑的網路) (主機 127.0.0.1 上的服務, 主機自己的位址, 169.254.169.254, 10.0.2.2, 其他內網位址都連不到, 沙箱自己的 loopback 連得到, DNS 指向 10.0.2.3, 沙箱裡改不了規則; `/run/docker.sock`, `/var/run/docker.sock`, dbus, `/run/user/<uid>/` 底下的 socket, 沙箱看得到的資料夾裡的 socket 都連不上, socketpair 與 TCP 照常; 外網只在 `LIVE=1` 實際連), [試跑技能草稿](#試跑技能草稿) (說明書的範例以 power 試跑: 假服務收到呼叫, 假 key 與 token 不外流, 正式資料庫不讀不寫, session, store_seed, 角色扮演與拒絕, user 與 guest 拒絕, internal 動作沒有主機存取, 回傳寫明外網開的 port, timeout 上限, 憑證不存在的提醒, 缺少網路工具時拒絕, 沙箱在設定網路前就結束時以 bwrap 的錯誤拒絕, 每小時 20 次且不算進 run_skill).
- `router/test/e2e-compiled.test.ts` (2 項): 用 `bun build --compile` 編出的 router (跟 `deploy/install.sh router` 一樣放進 stateDir 並複製 templates), 照 systemd unit 的方式啟動 (沒有 `--config`, 工作目錄是 stateDir, unit 的 PATH, 沒有 `/usr/sbin`), owner 對話的 plugin 呼叫 skill_try 跑說明書範例成功 (2.17.0 在正式環境就是這裡失敗, 從原始碼跑的測試抓不到); `router/selfpath.ts` 兩種執行方式的假服務指令與參數.
- `router/test/cred-http.test.ts`, `router/test/phase3-cred.test.ts`: key 放哪裡, worker 自帶標頭, /router help cred.
- `router/test/skillstore.test.ts` (19 項, 真的 bwrap): [資料庫 store](#資料庫-store) 兩種模式的寫回與每一種整次作廢 (刪檔, 刪資料夾, 改檔, 改 `.jsonl` 舊行, 非法 JSON 行, 空行, 沒以換行結尾, 單檔與單次上限, symlink, fifo, 腳本鎖住讀不到的資料夾), 動作失敗不寫回, full 只准 owner 與 admin 的動作, 其他宣告錯誤, 跨對話排隊, 對對話與其他動作隱藏; [bot 憑證 bots](#bot-憑證-bots) 的 `$<ENV>_API`, 只接受 telegram-bot, token 從輸出, 檔案, 資料庫擋下; 同一個動作同時用 store, bots, http.
