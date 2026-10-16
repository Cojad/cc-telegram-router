---
name: bot-skill
description: 建立或修改技能 (skill) 的 SOP: 技能放在哪個範圍 (單一對話, 這隻 bot, 全部 bot), 誰能安裝到哪個範圍, 技能需要 token 或要操作另一隻 bot (跨 bot 技能) 時怎麼處理. 使用者要你「做一個技能」「把這個存成 skill」, 或技能需要任何 token 時, 先讀這份再動手.
---

# 建立技能的 SOP

## 技能放哪裡

Claude Code 會從工作目錄往上讀 `.claude/skills`, 所以技能裝在哪裡決定誰拿得到. 你自己寫不進任何 `.claude` 資料夾 (Claude Code 內建保護, 只有 owner 的對話例外), 所以一律先寫在 `<你的資料夾>/skills/<名稱>/`, 再用 `install_skill` 請 router 複製過去:

| 範圍 | 裝到哪裡 | 誰能裝 |
|---|---|---|
| 只有這個對話 | `<你的資料夾>/.claude/skills/<名稱>/` | power 以上的對話, `install_skill` (scope `conversation`) |
| 這隻 bot 的所有對話 | `<home>/bot<id>/.claude/skills/<名稱>/` | owner 與 admin 對話, `install_skill` (scope `bot`) |
| 全部 bot 的所有對話 | `<home>/.claude/skills/<名稱>/` | owner 與 admin 對話, `install_skill` (scope `all`) |

不確定範圍時先問使用者; 預設只裝在這個對話. 對話角色不夠時 `install_skill` 跟其他越權動作一樣被擋並走提權 (發話者角色較高就在對話裡詢問, 否則問使用者要不要用 request_elevation 向 owner 申請), 只能允許一次.

## 步驟

1. 在自己資料夾寫好 `skills/<名稱>/SKILL.md` (frontmatter 要有 `name` 與 `description`, description 寫清楚「什麼時候用」), 腳本放 `skills/<名稱>/scripts/`.
2. 照 SKILL.md 實際跑一次腳本, 確認可用.
3. 呼叫 `install_skill` (name, scope). router 會檢查: 對話角色夠裝這個範圍, 有 SKILL.md, 沒有符號連結, 檔案裡沒有像 token 的字串; 通過後複製過去 (venv, node_modules 不複製). scope `conversation` 會在這一輪結束, worker 閒置後重新叫醒時載入; `bot` 與 `all` 讓其他對話下次叫醒時載入.
4. 告訴使用者裝在哪個範圍, 之後怎麼更新 (改 `skills/<名稱>/`, 再用 `install_skill` 帶 `replace: true`).

## 技能需要 token 時

用的是**這隻 bot 自己**: 不用登記, `bot_api` 的 credential 填 `self` 即可 (只限 owner 與 admin 的對話; getUpdates 等會打斷 router 收訊的方法不開放). 以下是**別的 bot 或外部服務**的 token.

**token 永遠不寫進技能, 也不放在對話讀得到的 .env.** 一律存成 router 的憑證, 用 `bot_api` 工具呼叫:

1. 請 owner (或 admin) 登記憑證, 二擇一:
   - 在**自己和 bot 的私訊**傳 `/router cred add <名稱> <token> [方法...]`. router 會驗證 token, 立刻刪掉那則訊息, token 只存在 router 設定檔, 不會進到任何對話.
   - token 已經在某個檔案裡: 在終端機執行 `cc-telegram-router cred-import <名稱> <檔案> <變數名> [方法,...]`, 值不會印出來.
   - **不要叫使用者把 token 貼在對話裡**; 對方貼了就提醒他換一把新的, 並改走上面的方式.
2. 只開放技能需要的 Bot API 方法 (`/router cred allow <名稱> <方法...>`), 預設只有 owner 與 admin 角色的對話能用 (`/router cred roles <名稱> <角色,...>` 可調整). 角色不夠的對話呼叫時跟其他越權動作一樣被擋並走提權: 發話者角色較高就在對話裡詢問, 否則可以 request_elevation 向 owner 申請; 只能允許一次, 要長期開放請 owner 調整憑證的角色.
3. 技能裡用 `bot_api` (credential, method, params, files) 呼叫. 要上傳檔案時, 檔案放在自己資料夾, `files` 寫 `{ "欄位": "/絕對路徑" }`, params 裡用 `attach://欄位` 指到它.
4. SKILL.md 寫明用到哪個憑證, 哪些方法, 讓之後的人知道要登記什麼.

`/router cred list` 可以看有哪些憑證 (只列名稱, 對應的 bot 或網址, 方法或路徑, 角色, 不會顯示 token).

### 對話專屬密鑰 (任何角色都能用)

這個對話自己要用的 token 或 API key (不是給整隻 bot 的技能), 請**使用者自己**在這個對話傳:

- `/secret set <名稱> <token> [方法...]` (Telegram bot token, 沒寫方法就是全部)
- `/secret set <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴>] [路徑...]` (一般 API, 結尾 `*` 代表前綴, 沒寫路徑就是全部; 預設 `Authorization: Bearer <key>`, 像 `x-api-key` 這種 API 用 `--header x-api-key`)

bot token 會先用 getMe 驗證, 不是有效的 bot token 就不會存.

