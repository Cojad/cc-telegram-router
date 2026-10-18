# 專屬設定目錄與 managed channel

[README](../README.md) 的文件索引列出所有文件.

## 這份文件在講什麼

router 的 worker 原本載入官方商店的 `telegram@claude-plugins-official`, 再用部署時蓋上去的檔案換成我們的 plugin. 官方商店一更新, 快取就可能被換掉 (見 [operations](operations.md) 的「官方 plugin 的自動更新與快取檢查」).

這一版改成讓 worker 載入 router 自己的 plugin `telegram@cc-telegram-router`. Claude Code 只讓核可清單上的 plugin 當 channel, 而這份清單只能寫在系統層的 managed settings (`/etc/claude-code/`). 要寫那裡得用 sudo, 所以 router 改用 bwrap: 只在 worker 看得到的 mount namespace 裡, 把 router 自己的檔案掛到 `/etc/claude-code`, 真的 `/etc` 不動, 也不用 sudo.

為了讓這個 namespace 只影響 router 的 worker, router 另外用一個專屬的 Claude Code 設定目錄, 也就有自己的 daemon. 機器上其他的 Claude Code session (包括 owner 自己的終端機) 照舊用 `~/.claude`, 不受影響.

## 已確定

- **bwrap 來源:** 用工具箱附的 static bwrap 0.13.1, 由本 repo 的 GitHub Actions 建置並發佈成 release asset. router 釘死版本與 sha256 下載, 全程不用 sudo.
- **預設開啟:** 新安裝與升級都直接用這個模式. bwrap 或 user namespace 不能用時 (例如 Ubuntu 24.04 的 `apparmor_restrict_unprivileged_userns=1`), 降級回原本的做法, 由 doctor 與重要通知說明, router 照常運作.
- **掛載:** `--bind / /` 遞迴整個根目錄, `/etc` 用 overlay, 再把 router 的 managed 資料夾唯讀掛到 `/etc/claude-code`, 最後 `--remount-ro /etc`.
- **設定目錄:** `<stateDir>/claude-config` (權限 700). router 下的每個 `claude` 指令都帶 `CLAUDE_CONFIG_DIR` 與 `CLAUDE_SECURESTORAGE_CONFIG_DIR`, 而且都包在 bwrap 裡.
- **daemon:** router 看管一個常駐在 bwrap 內的 `claude daemon run`. 叫醒前與定時檢查 daemon 與 worker 是否看得到 managed settings, 不符就修復並發重要通知.
- **對話紀錄:** 切換時把各對話目前 session 的紀錄 (含 tool-results) 從 `~/.claude/projects` 複製到新設定目錄, worker 醒來就能接續. 舊的留在 `~/.claude` 當備份. 原本 daemon 底下 router 對話的 job 會 stop 加 rm.
- **全機設定只帶全域 CLAUDE.md:** 不帶個人 skills, 其他 plugin, MCP server.
- **共用 session 名冊 (2.32.1):** bwrap 另外把使用者的 `sessions/` 名冊掛到專屬設定目錄的 `sessions/` 上, worker 與這台機器上使用者自己的 session 用 ListAgents 互相看得到, 也能用名稱互相傳訊 (見「共用 session 名冊」).
- **plugin 來源:** 本機資料夾商店 `cc-telegram-router`, 指向 router 部署時安裝的 plugin, 不依賴 GitHub. plugin 名稱維持 `telegram`, 所以工具名稱 `mcp__plugin_telegram_telegram_*`, channel 標籤 `plugin:telegram:telegram`, 技能命名空間都不變.

## 兩種模式

| | managed (預設) | legacy (降級) |
|---|---|---|
| channel | `plugin:telegram@cc-telegram-router` | `plugin:telegram@claude-plugins-official` (原本的做法) |
| 設定目錄 | `<stateDir>/claude-config` | `~/.claude` (或 router 自己的 `CLAUDE_CONFIG_DIR`) |
| claude 指令 | 包在 bwrap 裡, 帶兩個環境變數 | 直接執行 |
| daemon | router 看管的常駐 daemon | 第一個 `claude --bg` 帶起的 transient daemon, 跟其他 session 共用 |
| plugin 檢查 | 檢查商店資料夾的檔案 | 檢查官方快取 (原本的 pluginguard) |

