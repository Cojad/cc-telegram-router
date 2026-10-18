# cc-telegram-router

一隻 router 收 Telegram bot 的所有訊息, 每個 Telegram 對話 (私訊或群組) 交給一個獨立的 Claude Code 背景 session (`claude --bg`). 每個對話住在自己的資料夾, 有自己的 CLAUDE.md, memory 與 session (各層怎麼繼承, 誰能改, 存在哪裡見 [session 與記憶](docs/session-and-memory.md)), 回覆不會跑錯對話; worker 載入的 Telegram plugin 不持有 bot token, 所有收發都經 router 代為處理並記在 `router.db`.

權限依角色分開: 使用者與群組對話各有角色 (owner, admin, power, user, guest), 私訊的角色就是使用者角色, router 在每個工具呼叫前依對話角色檢查. 越權的動作先擋下, 再問: 發話者角色較高時直接在對話裡貼出提權詢問, 否則可以向 owner 申請; 跨對話傳訊與套件安裝也走審核, 核准過的授權可以撤銷, 每次使用都留紀錄. 密鑰 (bot token, API key) 一律由 router 保管與代呼叫, 不進 worker 也不以明文留在資料庫.

## 與上游的差異

上游是 Anthropic 官方 Claude Code Telegram channel plugin (`claude-plugins-official` 的 `telegram`, 0.0.7). 本專案從它 fork 出來 (v1), 再改寫成 router 架構 (v2); 收發 Telegram 的模組 (`router/telegram/`) 沿用 v1.

| 項目 | 上游 telegram plugin | cc-telegram-router |
|---|---|---|
| 架構 | plugin 在一個 Claude Code session 裡持有 token 並輪詢 | systemd 常駐的 router 持有 token 並輪詢; worker 的 plugin 經 unix socket 跟 router 收發 |
| 對話與 session | 所有允許的私訊與群組都進同一個 session | 每個對話一個背景 session 與資料夾, 不在線時自動喚醒 (`--resume`) |
| 多隻 bot | 一個 session 一隻, 多隻要各自設 `TELEGRAM_STATE_DIR` | 一隻 router 管多隻 bot (`/router bot add` / `rotate`), 資料夾以 bot id 命名; 每隻 bot 可以走官方或自架的 Bot API server |
| 存取控制 | 配對碼, 允許清單, 群組 mention (`/telegram:access`) | 沿用同一套 gate, 另加使用者角色與對話角色 |
| 權限 | Claude Code 的權限詢問轉到允許清單的私訊 (Allow / Deny) | 依對話角色的 settings 與 router 檢查每個工具呼叫; 先擋再問的提權, 三選一審核按鈕, 撤銷, 執行授權紀錄 |
| 管理介面 | 終端機的 `/telegram:access`, `/telegram:configure` | 安裝與修改設定用終端機的設定嚮導; Telegram 裡的 `/router` 指令, 終端機 CLI, `cc /指令` 代打 Claude Code 的 slash command |
| 訊息紀錄 | 沒有歷史與搜尋 | 每個 update 與送出的 payload 都在 `router.db`; `lookup_message`, 回覆引用自動補全 |
| 工具 | reply, react, edit_message, download_attachment | 另有 send_sticker, lookup_message, get_chat_context, bot_api, http_api, install_skill, skill_check, skill_try, run_skill, request_elevation, request_send_grant, event_raw, secret_from_handle, save_bot_profile |
| 憑證與密鑰 | bot token 存在 `.env` | 跨 bot 憑證與 HTTP API key 由 router 代呼叫 (worker 看不到值); 對話專屬密鑰 (AES-256-GCM) |
| 密鑰保護 | 沒有 | 每個 update 與文字附件都掃描密鑰, 存遮蔽版, 原文加密, 提醒並 5 分鐘後刪除原訊息 |
| 技能 | 沒有 | 三層技能範圍與 `install_skill`; 特權技能 (bwrap 沙箱, 雜湊核准, 每日更新憑證, 每隻 bot 一份的附加式資料庫) |
| 進度 | 輸入中提示 (typing) | hook 回報的即時進度訊息 |
| 輪詢與斷線 | grammY `bot.start`, 啟動時停掉舊的 poller | router 自己的重試規則, 斷線, 409, token 失效時通知 owner |
| 工具呼叫分類器 | 沒有 | 選配, 預設關閉; 第一階段只記錄 |

## Feature highlights

