# cc-telegram-router

Telegram 對話分流: 一隻 router 接 bot 的所有訊息, 每個 Telegram 對話交給一個獨立的 Claude Code 背景 session (`claude --bg`), 各自住在 `/x/cc/bot<id>/<對話>/` 自己的資料夾, 權限依角色分開設定.

## 結構

| 目錄 | 內容 |
|---|---|
| `router/` | router 本體. `main.ts` 組裝; `config.ts` `lock.ts` `db.ts` `conversations.ts` `settings.ts` `supervisor.ts` `ipc.ts` `guard.ts` `commands.ts` `context.ts` `progress.ts` `relay.ts` `rotate.ts` |
| `router/` (權限) | `permcheck.ts` 依角色檢查工具呼叫; `elevation.ts` 擋下, 提權詢問, 提權紀錄; `grants.ts` 跨對話傳訊申請; `pkgreview.ts` `packages.ts` 套件安裝審核; `approvals.ts` 審核群組與通知, 三選一按鈕; `authz.ts` 已核准授權的撤銷與使用紀錄; `credentials.ts` 跨 bot 技能的憑證; `skills.ts` 技能安裝範圍; `setup.ts` 新 bot 初次設定 |
| `router/telegram/` | 收發 Telegram 的模組 (沿用 v1 plugin): `transport.ts` `inbound.ts` `policy.ts` `outbound.ts` `store.ts` `format.ts` `rich.ts` |
| `plugin/` | worker 載入的 Telegram plugin v2 (消費者模式): 不持有 token, 透過 unix socket 跟 router 收發. `skills/doc` (/telegram:doc 使用說明), `skills/format` (/telegram:format 排版規則), `skills/bot-skill` (/telegram:bot-skill 建立技能與憑證的 SOP) |
| `hooks/` | worker 的 hook (`cc-hook`): 進度事件, 權限檢查與提權, 壓縮後補回 chat_context |
| `shared/` | router 與 plugin 共用的協定 (`protocol.ts`) 與工具定義 (`tools.ts`) |
| `templates/` | 各對話 settings 的範本 (`base-settings.json`, `roles/<角色>.json`), 共用 CLAUDE.md 範例 (`CLAUDE.md.example`) |
| `deploy/` | `install.sh` 與 systemd user unit |
| `docs/v1/` | v1 (單一 session plugin) 時期的文件, 僅供參考 |

## 運作方式

1. router 輪詢 bot (getUpdates), 每個 update 原樣寫進 `router.db` 的 `events`.
2. 沿用 v1 的 gate (配對, 允許清單, 群組 mention) 決定要不要送進 Claude. 要送的訊息依 (bot, chat_id) 對應到對話, 第一次出現時建立資料夾與 settings.
3. 訊息進該對話的佇列. worker 不在線就喚醒: 第一次用 `claude --bg` 帶一句 init prompt 開新 session, 之後用 `--resume`.
4. worker 的 plugin 讀 `CLAUDE_PROJECT_DIR` 知道自己是哪個對話, 連 `router.sock` 報到, 收到佇列裡的訊息後轉成 channel 通知並回 ack.
5. 模型呼叫 reply 等工具時, plugin 把呼叫轉給 router; router 檢查目標與附件路徑後代為呼叫 Bot API, 每個呼叫寫進 `outbound`.
6. 每個工具呼叫在 PreToolUse 由 hook 問 router, router 依對話角色的 settings 檢查 (`permcheck.ts`). 越權就擋下並告訴模型改用不越權的方法; 發話者角色高於對話時, 直接在對話裡貼出「提權執行 / 拒絕」詢問 (120 秒未回應視為拒絕). 按下的人角色夠高才算數, 之後的第一個 subagent 以他的角色執行.
7. power 對話的套件安裝 (pip, npm, bun...) 由 router 查 registry 資料後交給模型判斷風險, low 直接放行, 其餘送 owner 審核.

### 目錄

