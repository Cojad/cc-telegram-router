---
name: bot-skill
description: 建立或修改技能 (skill) 的 SOP: 技能放在哪個範圍 (單一對話, 這隻 bot, 全部 bot), 各角色能寫, 裝, 核准到哪裡, 技能需要 token 或要操作另一隻 bot (跨 bot 技能) 時怎麼處理, 特權動作 (privileged.json) 的執行細節與完整範例, 用 skill_check 檢查草稿, 用 skill_try 試跑 (power 以上). 使用者要你「做一個技能」「把這個存成 skill」, 或技能需要任何 token 時, 先讀這份再動手.
---

# 建立技能的 SOP

## 技能放哪裡

Claude Code 會從工作目錄往上讀 `.claude/skills`, 所以技能裝在哪裡決定誰拿得到. 你自己寫不進任何 `.claude` 資料夾 (Claude Code 內建保護, 只有 owner 的對話例外), 所以一律先寫在 `<你的資料夾>/skills/<名稱>/`, 再用 `install_skill` 請 router 複製過去:

| 範圍 | 裝到哪裡 | 誰能裝 |
|---|---|---|
| 只有這個對話 | `<你的資料夾>/.claude/skills/<名稱>/` | power 以上的對話, `install_skill` (scope `conversation`) |
| 這隻 bot 的所有對話 | `<home>/bot<id>/.claude/skills/<名稱>/` | owner 與 admin 對話, `install_skill` (scope `bot`) |
| 全部 bot 的所有對話 | `<home>/.claude/skills/<名稱>/` | owner 與 admin 對話, `install_skill` (scope `all`) |

