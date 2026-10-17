# Changelog

格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/), 版本號採 [Semantic Versioning](https://semver.org/lang/zh-TW/). 日期與時間一律 GMT+8. 每個版本對應一個里程碑, 列重點, 細節見 git history 與 [docs/](docs/).

版本方案: 1.x 是官方 telegram plugin 的 fork 時期 (單一 session plugin); 2.0.0 起是 router 架構 (一個對話一個背景 session), 之後每個里程碑加一個 minor 版本. 版本依里程碑歸類, 標的時間是主要 commit 的時段, 同一時段裡的 commit 可能分屬不同版本. 尚未建立 git tag.

## [Unreleased]

### Added

- `cc /usage` 加上 Weekly (all models) 的燃燒速率: 完美速率, 當前速率與 ratio, 剩下的額度與倒數, 到重置剛好用完的每日上限, 可超速多少或要減速 (算法見 [docs/operations.md](docs/operations.md#cc--報表腳本)).

### Changed

- `cc /status`, `cc /usage`, `cc /context` 的報表腳本收進 repo 的 `scripts/`, `deploy/install.sh router` 裝到 `<stateDir>/scripts`, router 改用這個位置 (原本是 `~/.claude/bin`). `/usage` 的解析與排版抽成 `scripts/usage_report.py`.
- `cc /usage` 的倒數一律只顯示最大的兩個單位, 最小到分鐘 (`5d23h`, `8h5m`, `5m`), 原本週額度會顯示成 `143h15m`.

### Fixed

- `/usage` 的重置日期在 12 月看到 1 月時算成下一年.

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
