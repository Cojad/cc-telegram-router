# Changelog

格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/), 版本號採 [Semantic Versioning](https://semver.org/lang/zh-TW/). 日期與時間一律 GMT+8. 每個版本對應一個里程碑, 列重點, 細節見 git history 與 [docs/](docs/).

版本方案: 1.x 是官方 telegram plugin 的 fork 時期 (單一 session plugin); 2.0.0 起是 router 架構 (一個對話一個背景 session), 之後每個里程碑加一個 minor 版本. 版本依里程碑歸類, 標的時間是主要 commit 的時段, 同一時段裡的 commit 可能分屬不同版本. 尚未建立 git tag.

## [Unreleased]

### Added

- router 重啟不再讓提權失效 (柯姊 2026-10-17): 已核准待綁定的提權 (10 分鐘期限) 與已綁定的 subagent 存進 `router.db` 的 `elev_binds`, 比照自己的 subagent 名單綁定 worker 程序 (session id, plugin pid, 程序啟動時間), router 重啟後同一個 worker 的 plugin 重新打招呼就仍有效 (之前的呼叫等它, 最多到 hook 的期限); worker 換了程序或讀不到啟動時間就失效並刪除; subagent-stop, 撤銷, 到期照舊移除, 過期項目在啟動與每天清掉. 見 [docs/permissions.md](docs/permissions.md#權限檢查與提權).
- router 重啟後立刻認得這一輪的發話者: 每次投遞在 meta 加一個隨機的 `delivery` 標記 (`queue.tag`); prompt hook 把 prompt 裡 channel 標籤的 `chat_id`, `message_id`, `user_id`, `kind`, `delivery` 送給 router (不送名字與內容); 這一輪原本不明時 (router 啟動時 worker 已在跑), 每個帶發話者的標籤都對上 router 一小時內投遞給這個對話, 而且沒被更早的 prompt 提過的訊息才採用, 有一個對不上就照舊等 Stop. event_raw 與自動提權在重啟後的第一輪就能用. 見 [docs/permissions.md](docs/permissions.md#權限檢查與提權).
- hook 重試的斷路: router 從第一次連不到起超過 3 分鐘, 期間沒有任何一次連上時, PreToolUse 與 SubagentStart 改成每個請求只試一次就落回「放行, 但不准跳出 sandbox」, 不再每次等 45 秒; 任何一次連上就恢復正常的重試. 狀態存在使用者暫存位置 (`$XDG_RUNTIME_DIR/cc-telegram-router/`, 否則 `~/.cache/cc-telegram-router/`) 每個 router socket 一個小檔, 由所有 hook 程序共用, 原子寫入, 讀不到或壞掉當成正常. 見 [docs/permissions.md](docs/permissions.md#router-連不到時).
- API key 的全域憑證可以直接在私訊登記並指定 key 放哪裡 (柯姊 2026-10-17): `/router cred add <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [路徑...]`, `cred-import` 與 `/secret set` 同樣的寫法 (`--query` 與 `--scheme none` 是新的, config.json 與 `conv_secrets` 加 `query` 欄位). http 憑證沒寫路徑就是網址底下全部路徑 (只限 host), 原本是一條都不開. worker 的 `http_api` 可以用 `headers` 自帶額外標頭 (例如 Anthropic 的 `anthropic-version`), router 原樣轉送; key 所在的標頭, Authorization, Cookie, Proxy-Authorization 與名稱像認證的標頭一律擋下. `/router cred list` 的路徑與角色顯示 `全部`, `(無, 全部擋下)`, `(無, 沒有對話能用)`. 見 [docs/credentials-and-skills.md](docs/credentials-and-skills.md#http-憑證的-key-放哪裡).
- `/router help <主題>` (cred, secret, perm, bot): 完整用法與範例 (Anthropic, OpenAI, Google 的 http 憑證與 Telegram bot token, 在哪裡打, 訊息會刪除, key 不進 worker, /secret 與 /router cred 的差別); `/router help` 的 cred 那行寫出 `--http` 形式. `/telegram:doc` 新增「登記 API key 與 bot token」一節, worker 被問到時直接照著教. 見 [docs/operations.md](docs/operations.md#router-help-主題).
- router 重啟的空窗不再落回放行或擋下自己的 subagent: worker 的 PreToolUse 與 SubagentStart hook 連不到 router 時照時間表重試 (第 0, 3, 8, 15, 30, 45 秒, 整段最多 45 秒, `shared/retry.ts` 兩端共用), 6 次都連不到才落回原本的「放行, 但不准跳出 sandbox」; 其他進度事件照舊只送一次. hook 第一次嘗試時算出期限 (加 45 秒) 隨請求送給 router, 單次等待改成跟著期限 (原本 PreToolUse 寫死 5 秒), 套件審核維持 55 秒, 整段不超過 55 秒. SendMessage 給名單裡的自己的 subagent 而 worker 的 plugin 還沒重新連上時, router 等它打招呼再判斷 (同一個程序就放行), 到期限才擋. 有重試或等待時 router log 記一行. SubagentStart 的 hook 逾時由 5 秒改為 60 秒 (worker 輪替後生效). 見 [docs/permissions.md](docs/permissions.md#router-連不到時), [docs/operations.md](docs/operations.md#router-重啟).
- 高風險工具自動提權: `ListAgents`, `RemoteTrigger`, `CronCreate`, `CronDelete`, `ScheduleWakeup`, `PushNotification` 與跨 session 的 `SendMessage` 被擋時, 若這一輪每個發話者都有權限 (用他的角色重算對話 settings, 疊上他的使用者覆寫), router 在 hook 直接放行, 不開 subagent, 不跳按鈕, 以最低的角色執行; 照樣記 `elev_log` (`auto`) 與「📜 提權紀錄」話題, tool_history 記有效角色與原因. 不是每個人都有權限時 (例如一般成員與 admin 的訊息併成一輪), 只要這一輪有角色高於對話而且有權限 (含使用者覆寫) 的發話者, 就照原本流程在對話裡跳「允許一次 / 拒絕」, 沒有人夠格才只剩主動申請. 只寫工具名稱的 allow 規則 (角色範本或覆寫) 讓 power 以下也能用, deny 規則所有角色都擋. 其他被擋的動作照原本的 subagent 提權 (取這一輪最低的發話者). 見 [docs/permissions.md](docs/permissions.md#自動提權).
- 使用者覆寫 `/router perm user <uid|@username> show | tool | path | net | mcp | reset` (存 `router.db` 的 `user_overrides`, owner 與 admin, admin 不能異動 owner): 他發起的一輪在任何對話做自動提權重算時套用, 他按對話裡的提權按鈕時 (能否核准, 以及核准後 subagent 的每個呼叫) 也套用, 也寫進他自己私訊的 settings (先疊使用者覆寫再疊私訊覆寫, 私訊標記待輪替); 群組裡不改變 worker 的 sandbox. 見 [docs/permissions.md](docs/permissions.md#使用者覆寫).
- worker 收得到 Telegram 的表情回應 (message reaction): router 累積後整理成 `<reactions>` 區塊 (每則訊息一行, 表情×人數與顯示名稱, 換表情或收回只算最終狀態, 最多 50 則), 附在該對話的下一則訊息前, 或最後一個表情之後 1 分鐘沒有動靜時單獨送出 (不帶發送者, 不提權, 不顯示 🤔). 每個對話用 `/router chat react <all|botself_only|disable|default>` 設定, 全域預設 config `receiveReact` (預設 botself_only, 只收對 bot 自己訊息的表情, 依 `router.db` 新的 `bot_messages` 判斷). getUpdates 的 `allowed_updates` 改為明確列出原本的類型加 `message_reaction`; 群組裡 bot 要是管理員才收得到, `/router chat` 會註明. 見 [docs/operations.md](docs/operations.md#表情回應-reaction).
- router 停止或重啟 (SIGTERM, SIGINT, `/router restart`) 時先把每個對話還沒送的表情回應單獨送進 worker, 等確認最多 5 秒再結束, 重啟不再遺失; 沒連上的 worker 不叫醒, 留在佇列等下次啟動. 見 [docs/operations.md](docs/operations.md#表情回應-reaction).
- `cc /usage` 加上 Weekly (all models) 的燃燒速率: 完美速率, 當前速率與 ratio, 剩下的額度與倒數, 到重置剛好用完的每日上限, 可超速多少或要減速, 措辭照群組範例的輕快語氣 (算法見 [docs/operations.md](docs/operations.md#cc--報表腳本)).
- 工具呼叫紀錄: 每個經過 PreToolUse 的工具呼叫 (所有角色, 含 owner 對話) 與 router 端執行的 Telegram 工具記在 `router.db` 的 `tool_history` (不存參數, 只有工具, 決定與原因, SendMessage 的收件對象), 保留 30 天; 報表 `/router tools [天數]` 與 `cli tools [天數]` (owner, admin). 見 [docs/permissions.md](docs/permissions.md#工具呼叫紀錄).
- 測試分區: `router/test` 依功能分成 10 個區 (對照檔 `router/test/areas.ts` 寫明各區的測試檔與觸發的原始碼路徑), 另有安全相關為主加一條收訊到回覆冒煙測試的 std 套組 (約 19 秒). `bun run test:std`, `bun run test:area <區名...>`, `bun run test:changed [base]` (比對 git 改動, 跑 std 與受影響的區; 改到共用核心或對照檔沒涵蓋的路徑時跑全套並印出原因); `bun run test` 全套不變. `areas.test.ts` 檢查每支測試檔都屬於某一區. 見 [docs/testing.md](docs/testing.md#測試分區)

### Changed

- 提權看「這一輪的發話者」: 自上一次 Stop 以來送進 worker 的所有訊息的發話者 (一輪進行中插進來的也算, 而且也算下一輪), 取角色最低的人; 原本只看最後一則訊息的發話者, 一般成員先說 admin 接著說, 兩則併成一輪時被當成 admin 發起. 表情回應摘要不算發話者; router 啟動時已在跑的 worker 到下一次 Stop 前沒有發話者 (保守). 對話裡的提權按鈕也照這一套: 這一輪有人角色不高於對話就不詢問. 見 [docs/permissions.md](docs/permissions.md#權限檢查與提權).
- 私訊的角色就是使用者角色: 私訊不再有自己的對話角色, settings, 權限檢查, 提權比較, 套件審核, 分類器, 工具呼叫紀錄, `/router status` 與 `/router chat` 對私訊一律讀使用者角色 (config owners 是 owner), 改使用者角色 (`/router role`, config owners) 時他每隻 bot 的私訊 settings 重寫並在閒置時輪替. `/router perm <私訊> role` 改為等同 `/router role`, 對應不到使用者時拒絕; 私訊的權限覆寫保留. 啟動時把私訊存的角色對齊使用者角色 (log 一行, 標記待輪替). 原本把某人升成 admin 後, 他的私訊仍是 user. 見 [docs/permissions.md](docs/permissions.md#角色).
- 安裝位置可自選, 不再假設 `/x`: plugin 與 hook 從 `~/.config/cc-telegram-router/router.json` (位置檔, `cc-telegram-router register` 寫入, `deploy/install.sh router` 會執行) 找 router 的 socket 與家目錄, 不再寫死 `/x/cc/.router/router.sock`; `deploy/install.sh` 不再預設 `/x/cc/.router`, 第一次安裝要用 `CC_ROUTER_STATE` 指定, 之後從位置檔讀; 角色範本的 sandbox `denyRead` 由 `/x` 改為依安裝位置隱藏 router 的家目錄, 狀態目錄 (不在家目錄底下時) 與 config 新增的 `sandboxDenyRead` (額外要隱藏的路徑, 預設空), 特權技能的 bwrap 也一樣 (見 [docs/operations.md](docs/operations.md#安裝位置)). 原本裝在 `/x` 以外時 sandbox 看得到其他對話與 router 的資料.
- 高風險工具改成 power 以下要提權 (只能允許一次): `ListAgents`, `RemoteTrigger`, `CronCreate`, `CronDelete`, `ScheduleWakeup`, `PushNotification`, 以及 `SendMessage` 傳給這個對話自己的 subagent 以外的對象 (其他 session). hook 多轉送 Agent 呼叫的 `name`, `subagent_type` 與 SubagentStart 的 `agent_type`, 用來認得自己的 subagent. 實測 `CronDelete` 不觸發 PreToolUse, router 擋不到 (只能刪同一個 session 建的排程). 見 [docs/permissions.md](docs/permissions.md#高風險工具).
- `cc /status`, `cc /usage`, `cc /context` 的報表腳本收進 repo 的 `scripts/`, `deploy/install.sh router` 裝到 `<stateDir>/scripts`, router 改用這個位置 (原本是 `~/.claude/bin`). `/usage` 的解析與排版抽成 `scripts/usage_report.py`.
- README 的 Requirements: python3 (3.7 以上) 列為必要; 「選配」分成「強烈建議」(tmux, curl, jq, matplotlib 等) 與「依功能需要」(特權技能的工具, 分類器的 API key); bubblewrap 與 socat 附官方 sandbox 文件連結與 Ubuntu 24.04 AppArmor 的注意事項.
- 對話自己的 subagent 名單 (判斷 SendMessage 是不是傳給其他 session) 改存 `router.db` 的 `own_agents`, router 重啟後仍有效. 每筆綁定開它的 worker 程序 (session id, plugin 的 pid 與啟動時間, 讀不到啟動時間就不算), 只有 plugin 已重新連上的同一個 worker 的項目才算數, worker 換程序 (輪替, 重開, 新 session) 時舊項目刪除; 30 天前與已不存在的對話的項目每天清掉. 原本只存在記憶體, router 重啟前開的 subagent 會被當成跨 session 擋下. 見 [docs/permissions.md](docs/permissions.md#高風險工具).
- config `socket` 設在 router 家目錄, 狀態目錄與 `sandboxDenyRead` 以外時, sandbox 也藏住 socket 檔本身 (角色範本的 `denyRead` 與特權技能 bwrap, 檔案蓋上 `/dev/null`), 不藏它所在的資料夾; 系統資料夾與使用者家目錄 (含上層) 不會被藏. 原本這種設定下 worker 的 sandbox 連得到 router socket. 見 [docs/operations.md](docs/operations.md#安裝位置).
- `plugin/package.json` 的版本對齊 2.9.0.
- `cc /usage` 的倒數一律只顯示最大的兩個單位, 最小到分鐘 (`5d23h`, `8h5m`, `5m`), 原本週額度會顯示成 `143h15m`.
- `cc /context`: 腳本偵測 matplotlib, 沒有時不畫圖, 改送文字圖 (每個類別一段文字進度條, 從上一個類別的結尾接著畫到 100%) 與安裝建議; 有時照舊送圖.

### Fixed

- `/secret set` (與 `secret_from_handle`) 沒帶 `--http` 時, 不像 Telegram bot token 的值也會拿去呼叫 getMe: 現在比照 `/router cred add`, 不呼叫 getMe, 回覆它像哪種 key 與加上 `--http` 的打法, 訊息照樣刪除.
- `http_api` 的額外標頭改成只擋精確名單: key 所在的標頭, Authorization, Proxy-Authorization, Cookie 與 Host, Content-Type, Content-Length 等傳輸層標頭; 原本依名稱片段 (auth, token, api-key...) 擋, 會誤擋 `x-csrf-token` 這類. 用 `--query` 的憑證, path 裡不能自己帶那個參數. 見 [docs/credentials-and-skills.md](docs/credentials-and-skills.md#http-憑證的-key-放哪裡).
- 句子中間提到登記指令 (例如「我是要你教我 /router cred add 的用法」) 被判成含密鑰並準備刪除: 現在只有訊息開頭就是 `/secret set`, `/router cred add`, `/router bot add|rotate` (可加 `cc ` 前綴) 而且參數位置有值時才算; 格式比對與已登記的值不變. 見 [docs/secrets.md](docs/secrets.md#原始事件與密鑰保護).
- `/router cred add` 與 `cred-import` 沒帶 `--http` 時, 不像 Telegram bot token 的值 (例如 Anthropic key) 會被拿去呼叫 getMe, 回「getMe failed (404)」: 現在不呼叫 getMe, 回覆它像哪種 key 與加上 `--http` 的打法, 訊息照樣刪除.
- `/usage` 的重置日期在 12 月看到 1 月時算成下一年.

### Removed

- 根目錄 `package.json` 指向不存在的 `./server.ts` 的 `bin` 與 `start` (v1 遺留).
- `docs/v1/` (v1 單一 session plugin 時期的文件) 整個移除, README 與 docs 不再連到它.

## [2.9.0] - 2026-10-17

2026-10-17 07:27 ~ 10:46 的一批改進.

### Added

- 工具呼叫分類器 (選配, 第一階段只記錄): user 與 power 對話規則放行的工具呼叫, 以及 router 端執行的 Telegram 工具, 在背景交給判斷型模型 (OpenAI Decisions, TypeSafe Jev, Cloudflare Clef 與 Clef Flash, 固定 prompt 的 `claude -p`) 評分, 結果與實際費用寫進 router.db, 不影響放行. 預設走 OpenRouter 的 Decisions router, 可改走原生或 OrcaRouter; 題目第 2 版改成原子是非題. `/router classifier [天數] [v1|v2]` 報表.
- 特權技能每日更新憑證: config `skillRefreshAt` (預設 `"05:00"`, `"off"` 關閉), 啟動後補跑超過 24 小時沒成功的技能.
- router 自己輪詢 (`poller.ts`): 逐步拉長的重試, 斷線超過 2 分鐘才通知 owner, 409 與 401 (token 失效) 各自處理; `/router` 指令的回覆遇到暫時性錯誤會重送.
- 文字類附件在收到訊息時就下載並偵測密鑰, 下載結果保留 30 天 (以最後使用時間算) 供 `download_attachment` 沿用.
- user 角色可用 cut, sort, uniq, which, tr, seq, hostname (不帶參數), cd; 非 owner 角色可讀自己對話的工具結果檔.

### Changed

- 提權跟著那一輪的發話者: 在 worker 終端機打的一輪沒有發話者, 只看對話角色, 不在對話裡詢問; 它提出的申請不綁上一則 Telegram 訊息. `event_raw` 同樣以發話者判斷.
- 重導向 (`>` `>>`, `sort -o` 等) 寫檔視為寫入; 白名單比對只在引號外切段.
- 永久允許涵蓋不帶參數的指令; 撤銷時「✅ 提權成功」那則也標已撤銷. 跨對話傳訊的允許一次改名「允許這個對話」.
- 套件安裝: 選項的值不算套件; 改變來源的選項, URL, 本機路徑與 `-e` 安裝每次都送審, 核准只放行下一次完全相同的安裝.
- 時間一律 GMT+8 (log, worker 收到的訊息時間, 通知與報表), 不出現 UTC 或 Z.
- 訊息紀錄每隻 bot 各一份, 以 (bot, chat_id, message_id) 為唯一鍵, 舊紀錄升級時分配一次.
- bot 設定跟著 Telegram bot id: 同一隻 bot 加回時沿用既有設定, 名稱換成另一隻 bot 就重置.
- bot 設定提醒依柯姊定稿加粗, 以 HTML 送出; Telegram 拒收 HTML 時改純文字重送.
- 選配功能缺設定或設定錯時只關閉該功能並記 log, router 照常啟動.

### Fixed

- 兩隻 bot 同號的訊息不再被當成重複丟掉, 引用也不再拿到另一隻 bot 的訊息.
- 測試刻意製造的錯誤在輸出裡標成「✅ 預期中」.

## [2.8.0] - 2026-10-17

規劃 10e 原始事件與密鑰保護 (06:57 ~ 07:29).

### Added

- 每個 update 的所有字串都掃描密鑰 (已知格式, 登記指令的值, router 持有的值); `events` 存遮蔽版, 原文以 AES-256-GCM 加密存在 `event_raw`.
- 送進 worker 與 messages 表的內容換成代號; 審核群組新增第五個話題「🔑 密鑰偵測」.
- 服務中的對話裡貼出密鑰時回覆提醒, 5 分鐘後刪除原訊息 (可取消, 重啟後照常執行).
- `event_raw` 工具: owner 或 admin 的那一輪請固定 agent 回答原文相關的問題, 出口由程式檢查; `secret_from_handle` 把代號登記成對話密鑰; 明文只限 owner 終端機 `cli event raw`.

### Changed

- 廣播頻道暫不支援: 頻道貼文只寫進 events, 不建立對話; bot 被加入頻道時通知 owner.

## [2.7.0] - 2026-10-17

規劃 10b 對話專屬密鑰與相關改進 (03:04 ~ 05:38).

### Added

- `/secret set|list|rm`: 任何角色的對話都能登記自己的 bot token 或 API key, 值以 AES-256-GCM 加密存在 `conv_secrets`; bot token 登記前用 getMe 驗證; `--header` / `--scheme`.
- bot 設定提醒: 群組隱私模式 (依 getMe 顯示目前設定) 與 Bot-to-Bot Communication Mode 的說明.
- `/router` 指令以 chat id 跨 bot 指定對話 (`--bot <名稱>`, 對話 key).
- 群組的 worker 可以用 `reply` 的 `on_behalf_of` 回到提問者的私訊, 不用申請.

### Changed

- 憑證角色不足時跟其他越權動作一樣擋下並走提權.
- `/router config set claudeBin` 只限 owner.
- 技能先寫在對話資料夾的 `skills/<名稱>/`, 再由 `install_skill` 安裝.

### Security

- `bot_api` / `http_api` 的回應若回顯了 token 或 key, 先遮蔽再交給 worker.

## [2.6.0] - 2026-10-16

規劃 10d 特權技能 (11:22 ~ 22:39).

### Added

- 特權技能: 技能帶 `privileged.json`, `/router skill approve` 核准並記下雜湊 (改了自動暫停), `run_skill` 在 bwrap 專屬沙箱執行, 輸出掃描憑證, 憑證被拒時更新一次再重試, 每個對話每小時 10 次.
- 動作可以帶 http API 憑證; 參數可以限定角色, 較低角色走提權申請; internal 動作可以掛載額外的唯讀路徑.

### Changed

- 提權: router 重啟後, 對話裡的提權詢問拿回剩下的時間或過期; 只有對話裡還開著的詢問會擋住新的申請; 詢問顯示 MCP 工具的參數.
- plugin 的 `run_skill` 最多等 35 分鐘, 其他工具維持 120 秒.

## [2.5.0] - 2026-10-16

規劃 10c「cc /」代打改版 (09:56 ~ 10:13).

### Changed

- router 指令直接執行; `/status` `/usage` `/context` `/cost` 有專用報表 (`/context` 附圖); 其他指令只取輸出交給 worker 整理; `cc //指令` 截當下畫面.
- 代打前後都回到輸入提示, 留下的選單或畫面一律關掉; worker 忙碌時不送按鍵.

## [2.4.0] - 2026-10-16

憑證與三選一審核 (07:48 ~ 09:17).

### Added

- 跨 bot 技能的憑證 (`bot_api`, `/router cred add`, `cred-import`), 技能安裝範圍 (`install_skill`).
- HTTP API 憑證 (`http_api`), base64 回應存成對話資料夾裡的檔案.
- 審核三選一: 允許一次 / 永久允許 / 拒絕; 允許過的申請留「🚫 撤銷」按鈕, 每次使用記在「🧾 執行授權」話題.
- owner 與 admin 對話的 `bot_api` credential `self`.
- `/telegram:bot-skill` SOP.

### Changed

- 有了結果的申請, 進度回覆當初提出申請的那則訊息, 在其他地方按下時同步一份.
- bot 或全部 bot 範圍的技能, sandbox 裡的角色可以讀, 不能改.
- 提權涵蓋 router 端的工具 (提權 subagent 的 bot_api / http_api 以提權後的角色執行).

## [2.3.0] - 2026-10-16

Phase 4 (07:01).

### Added

- `import-v1`: 匯入 v1 plugin 的訊息紀錄, 可重複執行.
- 三層 CLAUDE.md 範例 (FORCED / GENERAL / Default suggestions), `/telegram:format` 與 `/telegram:doc`.

## [2.2.0] - 2026-10-16

Phase 3 權限 (06:07 ~ 06:47).

### Added

- 角色範本 (owner, admin, power, user, guest), `/router perm` 與權限覆寫.
- 先擋再問: 每個工具呼叫依對話角色檢查, 對話內提權詢問, `request_elevation` 向 owner 申請, 提權紀錄.
- 跨對話傳訊申請, 審核群組, power 的套件安裝審核.
- 新 bot 初次設定: 認領碼, 人設訪談, 審核群組; 對話資料夾搬進 bot 資料夾.

## [2.1.0] - 2026-10-16

Phase 2 指令與介面 (03:07 ~ 05:48).

### Added

- `/router` 指令, `chat_context` 與 `router_log`, 壓縮後補回 chat_context 的 hook.
- 「cc /」代打 Claude Code 的 slash command; 終端機 CLI (`cc-telegram-router cli`).
- 即時進度訊息 (v1 的 live progress hooks 移植到 v2).
- `/id`, 以 @username 或回覆指定角色, `/router session rotate`, `/router status`.
- router 離線時 plugin 告知 Claude, 恢復後列出要重送的.

## [2.0.0] - 2026-10-16

Phase 1 router 上線 (01:32 ~ 02:59, 驗收測試 03:53).

### Added

- router 本體: 輪詢 bot, 每個 update 與送出的 payload 寫進 `router.db`, 依 (bot, chat_id) 對應到對話, 第一次出現時建立資料夾與 settings.
- 每個對話一個 Claude Code 背景 session (`claude --bg`, 之後 `--resume`), 不在線時自動喚醒.
- plugin v2 (消費者模式): 不持有 token, 經 unix socket 跟 router 收發.
- `deploy/install.sh` 與 systemd user unit.

### Changed

- v1 的文件移到 `docs/v1/`.

## [1.1.0] - 2026-09-17

v1 功能追加 (2026-09-15 12:15 ~ 2026-09-17 10:04).

### Added

- `send_sticker` 工具.
- 回覆的 meta 帶 `reply_to_user_id` (被回覆訊息的發送者).
- Bot API Rich Message 支援.
- 回覆帶媒體的訊息時附 `reply_to_attachment_*` meta; 照片一律記下 file_id.
- live progress hooks 的說明 (`docs/v1/tg-live-progress-hooks.md`).

### Changed

- `lookup_message` 輸出改成精簡的 GMT+8 文字, 每筆固定兩行.

### Fixed

- `isMentioned()` 漏看 rich message 的內容.

### Removed

- 實驗性的 MTProto listener (2026-09-15 加入, 2026-09-16 移除).

## [1.0.0] - 2026-09-15

官方 telegram plugin 0.0.7 的 fork (07:41 ~ 09:16).

### Added

- 模組化: 拆成 policy, format, poller, outbound, transport, inbound.
- 回覆的 meta 帶 `reply_to_message_id` / `reply_to_text`.
- SQLite 訊息紀錄 (`store.ts`) 與 `lookup_message` 工具, 回覆引用自動補全.
- `TELEGRAM_STANDBY_ONLY` 開關; 第二個 session 啟動時不再殺掉正在執行的 poller.
- fork 與原版之間一鍵切換的部署腳本.
