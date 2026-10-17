# 權限, 提權與審核

角色範本在 `templates/roles/<角色>.json` (owner, admin, power, user, guest), 各角色在對話裡能做什麼的說明在 `/telegram:doc` (`plugin/skills/doc/SKILL.md`).

[README](../README.md) 的文件索引列出所有文件.

## 權限檢查與提權

每個工具呼叫在 PreToolUse 由 hook 問 router, router 依對話角色的 settings 檢查 (`permcheck.ts`). 越權就擋下並告訴模型改用不越權的方法 (Claude Code 把太長的工具結果存在 `~/.claude/projects/<對話>/<session>/tool-results/`, 非 owner 角色都能讀自己對話的這些檔; 只有唯讀指令白名單的角色, 用 `>` `>>` 等重導向寫檔, 或 `sort -o`, `uniq 輸入 輸出` 這類用選項寫檔也算越權, 跟 Claude Code 一致; 比對白名單時指令依 `&&` `||` `|` `;` 與換行切段, 引號裡與跳脫的字元不算, 所以 `grep -E 'a|b'` 是一個指令); 發話者角色高於對話時, 直接在對話裡貼出「提權執行 / 拒絕」詢問 (120 秒未回應視為拒絕). 發話者綁在那一輪: 在 worker 終端機打的一輪 (prompt hook 沒有 Telegram 訊息) 沒有發話者, 只看對話角色, 不在對話裡詢問, 到下一則 Telegram 訊息開始的那一輪為止. 按下的人角色夠高才算數, 之後的第一個 subagent 以他的角色執行.

## 高風險工具

角色範本沒有規範的工具 (Claude Code 內建, 不屬於 Bash, 檔案讀寫, WebFetch/WebSearch, MCP) 原本一律放行; 其中會碰到這個對話以外的幾個改成 power 以下 (power, user, guest) 要提權 (`permcheck.ts` 的 `riskyRefusal`), admin 與 owner 不擋, 其他工具維持原狀:

- `ListAgents` (列出整台機器的 session), `RemoteTrigger`, `CronCreate`, `CronDelete`, `ScheduleWakeup`, `PushNotification`: 一律擋下, 原因是「power 以下的角色不能使用 <工具>」.
- `SendMessage`: 收件對象不是這個對話自己的 subagent 就擋下, 原因是「power 以下的角色不能傳訊給其他 session (收件對象 <對象> 不是這個對話自己的 subagent)」. 自己的 subagent 是: SubagentStart 回報的 agent id; 以及 router 放行的 Agent 呼叫帶的 `name`, 要等它的 SubagentStart 到了才算 (依 `subagent_type` 對應, 同時開好幾個時依序配對). Agent 呼叫被擋或 subagent 沒有啟動時, 那個名字不算: 沒有同名的 subagent 時, 裸名稱會送到同名的其他 session. 背景 subagent 回報給 `"main"` 只在 subagent 發出時放行, 主 session 送 `"main"` 當成跨 session. `name [ref]`, `uds:`, `bridge:` 這類位址, 空白與不認得的名稱都當成跨 session. 這份名單只存在 router 記憶體, 依對話分開; router 重啟後之前的 subagent 都不認得, 一律當成跨 session (保守).

擋下的處理跟其他越權一樣走先擋再問: 發話者角色是 admin 以上就在對話裡詢問, 否則告訴模型可以主動申請 (request_elevation). 這些只能「允許一次」, 不提供永久允許 (申請訊息寫明「高風險工具 ... 只能一次一次允許」, 也沒有永久允許的按鈕); 按下的人也要是 admin 以上, power 按了會回「你的角色 (power) 也不允許這個動作」. 核准後下一個 subagent 以按下的人的角色執行, 可以使用這些工具與傳訊給其他 session, 主 session 照舊被擋.

實測 (Claude Code 2.1.302, role-live): 除了 `CronDelete` 都會觸發 PreToolUse 並被 router 擋下; **`CronDelete` 不觸發 PreToolUse**, 模型呼叫了就直接執行, router 看不到也擋不了, 也不會出現在工具呼叫紀錄. 它只能刪除同一個 session 自己用 `CronCreate` 建立的排程 (排程只存在該 session 的記憶體), 而 power 以下建立排程已經要提權, 所以影響限於刪掉提權後建立的排程. role-live 會檢查這件事, Claude Code 哪天開始送 hook 時測試會提醒.

