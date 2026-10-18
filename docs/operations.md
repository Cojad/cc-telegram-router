# 部署與維運

[README](../README.md) 的文件索引列出所有文件.

## 部署

先裝官方 telegram plugin (`deploy/install.sh plugin` 要覆蓋它的快取路徑 `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7/`, 所以要先有它):

```bash
claude plugin marketplace list                                    # 沒有 claude-plugins-official 時先加:
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install telegram@claude-plugins-official            # 預設裝在 user 範圍
```

worker 的 settings 會自己啟用它 (`templates/base-settings.json` 的 `enabledPlugins`), `claude plugin list` 顯示 disabled 也沒關係; 同一份 settings 也關掉官方商店的自動更新, 見下方「官方 plugin 的自動更新與快取檢查」. 之前要先裝好 bun (`package.json` 的 `engines`, 官方安裝程式放在 `~/.bun/bin`) 與 Claude Code, 並在 repo 執行過 `bun install --frozen-lockfile`. 接著:

```bash
CC_ROUTER_STATE=<home>/.router deploy/install.sh router   # 編譯到 <home>/.router/cc-telegram-router, 複製 templates 與報表腳本; 還沒有 config.json 而且在終端機裡時接著開設定嚮導
deploy/install.sh plugin   # 打包 plugin v2 到官方 plugin 快取路徑 (第一次會備份原內容), 並在 stateDir 記下檔案指紋
deploy/install.sh unit     # 安裝 systemd user unit
deploy/install.sh setup    # 設定嚮導 (第一次 router 已經帶起時不用再跑; 之後要改設定再跑, 見下方「設定嚮導」)
sudo loginctl enable-linger <使用者>   # 見下方「登出後繼續執行 (linger)」
cd <home> && claude        # 只有第一次: 接受資料夾信任後離開 (/exit), 見下方「資料夾信任」
systemctl --user enable --now cc-telegram-router
```

`deploy/install.sh` 的每個子指令 (`router`, `plugin`, `unit`, `setup`, `all`) 開頭先做前置檢查 (`deploy/preflight.ts`, 測試 `router/test/preflight.test.ts`), 沒過就停下並說明怎麼補:

1. bun: `command -v bun` 找得到 (印出路徑), 版本符合 `package.json` 的 `engines.bun` (照 engines 讀, 太舊時提示 `bun upgrade`). 找不到 bun 時提示官方安裝方式 (放在 `~/.bun/bin`, 要加進 PATH).
2. 相依套件: `node_modules` 裡每個 `bun.lock` 的套件都在而且版本相同; 不存在或過期時自動執行 `bun install --frozen-lockfile` 並印出正在做, 失敗 (例如 lockfile 跟 package.json 不一致) 就停, 不會改用沒鎖版本的 `bun install`.
3. claude: `command -v claude` 找得到並印出版本; 比開發與測試用的版本 (README Requirements) 舊時只警告, 找不到就停.

`deploy/install.sh unit` 產生 systemd unit 時, unit 的 PATH 是 `~/.local/bin:~/bin:/usr/local/bin:/usr/bin:/bin`, 前面再加上 bun 所在的資料夾 (`command -v bun`) 與 claude 所在的資料夾 (config 的 `claudeBin` 是絕對路徑時用它, 否則 `command -v claude`), 已經在清單裡的不重複加. worker 的 telegram plugin 由 `.mcp.json` 直接執行 `bun`, PATH 裡沒有 bun 時 plugin 起不來 (router log 的 `plugin did not connect`). 找不到 bun 就停; 已安裝的 unit 重跑 `deploy/install.sh unit` 就會更新, 再 `systemctl --user restart cc-telegram-router`.

### 設定嚮導

`deploy/install.sh setup` 執行 `<home>/.router/cc-telegram-router --config <home>/.router/config.json setup`, 再 `register` 寫入位置檔; `deploy/install.sh router` 編譯完發現還沒有 config.json 而且在終端機裡時也會自己帶起它 (程式在 `router/wizard.ts`, 測試 `router/test/wizard.test.ts`, `e2e-wizard.test.ts`, `e2e-compiled.test.ts`). 只能在終端機執行: stdin 或 stdout 不是終端機時拒絕 (結束碼 2), 改照下方範例與「設定欄位」手寫 config.json.

- 新建 (沒有 config.json): 問 `home` (預設 config.json 所在資料夾的上一層; 必須是絕對路徑, 不能是使用者的家目錄, 因為在家目錄接受的資料夾信任不會存下來), `owners` (可以不填, 用認領碼), `model`, `claudeBin` (預設 PATH 找到的 claude), 再設定 bot; `stateDir` 寫成 config.json 所在的資料夾.
- 每隻 bot: 名稱 (英數, `-`, `_`), token, Bot API. token 輸入時每個字元 (含一次貼上的每個字元) 顯示一個 `*`; Backspace (含 Ctrl-H) 刪最後一個並擦掉一個 `*`, Ctrl-U 清空, Enter 結束, Ctrl-C 取消整個嚮導; 方向鍵等控制序列與 bracketed paste 的標記忽略. 畫面上與錯誤訊息裡都不會出現 token. Bot API 選官方或自架的本機 server; 自架再問網址 (預設 `http://127.0.0.1:8081`) 與 `localFilesDir` (server 的 `--dir`, 可不填), 寫進那隻 bot 的 `apiRoot` 與 `localFilesDir` (選官方而全域 `apiRoot` 是自架時, 那隻 bot 寫 `"apiRoot": "https://api.telegram.org"`). 然後用那隻 bot 的 server 呼叫 getMe: 成功顯示 `@username (id)`, 失敗時可以重打 token, 重選 server, 或放棄 (不寫入).
- 修改模式 (已有 config.json): 每一題 `[ ]` 裡是目前的值, Enter 保留; 只有你改了的欄位會寫入, 嚮導沒問的欄位 (`credentials`, `secretKey`, `classifier`, `sandboxDenyRead`, `receiveReact` 等) 與 JSON 的其他內容不動. `owners` 輸入 `-` 清空. 每隻 bot 可保留, 修改或移除 (最後一隻不能移除), 也能新增. token 只顯示「已設定 (末 4 碼)」, Enter 保留; 換 token 只接受同一隻 bot 的 (冒號前的 id 相同, 跟 `/router bot rotate` 一樣), 要換成別的 bot 就移除後新增. token 或 Bot API 改了才重新 getMe. 全部問完列出變更 (token 只寫「更換」), 確認後才寫; 沒有變更就不寫.
- `access.json`: 不存在時建立 `{"dmPolicy": "pairing", "allowFrom": [<owners>], "groups": {}, "pending": {}}`; 已存在時不換掉, 只把還不在 `allowFrom` 的 owner 加進去 (其他內容不動). 移除 owner 不會把人移出 `allowFrom`.
- 模型: 問模型前說明哪些模型本身就是 1M context, `[1m]` 要什麼額度; 選了 200K 的模型 (Opus 4.6, Sonnet 4.6 沒有 `[1m]`, 或更舊的) 而 autoCompactWindow 大於 200000 時, 提醒並問要不要改成 200000.
- 寫入: config.json 與 access.json 都先寫暫存檔 (權限 600) 再改名. router 正在執行 (socket 存在) 時提醒要重啟才套用, 嚮導不會自己重啟.
- 資料夾信任 (有寫入或沒有變更時): home 已被信任就說明; 沒有就先給官方建議的互動做法, 再問要不要由嚮導代寫, 只有輸入 `y` 才寫. 代寫照官方文件的手動做法, 在 `~/.claude.json` 把 `projects["<home>"].hasTrustDialogAccepted` 設成 `true` (home 在 git repo 裡時是 repo 根目錄): 先備份成 `~/.claude.json.cc-router-backup-<GMT+8 時間>` (權限 600), 寫之前重新讀最新內容, 只改這一個設定, 暫存檔保留原權限再改名, 寫完讀回確認, 3 秒後再讀一次; 每個執行中的 Claude Code 都會整檔改寫這個檔, 被蓋掉時說明並改建議互動做法. router 正在執行時先提醒 (它的 worker 隨時會寫這個檔, 建議先停 router). home 是使用者的家目錄時不代寫 (家目錄的信任不會存下來). router 本身只讀 `~/.claude.json`, 從不寫.
- 結尾 (有寫入或沒有) 跑一次 `cc-telegram-router doctor` (見「cli doctor 與 worker 狀態」); 還沒有 config.json 時只檢查 bun 與 `claudeBin` 在 systemd unit 的 PATH 下找不找得到: 已安裝的 unit (`~/.config/systemd/user/cc-telegram-router.service`) 看它的 `Environment=PATH=`, 還沒安裝看上面那份預設清單; 找不到就說明要重跑 `deploy/install.sh unit` (或把 `claudeBin` 改成絕對路徑).

### 登出後繼續執行 (linger)

router 是 systemd user service: 沒開 linger 時, 使用者的 systemd 只在他登入期間存在, 最後一個 session 登出 (例如 ssh 斷線) router 就跟著停, 開機後也要等他登入才會啟動. 開一次就好: `sudo loginctl enable-linger <使用者>` (有些系統允許使用者自己打 `loginctl enable-linger` 不用 sudo). 確認: `loginctl show-user <使用者> -p Linger` 要印出 `Linger=yes`. 關閉是 `loginctl disable-linger <使用者>`.

### 資料夾信任

router 以 `claude --bg` 在每個對話資料夾 (`<home>` 底下) 啟動 worker. Claude Code 啟動背景 session 前會檢查那個資料夾有沒有被信任 (workspace trust), 沒信任又沒辦法跳出確認框時直接失敗 (`Workspace not trusted`). 所以第一次要在 `<home>` 互動執行一次 `claude`, 在信任確認框選接受, 然後離開.

依 Claude Code 官方文件 ([Configure permissions: Project allow rules and workspace trust](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust)): 不在 git repo 裡時, 信任記在啟動 claude 的那個資料夾, 並涵蓋它底下的所有子資料夾, 所以之後才建立的對話資料夾不用再個別信任. 例外:

- `<home>` 本身在某個 git repo 裡時, 信任記在那個 repo 的根目錄 (同樣涵蓋整個 repo).
- 子資料夾裡巢狀的 git repo 不在涵蓋範圍: 對話資料夾本身被 `git init` 成 repo 時, 它的 worker 要另外信任 (在那個資料夾互動執行一次 `claude`).
- `<home>` 不要是使用者的家目錄 (`~`): 在家目錄接受的信任只在當次 session 有效, 不會寫到磁碟.

`<home>` 是 router 的家目錄, 位置可自選 (見下方「安裝位置」). 共用的 `<home>/CLAUDE.md` 可以從範例開始: `cp templates/CLAUDE.md.example <home>/CLAUDE.md`. worker 端的使用說明在 plugin 的 `/telegram:doc` skill (`plugin/skills/doc/SKILL.md`).