```
/x/cc/CLAUDE.md                 共用規則 (FORCED / GENERAL / Default suggestions 三層)
/x/cc/bot<id>/CLAUDE.md         該 bot 的人設 (初次設定訪談產生)
/x/cc/bot<id>/<type>-<chat>/    一個對話: CLAUDE.md, memory/, attachments/, .chat/
/x/cc/.router/                  router 執行檔, config.json, access.json, router.db, sessions/ (各對話 settings)
```

Claude Code 從工作目錄往上讀 CLAUDE.md, 三層自然疊加. bot 資料夾以 Telegram bot id 命名, 換 token 不會變. 舊版放在 `/x/cc/<對話>/` 的資料夾, router 啟動時會先停掉該 worker, 連同 `~/.claude/projects` 的對話紀錄搬進 bot 資料夾.

### 審核按鈕, 撤銷, 執行授權

- 申請 (跨對話傳訊, 套件安裝, 提權) 都是「允許一次 / 永久允許 / 拒絕」, 申請訊息寫明永久允許的範圍: 跨對話是 `send *` (可送往 bot 所在的任何對話), 套件是 `pkg *` (PyPI 與 npm 不用審核, URL 與自訂來源仍審核), 提權是把被擋的那類動作寫成權限覆寫 (`Bash(python3 *)`, 讀寫某個資料夾, 某個工具或 MCP); 跳出 sandbox 不能永久允許.
- 申請有了結果後, worker 處理結果的那一輪, 進度回覆當初提出申請的那則訊息; 在其他地方按下按鈕時, 那裡也同步一份進度 (開頭標明對話).
- 允許過的申請在審核群組留「🚫 撤銷」按鈕. 每一次動用已核准的權限都記在 `auth_uses` 與「🧾 執行授權」話題, 附工具呼叫內容與撤銷按鈕. 撤銷會移除權限覆寫, 丟掉尚未使用的提權, 輪替 worker 並通知它.

### 技能與憑證

- 技能範圍: `/x/cc/.claude/skills` (全部 bot), `/x/cc/bot<id>/.claude/skills` (一隻 bot), 對話資料夾的 `.claude/skills` (單一對話). owner 與 admin 的對話用 `install_skill` 安裝到前兩個範圍, router 會拒絕含 token 的技能.
- 跨 bot 技能需要的 token 存在 `config.json` 的 `credentials` (token, 允許的方法, 允許的角色), 由 owner 或 admin 在私訊用 `/router cred add` 登記 (訊息會被刪), 或在終端機用 `cc-telegram-router cred-import <名稱> <檔案> <變數> [方法,...]` 從檔案搬進來. worker 用 `bot_api` 工具使用, 看不到 token; owner 在終端機可用 `cc-telegram-router cli botapi`.
- 一般 API key (例如 OpenAI) 也存成憑證, 種類 http: `cred-import <名稱> <檔案> <變數> <路徑,...> --http <網址>`, worker 用 `http_api`, 回應裡的 base64 可直接存成對話資料夾裡的檔案.
- 放在 bot 或全部 bot 範圍的技能, sandbox 裡的角色可以讀與執行, 不能改.
- owner 與 admin 的對話用 `bot_api` 的 credential `self` 以這隻 bot 自己的身分呼叫任何 Bot API (getUpdates, setWebhook, deleteWebhook, logOut, close 除外).
- worker 端的 SOP 在 `/telegram:bot-skill`.

### 審核群組與新 bot 初次設定

- config 沒有 owners 時, router log 會印出一次性認領碼; 私訊 bot `/start <碼>` 的人成為 owner.
- owner 第一次私訊一隻還沒設定的 bot, worker 會先訪談名字, 個性, 說話風格, 用途, 用 `save_bot_profile` 寫進 `bot<id>/CLAUDE.md`.
- 接著引導設定審核群組: 開了話題的 supergroup, bot 是管理員且能管理話題, 在群組裡下 `/router setup group`. router 建立「🔔 重要通知」「🔐 權限審核」「📜 提權紀錄」「🧾 執行授權」四個話題 (已設定的群組再下一次會補上缺的話題). 可以略過, 之後通知與申請都私訊 owner (提權紀錄只留在 router.db).

