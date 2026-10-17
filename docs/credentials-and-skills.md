# 技能與憑證

[README](../README.md) 的文件索引列出所有文件.

## 技能範圍

- 技能範圍: `<home>/.claude/skills` (全部 bot), `<home>/bot<id>/.claude/skills` (一隻 bot), 對話資料夾的 `.claude/skills` (單一對話). worker 寫不進任何 `.claude` (Claude Code 內建保護, 只有 owner 對話例外), 所以技能先寫在對話資料夾的 `skills/<名稱>/`, 再用 `install_skill` 由 router 複製: scope `conversation` (power 以上) 裝到該對話的 `.claude/skills`, `bot` 與 `all` (owner 與 admin) 裝到前兩個範圍; 角色不夠時跟其他越權動作一樣走提權. router 會拒絕含 token 或符號連結的技能.
- 放在 bot 或全部 bot 範圍的技能, sandbox 裡的角色可以讀與執行, 不能改.

## 憑證

- 跨 bot 技能需要的 token 存在 `config.json` 的 `credentials` (token, 允許的方法, 允許的角色), 由 owner 或 admin 在私訊用 `/router cred add` 登記 (訊息會被刪), 或在終端機用 `cc-telegram-router cred-import <名稱> <檔案> <變數> [方法,...]` 從檔案搬進來. worker 用 `bot_api` 工具使用, 看不到 token; owner 在終端機可用 `cc-telegram-router cli botapi`. 對話角色不在憑證允許的角色 (含 `self`) 時跟其他越權動作一樣擋下並走提權 (發話者角色較高就在對話裡詢問, 只能允許一次); 憑證不存在或方法, 路徑沒開放則直接拒絕.
- 一般 API key (例如 OpenAI) 也存成憑證, 種類 http: `cred-import <名稱> <檔案> <變數> <路徑,...> --http <網址>`, worker 用 `http_api`, 回應裡的 base64 可直接存成對話資料夾裡的檔案. 路徑先擋掉 `..`, `.`, `%2e`, 編碼過的 `/` 與 `\`, `#` 再比對前綴 (fetch 會把 `/v1/images/../files` 解析成 `/v1/files`), 對話密鑰也一樣. `bot_api` 與 `http_api` 的回應若回顯了 token 或 key (例如回聲 API), router 先遮蔽成 `<密鑰>` 才交給 worker.
- owner 與 admin 的對話用 `bot_api` 的 credential `self` 以這隻 bot 自己的身分呼叫任何 Bot API (getUpdates, setWebhook, deleteWebhook, logOut, close 除外).

對話自己登記的 token 與 API key (不用提權) 見 [密鑰](secrets.md#對話專屬密鑰).

## 特權技能

- 特權技能 (技能的 sudo bit): 技能帶 `privileged.json` 列出動作, owner 或 admin 以 `/router skill approve` 核准 (記下檔案雜湊, 改了自動暫停). 對話用 `run_skill` 呼叫, router 以 bwrap 專屬沙箱執行: 只讀技能與憑證資料夾 (`<stateDir>/creds/`), 只寫對話資料夾, 隱藏 router 的家目錄 (其他對話), stateDir, $HOME, config `sandboxDenyRead` 與放在這些位置以外的 router socket 檔 (見 [部署與維運](operations.md#安裝位置)); 輸出掃描憑證內容; 憑證被拒時執行 internal 的更新動作一次再重試; 每個對話每小時 10 次. 動作可以帶 http API 憑證 (`http`, 腳本拿到授權標頭的環境變數, key 會從輸出遮蔽); 單一參數可以限定角色 (`args.<名稱>.roles`), 較低角色帶這個參數就照一般流程觸發提權申請. 每天固定時間 (config `skillRefreshAt`, 預設 `"05:00"` GMT+8, `"off"` 關閉) router 對所有已核准技能執行一次被 `refresh` 指到的 internal 動作 (同樣的沙箱, 掛載, env 與雜湊檢查, 在 `<stateDir>/skill-refresh/<技能>/` 執行), 讓 cookie 不會放到過期: 雜湊不符就略過並通知 owner, 失敗通知 owner (輸出遮蔽憑證), 成功只記在 router log 與 `skill_runs` (對話欄位 `router:refresh`, 不算進任何對話每小時 10 次的限額). router 啟動一分鐘後補跑: 上次成功的每日更新超過 24 小時 (或從沒成功過) 的技能執行一次, 之後照每天的時間; 每次執行依序排隊, 不會重疊.

## worker 端 SOP

- worker 端的 SOP 在 `/telegram:bot-skill`.