沒有終端機可以跑嚮導時, `<home>/.router/config.json` (權限 600) 與 `access.json` 也可以手寫, 建好後執行 `<home>/.router/cc-telegram-router register` (或再跑一次 `deploy/install.sh router`) 寫入位置檔. config.json 的例子 (欄位說明見下方「設定欄位」), access.json 見「私訊與群組的存取」:

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
  "skillRefreshAt": "05:00",
  "receiveReact": "botself_only"
}
```

私訊的角色就是使用者角色 (見 [權限](permissions.md#角色)). 從私訊還有自己角色的版本升級時, router 啟動會把私訊對齊使用者角色, log 裡每個有變的私訊一行 `dm role <對話>: <舊> -> <新> (the user's role)`, 並標記待輪替, 不用另外 `/router session rotate`. 升級前可以先查哪些私訊會變: `sqlite3 <home>/.router/router.db "SELECT c.key, c.role, coalesce(u.role, 'user') FROM conversations c LEFT JOIN users u ON u.uid = c.chat_id WHERE c.type = 'dm' AND c.role != coalesce(u.role, 'user')"` (config `owners` 的私訊會是 owner, 不看 `users`).

`owners` 可以留空, 用 log 裡的認領碼認領 (見下方「新 bot 初次設定與審核群組」). 套件審核用的模型就是 `model`. `skillRefreshAt` 是特權技能每日更新憑證的時間 (GMT+8 `"HH:MM"`, `"off"` 關閉, 不寫就是 `"05:00"`), 改了要重啟 router; 格式寫錯只會關閉每日更新並在 log 寫一行 `config.json: ...`, router 照常啟動. 沒有特權技能, 或技能沒有 refresh 動作時, 每日更新什麼都不做. `receiveReact` 是對話沒有自己設定時收哪些表情回應 (`all`, `botself_only`, `disable`, 不寫就是 `botself_only`), 見下方「表情回應 (reaction)」.

## 設定欄位

`config.json` 的每個欄位 (`router/config.ts`). 手改 config.json 要重啟 router 才生效; `/router config set` 能改的 (`model`, `autoCompactWindow`, `claudeBin`, `owners`) 立刻生效並寫回. 檔案含 bot token, 憑證與 `secretKey`, 權限要是 600.

| 欄位 | 說明 |
|---|---|
| `bots` | bot 清單, 每隻 `{ "name": ..., "token": ... }`, 至少一隻 (必填); 之後用 `/router bot add` / `rotate` 管理. 選填 `apiRoot` (這隻 bot 的 Bot API server, 優先於全域 `apiRoot`) 與 `localFilesDir` (自架 server 在 `--local` 模式時, 附件只從這個絕對路徑底下讀). 見[自架 Bot API server](#自架-bot-api-server). |
| `home` | router 的家目錄, 每個對話一個資料夾; 沒寫是 config.json 所在資料夾的上一層. 見[安裝位置](#安裝位置). |
| `stateDir` | 狀態目錄 (router.db, access.json, 技能的資料庫與憑證資料夾, 工具箱 `toolbox/` 與技能的 Python 環境 `skill-env/`, 執行檔); 沒寫是 config.json 所在的資料夾. 見[安裝位置](#安裝位置). |
| `socket` | router 的 unix socket (plugin, hook 與 `cli` 連它); 沒寫是 `<stateDir>/router.sock`, 放在 home 與 stateDir 以外時沙箱另外隱藏它. 見[安裝位置](#安裝位置). |
| `owners` | 一律是 owner 的 Telegram uid; 可以留空, 用認領碼認領. 見[新 bot 初次設定與審核群組](#新-bot-初次設定與審核群組). |
| `model` | worker 與套件審核用的模型 (`--model`); 沒寫是 `claude-opus-5-5`. |
| `autoCompactWindow` | 新對話的 autoCompactWindow; 沒寫是 750000. |
| `claudeBin` | 啟動 worker, 套件審核與 `cc /` 代打用的 claude 執行檔; 沒寫是 `claude` (照 PATH 找). 只有 owner 能用 `/router config set` 改. |
| `apiRoot` | 沒有自己 `apiRoot` 的 bot 與 bot 憑證用的 Bot API 網址, 例如自架的 `http://127.0.0.1:8081`; 沒寫 (或不是 http(s) 網址) 是 `https://api.telegram.org`. 特權動作 `bots` 的 `$<ENV>_API` 也照它 (憑證有自己的 `apiRoot` 時用憑證的; 在主機本機時沙箱經 10.0.2.2 只連得到那個 port). 見[自架 Bot API server](#自架-bot-api-server), [bot 憑證 bots](credentials-and-skills.md#bot-憑證-bots). |
| `credentials` | 跨 bot 的 bot token 與 http API key, 名稱 -> `{ token, kind, methods, baseUrl, apiRoot, header, scheme, query, defaultHeaders, roles, label, addedBy }`; 由 `/router cred` 與 `cred-import` 管理, 不要手改 (例外: telegram-bot 類的 `apiRoot`, 這個憑證要走的 Bot API server, 沒寫用全域 `apiRoot`, 手改後 `/router cred reload`). 見[憑證](credentials-and-skills.md#憑證). |
| `secretKey` | 加密對話密鑰與原始事件的 AES-256 key (base64); 沒有時 router 啟動時產生並寫回 config.json. 遺失就解不開已存的密鑰與原文, 要跟 router.db 一起備份. 見[密鑰](secrets.md). |
| `skillRefreshAt` | 特權技能每日更新憑證的時間, GMT+8 `"HH:MM"`, `"off"` 關閉; 沒寫是 `"05:00"`, 寫錯只關閉每日更新. 見[特權技能](credentials-and-skills.md#特權技能). |
| `pluginCheckAt` | 每天檢查官方 plugin 快取的時間, GMT+8 `"HH:MM"`, `"off"` 關閉; 沒寫是 `"09:07"`, 寫錯只關閉每日檢查 (worker 打招呼時的檢查照舊). 見[官方 plugin 的自動更新與快取檢查](#官方-plugin-的自動更新與快取檢查). |
| `classifier` | 工具呼叫分類器 (選配, 預設關閉, 第一階段只記錄); 格式錯只關閉它. 見[工具呼叫分類器](classifier.md). |
| `sandboxDenyRead` | 所有沙箱 (角色範本與特權動作) 額外隱藏的絕對路徑, 例如同一台機器上其他專案; 沒寫是沒有, 寫錯的項目略過. 見[安裝位置](#安裝位置). |
| `sandboxTimezone` | 特權技能沙箱的時區 (`TZ` 與 `/etc/localtime`), `/usr/share/zoneinfo` 裡的名稱; 沒寫或寫錯是 `Asia/Taipei`. 見[執行環境規格](skill-runtime.md#時區). |
| `sandboxExtraRo` | 特權技能的沙箱額外唯讀看得到的絕對路徑 (沙箱是白名單, 預設只有 `/usr` 與少數 `/etc` 檔), 結尾是 `/bin` 的放進 PATH; 沒寫是沒有, 寫錯的項目略過. 見[執行環境規格](skill-runtime.md#掛載路徑). |
| `receiveReact` | 對話沒有自己設定時收哪些表情回應: `all`, `botself_only`, `disable`; 沒寫是 `botself_only`. 見[表情回應 (reaction)](#表情回應-reaction). |
| `reactFlushMs` | 表情回應等多少毫秒沒有新訊息就單獨交給 worker; 沒寫是 60000, 測試才縮短. 見[表情回應 (reaction)](#表情回應-reaction). |
| `health` | 給外部監控 (例如 Gatus) 的 HTTP 健康檢查端點 (選配, 預設關閉): `{ "listen": "127.0.0.1:8787", "token": ..., "staleAfterS": 90 }`; 不是本機位址也照開, log 與啟動公告會警告; 寫錯或 port 被佔用只關閉它. 見[健康檢查端點](#健康檢查端點). |
| `backlogSweepFirstMs` | 只給測試用, 一般使用者不用設. router 啟動後多少毫秒第一次檢查佇列裡還沒送達的訊息 (先讓已經在跑的 worker 重新連上); 沒寫是 15000. |
| `vaultTickMs` | 只給測試用, 一般使用者不用設. 多久檢查一次到期要刪的密鑰訊息 (刪除時間本身不變, 例如群組指令仍是 10 秒後刪); 沒寫是 10000. |

選配欄位 (`skillRefreshAt`, `pluginCheckAt`, `classifier`, `sandboxDenyRead`, `sandboxExtraRo`, `sandboxTimezone`, `receiveReact`, `health`, `apiRoot`, bots 的 `apiRoot` 與 `localFilesDir`) 寫錯時 router 照常啟動, 該功能關閉或用預設值, 啟動時 log 寫一行 `config.json: ...`.

## 官方 plugin 的自動更新與快取檢查

worker 載入的 plugin v2 是 `deploy/install.sh plugin` 蓋在官方 telegram plugin 的快取資料夾 (`~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7/`) 上的. Claude Code 對官方商店 `claude-plugins-official` 預設開啟自動更新: 互動 session (背景 worker 也算) 送出第一則訊息後, 隨機等最多十分鐘, 重新整理商店並把 plugin 更新到新的版本資料夾, 下一次啟動就載入官方版. 官方版不認識 router, worker 會收不到 Telegram 訊息. 所以:

- **worker 的 settings 關掉官方商店的自動更新**: `templates/base-settings.json` 的 `extraKnownMarketplaces` 宣告 `claude-plugins-official` 的 `autoUpdate: false`. 依官方文件 ([plugins/loading 的 When auto-update runs](https://code.claude.com/docs/en/plugins/loading#when-auto-update-runs)), settings 檔裡 `extraKnownMarketplaces` 的 `autoUpdate` 優先於 `known_marketplaces.json` 與預設值. 來源必須照寫官方的 `github` `anthropics/claude-plugins-official`: `claude-plugins-official` 是保留名稱, 來源不是 `github.com/anthropics/` 時 Claude Code 會把整個商店判為不受信任的來源而停用 (連 telegram plugin 一起); 同名的項目由優先序最高的檔整筆取代, 所以角色範本不能再定義它. 建議全機的 `~/.claude/plugins/known_marketplaces.json` 也把它設成 `"autoUpdate": false` (或在 `/plugin` 的 Marketplaces 關掉 Enable auto-update), 讓終端機的 session 也不會更新它. 手動重裝 (`claude plugin install telegram@claude-plugins-official`) 或 `claude plugin update` 仍會換掉快取, 不受這個設定影響, 由下面的檢查抓出來.
- **部署時記下指紋**: `deploy/install.sh plugin` 部署後在 stateDir 寫 `plugin-fingerprint.json`: 部署的版本資料夾與其中每個檔案的 sha256 (Claude Code 自己的 `.in_use`, `.orphaned_at` 不算). 還不知道 stateDir 時 (第一次安裝, router 還沒裝) 只部署不記, 印一行提示.
- **router 檢查快取** (`router/pluginguard.ts`): 每個 worker 的 plugin 打招呼 (hello) 時, 以及每天 `pluginCheckAt` (預設 09:07, GMT+8), 比對: `~/.claude/plugins/installed_plugins.json` 裡 `telegram@claude-plugins-official` 的每一筆 `installPath` 是否還是部署的資料夾; 資料夾裡的檔案是否跟指紋相同 (內容改變, 多出, 少了); 資料夾是否被標了 `.orphaned_at` (Claude Code 換版後標記舊版, 14 天後刪除); 同一層有沒有出現其他版本資料夾. 有不符就通知 owner (每隻 bot 的重要通知位置, 同一個位置只送一次), 說明可能被官方更新或手動 update 蓋掉, 請重新 `deploy/install.sh plugin` 後 `/router session rotate all`. **router 不改任何檔.** 打招呼時只在問題跟上次通知的不同時才通知; 每日檢查只要還有問題就再通知一次. 恢復正常, 或還沒有指紋 (這版之後還沒跑過 `deploy/install.sh plugin`) 時只寫 log. Claude Code 的 plugins 根目錄照它的規則: 有 `CLAUDE_CODE_PLUGIN_CACHE_DIR` 用它, 否則 `~/.claude/plugins`.

手動跟進官方新版: 官方更新了 telegram plugin (例如修了跟 Claude Code 新版的相容問題) 而我們要跟進時, 先看官方的改動 ([原始碼](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)), 需要的部分併進 `plugin/`; 若官方版本號變了而要換快取資料夾, 改 `deploy/install.sh` 的 `PLUGIN_CACHE`, 在終端機 `claude plugin marketplace update claude-plugins-official` 與 `claude plugin update telegram@claude-plugins-official` 取得新版資料夾, 再跑 `deploy/install.sh plugin` 蓋上 v2 並重記指紋, 最後 `/router session rotate all`. 換版時 router 的檢查會先通知一次 (installPath 與版本資料夾變了), 部署完重記指紋就恢復.

## 自架 Bot API server

bot 可以改走自架的 [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) (例如要收發超過 50 MB 的檔案), 不用改程式, 只改 config.json 後重啟 router.

設定 (程式在 `router/config.ts`, `router/telegram/files.ts`):

- 每隻 bot 用哪個 server: `bots[]` 那一項的 `apiRoot`, 沒寫就用全域 `apiRoot`, 再沒有就是官方 `https://api.telegram.org`. 網址結尾的 `/` 可有可無; 不是 http(s) 網址時 log 寫一行 `config.json: ...` 並改用上一層. 例如全部 bot 都走同一台: `"apiRoot": "http://127.0.0.1:8081"`; 只有一隻: `{ "name": "cc", "token": "<bot token>", "apiRoot": "http://127.0.0.1:8081", "localFilesDir": "<server 的 --dir>" }`.
- 這隻 bot 的每個 Bot API 呼叫都走它的 server: 收訊 (getUpdates), 發訊與上傳, 啟動與 `/router bot rotate` 的 getMe, worker 的 `bot_api` (`self`), 附件下載 (`download_attachment`, 照片與文字附件收到時的下載). `/router bot add` 新增的 bot 沒有自己的 `apiRoot`, 走全域的; 要個別設定就改 config.json 後重啟. `/router bot rotate` 只換 token, `apiRoot` 與 `localFilesDir` 保留.
- 其他 bot 的憑證 (`credentials` 的 telegram-bot 類) 可以加 `apiRoot`, 沒寫用全域的; `bot_api`, `cli cred call`, 特權動作的 `$<ENV>_API`, `/router cred rotate` 的 getMe 都照它. 新增憑證 (`/router cred add`, `cred-import`) 時用全域的, 要個別設定就手改 config.json 後 `/router cred reload`. 試跑 (`skill_try`, `skill run --trial --api`) 一律走假服務; 對話密鑰 (`/secret set` 的 telegram-bot 類) 走全域 `apiRoot`.
- 從官方 server 搬過去之前, Telegram 要求 bot 先在官方 server 呼叫一次 `logOut`, 否則不保證收得到 update (之後 10 分鐘內不能再登入官方 server). worker 不能呼叫這個方法, 由 owner 在終端機自己做: `curl https://api.telegram.org/bot<bot token>/logOut`.

本機模式 (`--local`):

- server 以 `--local` 啟動時, `getFile` 回的是 server 主機上的絕對路徑, 而且沒有 `/file` 下載端點. router 看到絕對路徑就自己從磁碟讀, 所以 router 要跟 server 在同一台 (server 在 docker 裡時, 把它的 `--dir` 以相同路徑掛到主機上). 回相對路徑時 (沒開 `--local`, 或官方 server) 照舊從 `<apiRoot>/file/bot<token>/<路徑>` 下載.
- 檔案權限: 執行 router 的使用者要能讀 server `--dir` 底下的檔案, server 通常以自己的使用者寫檔. 做法例如把 router 的使用者加進 server 使用者的群組, `--dir` 底下的資料夾給群組讀取與進入 (`r-x`), 檔案給群組讀取, 並讓 server 的 umask 建出群組可讀的檔案. 讀不到時 `download_attachment` 回「router 沒有讀取權限」; 找不到檔案時回「不存在」(提示要在同一台, 同一路徑).
- 檢查: 路徑解開符號連結後要是一般檔案, 最大 2000 MB; 不能落在 router 的 `stateDir` 或 `home` 底下 (server 的 `--dir` 不要放在 router 的 home 裡), 避免 server 出問題時被拿來讀 config.json; 有設 `localFilesDir` 時還要在它底下 (建議設成 server 的 `--dir`). 路徑只來自 server 的 `getFile` 回應, worker 只能給 file_id.
- `--local` 的路徑裡有 bot token (server 每隻 bot 一個資料夾): 錯誤訊息裡的 token 換成 `<token>`, 交給下游 (router.db 的 `attachment_cache`, 密鑰偵測, 存下來的檔名) 的路徑只留最後兩段 (例如 `documents/file_3.txt`).

大小上限:

- 上傳 (`reply` 的 `files`, `send_sticker` 的 `file`): 這隻 bot 的 `apiRoot` 不是官方 (主機不是 `api.telegram.org`) 時 2000 MB, 官方 50 MB, 超過時送出前就拒絕. 自架但沒開 `--local` 的 server 實際上限仍是 50 MB, 超過時由 server 回錯誤. `bot_api` 工具上傳的檔案不另外檢查, 由 server 決定.
- 下載: 官方 server 只能下載 20 MB 以內的檔案 (Telegram 的限制); `--local` 從磁碟讀, 上限 2000 MB.

測試: `router/test/local-bot-api.test.ts` (模組), `router/test/e2e-localapi.test.ts` (從原始碼跑的 router, 兩隻 bot 各接一台假 server), `router/test/e2e-compiled.test.ts` (編譯版).

## 私訊與群組的存取

`<stateDir>/access.json` 決定誰的訊息送進 worker (`router/telegram/policy.ts`), 用 `/router access` 管理 (owner 與 admin). 格式沿用上游: `{ "dmPolicy": ..., "allowFrom": [uid...], "groups": { "<chat_id>": { "requireMention": true, "allowFrom": [] } }, "pending": {} }`.

- `dmPolicy` `pairing` (預設): 不在 `allowFrom` 的人私訊 bot 時拿到一組 6 碼配對碼 (訊息不送進 worker), owner 或 admin 用 `/router access pair <碼>` 核可 (加進 `allowFrom`, bot 回他「配對完成」) 或 `deny <碼>` 拒絕. 碼 1 小時有效; 同時最多 3 個待核可, 超過時新來的人不回應; 同一個人在碼有效期間再私訊只再回一次碼, 之後不回應. 發碼的同時, 申請貼到審核群組的「🤝 配對申請」話題 (沒有審核群組就私訊 owner), owner 或 admin 按「✅ 同意」或「❌ 拒絕」就等於下 pair 或 deny, 見[私訊配對](permissions.md#私訊配對).
- `allowlist`: 只收 `allowFrom`, 其他人不回應也不發碼; `/router access allow <uid>` 與 `remove <uid>` 管理名單.
- `disabled`: 私訊與群組都不收.
- owner 一律在 `allowFrom` 裡: 私訊的 gate 只看 `allowFrom`, 所以每種成為 owner 的方式都會把 uid 加進去: 認領碼 (`/start <碼>`), 設定嚮導, `/router config set owners`, `/router role <uid> owner`, 以及 router 啟動時 (config 的 `owners` 與 `users` 表裡角色是 owner 的人, 例如手改了 config.json; log 寫一行 `access.json: owner ... 加入 allowFrom`). 只會加入, 移除 owner 不會把人移出 `allowFrom`. 測試: `router/test/owners-access.test.ts`, `e2e-wizard.test.ts`, `wizard.test.ts`.
- 群組: `/router access group add <chat_id> [--no-mention]` 加入 (預設 `requireMention` 為 true, 要 mention bot 或回覆 bot 才送進 worker), `group rm <chat_id>` 移除; 沒列在 `groups` 的群組不回應. 群組的 `allowFrom` 不是空的時只收名單內的人 (手改 access.json).
- `/router access` (或 `show`) 列出目前設定與待核可的碼; `/router access policy <pairing|allowlist|disabled>` 切換模式.

## 疑難排解

先跑一次 `cc-telegram-router cli doctor` (見下方「cli doctor 與 worker 狀態」), 它把下面大部分的項目一次查完, 輸出可以直接貼給別人.

- `plugin did not connect` (router log): worker 的 telegram plugin 沒連上 router. router 會讀那個對話的 plugin log, 把原因寫進「🔔 重要通知」(例如 `Executable not found in $PATH: "bun"`). 依序檢查:
  1. unit 的 PATH 有沒有 bun: `systemctl --user cat cc-telegram-router` 的 `Environment=PATH=` 要包含 `command -v bun` 所在的資料夾 (bun 的官方安裝位置 `~/.bun/bin` 不在預設清單裡). 沒有就重跑 `deploy/install.sh unit`, 再 `systemctl --user restart cc-telegram-router`. 設定嚮導結尾也會提醒.
  2. plugin 有沒有裝好: `deploy/install.sh plugin` 之後官方 plugin 快取路徑裡是 v2 (`.deployed-version` 是 `v2`).
  3. plugin 自己的 log: `~/.cache/claude-cli-nodejs/<對話資料夾的絕對路徑, 每個 / 換成 ->/mcp-logs-plugin-telegram-telegram/`. 例如對話資料夾 `/srv/cc/bot123/dm-555` 的 log 在 `~/.cache/claude-cli-nodejs/-srv-cc-bot123-dm-555/mcp-logs-plugin-telegram-telegram/`, 裡面有 plugin 啟動失敗的原因 (例如找不到 bun).
- `deploy/install.sh` 一開始就停: 照它印出的前置檢查說明補 (裝或更新 bun, 在 repo 執行 `bun install --frozen-lockfile`, 裝 Claude Code), 再重跑同一個子指令.
- worker 起不來, log 有 `Workspace not trusted`: 見上方「資料夾信任」. router 啟動時也會檢查 home 有沒有被信任, 沒有就發「🔔 重要通知」; 設定嚮導可以代寫 (見「設定嚮導」).
- 每一輪都沒有回覆, 對話裡出現「⚠️ 暫時無法回應」, 重要通知寫「這一輪因 API 錯誤結束」: worker 的 Claude Code 每一輪都在 API 那裡失敗, router 從 StopFailure hook 得知原因. 最常見的是模型名稱帶 `[1m]` (例如 `claude-sonnet-4-6[1m]`) 而帳號沒有 1M context 的額度, 訊息是 `Usage credits required for 1M context`: 改用沒有 `[1m]` 的模型 (`/router config set model claude-sonnet-4-6`, 或 `/router chat <chat_id> model ...` 只改一個對話), 把 `autoCompactWindow` 調到 200000 以下, 或在 router 的使用者下開 `claude` 執行 `/usage-credits` 開啟額度. Opus 4.7 以上, Sonnet 5 以上, Fable 與 Haiku 5.5 本身就是 1M context, 不需要 `[1m]`; Opus 4.6 與 Sonnet 4.6 只有 `[1m]` 版本才是 1M, Sonnet 4.6 的 1M 在所有方案都要 usage credits.
- 改了模型 (或其他啟動參數) 卻沒有生效 (舊參數殘留): 不帶旗標的 `--resume` 會沿用 daemon job 建立時的參數 (舊的 `--model`). 2.26.0 起 router 叫醒時比對 job 存的旗標, 不同就 `claude stop` 加 `claude rm` 再帶新旗標 resume (見「背景 session 的 job 與 daemon」); `/router config set model` 讓用預設模型的對話閒置時輪替, `/router chat <chat_id> model <模型>` 立刻重啟. 還是沒生效就看 log 有沒有 `was started with other flags` 與 `claude rm ... failed`, 並跑 `cli doctor` 看殘留的 job.
- `journalctl --user -u cc-telegram-router` 在停止或重啟時出現 `Unit process ... remains running after unit stopped` 或 `Found left-over process ... (claude) in control group while starting unit. Ignoring.`: 這是正常的. unit 用 `KillMode=process`, 停止 router 時只停 router 自己, 由 `claude --bg` 啟動的 worker 與它的 daemon 刻意留著繼續跑 (不然每次重啟 router 都會砍掉所有 worker), systemd 才會提醒有程序留在 cgroup 裡.
- `--local` 的附件下載失敗: 見「自架 Bot API server」的檔案權限.

## cli doctor 與 worker 狀態

- `cc-telegram-router cli doctor` (Telegram 裡是 `/router doctor`, owner 與 admin, 回在私訊) 經由執行中的 router 一次檢查, 每項一行 (✅ 正常, ⚠️ 要注意, ❌ 會出問題), 不含任何 token, 可以直接貼給別人: bun 與 `claudeBin` 在 systemd unit 的 PATH 下找不找得到 (還沒安裝 unit 時看預設清單); 官方 telegram plugin 是否裝在這個使用者, 跟 `deploy/install.sh plugin` 部署時相同; 位置檔 (`~/.config/cc-telegram-router/router.json`) 是否指向這個 router; home 是否被 Claude Code 信任 (另列自己是 git repo, 不吃 home 信任的對話資料夾); 預設與各對話的模型和 autoCompactWindow 是否一致; 不是對話目前 session 的殘留 job (判斷與 router 的 job 清理相同, `router/jobs.ts`; router 自己每 10 分鐘清掉, doctor 只列出) 與卡住 (`blocked`) 的 worker; claude daemon 是否由 router 帶起, 有沒有沒有 daemon 在管的暖機 spare (同「背景 session 的 job 與 daemon」的唯讀檢查); 在跑但 plugin 沒連上的 worker. router 沒在執行時用 `cc-telegram-router [--config <路徑>] doctor` (少了連線那一項); 設定嚮導結尾也會跑一次. 程式在 `router/doctor.ts`, `router/diagnose.ts`, 測試 `router/test/diagnose.test.ts`, `e2e-diagnose.test.ts`.
- `/router status` 在每個對話後面多列: worker 在 daemon 裡的狀態 (不是 done, idle, working 時才列, 例如 `worker blocked`), worker 在跑但 plugin 沒連上, 以及 24 小時內最後一次的問題與時間 (GMT+8), 例如 `⚠️ 13:05 資料夾沒有被信任 (Workspace not trusted)`. 這些只存在 router 的記憶體, 重啟後清空.
- 叫不醒的 worker: 叫醒流程先照「背景 session 的 job 與 daemon」比對旗標 (不同就換掉 job), 再 `--resume` 或開新 session; `claude --bg` 本身拒絕 (例如 `Workspace not trusted`) 時立刻算失敗, 不等 plugin; 否則等 plugin 連線 90 秒. 原因依序取: `claude --bg` 的訊息, 那個對話的 plugin log 最新檔 (10 分鐘內寫的, 只看連線失敗與找不到執行檔這類, 不看工具錯誤), 資料夾信任. 連續失敗時下一次叫醒的間隔是 1, 2, 5, 10, 30 分鐘 (之後都是 30), 期間的訊息留在佇列, 時間到了再試; 同一個對話同一個原因只通知一次, 換了原因再通知, 恢復連線時通知一次. 修好後 `/router session restart <chat_id>` 立刻重試, 不用等.
- 一輪以 API 錯誤結束 (worker 的 StopFailure hook 回報錯誤類型, 細節與 Claude Code 顯示的錯誤文字): 重要通知寫原因, 原始訊息 (遮蔽 token) 與修法 (1M context 額度, 登入失效, 付款, 額度用完, 模型不存在, 服務忙碌, 輸出過長, 安全機制), 同一對話同一原因 30 分鐘內只通知一次; 對話裡回一句「⚠️ 暫時無法回應: <簡短原因>. 已通知管理員.」, 同一對話 5 分鐘內只回一次.
- router 啟動時 (第一隻 bot 取得 getMe 後) 檢查一次, 有問題就發重要通知: router 自己的 PATH (也就是 unit 的 PATH) 找不到 bun; home 沒有被 Claude Code 信任, 或讀不到 `~/.claude.json`; 預設模型需要 1M context 額度, 或 autoCompactWindow 超過模型的 context.

## 升級

1. 取得新版 (例如 `git pull`), 看 CHANGELOG 這幾版有沒有要另外做的事.
2. 編譯與安裝 (router 照常執行, 執行檔是換檔不是覆寫, 不影響正在跑的程序):

   ```bash
   deploy/install.sh router
   deploy/install.sh plugin   # 也重記官方 plugin 快取的指紋 (見「官方 plugin 的自動更新與快取檢查」)
   deploy/install.sh unit     # 只有 deploy/cc-telegram-router.service 改過時需要 (CHANGELOG 會寫)
   ```

3. 停 router 並備份 (worker 不受影響; 這段時間傳來的訊息留在 Telegram, router 起來後照常收): router.db 是 WAL 模式, `-wal` 與 `-shm` 檔要一起複製; config.json 含 token 與 `secretKey`, 備份資料夾權限設 700.

   ```bash
   systemctl --user stop cc-telegram-router
   mkdir -m 700 -p <備份資料夾>
   cp -a <home>/.router/router.db* <home>/.router/config.json <備份資料夾>/
   ```

4. 啟動: `systemctl --user start cc-telegram-router`. 資料庫結構由 router 啟動時自動升級: 只新增資料表與欄位, 不刪除也不改名; 有些版本另外做一次性的資料調整 (記在 router.db 的 `migrations`, 會寫在 CHANGELOG 與 log).
5. 讓 worker 載入新的 plugin 與設定: 在 Telegram 打 `/router session rotate all`, 或終端機 `<home>/.router/cc-telegram-router cli session rotate all`. 閒置的 worker 一分鐘內停掉, 忙碌的等它閒置, 下一則訊息用新版叫醒.

要改設定 (換 token, 換成自架的 Bot API server, 加 owner 等): `deploy/install.sh setup` 的修改模式 (見上方「設定嚮導」), 再重啟 router.

退版: 切回舊版重跑步驟 2 再重啟. 新版只新增資料表與欄位, 舊版通常能直接用同一份 router.db; 要完全回到升級前, 停 router 後把備份的 `router.db*` 與 config.json 複製回去再啟動.

## 表情回應 (reaction)

worker 收得到 Telegram 的 message reaction, 但不是每個表情都叫醒它:

- 收哪些: `all` 對話裡所有訊息的表情, `botself_only` 只收對這隻 bot 自己發的訊息的表情 (預設), `disable` 不收. 每個對話用 `/router chat [對話] react <all|botself_only|disable|default>` 設定 (權限與指定對話的方式同其他 `/router chat` 子指令, `default` 回到 config 的 `receiveReact`), 私訊與群組都適用; `/router chat` 列出每個對話目前的值. config 的 `receiveReact` 改了要重啟 router; 值寫錯只會改用 `botself_only` 並在 log 寫一行.
- 誰的表情: 跟訊息一樣, 只有會送進 worker 的人 (私訊是 owner 與 `allowFrom`, 群組是列在 `access.json` 的群組, 群組有 `allowFrom` 時只收名單內的人). 還沒有對話的 chat 不收.
- 「bot 自己發的訊息」: 這隻 bot 每個 Bot API 呼叫的回應裡帶的訊息 (send*, forward*, copy*, edit* 系列, 含 worker 的 reply, router 的指令回覆與通知, worker 用 `bot_api` 以這隻 bot 送出的) 都記在 `router.db` 的 `bot_messages` (bot, chat_id, message_id); 這個表之前的舊訊息看訊息紀錄 (`messages`) 裡這隻 bot 送出的 (`direction = 'out'`). Telegram 的 reaction update 本身不帶訊息的發送者, 所以只能靠 router 自己的紀錄.
- 送出: 表情先存在 router (記憶體), 在這個對話的下一則訊息送進 worker 時整理成 `<reactions>` 區塊附在前面; 或最後一個表情之後 1 分鐘內沒有新的表情也沒有新訊息, 就單獨送進 worker (會叫醒它), 每來一個新表情就重新計時. 單獨送的那一則以 router 名義送 (meta `user="router" kind="reactions"`), 不帶發送者, 不會讓任何人的角色替這一輪提權 (前一則訊息的發送者也不算); 那一輪不顯示「🤔 思考中…」(hook 看到這一輪的 prompt 只有 reactions 的 `<channel>` 才算, 跟一般訊息在同一輪就照常顯示).
- router 停止或重啟 (SIGTERM, SIGINT, 例如 `systemctl restart`, 以及 `/router restart`) 時不會丟掉表情: 先停止收 Telegram 的 update, 再把每個對話還沒送的表情立刻照「單獨送出」送出, 等連線中的 worker 確認收到 (ack) 最多 5 秒, 之後才關 socket 結束. 超過 5 秒沒確認的記一行 log (`reactions <對話>: not acked within 5000ms at stop, stays queued`), 那一則留在 `router.db` 的佇列, worker 重新連上 router 時重送 (plugin 依 qid 去重). worker 沒連上 (閒置被停掉) 的對話不在停止時叫醒, 只寫進佇列並記 log (`worker not connected, queued at stop`), router 下次啟動 15 秒後的佇列巡檢會叫醒它送出; router 停了不再啟動時就留在佇列裡, 下次啟動才送.
- 摘要: 每則被回應的訊息一行, `1001 🤣×2 (Example User, Another User); 👍 (Example User)`; 同一人換表情或收回只算最後的狀態 (收回就消失, 某則訊息最後沒有任何表情就不列); 名稱是 Telegram 顯示名稱 (first + last name, 匿名管理員是群組名稱), 跟附件檔名一樣去掉 `< > [ ] ; 換行`, 最長 64 字, bot token 格式遮蔽; 自訂表情顯示 `[自訂表情]`, 付費表情 `[付費⭐]`. 最多列 50 則訊息, 超過時保留最近被回應的 50 則, 並註明省略幾則. 區塊開頭一行說明這是資訊不是指令, 名稱是不可信的外部資料.
- Telegram 的限制: getUpdates 的 `allowed_updates` 要明確列 `message_reaction` 才會收到 (空清單代表除了 `chat_member`, `message_reaction`, `message_reaction_count` 以外的全部), router 送的是空清單的那些類型再加 `message_reaction`, 原本收的類型都還在. **群組裡 bot 要是管理員才收得到 reaction**; 不是管理員時 `/router chat` 在那個群組註明「收不到 reaction (bot 不是管理員)」(查詢 getChatMember, 查不到時註明「查不到 bot 是否為管理員」). 私訊不需要. 匿名的表情計數 (`message_reaction_count`, 主要是頻道) 不收. bot 自己按的表情 Telegram 不會送來.

## 安裝位置

router 可以裝在任何位置, 程式不假設固定路徑:

- `home` 是 router 的家目錄, 每隻 bot 一個 `bot<id>/`, 每個對話一個資料夾都在這裡; 不寫時是 config.json 所在目錄的上一層. `stateDir` 放 router 執行檔, config.json, access.json, router.db, socket 與各對話的 settings; 不寫時是 config.json 所在目錄. 慣例是 `<home>/.router`, 也可以放在 home 以外.
- 位置檔: worker 的 plugin 與 hook 從 `~/.config/cc-telegram-router/router.json` 讀 router 的 `home`, `stateDir` 與 `socket` (`shared/locate.ts`). 不用環境變數, 因為背景 session 繼承的是 claude daemon 的環境, 而 owner 自己在 `<home>` 開的終端機 session 也要找得到 router. 位置檔由 `cc-telegram-router register` 依 config.json 寫入, `deploy/install.sh router` 在 config.json 已存在時會執行它. router 啟動時檢查位置檔: 指向自己 (同一個 `stateDir`) 但 `home` 或 `socket` 改過就更新並記 log; 不存在或指向另一個 router 只記 log, 不會改寫 (測試與第二套安裝不會蓋掉正式的位置檔). 位置檔不存在時, plugin 回報「不是 Telegram worker」並說明原因, hook 視同 router 連不上 (不准跳出 sandbox). plugin 只在 session 啟動時讀一次, 所以要先寫好位置檔再叫醒 worker.
- `deploy/install.sh router` 與 `unit` 要知道 `stateDir`: 第一次用 `CC_ROUTER_STATE=<home>/.router` 指定, 之後從位置檔讀; 兩者都沒有就停下並說明, 不會裝到預設位置.
- sandbox 隱藏的路徑: owner 以外的角色範本 `denyRead` 是 `{{hidden}}` 加上 `~` (使用者家目錄). `{{hidden}}` 是 router 的家目錄, `stateDir` (在家目錄底下時已包含在內) 與 config `sandboxDenyRead` (額外要隱藏的絕對路徑, 預設空; 例如同一台機器上其他專案所在的目錄), 互相包含的只留最外層. config `socket` 設在這些位置以外時, socket 檔本身也列入 (只藏那個檔, 不藏它所在的資料夾, 例如 `/tmp`, `/run`); socket 在使用者家目錄裡時 `~` 已經藏住, 不另外列; 設成系統資料夾 (`/`, `/tmp`, `/var/tmp`, `/run`, `/var/run` 等), 使用者家目錄或它的上層時不列, 以免 worker 壞掉. 自己的對話資料夾, 共用技能資料夾與 bot 的共用記憶 (`bot<id>/memory`, 唯讀, 見[權限: bot 共用記憶](permissions.md#bot-共用記憶)) 再由 `allowRead` 打開. 特權技能的 bwrap 沙箱是白名單 (見[執行環境規格](skill-runtime.md#掛載路徑)), 這份清單裡的路徑本來就不在沙箱裡; 只有被掛進沙箱的路徑 (`/usr`, `sandboxExtraRo`, internal 動作的 `host.mounts`) 裡含有清單上的路徑時才蓋住: 資料夾蓋上空的 tmpfs, 檔案 (socket) 蓋上 `/dev/null`, 不存在的略過; Claude Code 的 sandbox 對 `denyRead` 裡的檔案同樣蓋上 `/dev/null` (2.1.302 實測: 在 sandbox 裡 socket 變成字元裝置, 同資料夾的其他檔照常可讀; 連線另外被 sandbox 拒絕, `Operation not permitted`). `sandboxDenyRead` 的項目不是絕對路徑或是 `/` 時略過並在 log 寫一行, 其他項目照常隱藏. 改了要重啟 router, 再 `/router session rotate all` 讓 worker 用新的 settings.

## 新 bot 初次設定與審核群組

- config 沒有 owners 時, router log 會印出一次性認領碼; 私訊 bot `/start <碼>` 的人成為 owner (寫進 config 的 `owners`, 並加進 access.json 的 `allowFrom`).
- owner 第一次私訊一隻還沒設定的 bot, worker 會先訪談名字, 個性, 說話風格, 用途, 用 `save_bot_profile` 寫進 `bot<id>/CLAUDE.md`.
- 接著引導設定審核群組: 開了話題的 supergroup, bot 是管理員且能管理話題, 在群組裡下 `/router setup group`. router 建立「🔔 重要通知」「🔐 權限審核」「📜 提權紀錄」「🧾 執行授權」「🔑 密鑰偵測」「🤝 配對申請」六個話題 (已設定的群組再下一次會補上缺的話題; 缺「🔑 密鑰偵測」或「🤝 配對申請」的群組在 router 啟動時自動補建). 「🤝 配對申請」收私訊配對的申請與 ✅ 同意 / ❌ 拒絕 按鈕, 見[私訊配對](permissions.md#私訊配對). 可以略過, 之後通知與申請都私訊 owner (提權紀錄只留在 router.db).
- 設定存在 `bot_setup`, 以 bot 名稱為 key, 並記下它屬於哪個 Telegram bot id (`bot_id`, 跟 `bot<id>` 資料夾一樣是 token 冒號前那段; 啟動時補上現有 bot 的 id). `/router bot add` 時, 同名的設定屬於同一個 bot id 才沿用 (舊紀錄沒有 id 時, 看 `bot<id>` 資料夾在不在): 已完成人設的話, 回覆說明沿用既有人設與審核群組 (或照舊私訊 owner, 或提醒審核群組還沒設定), 不會再說要做初次設定. 名稱給了另一隻 bot 就當新 bot, 設定重置, 回覆照新 bot 的初次設定. 啟動時也一樣: `config.json` 裡某個名稱的 token 換成另一隻 bot (紀錄的 `bot_id` 跟 token 的 id 不同), 那個名稱的設定重置, router log 留一行, 並通知 owner 哪個名稱換了 bot (先用那隻 bot 送, 送不到再用其他 bot). 要重做人設用 `/router setup persona`. `/router bot rotate` 只接受同一隻 bot 的新 token (bot 資訊還沒取得時用舊 token 的 id 比對).

## bot 設定提醒

- `/router bot add` 與 `rotate` 等 getMe 完成才回覆, 之後馬上 `/router bot list` 就看得到新 bot. 某隻 bot 的資訊還沒取得時 (例如 router 剛啟動連不上 Telegram), `bot list` 與 `status` 顯示「讀取中」, getMe 照輪詢的重試規則 (見下方「輪詢與重試」) 重試到成功.
- 新增 bot (`/router bot add`), 新 bot 初次設定 (審核群組說明那則), `/router setup group` (設定成功或不符條件都附), 以及 bot 被加入群組時 (通知送到重要通知話題或 owner 私訊), router 會附上這隻 bot 的設定提醒.
- 群組隱私模式: 說明開啟與關閉的差別, 依 getMe 的 `can_read_all_group_messages` 顯示目前設定 (true 是關閉, 符合建議; 其他是開啟, 建議關閉), 關閉方式 (@BotFather `/setprivacy`). 重點一定寫出: 改完要把 bot 從群組移除再重新加入才生效; bot 是群組管理員就不受限制 (以管理員身分加入群組時不附這段).
- Bot-to-Bot Communication Mode (@BotFather 的設定): Bot API 的 getMe 沒有對應欄位, 查不到開了沒, 只附固定說明: 開與關的差別, 設定方式 (@BotFather `/setbot2bot` 或 BotFather Mini App), 以及風險 (router 不分辨發話者是人還是 bot, 其他 bot 的訊息與 /secret 這類指令會照常處理; 可能互相回覆停不下來).
- 兩段文字由柯姊定稿, 依她 review 草稿的標記加粗 (兩段的標題, 「開啟 (預設):」「關閉:」等清單開頭, 「關閉方式:」「設定方式:」「開啟的風險:」, 「兩件很重要的事:」與兩點的重點句; emoji, 目前設定那行與最後的建議段落不加粗), 以 parse_mode HTML 送出. 同一則訊息裡的其他文字, 以及帶入的群組名稱, bot 名稱一律做 HTML 跳脫, 名稱裡有 < > & 也送得出去; 萬一 Telegram 仍拒收 HTML (can't parse entities), 同一則改用純文字 (去掉標籤) 重送一次並記 log; 在終端機 CLI 下的指令印成純文字.

## router 重啟

- **啟動與關機公告** (`router/health.ts` 的 startNotice, stopNotice): 每次啟動, 第一隻 bot 取得 getMe 後, 跟其他啟動檢查一樣發到每隻 bot 的「🔔 重要通知」(沒有審核群組時 owner 私訊), 同一個地方只發一次. 啟動公告一定有 `🟢 cc-telegram-router <版本> 啟動`; 有開[健康檢查端點](#健康檢查端點)時加一行 `health point (http://<listen 位址>/healthz) 啟動`, 位址對外開放時加 `⚠️ health point 對外開放, 請注意防範`, 在私有網段時加一行提醒, 未設 token 時加 `⚠️ health point 未設 token, ...`; 設了但沒聽起來 (例如 port 被佔用) 時寫沒有啟動. 關機或重啟時, 停下 bot 之前先發 `🔴 cc-telegram-router <版本> 重啟 (來源: ...)` 或 `... 關機 (來源: ...)`: 來源是 `cli` (`cc-telegram-router cli restart`), `telegram: <顯示名稱或 @username>` (Telegram 裡的 `/restart`), 在 systemd 下收到 SIGTERM 時, router 用 `systemctl --user list-jobs --no-legend` 查自己 unit (`cc-telegram-router.service`) 的 job 類型 (最多等 2 秒): `restart` (`systemctl --user restart`) 寫 `重啟 (來源: systemd)`, `stop` (`systemctl --user stop`) 寫 `關機 (來源: systemd)`, 查不到 (指令失敗或逾時) 寫 `關機 (來源: systemd (SIGTERM))`; 不在 systemd 下收到訊號寫 `訊號 SIGTERM` (或 SIGINT). 寫「重啟」時, 之後新的 router 再發一則啟動公告. 關機公告最多等 5 秒, 送不出去也照常停止 (log 寫 `stop notice: not confirmed within 5s`).

router 重啟 (`systemctl restart`, `/router restart`, 部署) 時 worker 不跟著重啟, 但有一段空窗. 2026-10-17 實測 (3 個 worker 在線): 收到 SIGTERM 後約 0.69 秒 worker 斷線, 0.85 秒新 router 起來, 1.19 秒所有 worker 的 plugin 都重新連上.

- **router 程序連不上** (約 0 到 0.85 秒): worker 的 PreToolUse 與 SubagentStart hook 照時間表重試 (第 0, 3, 8, 15, 30, 45 秒), 一般重啟在第 3 秒那次就拿到 router 的正常判斷, 那個工具呼叫因此慢約 3 秒. 其他進度事件只送一次, 空窗裡的那幾則進度會漏掉. 45 秒內都連不上 (router 起不來) 才落回「放行, 但不准跳出 sandbox」, 而且每個工具呼叫都要等滿 45 秒; 從第一次連不到起超過 3 分鐘仍沒有任何一次連上時改成每個請求只試一次就落回 (斷路), router 回來後第一次連上就恢復. 斷路的狀態檔在 `$XDG_RUNTIME_DIR/cc-telegram-router/` (沒有時 `~/.cache/cc-telegram-router/`), 刪掉就回到正常的重試.
- **plugin 還沒重新連上** (約 0.85 到 1.19 秒): SendMessage 給這個對話自己的 subagent 會等 plugin 打招呼, 連上就立刻判斷放行, 不會被當成跨 session 擋下.
- 細節與 log 格式見 [權限, 提權與審核](permissions.md#router-連不到時). SubagentStart 的 hook 逾時是 60 秒 (原本 5 秒) 才容得下重試, 改的是 worker 的 settings, 已在跑的 worker 要輪替 (`/router session rotate`) 後才生效; hook 執行檔 (`<stateDir>/hooks/cc-hook`) 重新編譯後下一次呼叫就生效.

## 背景 session 的 job 與 daemon

每個 worker 是 `claude --bg` 開的背景 session, 由 Claude Code 的 daemon (`claude daemon run`) 管理. daemon 把每個 session 記成一個 job: `~/.claude/jobs/<短 id>/state.json` (有 `CLAUDE_CONFIG_DIR` 時在它底下), 其中 `respawnFlags` 是 job 啟動時的旗標, 也就是 router 給的整組參數 (`--allow-dangerously-skip-permissions`, `--name tg-<對話>`, `--setting-sources`, `--settings <stateDir>/sessions/<對話>.json`, `--channels`, `--model`; daemon 依自己的順序存). 不帶旗標的 `claude --bg --resume <session>` 會沿用這組舊旗標, 所以 router 的處理是 (`router/jobs.ts`, `router/supervisor.ts`):

- **叫醒時比對旗標**: 對話還有 job 時, 拿 job 的 `respawnFlags` 跟這次要給的旗標比 (不看順序). 讀不到 state.json 時, 改用 router 上次啟動時記在 router.db `conversations.worker_flags` 的旗標. 不同就先 `claude stop` (還在跑時) 再 `claude rm` 那個 job, 然後帶新旗標 `--resume` 同一個 session, log 寫一行哪些旗標變了 (例如 `--model claude-old → claude-new`). 兩邊都讀不到時照舊不帶旗標 resume; `claude rm` 失敗時也照舊 resume, 沿用存下的旗標並寫 log. 所以改 config 的 `model`, plugin 的 channel 名稱, stateDir 位置等等, 都會在下一次叫醒時生效, 不用另外處理.
- **`/router config set model`**: 用預設模型 (沒有自己 `/router chat model`) 而且已有 session 的對話標記待輪替, 閒置時停掉, 下一則訊息叫醒時套用新模型. 對話自己的 `/router chat model` 照舊立刻重啟並換掉 job.
- **清理多餘的 job**: router 啟動後 5 秒, 之後每 10 分鐘, 比對 `claude agents --json --all` 與 jobs 資料夾. 名稱是 `tg-<對話>`, 工作目錄是 router 那個對話的資料夾, 但不是這個對話目前 session 的 job (反覆重啟留下的舊 job, 帶旗標 resume 開出的副本, blocked 的舊 job), 還在跑就先 `claude stop`, 再 `claude rm`, log 各寫一行. 其他 job (別的 session, 名稱或資料夾對不上的) 一律不碰; 還沒有 session 的對話 (第一次叫醒可能正在進行) 也不碰.
- **daemon 由誰帶起** (GitHub #98872): worker 的環境變數來自 daemon 程序. 依 Claude Code 2.1.302 的程式, 背景 session 認領暖機 spare 時, 會把 `claude --bg` 呼叫端 (router) 的環境變數疊上去, 但 daemon 有而 router 沒給的變數 (例如 router 刻意拿掉的 `TELEGRAM_*`) 會留在 worker 裡 (讀程式得知, 沒有用真的 daemon 實測). router 每次清理時唯讀檢查 daemon 程序的 `--spawned-by` (`/proc/<pid>/cmdline`, 不讀環境變數, 只看 router 所用 claude 安裝的程序): 不是由 router 的 home 或 stateDir 底下帶起的, 就通知 owner 一次 (每隻 bot 的重要通知位置). router 不自動重啟 daemon, 因為會影響這台機器上的其他 session; 沒有其他 session 在用時, 可以在終端機執行 `claude daemon stop --any --keep-workers`, 下一次叫醒 worker 時就由 router 帶起新的 daemon (新 daemon 會接手還在跑的 worker, 這點是讀程式推論). 評估過由 router 先執行 `claude daemon run` 帶起 daemon, 不採用: daemon 沒有 client 時約 5 秒就自行結束, 而且已有 daemon 時會拒絕.
- **暖機 spare 程序**: 每個 daemon 固定預先開 1 個 spare (`claude bg-pty-host ... /spare/<id>.pty.sock` 與它底下的 `bg-spare`), 被認領就補 1 個, daemon 閒置退出時一起結束; daemon 啟動時會回收同一個執行期資料夾 (`/tmp/cc-daemon-<uid>/<hash>/spare`) 裡沒人用的 spare (daemon.log 的 `bg orphan-spare reap`). 這是 Claude Code 的行為, router 重啟 (`KillMode=process`) 不會結束 daemon 或 spare. 會越積越多的情況 (推論): daemon 被強制結束而不是閒置退出, 或從不同環境 (例如 `TMPDIR`, 設定資料夾) 帶起的 daemon 用了不同的執行期資料夾, 彼此不回收. router 每次清理時找出父程序不是任何 daemon 的 spare, 通知 owner 一次 (附 pid); 不自動結束它們, 確認後可以手動 `kill <pid>`.

## 輪詢與重試

- 輪詢由 router 自己做 (`poller.ts`, 不用 grammY 的 bot.start), 啟動 (getMe) 與之後收訊都套用同一套規則: 網路錯誤與 Telegram 5xx 以 5 秒, 10 秒, 30 秒, 1 分, 2 分, 5 分逐步拉長, 之後每 5 分鐘一直重試 (429 照 retry_after); 斷線超過 2 分鐘才通知 owner 一次, 恢復時再通知一次. 409 衝突 (別的程式在用這個 token 收訊息) 每 60 秒重試並立刻通知. 401 (token 失效) 不再重試, 立刻通知 owner 用 `/router bot rotate`. 通知經其他還正常的 bot 送到它的重要通知話題或 owner 私訊; 409 與恢復通知也可以由那隻 bot 自己送 (409 只停收訊, 送訊息仍正常, 所以只有一隻 bot 時也收得到); 沒有 bot 送得出去, 或沒有 owner 與審核群組時只記 log. `/router status` 每隻 bot 後面標狀態: 收訊中, 重試中 (從幾點開始, 原因), token 失效.
- `/router` 指令的回覆遇到網路錯誤, Telegram 5xx 或 429 (照 retry_after) 時, 第一次送出後 1 分鐘內最多再試 3 次 (間隔 2 秒, 5 秒, 15 秒; `sendretry.ts`), 其他 4xx 不重試, 最後還是失敗就在 router log 記一行.

## 健康檢查端點

給 Gatus 這類外部監控工具的 HTTP 端點 (`router/health.ts`), 選配, config.json 沒有 `health` 就不開. 改了要重啟 router 才生效.

```json
"health": { "listen": "127.0.0.1:8787", "token": "<自己產生的一串亂數>", "staleAfterS": 90 }
```

- `listen`: `<位址>:<port>`, 例如 `127.0.0.1:<port>`, `[::1]:<port>` 或 `localhost:<port>` (IPv6 位址加方括號), port 1 到 65535. 建議只聽本機位址, 寫 `127.0.0.1`: `localhost` 可能只聽在 `::1`, 用 127.0.0.1 連的監控就連不到. 不是本機位址也照開, 但依位址分三級警告 (log 一行 `health: ⚠️ ...`, 並寫進啟動公告):
  - 本機 (loopback): 127.0.0.0/8, `::1`, `localhost`. 只有這台機器連得到, 不警告.
  - 私有網段: 10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT), 169.254/16 (link-local), IPv6 的 fc00::/7 與 fe80::/10. 警告同一個網段的其他機器連得到.
  - 對外開放 (public): 其他位址, 包含 `0.0.0.0` 與 `::` (所有網卡) 以及主機名稱 (不查 DNS, 一律當對外). 警告「health point 對外開放, 請注意防範」.
  
  `listen` 格式錯 (沒有 port, 不是 IP 位址或主機名稱) 時不開端點, log 一行 `config.json: health ...`; port 被佔用時 log 一行 `health: cannot listen on ...` 不開端點 (啟動公告寫沒有啟動). 兩種情況 router 都照常運作.
- `token` (選填): 有設時要帶 `Authorization: Bearer <token>`, 沒帶或不對回 401, 比對是 constant-time. token 不會出現在 log, 錯誤訊息, 公告或 `/router config show` (只顯示「要 token, 已設定」). 沒設時 log, `/router config show` 與啟動公告都提示「未設 token」.
- `staleAfterS` (選填): 一隻 bot 最近一次 getUpdates 成功超過幾秒就算異常; 沒寫是 **90**, 寫錯 (不是 1 以上的數字) 用 90 並 log 一行. 90 是 router long polling timeout (30 秒) 的三倍: 閒置的 bot 每 30 秒至少成功一次, 一次失敗加上前幾次重試 (5 秒, 10 秒, 30 秒, 見「輪詢與重試」) 也還在門檻內. 設得比 30 小, 沒有訊息時也會誤報 503.

`GET /healthz` (也接受 `HEAD`, 只回狀態碼與標頭) 回 JSON. 其他路徑回 404, 其他方法回 405.

- **200**: 每隻 bot 最近一次 getUpdates 成功都在 `staleAfterS` 內. 還沒成功過的 bot (剛啟動) 從它開始輪詢起算.
- **503**: 任一隻 bot 超過門檻, 例如 Telegram 連不上, token 失效 (401), 或請求卡住沒有回應 (這時 `state` 仍是 `ok`, 但 `lastOkAgoS` 一直變大).

```json
{
  "status": "ok",
  "version": "2.30.0",
  "now": "2026-10-18T15:15:53.616+08:00",
  "startedAt": "2026-10-18T15:15:52.922+08:00",
  "uptimeS": 1,
  "staleAfterS": 90,
  "bots": {
    "cc": { "ok": true, "state": "ok", "lastOkAt": "2026-10-18T15:15:53.598+08:00", "lastOkAgoS": 0 }
  },
  "workers": { "total": 1, "standby": 0, "asleep": 1, "backoff": 1, "pluginDisconnected": 0 },
  "lastWakeFailure": { "at": "2026-10-18T15:15:53.518+08:00", "agoS": 0, "bot": "cc", "failures": 1, "cause": "claude --bg 失敗: Error: cannot start the session in <隱藏>" }
}
```

- `status`: `ok` (200) 或 `down` (503). 時間一律 GMT+8 ISO 字串.
- `bots`: 以 config.json 的 bot 名稱為鍵. `ok` 是否在門檻內; `state` 是輪詢狀態 (`starting`, `ok`, `retrying`, `unauthorized`, `stopped`); `lastOkAt` 與 `lastOkAgoS` 是最近一次成功的時間與距今秒數, 還沒成功過時是 `null`, 另有 `waitingS` (從開始輪詢起算).
- `workers`: 對話數, 定義同 `/router status`: `standby` 是 plugin 連著的 (🛜待命中), `asleep` 是沒連著的 (💤已休眠), 兩者相加是 `total`; `asleep` 裡面, `backoff` 是連續叫不醒, 下次叫醒還在等待間隔的 (見「cli doctor 與 worker 狀態」), `pluginDisconnected` 是 daemon 有在跑但 plugin 沒連上的 (由 `claude agents` 得知, 最多每 30 秒問一次, 問不到時是 `null`).
- `lastWakeFailure`: 最近一次叫不醒 (任何對話) 的時間, bot 名稱, 連續失敗次數與原因 (2.27.0 的診斷), 沒有時是 `null`. 只存在記憶體, 重啟後清空.
- 不含任何隱私: 沒有 token, chat 名稱, chat_id, 使用者 id 或 username, 對話 key (含 chat id) 與訊息內容. 叫不醒的原因裡, 那個對話的資料夾, key, chat id, 標題與 bot 的 username 換成 `<隱藏>`, 6 位數以上的數字換成 `<id>`, token 換成 `<token>`. 要知道是哪個對話, 看 router 的 log 或 `/router status`.

Gatus 設定範例 (`config.yaml`; token 用環境變數帶入, 不寫死在檔案裡):

```yaml
endpoints:
  - name: cc-telegram-router
    url: "http://127.0.0.1:8787/healthz"
    interval: 60s
    headers:
      Authorization: "Bearer ${CCTR_HEALTH_TOKEN}"
    conditions:
      - "[STATUS] == 200"
      - "[BODY].status == ok"
      - "[BODY].bots.cc.ok == true"
```

Gatus 跑在 docker 裡時, 容器的 127.0.0.1 是容器自己, 連不到 router; 端點又只聽本機位址, 所以要用 host network (Linux 的 Docker Engine), 讓容器跟主機共用網路:

```yaml
services:
  gatus:
    image: twinproduction/gatus:latest
    network_mode: host
    environment:
      CCTR_HEALTH_TOKEN: ${CCTR_HEALTH_TOKEN}
    volumes:
      - ./config:/config
```

測試: `router/test/health.test.ts` (模組), `router/test/e2e-health.test.ts` (真的 router + 假 Bot API).

## 工具呼叫紀錄

`router.db` 的 `tool_history` (記什麼見 [權限](permissions.md#工具呼叫紀錄)) 保留 30 天, router 啟動時與之後每天清掉更舊的. 同時清的還有 `own_agents` (每個對話自己的 subagent 名單, 見 [權限](permissions.md#高風險工具)): 30 天前加入的與已不存在的對話的項目. 報表只限 owner 與 admin: Telegram 用 `/router tools [天數]` (群組裡下會改私訊回覆), 終端機用 `cc-telegram-router cli tools [天數]`, 天數 1~30, 預設 7. 依工具計次, 用得最多的在前, 分列各對話角色的次數, 已提權的次數, 被 router 擋下的次數與 router 端 Telegram 工具的錯誤次數 (原因見提權紀錄). 範例 (測試資料):

```
工具呼叫統計: 近 7 天 (2026-10-10 12:00 起, GMT+8)
Bash 56 次: owner 40, power 12, user 4; 提權 1, 被擋 3
mcp__plugin_telegram_telegram__reply 25 次: owner 9, user 16; 錯誤 1
Read 21 次: user 20, guest 1; 被擋 1
SendMessage 2 次: user 2; 被擋 2
ListAgents 1 次: power 1; 被擋 1
合計 105 次: owner 49, power 13, user 42, guest 1; 提權 1, 被擋 7, 錯誤 1
角色是對話角色; 提權: 已提權的 subagent 以較高角色執行; 被擋: router 擋下 (原因見提權紀錄); 錯誤: router 端執行的 Telegram 工具被拒或 API 失敗
```

## /router help 主題

`/router help` 列出所有指令 (cred 那行寫出 bot token 與 `--http` API key 兩種登記方式, 以及 rotate 與 header); `/router help <主題>` 給一個主題的完整用法與範例:

| 主題 | 內容 |
|---|---|
| `cred` | 全域憑證: 在哪裡打 (owner 或 admin 自己的私訊, 含 key 的訊息 60 秒後刪除, 自己, owner, admin 能按「取消刪除」, 群組裡被拒並立刻刪除, key 不進 worker), http 憑證的 `--http`, `--header`, `--scheme`, `--query`, `--default-header` 與路徑 (沒寫就是全部), worker 自帶標頭的規則, Anthropic, OpenAI, Google 與 Telegram bot token 範例, 換 key 的 `rotate`, 預設標頭的 `header` (列出, set, rm), 同名 add 的覆蓋 / 取消, 管理指令, 終端機 `cred-import` |
| `secret` | `/secret` (對話密鑰) 與 `/router cred` (全域憑證) 的差別與各自適用情境, 在哪裡打 (私訊 60 秒後刪除可取消, 群組 10 秒後刪除不能取消, 被拒的立刻刪), 指令與範例 (含 `--default-header` 與 `/secret header`), 密鑰偵測只認訊息開頭的登記指令 |
| `perm` | `/router perm` 對話覆寫與 `/router perm user` 使用者覆寫的子操作與範例 |
| `bot` | `/router bot` 的子操作 (含 token 的訊息 60 秒後刪除, 可取消), 與 `/router cred add` 的分別 |

不認得的主題回覆主題清單加上指令總覽. `/secret help` 也指向 `/router help secret`. 細節見 [憑證與技能](credentials-and-skills.md#http-憑證的-key-放哪裡) 與 [密鑰](secrets.md).

## /router perm user

`/router perm user <uid|@username> <子操作>` 把權限覆寫掛在人身上 (使用者覆寫, 存 `router.db` 的 `user_overrides`), 子操作沿用對話覆寫的語法:

| 子操作 | 說明 |
|---|---|
| `show` (或不寫) | 這個人的角色, 使用者覆寫與生效範圍 (回覆走私訊) |
| `tool allow\|deny\|rm <規則>` | 例如 `tool allow ListAgents` (只寫工具名稱的 allow 規則讓 power 以下也能用這個高風險工具) |
| `path read\|write\|rm <絕對路徑>` | 讀或讀寫某個資料夾 |
| `net allow\|rm <網域>` | sandbox 可連的網域 |
| `mcp allow\|rm <名稱>` | 某個 MCP server 的所有工具 |
| `reset` | 清掉這個人的所有使用者覆寫 |

owner 與 admin 可以下; admin 不能異動 owner (查看可以). `send` 與 `pkg` 是 router 依對話把關的, 只能掛在對話上 (`/router perm [chat_id] send|pkg ...`), 對使用者下會回覆說明. 改了之後他每隻 bot 的私訊 settings 立刻重寫, worker 標記待輪替 (閒置時停掉, 下一則訊息套用), 回覆列出受影響的私訊; `/router perm <私訊> show` 另列一行「使用者覆寫」.

生效範圍 (細節見 [docs/permissions.md](permissions.md#使用者覆寫)): 他發起的一輪在任何對話做[自動提權](permissions.md#自動提權)的重算時疊上去 (這一輪所有發話者都要有權限); 他自己的私訊 settings 也套用. 群組裡只影響 router 在 hook 的判斷, 路徑與網域覆寫不會改變群組 worker 的 sandbox.

## 終端機 CLI

`cc-telegram-router [--config <config.json>] cli <子指令...>` 把 `/router <子指令...>` 經 router socket 交給正在執行的 router, 以 owner 身分執行並印出回覆 (socket 只有 worker 沙箱外的 owner 終端機連得到). 子指令跟 Telegram 的 `/router` 一樣 (例如 `cli status`, `cli tools 7`, `cli botapi ...`), `cli restart` 等同 `/restart`; 另有只在終端機能用的: `cli event raw <id>` (見[密鑰保護](secrets.md)), `cli skill run` 與 `cli skill refresh` (以某個對話與角色的身分跑一次特權動作, 試跑用拋棄式資料庫與本機假 Bot API, 立刻跑一次技能的憑證更新; 給驗收用, 見[技能與憑證](credentials-and-skills.md#終端機執行特權動作)). 例:

```bash
cc-telegram-router cli skill run router-group-100 tg-sticker list --role user --out /tmp/acc/list
cc-telegram-router cli skill run router-group-100 tg-sticker publish --trial-store /tmp/acc/store --api http://127.0.0.1:8081 --out /tmp/acc/pub '{"webp":"stickers/a.webp","emoji":"🐳","name":"揮手","usage":"打招呼","description":"藍鯨揮手"}'
cc-telegram-router cli skill refresh web-instagram
```

一般子指令等 router 回答最多 2 分鐘, `skill run` 與 `skill refresh` 最多 1 小時, `session send` 是 `--wait` 再加 30 秒 (見下一節).

## 從外部送訊息給 worker

主機終端機, 或同一台機器上的其他 Claude Code session (例如 v1), 要把訊息送進某個對話的 worker 時用 `cli session send`. 它經過 router, 所以 worker 輪替或閒置停掉 (它的 SendMessage 位址跟著消失) 時一樣送得到: router 會叫醒它.

```bash
cc-telegram-router cli session send <chat_id|對話key> [--bot <名稱>] [--from <發送者>] [--wait <秒>] [<文字> | -]
cc-telegram-router cli session send router-dm-123 --from v1 請整理今天的待辦
printf '第一行\n第二行\n' | cc-telegram-router cli session send -100123 --from v1 -
```

- **對話**: chat_id 或對話 key (`/router chat` 列表的第一欄), 跟其他 session 指令一樣; 同一個 chat_id 在多隻 bot 都有對話時要加 `--bot`. 找不到就報錯, 什麼都不送.
- **文字**: 寫在對話與選項後面, 之後的字全部算文字 (文字本身以 `--` 開頭時, 前面先放一個 `--`). 沒給文字或文字是 `-` 時從 stdin 讀, 換行與空白照原樣, 適合多行的長訊息; stdin 是終端機而又沒給文字時直接報錯, 不會停下來等輸入. 空的內容與超過 64000 字的拒絕.
- **`--from`**: 發送者的名稱. worker 要回覆時用 SendMessage 傳給這個名稱, 所以寫自己的 session 名稱 (1~64 字, 不能有空白, 引號與 `< >`). 沒給時是「終端機」, 表示沒有對象可以回.
- **怎麼送**: 經執行中 router 的 socket, 跟 router 自己的通知 (申請結果, 代打結果) 走同一條路: 先寫進 `router.db` 的佇列, worker 連著就立刻送; 沒連上 (睡著, 輪替或閒置停掉) 就叫醒, 它連上時送出. 訊息在佇列裡, router 重啟也不會掉: router 啟動 15 秒後與之後每分鐘, 會把有積壓的對話再叫醒一次. router 沒在跑時報錯 (`router 沒在跑 (連不到 <socket>), 訊息沒有送出`), 終端機不會自己寫資料庫.
- **worker 看到什麼**: 一個 `<host_message from="<發送者>" via="cli">` 區塊. 開頭說明這則從主機終端機送來, 不是 Telegram 上的人說的, 發送者是誰, 回應去向由 worker 自己判斷: 內容要它轉告這個對話時, 才用 reply 發到 Telegram; 要回覆發送者時, 用 SendMessage 傳給 `--from` 的名稱; 不要自動把回應貼到對話裡. router 本身不往對話貼任何東西. 這一輪跟 router 的通知一樣沒有發話者 (只看對話角色), SendMessage 傳給其他 session 是[高風險工具](permissions.md#高風險工具): admin 與 owner 的對話直接可以回; power 以下的對話, 這個 SendMessage 要經過提權 (沒有發話者, 不會自動提權, 也不會在對話裡詢問), 照一般的權限流程由 worker 向 owner 申請 (request_elevation), 核准後再回.
- **輸出**: 第一行是 `已排進佇列 (#<佇列編號>) 給 <對話>, 發送者 <名稱>: worker 醒著, 直接送出` 或 `...: worker 沒有連上, 正在叫醒`. 接著等 worker 收到 (worker 的 plugin 把訊息交給 Claude Code 後回報, 佇列標成 acked), 印 `已送達: worker 收到了 (<秒數> 秒)`. 最多等 `--wait` 秒 (預設 60, 可設 0~600, 0 是不等); 逾時只提示, 訊息仍在佇列, worker 連上時就會收到.
- **結束碼**: 0 已送達 (或 `--wait 0` 不等), 2 已排進佇列但時間內沒確認送達, 1 錯誤 (參數不對, 沒有文字, 找不到對話, router 沒在跑).
- **只在主機終端機**: Telegram 裡的 `/router session send` 一律拒絕.

## 時間

時間一律 GMT+8, 不出現 UTC 或 Z: router 的 log 每行開頭是 `2026-10-17 08:06:04.919+08:00`, 交給 worker 的訊息時間 (`<channel ts=...>`) 是 `2026-10-17T08:06:04.919+08:00`, 指令輸出, 通知, router_log 與報表顯示的時間都換算成 GMT+8 (`shared/time.ts`, `router/context.ts` 的 `gmt8`). router.db 與訊息紀錄裡存的仍是 UTC 的 ISO 時間 (比較與查詢用), 顯示時才換算.

## cc / 報表腳本

`cc /status`, `cc /usage` 與 `cc /context` 的圖由 repo 的 `scripts/` 產生, 純腳本不經 LLM, router 把輸出原樣送出:

| 檔案 | 用途 |
|---|---|
| `tg-status-report.sh <pane>` | 對 worker 的 tmux pane 送 `/status`, 擷取畫面, 只印白名單欄位 Version, Session kind, Model (Session ID, Email, Organization, Peer address, Login method 永遠不印) |
| `tg-usage-report.sh <pane>` | 送 `/usage`, 擷取畫面, 交給同目錄的 `usage_report.py` 排版 |
| `usage_report.py [--now <ISO 時間>]` | 從 stdin 讀 `/usage` 畫面, 印報表; `--now` 固定現在時間 (測試用) |
| `tg-context-chart.py <out.png>` | 從 stdin 讀 JSON, 畫 `/context` 的 donut chart. 沒有 matplotlib (沒裝或 import 失敗) 時不寫 PNG, 改在 stdout 印文字圖加一行安裝建議, exit code 3. 文字圖每個類別一行 (20 格, 每格 5%) 與百分比, 每一行的實心段從上一行結尾的位置開始, 全部接起來剛好到 100%; 格子內的部分用最接近的方塊字元 (▏ 到 █, ▐, ▕) 表示, 有用量的類別至少佔八分之一格 |

腳本一律用 python3 執行 (`.py` 的 shebang 是 `#!/usr/bin/env python3`, `.sh` 裡呼叫 `python3`), 需要 3.7 以上, 不相容 python2. 兩支 `.sh` 讀完畫面後按 Esc 離開 `/status` 與 `/usage` 的畫面 (比對整個畫面, 第一次 Esc 沒有變化才再按一次).

`cc /context` 有圖時送圖片, 表格當說明文字; 腳本 exit 3 時送表格加上腳本印的文字圖與安裝建議 (`python3 -m pip install --user matplotlib` 或 `sudo apt-get install python3-matplotlib`); 其他失敗只送表格.

安裝: `deploy/install.sh router` 把 `scripts/` 整個複製到 `<stateDir>/scripts`. 編譯後的 router 用 `<stateDir>/scripts`, 從原始碼執行時用 repo 的 `scripts/`. 腳本在每次代打時才執行, 只改腳本時重跑 `deploy/install.sh router` 即可, 不用重啟 router.

`cc /usage` 的輸出 (以測試資料為例):

```
📊 Token Usage (claude code cli @ 04:45)

Session ▍░░░░░░░░░  4% used 🟢 ↻8h15m
Weekly  ▋░░░░░░░░░  6% used 🟢 ↻5d23h
Fable   ░░░░░░░░░░  0% used 🟢 ↻5d23h

--- 燃燒速率 ---
完美速率: 14.2%/天
當前速率: 5.8%/天 (40% ratio)
剩下 94.0% / 5d23h
最高可用 15.7%/天燒完
可以超速 110%喔! 🏎️
```

- 標題的時間是現在 (GMT+8). 每列是 10 格進度條 (以八分之一方塊湊出小數), 已用百分比, 顏色 (未滿 70% 🟢, 70% 到未滿 90% 🟡, 90% 以上 🔴), `↻` 後面是距離重置的倒數. `/usage` 畫面上的重置時間是 UTC, 報表只顯示倒數; 日期跨年 (12 月看到 1 月的日期) 算下一年.
- 倒數 (列上的 `↻` 與燃燒速率的剩下) 一律只顯示最大的兩個單位, 最小到分鐘: `5d23h`, `8h5m`, 不到一小時只寫 `5m`.
- 燃燒速率只算 Weekly (all models) 那一列, 週期 7 天:
  - 完美速率 = 100% / 7 天.
  - 已過時間 = 7 天 − 距離重置的時間. 不到 1 小時時當前速率顯示「這週剛開始, 速率還看不準喔 ⏳」.
  - 當前速率 = 已用% / 已過天數; ratio = 當前速率 / 完美速率.
  - 剩下 = 100% − 已用%, 後面是距離重置的倒數.
  - 最高可用 = 剩下% / 剩餘天數, 也就是到重置時剛好用完的每日用量.
  - 最高可用不低於完美速率時顯示「可以超速 N%喔! 🏎️」, N = 最高可用 / 完美速率. 低於時 (等同當前速率已超過完美速率) 改顯示「超速了喔! 每天最多 X% 才撐得到重置 🐢」, X 就是最高可用.
  - 已用 100% 時顯示「這週額度用完了喔, ↻(倒數) 後重置 🛑」, 不顯示最高可用.
  - 數字一律無條件捨去: 速率與剩下取一位小數 (100/7 顯示 14.2), ratio 與超速百分比取整數.
  - 畫面上沒有 Weekly (all models) 那列, 或讀不到它的重置時間時, 不顯示燃燒速率.

對應測試: `router/test/usage-report.test.ts` (`/usage`, `/status`), `router/test/context-chart.test.ts` (圖與文字圖), `router/test/phase2.test.ts` 的 relay /context.
