# 部署與維運

[README](../README.md) 的文件索引列出所有文件.

## 部署

```bash
CC_ROUTER_STATE=<home>/.router deploy/install.sh router   # 編譯到 <home>/.router/cc-telegram-router, 複製 templates 與報表腳本
deploy/install.sh plugin   # 打包 plugin v2 到官方 plugin 快取路徑 (第一次會備份原內容)
deploy/install.sh unit     # 安裝 systemd user unit
systemctl --user enable --now cc-telegram-router
```

`<home>` 是 router 的家目錄, 位置可自選 (見下方「安裝位置」). 共用的 `<home>/CLAUDE.md` 可以從範例開始: `cp templates/CLAUDE.md.example <home>/CLAUDE.md`. worker 端的使用說明在 plugin 的 `/telegram:doc` skill (`plugin/skills/doc/SKILL.md`).

`<home>/.router/config.json` (權限 600) 與 `access.json` 要手動建立一次, 建好後執行 `<home>/.router/cc-telegram-router register` (或再跑一次 `deploy/install.sh router`) 寫入位置檔:

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

## 表情回應 (reaction)

worker 收得到 Telegram 的 message reaction, 但不是每個表情都叫醒它:

- 收哪些: `all` 對話裡所有訊息的表情, `botself_only` 只收對這隻 bot 自己發的訊息的表情 (預設), `disable` 不收. 每個對話用 `/router chat [對話] react <all|botself_only|disable|default>` 設定 (權限與指定對話的方式同其他 `/router chat` 子指令, `default` 回到 config 的 `receiveReact`), 私訊與群組都適用; `/router chat` 列出每個對話目前的值. config 的 `receiveReact` 改了要重啟 router; 值寫錯只會改用 `botself_only` 並在 log 寫一行.
- 誰的表情: 跟訊息一樣, 只有會送進 worker 的人 (私訊是 owner 與 `allowFrom`, 群組是列在 `access.json` 的群組, 群組有 `allowFrom` 時只收名單內的人). 還沒有對話的 chat 不收.
- 「bot 自己發的訊息」: 這隻 bot 每個 Bot API 呼叫的回應裡帶的訊息 (send*, forward*, copy*, edit* 系列, 含 worker 的 reply, router 的指令回覆與通知, worker 用 `bot_api` 以這隻 bot 送出的) 都記在 `router.db` 的 `bot_messages` (bot, chat_id, message_id); 這個表之前的舊訊息看訊息紀錄 (`messages`) 裡這隻 bot 送出的 (`direction = 'out'`). Telegram 的 reaction update 本身不帶訊息的發送者, 所以只能靠 router 自己的紀錄.
- 送出: 表情先存在 router (記憶體, router 重啟會掉最多一分鐘的量), 在這個對話的下一則訊息送進 worker 時整理成 `<reactions>` 區塊附在前面; 或最後一個表情之後 1 分鐘內沒有新的表情也沒有新訊息, 就單獨送進 worker (會叫醒它), 每來一個新表情就重新計時. 單獨送的那一則以 router 名義送 (meta `user="router" kind="reactions"`), 不帶發送者, 不會讓任何人的角色替這一輪提權 (前一則訊息的發送者也不算); 那一輪不顯示「🤔 思考中…」(hook 看到這一輪的 prompt 只有 reactions 的 `<channel>` 才算, 跟一般訊息在同一輪就照常顯示).
- 摘要: 每則被回應的訊息一行, `1001 🤣×2 (Example User, Another User); 👍 (Example User)`; 同一人換表情或收回只算最後的狀態 (收回就消失, 某則訊息最後沒有任何表情就不列); 名稱是 Telegram 顯示名稱 (first + last name, 匿名管理員是群組名稱), 跟附件檔名一樣去掉 `< > [ ] ; 換行`, 最長 64 字, bot token 格式遮蔽; 自訂表情顯示 `[自訂表情]`, 付費表情 `[付費⭐]`. 最多列 50 則訊息, 超過時保留最近被回應的 50 則, 並註明省略幾則. 區塊開頭一行說明這是資訊不是指令, 名稱是不可信的外部資料.
- Telegram 的限制: getUpdates 的 `allowed_updates` 要明確列 `message_reaction` 才會收到 (空清單代表除了 `chat_member`, `message_reaction`, `message_reaction_count` 以外的全部), router 送的是空清單的那些類型再加 `message_reaction`, 原本收的類型都還在. **群組裡 bot 要是管理員才收得到 reaction**; 不是管理員時 `/router chat` 在那個群組註明「收不到 reaction (bot 不是管理員)」(查詢 getChatMember, 查不到時註明「查不到 bot 是否為管理員」). 私訊不需要. 匿名的表情計數 (`message_reaction_count`, 主要是頻道) 不收. bot 自己按的表情 Telegram 不會送來.

