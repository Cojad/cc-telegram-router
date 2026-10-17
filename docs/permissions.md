# 權限, 提權與審核

角色範本在 `templates/roles/<角色>.json` (owner, admin, power, user, guest), 各角色在對話裡能做什麼的說明在 `/telegram:doc` (`plugin/skills/doc/SKILL.md`).

[README](../README.md) 的文件索引列出所有文件.

## 角色

使用者有角色 (`router.db` 的 `users`, 用 `/router role` 設定; config `owners` 一律是 owner, 沒設定過的是 user), 群組與頻道的對話也有自己的角色 (`conversations.role`, 用 `/router perm <chat_id> role` 設定, 新對話是 user). **私訊沒有自己的角色, 它的角色就是那位使用者的角色**: settings 產生, 權限檢查, 提權比較, 套件審核, 分類器, 工具呼叫紀錄的對話角色, `/router status` 與 `/router chat` 顯示的, 全部讀使用者角色 (router 每次讀私訊時從 `users` 與 config `owners` 算出來, `conversations.role` 欄位只是同步的複本). 同一個人在每隻 bot 的私訊都跟著他.

- 使用者角色改變 (`/router role`, 對私訊下的 `/router perm ... role`, config `owners` 增減) 時, 他所有私訊的 settings 與 chat context 立刻重寫, worker 標記待輪替 (閒置時停掉, 下一則訊息用新角色叫醒, 跟 `/router session rotate` 同一套), 回覆會列出受影響的私訊.
- `/router perm <私訊> role <角色>` 等同 `/router role <那位使用者> <角色>`: 同樣的權限檢查 (admin 不能設 owner, 不能異動 owner, config owner 要用 `/router config set owners`), 回覆會說明改成設定使用者角色. chat_id 對應不到使用者時拒絕, 提示改用 `/router role`.
- 私訊的權限覆寫 (`/router perm <私訊> tool|path|net|mcp|send|pkg ...`) 照常保留, 疊在使用者角色的範本上; `reset` 只清覆寫. 那位使用者自己的[使用者覆寫](#使用者覆寫)也套用在他的私訊: 先疊使用者覆寫, 再疊私訊覆寫 (覆寫只會增加 allow, deny, 路徑與網域, 拒絕規則永遠優先, 順序不影響結果).
- 遷移: 以前私訊可以有自己的角色. router 啟動時把每個私訊的 `conversations.role` 對齊使用者角色, 有變的記一行 log (`dm role <對話>: <舊> -> <新> (the user's role)`), chat context 版本加一, 並標記待輪替.

## 權限檢查與提權

每個工具呼叫在 PreToolUse 由 hook 問 router, router 依對話角色的 settings 檢查 (`permcheck.ts`). 越權就擋下並告訴模型改用不越權的方法 (Claude Code 把太長的工具結果存在 `~/.claude/projects/<對話>/<session>/tool-results/`, 非 owner 角色都能讀自己對話的這些檔; 只有唯讀指令白名單的角色, 用 `>` `>>` 等重導向寫檔, 或 `sort -o`, `uniq 輸入 輸出` 這類用選項寫檔也算越權, 跟 Claude Code 一致; 比對白名單時指令依 `&&` `||` `|` `;` 與換行切段, 引號裡與跳脫的字元不算, 所以 `grep -E 'a|b'` 是一個指令); 這一輪的發話者角色都高於對話時, 直接在對話裡貼出「提權執行 / 拒絕」詢問 (120 秒未回應視為拒絕). 按下的人角色要高於對話, 而且用他的角色加上他自己的[使用者覆寫](#使用者覆寫)重算後允許被擋的動作才算數; 之後的第一個 subagent 以他的角色執行, 它的每個呼叫也用他的角色加他的使用者覆寫檢查. 高風險工具在發話者都有權限時不用詢問, 直接放行; 不是每個人都有權限時, 只要在場有人可以就照樣在對話裡詢問 (見[自動提權](#自動提權)).

**重啟後的提權綁定** (`elevation.ts`, `router.db` 的 `elev_binds`): 已核准, 等著綁給下一個 subagent 的提權 (有 10 分鐘期限), 與已經綁定的 subagent (agent id, 角色, 按下的人, 提權編號) 都存進 `router.db`, router 重啟後仍有效 (柯姊 2026-10-17, 起因是部署重啟讓已綁定為 owner 的 subagent 回到對話角色). 比照[自己的 subagent 名單](#高風險工具), 每一筆綁定核准或綁定當時的 worker 程序 (session id, plugin 的 pid 與程序啟動時間): router 重啟後要等那個 worker 的 plugin 重新打招呼 (hello), 確認是同一個程序才算數; plugin 還沒回來時, 已綁定 subagent 的呼叫與帶著待綁定提權的 SubagentStart 先等它, 最多到 hook 的期限 (見 [router 連不到時](#router-連不到時)), 到期仍沒回來就照對話角色判斷. 同一個對話的 plugin 從另一個程序打招呼 (輪替, 重開, 換新 session) 時, 舊程序的待綁定提權與已綁定 subagent 一起失效並刪除, router 記一行 `elevation #<編號> <對話>: another worker process said hello, ...`. 核准時 plugin 沒連上的待綁定提權, 由之後第一個打招呼的程序接手; 這種沒有程序可對照的項目, 以及讀不到程序啟動時間的 (沒有 `/proc`), router 重啟後一律刪除. SubagentStop, 撤銷, 10 分鐘到期照原本規則移除 (資料庫一起刪); 過期的待綁定提權, 已不存在的對話的項目, 以及 30 天前綁定的 subagent, 在 router 啟動時與之後每天清掉. 綁定只對開出它的那個對話有效, 主 session 照舊不提權.

**這一輪的發話者** (`elevation.ts`): 自上一次 Stop 事件以來送進這個 worker 的所有訊息的發話者, 一輪進行中插進來的訊息也算; 判斷時取其中角色最低的人 (一般成員先說, admin 接著說, 兩則併成同一輪時, 這一輪只能做一般成員能做的事). 細節:

- 一輪進行中送進來的訊息, Claude Code 可能在這一輪讀到, 也可能留到下一輪才讀, 所以兩輪都算它的發話者 (多算只會讓角色變低, 不會變高). Stop 之後只留這些訊息的發話者, 之前的清掉.
- 只有表情回應摘要 (`kind=reactions`, 沒有 user_id) 的送入不算發話者; 只由它開始的一輪 (prompt hook 標記 reactions) 沒有發話者. 在 worker 終端機打的一輪 (prompt hook 沒有 Telegram 訊息) 也沒有發話者. 沒有發話者的一輪只看對話角色, 不詢問也不自動放行; 期間送進來的訊息留到下一輪.
- router 啟動時已經在跑的 worker 可能正在一輪中間, router 沒看到這一輪送進去的訊息: 到這個 worker 下一次 Stop 之前都當成沒有發話者 (保守), 除非下一輪開始時的 prompt 本身就說明了發話者 (下一點).
- **從 prompt 的 channel 標籤取得發話者**: Claude Code 開始一輪時把 prompt 原文交給 UserPromptSubmit hook, 每則訊息是一個 `<channel source="plugin:telegram:telegram" ...>` 標籤, 屬性就是 router 投遞時的 meta. hook (`shared/prompttags.ts`) 只把每個標籤的 `chat_id`, `message_id`, `user_id`, `kind`, `delivery` 送給 router (最多 100 個, 每個值最多 64 字), 名字, 時間與訊息內容都不送. router 每次投遞都在 meta 加一個隨機的 `delivery` 標記 (存在 `queue.tag`, 重送時不變). 這個 worker 的這一輪還不明時 (上一點), 標籤全部對得上才採用: 每個帶 `user_id` 的標籤, 它的 `delivery` 要是 router 一小時內投遞給這個對話的訊息, 且 router 記錄的 `chat_id`, `message_id`, `user_id` 與標籤相同, 也沒有被更早的 prompt 提過 (`queue.prompted_at`, 每個 prompt 提到的投遞都會記上). 有一個對不上 (訊息內容裡抄來的標籤, 舊版 router 投遞的沒有 `delivery`, 格式壞掉, 同一個屬性出現兩次, 超過 100 個標籤) 就整批不用, 照上一點等 Stop, router log 記 `turn of <對話>: prompt tags not used (<原因>), no sender until its Stop`; 採用時記 `turn of <對話>: its senders from the prompt's tags (<數量> message(s) with a sender)`, 這些人加進這一輪的發話者 (router 啟動後投遞的訊息原本就算在內). 沒有 `user_id` 的標籤 (router 通知, 表情回應摘要) 不加任何人. 已經知道發話者的一輪不看標籤, 照投遞紀錄判斷. 一輪的發話者取角色最低的人, 所以就算訊息內容夾帶了別人的真標籤, 發話者自己的標籤也在同一個 prompt 裡, 角色不會因此變高. worker plugin 從 router 啟動之後才開始的程序打招呼時 (輪替, 重開, 新 session), 沒有漏看的一輪, 立刻照常判斷; 換了程序時舊程序的發話者清掉, 還沒確認收到的訊息重送時會再算進來. 讀不到程序啟動時間 (沒有 `/proc`) 時一律等 Stop.
- Stop 沒送到 (例如一輪被中斷) 時, 發話者會一直累積到下一次 Stop, 只會讓角色變低.

## 高風險工具

角色範本沒有規範的工具 (Claude Code 內建, 不屬於 Bash, 檔案讀寫, WebFetch/WebSearch, MCP) 原本一律放行; 其中會碰到這個對話以外的幾個改成 power 以下 (power, user, guest) 要提權 (`permcheck.ts` 的 `riskyRefusal`), admin 與 owner 不擋, 其他工具維持原狀:

- `ListAgents` (列出整台機器的 session), `RemoteTrigger`, `CronCreate`, `CronDelete`, `ScheduleWakeup`, `PushNotification`: 一律擋下, 原因是「power 以下的角色不能使用 <工具>」.
- `SendMessage`: 收件對象不是這個對話自己的 subagent 就擋下, 原因是「power 以下的角色不能傳訊給其他 session (收件對象 <對象> 不是這個對話自己的 subagent)」. 自己的 subagent 是: SubagentStart 回報的 agent id; 以及 router 放行的 Agent 呼叫帶的 `name`, 要等它的 SubagentStart 到了才算 (依 `subagent_type` 對應, 同時開好幾個時依序配對). Agent 呼叫被擋或 subagent 沒有啟動時, 那個名字不算: 沒有同名的 subagent 時, 裸名稱會送到同名的其他 session. 背景 subagent 回報給 `"main"` 只在 subagent 發出時放行, 主 session 送 `"main"` 當成跨 session. `name [ref]`, `uds:`, `bridge:` 這類位址, 空白與不認得的名稱都當成跨 session. 這份名單依對話分開, 存在 `router.db` 的 `own_agents`, router 重啟後仍有效. 每一筆綁定開它的那個 worker 程序 (session id, worker plugin 的 pid 與該程序的啟動時間, 三者都相同才算同一個程序, pid 被系統重用時啟動時間不同; 讀不到啟動時間, 例如沒有 `/proc` 的系統, 那個 worker 的名單一律不算): 只有 router 啟動後 plugin 已經打過招呼 (hello) 的那個 worker 的項目才算數, plugin 沒連上時一律不算 (SendMessage 給名單裡的名稱時先等 plugin 回來, 見 [router 連不到時](#router-連不到時)); 同一個對話的 plugin 從另一個程序打招呼 (輪替, 重開, 換新 session, 即使 session id 沒變) 時, 舊程序的項目整批刪除, 因為那些 subagent 已經不在, 留著同名項目會讓裸名稱送到同名的其他 session. SubagentStart 到的時候 plugin 沒連上, 這個 subagent 不記 (保守). 還在等 SubagentStart 的 Agent 呼叫名稱只放在記憶體, 不入庫: router 重啟或 worker 換程序時丟棄, 那個名稱就不算. SubagentStop 不移除項目: 已結束的 subagent 可以用 SendMessage 叫回來繼續, 移除會把對自己 subagent 的訊息當成跨 session. 每個 worker 最多保留最新 500 筆; 30 天前加入的項目, 以及已不存在的對話的項目, 在 router 啟動時與之後每天清掉.

settings 的規則可以改變這條線: allow 規則**只寫工具名稱** (例如 `ListAgents`, `SendMessage`; 角色範本, `/router perm <對話> tool allow`, 或[使用者覆寫](#使用者覆寫)) 讓 power 以下也能用, `SendMessage` 是任何收件對象; deny 規則只寫工具名稱時所有角色都擋 (原因「<角色> 禁止 <工具>」). 帶括號的規則 (例如 `ListAgents(*)`) 不算.

### 自動提權

被擋的高風險工具呼叫 (上面六個與跨 session 的 `SendMessage`), 若**這一輪的每個發話者**都有權限做這個呼叫, router 在 hook 直接放行: 不開 subagent, 不跳按鈕, 不需要任何人按 (柯姊 2026-10-17). 「有權限」是用那位發話者的角色重算這個對話的 settings, 再疊上他自己的使用者覆寫, 照對話本身的檢查走一遍 (`checkCall`, `riskyRefusal`, 技能參數與憑證的角色限制); 所以角色範本開放某個工具給 power, 或某人被加了使用者覆寫, 自動生效. 放行時以這一輪最低的那個角色執行. 一輪裡有人權限不夠 (例如一般成員與 admin 的訊息併成一輪), 就不自動放行, 改走對話裡的按鈕: 這一輪的發話者中只要有人角色高於對話, 而且他的角色加他的使用者覆寫可以做這個呼叫, 就照原本流程在對話裡跳「允許一次 / 拒絕」, 在場的 admin 或 owner 不用跑去審核群組 (柯姊 2026-10-17); 沒有任何人夠格, 才告訴模型可以主動申請 (request_elevation, 送到審核群組).

每次自動放行都照樣記錄: `elev_log` (種類 `auto`) 與審核群組「📜 提權紀錄」話題各一則「⚡ 自動提權 <對話>: <工具與參數>, 收件對象 <對象> (只有 SendMessage) (subagent <id>)」, 下一行寫「發起者 <每位發話者 [角色]>: 這一輪的發話者都有權限, 以 <角色> 角色執行 (不用按鈕)」; 工具呼叫紀錄的決定是 `allow`, 有效角色是放行的角色, 原因是「自動提權 (發起者 ...), 以 <角色> 角色執行」.

只有 hook 能自己決定的這幾個工具會自動放行, 也只有它們看「在場有人夠格」就詢問. 其他被擋的動作 (路徑, 網路, 跳出 sandbox, 技能參數與憑證) 照上面的 subagent 提權流程不變: 取這一輪角色最低的發話者, 他的角色高於對話而且允許這個動作才在對話裡詢問, 否則告訴模型可以主動申請. 高風險工具的申請只能「允許一次」, 不提供永久允許 (申請訊息寫明「高風險工具 ... 只能一次一次允許」, 也沒有永久允許的按鈕); 按下的人也要是 admin 以上 (或他的 settings, 含使用者覆寫, 開放了這個工具), 不夠的人按了會回「你的角色 (<角色>) 也不允許這個動作」. 核准後下一個 subagent 以按下的人的角色執行, 可以使用這些工具與傳訊給其他 session, 主 session 照舊被擋.

實測 (Claude Code 2.1.302, role-live): 除了 `CronDelete` 都會觸發 PreToolUse 並被 router 擋下; **`CronDelete` 不觸發 PreToolUse**, 模型呼叫了就直接執行, router 看不到也擋不了, 也不會出現在工具呼叫紀錄. 它只能刪除同一個 session 自己用 `CronCreate` 建立的排程 (排程只存在該 session 的記憶體), 而 power 以下建立排程已經要提權, 所以影響限於刪掉提權後建立的排程. role-live 會檢查這件事, Claude Code 哪天開始送 hook 時測試會提醒.

hook 一直連不到 router 時維持原狀 (只擋跳出 sandbox, 其他交給 worker 自己的設定), 所以 router 不在時這些工具不會被擋; router 重啟的空窗由 hook 重試與 router 等 plugin 補上, 見 [router 連不到時](#router-連不到時).

## router 連不到時

router 重啟時有兩段空窗 (實測數字見 [部署與維運](operations.md#router-重啟)): router 程序本身連不上, 以及 router 起來了但 worker 的 plugin 還沒重新打招呼 (hello). 兩邊照同一份時間表 (`shared/retry.ts`) 處理, 共用同一個期限.

- **時間表**: 第一次立刻試, 之後間隔 3, 5, 7, 15, 15 秒, 最多重試 5 次, 總共 6 次 (第 0, 3, 8, 15, 30, 45 秒), 整段最多 45 秒. 期限是 hook 第一次嘗試的時間加 45 秒, 每次請求都帶給 router.
- **hook 重試** (`hooks/hook.ts`): 只有 PreToolUse 與 SubagentStart 兩種事件, 而且只在「連不到」時重試: socket 不存在, 連線被拒, 或連上後還沒拿到回答就斷線 (router 正在結束). 連上了而 router 還在處理不是重試的理由, 照下面的單次等待等它回答. 其他事件 (prompt, post, stop, compact, SubagentStop) 照舊只送一次. 6 次都連不到才落回上面的規則: 放行, 但 `dangerouslyDisableSandbox` 一律拒絕 (原因 `router unreachable: no unsandboxed commands`). 位置檔不存在 (沒有安裝 router) 時不重試, 直接落回.
- **斷路** (`shared/retry.ts` 的 breaker): 從第一次連不到算起超過 3 分鐘, 期間沒有任何一次連上時, 之後每個請求 (PreToolUse, SubagentStart) 只試一次, 連不到就照上面的規則落回, 不再走 45 秒的重試. 任何一次連上 (任何事件, 連上但等不到回答也算) 就恢復正常的時間表; 之後再連不到, 3 分鐘從新的第一次重新算. 狀態由每個 hook 程序共用 (hook 每次都是新的程序), 存在使用者的暫存位置 `$XDG_RUNTIME_DIR/cc-telegram-router/reach-<socket 路徑的雜湊>.json` (沒有 `XDG_RUNTIME_DIR` 時是 `~/.cache/cc-telegram-router/`, 不在 `stateDir` 裡), 一個 router socket 一個檔, 內容只有第一次連不到的時間 (`down_since`) 與最後一次連上的時間 (`last_ok`). 只在狀態改變時寫 (一次斷線的第一次失敗, 斷線後第一次連上), 寫入用暫存檔再改名 (原子), 權限 600; 檔案不存在, 讀不到或內容壞掉都當成正常, 寫不進去也只是下一個 hook 不知道.
- **單次等待**: 連上之後等 router 回答到期限再加 5 秒, 套件安裝審核 ([套件安裝審核](#套件安裝審核)) 維持 55 秒; 兩者都不超過第一次嘗試後 55 秒. 最壞情況 (最後一次在第 45 秒才連上) 整個 hook 在 55 秒內結束, 在 `templates/base-settings.json` 給 PreToolUse 與 SubagentStart 的 60 秒逾時之內. 等不到回答時同樣落回上面的規則.
- **router 等 plugin** (`router/elevation.ts`): SendMessage 的收件對象在這個對話的自己的 subagent 名單 (`own_agents`, 任何一個 worker 程序的項目) 裡, 但這個對話的 worker plugin 目前沒有連上時, 先等, 不擋. plugin 一打招呼就立刻判斷, 不等下一個檢查點: 同一個 worker 程序就算自己的 subagent, 放行; 另一個程序時舊項目已刪除, 照跨 session 處理. 到期限 (hook 帶來的期限, 最多從現在起 45 秒) 仍沒連上才當成不是自己的 subagent, 走原本的擋下, 按鈕與提權流程. 對話角色本來就允許這個 SendMessage (admin 以上, 或 settings 開放) 時不等; 收件對象不在名單裡, `"main"`, 以及 plugin 已經連上時照舊立刻判斷; 舊版 hook 沒帶期限時也不等.
- **記錄**: 只有重試或等待時 router log 才記一行, 正常呼叫不記 (斷路中的那一次嘗試連上時不算重試, 不記). hook 在第二次以後才連上時記 `hook <事件> <對話>: reached the router on try <次數>, <秒數>s after the first`; router 等 plugin 時記 `own subagent <收件對象> of <對話>: waited <秒數>s for the worker's plugin, <結果>`, 結果是 `the same worker is back: counted`, `another worker process said hello: not counted` 或 `the plugin did not say hello in time: not counted`. 6 次都連不到時 router 不在, 沒有 log.

## 使用者覆寫

權限覆寫原本掛在對話上 (`/router perm <對話> ...`). 使用者覆寫掛在人身上 (`router.db` 的 `user_overrides`), 用 `/router perm user <uid|@username> show | tool allow|deny|rm <規則> | path read|write|rm <路徑> | net allow|rm <網域> | mcp allow|rm <名稱> | reset` 設定 (指令見[部署與維運](operations.md#router-perm-user)). 權限檢查比照對話覆寫與 `/router role`: owner 與 admin 可以下, admin 不能異動 owner (查看可以). `send` 與 `pkg` 是 router 依對話把關的, 不能掛在使用者身上.

生效範圍:

- **他發起的一輪, 在任何對話**: [自動提權](#自動提權)重算他的權限時疊上去; 他在對話裡按提權按鈕時, 檢查他能不能核准, 以及核准後 subagent 的每個呼叫, 也疊上去. 群組裡這只影響 hook 層的判斷 (高風險工具); 路徑與網域覆寫不會改變群組 worker 的 settings 與 sandbox, worker 照樣讀寫不到那些路徑, 連不到那些網域.
- **他自己的私訊** (每隻 bot): 私訊角色就是使用者角色, 所以使用者覆寫寫進私訊的 settings (先疊使用者覆寫, 再疊私訊覆寫), `/router perm <私訊> show` 會另列一行「使用者覆寫」. 改了之後他所有私訊的 settings 立刻重寫, worker 標記待輪替 (閒置時停掉, 下一則訊息套用).

## 工具呼叫紀錄

每個經過 PreToolUse 而由 hook 轉給 router 的工具呼叫, 在 `router.db` 的 `tool_history` 記一筆 (所有角色, 含 owner 對話), 用來觀察平常用到哪些工具, 目前不做白名單. 欄位: 時間, 對話, 對話角色, 有效角色 (已提權的 subagent 以較高角色執行時, 或自動提權放行時), 工具名稱, router 的決定 (`allow` 或 `deny`), 原因 (擋下時, 或提權放行時), 收件對象 (只有 SendMessage), 是否來自 subagent. 工具參數一律不存 (指令與檔案內容可能有密鑰), 原因與收件對象先遮蔽已知格式的密鑰再截斷 (160 與 80 字). `allow` 是 router 沒有擋, 之後 Claude Code 仍依 worker 自己的設定判斷.

主 session 呼叫的 Telegram plugin 工具 (reply, react...) 不經 hook 轉給 router, 改在 router 執行時記錄, 決定是 `allow` 或 `error` (被拒或 API 失敗); 已提權的 subagent 呼叫時有效角色是提權的角色. 不在 router home 底下的 Claude Code session (例如 owner 自己的終端機, 沒有這個 hook) 不會有紀錄. 寫紀錄失敗只記 log, 不影響放行. 報表與保留期見 [部署與維運](operations.md#工具呼叫紀錄).

## 套件安裝審核

power 對話的套件安裝 (pip, npm, bun...) 由 router 查 registry 資料後交給模型判斷風險, low 直接放行, 其餘送 owner 審核. 指令解析認得各工具帶值的選項 (例如 `--only-binary :all:`, `--target pydeps`, `--omit dev`), 值不算套件; 帶了改變來源的選項 (`-i`/`--index-url`, `--extra-index-url`, `-f`/`--find-links`, `--trusted-host`, `--registry`...) 時, 那筆安裝的每個套件都列成自訂來源項目「<套件> (來源 <url>)」, 不查 PyPI/npm 的資料, 一律送人審. 從 URL, 本機路徑安裝與 `-e` 安裝也一樣. 這些項目核准 (允許一次或永久允許都一樣) 只放行下一次完全相同的安裝, 不寫任何權限覆寫, 之後再裝仍要審核 (審核訊息會說明原因; owner 用 `/router perm` 手動加的 `other:` 覆寫仍有效); `uvx --from`, `--with`, `pipx run --spec`, `npx -p` 的值是套件, 這時後面的第一個字是指令.

## 審核按鈕, 撤銷, 執行授權

- 申請 (跨對話傳訊, 套件安裝, 提權) 都是「允許一次 / 永久允許 / 拒絕」 (跨對話傳訊的允許一次叫「允許這個對話」: 之後這個對話都可以傳到那裡; 已存在的覆寫不受影響), 申請訊息寫明永久允許的範圍: 跨對話是 `send *` (可送往 bot 所在的任何對話), 套件是 `pkg *` (PyPI 與 npm 不用審核, URL 與自訂來源仍審核), 提權是把被擋的那類動作寫成權限覆寫 (`Bash(python3)` 與 `Bash(python3 *)` 一對, 不帶參數的 `hostname` 這類指令也涵蓋; 讀寫某個資料夾, 某個工具或 MCP); 跳出 sandbox 與重導向寫檔不能永久允許.
- 申請有了結果後, worker 處理結果的那一輪, 進度回覆當初提出申請的那則訊息; 在其他地方按下按鈕時, 那裡也同步一份進度 (開頭標明對話). 在 worker 終端機打的那一輪提出的申請 (跨對話傳訊, 套件審核, 提權) 沒有對應的 Telegram 訊息, 結果不回覆任何訊息, 也不會綁到上一則.
- 允許過的申請在審核群組留「🚫 撤銷」按鈕. 每一次動用已核准的權限都記在 `auth_uses` 與「🧾 執行授權」話題, 附工具呼叫內容與撤銷按鈕. 撤銷會移除權限覆寫 (一對 Bash 規則一起移除), 丟掉尚未使用的提權, 輪替 worker 並通知它; 授權出現過的每則訊息 (申請的每一份, 每次使用, 提權紀錄話題裡那則「✅ 提權成功」) 都拿掉按鈕並標「🚫 已撤銷」.

審核群組本身的設定見 [部署與維運](operations.md#新-bot-初次設定與審核群組).