## 部署

```bash
deploy/install.sh router   # 編譯到 /x/cc/.router/cc-telegram-router, 複製 templates
deploy/install.sh plugin   # 打包 plugin v2 到官方 plugin 快取路徑 (第一次會備份原內容)
deploy/install.sh unit     # 安裝 systemd user unit
systemctl --user enable --now cc-telegram-router
```

共用的 `/x/cc/CLAUDE.md` 可以從範例開始: `cp templates/CLAUDE.md.example /x/cc/CLAUDE.md`. worker 端的使用說明在 plugin 的 `/telegram:doc` skill (`plugin/skills/doc/SKILL.md`).

`/x/cc/.router/config.json` (權限 600) 與 `access.json` 要手動建立一次:

```json
{
  "bots": [{ "name": "cc", "token": "<bot token>" }],
  "home": "/x/cc",
  "stateDir": "/x/cc/.router",
  "owners": [],
  "model": "claude-opus-5-5",
  "autoCompactWindow": 750000,
  "claudeBin": "/home/<user>/.local/bin/claude"
}
```

`owners` 可以留空, 用 log 裡的認領碼認領 (見上方). 套件審核用的模型就是 `model`.

## 測試

```bash
bun test router/test
```

| 檔案 | 對應 |
|---|---|
| `router/test/phase1.test.ts` | 規劃 03, 04, 05, 07 的模組行為: 對話資料夾, settings 範本, 佇列, 送出檢查, 單一實例, IPC, supervisor, plugin MCP, router 離線告知 |
| `router/test/phase2.test.ts` | 規劃 03 的 /router 指令表與拒絕訊息, 06 chat_context, router_log, hook, 「cc /」代打, 即時進度訊息 |
| `router/test/e2e.test.ts` | 真的 router + 假 Bot API: 每個 update 與送出的 payload 都在 db, 回覆送出與紀錄, /router 指令不轉給 worker, CLI |
| `router/test/phase3.test.ts` | 規劃 03, 07: 角色範本, /router perm, 權限檢查, 跨對話傳訊申請, 審核頻道, 提權 (詢問, 核准, 逾時, 主動申請, 紀錄), hook, bot 資料夾與搬遷 |
| `router/test/phase3-cred.test.ts` | 憑證的角色與方法限制, Bot API 呼叫 (含上傳), install_skill 的檢查, /router cred 與 botapi |
| `router/test/phase3-pkg.test.ts` | 規劃 07 套件安裝審核: 指令解析, manifest, 審核快取, 送審與核准, 慢審核, 審核模型的呼叫方式, hook |
| `router/test/e2e-setup.test.ts` | 真的 router + 假 Bot API, 從沒有 owner 開始: 認領碼, 人設訪談與 bot CLAUDE.md, 審核群組的檢查與話題, 略過 |
| `router/test/phase4.test.ts` | 規劃 10 Phase 4: v1 訊息紀錄匯入 (`import-v1`), 三層 CLAUDE.md 範例, /telegram:doc 與 /telegram:format |
| `router/test/role-live.test.ts` | `LIVE=1` 才跑: 真的 claude 依各角色範本執行, 驗證 Claude Code 實際放行與擋下的事 |
| `router/test/e2e-wake.test.ts` | 真的 router + 假 claude CLI (`fixtures/`, 假 worker 是真的程序): 私訊與群組各自一個 worker 且不串線, 被回收後自動喚醒, worker 不在時連發多則只喚醒一次且不掉訊息 |

### Phase 1 驗收對照