**判定** (router 啟動時做一次, 執行中不切換):
1. config 的 `channelMode` 是 `"legacy"`: 用 legacy. 預設是 `"auto"`.
2. 不是 Linux, 或這個 CPU 沒有 static bwrap (目前只建 x64): legacy.
3. 工具箱裡沒有 bwrap, 或檔案的 sha256 跟 `installed.json` 不符: legacy.
4. 試跑一次 `bwrap <完整掛載參數> -- true` (5 秒逾時): 失敗就 legacy, 原因附上 bwrap 的錯誤訊息 (例如 `setting up uid map: Permission denied`).
5. 以上都通過: managed.

降級的原因會寫進三個地方: 啟動通知 (每次啟動都會送到重要通知位置的那一則, 多一行「channel 模式」), `cli doctor`, `/healthz`. 啟動通知本來就會送, 所以降級不會多一則訊息.

## 檔案配置

| 路徑 | 內容 | 誰寫 |
|---|---|---|
| `<stateDir>/toolbox/host/bwrap` | static bwrap. 放在 `host/` 而不是 `bin/`, 因為 `bin/` 會掛進技能沙箱 | `toolbox install` |
| `<stateDir>/managed/managed-settings.json` | `{"channelsEnabled": true, "allowedChannelPlugins": [{"marketplace": "cc-telegram-router", "plugin": "telegram"}]}` | router 啟動時 |
| `<stateDir>/marketplace/.claude-plugin/marketplace.json` | 商店宣告, 只有 `telegram` 一個 plugin | `deploy/install.sh plugin` |
| `<stateDir>/marketplace/telegram/` | plugin 本體 (跟現在部署到官方快取的內容相同) | `deploy/install.sh plugin` |
| `<stateDir>/claude-config/` | 專屬設定目錄: daemon 狀態, jobs, 對話紀錄, `.claude.json` | Claude Code 與 router |
| `<stateDir>/claude-config/migrated.json` | 對話紀錄遷移的紀錄 (時間, 複製了哪些 session) | router |

`deploy/install.sh plugin` 兩邊都部署: 商店資料夾給 managed 模式, 官方快取給 legacy 模式. 這樣降級時也有可用的 plugin.

## bwrap 參數

```
<stateDir>/toolbox/host/bwrap --bind / / --dev-bind /dev /dev \
  --overlay-src /etc --tmp-overlay /etc \
  --ro-bind <stateDir>/managed /etc/claude-code \
  --remount-ro /etc \
  --bind <原本的設定目錄>/sessions <stateDir>/claude-config/sessions -- <claude 指令>
```

- 最後一條是「共用 session 名冊」. 兩個資料夾都要先存在 (bind 的來源與掛載點), router 在試跑 bwrap 前建好, 權限 700 (`prepareMounts`). config 設 legacy 時不會建.

- 沒有切 pid 與網路 namespace, 程序與網路都跟主機相同. `/run/user/<uid>/cc-socks`, `/tmp` 也是同一份.
- `--remount-ro /etc` 讓 worker 不能在 overlay 上自己加 `managed-settings.d/*.json`.
- worker 裡 Claude Code 自己的 Bash sandbox 用系統的 bwrap, 照常運作 (巢狀已實測).
- namespace 裡沒有對應的 uid 會顯示成 65534. 例如 `/usr/bin/sudo` 不能用. router 的 worker 本來就不該用 sudo.

## claude 指令的包裝

新模組 `router/claudecmd.ts` 提供一個 launcher, 所有呼叫 `claudeBin` 的地方都改經過它:
- `argv(args)`: managed 模式回 `[bwrap, ...掛載參數, '--', claudeBin, ...args]`, legacy 模式回 `[claudeBin, ...args]`.
- `env(base)`: managed 模式加 `CLAUDE_CONFIG_DIR=<stateDir>/claude-config` 與 `CLAUDE_SECURESTORAGE_CONFIG_DIR=<原本的設定目錄>`, 並拿掉 `TELEGRAM_*`. 原本的設定目錄是 router 自己的 `CLAUDE_CONFIG_DIR`, 沒設就是 `~/.claude`.

