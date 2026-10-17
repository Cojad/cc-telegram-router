# cc-telegram-router

一隻 router 收 Telegram bot 的所有訊息, 每個 Telegram 對話 (私訊或群組) 交給一個獨立的 Claude Code 背景 session (`claude --bg`). 每個對話住在自己的資料夾, 有自己的 CLAUDE.md, memory 與 session, 回覆不會跑錯對話; worker 載入的 Telegram plugin 不持有 bot token, 所有收發都經 router 代為處理並記在 `router.db`.

權限依角色分開: 使用者與對話各有角色 (owner, admin, power, user, guest), router 在每個工具呼叫前依對話角色檢查. 越權的動作先擋下, 再問: 發話者角色較高時直接在對話裡貼出提權詢問, 否則可以向 owner 申請; 跨對話傳訊與套件安裝也走審核, 核准過的授權可以撤銷, 每次使用都留紀錄. 密鑰 (bot token, API key) 一律由 router 保管與代呼叫, 不進 worker 也不以明文留在資料庫.

## 與上游的差異

上游是 Anthropic 官方 Claude Code Telegram channel plugin (`claude-plugins-official` 的 `telegram`, 0.0.7). 本專案從它 fork 出來 (v1), 再改寫成 router 架構 (v2); 收發 Telegram 的模組 (`router/telegram/`) 沿用 v1.

| 項目 | 上游 telegram plugin | cc-telegram-router |
|---|---|---|
| 架構 | plugin 在一個 Claude Code session 裡持有 token 並輪詢 | systemd 常駐的 router 持有 token 並輪詢; worker 的 plugin 經 unix socket 跟 router 收發 |
| 對話與 session | 所有允許的私訊與群組都進同一個 session | 每個對話一個背景 session 與資料夾, 不在線時自動喚醒 (`--resume`) |
| 多隻 bot | 一個 session 一隻, 多隻要各自設 `TELEGRAM_STATE_DIR` | 一隻 router 管多隻 bot (`/router bot add` / `rotate`), 資料夾以 bot id 命名 |
| 存取控制 | 配對碼, 允許清單, 群組 mention (`/telegram:access`) | 沿用同一套 gate, 另加使用者角色與對話角色 |
| 權限 | Claude Code 的權限詢問轉到允許清單的私訊 (Allow / Deny) | 依對話角色的 settings 與 router 檢查每個工具呼叫; 先擋再問的提權, 三選一審核按鈕, 撤銷, 執行授權紀錄 |
| 管理介面 | 終端機的 `/telegram:access`, `/telegram:configure` | Telegram 裡的 `/router` 指令, 終端機 CLI, `cc /指令` 代打 Claude Code 的 slash command |
| 訊息紀錄 | 沒有歷史與搜尋 | 每個 update 與送出的 payload 都在 `router.db`; `lookup_message`, 回覆引用自動補全 |
| 工具 | reply, react, edit_message, download_attachment | 另有 send_sticker, lookup_message, get_chat_context, bot_api, http_api, install_skill, run_skill, request_elevation, request_send_grant, event_raw, secret_from_handle, save_bot_profile |
| 憑證與密鑰 | bot token 存在 `.env` | 跨 bot 憑證與 HTTP API key 由 router 代呼叫 (worker 看不到值); 對話專屬密鑰 (AES-256-GCM) |
| 密鑰保護 | 沒有 | 每個 update 與文字附件都掃描密鑰, 存遮蔽版, 原文加密, 提醒並 5 分鐘後刪除原訊息 |
| 技能 | 沒有 | 三層技能範圍與 `install_skill`; 特權技能 (bwrap 沙箱, 雜湊核准, 每日更新憑證) |
| 進度 | 輸入中提示 (typing) | hook 回報的即時進度訊息 |
| 輪詢與斷線 | grammY `bot.start`, 啟動時停掉舊的 poller | router 自己的重試規則, 斷線, 409, token 失效時通知 owner |
| 工具呼叫分類器 | 沒有 | 選配, 預設關閉; 第一階段只記錄 |

## Feature highlights

