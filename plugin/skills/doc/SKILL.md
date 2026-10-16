---
name: doc
description: cc-telegram-router 的使用說明: /router 指令, /id 查 uid, 角色與權限, 提權, 套件安裝審核, 審核群組與新 bot 初次設定, 「cc /」代打, 即時進度訊息. 有人問「怎麼設定角色」「怎麼查 uid」「/router 怎麼用」「為什麼被擋」「怎麼提權」「這個 bot 能做什麼」時使用.
---

# cc-telegram-router 使用說明

這些指令是 **router 自己處理的**, 不會送進任何 worker. 你 (worker) 不能代替使用者執行它們, 只能教使用者怎麼打. 使用者需要 owner 或 admin 角色才能用.

## 角色

由高到低: `owner` > `admin` > `power` > `user` > `guest`.

- owner: 全部能力, 含 bot token 與 router core 設定. 由 config 的 owners 指定.
- admin: 可以用所有 /router 指令, 但不能把任何人設成 owner, 不能異動 owner, bot token 的新增/更換/移除只限 owner 私訊.
- power, user, guest: 不能用 /router 指令 (會收到明確的拒絕訊息).

使用者有自己的角色 (`/router role`), 每個對話也有角色 (`/router perm ... role`). 對話的角色決定那個對話裡的 worker 能做什麼:

| 對話角色 | worker 能做的事 |
|---|---|
| owner | 全部, 不受資料夾與 sandbox 限制 |
| admin, power | 自己資料夾內讀寫, Bash 在 sandbox 裡執行 (python3, node, bun), 可連 PyPI 與 npm. power 安裝套件要經過審核 |
| user | 自己資料夾內讀寫, Bash 只能跑唯讀指令 |
| guest | 只能對話, 讀收到的附件 |

## 權限不足與提權

- 每個工具呼叫都會先由 router 依對話角色檢查; 越權就擋下, worker 會改用不越權的方法, 做不到時告訴你並問要不要向 bot owner 申請.
- **你的角色高於這個對話時**: 被擋的同時, router 會在對話裡貼出「✅ 允許一次 / ♾️ 永久允許 / ❌ 拒絕」, 120 秒沒人按視為拒絕. 按下的人角色要高於對話, 而且被擋的動作在他的角色下允許; 之後 worker 開的第一個 subagent 以按的人的角色執行. 永久允許會把這類動作加進對話的權限覆寫 (訊息裡會寫明範圍, 例如「執行 python3 開頭的指令」「讀取 /x/data 底下的檔案」); 跳出 sandbox 不能永久允許.
- **向 owner 申請**: 你同意後 worker 會呼叫 request_elevation, 申請送到審核群組 (或 owner 私訊), owner 或 admin 決定.
- 所有被擋下的動作, 提權申請與結果都記在提權紀錄 (審核群組的「📜 提權紀錄」話題, 附原申請的連結).

## 審核按鈕, 撤銷與執行授權

- 每個申請 (跨對話傳訊, 套件安裝, 提權) 都有「✅ 允許一次」「♾️ 永久允許」「❌ 拒絕」, 申請訊息會寫明永久允許的範圍. 目標對話收到的跨對話詢問只有允許與拒絕.
- 允許過的申請, 審核群組裡那則訊息會留一個「🚫 撤銷」按鈕; owner 或 admin 按下後, 加入的權限立刻移除, worker 閒置時重啟套用.
- 每一次動用已核准的權限 (提權的 subagent 的每個工具呼叫, 靠永久允許才過的動作, 靠授權送往其他對話, 安裝已核准的套件) 都記在「🧾 執行授權」話題, 附工具呼叫內容與「🚫 撤銷」按鈕.

## 套件安裝審核 (power 對話)

pip, uv, poetry, npm, bun, yarn, pnpm, npx, uvx 的安裝指令會先由 router 查 PyPI/npm 的資料, 交給模型判斷風險: low 直接放行 (結果快取一週); medium, high, 審核失敗, 或從 URL, 本機路徑, 自訂來源安裝, 一律送 owner 審核. 核准後該對話之後都能安裝那些套件; owner 也可以直接用 `/router perm [chat_id] pkg allow pypi:名稱`.

## 跨對話傳訊

worker 要送訊息到別的對話會被擋, 它可以用 request_send_grant 申請: 向 owner 申請 (永久有效), 或請目標對話同意 (同時也會送給 owner, 先按的人決定).

## 技能與憑證

技能可以有特權動作 (像 sudo): owner 或 admin 用 `/router skill approve <技能>` 核准後, user 與 power 對話也能用 `run_skill` 執行, 需要的 cookie 等憑證由 router 在專屬沙箱裡交給腳本, 對話拿不到; 技能檔案被改就自動暫停. `/router skill list` 看狀態. 細節見 /telegram:bot-skill.

owner 與 admin 的對話可以直接以這隻 bot 自己的身分呼叫任何 Bot API (例如刪除訊息, 置頂, 查群組資訊): `bot_api` 的 credential 填 `self`, 不用另外登記. getUpdates, setWebhook, deleteWebhook, logOut, close 會讓 router 收不到訊息, 不開放; 其他角色不能用.

做技能, 或技能需要 token / 要操作另一隻 bot 時, 先讀 `/telegram:bot-skill`. 重點: token 不寫進技能, 由 owner 或 admin 在私訊用 `/router cred add` 登記成 router 的憑證, worker 用 `bot_api` 工具使用 (一般 API key 由 owner 在終端機登記, 用 `http_api`); owner 與 admin 的對話可以用 `install_skill` 把技能裝成整隻 bot 或全部 bot 共用.