`CLAUDE_SECURESTORAGE_CONFIG_DIR` 讓 Claude Code 從原本的設定目錄讀寫登入憑證. 所以不用另外登入, router 也不讀憑證檔.

包裝的範圍是 router 下的每個 `claude` 指令:
- supervisor 的 `--bg`, `--resume`, `agents`, `stop`, `rm`.
- job 清理, doctor 的 `agents`.
- relay 的 `claude attach`.
- 分類器, 套件審核, 原始事件的 `claude -p`. 這些本來就用 `--setting-sources ''` 與 `--no-session-persistence`, 行為不變, 只是登入改走同一套環境.

## daemon 的看管

- **為什麼要常駐:** Claude Code 的 transient daemon 在最後一個 session 結束 5 秒後就退出. 下一次若有程序在 bwrap 外下 `claude --bg`, 新 daemon 就會開在 namespace 外, worker 的 channel 事件被靜默丟掉 (已實測重現). 在 bwrap 內用 `claude daemon run` 帶起的 daemon (origin `foreground`) 閒置也不退出. 有它在時, 連 bwrap 外的 `claude --bg --resume` 都會交給它, worker 開在 namespace 內 (已實測).
- **啟動:** router 啟動時 (managed 模式) 執行 `ensureDaemon`:
  - 讀 `<設定目錄>/daemon.status.json` 的 `supervisorPid`. 程序活著, 而且檢查通過, 就沿用 (router 重啟時 daemon 與 worker 都留著, unit 是 `KillMode=process`).
  - 沒有 daemon 就用 launcher 以 detached 方式啟動 `claude daemon run`. stdout 與 stderr 寫到 `<stateDir>/logs/daemon-run.log`, 環境拿掉 `TELEGRAM_*`.
- **檢查** (`checkNamespaces`): daemon 與 `daemon/roster.json` 裡每個 worker 的 `/proc/<pid>/root/etc/claude-code/managed-settings.json`, 內容要跟 `<stateDir>/managed/managed-settings.json` 相同. 只讀檔, 不需要權限.
- **何時檢查:** 每次叫醒 worker 前 (supervisor 的新 hook `beforeWake`, 只是讀兩個小檔), 以及每分鐘一次.
- **修復:**
  - daemon 不在: 重新啟動.
  - daemon 或 worker 看不到 managed settings: 先用 launcher 下 `claude daemon stop --any` (只影響專屬設定目錄的 daemon 與它的 worker), 再重新啟動 daemon. worker 在下一則訊息時照常叫醒, 用存下的 session 接續.
  - 修復後發重要通知給每隻 bot 的 owner (同一個原因只通知一次, 恢復時記 log).
  - 連續 3 次修不好 (例如 bwrap 突然不能用) 就停止嘗試並通知, 等 owner 處理. router 不會自己切回 legacy.

## plugin 與 settings 範本

- `templates/base-settings.json` 的 `enabledPlugins` 與 `extraKnownMarketplaces` 改成依模式產生:
  - managed: `telegram@cc-telegram-router` 與 `{"source": {"source": "directory", "path": "<stateDir>/marketplace"}}`.
  - legacy: 維持官方那兩筆.
  - 實測: 商店只宣告在 `--settings`, 不跑 `plugin install`, plugin 也會從商店資料夾原地載入 (`CLAUDE_PLUGIN_ROOT` 指向它), channel 註冊成功.
- `supervisor.ts` 的 `CHANNEL` 改成依模式決定. 換模式時, daemon job 存的 `--channels` 跟新的不同, 既有的旗標比對 (2.26.0) 會 rm 舊 job, 再帶新旗標接續, 不用另外處理.
- `pluginguard.ts`: managed 模式檢查商店資料夾跟 `deploy/install.sh plugin` 記下的指紋是否相同. legacy 模式照舊檢查官方快取. 指紋檔分成兩份: 商店是 `plugin-fingerprint.marketplace.json`, 官方快取維持 `plugin-fingerprint.json`.
- `main.ts` 的 `PLUGIN_DIR` (freshness 用來判斷 plugin 有沒有換過) 跟著模式指向商店或官方快取.