- **一個對話一個 session**: 私訊與群組各自一個 worker 與資料夾, 被回收後下一則訊息自動喚醒, 連發多則只喚醒一次且不掉訊息.
- **Session 隔離**: 每個對話是獨立的背景 session, context 各自分開; owner 以外的角色, 檔案工具只能碰自己的對話資料夾, Bash 跑在 Claude Code 的 sandbox (Linux 上是 bubblewrap) 裡, router 的家目錄, 狀態目錄與使用者家目錄 (另可設定額外路徑) 都被隱藏, 只開放自己的資料夾與共用技能, 讀不到其他對話的檔案, 對話紀錄, router 的資料庫與憑證; 回覆只能送回自己的對話, 送往其他對話要經過核准. 特權技能另由 router 在 bwrap 專屬沙箱執行.
- **先擋再問的提權**: 越權就擋下並告訴模型改用不越權的方法; 發話者角色較高時在對話裡貼出「允許一次 / 永久允許 / 拒絕」, 按下的人以他的角色執行下一個 subagent.
- **審核與授權**: 跨對話傳訊, 套件安裝, 提權申請送到審核群組 (五個話題) 或 owner 私訊; 核准過的可以撤銷, 每次使用記在「🧾 執行授權」.
- **密鑰不落地**: bot_api / http_api 由 router 代呼叫, 回應裡回顯的 key 先遮蔽; 對話可以自己登記密鑰, 不用提權.
- **原始事件與密鑰保護**: 貼進 Telegram 的 token 在 events 與 worker 看到的都是代號, 原文加密保存; owner 或 admin 可以請固定 agent 回答原文相關的問題, 出口由程式檢查.
- **特權技能**: 技能帶 `privileged.json` 列出動作, owner 或 admin 核准後由 router 在 bwrap 專屬沙箱執行, 檔案改了自動暫停.
- **Telegram 裡管理**: `/router` 指令管 bot, 角色, 權限, 憑證與 session; `cc /status` 這類指令由 router 開 tmux 代打給背景 worker.
- **時間一律 GMT+8**: log, 通知, 報表與 worker 收到的訊息時間都是 GMT+8.

## Requirements

必要:

| 項目 | 需求 | 用途 |
|---|---|---|
| 作業系統 | Linux, systemd user service (`systemctl --user`) | router 以 user unit 常駐 (`deploy/cc-telegram-router.service`) |
| [Bun](https://bun.sh) | 開發與測試用 1.4.2 | 編譯 router 與 hook (`bun build --compile`), 打包 plugin, `bun:sqlite`, 測試 |
| Claude Code CLI | 支援 `--bg`, `--resume`, `attach`, `--channels` 的版本; 開發與測試用 2.1.302 | worker (`claude --bg`), 套件審核與 event_raw 的 `claude -p`, `cc /` 代打 |
| 官方 telegram plugin | 先裝好 `telegram@claude-plugins-official` (0.0.7) | `deploy/install.sh plugin` 把 plugin v2 放進它的快取路徑 (第一次會備份原內容) |
| bubblewrap (`bwrap`) 與 socat | 發行版套件: `sudo apt-get install bubblewrap socat` (或 dnf) | owner 以外的角色範本都開啟 Claude Code 的 sandbox, Linux 上要靠這兩個 ([官方文件](https://code.claude.com/docs/en/sandboxing)); 特權技能的專屬沙箱 (`bwrap`). Ubuntu 24.04 以後預設的 AppArmor 會阻止 bubblewrap 建立 user namespace (`sysctl kernel.apparmor_restrict_unprivileged_userns` 是 1 就會擋), 要照官方文件加 AppArmor profile. Claude Code 的 `/sandbox` 面板 Dependencies 分頁會列出缺少的 ripgrep, bubblewrap, socat, seccomp filter |
| python3 | 3.7 以上 (開發與測試用 3.10.12); 必須是 python3, 腳本不相容 python2 | `cc /status`, `cc /usage`, `cc /context` 的報表腳本 (本 repo 的 `scripts/`, `deploy/install.sh router` 裝到 stateDir 的 `scripts/`, 見 [部署與維運](docs/operations.md#cc--報表腳本)) |

強烈建議:

| 項目 | 用途 |
|---|---|
| tmux | `cc /指令` 代打 (router 用自己的 tmux server 開 `claude attach`) |
| curl | 除錯時手動查詢 Bot API 與 HTTP API; 特權技能的腳本呼叫 API 常用它 (`/telegram:bot-skill` 的範例). 本 repo 的程式與腳本不用它 |
| jq | 處理 JSON (例如 Bot API 的回應); 也在 user 角色的唯讀指令白名單裡, worker 可以直接用. 本 repo 的程式與腳本不用它 |
| matplotlib (python3 套件) | `cc /context` 的圖; 沒有時 `/context` 退為純文字 (每個類別一段文字進度條, 從上一個類別的結尾接著畫到 100%, 附安裝建議). 安裝: `python3 -m pip install --user matplotlib` 或 `sudo apt-get install python3-matplotlib` |
| node, pip, npm 等 | power 與 admin 對話的 worker 自己要用的執行環境 (python3 已在必要) |

依功能需要:

| 項目 | 用途 |
|---|---|
| 特權技能需要的工具 (例如 yt-dlp, deno) | 由技能自己決定; 沙箱看得到 `~/.local/bin`, `~/.local/lib`, `~/.deno/bin` |
| OpenRouter 或其他分類器的 API key | 工具呼叫分類器 (預設關閉) |

不需要: sqlite3 CLI (router 用 `bun:sqlite`).

## How to install

安裝位置可自選. 以下 `<home>` 是 router 的家目錄 (每個對話一個資料夾, 例如 `~/cc`), 狀態目錄 (執行檔, config.json, router.db) 用 `<home>/.router`.

1. 安裝官方 telegram plugin, 再部署本專案:

   ```bash
   CC_ROUTER_STATE=<home>/.router deploy/install.sh router   # 編譯到 <home>/.router/cc-telegram-router, 複製 templates 與報表腳本
   deploy/install.sh plugin   # 打包 plugin v2 到官方 plugin 快取路徑 (第一次會備份原內容)
   deploy/install.sh unit     # 安裝 systemd user unit
   ```

2. 手動建立 `<home>/.router/config.json` (權限 600):

   ```json
   {
     "bots": [{ "name": "cc", "token": "<bot token>" }],
     "home": "<home>",
     "stateDir": "<home>/.router",
     "sandboxDenyRead": [],
     "owners": [],
     "model": "claude-opus-5-5",
     "autoCompactWindow": 750000,
     "claudeBin": "/home/<user>/.local/bin/claude",
     "skillRefreshAt": "05:00"
   }
   ```

   以及 `<home>/.router/access.json` (沿用上游的格式, 之後用 `/router access` 管理; 例如只允許配對過的私訊):

   ```json
   { "dmPolicy": "pairing", "allowFrom": [], "groups": {}, "pending": {} }
   ```

   `sandboxDenyRead` 是 sandbox 額外要隱藏的路徑, 例如同一台機器上其他專案所在的目錄.
3. 寫入位置檔, 讓 worker 的 plugin 與 hook 找得到 router: `<home>/.router/cc-telegram-router register` (寫 `~/.config/cc-telegram-router/router.json`; 有 config.json 時 `deploy/install.sh router` 也會做, 之後再跑 `deploy/install.sh` 就不必指定 `CC_ROUTER_STATE`).
4. 共用規則從範例開始: `cp templates/CLAUDE.md.example <home>/CLAUDE.md`.
5. 啟動: `systemctl --user enable --now cc-telegram-router`.
6. 認領 owner: `owners` 留空時, router log 會印出一次性認領碼, 私訊 bot `/start <碼>` 的人成為 owner. 接著 bot 會訪談人設, 並引導設定審核群組 (可以略過).

各欄位與初次設定的細節見 [部署與維運](docs/operations.md).

## 文件索引

| 文件 | 內容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 結構, 運作方式, 目錄, 訊息紀錄, 廣播頻道 |
| [docs/permissions.md](docs/permissions.md) | 權限檢查與提權, 套件安裝審核, 審核按鈕, 撤銷, 執行授權 |
| [docs/credentials-and-skills.md](docs/credentials-and-skills.md) | 技能範圍, 憑證 (bot_api, http_api), 特權技能 |
| [docs/secrets.md](docs/secrets.md) | 對話專屬密鑰 (10b), 原始事件與密鑰保護 (10e) |
| [docs/classifier.md](docs/classifier.md) | 工具呼叫分類器 (第一階段, 只記錄) |
| [docs/operations.md](docs/operations.md) | 部署與 config.json, 安裝位置, 新 bot 初次設定與審核群組, bot 設定提醒, 輪詢與重試, 時間 |
| [docs/testing.md](docs/testing.md) | 執行測試, 測試檔對照, 各階段驗收對照表 |
| [CHANGELOG.md](CHANGELOG.md) | 版本變更紀錄 |
| [docs/v1/](docs/v1/) | v1 (單一 session plugin) 時期的文件, 僅供參考 |
| `/telegram:doc` (`plugin/skills/doc/SKILL.md`) | worker 端的使用說明 |
| `/telegram:bot-skill` (`plugin/skills/bot-skill/SKILL.md`) | worker 建立技能與憑證的 SOP |

測試: `bun test` (repo 根目錄, 只跑 `router/test`), 見 [docs/testing.md](docs/testing.md).
