# 測試

[README](../README.md) 的文件索引列出所有文件.

## 執行

```bash
bun test router/test
```

輸出裡以「✅ 預期中 (測試刻意模擬, 屬正確行為)」開頭的行, 是測試刻意製造的錯誤 (例如模擬 db locked, disk full, 重複的訊息), 用來驗證 router 遇到這些狀況仍正常運作, 不是真的錯誤.

repo 根目錄的 `bunfig.toml` 設了 `[test] root = "router/test"`, 所以在 repo 根目錄直接跑 `bun test` 或 `bun run test` (package.json 的 `test` script 就是 `bun test router/test`) 也只會跑 `router/test` 底下的測試, 不會掃到上層或其他目錄. 不要在 repo 以外的上層目錄 (多個專案共用的工作區) 跑 `bun test`: bun 會把路徑含指定字串的檔案都當測試執行.

## 測試檔對照

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
| `router/test/poller.test.ts` | [輪詢與重試](operations.md#輪詢與重試)的輪詢: 重試間隔, 2 分鐘才通知與恢復通知, 409, 401, 429, 啟動時的 getMe, status 與通知文字 (e2e 另測 token 失效時經其他 bot 通知與 /router status); 指令回覆重試 (e2e 另測 502 後重送) |
| `router/test/store.test.ts`, `router/test/inbound.test.ts` | [訊息紀錄](architecture.md#訊息紀錄): 每隻 bot 各自一份 (私訊撞號, 同群組同一則), 舊紀錄分配 bot 一次 (對話, events, outbound, 時間, legacy), legacy 列用時間重新判斷一次, 重複丟掉時寫 log, 引用不跨 bot |
| `router/test/role-live.test.ts` | `LIVE=1` 才跑: 真的 claude 依各角色範本執行 (router 家目錄與 stateDir 都是臨時位置), 驗證 Claude Code 實際放行與擋下的事; 最後三條帶 user 對話的 hook, 驗證高風險工具真的觸發 PreToolUse 並被 router 擋下, owner 的一輪 ListAgents 自動提權放行, 傳給自己命名的 subagent 則放行; power 的 sandbox 看不到放在 home 與 stateDir 以外的 router socket |
| `router/test/portability.test.ts` | [安裝位置](operations.md#安裝位置): config `sandboxDenyRead` 與隱藏清單, 角色範本的 denyRead, 特權技能 bwrap (含真的 bwrap 在 /var/tmp 的安裝, 與連不上放在別處的 socket), 位置檔與 `register`, plugin 與 hook 經位置檔連上 router, `deploy/install.sh` 不預設位置 |
| `router/test/toolhistory.test.ts` | [工具呼叫紀錄](permissions.md#工具呼叫紀錄): 一筆的內容 (不存參數, 遮蔽與截斷), 寫入失敗只記 log, 30 天清除, 報表, `/router tools` 的權限與參數 |
| `router/test/dmrole.test.ts` | [角色](permissions.md#角色)的私訊: 每次讀私訊都是使用者角色 (config owners 是 owner, 每隻 bot 的私訊都跟著), 改角色時私訊的 settings 重寫並標記待輪替, `/router perm <私訊> role` 等同 `/router role` 與對應不到時拒絕, 覆寫保留, `/router status` 與 `/router chat` 顯示, config owners 增減, 高風險工具與 tool_history 讀使用者角色, 遷移 (對齊一次, ctx_v 加一) |
| `router/test/e2e-dmrole.test.ts` | 真的 router + 假 Bot API: 啟動時把有自己角色的私訊對齊使用者角色, log, settings 與 chat context 用使用者角色, 群組不變 |
| `router/test/risky.test.ts` | [高風險工具](permissions.md#高風險工具): 每個工具在各角色的放行與擋下, SendMessage 對自己的 subagent 與跨 session 的判斷, 自己的 subagent 名單存在 router.db 並綁定 worker 程序 (`own_agents`, `workerKey`), owner 與 admin 的一輪自動提權, 核准的申請只能允許一次, 按下的人角色要夠, hook 轉送 Agent 的名稱 |
| `router/test/autoelev.test.ts` | [自動提權](permissions.md#自動提權), [這一輪的發話者](permissions.md#權限檢查與提權), [使用者覆寫](permissions.md#使用者覆寫): 純 admin 一輪六個工具與跨 session 傳訊自動放行並記錄 (elev_log, 提權紀錄話題), 混合一輪不放行也不跳按鈕, power 一輪預設不放行但角色範本或使用者覆寫允許就放行, deny 覆寫, `riskyRefusal` 讀 settings, Stop 重置與進行中送入的訊息算兩輪, reaction 與終端機沒有發話者, router 啟動後等 Stop (`unknownTurns`) 與新程序立即判斷, 按鈕提權用同一套發話者, `/router perm user` 指令與權限檢查, 私訊標記待輪替 |
| `router/test/e2e-autoelev.test.ts` | 真的 router + 真的 hook + 真的 plugin client + 假 Bot API: router 啟動時已在跑的 worker 等 Stop, owner 的一輪在 user 群組自動提權 (hook allow, elev_log, tool_history 有效角色), user 與 owner 的訊息併成一輪被擋且不跳按鈕, `cli perm user` 後私訊 settings 帶覆寫 (群組不帶) 且他在群組的一輪以 user 放行 |
| `router/test/e2e-toolhistory.test.ts` | 真的 router + 真的 hook + 假 Bot API: 每個 PreToolUse 一筆紀錄 (含 owner 對話), user 的高風險工具被擋而 owner 不擋, 自己命名的 subagent, router 端 Telegram 工具的紀錄, `cli tools` |
| `router/test/e2e-ownagents.test.ts` | 真的 router (重啟兩次, 同一個 router.db) + 真的 hook + 真的 plugin client: 自己的 subagent 在 router 重啟後, 同一個 worker 的 plugin 重連就仍算數; plugin 沒連上時不算; 另一個 worker 程序打招呼時舊項目刪除; 讀不到程序啟動時間的 plugin 不算; 已不存在的對話的項目啟動時清掉 |
| `router/test/e2e-wake.test.ts` | 真的 router + 假 claude CLI (`fixtures/`, 假 worker 是真的程序): 私訊與群組各自一個 worker 且不串線, 被回收後自動喚醒, worker 不在時連發多則只喚醒一次且不掉訊息 |
| `router/test/requirements.test.ts` | README 的 Requirements 與 package 檔: 根目錄 package.json 沒有 v1 的 `bin` 與 `start`, plugin 版本與 repo 和 CHANGELOG 一致, 報表腳本一律用 python3 (shebang 與呼叫), curl, jq 與 matplotlib 列在強烈建議, 分類器的 API key 在依功能需要, repo 自己的程式與腳本不用 curl 與 jq |
| `router/test/context-chart.test.ts` | [cc / 報表腳本](operations.md#cc--報表腳本)的 `tg-context-chart.py`: 有 matplotlib 時寫 PNG, 沒有時 (PYTHONPATH 放一個 import 失敗的 matplotlib) exit 3, 文字圖 (各行接續到 100%, 有用量的類別至少八分之一格) 與安裝建議, 不寫 PNG; phase2 另測 relay 收到 exit 3 時送表格加文字圖 |
| `router/test/usage-report.test.ts` | [cc / 報表腳本](operations.md#cc--報表腳本): `/usage` 報表的列, 倒數只顯示最大的兩個單位, 燃燒速率 (柯姊的範例, 週期剛開始, 超速中, 接近重置, 用完, 跨年, 沒有 Weekly 或重置時間), 腳本可執行, 兩支 `.sh` 以假 tmux 送指令與離開畫面, `/status` 只印白名單欄位 |
| `router/test/channel.test.ts` | [廣播頻道](architecture.md#廣播頻道): 加入頻道的通知內容, /telegram:doc 的頻道一節 |
| `router/test/reactions.test.ts` | [表情回應](operations.md#表情回應-reaction): `allowed_updates` 含 `message_reaction` 且保留空清單的所有類型, config `receiveReact` (預設, 三個值, 寫錯), 三個值的篩選, 名稱的清理與匿名管理員, 換表情與收回只算最終狀態, 摘要格式, 下一則訊息時取走, 1 分鐘 debounce (可注入的計時器與縮短的真計時器), 停止時全部取出並送出 (ack, 沒連上的排隊, 對話不見, 逾時與例外不卡住), 50 則上限, `bot_messages` (各種回應, 每隻 bot 分開), `/router chat react` 與 `/router chat` 的顯示 (管理員註記) |
| `router/test/e2e-reactions.test.ts` | 真的 router + 真的 hook + 真的 plugin client + 假 Bot API: getUpdates 的 `allowed_updates`, botself_only 只收對 bot 訊息的表情並附在下一則訊息前, 單獨送出 (debounce 重新計時, router 名義, 不帶發送者, 不顯示 🤔, 不借前一則訊息發送者的角色提權), `/router chat react all` 與 `disable`, 不是管理員的群組在 `/router chat` 註明, 私訊同樣運作, SIGTERM 時連線中的 worker 在 router 結束前收到還沒送的表情, 沒連上的私訊留在佇列不叫醒; 對照組: 一般訊息的那一輪照常顯示 🤔 與在對話裡詢問提權 |
| `router/test/e2e-channel.test.ts` | 真的 router + 假 Bot API 送 channel_post: 頻道貼文 (含編輯, 指令) 只進 events, 就算列在 access.json 也不建立對話不送 worker, bot 不在頻道發言; 加入頻道時通知 owner |

各功能的驗收項目與對應的測試如下. 文件與測試要互相呼應: 改了文件的描述, 檢查對應的測試是否還成立; 改了測試, 回頭檢查文件, 兩者同一個 commit 送出.

## Phase 1 驗收對照

| 驗收項目 | 測試 |
|---|---|
| 私訊與群組各自一個背景 session, 回覆不會跑錯對話 | e2e-wake「DM and group each get their own worker…」, e2e「a plugin for the conversation gets…」(user 對話送往別的 chat 被擋) |
| worker 被回收後再傳訊會自動喚醒 | e2e-wake「a reaped worker is woken by the next message…」 |
| 連續快速傳多則只喚醒一次, 不掉訊息 | e2e-wake「a burst while the worker is down…」, phase1「unacked deliveries are sent again…」 |
| 每個 update 與送出的 payload 都在 db | e2e「every update is logged…」, e2e「…its reply goes out and is logged」 |

## Phase 2 驗收對照

| 驗收項目 | 測試 |
|---|---|
| 指令的權限與拒絕訊息符合規劃 03 指令表 | phase2 的指令測試 (users 被拒, admin 的限制, bot token 只限 owner 私訊, access, chat, session, config, 列表) |
| bot rotate 不斷線 | e2e「bot rotate (owner DM)…」: 輪詢換到新 token, 含 token 的訊息被刪, 換線後的訊息照常送達 |
| 指令執行後下一則訊息帶 router_log | e2e「a /router command is answered by the router…」 |
| compact 與喚醒後 chat_context 會補回 | phase2「SessionStart hook puts the chat_context back after compact」, e2e-wake「a reaped worker is woken…」(新連線帶 chat_context) |

## Phase 3 驗收對照

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

## 10b 對話專屬密鑰驗收對照

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

## 頻道驗收對照

| 驗收項目 | 測試 |
|---|---|
| 頻道貼文 (含 edited_channel_post) 只寫進 events (/secret 值遮蔽), 不建立對話, 不送 worker, 頻道裡的指令不回應 | e2e-channel「channel posts only go to events…」 |
| bot 被加入頻道時通知 owner: 頻道名稱與 id, 尚未支援, GitHub issues 連結 | channel「channelJoinNotice: …」; e2e-channel「added to a channel: …」 |
| 實際頻道: 加 bot 為管理員, 發貼文 | 上線實測 (測試帳號) |

## 10e 原始事件與密鑰保護驗收對照

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
| 工具說明, /telegram:doc 與 docs/secrets.md 同步 | rawvault「docs: …」 |

## 工具呼叫分類器 (第一階段) 驗收對照

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
| 題目第 2 版: 原子是非題取最大值當 p_block, 各題機率存 parts; 一般工具與 Telegram 工具各自的題目; 等級描述行為; claude 同樣的題目 | classifier「questions v2: …」「Decisions judge: …」「Jev judge: …」「OpenRouter judge: …」「claude judge: …」; e2e-classifier「Telegram tools are judged router-side…」(parts) |
| chat id 分開遮 (`<this-chat>`, `<other-chat-N>`), Telegram 工具附 `target`, 說明解釋遮蔽代號 | classifier「masking: …」「the message that started the turn…」「Telegram tools (router-side)…」; e2e-classifier「a user call the rules allow…」「Telegram tools are judged router-side…」 |
| 報表可只看某一版題目 (`v1` / `v2`), 單筆顯示版本與各題機率 | classifier「report by question version…」「/router classifier: …」 |
| Cloudflare Clef 與 Clef Flash 是各自獨立的兩家 (OpenRouter, 自己的模型與上限), 可單獨關閉 (不跑不留紀錄), 報表各一行, 一致率與意見不同的也列 | classifier「config: …」「Clef and Clef Flash: …」; e2e-classifier「a user call the rules allow…」「/router classifier from the owner terminal…」; e2e-classifier-off「on with no credentials…」 |
| 每家每天上限 (GMT+8 日界; claude 預設 $50, 以 total_cost_usd 換算值計), 超過當天停; 併發上限與略過 | classifier「config: …」「daily cap per provider…」「busy: …」 |
| 走 OrcaRouter 時要求並記錄實際費用 (`usage.cost_usd`, 沒有記 0 並註明), 說明裡留 `X-Orca-Request-Id`; TypeSafe 原生不帶這個標頭 | classifier「Jev through OrcaRouter: …」「Jev judge: …」 |
| Decisions 與 Jev 預設走 OpenRouter 的 `/api/alpha/decisions` (Jev 式請求, `usage.cost` 當實際費用, 不換算); 原生 `/v1/decisions` 與 `/v1/systemone` (TypeSafe, OrcaRouter) 由 config `api` 選 | classifier「config: …」「OpenRouter judge: …」「Decisions judge: …」「Jev judge: …」; e2e-classifier「a user call the rules allow…」 |
| 報表: 一般工具與 Telegram 工具分開, 各家數字與跟 claude 的差異, 實際費用與 claude 訂閱用量 (API 換算) 分開, 單筆詳情, 只限 owner | classifier「report: …」「/router classifier: …」; e2e-classifier「/router classifier from the owner terminal…」 |
| 保留 30 天 | classifier「purge: …」 |

## 安裝位置驗收對照

| 驗收項目 | 測試 |
|---|---|
| 角色範本不寫死路徑: sandbox 隱藏 router 家目錄, 不在家目錄底下的 stateDir, `sandboxDenyRead` 與 `~`, 自己的資料夾與共用技能再打開; 隱藏清單沒填入就拒絕產生 settings | portability「role templates follow the install…」「fill splices a list…」; phase1「user settings…」 |
| `sandboxDenyRead`: 絕對路徑才收, 寫錯只略過並警告, router 照常啟動; 互相包含的路徑只留最外層 | portability「config sandboxDenyRead…」「hiddenPaths…」 |
| `/router perm path read` 可以打開隱藏路徑裡的子目錄, 隱藏清單不變 | portability「role templates follow the install…」 |
| 特權技能 bwrap: tmpfs 隱藏同一份清單 (存在, 不在 /tmp 底下, 不重疊), 都在 bind 之前; 真的執行時看不到其他對話, 家目錄以外的 stateDir 與 `sandboxDenyRead` | portability「skill bwrap: tmpfs over /tmp…」「skill bwrap, real run: other conversations…」 |
| config `socket` 在 home, stateDir 與 `sandboxDenyRead` 以外時, 隱藏清單列入 socket 檔本身 (不是它的資料夾); 系統資料夾, 使用者家目錄與它的上層不列; 角色範本的 denyRead 帶到它 | portability「hiddenPaths: a socket outside…」 |
| 特權技能 bwrap: 隱藏的檔案蓋 `/dev/null`, 資料夾蓋 tmpfs, 不存在的略過; 真的執行時連不上放在別處的 socket, 同資料夾其他檔照常可讀 (沒列入時連得上) | portability「skill bwrap: a hidden file…」「skill bwrap, real run: a router socket…」 |
| 真的 claude: power 的 sandbox 看不到放在別處的 router socket (不是 socket 型別, 連不上), 同資料夾其他檔照常可讀 | role-live「power: a router socket outside…」(LIVE=1; 2026-10-17 Claude Code 2.1.302 通過: `character special file`, 連線 `Operation not permitted`) |
| plugin 與 hook 從位置檔找到 router (含 owner 的終端機 session); 沒有位置檔時 plugin 說明原因, hook 不准跳出 sandbox | portability「plugin finds the router…」「cc-hook finds the router…」「findRouter…」 |
| `register` 依 config.json 寫位置檔; router 啟動只在位置檔指向自己時更新, 不會建立或改寫別人的 | portability「cc-telegram-router register…」「locator…」 |
| `deploy/install.sh` 不預設安裝位置, 沒指定也沒有位置檔就停下說明 | portability「install.sh: no fixed default…」 |
| 真的 claude: power 讀不到其他對話與 stateDir | role-live「power: runs python…」(LIVE=1) |

## 工具呼叫紀錄與高風險工具驗收對照

| 驗收項目 | 測試 |
|---|---|
| 每個經過 PreToolUse 的呼叫記一筆 (所有角色, 含 owner): 時間, 對話, 對話角色, 有效角色, 工具, 決定與原因, 收件對象, 是否 subagent | toolhistory「hookUse: …」「record: writes one row…」; e2e-toolhistory「every PreToolUse is a tool_history row…」 |
| 不存工具參數; 原因與收件對象遮蔽密鑰並截斷 | toolhistory「record: writes one row…」「maskShort: …」; e2e-toolhistory「every PreToolUse…」(do-not-store) |
| 主 session 的 Telegram 工具在 router 執行時記錄, 不重複 | e2e-toolhistory「a Telegram reply the router runs…」 |
| 寫紀錄失敗只記 log, 不影響放行 | toolhistory「record: a failing write is only logged…」 |
| 保留 30 天 (啟動時與每天清) | toolhistory「purge: …」 |
| 報表 `/router tools [天數]` 與 `cli tools [天數]`: 依工具計次, 依角色分欄, 提權, 被擋; 只限 owner 與 admin | toolhistory「toolReport: …」「/router tools [天數]: …」; e2e-toolhistory「cli tools [天數]…」 |
| ListAgents, RemoteTrigger, CronCreate, CronDelete, ScheduleWakeup, PushNotification: power 以下擋下, admin 與 owner 放行, 原因清楚 | risky「riskyRefusal: …」「every high-risk tool in every conversation role…」; e2e-toolhistory「every PreToolUse…」 |
| SendMessage: 自己的 subagent (agent id; Agent 的 name 要等 SubagentStart) 與 subagent 回報 main 放行, 其他 session, `name [ref]`, `uds:`, `bridge:`, 不認得的名稱擋下 | risky「SendMessage: own subagents…」「cc-hook forwards an Agent call's name…」; e2e-toolhistory「every PreToolUse…」 |
| 自己的 subagent 名單存在 router.db (`own_agents`): router 重啟後同一個 worker 的 plugin 重連就仍算數; plugin 沒連上不算; 另一個 worker 程序 (同 session id 也算) 打招呼時舊項目刪除, 回到舊的 worker key 也不會復活; SubagentStop 不移除; plugin 沒連上時的 SubagentStart 不記; 等 SubagentStart 的名稱不跨 worker; 每個 worker 留最新 500 筆; 30 天前與已不存在的對話的項目清掉; worker 以 session, pid 與程序啟動時間辨認, 讀不到啟動時間 (程序不在, 沒有 /proc) 就不算 | risky「own subagents are kept in router.db…」「own subagents: a SubagentStart with no worker…」「own_agents rows…」「workerKey…」; e2e-ownagents「own subagents survive a router restart…」 |
| 發話者都是 admin 以上的一輪自動放行 (見下方自動提權驗收); 核准的申請只能允許一次 (沒有永久允許), 按下的人要 admin 以上; 核准後 subagent 可用, 主 session 照舊被擋 | risky「elevation: an owner's turn…」「elevation: a power sender…」「a power conversation…」 |
| 這些工具在真的 Claude Code 會觸發 PreToolUse 並被 router 擋下 (`CronDelete` 例外, 不觸發 hook, 照實記錄), 一般成員的一輪不在對話裡詢問; owner 的一輪 ListAgents 自動提權, Claude Code 照 hook 的 allow 執行; 傳給自己命名的背景 subagent 放行, 其他名稱擋下 | role-live「user: the high-risk tools reach PreToolUse…」「user: an owner's Telegram turn makes ListAgents at once…」「user: SendMessage to its own named subagent…」(LIVE=1, 自動提權那條尚未實測) |

## 自動提權與使用者覆寫驗收對照

| 驗收項目 | 測試 |
|---|---|
| 這一輪的發話者 = 上一次 Stop 以來送入的所有訊息的發話者, 取角色最低; 一輪進行中送入的訊息算這一輪也算下一輪; Stop 後重置 | autoelev「the people of a turn: Stop starts afresh…」「a mixed turn…」 |
| reaction 摘要的送入不算發話者, 只由它開始的一輪沒有發話者; 終端機的一輪沒有發話者 | autoelev「the people of a turn…」; e2e-reactions「a while after the last reaction…」 |
| router 啟動時已在跑的 worker 到下一次 Stop 前沒有發話者; router 啟動後才開始的 worker 程序立即判斷 | autoelev「after the router starts (unknownTurns)…」; e2e-autoelev「a worker running when the router started…」; e2e-rawvault「event_raw goes by who started the turn…」 |
| 純 admin (或 owner) 一輪: 六個高風險工具與跨 session 的 SendMessage 直接放行, 不開 subagent, 不跳按鈕, 以最低角色執行 | autoelev「a pure admin turn…」; risky「elevation: an owner's turn…」「a power conversation…」; e2e-autoelev「a worker running when the router started…」 |
| 每次自動放行都記錄: elev_log `auto` 與提權紀錄話題 (發起者, 角色, 工具, 收件對象, subagent), tool_history 的決定, 有效角色與原因 | autoelev「a pure admin turn…」「the record goes to the 提權紀錄 topic…」; e2e-autoelev「a worker running when the router started…」 |
| 混合一輪 (user + admin): 不自動放行, 也不在對話裡跳按鈕 (高風險工具與其他越權都一樣) | autoelev「a mixed turn…」「the button elevation uses the same people…」; risky「elevation: a power sender…」; e2e-autoelev「a user's message and the owner's…」 |
| power 一輪預設不放行; 角色範本或使用者覆寫的 allow 規則 (只寫工具名稱) 允許時放行; deny 規則所有角色都擋 | autoelev「a power turn…」「riskyRefusal reads the settings…」 |
| 其他被擋的動作 (路徑, 網路, sandbox) 照 subagent 提權流程 | autoelev「a pure admin turn…」(重導向寫檔仍詢問) |
| `/router perm user <使用者> show\|tool\|path\|net\|mcp\|reset`: owner 與 admin, admin 不能異動 owner, power 不能下; send 與 pkg 只能掛在對話 | autoelev「/router perm user: …」 |
| 使用者覆寫在任何對話的自動提權重算時套用 | autoelev「a power turn…」; e2e-autoelev「/router perm user from the terminal…」 |
| 使用者覆寫寫進他私訊的 settings (群組不變), 私訊標記待輪替, `/router perm <私訊> show` 列出 | autoelev「/router perm user: …」; e2e-autoelev「/router perm user from the terminal…」 |

## 私訊角色驗收對照

| 驗收項目 | 測試 |
|---|---|
| 私訊的有效角色是使用者角色 (config owners 是 owner), 每隻 bot 的私訊都跟著; 群組與頻道保留自己的角色; 私訊不能單獨設角色 | dmrole「a DM's role is its user's role on every read…」; phase1「owner DM gets the owner role…」 |
| 改使用者角色 (`/router role`): 他的私訊 settings 重寫, 標記待輪替, 回覆列出私訊, 私訊的 worker 收到 router log | dmrole「/router role: the user's DMs…」 |
| `/router perm <私訊> role` 等同 `/router role` (同樣的檢查與效果, 回覆說明); 對應不到使用者時拒絕並提示 `/router role` | dmrole「/router perm <私訊> role is /router role…」「…with no user behind the chat id…」 |
| 私訊的權限覆寫保留, 疊在使用者角色上; `perm show` 標明是使用者角色 | dmrole「a DM's perm overrides stay…」 |
| `/router status` (與 `cli status`, 同一個指令) 與 `/router chat` 的私訊顯示使用者角色 | dmrole「/router status and /router chat show the user's role…」; phase2「/router config, /router chat and /router log…」 |
| config owners 增減: 那些人的私訊跟著改 | dmrole「config owners changed…」 |
| 讀對話角色的檢查 (高風險工具, tool_history 的對話角色) 在私訊讀到使用者角色 | dmrole「role checks that read the conversation role…」 |
| 遷移: 私訊存的角色對齊使用者角色一次, 讀取一律不用舊值, ctx_v 加一; 啟動時對齊, log, 標記待輪替, settings 與 chat context 用使用者角色 | dmrole「migration: …」; e2e-dmrole「at start a DM's stored role is aligned…」 |

## 表情回應驗收對照

| 驗收項目 | 測試 |
|---|---|
| 設定 `receiveReact` 三個值 (`all`, `botself_only`, `disable`), 每個對話用 `/router chat react` 設定, 全域預設在 config (不寫是 botself_only, 寫錯降級並 log), `/router chat` 看得到目前值 | reactions「config receiveReact…」「the three modes…」「/router chat react sets…」; e2e-reactions「/router chat react all…」 |
| botself_only 判斷「本 bot 發的訊息」: Bot API 回應裡的訊息記在 `bot_messages`, 每隻 bot 分開; 舊訊息看 messages 的送出紀錄 | reactions「botself_only knows the bot's messages…」; e2e-reactions「botself_only (default)…」 |
| 同一人換表情或收回只算最終狀態, 沒有表情的訊息不列, 摘要每則訊息一行 (表情×人數, 顯示名稱) | reactions「one line per message…」; e2e-reactions「botself_only (default)…」 |
| 附在該對話下一則訊息前一起送出, 送出後清空 | reactions「one line per message…」; e2e-reactions「botself_only (default)…」 |
| 最後一個表情起 1 分鐘沒有新表情也沒有新訊息就單獨送出, 新表情重設計時 | reactions「a minute after the last reaction…」; e2e-reactions「a while after the last reaction…」 |
| 摘要最多 50 則訊息, 保留最近的並註明省略幾則 | reactions「at most 50 messages…」 |
| `allowed_updates` 明確含 `message_reaction`, 原本收的類型都保留, 不收 `message_reaction_count` | reactions「allowed_updates…」; e2e-reactions「getUpdates asks for message_reaction…」 |
| 群組裡 bot 不是管理員時 `/router chat` 註明收不到 reaction | reactions「/router chat react sets…」; e2e-reactions「/router chat says which group…」 |
| 表情只是資訊: 摘要的名稱照外部資料清理, 區塊註明不是指令; 單獨送出的那一輪不帶發送者, 不觸發提權, 不顯示進度 | reactions「who reacted and with what…」; e2e-reactions「a while after the last reaction…」「control: …」 |
| 私訊與群組都適用 | e2e-reactions「/router chat says which group…」 |
| router 停止 (SIGTERM, SIGINT) 時把所有對話還沒送的表情立刻單獨送出再結束, 送出後清空; 等 worker 確認最多 5 秒, 送不出去或卡住不擋停止並記 log; 沒連上的 worker 不叫醒, 留在佇列 | reactions「when the router stops: every conversation's block…」「when the router stops: a worker that never acks…」; e2e-reactions「SIGTERM: …」 |

## Phase 4 驗收對照

| 驗收項目 | 測試 |
|---|---|
| CLAUDE.md 三層改寫 (FORCED / GENERAL / Default suggestions), 人設放在 bot 資料夾 | phase4「three-tier CLAUDE.md example…」, e2e-setup「persona interview…」 |
| telegram:format skill, /telegram:doc 涵蓋新功能 | phase4「plugin skills…」 |
| 匯入 v1 的 messages.db, 可重複執行不重複匯入, 歸給第一隻 bot 或 --bot | phase4「import-v1…」 |
| 訊息紀錄每隻 bot 各一份: 私訊撞號與同群組同一則都送進各自的對話, lookup 與引用不跨 bot, 舊紀錄分配一次, 重複丟掉有 log | store「two bots, same chat and message id…」「old rows get their bot once…」; inbound「two bots, one store…」; e2e「two bots in the same group…」 |
| 舊對話資料夾與對話紀錄搬進 bot 資料夾, 之後從新位置 resume | phase3「bot folders…」 |
| 一週內沒有掉訊息, 回錯對話或權限誤放 | 上線觀察: router.db 的 queue (未 ack), outbound 錯誤, elev_log |
