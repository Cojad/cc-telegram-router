---
name: doc
description: cc-telegram-router 的使用說明: /router 指令, /id 查 uid, 角色, 「cc /」代打, 即時進度訊息. 有人問「怎麼設定角色」「怎麼查 uid」「/router 怎麼用」「這個 bot 能做什麼」時使用.
---

# cc-telegram-router 使用說明

這些指令是 **router 自己處理的**, 不會送進任何 worker. 你 (worker) 不能代替使用者執行它們, 只能教使用者怎麼打. 使用者需要 owner 或 admin 角色才能用.

## 角色

由高到低: `owner` > `admin` > `power` > `user` > `guest`.

- owner: 全部能力, 含 bot token 與 router core 設定. 由 config 的 owners 指定.
- admin: 可以用所有 /router 指令, 但不能把任何人設成 owner, 不能異動 owner, bot token 的新增/更換/移除只限 owner 私訊.
- power, user, guest: 不能用 /router 指令 (會收到明確的拒絕訊息).

## 查 uid 與 id: /id (同義 /info)

| 打法 | 結果 |
|---|---|
| `/id` | 這則訊息: `訊息ID`, `作者ID` (你的 uid, 有 username 時加 `[@username]`), `對話ID` |
| 回覆某則訊息打 `/id` | 被回覆那則的 `訊息ID`, `作者ID`, `對話ID` |
| `/id @username` | `使用者ID` 與最後出現的時間, 對話 (bot 要收過他的訊息) |

## 設定角色

- `/router role @username admin`
- `/router role 123456789 admin` (直接用 uid)
- 回覆某人的訊息打 `/router role admin` (對象就是被回覆的人)
- `/router role @username none`: 拿掉角色, 回到 user
- `/router role list`: 列出所有設定過角色的人, 格式 `名稱(@username) uid 角色`

`user` 這個字可加可不加: `/router role user @username admin` 也可以.

## 其他 /router 指令

| 指令 | 作用 |
|---|---|
| `/router status` | 每隻 bot 各列最近有訊息的對話 (新到舊, 每隻最多 10 個, 總行數超過 30 行時每隻 5 個, 最多 5 隻 bot), 每行 `狀態類型角色 多久前: 名稱`. 🛜待命中 = worker 正在執行且連上 router, 訊息立刻送達; 💤已休眠 = worker 沒在執行, 訊息先排隊, 下一則訊息自動叫醒. 😀DM 💬群組 📣頻道; 🥇owner 🥈admin 🥉power 🚻user 🥷guest |
| `/router chat` | 列出所有對話的角色, 模型, compact, mention, 待命中/已休眠, 最後活動 |
| `/router chat [chat_id] compact <750k\|1m\|auto>` | 調整自動壓縮門檻 (worker 會重啟) |
| `/router chat [chat_id] model <模型>` | 換模型 (worker 會重啟) |
| `/router chat [chat_id] mention <on\|off>` | 群組是否要提到 bot 才回應 |
| `/router access show \| pair <code> \| allow <uid> \| remove <uid> \| group add <chat_id> \| group rm <chat_id> \| policy <...>` | 誰能跟 bot 說話 |
| `/router session restart\|stop [chat_id]` | 重啟或停止某個對話的 worker |
| `/router session rotate [chat_id\|all]` | 標記 worker 等待輪替: 閒置的一分鐘內停掉, 忙碌的等它閒置; 下一則訊息會用新的程式與設定叫醒. 更新 plugin 或設定後用 |
| `/router config` | 列出 router 設定; `get`/`set <key>` 讀寫單項 |
| `/router log [chat_id] [筆數]` | 最近的訊息紀錄 |
| `/router bot list` | 列出 bot (add/rotate/remove 只限 owner 私訊) |
| `/restart` | 重啟 router, worker 不受影響 |
| `/router help` | 指令總覽 |

`[chat_id]` 省略時代表目前這個對話.

**在群組裡下列表類指令** (chat, log, role list, access show, config, bot list; status 例外, 直接回在群組), 結果會私訊給下指令的人, 群組只會看到「已私訊給你」. 對方沒私訊過 bot 的話要先私訊一次.

## 「cc /xxx」代打 slash command

在訊息開頭打 `cc /status`, `cc /usage`, `cc /compact` 等, router 會替這個對話的 worker 在它的終端機打入該指令並回傳畫面. owner 與 admin 可以代打任何指令; 群組裡所有人都能用 `cc /status` 與 `cc /usage`.

## 即時進度訊息

Telegram 觸發的一輪, 會先出現「🤔 思考中…」, 每個工具一行 (▶ 執行中, ✅ 完成), 結束時變「✅ 完成」並在幾秒後刪除. 答案是另一則訊息.

## router 暫時離線時

reply 等工具會回「router 目前離線, 沒有送出」. 不要重試; router 恢復時你會收到 `<router_status>` 通知, 再依當下狀況重新送出.