任何角色的對話都能有自己的密鑰: 使用者在這個對話傳 `/secret set <名稱> <值> [方法...]` 或 `/secret set <名稱> <值> --http <網址> [路徑...]`, router 加密保存並刪掉那則訊息 (群組沒有刪除權限時提醒發送者刪), worker 用 `bot_api` / `http_api` 填那個名稱使用, 不看角色也不用授權, 值不會進到對話. `/secret list` 看有哪些, `/secret rm <名稱>` 移除; owner 與 admin 用 `/router secret list|rm <chat_id>` 管理任何對話的密鑰.

## 審核群組與新 bot 初次設定

- 重要通知 (新對話, worker 叫不醒) 與權限申請預設私訊 owner. owner 可以建一個開了話題的 supergroup, 把 bot 設為管理員並勾選「管理話題」, 在群組裡下 `/router setup group`, 之後改送到群組的「🔔 重要通知」「🔐 權限審核」「📜 提權紀錄」「🧾 執行授權」四個話題 (已設定過的群組再下一次會補上缺的話題).
- 新 bot 第一次被 owner 私訊時, 會先訪談名字, 個性, 說話風格, 用途, 寫成那隻 bot 的人設.
- `/router setup` 看狀態, `setup skip` 改回私訊 owner, `setup persona` 下次私訊時重新訪談.

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
| `/router perm [chat_id] show \| role <角色> \| tool allow\|deny\|rm <規則> \| path read\|write\|rm <路徑> \| net allow\|rm <網域> \| mcp allow\|rm <名稱> \| send allow\|rm <chat_id> \| pkg allow\|rm <pypi\|npm:名稱> \| reset` | 調整對話的角色與權限覆寫, 回覆會列出變更; worker 閒置時重啟套用 |
| `/router setup [group\|skip\|persona]` | 審核群組與 bot 初次設定 (只限 owner) |
| `/router cred list \| add <名稱> <token> [方法...] \| allow\|disallow <名稱> <方法...> \| roles <名稱> <角色,...> \| rm <名稱>` | 跨 bot 技能用的憑證; add 只能在自己和 bot 的私訊下, 訊息會被刪除 |
| `/router botapi <憑證> <方法> <JSON> [--file 欄位=/路徑]` | owner 直接用憑證呼叫 Bot API (終端機用 `cc-telegram-router cli botapi ...`) |
| `/router config` | 列出 router 設定; `get`/`set <key>` 讀寫單項 (owners 與 claudeBin 只有 owner 能改) |
| `/router log [chat_id] [筆數]` | 最近的訊息紀錄 |
| `/router bot list` | 列出 bot (add/rotate/remove 只限 owner 私訊) |
| `/restart` | 重啟 router, worker 不受影響 |
| `/router help` | 指令總覽 |

`[chat_id]` 省略時代表目前這個對話.

**在群組裡下列表類指令** (chat, log, role list, access show, config, bot list; status 例外, 直接回在群組), 結果會私訊給下指令的人, 群組只會看到「已私訊給你」. 對方沒私訊過 bot 的話要先私訊一次.

## 「cc /xxx」代打 slash command

在訊息開頭打 `cc /指令` (或 `柯柯 /指令`), router 會替這個對話的分身處理:

| 打法 | 結果 |
|---|---|
| `cc /router ...`, `cc /restart`, `cc /id` | 直接當 router 指令執行, 跟打 `/router ...` 一樣 |
| `cc /status`, `cc /usage` | 專用報表 (濾掉 email, session id 等私人欄位) |
| `cc /context` | 這個 session 的 context 用量表 加 甜甜圈圖 |
| `cc /cost` | 這個 session 的花費, 時間, 各模型用量 |
| `cc /其他指令` (例如 `/compact`, `/model opus`) | router 在終端機執行, 只取這個指令的輸出交給分身整理後回覆; 不是 Claude Code 的指令會直接說明; 分身 90 秒內沒整理就送原始輸出 |
| `cc //指令` | 開一次性的終端機執行, 直接送出當下畫面 (截圖); 上面有專用處理的指令打 `//` 也照 `/` 的方式處理 |

不論哪一種, 離開前都會把留在畫面上的選單或檢視關掉, 分身不會被卡住. owner 與 admin 可以代打任何指令; 群組裡所有人都能用 `cc /status` 與 `cc /usage`; `cc //` 截圖只限 owner 與 admin. 分身正在處理時, `cc /` 會請你稍後再試 (`cc //` 照樣截圖).

## 即時進度訊息

Telegram 觸發的一輪, 會先出現「🤔 思考中…」, 每個工具一行 (▶ 執行中, ✅ 完成), 結束時變「✅ 完成」並在幾秒後刪除. 答案是另一則訊息.

申請被允許, 拒絕, 逾時或撤銷之後, worker 處理結果的那一輪, 進度會回覆當初提出申請的那則訊息; 在別處按下按鈕時 (例如審核群組), 那裡也會出現一份同步的進度, 開頭標明是哪個對話.

## router 暫時離線時

reply 等工具會回「router 目前離線, 沒有送出」. 不要重試; router 恢復時你會收到 `<router_status>` 通知, 再依當下狀況重新送出.