- **一個對話一個 session**: 私訊與群組各自一個 worker 與資料夾, 被回收後下一則訊息自動喚醒, 連發多則只喚醒一次且不掉訊息.
- **Session 隔離**: 每個對話是獨立的背景 session, context 各自分開; owner 以外的角色, 檔案工具只能碰自己的對話資料夾, Bash 跑在 Claude Code 的 sandbox (Linux 上是 bubblewrap) 裡, router 的家目錄, 狀態目錄與使用者家目錄 (另可設定額外路徑) 都被隱藏, 只開放自己的資料夾, 共用技能 (唯讀) 與 bot 的共用記憶 (admin 能改 bot 的 CLAUDE.md 與 memory, 其他角色唯讀; guest 在自己資料夾只能讀附件, 讀寫 CLAUDE.md 與 memory, 見 [session 與記憶](docs/session-and-memory.md)), 讀不到其他對話的檔案, 對話紀錄, router 的資料庫與憑證; 回覆只能送回自己的對話, 送往其他對話要經過核准. 特權技能另由 router 在 bwrap 專屬沙箱執行.
- **先擋再問的提權**: 越權就擋下並告訴模型改用不越權的方法; 發話者角色較高時在對話裡貼出「允許一次 / 永久允許 / 拒絕」, 按下的人以他的角色執行下一個 subagent.
- **審核與授權**: 跨對話傳訊, 套件安裝, 提權申請送到審核群組 (六個話題) 或 owner 私訊; 核准過的可以撤銷, 每次使用記在「🧾 執行授權」. 陌生人私訊拿到配對碼時, 申請貼在「🤝 配對申請」, owner 或 admin 按一下就能同意或拒絕.
- **密鑰不落地**: bot_api / http_api 由 router 代呼叫, 回應裡回顯的 key 先遮蔽; 對話可以自己登記密鑰, 不用提權.
- **原始事件與密鑰保護**: 貼進 Telegram 的 token 在 events 與 worker 看到的都是代號, 原文加密保存; owner 或 admin 可以請固定 agent 回答原文相關的問題, 出口由程式檢查.
- **特權技能**: 技能帶 `privileged.json` 列出動作, owner 或 admin 核准後由 router 在 bwrap 專屬沙箱執行, 檔案改了自動暫停.
- **Telegram 裡管理**: `/router` 指令管 bot, 角色, 權限, 憑證與 session; `cc /status` 這類指令由 router 開 tmux 代打給背景 worker.
- **每隻 bot 的資料庫**: 特權動作可以宣告 `store`, user 與 power 對話不用提權就能累積資料 (append 只能新增, 要刪改用 full 且限 owner 與 admin 的動作), 檢查通過才寫回.
- **特權動作的 bot 憑證**: 動作用 `bots` 拿到另一隻 bot 的 Bot API 網址, token 不進對話, 出現在輸出或檔案就遮蔽並通知 owner.
- **自己的 plugin, 不怕官方更新**: worker 載入 router 自己商店的 telegram plugin, 在 bwrap 的 mount namespace 裡用 router 專屬的 Claude Code 設定目錄與 daemon, 不用 sudo, 跟這台機器上的其他 session 分開; router 看管 daemon, 不對就自動修復並通知. bwrap 或 user namespace 不能用時降級回官方 plugin 的做法, 照常運作. 見 [專屬設定目錄與 managed channel](docs/managed-channel.md).
- **從外部送訊息給 worker**: 主機終端機或其他 Claude Code session 用 `cli session send <對話> --from <名稱> <文字>` (或從 stdin) 把訊息送進某個對話的 worker; 經 router 的佇列, worker 睡著就叫醒, router 重啟也不會掉, 收到才印「已送達」. 回覆給 Telegram 或用 SendMessage 回給發送者由 worker 判斷, 見[部署與維運](docs/operations.md#從外部送訊息給-worker). managed 模式的 worker 跟使用者的 session 共用名冊, 在跑的 worker 用 ListAgents 看得到, 睡著的看不到, 要確定送到就用這個指令.
- **終端機執行與試跑**: owner 在終端機以某個對話與角色的身分跑特權動作 (`cli skill run`, 可用拋棄式資料庫與本機假 Bot API), 或立刻更新某個技能的憑證 (`cli skill refresh`).
- **skill_check 與 skill_try**: worker 不用讀 router 原始碼就能寫特權技能; `skill_check` 檢查草稿並列出核准時會看到的內容, user 以上用 `skill_try` 以假憑證與試跑資料庫不經核准跑一次 (白名單沙箱, 外網只開 80, 443, 53, 22).
- **試跑沙箱的網路隔離**: 試跑連得到外網, 連不到主機本機, 內網, 雲端 metadata 與主機上的 unix socket (例如 docker.sock, 其他 session 的 socket).
- **附件用 caption 與相簿**: reply 帶檔案時文字成為第一個檔的 caption, 多個檔送成相簿, 文字超過 caption 上限才先送完整文字.
- **自架 Bot API server**: 每隻 bot 可以各自設 `apiRoot` 走自架的 telegram-bot-api; `--local` 模式的附件由 router 從磁碟讀, 上傳上限 2000 MB.
- **設定嚮導**: `deploy/install.sh setup` 建立或修改 config.json 與 access.json, 每隻 bot 選官方或自架的 Bot API 並當場驗證 token; token 以 `*` 顯示, 重跑就是修改模式, Enter 保留原值.
- **時間一律 GMT+8**: log, 通知, 報表與 worker 收到的訊息時間都是 GMT+8.
- **健康檢查端點**: 選配的 `GET /healthz` (建議只聽本機位址, 可要 bearer token) 給 Gatus 這類監控工具, 每隻 bot 的輪詢超過門檻就回 503; router 每次啟動與關機都發重要通知 (含 health 網址與對外開放的警告). 設定與 Gatus 範例見 [部署與維運: 健康檢查端點](docs/operations.md#健康檢查端點).

## bwrap 版 (managed 模式) 的差異

2.32.0 起預設用 managed 模式. 跟以前 (legacy 模式) 比, 差在這些地方 (細節見 [專屬設定目錄與 managed channel](docs/managed-channel.md)):

- **用自己的 plugin, 不怕官方更新.** 以前 worker 載入官方商店的 telegram plugin, 再把我們的檔案蓋上去, 官方一更新就可能被換掉. 現在 worker 載入 router 自己商店 (`<stateDir>/marketplace`) 裡的 plugin. Claude Code 只讓系統層 managed settings 核可的 plugin 當 channel, 那本來要用 sudo 寫進 `/etc/claude-code`; router 改用 bwrap 只在 worker 看得到的地方掛上自己的檔案, 真的 `/etc` 不動, 不用 sudo.
- **專屬設定目錄與常駐 daemon.** router 下的每個 `claude` 指令都在 bwrap 裡執行, 用 router 自己的設定目錄 (`<stateDir>/claude-config`). 所以 router 有自己的 daemon, 跟你終端機的 session 分開; router 一直讓它在 bwrap 裡跑著, 每分鐘與每次叫醒前檢查, 不對就自動修好並通知. 登入沿用你自己的 (`~/.claude`), 不用另外登入.
- **worker 的資料換了位置.** 對話紀錄 (`projects/`), daemon 的 job, 資料夾信任 (`.claude.json`) 都在 `<stateDir>/claude-config`. 第一次啟動時 router 會把各對話目前的紀錄複製過去 (原本的留在 `~/.claude` 當備份), worker 醒來接續原本的對話. worker 的自動記憶一直在對話資料夾的 `memory/` (不在設定目錄), 不用搬, 兩種模式都讀得到. worker 一直都帶 `--setting-sources project,local`, 你使用者層的 `settings.json` 與 `~/.claude/CLAUDE.md` 本來就不載入, 這點沒變 (managed 模式的使用者層在 `<stateDir>/claude-config`, 同樣不載入); 要給所有 worker 的規則寫在 `<home>/CLAUDE.md`.
- **session 名冊預設共用.** config.json 的 `"managed": { "shareSessions": true }` (沒寫就是開): worker 跟你終端機的 Claude Code session 用同一份名冊, ListAgents 互相看得到, 也能用名稱互相 SendMessage. 設成 `false` 時名冊分開, 互相看不到, 也不能用名稱傳訊. 不論開關, power 以下角色的 worker 都不能用 ListAgents 或傳訊給其他 session (router 會擋, 可提權), admin 與 owner 的 worker 開著共用時看得到你所有的 session.
- **在終端機看 worker 要用 router 的指令.** 直接跑 `claude agents` 或 `claude attach` 看到的是你自己的 daemon, 找不到 worker; 要帶 `CLAUDE_CONFIG_DIR=<stateDir>/claude-config`, 或改用 `cc-telegram-router managed agents` 與 `cc-telegram-router managed attach <job id | 對話 key | chat_id>` (用法相同, router 代你帶好環境, 也在 bwrap 裡).
- **睡著的 worker 不在名冊.** 名冊只有正在跑的 session; 要確定送到某個對話 (必要時叫醒它), 用 `cc-telegram-router cli session send`.
- **worker 的環境多了兩件事.** 有 managed settings 時, Claude Code 會在每個 session 掛上內建的 `cc-plugin-sec-default` (依它的說明不加任何政策); worker 看到的 `/etc` 是唯讀的 (不能自己加 managed settings).
- **static bwrap 與降級.** router 用工具箱的 bubblewrap 0.13.1 static 版 (本 repo 的 GitHub Actions 建置, release 固定 sha256, `deploy/install.sh router` 下載, 目前只有 x86_64), 跟系統的 bwrap 分開. 不是 Linux, 工具箱沒有它或檔案被改過, 或系統不讓一般使用者建 user namespace (例如 Ubuntu 24.04 的 `kernel.apparmor_restrict_unprivileged_userns=1`) 時, router 自動降級成 legacy 模式照常運作, 原因寫在啟動公告與 `cli doctor`.
- **風險.** managed settings 對個人帳號 (Pro, Max) 有效是實測結果 (Claude Code 2.1.302), 官方文件沒有保證; 之後的版本若不再採用, channel 事件會被靜默丟掉. router 檢查得到檔案有沒有掛上, 檢查不到 Claude Code 有沒有採用.
- **退回 legacy.** config.json 加 `"channelMode": "legacy"` 後重啟 router: worker 回到官方 plugin 的快取與 `~/.claude`, router 會把專屬設定目錄裡比較新的對話紀錄複製回 `~/.claude`. legacy 模式需要先裝好官方 telegram plugin (見下方安裝步驟).

## Requirements

必要:

| 項目 | 需求 | 用途 |
|---|---|---|
| 作業系統 | Linux, systemd user service (`systemctl --user`) | router 以 user unit 常駐 (`deploy/cc-telegram-router.service`) |
| [Bun](https://bun.sh) | 1.4.3 以上 (`package.json` 的 `engines`; 之後的排程要用 `Bun.cron.parse`; 1.4.2 的 `Bun.spawnSync` 可能空轉卡死, 見 CHANGELOG 2.31.0); 開發與測試用 1.4.3 | 編譯 router 與 hook (`bun build --compile`), 打包 plugin, `bun:sqlite`, 測試 |
| Claude Code CLI | 支援 `--bg`, `--resume`, `attach`, `--channels` 的版本; 開發與測試用 2.1.302 | worker (`claude --bg`), 套件審核與 event_raw 的 `claude -p`, `cc /` 代打 |
| 官方 telegram plugin | 建議先裝好 `telegram@claude-plugins-official` (0.0.7) | 只有降級成 legacy 模式時用到: `deploy/install.sh plugin` 也把 plugin v2 放進它的快取路徑 (第一次會備份原內容). 預設的 managed 模式用 router 自己商店裡的 plugin, 見 [專屬設定目錄與 managed channel](docs/managed-channel.md) |
| unprivileged user namespace | 一般使用者能建立 user namespace (多數發行版預設可以; Ubuntu 24.04 以後的 `kernel.apparmor_restrict_unprivileged_userns=1` 會擋工具箱的 static bwrap) | managed 模式: router 用工具箱的 static bwrap (`deploy/install.sh router` 下載, sha256 核對, 不用 sudo) 在 mount namespace 裡給 worker 掛上 managed settings. 不能用時 router 自動降級成 legacy 模式並在啟動公告與 `cli doctor` 說明原因, 照常運作 |
| bubblewrap (`bwrap`) 與 socat | 發行版套件: `sudo apt-get install bubblewrap socat` (或 dnf) | owner 以外的角色範本都開啟 Claude Code 的 sandbox, Linux 上要靠這兩個 ([官方文件](https://code.claude.com/docs/en/sandboxing)); 特權技能的專屬沙箱 (`bwrap`). Ubuntu 24.04 以後預設的 AppArmor 會阻止 bubblewrap 建立 user namespace (`sysctl kernel.apparmor_restrict_unprivileged_userns` 是 1 就會擋), 要照官方文件加 AppArmor profile. Claude Code 的 `/sandbox` 面板 Dependencies 分頁會列出缺少的 ripgrep, bubblewrap, socat, seccomp filter |
| python3 | 3.7 以上 (開發與測試用 3.10.12); 必須是 python3, 腳本不相容 python2 | `cc /status`, `cc /usage`, `cc /context` 的報表腳本 (本 repo 的 `scripts/`, `deploy/install.sh router` 裝到 stateDir 的 `scripts/`, 見 [部署與維運](docs/operations.md#cc--報表腳本)) |

強烈建議:

| 項目 | 用途 |
|---|---|
| tmux | `cc /指令` 代打 (router 用自己的 tmux server 開 `claude attach`) |
| curl | 除錯時手動查詢 Bot API 與 HTTP API; 特權技能的 shell 腳本呼叫 API 常用它. 本 repo 的程式與腳本不用它 |
| jq | 處理 JSON (例如 Bot API 的回應); 也在 user 角色的唯讀指令白名單裡, worker 可以直接用. 本 repo 的程式與腳本不用它 |
| matplotlib (python3 套件) | `cc /context` 的圖; 沒有時 `/context` 退為純文字 (每個類別一段文字進度條, 從上一個類別的結尾接著畫到 100%, 附安裝建議). 安裝: `python3 -m pip install --user matplotlib` 或 `sudo apt-get install python3-matplotlib` |
| node, pip, npm 等 | power 與 admin 對話的 worker 自己要用的執行環境 (python3 已在必要) |

依功能需要:

| 項目 | 用途 |
|---|---|
| 特權技能需要的工具 (例如 yt-dlp) | ffmpeg, deno, uv 由 `deploy/install.sh router` 下載固定版本到 stateDir 的工具箱 (主機不用裝; 下載失敗只影響需要它的技能), Python 套件由技能的 `uv.lock` 建環境; 其他的沙箱只看得到 `/usr` (系統裝的) 與 config `sandboxExtraRo` 加的路徑, 家目錄裡裝的看不到 (見 [執行環境規格](docs/skill-runtime.md)) |
| OpenRouter 或其他分類器的 API key | 工具呼叫分類器 (預設關閉) |
| slirp4netns (1.0 以上), nftables (`nft`), util-linux 的 `nsenter` | 特權技能 (`run_skill`, 憑證更新, `skill_try`) 的網路隔離 (外網只開 80, 443, 53, 22, 連不到主機本機與內網), 也要能建 unprivileged user namespace (bwrap 本來就要). 缺少時特權技能一律拒絕執行, 其他功能不受影響. 安裝: `sudo apt-get install slirp4netns nftables` |

不需要: sqlite3 CLI (router 用 `bun:sqlite`).

## How to install

安裝位置可自選. 以下 `<home>` 是 router 的家目錄 (每個對話一個資料夾, 例如 `~/cc`; 不能是使用者的家目錄 `~` 本身), 狀態目錄 (執行檔, config.json, access.json, router.db) 用 `<home>/.router`.

1. 安裝 bun 1.4.3 以上與 Claude Code. bun 的官方安裝程式 (`curl -fsSL https://bun.sh/install | bash`) 放在 `~/.bun/bin` 並把它加進 shell 的 PATH, 開新的 shell 後用 `bun --version` 確認; 已經有 bun 時 `bun upgrade` 更新. Claude Code 裝好後 `claude --version` 確認 (開發與測試用的版本見上方 Requirements).
2. 取得本專案並安裝相依套件 (照 `bun.lock` 鎖定的版本):

   ```bash
   git clone https://github.com/Cojad/cc-telegram-router.git
   cd cc-telegram-router
   bun install --frozen-lockfile
   ```

3. 安裝官方 telegram plugin (預設的 managed 模式用不到, 但降級成 legacy 模式時要用; `deploy/install.sh plugin` 會覆蓋它的快取路徑, 所以要先裝), 再部署本專案:

   ```bash
   claude plugin marketplace list    # 沒有 claude-plugins-official 時: claude plugin marketplace add anthropics/claude-plugins-official
   claude plugin install telegram@claude-plugins-official
   CC_ROUTER_STATE=<home>/.router deploy/install.sh router   # 編譯到 <home>/.router/cc-telegram-router, 複製 templates 與報表腳本, 下載工具箱 (含 static bwrap); 還沒有 config.json 時接著開設定嚮導
   deploy/install.sh plugin   # 打包 plugin v2 到 router 的商店 (<home>/.router/marketplace) 與官方 plugin 快取路徑 (第一次會備份原內容)
   deploy/install.sh unit     # 安裝 systemd user unit
   ```

   `deploy/install.sh` 的每個子指令開頭都先檢查: bun 找得到 (印出路徑) 而且版本符合 `package.json` 的 `engines`; repo 的相依套件跟 `bun.lock` 一致, 沒裝或過期時自動執行 `bun install --frozen-lockfile` (印出正在做; 失敗就停, 不會改用沒鎖版本的 `bun install`); claude 找得到並印出版本 (比開發與測試用的版本舊時只警告). 缺了什麼就停下並說明怎麼補. `deploy/install.sh unit` 產生 systemd unit 時, 會把 bun 與 claude 所在的資料夾加進 unit 的 PATH (unit 原本只有 `~/.local/bin`, `~/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`; bun 的官方安裝位置 `~/.bun/bin` 不在裡面), 之後換了位置重跑 `deploy/install.sh unit` 會更新.
4. 設定嚮導 (`deploy/install.sh router` 第一次會自己帶起; 之後隨時用 `deploy/install.sh setup` 再跑, 它執行 `<home>/.router/cc-telegram-router setup` 再 `register`). 要在終端機裡執行, 沒有終端機 (例如腳本, 管線) 時嚮導拒絕執行, 改照 [部署與維運: 設定欄位](docs/operations.md#設定欄位) 手寫 config.json. 嚮導依序問:
   - home, owner 的 Telegram uid (可以不填, 啟動後用認領碼認領, 見第 8 步), worker 用的模型, claude 執行檔 (預設是 PATH 找到的那個).
   - 每隻 bot 的名稱與 token. token 輸入時每打一個字 (或貼上的每一個字) 顯示一個 `*`, 看得出有沒有打進去與長度, 但畫面上永遠不出現 token 本身; Backspace 刪最後一個字, Ctrl-U 清掉重打, Enter 結束.
   - 這隻 bot 用官方 Bot API (`api.telegram.org`) 還是自架的本機 Bot API server ([telegram-bot-api](https://github.com/tdlib/telegram-bot-api)). 選自架就再問網址 (預設 `http://127.0.0.1:8081`) 與 server 的 `--dir` (可不填). 接著用那個 server 呼叫 getMe 驗證 token, 成功顯示 `@username (id)`; 失敗時可以重打 token, 重選 server, 或放棄. 驗證沒過不會寫入任何東西.
   - 最後列出要寫入的內容, 確認後寫入 `config.json` 與 `access.json` (權限 600, 先寫暫存檔再改名). 任何時候按 Ctrl-C 都是取消, 不寫入.
   - 選模型時說明 `[1m]`: Opus 4.7 以上, Sonnet 5 以上本身就是 1M context; 名稱加 `[1m]` 的版本要帳號有 1M context 額度 (Sonnet 4.6 的 1M 在所有方案都要 usage credits), 沒有就每一輪 API 錯誤. 選了 200K 的模型而 autoCompactWindow 比較大時會提醒.
   - 資料夾信任: `<home>` 還沒被 Claude Code 信任時, 先說明官方的互動做法 (第 6 步), 再問要不要由嚮導代寫 `~/.claude.json`; 只有輸入 `y` 才寫, 會先備份, 只改那一個設定, 寫完再確認沒被其他 Claude Code 蓋掉. router 正在執行時會先提醒.
   - 結尾自動跑一次 `cc-telegram-router doctor` (bun 與 claude 在 unit 的 PATH, plugin, 位置檔, 信任, 模型), 有問題就說明怎麼補.

   第一次跑時 `access.json` 不存在, 嚮導建立預設的一份 (私訊用配對碼 `pairing`, 沒有允許清單, 沒有群組); 已經存在的 `access.json` 不會被換掉, 嚮導只會把 owner 加進它的 `allowFrom` (owner 私訊 bot 不用配對, 見下方「私訊與群組的存取」).

   再跑一次就是修改模式: 讀出目前的 config.json, 每一題的 `[ ]` 裡是目前的值, 直接按 Enter 保留, 只寫入你改過的欄位; 每隻 bot 可以保留, 修改 (換 token 只能換同一隻 bot 的, 官方與自架可以互換) 或移除, 也能新增; token 只顯示「已設定 (末 4 碼)」. 嚮導沒有問的欄位 (例如 `credentials`, `secretKey`, `classifier`, `receiveReact`, `sandboxDenyRead`, `skillRefreshAt`) 原封不動, 要改見 [部署與維運: 設定欄位](docs/operations.md#設定欄位). router 正在執行時, 改完要 `systemctl --user restart cc-telegram-router` 才套用.

   用自架的 Bot API server 時: server 以 `--local` 啟動, router 要跟它在同一台而且讀得到它 `--dir` 底下的檔案 (例如把 router 的使用者加進 server 使用者的群組, 給群組讀取權限), `--dir` 不要放在 `<home>` 裡; 上傳上限從 50 MB 變成 2000 MB. bot 原本在官方 server 時, 搬過去前先對官方呼叫一次 `logOut`. 見 [部署與維運: 自架 Bot API server](docs/operations.md#自架-bot-api-server).
5. 共用規則從範例開始: `cp templates/CLAUDE.md.example <home>/CLAUDE.md`.
6. 第一次要在 `<home>` 互動執行一次 `claude` (`cd <home> && claude`), 在資料夾信任確認框選接受後離開 (這是 legacy 模式要的; 預設的 managed 模式由 router 在自己的設定目錄寫入 `<home>` 的信任, 但先做好, 降級時才不會叫不醒 worker). router 以 `claude --bg` 在每個對話資料夾啟動 worker, 背景 session 要求資料夾已被信任; 依 Claude Code 官方文件, 不在 git repo 裡時信任涵蓋 `<home>` 底下所有子資料夾, 之後的對話資料夾都繼承, 不用個別信任. `<home>` 不要是使用者的家目錄 (那裡的信任不會存下來). 細節與例外見 [部署與維運: 資料夾信任](docs/operations.md#資料夾信任).
7. 開 linger, 讓 router 在登出後繼續執行, 開機自動啟動: `sudo loginctl enable-linger <使用者>`, 用 `loginctl show-user <使用者> -p Linger` 確認是 `Linger=yes` (見 [部署與維運](docs/operations.md#登出後繼續執行-linger)). 然後啟動: `systemctl --user enable --now cc-telegram-router`.
8. 認領 owner: `owners` 留空時, router log 會印出一次性認領碼, 私訊 bot `/start <碼>` 的人成為 owner (並加進 `allowFrom`). 接著 bot 會訪談人設, 並引導設定審核群組 (可以略過).

各欄位與初次設定的細節見 [部署與維運](docs/operations.md).

## 疑難排解

- router log 一直出現 `plugin did not connect`: worker 的 telegram plugin 沒連上 router. 最常見是 systemd unit 的 PATH 裡沒有 bun (plugin 由 `.mcp.json` 直接執行 `bun`, 而 bun 的官方安裝位置 `~/.bun/bin` 不在 unit 預設的 PATH). 先看 `systemctl --user cat cc-telegram-router` 的 `Environment=PATH=` 有沒有 `command -v bun` 所在的資料夾; 沒有就重跑 `deploy/install.sh unit` (會自動加進去), 再 `systemctl --user restart cc-telegram-router`. 還是不行就看 plugin 自己的 log: `~/.cache/claude-cli-nodejs/<對話資料夾路徑, 斜線換成 ->/mcp-logs-plugin-telegram-telegram/`, 例如對話資料夾 `/srv/cc/bot123/dm-555` 的在 `~/.cache/claude-cli-nodejs/-srv-cc-bot123-dm-555/mcp-logs-plugin-telegram-telegram/`.
- 先跑 `<home>/.router/cc-telegram-router cli doctor` (Telegram 裡 `/router doctor`): 一次檢查 bun 與 claude 在 unit 的 PATH, plugin, 位置檔, 資料夾信任, 模型與 autoCompactWindow, daemon 裡殘留的 job, 輸出不含 token, 可以直接貼給別人. `/router status` 也會在每個對話後面列出 worker 的狀態與最後一次的問題. router 叫不醒 worker 或某一輪因 API 錯誤結束時, 會在「🔔 重要通知」寫原因與修法 (同一原因只通知一次).
- 每一輪都沒有回覆, 出現「⚠️ 暫時無法回應」: 最常見是模型名稱帶 `[1m]` (例如 `claude-sonnet-4-6[1m]`) 而帳號沒有 1M context 的額度 (`Usage credits required for 1M context`). 改用沒有 `[1m]` 的模型 (`/router config set model claude-sonnet-4-6`), 或在 router 的使用者下開 `claude` 執行 `/usage-credits`. Opus 4.7 以上, Sonnet 5 以上本身就是 1M context, 不用 `[1m]`.
- 改了模型卻沒生效 (舊參數殘留): router 叫醒 worker 時會比對 daemon job 存的旗標, 不同就換掉 job (用預設模型的對話閒置時輪替); 還是不行就看 log 與 cli doctor 列出的殘留 job, 見 [部署與維運: 疑難排解](docs/operations.md#疑難排解).
- journal 在 router 停止或重啟時寫 `left-over process` 或 `remains running after unit stopped`: 正常. unit 用 `KillMode=process`, 停 router 時刻意不停 worker.
- 更多 (前置檢查, 資料夾信任, 自架 Bot API server 的檔案權限) 見 [部署與維運: 疑難排解](docs/operations.md#疑難排解).

## 私訊與群組的存取

誰的訊息會送進 worker, 由 `<home>/.router/access.json` 決定 (`/router access` 指令管理, owner 與 admin 能用). 私訊有三種模式 (`/router access policy <模式>` 切換):

- `pairing` (預設): 不在允許清單 (`allowFrom`) 裡的**每一個人**私訊 bot, 都會先收到一組 6 碼配對碼, 訊息不會送進 worker. 他把碼告訴 owner 或 admin, 由 owner 或 admin 用 `/router access pair <碼>` 核可 (或 `/router access deny <碼>` 拒絕), 核可後他進入允許清單, bot 回他「配對完成」, 之後的訊息才送進 worker. 配對碼 1 小時有效; 同時最多 3 個待核可, 再有新的人私訊就不回應, 等前面的核可, 拒絕或過期; 同一個人重複私訊只會再提醒一次配對碼. owner 一律在允許清單裡 (不論是認領, 嚮導, `/router config set owners`, `/router role <uid> owner` 或手改 config.json 後重啟), 所以 owner 自己私訊不會收到配對碼.
- `allowlist`: 只收允許清單裡的人, 其他人私訊沒有任何回應, 也不發配對碼. 用 `/router access allow <uid>` 加人, `/router access remove <uid>` 移除.
- `disabled`: 什麼都不收 (私訊與群組都不收).

群組另外管理: 把 bot 加進群組後, 用 `/router access group add <chat_id>` 讓 router 收這個群組 (預設要 mention bot 才回應, 加 `--no-mention` 則每則都收), `/router access group rm <chat_id>` 移除. 沒加入的群組完全不回應. `/router access` (或 `show`) 列出目前的模式, 允許清單, 群組與待核可的配對碼.

## How to upgrade

1. 取得新版 (`git pull`), 看 [CHANGELOG](CHANGELOG.md) 有沒有要另外做的事.
2. `deploy/install.sh router` 與 `deploy/install.sh plugin` (unit 有改時再加 `deploy/install.sh unit`).
3. `systemctl --user stop cc-telegram-router`, 備份 `<home>/.router/router.db*` (WAL 模式, 連同 `-wal`, `-shm`) 與 `config.json`.
4. `systemctl --user start cc-telegram-router`: 資料庫結構由 router 啟動時自動升級 (只新增資料表與欄位, 退回舊版通常能直接用). 從 managed 模式以前的版本升級時, router 第一次以 managed 模式啟動會把各對話的紀錄複製到它自己的設定目錄, worker 醒來接續原本的對話; worker 的自動記憶在對話資料夾的 `memory/`, 不用搬 (見 [managed-channel](docs/managed-channel.md#對話紀錄的遷移)).
5. `/router session rotate all` (或終端機 `<home>/.router/cc-telegram-router cli session rotate all`), 讓 worker 載入新的 plugin 與設定.

要改設定 (例如換 token, 換成自架的 Bot API server, 加 owner) 用 `deploy/install.sh setup` 的修改模式, 再重啟 router.

細節與退版見 [部署與維運: 升級](docs/operations.md#升級).

## 文件索引

| 文件 | 內容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 結構, 運作方式, 目錄, 訊息紀錄, 廣播頻道 |
| [docs/session-and-memory.md](docs/session-and-memory.md) | session 與記憶: 各層 CLAUDE.md 與記憶的繼承, 依角色的讀寫權限, session 存在哪裡與怎麼接續, managed 模式的自動遷移, 從 OpenClaw 轉過來時檔案放哪裡 |
| [docs/permissions.md](docs/permissions.md) | 權限檢查與提權, 套件安裝審核, 審核按鈕, 撤銷, 執行授權 |
| [docs/credentials-and-skills.md](docs/credentials-and-skills.md) | 技能範圍, 憑證 (bot_api, http_api), 特權技能 |
| [docs/skill-runtime.md](docs/skill-runtime.md) | 特權技能的執行環境規格: 掛載路徑, 環境變數, 工具箱, Python 套件 (uv), 工作目錄, 網路, 主機存取, 對外 port, 核准, exit code 與輸出 |
| [docs/secrets.md](docs/secrets.md) | 對話專屬密鑰 (10b), 原始事件與密鑰保護 (10e) |
| [docs/classifier.md](docs/classifier.md) | 工具呼叫分類器 (第一階段, 只記錄) |
| [docs/managed-channel.md](docs/managed-channel.md) | 專屬設定目錄與 managed channel: worker 在 bwrap 裡用 router 自己的設定目錄, daemon 與 plugin, 降級, daemon 的看管, 對話紀錄的遷移, 共用 session 名冊, `managed agents` 與 `attach` |
| [docs/operations.md](docs/operations.md) | 部署, 設定嚮導, linger, 資料夾信任, config.json 設定欄位, 自架 Bot API server, 私訊與群組的存取, 升級, 表情回應, 安裝位置, 新 bot 初次設定與審核群組, bot 設定提醒, router 重啟, 輪詢與重試, 健康檢查端點, 工具呼叫紀錄, CLI, 時間, 報表腳本 |
| [docs/testing.md](docs/testing.md) | 執行測試, 測試分區 (std, 依改動跑), 測試檔對照, 各階段驗收對照表 |
| [CHANGELOG.md](CHANGELOG.md) | 版本變更紀錄 |
| `/telegram:doc` (`plugin/skills/doc/SKILL.md`) | worker 端的使用說明 |
| `/telegram:bot-skill` (`plugin/skills/bot-skill/SKILL.md`) | worker 建立技能與憑證的 SOP |

測試: `bun test` (repo 根目錄, 只跑 `router/test`, 全套); 開發中用 `bun run test:changed` (std 加上改到的區), 見 [docs/testing.md](docs/testing.md#測試分區).