router 自己處理那則訊息 (你不會收到它, 只會在 router_log 看到 `<已遮蔽>`), 加密存起來, 私訊裡立刻刪掉; 群組裡 bot 沒有刪除權限時會提醒發送者自己刪.
之後用 `bot_api` 或 `http_api`, credential 填那個名稱: 對話自己的密鑰優先於全域憑證, 不看角色也不用授權, 只能呼叫登記時的方法或網址與路徑.
回應裡出現的值會換成 `<密鑰>`. 使用者用 `/secret list` 看有哪些, `/secret rm <名稱>` 移除. 這只是**建議使用者自己去下指令**, 不要叫他把值貼給你.

### 一般 API key (OpenAI 之類)

不是 Telegram bot 的 key 也一樣存成 router 的憑證, 種類是 http: 由 owner 在終端機
`cc-telegram-router cred-import <名稱> <檔案> <變數名> <路徑,...> --http <網址>` 登記, 只開放需要的路徑
(結尾 `*` 代表前綴). 技能裡用 `http_api` (credential, path, json 或 form + files) 呼叫; 回應裡的 base64
大檔 (例如產生的圖) 用 `save_b64` `{ "at": "data.0.b64_json", "to": "相對路徑" }` 直接存進自己資料夾,
不要讓它回到對話裡.

## 特權動作 (技能的 sudo bit)

技能要用到 user 或 power 對話拿不到的東西 (cookie, 沙箱外的檔案), 又希望這些對話不用提權就能用時, 在技能資料夾加 `privileged.json`, 列出動作 (像 sudoers):

```json
{ "actions": {
  "extract": { "run": ["bash", "scripts/extract.sh", "{url}", "{force?}"],
               "args": { "url": { "pattern": "https://(www\\.)?youtube\\.com/\\S+" }, "force": { "flag": "--force" } },
               "roles": ["owner", "admin", "power", "user"], "creds": { "COOKIE_DIR": "my-cookies" },
               "timeout": 900, "auth_failure": "reason=auth", "refresh": "refresh" },
  "refresh": { "run": ["python3", "scripts/refresh.py", "{cred:COOKIE_DIR}"], "creds": { "COOKIE_DIR": "my-cookies" }, "internal": true } } }
```

- 技能要裝在這隻 bot 或全部 bot 範圍, 由 owner 或 admin 用 `/router skill approve <技能>` 核准; 核准會記下檔案雜湊, 之後改了任何檔案都自動暫停, 要重新核准.
- 對話用 `run_skill` (skill, action, args) 呼叫. router 檢查角色與參數格式 (不經 shell), 在專屬沙箱執行: 只讀得到技能資料夾與 `creds` 指定的憑證資料夾 (路徑放在環境變數), 只寫得到對話資料夾, router 狀態與 $HOME 都看不到.
- 憑證資料夾在 router 那邊 (`/x/cc/.router/creds/<名稱>`), 由 owner 放入檔案. 腳本要把憑證的工作副本放 `/tmp` (沙箱私有), 不要寫進對話資料夾; router 也會掃描回傳文字與輸出檔, 發現憑證內容就刪除並通知 owner.
- `auth_failure` 比對到輸出時, router 執行 `refresh` 指定的 internal 動作一次 (只有它能寫憑證資料夾) 再重試; 更新失敗會通知 owner.
- 動作要呼叫 API (例如 Whisper) 時寫 `"http": { "WHISPER": "openai" }`: 腳本拿到 `$WHISPER_URL` (base URL) 與 `$WHISPER_HEADER` (整行授權標頭, 例如 `Authorization: Bearer ...`), 要寫進 `/tmp` 的檔案再給 `curl -H @檔案`, 不要放命令列; key 出現在輸出會被遮蔽並通知 owner.
- 某個參數只給較高角色用時寫 `"force": { "flag": "--force", "roles": ["owner", "admin"] }`: 其他角色帶這個參數會被擋, 照一般流程觸發提權申請 (發起者角色夠高就在對話裡問, 不然請對方用 request_elevation); 核准後由 subagent 重新呼叫. 這種限制不能永久允許.
- 每個對話每小時最多 10 次.

## 跨 bot 技能

要操作另一隻 bot 的資源 (例如只有建立者能修改的貼圖包) 就是跨 bot 技能: 那隻 bot 的 token 照上面登記成憑證, 方法只開放需要的那幾個. 憑證只用來管理資源, 不拿來以那隻 bot 的身分發言. 這類技能通常放「全部 bot」範圍, 由 owner 或 admin 安裝.

## 腳本與工具的分工

腳本 (bash, python) 呼叫不到 MCP 工具, 所以:

- 腳本負責產生檔案 (產圖, 轉檔, 整理資料), 輸出檔案路徑.
- 需要 Telegram 的步驟由你呼叫工具: 送訊息用 `reply`, 送貼圖用 `send_sticker`, 用憑證的操作用 `bot_api`; 一般 API 用 `http_api`.
- 放在「這隻 bot」或「全部 bot」範圍的技能, 腳本對所有角色的對話都是唯讀可執行 (sandbox 允許讀, 不能改); 需要的 Python 套件裝在自己資料夾 (例如 `pip install --target ./.pylib <套件>` 再設 `PYTHONPATH=./.pylib`).
- 終端機的 session 沒有這些工具: owner 在終端機用 `cc-telegram-router cli botapi <憑證> <方法> '<JSON>' [--file 欄位=/路徑]`.

## 檢查清單

- [ ] SKILL.md 的 description 寫清楚觸發時機
- [ ] 沒有任何 token, 密碼, API key 寫在檔案裡
- [ ] 需要的憑證已登記, 方法只開放必要的
- [ ] 範圍與使用者確認過
- [ ] 實際跑過一次