## 設定目錄的初始化

router 在 managed 模式啟動時, 每次都做一次 (都是冪等的):
- 建 `<stateDir>/claude-config`, 權限 700.
- `settings.json`: 加 `skipDangerousModePermissionPrompt: true`, 其他鍵保留. 沒有這一項時 `--bg` 會被擋 (`--bg with bypassPermissions requires accepting the disclaimer first`, 已實測).
- `.claude.json`: `projects[<home>].hasTrustDialogAccepted = true`, 其他內容保留. 背景 session 遇到未信任的資料夾會直接失敗 (`Workspace not trusted`, 已實測), 事先寫好信任後不會出現信任畫面 (已實測).
  - 這個檔會被 Claude Code 自己改寫. router 只在 daemon 啟動前寫入, 寫法是讀進來, 合併, 寫暫存檔再改名.
- **全域 CLAUDE.md 不用 symlink:** 實測換了 `CLAUDE_CONFIG_DIR` 後, Claude Code 仍讀 `~/.claude/CLAUDE.md`. 它裡面的 `@memory/...` 匯入, 在新設定目錄裡沒有生效, 因為那屬於「外部匯入」, 要逐個專案核准. 現在正式環境各對話的 `hasClaudeMdExternalIncludesApproved` 也都是 false, 所以行為跟現在相同. router 不會自動核准外部匯入.
- 不帶個人 skills (`~/.claude/skills`), 其他 plugin, MCP server: 新設定目錄本來就沒有這些. 注意: claude.ai 帳號層級的東西不在設定目錄裡, 照樣會出現. 包括帳號同步的技能 (會下載到 `<設定目錄>/skills/synced`) 與 claude.ai 的 MCP 連接器. 這跟現在相同.

## 對話紀錄的遷移

函式 `migrateTranscripts` (`router/claudecmd.ts`), 有兩個入口:
- **自動:** router 在 managed 模式啟動時, 沒有 `migrated.json` 就先遷移, 再看管 daemon. 公開 repo 的使用者升級後不用多做事.
- **手動:** `cc-telegram-router [--config <路徑>] managed migrate [--dry-run] [--user-config <原本的設定目錄>] [--force]`. 計畫切換時, 先停 router 再執行 (不帶 `--dry-run` 時會拿 router 的鎖, router 在跑就拒絕). 已經遷移過 (`migrated.json` 存在) 時不再做, 要再做一次加 `--force` (已存在的 session 一樣不覆蓋).

步驟:
1. 對 router.db 裡每個有 session 的對話, 把 `<原本的設定目錄>/projects/<資料夾代號>/<session>.jsonl` 與同名資料夾 (tool-results, subagents) 複製到 `<專屬設定目錄>/projects/<資料夾代號>/`. 目的地已有同名檔就跳過, 不覆蓋. 原本的不刪.
2. 補上這些對話資料夾的信任: 原本 `~/.claude.json` 裡有信任的 (例如本身是 git repo 的對話資料夾), 照抄到新的 `.claude.json`.
3. 原本 daemon 裡 router 對話的 job: 從 `<原本的設定目錄>/jobs/*/state.json` 找名稱是 `tg-<對話>`, cwd 是對話資料夾的 job, 用一般的 `claude stop` 加 `claude rm` (不帶專屬環境) 移除. 沒有符合的 job 就不呼叫 claude, 免得為了查詢帶起一個 daemon. 不碰其他 job.
4. 寫 `migrated.json`.

`--dry-run` 只列出會做的事, 不寫任何檔, 也不呼叫 claude. `--user-config` 指定原本的設定目錄 (演練時指向複製品), 這時步驟 3 只列出, 不呼叫 claude. `.claude.json` 跟著設定目錄: `~/.claude` 用 `~/.claude.json`, 其他資料夾用它裡面的 `.claude.json`.