## 安裝位置

router 可以裝在任何位置, 程式不假設固定路徑:

- `home` 是 router 的家目錄, 每隻 bot 一個 `bot<id>/`, 每個對話一個資料夾都在這裡; 不寫時是 config.json 所在目錄的上一層. `stateDir` 放 router 執行檔, config.json, access.json, router.db, socket 與各對話的 settings; 不寫時是 config.json 所在目錄. 慣例是 `<home>/.router`, 也可以放在 home 以外.
- 位置檔: worker 的 plugin 與 hook 從 `~/.config/cc-telegram-router/router.json` 讀 router 的 `home`, `stateDir` 與 `socket` (`shared/locate.ts`). 不用環境變數, 因為背景 session 繼承的是 claude daemon 的環境, 而 owner 自己在 `<home>` 開的終端機 session 也要找得到 router. 位置檔由 `cc-telegram-router register` 依 config.json 寫入, `deploy/install.sh router` 在 config.json 已存在時會執行它. router 啟動時檢查位置檔: 指向自己 (同一個 `stateDir`) 但 `home` 或 `socket` 改過就更新並記 log; 不存在或指向另一個 router 只記 log, 不會改寫 (測試與第二套安裝不會蓋掉正式的位置檔). 位置檔不存在時, plugin 回報「不是 Telegram worker」並說明原因, hook 視同 router 連不上 (不准跳出 sandbox). plugin 只在 session 啟動時讀一次, 所以要先寫好位置檔再叫醒 worker.
- `deploy/install.sh router` 與 `unit` 要知道 `stateDir`: 第一次用 `CC_ROUTER_STATE=<home>/.router` 指定, 之後從位置檔讀; 兩者都沒有就停下並說明, 不會裝到預設位置.
- sandbox 隱藏的路徑: owner 以外的角色範本 `denyRead` 是 `{{hidden}}` 加上 `~` (使用者家目錄). `{{hidden}}` 是 router 的家目錄, `stateDir` (在家目錄底下時已包含在內) 與 config `sandboxDenyRead` (額外要隱藏的絕對路徑, 預設空; 例如同一台機器上其他專案所在的目錄), 互相包含的只留最外層. config `socket` 設在這些位置以外時, socket 檔本身也列入 (只藏那個檔, 不藏它所在的資料夾, 例如 `/tmp`, `/run`); socket 在使用者家目錄裡時 `~` 已經藏住, 不另外列; 設成系統資料夾 (`/`, `/tmp`, `/var/tmp`, `/run`, `/var/run` 等), 使用者家目錄或它的上層時不列, 以免 worker 壞掉. 自己的對話資料夾與共用技能資料夾再由 `allowRead` 打開. 特權技能的 bwrap 沙箱隱藏同一份清單 (見 [憑證與技能](credentials-and-skills.md)): 資料夾蓋上空的 tmpfs, 檔案 (socket) 蓋上 `/dev/null`, 不存在的略過; Claude Code 的 sandbox 對 `denyRead` 裡的檔案同樣蓋上 `/dev/null` (2.1.302 實測: 在 sandbox 裡 socket 變成字元裝置, 同資料夾的其他檔照常可讀; 連線另外被 sandbox 拒絕, `Operation not permitted`). `sandboxDenyRead` 的項目不是絕對路徑或是 `/` 時略過並在 log 寫一行, 其他項目照常隱藏. 改了要重啟 router, 再 `/router session rotate all` 讓 worker 用新的 settings.

## 新 bot 初次設定與審核群組

- config 沒有 owners 時, router log 會印出一次性認領碼; 私訊 bot `/start <碼>` 的人成為 owner.
- owner 第一次私訊一隻還沒設定的 bot, worker 會先訪談名字, 個性, 說話風格, 用途, 用 `save_bot_profile` 寫進 `bot<id>/CLAUDE.md`.
- 接著引導設定審核群組: 開了話題的 supergroup, bot 是管理員且能管理話題, 在群組裡下 `/router setup group`. router 建立「🔔 重要通知」「🔐 權限審核」「📜 提權紀錄」「🧾 執行授權」「🔑 密鑰偵測」五個話題 (已設定的群組再下一次會補上缺的話題). 可以略過, 之後通知與申請都私訊 owner (提權紀錄只留在 router.db).
- 設定存在 `bot_setup`, 以 bot 名稱為 key, 並記下它屬於哪個 Telegram bot id (`bot_id`, 跟 `bot<id>` 資料夾一樣是 token 冒號前那段; 啟動時補上現有 bot 的 id). `/router bot add` 時, 同名的設定屬於同一個 bot id 才沿用 (舊紀錄沒有 id 時, 看 `bot<id>` 資料夾在不在): 已完成人設的話, 回覆說明沿用既有人設與審核群組 (或照舊私訊 owner, 或提醒審核群組還沒設定), 不會再說要做初次設定. 名稱給了另一隻 bot 就當新 bot, 設定重置, 回覆照新 bot 的初次設定. 啟動時也一樣: `config.json` 裡某個名稱的 token 換成另一隻 bot (紀錄的 `bot_id` 跟 token 的 id 不同), 那個名稱的設定重置, router log 留一行, 並通知 owner 哪個名稱換了 bot (先用那隻 bot 送, 送不到再用其他 bot). 要重做人設用 `/router setup persona`. `/router bot rotate` 只接受同一隻 bot 的新 token (bot 資訊還沒取得時用舊 token 的 id 比對).