| 驗收項目 | 測試 |
|---|---|
| 私訊與群組各自一個背景 session, 回覆不會跑錯對話 | e2e-wake「DM and group each get their own worker…」, e2e「a plugin for the conversation gets…」(user 對話送往別的 chat 被擋) |
| worker 被回收後再傳訊會自動喚醒 | e2e-wake「a reaped worker is woken by the next message…」 |
| 連續快速傳多則只喚醒一次, 不掉訊息 | e2e-wake「a burst while the worker is down…」, phase1「unacked deliveries are sent again…」 |
| 每個 update 與送出的 payload 都在 db | e2e「every update is logged…」, e2e「…its reply goes out and is logged」 |

### Phase 2 驗收對照

| 驗收項目 | 測試 |
|---|---|
| 指令的權限與拒絕訊息符合規劃 03 指令表 | phase2 的指令測試 (users 被拒, admin 的限制, bot token 只限 owner 私訊, access, chat, session, config, 列表) |
| bot rotate 不斷線 | e2e「bot rotate (owner DM)…」: 輪詢換到新 token, 含 token 的訊息被刪, 換線後的訊息照常送達 |
| 指令執行後下一則訊息帶 router_log | e2e「a /router command is answered by the router…」 |
| compact 與喚醒後 chat_context 會補回 | phase2「SessionStart hook puts the chat_context back after compact」, e2e-wake「a reaped worker is woken…」(新連線帶 chat_context) |

### Phase 3 驗收對照

| 驗收項目 | 測試 |
|---|---|
| 每個角色: 能做的做得到, 不能做的被擋且原因正確 | phase3「five role templates…」「permcheck: each role template…」; 真的 claude 執行: role-live (LIVE=1) |
| 越權被擋時告訴模型改用不越權的方法, 做不到就問要不要向 owner 申請 | phase3「elevation: a plain user turn is refused with advice…」 |
| 發話者角色較高時在對話裡詢問, 120 秒預設拒絕 | phase3「…in-chat 提權執行/拒絕 prompt…」「nobody answers within the time limit…」 |
| 按下的人角色要夠高, 以他的角色執行; 只有下一個 subagent, 主 session 與其他 subagent 照舊被擋 | phase3「…only a role high enough may approve…」, phase3「cc-hook asks the router…」 |
| 主動申請 (request_elevation) 送 owner | phase3「request_elevation from a plain user turn…」 |
| 提權紀錄: 被擋, 申請, 成功 (附原申請連結), 群組話題 | phase3「…approval runs the next subagent…」(紀錄與連結), 「elevation log: with an approvals group…」 |
| 跨對話傳訊: owner 審核, 目標對話與 owner 同時詢問 | phase3「grants: owner mode…」「grants: target mode…」 |
| power 安裝套件: 低風險放行, 其餘送審, 核准後可裝 | phase3-pkg 全部 |
| 新 bot 初次設定與審核群組 | e2e-setup 全部 |
| /router perm 與覆寫 | phase3「/router perm: show…」「admin cannot touch…」「overrides lay paths…」 |
| 三選一按鈕與永久允許的範圍 | phase3 grants 兩條, 「永久允許 runs it this time…」; phase3-pkg「永久允許 lets the conversation…」 |
| 撤銷與執行授權 | phase3「authz: …」三條; phase3-pkg「installing an approved package is a use…」 |
| 跨 bot 技能的憑證, 技能範圍 | phase3-cred 全部; e2e-setup「credentials end to end…」; phase4「/telegram:bot-skill…」 |

### Phase 4 驗收對照

| 驗收項目 | 測試 |
|---|---|
| CLAUDE.md 三層改寫 (FORCED / GENERAL / Default suggestions), 人設放在 bot 資料夾 | phase4「three-tier CLAUDE.md example…」, e2e-setup「persona interview…」 |
| telegram:format skill, /telegram:doc 涵蓋新功能 | phase4「plugin skills…」 |
| 匯入 v1 的 messages.db, 可重複執行不重複匯入 | phase4「import-v1…」 |
| 舊對話資料夾與對話紀錄搬進 bot 資料夾, 之後從新位置 resume | phase3「bot folders…」 |
| 一週內沒有掉訊息, 回錯對話或權限誤放 | 上線觀察: router.db 的 queue (未 ack), outbound 錯誤, elev_log |