不確定範圍時先問使用者; 預設只裝在這個對話. user 角色現在還不能自己安裝技能 (之後的階段才開放), 見[各角色能做到哪裡](#各角色能做到哪裡). 對話角色不夠時 `install_skill` 跟其他越權動作一樣被擋並走提權 (發話者角色較高就在對話裡詢問, 否則問使用者要不要用 request_elevation 向 owner 申請), 只能允許一次.

## 步驟

1. 在自己資料夾寫好 `skills/<名稱>/SKILL.md` (frontmatter 要有 `name` 與 `description`, description 寫清楚「什麼時候用」), 腳本放 `skills/<名稱>/scripts/`.
2. 一般技能照 SKILL.md 實際跑一次腳本, 確認可用 (特權動作的腳本要靠 router 給的環境變數, 你自己直接跑不起來, 見[特權動作](#特權動作-技能的-sudo-bit)).
3. 呼叫 `skill_check` (path: `skills/<名稱>`) 檢查: router 用自己的解析程式讀 SKILL.md 與 privileged.json (不執行任何程式), 告訴你哪裡錯, 怎麼改, `install_skill` 會不會拒絕, `/router skill approve` 會列出什麼. 有錯就照著改再檢查一次, 直到第一行是 `skill check: ok`.
4. 呼叫 `install_skill` (name, scope). router 會檢查: 對話角色夠裝這個範圍, 有 SKILL.md, 沒有符號連結, 檔案裡沒有像 token 的字串; 通過後複製過去 (venv, node_modules 不複製). scope `conversation` 會在這一輪結束, worker 閒置後重新叫醒時載入; `bot` 與 `all` 讓其他對話下次叫醒時載入.
5. 告訴使用者裝在哪個範圍, 之後怎麼更新 (改 `skills/<名稱>/`, 再用 `install_skill` 帶 `replace: true`).

## 技能需要 token 時

用的是**這隻 bot 自己**: 不用登記, `bot_api` 的 credential 填 `self` 即可 (只限 owner 與 admin 的對話; getUpdates 等會打斷 router 收訊的方法不開放). 以下是**別的 bot 或外部服務**的 token.

**token 永遠不寫進技能, 也不放在對話讀得到的 .env.** 一律存成 router 的憑證, 用 `bot_api` 工具呼叫:

1. 請 owner (或 admin) 登記憑證, 二擇一:
   - 在**自己和 bot 的私訊**傳 `/router cred add <名稱> <token> [方法...]`. router 會驗證 token, 60 秒後刪掉那則訊息 (他, owner, admin 可以按「取消刪除」保留), token 只存在 router 設定檔, 不會進到任何對話. 之後換 token 用 `/router cred rotate <名稱> <新 token>`, 方法與角色不變.
   - token 已經在某個檔案裡: 在終端機執行 `cc-telegram-router cred-import <名稱> <檔案> <變數名> [方法,...]`, 值不會印出來.
   - **不要叫使用者把 token 貼在對話裡**; 對方貼了就提醒他換一把新的, 並改走上面的方式.
2. 只開放技能需要的 Bot API 方法 (`/router cred allow <名稱> <方法...>`), 預設只有 owner 與 admin 角色的對話能用 (`/router cred roles <名稱> <角色,...>` 可調整). 角色不夠的對話呼叫時跟其他越權動作一樣被擋並走提權: 發話者角色較高就在對話裡詢問, 否則可以 request_elevation 向 owner 申請; 只能允許一次, 要長期開放請 owner 調整憑證的角色.
3. 技能裡用 `bot_api` (credential, method, params, files) 呼叫. 要上傳檔案時, 檔案放在自己資料夾, `files` 寫 `{ "欄位": "/絕對路徑" }`, params 裡用 `attach://欄位` 指到它.
4. SKILL.md 寫明用到哪個憑證, 哪些方法, 讓之後的人知道要登記什麼.

`/router cred list` 可以看有哪些憑證 (只列名稱, 對應的 bot 或網址, 方法或路徑, 角色, 不會顯示 token).

### 對話專屬密鑰 (任何角色都能用)

這個對話自己要用的 token 或 API key (不是給整隻 bot 的技能), 請**使用者自己**在這個對話傳:

- `/secret set <名稱> <token> [方法...]` (Telegram bot token, 沒寫方法就是全部)
- `/secret set <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [--default-header <名稱>:<值>]... [路徑...]` (一般 API, 結尾 `*` 代表前綴, 沒寫路徑就是全部; 預設 `Authorization: Bearer <key>`, 像 `x-api-key` 這種 API 用 `--header x-api-key`, 用 `?key=` 傳 key 的用 `--query key`)

bot token 會先用 getMe 驗證, 不是有效的 bot token 就不會存; 沒加 `--http` 而值不像 bot token (例如 API key) 時 router 不拿去 getMe, 直接提示要加 `--http`.

router 自己處理那則訊息 (你不會收到它, 只會在 router_log 看到 `<已遮蔽>`), 加密存起來, 私訊裡 60 秒後刪掉 (發訊者, owner, admin 可按「取消刪除」); 群組裡 10 秒後刪, 沒有取消按鈕, bot 沒有刪除權限時會提醒發送者自己刪. 要改 http 密鑰的預設標頭不用重貼 key: `/secret header <名稱>` (列出) | `set <標頭>:<值>` | `rm <標頭>`.
之後用 `bot_api` 或 `http_api`, credential 填那個名稱: 對話自己的密鑰優先於全域憑證, 不看角色也不用授權, 只能呼叫登記時的方法或網址與路徑.
回應裡出現的值會換成 `<密鑰>`. 使用者用 `/secret list` 看有哪些, `/secret rm <名稱>` 移除. 這只是**建議使用者自己去下指令**, 不要叫他把值貼給你.
使用者已經把值貼在對話裡時, 你看到的是 `<已遮蔽 #<event id>.<序號>: ...>`: 不要叫他重貼. owner 或 admin 的一輪可以用 `event_raw` 拿到代號, 再用 `secret_from_handle` 登記成這個對話的密鑰 (見 /telegram:doc 的「密鑰與原文」).

### 一般 API key (OpenAI 之類)

不是 Telegram bot 的 key 也一樣存成 router 的憑證, 種類是 http: owner 或 admin 在自己和 bot 的私訊
`/router cred add <名稱> <API key> --http <網址> [--header <標頭>] [--scheme <前綴|none>] [--query <參數>] [--default-header <名稱>:<值>]... [路徑...]`
(訊息 60 秒後刪除), 或 owner 在終端機 `cc-telegram-router cred-import <名稱> <檔案> <變數名> [路徑,...] --http <網址> [同樣的選項]`.
沒寫路徑就是那個網址底下全部路徑, 要收窄就列出路徑 (結尾 `*` 代表前綴). 範例 (Anthropic):
`/router cred add anthropic sk-ant-... --http https://api.anthropic.com --header x-api-key --default-header anthropic-version:2023-06-01`. 換 key 用 `/router cred rotate <名稱> <新 key>`, 不用重貼 key 改預設標頭用 `/router cred header <名稱> set <標頭>:<值>` (同名就更新), 移除用 `rm <標頭>`, 不帶參數就列出. 完整說明: 使用者打 `/router help cred`.
技能裡用 `http_api` (credential, path, json 或 json_file 或 form + files, 可選 headers) 呼叫. key 放哪裡由憑證決定, 你不用也不能自己放:
`headers` 只放 API 需要的其他標頭 (例如 `{"anthropic-version": "2023-06-01"}`; 憑證有預設標頭時 router 自動補上, 你帶了同名的就用你的), 帶 key 所在的那個標頭 (例如 x-api-key 憑證的 x-api-key), Authorization, Proxy-Authorization, Cookie, Host, Content-Type 這類會被擋; 用 `--query` 的憑證, path 裡也不能自己帶那個參數.
很大的請求 (例如幾十萬 token 的 count_tokens) 先寫成自己資料夾裡的 JSON 檔, 用 `json_file: "相對路徑"` 送出 (最多 20 MB, 要是合法 JSON, 跟 json, form, files 擇一), 不要把內容塞進 json 參數. 檔案是 router 讀的: owner 與 admin 對話可以給資料夾外的路徑 (router 狀態目錄除外), user 與 power 只能用自己資料夾裡的.
回應裡的 base64 大檔 (例如產生的圖) 用 `save_b64` `{ "at": "data.0.b64_json", "to": "相對路徑" }` 直接存進自己資料夾,
不要讓它回到對話裡.

## 特權動作 (技能的 sudo bit)

技能要用到 user 或 power 對話拿不到的東西 (cookie, API key, 另一隻 bot 的 token, 這隻 bot 共用的資料), 又希望這些對話不用提權就能用時, 在技能資料夾加 `privileged.json`, 列出動作 (像 sudoers). 對話用 `run_skill` (skill, action, args) 呼叫, router 在專屬沙箱執行, 憑證永遠不進對話. 完整可用的例子見[範例: 活動報名清單](#範例-活動報名清單).

### 流程

1. 在 `skills/<名稱>/` 寫 SKILL.md, privileged.json, 腳本.
2. `skill_check` 檢查到 `skill check: ok`, 把它回報的「核准時會列出」給使用者看. power 以上的對話再用 `skill_try` 試跑每個動作 (見[試跑](#試跑-skill_try)).
3. 特權動作只在**這隻 bot 或全部 bot 範圍**有效 (只裝在對話範圍的技能, 對話自己改得到, 不給特權): 由 owner 或 admin 的對話 `install_skill` (scope `bot` 或 `all`).
4. owner 或 admin 在 Telegram 打 `/router skill approve <名稱>` 核准. 核准記下檔案雜湊 (不含 venv, node_modules, `__pycache__`, `.git`), **之後改了任何檔案都自動暫停**, 要重新核准; 所以改好, 裝好之後再請他核准.
5. 動作用到的憑證要先登記 (見上面「技能需要 token 時」); 憑證本身的 roles 與 methods 不套用在特權動作上, 由核准與動作的 `roles` 把關.

### privileged.json 的欄位

每個動作是 `actions` 底下的一個物件:

| 欄位 | 意思 |
|---|---|
| `run` | 要執行的指令, 字串陣列, 不經 shell. 含 `/` 的相對路徑 (例如 `scripts/x.py`) 換成技能資料夾裡那個檔的絕對路徑; 找不到這個檔就原樣傳入, 而工作目錄是對話資料夾, 所以一定失敗 |
| `{名稱}` | `run` 裡獨占一個元素的參數, 換成 `args` 裡同名參數的值; 沒帶就拒絕執行. 不能跟其他字黏在一起 (`"--url={url}"` 會原樣傳入), 要寫成 `"--url", "{url}"` |
| `{名稱?}` | 可省的參數: 沒帶 (或空字串) 就整個略過, 不傳空字串 |
| `{cred:環境變數}` | 換成 `creds` 裡那個環境變數對應的憑證資料夾路徑 (沙箱裡的 `/cctr/creds/<環境變數>`) |
| `args.<名稱>.pattern` | 正規表示式, **整串比對** (router 包成 `^(?:pattern)$`), 所以不用自己加 `^` `$`, 也不能只比對到一部分就過. 值最長 2000 字, 不能有換行. 沒寫 pattern 就是任何一行字 |
| `args.<名稱>.flag` | 開關型參數: 值是 `true` 時傳入這個字 (例如 `--force`), 否則略過 |
| `args.<名稱>.roles` | 只有這些角色能帶這個參數, 較低角色帶了照一般流程觸發提權申請 (只能一次一次允許) |
| `roles` | 能呼叫的對話角色; 沒寫是 owner, admin, power, user (guest 不行) |
| `creds` | `{環境變數: 憑證資料夾名稱}`: 資料夾在 router 那邊, 由 owner 放入檔案 (例如 cookie); 腳本在 `$環境變數` 拿到沙箱裡的路徑 `/cctr/creds/<環境變數>`, 唯讀 |
| `http` | `{環境變數: http 憑證名稱}`: 腳本拿到 `$<ENV>_URL` (base URL, 結尾沒有 `/`) 與 `$<ENV>_HEADER` (整行授權標頭, 例如 `Authorization: Bearer ...`) |
| `bots` | `{環境變數: telegram-bot 憑證名稱}`: 腳本拿到 `$<ENV>_API` (`https://api.telegram.org/bot<token>` 這種網址; router 用自架的 Bot API 時可能是 `http://10.0.2.2:<埠>/bot<token>`, 照用即可), 例如 `$NOTIFY_BOT_API/sendMessage` |
| `store` | `{環境變數: 資料庫名稱}` 或 `{環境變數: {"name": ..., "mode": "full"}}`: 這隻 bot 共用的資料庫, 腳本在 `$環境變數` 拿到工作副本的路徑 (規則見下) |
| `timeout` | 秒, 沒寫是 600; 超過就被終止 |
| `internal` | `true`: 對話不能呼叫, 只由 router 執行 (憑證更新) |
| `auth_failure`, `refresh` | 輸出比對到 `auth_failure` (正規表示式, 不分大小寫) 時, router 執行 `refresh` 指的 internal 動作一次 (只有它能寫憑證資料夾) 再重試; router 每天固定時間 (預設 05:00 GMT+8) 與啟動時發現超過 24 小時沒成功更新, 也會主動執行它, 所以它要能在憑證還有效時重複執行 |
| `tools` | 需要的工具箱工具: `ffmpeg` (含 ffprobe), `deno`, `uv`; router 安裝時下載的固定版本, 在 `PATH` 最前面. 宣告了但工具箱沒裝時拒絕執行並說明. 系統的 `/usr/bin` 工具不用宣告 |
| `outbound_ports` | 只給非 internal 動作: 外網要多開的 port (1~65535 的整數陣列, tcp 與 udp), 預設只開 80, 443, 53, 22. 開不了主機本機與內網. **有這個宣告的技能只有 owner 能核准** |
| `host` | 只給 internal 動作, 主機存取: `{"ports": [主機的 port], "mounts": [唯讀可見的主機路徑, "~/" 是 router 使用者的家目錄], "env": {額外的環境變數}}`. `ports` 經 `$CCTR_HOST` 連 (例如 `http://$CCTR_HOST:9222`; 沙箱裡的 127.0.0.1 是沙箱自己, 不是主機); 有 `mounts` 時可以連掛進來的 unix socket (例如 ssh agent). 主機其他 port 與內網照樣連不到. **有這個宣告的技能只有 owner 能核准** |
| `mounts`, `env` | 舊寫法, internal 動作的 `host.mounts` 與 `host.env`; 寫在其他動作上沒有作用 |

環境變數名稱不能重複 (包含 `http` 展開的 `_URL`, `_HEADER` 與 `bots` 展開的 `_API`), 也不能是 PATH, HOME, LANG, TMPDIR, TZ, CCTR_HOST, VIRTUAL_ENV. 資料庫名稱是小寫英數字與 `-`. internal 動作不能用 store 與 bots.

### 執行時的環境

- **工作目錄是對話資料夾** (呼叫它的那個對話), 也是唯一寫得到的地方 (它的 `.chat` 唯讀), 輸出檔就寫在這裡, 寫相對路徑即可; 之後你用 `reply` 的 `files` 送出.
- **技能資料夾在沙箱裡唯讀**. Python 一律加 `-B` (例如 `["python3", "-B", "scripts/x.py"]`), 或 internal 動作的 `host.env` 設 `PYTHONDONTWRITEBYTECODE=1`, 不要寫 `__pycache__`.
- `HOME` 是沙箱私有的 `/tmp` (每次執行都是空的, 跑完就消失), `TMPDIR` 也是; 憑證的工作副本 (例如要改寫的 cookie 檔) 放這裡, 不要寫進對話資料夾. `PATH` 是 `/cctr/env/bin` (技能有 Python 環境時), `/cctr/tools/bin` (工具箱), `/usr/local/bin`, `/usr/bin`, `/bin`.
- **白名單: 只看得到列出來的東西**, 像手機 App. 有: `/usr` (系統的程式與函式庫, 例如 bash, curl, python3), 少數 `/etc` 檔 (CA 憑證, 名稱解析; `/etc/passwd` 只有沙箱自己的使用者), 技能資料夾, 宣告的憑證資料夾 (`/cctr/creds/<環境變數>`), 資料庫副本 (`/cctr/store/<環境變數>`), 對話資料夾, 私有的 `/tmp`. 其他全部不存在: router 使用者的家目錄 (裡面裝的套件與工具也用不到), `/home`, `/opt`, `/run`, `/sys`, router 的家目錄 (其他對話), router 狀態目錄, 其他技能.
- **不要從對話資料夾載入程式或套件** (例如 `PYTHONPATH=./.pylib`, `source ./x.sh`): 那個資料夾對話自己寫得到, 等於讓對話用動作的憑證跑任意程式.
- **Python 套件用 uv**: 技能資料夾放 `pyproject.toml` (`dependencies` 寫死版本) 與 `uv.lock` (用 `uv lock` 產生, 兩個檔一起放; GitHub 這類 git 來源寫在 `[tool.uv.sources]`, lock 會鎖在 commit). router 核准時建好環境並唯讀掛在 `/cctr/env`, `run` 寫 `"python3"` 就是環境裡的 Python (不要寫 `venv/bin/python3`). PyPI 套件由模型判斷風險, git 等自訂來源一律人工審核. 不要自己在技能資料夾建 venv (`install_skill` 不複製, 雜湊也不含).
- 參數是呼叫者給的輸入, 一律當資料: 不要拿去 `eval` 或組 shell 指令. 參數是檔名時, pattern 擋掉 `..` (例如 `(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}`), 腳本再確認它在工作目錄裡.
- 授權標頭與 bot 網址不要放在命令列 (別的程序看得到), 也不要印出來或寫進檔案: Python 直接放進請求; shell 先寫進 `/tmp` 的檔再 `curl -H @檔案`. 印錯誤時只印錯誤種類, 不要印整個請求或網址.
- **exit code 不是 0 就算失敗** (資料庫也不寫回). 對話收到 `exit <碼>` 開頭, 加上輸出 (stdout 與 stderr) 的最後 60 行.
- **輸出會掃描憑證**: 回傳文字裡出現的憑證內容 (cookie 值, http key, bot token) 遮蔽成 `<已遮蔽>`; 這次執行在對話資料夾寫出的文字檔含有憑證內容, 或檔名像 cookie 檔, 就刪除; 兩種都會通知 owner.
- **每個對話每小時最多 10 次** (`run_skill`, 不分技能).
- **網路: 外網只開 port 80, 443, 53, 22** (tcp 與 udp; 要別的 port 宣告 `outbound_ports`, owner 核准), **連不到主機本機與內網** (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 含雲端 metadata, IPv6 的本機與內網位址, 主機自己的位址); DNS 照常可用. 沙箱裡的 127.0.0.1 是沙箱自己. **不能建立 unix socket** (`/run` 不存在, 建立 AF_UNIX socket 一律失敗; `socketpair` 照常), 所以腳本不要依賴 docker, dbus 這類本機服務. router 自己執行的 internal 動作外網不限 port, 主機只連得到 `host.ports` 宣告的.

### 資料庫 store

- 同一隻 bot 的所有對話共用一份 (`<stateDir>/skill-store/bot<id>/<名稱>/`, 對話看不到), 只有宣告它的動作執行時看得到. 每次執行拿到的是副本, **exit 0 而且檢查通過才寫回**; 有一項不過就整次作廢, 資料庫不動, 對話收到原因, owner 收到通知. 同一個資料庫的執行依序排隊.
- append 模式 (預設): 原有的檔案與資料夾一個都不能少, 一般檔案內容不能變; `.jsonl` 只能在尾端加完整的 JSON 行: 每行一個合法 JSON, 以換行結尾, 不能有空行, 不能刪改舊行 (舊內容要逐位元是新內容的開頭). 可以新增檔案與資料夾 (新的 `.jsonl` 一樣每行都要是合法 JSON). 所以 user 與 power 能用的動作 (例如新增一筆) 用 append.
- full 模式: 可以新增, 修改, 刪除; **只准用在 roles 只有 owner 與 admin 的動作** (沒寫 roles 也不行), 否則 privileged.json 讀取失敗, 核准會拒絕.
- 兩種模式: 不接受符號連結, 裝置檔, fifo; 寫入的單檔上限 5 MB (append 的 `.jsonl` 算新加的部分), 一次執行所有資料庫加起來 20 MB; 寫入的內容含有這個動作的憑證內容也不接受.

### 試跑 (skill_try)

power 以上的對話用 `skill_try` (path, action, args, 選填 role, session, store_seed) 不用核准就跑一次草稿的動作. 跑法跟正式執行一樣 (參數比對, 沙箱, 工作目錄, 資料庫寫回檢查, 輸出掃描), 差別:

- **憑證全是假的**: `$<ENV>_URL` 與 `$<ENV>_API` 指到沙箱裡 127.0.0.1 上的假服務 (Bot API 一律回 `{"ok":true,"result":true}`, http API 一律回 `{"fake":true}`), key 與 token 是隨機的假值, `$<ENV>_HEADER` 的標頭名稱與前綴照真的憑證; creds 資料夾是空的. 所以腳本要能處理回應裡沒有想要的欄位 (範例的「查不到活動名稱」). 回傳會列出假服務收到的每個請求 (方法, 路徑, 大小與開頭).
- **資料庫從空的開始**, 不會複製這隻 bot 的正式資料庫. `store_seed` 給你資料夾裡的一個資料夾 (每個子資料夾是一個資料庫, 名稱同 privileged.json, 只能有一般檔案) 當初始內容; `session` 給一個名字 (小寫英數與 `-`), 試跑資料庫與 creds 資料夾就留給下一次 (最後一次使用後 24 小時清掉), 例如先 join 兩次再 list, cancel. 回傳列出這次資料庫的變動 (新增, 修改含 `.jsonl` 行數, 刪除); 寫回檢查不過時說明原因.
- 工作目錄是你資料夾裡的 `skill-try/<時間>-<動作>/`, 輸出檔在那裡.
- **試跑的網路: 跟正式執行一樣, 外網只開 port 80, 443, 53, 22 與動作宣告的 `outbound_ports`, 連不到主機本機與內網**; 試跑 internal 動作也是這幾個 port. DNS 照常可用. 沙箱裡自己的 127.0.0.1 是假服務, 不是主機. **也不能建立 unix socket** (`/run` 不存在, 建立 AF_UNIX socket 一律失敗; `socketpair` 照常), 所以腳本不要依賴 docker, dbus 這類本機服務.
- `role` 扮演等於或低於自己的角色, 看 `roles` 與 `args.roles` 擋不擋; 試跑不送提權申請.
- internal 動作也能試 (例如憑證更新腳本), 但沒有主機存取 (`host` 的 ports, mounts, env); timeout 最多 600 秒.
- 每個對話每小時 20 次, 不算進 `run_skill` 的 10 次.
- 第一行是 `skill try: ok`, `failed` (跑了, 但 exit 不是 0 或資料庫寫回被拒) 或 `refused` (沒有跑, 附原因).

試跑通過不等於正式能跑: 真的憑證要先登記 (試跑會提醒 router 裡不存在的), 要裝到 bot 範圍並核准. 有 `uv.lock` 的草稿試跑時也建環境, 但只限全部是 PyPI 而且自動審核判定 low 的套件; 有自訂來源的要等核准.

### 各角色能做到哪裡

| 角色 | 寫草稿 (`skills/<名稱>/`) | `skill_check` | `skill_try` | `install_skill` | 核准 (`/router skill approve`) |
|---|---|---|---|---|---|
| owner, admin | 可以 | 可以 | 可以 | 對話, 這隻 bot, 全部 bot 範圍 | 可以 (在 Telegram 打指令, 不是工具) |
| power | 可以 | 可以 | 可以 | 只有對話範圍; bot 與 all 範圍會被擋並走提權 | 不行 |
| user | 可以 | 可以 | 不行 (試跑的程式還沒核准, 要等之後的白名單沙箱) | 現在還不能 (被擋時走提權; 開放 user 自己安裝要等之後的階段) | 不行 |
| guest | 不行 (不能寫檔) | 不行 | 不行 | 不行 | 不行 |

所以 user 與 power 對話寫特權技能的終點是: 草稿寫好, `skill_check` 通過 (power 再加 `skill_try` 試跑過), 把結果 (特別是「核准時會列出」那段) 告訴使用者, 請 owner 或 admin 安裝到 bot 範圍並核准. 不要自己宣稱已經可以用.

### 範例: 活動報名清單

「群組活動的報名清單: 成員只能報名自己, 看清單; 取消報名與整理清單只限 owner 與 admin. 報名時查活動名稱, 並通知一個公告頻道」. 用到 http 憑證 (查活動資訊的 API), bot 憑證 (另一隻 bot 管理的公告頻道), store (append 給報名, full 給取消). 以下網址與名稱都是範例值.

`skills/signup/SKILL.md`:

```markdown
---
name: signup
description: 這隻 bot 共用的活動報名清單. 使用者要報名, 看誰報名了, 或管理員要取消某人的報名時用.
---

# 活動報名清單

用 run_skill 呼叫 (skill: signup):

- 報名: action join, args {"name": "顯示名稱", "note": "選填的備註"}
- 看清單: action list
- 取消: action cancel, args {"index": "編號"} (只有 owner 與 admin)

需要的憑證: http 憑證 event-api (查活動資訊), telegram-bot 憑證 notify-bot (公告頻道 @example_events 的管理 bot).
```

`skills/signup/privileged.json`:

```json
{
  "actions": {
    "join": {
      "run": ["python3", "-B", "scripts/signup.py", "join", "{name}", "{note?}"],
      "args": {
        "name": { "pattern": "[^\\s].{0,39}" },
        "note": { "pattern": ".{1,200}" }
      },
      "roles": ["owner", "admin", "power", "user"],
      "http": { "EVENTS": "event-api" },
      "bots": { "NOTIFY_BOT": "notify-bot" },
      "store": { "SIGNUPS": "signup" },
      "timeout": 60
    },
    "list": {
      "run": ["python3", "-B", "scripts/signup.py", "list"],
      "roles": ["owner", "admin", "power", "user"],
      "store": { "SIGNUPS": "signup" },
      "timeout": 30
    },
    "cancel": {
      "run": ["python3", "-B", "scripts/signup.py", "cancel", "{index}"],
      "args": { "index": { "pattern": "[0-9]{1,4}" } },
      "roles": ["owner", "admin"],
      "store": { "SIGNUPS": { "name": "signup", "mode": "full" } },
      "timeout": 30
    }
  }
}
```

`skills/signup/scripts/signup.py`:

```python
"""活動報名: join <名稱> [備註] | list | cancel <編號>. 由 router 以特權動作執行."""
import json, os, sys, time, urllib.request


def fail(msg):
    print(msg)
    sys.exit(1)


store = os.environ.get('SIGNUPS') or fail('沒有 $SIGNUPS: 這支要由 router 以特權動作執行')
path = os.path.join(store, 'signups.jsonl')


def rows():
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def call(url, data=None, header=None):
    # the auth header and the bot URL go straight into the request: never printed, never on a command line
    req = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode())
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    if header:
        name, value = header.split(': ', 1)
        req.add_header(name, value)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


cmd = sys.argv[1]
if cmd == 'join':
    name, note = sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ''
    if any(r['name'] == name for r in rows()):
        # exit 1: the run failed, so nothing is written back
        fail(f'{name} 已經報名過了')
    event = '這次活動'
    try:
        event = call(f"{os.environ['EVENTS_URL']}/v1/events/current", header=os.environ['EVENTS_HEADER']).get('title') or event
    except Exception as e:
        print(f'查不到活動名稱 ({type(e).__name__})')
    # append mode: one complete JSON line, ending in a newline
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'name': name, 'note': note, 'event': event, 'at': int(time.time())}, ensure_ascii=False) + '\n')
    try:
        call(f"{os.environ['NOTIFY_BOT_API']}/sendMessage", {'chat_id': '@example_events', 'text': f'🙋 {name} 報名了{event}'})
    except Exception as e:
        print(f'通知頻道失敗 ({type(e).__name__}), 報名已記下')
    print(f'{name} 報名成功, 目前 {len(rows())} 人 ({event})')
elif cmd == 'list':
    for i, r in enumerate(rows(), 1):
        print(f"{i}. {r['name']}" + (f" ({r['note']})" if r['note'] else ''))
elif cmd == 'cancel':
    keep, n = rows(), int(sys.argv[2])
    if not 1 <= n <= len(keep):
        fail(f'沒有第 {n} 位 (共 {len(keep)} 位)')
    gone = keep.pop(n - 1)
    # full mode (owner and admin only): the whole file is rewritten
    with open(path, 'w', encoding='utf-8') as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + '\n' for r in keep)
    print(f"已取消第 {n} 位: {gone['name']}")
else:
    fail(f'不認得的指令 {cmd}')
```

上線步驟: owner 或 admin 在自己和 bot 的私訊登記 `/router cred add event-api <API key> --http https://events.example.com` 與 `/router cred add notify-bot <bot token>` (那隻 bot 要是頻道管理員), 由 owner 或 admin 的對話 `install_skill` (name `signup`, scope `bot`), 再 `/router skill approve signup`. 之後任何 user 以上的對話: `run_skill` (skill `signup`, action `join`, args `{"name": "小明", "note": "會晚到"}`).

## 跨 bot 技能

要操作另一隻 bot 的資源 (例如只有建立者能修改的貼圖包) 就是跨 bot 技能: 那隻 bot 的 token 照上面登記成憑證. 兩種用法: 一般技能由你呼叫 `bot_api` (憑證的方法只開放需要的那幾個, 角色照憑證設定); 特權動作寫 `bots`, 腳本自己呼叫 (上面的範例). 憑證只用來管理資源, 不拿來以那隻 bot 的身分發言. 這類技能通常放「全部 bot」範圍, 由 owner 或 admin 安裝.

## 腳本與工具的分工

腳本 (bash, python) 呼叫不到 MCP 工具. 分兩種情況:

- **一般技能** (沒有 privileged.json, 腳本在你自己的沙箱跑): 腳本負責產生檔案 (產圖, 轉檔, 整理資料), 輸出檔案路徑; 需要 Telegram 或憑證的步驟由你呼叫工具: 送訊息用 `reply`, 送貼圖用 `send_sticker`, bot token 的操作用 `bot_api`, 一般 API 用 `http_api`. 需要的 Python 套件裝在自己資料夾 (例如 `pip install --target ./.pylib <套件>` 再設 `PYTHONPATH=./.pylib`, power 以上的對話, 安裝會經過套件審核). 放在「這隻 bot」或「全部 bot」範圍的技能, 腳本對所有角色的對話都是唯讀可執行.
- **特權動作** (privileged.json): 腳本由 router 在專屬沙箱執行, 自己用 `$<ENV>_HEADER`, `$<ENV>_API` 呼叫 API, 自己讀寫 `$<ENV>` 的資料庫; 不用 `bot_api` 與 `http_api`, 也不用 `.pylib` (見[執行時的環境](#執行時的環境)). 送訊息與送檔仍由你在 `run_skill` 回來之後用 `reply`.
- 終端機的 session 沒有這些工具: owner 在終端機用 `cc-telegram-router cli botapi <憑證> <方法> '<JSON>' [--file 欄位=/路徑]`, 特權動作用 `cc-telegram-router cli skill run` (見 docs/credentials-and-skills.md).

## 檢查清單

- [ ] SKILL.md 的 description 寫清楚觸發時機
- [ ] 沒有任何 token, 密碼, API key 寫在檔案裡
- [ ] 需要的憑證已登記, 方法只開放必要的
- [ ] 範圍與使用者確認過
- [ ] `skill_check` 第一行是 `skill check: ok`
- [ ] power 以上: 每個動作都用 `skill_try` 試跑過 (失敗與被擋的情況也試)
- [ ] 一般技能實際跑過一次; 特權動作已安裝到 bot 或全部 bot 範圍並核准後, 用 `run_skill` 跑過一次