## bot 設定提醒

- `/router bot add` 與 `rotate` 等 getMe 完成才回覆, 之後馬上 `/router bot list` 就看得到新 bot. 某隻 bot 的資訊還沒取得時 (例如 router 剛啟動連不上 Telegram), `bot list` 與 `status` 顯示「讀取中」, getMe 照輪詢的重試規則 (見下方「輪詢與重試」) 重試到成功.
- 新增 bot (`/router bot add`), 新 bot 初次設定 (審核群組說明那則), `/router setup group` (設定成功或不符條件都附), 以及 bot 被加入群組時 (通知送到重要通知話題或 owner 私訊), router 會附上這隻 bot 的設定提醒.
- 群組隱私模式: 說明開啟與關閉的差別, 依 getMe 的 `can_read_all_group_messages` 顯示目前設定 (true 是關閉, 符合建議; 其他是開啟, 建議關閉), 關閉方式 (@BotFather `/setprivacy`). 重點一定寫出: 改完要把 bot 從群組移除再重新加入才生效; bot 是群組管理員就不受限制 (以管理員身分加入群組時不附這段).
- Bot-to-Bot Communication Mode (@BotFather 的設定): Bot API 的 getMe 沒有對應欄位, 查不到開了沒, 只附固定說明: 開與關的差別, 設定方式 (@BotFather `/setbot2bot` 或 BotFather Mini App), 以及風險 (router 不分辨發話者是人還是 bot, 其他 bot 的訊息與 /secret 這類指令會照常處理; 可能互相回覆停不下來).
- 兩段文字由柯姊定稿, 依她 review 草稿的標記加粗 (兩段的標題, 「開啟 (預設):」「關閉:」等清單開頭, 「關閉方式:」「設定方式:」「開啟的風險:」, 「兩件很重要的事:」與兩點的重點句; emoji, 目前設定那行與最後的建議段落不加粗), 以 parse_mode HTML 送出. 同一則訊息裡的其他文字, 以及帶入的群組名稱, bot 名稱一律做 HTML 跳脫, 名稱裡有 < > & 也送得出去; 萬一 Telegram 仍拒收 HTML (can't parse entities), 同一則改用純文字 (去掉標籤) 重送一次並記 log; 在終端機 CLI 下的指令印成純文字.

## 輪詢與重試

- 輪詢由 router 自己做 (`poller.ts`, 不用 grammY 的 bot.start), 啟動 (getMe) 與之後收訊都套用同一套規則: 網路錯誤與 Telegram 5xx 以 5 秒, 10 秒, 30 秒, 1 分, 2 分, 5 分逐步拉長, 之後每 5 分鐘一直重試 (429 照 retry_after); 斷線超過 2 分鐘才通知 owner 一次, 恢復時再通知一次. 409 衝突 (別的程式在用這個 token 收訊息) 每 60 秒重試並立刻通知. 401 (token 失效) 不再重試, 立刻通知 owner 用 `/router bot rotate`. 通知經其他還正常的 bot 送到它的重要通知話題或 owner 私訊; 409 與恢復通知也可以由那隻 bot 自己送 (409 只停收訊, 送訊息仍正常, 所以只有一隻 bot 時也收得到); 沒有 bot 送得出去, 或沒有 owner 與審核群組時只記 log. `/router status` 每隻 bot 後面標狀態: 收訊中, 重試中 (從幾點開始, 原因), token 失效.
- `/router` 指令的回覆遇到網路錯誤, Telegram 5xx 或 429 (照 retry_after) 時, 第一次送出後 1 分鐘內最多再試 3 次 (間隔 2 秒, 5 秒, 15 秒; `sendretry.ts`), 其他 4xx 不重試, 最後還是失敗就在 router log 記一行.

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
