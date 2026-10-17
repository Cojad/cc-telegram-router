# 部署與維運

[README](../README.md) 的文件索引列出所有文件.

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
  "claudeBin": "/home/<user>/.local/bin/claude",
  "skillRefreshAt": "05:00"
}
```

`owners` 可以留空, 用 log 裡的認領碼認領 (見下方「新 bot 初次設定與審核群組」). 套件審核用的模型就是 `model`. `skillRefreshAt` 是特權技能每日更新憑證的時間 (GMT+8 `"HH:MM"`, `"off"` 關閉, 不寫就是 `"05:00"`), 改了要重啟 router; 格式寫錯只會關閉每日更新並在 log 寫一行 `config.json: ...`, router 照常啟動. 沒有特權技能, 或技能沒有 refresh 動作時, 每日更新什麼都不做.

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

## 時間

時間一律 GMT+8, 不出現 UTC 或 Z: router 的 log 每行開頭是 `2026-10-17 08:06:04.919+08:00`, 交給 worker 的訊息時間 (`<channel ts=...>`) 是 `2026-10-17T08:06:04.919+08:00`, 指令輸出, 通知, router_log 與報表顯示的時間都換算成 GMT+8 (`shared/time.ts`, `router/context.ts` 的 `gmt8`). router.db 與訊息紀錄裡存的仍是 UTC 的 ISO 時間 (比較與查詢用), 顯示時才換算.