**演練** (不碰正式的 `~/.claude`, daemon 與 router):
1. 建一個暫存資料夾, 複製 `config.json` 進去, 把它的 `stateDir` 改成暫存資料夾裡的 `state`, 再把 `router.db` 複製到那個 `state` (`home` 不改, 對話資料夾路徑要對得上).
2. 建一份原本設定目錄的複製品: 把要演練的對話在 `~/.claude/projects/` 底下的資料夾, `~/.claude/jobs/`, 以及 `~/.claude.json` (放成複製品裡的 `.claude.json`) 複製過去.
3. `cc-telegram-router --config <暫存>/config.json managed migrate --user-config <複製品> --dry-run`, 再不帶 `--dry-run` 跑一次.
4. 檢查 `<暫存>/state/claude-config/projects/` 的內容與 `migrated.json`; 原本的檔案都沒動.

**降回 legacy:** router 在 legacy 模式啟動時, 若專屬設定目錄有 `migrated.json` (曾經用過 managed), 會把各對話目前 session 在專屬設定目錄裡比較新的紀錄 (含 tool-results) 複製回原本的設定目錄 (只複製較新的, 不刪任何東西), 讓 worker 接續到最新內容 (`syncBack`).

## 其他會改的地方

- **transcripts 佔位符** (`settingsVars.transcripts`, 角色範本讓 worker 讀自己的 tool-results): 跟著設定目錄走.
- **信任檢查** (`diagnose.ts` 的 `readProjects`, 啟動檢查, 叫不醒的原因): managed 模式讀 `<專屬設定目錄>/.claude.json`.
- **`jobs.ts` 的 `jobsDir`:** 傳入設定目錄.
- **job 清理的 daemon 報告:** managed 模式不再提醒「daemon 不是 router 帶起的」, 因為 daemon 本來就是 router 帶起的; 改成回報檢查結果.
- **doctor:** 多三行:
  - 目前模式與原因.
  - bwrap 版本與 sha256 是否相符.
  - daemon 與 worker 是否看得到 managed settings (pid 與檢查結果).
- **`/healthz`:** JSON 多一個 `channel` 欄位, 例如 `{"mode": "managed", "managedOk": true}` 或 `{"mode": "legacy", "reason": "..."}`. 只是資訊, 不影響 200 或 503 的判斷 (那仍只看 polling 是否新鮮).
- **其他 session 與 worker 互相看得到:** 見下方「共用 session 名冊」. 要送訊息給睡著或輪替中的 worker, 仍用 `cc-telegram-router cli session send` (經 router 的佇列, 會叫醒它); 用名稱 SendMessage 只送得到正在跑的 worker.

## 共用 session 名冊

**為什麼:** ListAgents 與用名稱 SendMessage, 靠的是 `<設定目錄>/sessions/` 裡的名冊: 每個 session 一個 `<pid>.json` (name, sessionId, messagingSocketPath, peerFeatures 等) 與一個 `<pid>.<hash>.key`. socket 本身都在共用的 `/run/user/<uid>/cc-socks`. worker 改用專屬設定目錄後名冊分開, 兩邊互相看不到 (2.32.0 實測: ListAgents 列不出對方, 用名稱傳訊回 `No agent named ... is reachable`; 只有直接用 `uds:<socket 路徑>` 才送得到).

**做法 (2.32.1):** router 的 bwrap 多一條 `--bind <原本的設定目錄>/sessions <stateDir>/claude-config/sessions`. bwrap 裡的 daemon 與 worker 都把名冊寫進使用者的 `sessions/`, 也從那裡讀, 所以跟使用者自己的 session 用同一份名冊. bwrap 外看 `<stateDir>/claude-config/sessions` 是空的.

**`.key` 檔是什麼** (讀 Claude Code 2.1.302 的程式, 沒讀任何 key 的內容):
- 每個 session 啟動時寫自己的 `<pid>.<sha256(socket 路徑)>.key`, 權限 600, 內容是一個隨機的 peerToken, 加上程序的啟動時間與 pidDomain.
- 傳送端要送到某個 socket 時, 在自己設定目錄的 `sessions/` 找 `.<sha256(那個 socket)>.key` 結尾的檔, 把對方的 peerToken 放進握手; 接收端比對是不是自己的 token. 找不到 key 時改用 socket 的對等端檢查 (同一個 uid), 所以分開時用 uds 位址仍送得到.
- 共用名冊不會衝突: 檔名含 pid 與 socket 路徑, bwrap 沒切 pid namespace, 兩邊的 pid 不會重複, pidDomain 也相同. 清理只刪 pid 已經不在而且 pidDomain 相同的檔, 哪一邊清都正確.