hook 連不到 router 時維持原狀 (只擋跳出 sandbox, 其他交給 worker 自己的設定), 所以 router 不在時這些工具不會被擋.

## 工具呼叫紀錄

每個經過 PreToolUse 而由 hook 轉給 router 的工具呼叫, 在 `router.db` 的 `tool_history` 記一筆 (所有角色, 含 owner 對話), 用來觀察平常用到哪些工具, 目前不做白名單. 欄位: 時間, 對話, 對話角色, 有效角色 (已提權的 subagent 以較高角色執行時), 工具名稱, router 的決定 (`allow` 或 `deny`), 原因 (擋下時, 或提權放行時), 收件對象 (只有 SendMessage), 是否來自 subagent. 工具參數一律不存 (指令與檔案內容可能有密鑰), 原因與收件對象先遮蔽已知格式的密鑰再截斷 (160 與 80 字). `allow` 是 router 沒有擋, 之後 Claude Code 仍依 worker 自己的設定判斷.

主 session 呼叫的 Telegram plugin 工具 (reply, react...) 不經 hook 轉給 router, 改在 router 執行時記錄, 決定是 `allow` 或 `error` (被拒或 API 失敗); 已提權的 subagent 呼叫時有效角色是提權的角色. 不在 router home 底下的 Claude Code session (例如 owner 自己的終端機, 沒有這個 hook) 不會有紀錄. 寫紀錄失敗只記 log, 不影響放行. 報表與保留期見 [部署與維運](operations.md#工具呼叫紀錄).

## 套件安裝審核

power 對話的套件安裝 (pip, npm, bun...) 由 router 查 registry 資料後交給模型判斷風險, low 直接放行, 其餘送 owner 審核. 指令解析認得各工具帶值的選項 (例如 `--only-binary :all:`, `--target pydeps`, `--omit dev`), 值不算套件; 帶了改變來源的選項 (`-i`/`--index-url`, `--extra-index-url`, `-f`/`--find-links`, `--trusted-host`, `--registry`...) 時, 那筆安裝的每個套件都列成自訂來源項目「<套件> (來源 <url>)」, 不查 PyPI/npm 的資料, 一律送人審. 從 URL, 本機路徑安裝與 `-e` 安裝也一樣. 這些項目核准 (允許一次或永久允許都一樣) 只放行下一次完全相同的安裝, 不寫任何權限覆寫, 之後再裝仍要審核 (審核訊息會說明原因; owner 用 `/router perm` 手動加的 `other:` 覆寫仍有效); `uvx --from`, `--with`, `pipx run --spec`, `npx -p` 的值是套件, 這時後面的第一個字是指令.

## 審核按鈕, 撤銷, 執行授權

- 申請 (跨對話傳訊, 套件安裝, 提權) 都是「允許一次 / 永久允許 / 拒絕」 (跨對話傳訊的允許一次叫「允許這個對話」: 之後這個對話都可以傳到那裡; 已存在的覆寫不受影響), 申請訊息寫明永久允許的範圍: 跨對話是 `send *` (可送往 bot 所在的任何對話), 套件是 `pkg *` (PyPI 與 npm 不用審核, URL 與自訂來源仍審核), 提權是把被擋的那類動作寫成權限覆寫 (`Bash(python3)` 與 `Bash(python3 *)` 一對, 不帶參數的 `hostname` 這類指令也涵蓋; 讀寫某個資料夾, 某個工具或 MCP); 跳出 sandbox 與重導向寫檔不能永久允許.
- 申請有了結果後, worker 處理結果的那一輪, 進度回覆當初提出申請的那則訊息; 在其他地方按下按鈕時, 那裡也同步一份進度 (開頭標明對話). 在 worker 終端機打的那一輪提出的申請 (跨對話傳訊, 套件審核, 提權) 沒有對應的 Telegram 訊息, 結果不回覆任何訊息, 也不會綁到上一則.
- 允許過的申請在審核群組留「🚫 撤銷」按鈕. 每一次動用已核准的權限都記在 `auth_uses` 與「🧾 執行授權」話題, 附工具呼叫內容與撤銷按鈕. 撤銷會移除權限覆寫 (一對 Bash 規則一起移除), 丟掉尚未使用的提權, 輪替 worker 並通知它; 授權出現過的每則訊息 (申請的每一份, 每次使用, 提權紀錄話題裡那則「✅ 提權成功」) 都拿掉按鈕並標「🚫 已撤銷」.

審核群組本身的設定見 [部署與維運](operations.md#新-bot-初次設定與審核群組).