**實測** (2026-10-18, Claude Code 2.1.302, 兩個自建的設定目錄, 一個當使用者的, 一個在 static bwrap 裡當 router 的):
- 前景 session 互相: ListAgents 雙向看得到, 用名稱傳訊與回覆雙向都通.
- bwrap 裡的背景 worker 與使用者的前景 session: 互相看得到, 用名稱傳訊與回覆都通.
- 名冊只寫在使用者的 `sessions/`; 前景 `/exit` 與背景 `claude rm` 後都清乾淨.
- bwrap 外對 router 設定目錄下的 `claude agents`, 只列出 daemon 的 job; bwrap 裡的 `claude agents` 另外列出使用者的 session (那些項目沒有 job id). router 的 listAgents 在 bwrap 裡, 只取有 id 的 job, 所以 job 清理, 叫醒與 `/router status` 不會混進使用者的 session.
- 另一個做法是把 router 的 `sessions/` 換成指向使用者 `sessions/` 的 symlink. 實測一樣通 (Claude Code 不會把 symlink 換成實體資料夾, 只會把被指向的資料夾權限改成 700), 但它在 bwrap 外也會生效, 改用 bind 只影響 router 自己的 claude.

**影響: worker 看得到使用者所有的 session.** 共用之後, worker 的 ListAgents 會列出這台機器上使用者自己的每一個 Claude Code session, 包括名稱, 種類, 狀態, tmux 位置與啟動時間, 也能用名稱傳訊給它們.
- Claude Code 自己的權限不擋: 實測 user 角色的範本 (`dontAsk`), 沒掛 router 的 hook 時, ListAgents 與 SendMessage 都直接成功, 列出了使用者的兩個 session, 也傳出了訊息.
- router 的 hook 會擋: ListAgents 是[高風險工具](permissions.md#高風險工具), 傳給其他 session 的 SendMessage 也一樣. power 以下的角色會被 router 的 PreToolUse hook 擋下 (`router/permcheck.ts` 的 `RISKY_TOOLS` 與 `riskyRefusal`), 只能提權後一次一次允許; admin 與 owner 的對話可以直接用. 所以實際上只有 admin 與 owner 的 worker 看得到使用者的 session.
- 反過來, 使用者的 session (包括 v1) 也看得到每一個在跑的 worker (`tg-<對話>`), 可以用名稱傳訊. worker 睡著時不在名冊裡, 要叫醒它就用 `cli session send`.

## 工具箱與 GitHub Actions

- `.github/workflows/bwrap-static.yml`: 手動觸發 (`workflow_dispatch`, 輸入 release tag).
  - 在 Alpine 容器 (固定 digest) 從 bubblewrap 0.13.1 官方 tarball (驗 sha256) 編 static 版.
  - 上傳成本 repo 的 release asset `bwrap-0.13.1-x86_64`.
  - 印出 sha256.
- `router/toolbox.ts` 加一項 `bwrap`, 版本 0.13.1, 只有 x64, unpack 方式 `raw` (不壓縮), 安裝到 `toolbox/host/`.
- sha256 先填編譯工本機建出來的值 (`75385f30...`). Actions 的產物若因為 Alpine 套件更新而不同, 要在建好 release 後改成 release asset 的值.
- 下載失敗或 sha256 不符時: 工具箱報錯, router 照常啟動, 走 legacy.

## 測試

- `router/test/managed.test.ts` (17 項): 模組層級, 見下方清單.
- `router/test/e2e-managed.test.ts` (5 項): 真的 router, 假 Bot API, e2e-wake 的假 claude, 以及用系統 bwrap 做出同樣 mount namespace 的 bwrap 替身.
- `router/test/health.test.ts`: 啟動公告的 channel 一行, `/healthz` 的 `channel` 欄位, 文件範例的欄位.
- 驗收對照表在 [testing](testing.md#managed-channel-驗收對照).
- 實機驗證 (2026-10-18, Claude Code 2.1.302, static bwrap 0.13.1, 獨立的設定目錄, 沒碰正式環境): 用 router 的模組 (`resolveChannel`, `migrateTranscripts`, `createDaemonKeeper`, launcher) 搭配真的 claude 與一個探針 channel plugin (商店 `cc-telegram-router`, plugin `telegram`).
  - 遷移後的 session 以 `--bg --resume` 叫醒, 經 channel 回答得出遷移前請它記住的內容.
  - 在 bwrap 外用 router 的設定目錄帶起的 daemon 與 worker 被檢查出來. keeper 停掉並在 bwrap 裡重啟, worker 再叫醒後照常經 channel 回覆.

涵蓋的項目:

- 單元測試:
  - 模式判定 (各種降級原因, 用假的 bwrap 腳本與假的平台).
  - bwrap 參數.
  - launcher 的 argv 與 env.
  - `checkNamespaces` (用假的 `/proc` 根目錄).
  - `ensureDaemon` 的沿用, 啟動, 修復, 連續失敗.
  - 設定目錄初始化 (保留既有鍵).
  - 遷移 (複製, 不覆蓋, dry-run, 信任照抄, job 篩選).
  - settings 範本依模式產生.
  - pluginguard 的商店檢查.
  - toolbox 的 raw 安裝與 host 資料夾.
- e2e (真的 router + 假 claude + bwrap 替身):
  - 替身記錄參數, 再用系統 bwrap 做出真的 mount namespace. 驗證每個 claude 呼叫都經過它, 帶了兩個設定目錄的環境變數, 沒有 `TELEGRAM_*`, 而且看得到 managed settings.
  - 自動遷移: 紀錄與 tool-results 複製過去, 原本的 job 用使用者自己的 claude 移除, worker 用原本的 session 接續並收到訊息.
  - 修復: 換成 namespace 外的 daemon, 下一次叫醒前被停掉並在 namespace 裡重啟, 發出通知.
  - `cli doctor` 經由 router 的模式, bwrap, daemon 三行.
  - 降級: bwrap 試跑失敗時走 legacy, 啟動公告寫出原因.

## 正式切換的步驟 (team lead 執行)

1. 合併並建置新版, `deploy/install.sh router` (工具箱會裝 bwrap) 與 `deploy/install.sh plugin` (多部署商店資料夾).
2. `systemctl --user stop cc-telegram-router`.
3. `<stateDir>/cc-telegram-router --config <stateDir>/config.json managed migrate --dry-run`, 確認清單. 再不帶 `--dry-run` 執行 (不先手動做也可以, router 第一次以 managed 模式啟動時會自己做).
4. `systemctl --user start cc-telegram-router`. 看啟動通知的「channel 模式: managed」, 以及 `cli doctor` 的三行.
5. 在一個對話發訊息, 確認 worker 醒來並接續之前的內容.
6. 回退: config 設 `"channelMode": "legacy"` 後重啟. worker 回到官方 plugin 與 `~/.claude`.

## 風險與待決問題

- **managed settings 對個人帳號有效是實測結果, 文件沒有保證.** Claude Code 改版可能讓它失效. 那時事件會被靜默丟掉, 只有 worker 的 debug 看得到. router 的檢查只能確認檔案掛上了, 確認不了 Claude Code 有沒有採用. 可考慮之後加一個「自己送一則測試事件」的端對端檢查, 這版不做.
- **sec-default:** managed 模式下, worker 都會掛上 Claude Code 內建的 `cc-plugin-sec-default@builtin` (有 managed settings 就會). 依它的說明不加任何政策. router 的 hook 寫在 `--settings`, 推論不受影響, 實機驗證時會確認.
- **憑證多一個寫入者:** 專屬 daemon 會自己更新 token, 寫回原本的憑證檔. 這跟現在所有 session 共用同一檔的情況相同.
- **降回 legacy 的紀錄:** 見「對話紀錄的遷移」的「降回 legacy」. 只同步各對話目前的 session.
