# session 與記憶

[README](../README.md) 的文件索引列出所有文件.

這份說明一個分身 (worker) 讀得到哪些指示與記憶, 從哪裡繼承, 誰能改; 它的 session (對話紀錄) 存在哪裡, 怎麼接續; 切換到 managed 模式時自動遷移了什麼; 以及從 OpenClaw 轉過來時, 原本的 workspace 檔案該放到哪裡. 用詞: 「對話」是一個 Telegram 私訊或群組, 「分身」是 router 為這個對話開的 Claude Code 背景 session, `<home>` 是 config 的 `home` (例如 `/x/cc`), `<stateDir>` 是 router 的狀態資料夾 (預設 `<home>/.router`).

## 記憶的繼承架構

### 自動繼承上層的 CLAUDE.md

Claude Code 啟動時, 從工作目錄一路往上到根目錄, 每一層資料夾的 `CLAUDE.md` 都會讀進 context. 分身的工作目錄是對話資料夾, 所以它自動繼承這條鏈上的每一份. 使用者層的 `CLAUDE.md` 不在其中: 分身一律帶 `--setting-sources project,local` 啟動 (沒有 `user`), 所以所有角色 (含 owner) 的分身都不載入它; managed 模式的使用者層位置也不是 `~/.claude/CLAUDE.md`, 而是 `<stateDir>/claude-config/CLAUDE.md`, 同樣不載入. 要給所有分身的規則寫在 `<home>/CLAUDE.md`.

```
/CLAUDE.md, /x/CLAUDE.md ...            <home> 的上層, 有的話也會讀到 (router 不使用)
<home>/CLAUDE.md                        全域: 所有 bot, 所有對話
<home>/bot<id>/CLAUDE.md                bot 層: 這隻 bot 的人設
<home>/bot<id>/<對話>/CLAUDE.md         對話層: 這個對話的客製
<home>/bot<id>/<對話>/memory/MEMORY.md  對話層的自動記憶索引
```

這些檔案全部一起放進 context, 不是下層取代上層. 下層寫得更具體, 規則衝突時以 `<home>/CLAUDE.md` 自己定的三層 (見下) 決定下層能不能覆寫. 因為是照資料夾往上找, 同一隻 bot 的所有對話自動共用 bot 層, 所有 bot 自動共用全域層, 不用另外設定.

### 各層一覽

| 層級 | 路徑 | 自動載入 | 誰能改 | 用途 |
|---|---|---|---|---|
| 使用者層 | `~/.claude/CLAUDE.md` (managed 模式是 `<stateDir>/claude-config/CLAUDE.md`) | 否 (所有角色, 含 owner) | 主機上的人 | 這台機器使用者自己的 Claude Code 用; 分身不載入, 要給所有分身的規則寫在 `<home>/CLAUDE.md` |
| 全域 | `<home>/CLAUDE.md` | 是 | owner | 所有 bot, 所有對話的共用規則. 分三層, 定義下層能不能覆寫 |
| bot 層 | `<home>/bot<id>/CLAUDE.md` | 是 | owner, admin | 這隻 bot 的人設 (初次設定訪談產生) |
| bot 層記憶 | `<home>/bot<id>/memory/` | 否 | owner, admin (power, user, guest 唯讀) | 這隻 bot 所有對話共用的記憶. 在 bot 層 `CLAUDE.md` 用一般文字寫「需要時讀 memory/xxx.md」, 分身需要時用 Read 讀 |
| 對話層 | `<home>/bot<id>/<對話>/CLAUDE.md` | 是 | 這個對話的分身 (所有角色), owner | 這個對話的客製規則 |
| 對話層記憶 | `<home>/bot<id>/<對話>/memory/` | `MEMORY.md` 是 | 這個對話的分身 (所有角色), owner | Claude Code 的自動記憶. 分身自己會寫, `MEMORY.md` 是索引, 每個 session 開始時自動載入 |

bot 層記憶不分對話, guest 也讀得到; 只該給特定對話 (例如 owner 私訊) 的內容, 放那個對話的 `memory/`.

### `<home>/CLAUDE.md` 的三層

| 區段 | 下層能不能覆寫 |
|---|---|
| FORCED RULES | 任何情況都適用, 各對話不可覆寫 |
| GENERAL RULES | 只有 power 以上的對話能在自己資料夾的 `CLAUDE.md` 覆寫 |
| Default suggestions | 使用者要求就能覆寫 |

這是寫給分身看的約定, 真正的權限限制在 router 產生的 settings (dontAsk, sandbox, 白名單) 與 router 的 hook ([權限, 提權與審核](permissions.md)).

### 讀寫權限 (依角色)

| | owner | admin | power | user | guest |
|---|---|---|---|---|---|
| 對話層 `CLAUDE.md`, `memory/` | 讀寫 | 讀寫 | 讀寫 | 讀寫 | 讀寫 (對話資料夾的其他檔案只能讀 `attachments/`) |
| bot 層 `CLAUDE.md`, `memory/` | 讀寫 | 讀寫 | 唯讀 | 唯讀 | 唯讀 |
| `<home>/CLAUDE.md` | 讀寫 | 自動載入, 不能改 | 同左 | 同左 | 同左 |
| 其他對話的資料夾 | 讀寫 | 讀不到 | 讀不到 | 讀不到 | 讀不到 |

「自動載入」不經過權限檢查: 讀不到某個檔的角色, 「各層一覽」標為自動載入的 `CLAUDE.md` 與 `MEMORY.md` 照樣會在 session 開始時載入 (使用者層不在其中). 權限只管分身用工具 (Read, Edit, Write, Bash) 主動讀寫. 對話層的 `.chat/` 是 router 的狀態, 所有角色都不能改. admin 的定位幾乎等同 owner (只差不能把自己升為 owner), 所以能改 bot 層的 `CLAUDE.md` 與 `memory/`; 改動會套用到這隻 bot 的所有對話.

分身一律帶 `--setting-sources project,local` 啟動, 使用者層的 `~/.claude/settings.json` (個人 hooks, plugin, 環境變數, 權限) 不載入; 分身的設定全部來自 router 產生的 `<stateDir>/sessions/<對話>.json`.

## session

### 一個對話一個 session

- router.db 的 `conversations.session_id` 記著這個對話目前的 session. 第一次收到訊息時開新 session (`claude --bg`), 之後都用 `--resume <session_id>` 接續同一個.
- 分身被停掉 (例如輪替, daemon 結束, router 或主機重啟) 後, 下一則訊息再叫醒並接續; 對話內容不會因為停掉而遺失.
- `/router session rotate`: 閒置時停掉, 下一則訊息用新的程式與設定叫醒, 仍接續同一個 session. `/router session restart`: 立刻重新叫醒.
- 每次叫醒時比對 daemon 存下的啟動旗標, 不同就換掉 job 再接續 ([部署與維運](operations.md#背景-session-的-job-與-daemon)).
- context 快滿時依對話的 `autoCompactWindow` 自動壓縮, 壓縮後仍是同一個 session.

### session 存在哪裡

session 的資料由 Claude Code 存在它的設定目錄, 位置隨 channel 模式 ([managed-channel](managed-channel.md)) 而不同:

| 資料 | managed 模式 (預設) | legacy 模式 (2.32.0 以前, 或降級) |
|---|---|---|
| 對話紀錄 (`<session>.jsonl`, 同名資料夾的 `subagents/`, `tool-results/`) | `<stateDir>/claude-config/projects/<資料夾代號>/` | `~/.claude/projects/<資料夾代號>/` |
| job 狀態 | `<stateDir>/claude-config/jobs/` | `~/.claude/jobs/` |
| daemon 狀態與 log | `<stateDir>/claude-config/daemon*` | `~/.claude/daemon*` |
| session 名冊與 key (ListAgents, SendMessage 用) | 預設與使用者共用 `~/.claude/sessions/` (`managed.shareSessions`) | `~/.claude/sessions/` |
| 資料夾信任 | `<stateDir>/claude-config/.claude.json` | `~/.claude.json` |
| 登入憑證 | `~/.claude` (`CLAUDE_SECURESTORAGE_CONFIG_DIR`) | `~/.claude` |

所有 `CLAUDE.md` 與記憶都在 `<home>` 底下, 不在任何 Claude Code 設定目錄裡, 兩種模式讀的是同一份. 對話層記憶能放在對話資料夾, 是因為 router 從第一版起就在 `templates/base-settings.json` 設了 `"autoMemoryDirectory": "{{folder}}/memory"`; 沒設這個參數的 session (例如有人直接在那個資料夾開互動的 claude) 才會寫到設定目錄的 `projects/<代號>/memory/`, 分身不讀那裡.

### 從終端機看 session

- `cctr managed agents` / `managed attach <對話 key | chat_id | job id>`: 等同 `claude agents` / `claude attach`, 自動帶 router 的設定目錄.
- 直接用 `claude agents` 時, managed 模式要加 `CLAUDE_CONFIG_DIR=<stateDir>/claude-config`.
- 送訊息給分身: `cctr cli session send <對話> --from <名稱>`, 分身睡著也會叫醒 ([部署與維運](operations.md#從外部送訊息給-worker)). 名冊共用時, 醒著的分身也能用 ListAgents 與 SendMessage 找到.

## managed 模式的自動遷移

升級到 2.32.0 以後, router 預設改用 managed 模式 (bwrap 版), Claude Code 的設定目錄從 `~/.claude` 換成 `<stateDir>/claude-config`. router 第一次以 managed 模式啟動時 (專屬設定目錄還沒有 `migrated.json`), 會**自動**做以下的事, 一般升級不用手動處理:

1. **複製對話紀錄:** router.db 裡每個對話目前那個 session 的 `<session>.jsonl` 與同名資料夾 (`subagents/`, `tool-results/`), 從 `~/.claude/projects/<資料夾代號>/` 複製到 `<stateDir>/claude-config/projects/<資料夾代號>/`. 目的地已有就跳過, 原本的不刪, 分身醒來就能接續.
2. **寫入資料夾信任:** 在新的 `<stateDir>/claude-config/.claude.json` 寫入 `<home>` 的信任; 原本 `~/.claude.json` 裡對話資料夾個別的信任 (例如本身是 git repo 的對話資料夾) 照抄過去. 少了信任, 背景 session 會直接失敗 (`Workspace not trusted`).
3. **接受 bypass 警告:** 在新的 `settings.json` 寫入 `skipDangerousModePermissionPrompt`, 否則 `--bg` 會被擋.
4. **移除舊 job:** 原本 `~/.claude` 的 daemon 裡屬於 router 對話的 job (名稱是 `tg-<對話>`, 工作目錄是對話資料夾) 停掉並移除, 不碰其他 job.
5. **寫遷移紀錄:** `migrated.json` 記下時間, 複製了哪些 session, 移除了哪些 job, 之後不會再遷移.

`<home>` 的信任與第 3 項每次以 managed 模式啟動都會檢查並補上 (冪等); 對話資料夾個別的信任只在遷移時照抄一次. 不用搬的: 所有 `CLAUDE.md` 與記憶 (都在 `<home>`), router.db, config, 技能. 不會搬的: 已經輪替掉的舊 session 紀錄, 仍留在 `~/.claude/projects`.

想先確認再遷移: 停 router, 跑 `cctr managed migrate --dry-run` 看清單, 再不帶 `--dry-run` 執行, 然後啟動 router ([managed-channel](managed-channel.md#對話紀錄的遷移)). 退回 legacy (config 設 `"channelMode": "legacy"`) 時, 專屬設定目錄裡較新的 session 紀錄會複製回 `~/.claude/projects`, 只複製, 不刪.

## 從 OpenClaw 轉過來

OpenClaw 的 workspace 用一組固定檔名放人設, 規則與記憶. 轉到 cc-telegram-router 時, 依內容的適用範圍與隱私放到對應的層, 改寫成 Claude Code 讀得懂的指示, 不要整份原封複製:

| OpenClaw 檔案 | 內容 | 放到 | 注意 |
|---|---|---|---|
| `SOUL.md` | 個性, 價值觀, 說話風格 | `<home>/bot<id>/CLAUDE.md` | bot 層人設, 所有對話共用 |
| `IDENTITY.md` | 名字, 形象, emoji | `<home>/bot<id>/CLAUDE.md` | 跟 SOUL 合成一份人設 |
| `AGENTS.md` | 運作規則, 群組禮儀, 記憶用法 | 適用所有 bot 的寫進 `<home>/CLAUDE.md` 的 GENERAL 或 Default; 只屬於這隻 bot 的寫進 bot 層 `CLAUDE.md` | 跟 FORCED RULES 衝突的 (例如繞過權限, 讀憑證) 一律拿掉; OpenClaw 專屬的機制 (heartbeat, 自己的 memory 流程) 改寫或刪掉 |
| `USER.md` | 主人是誰, 偏好 | bot 層 `memory/`, 在 bot 層 `CLAUDE.md` 指過去 | 這隻 bot 的所有對話都讀得到 (含 guest), 不想公開的細節拿掉或改放 owner 私訊 |
| `MEMORY.md` | 長期記憶 | 視內容選 bot 層 `memory/` (所有對話都該知道的) 或 owner 私訊的 `memory/` (私人的) | 拆成主題檔, 再更新各自的 `MEMORY.md` 索引 |
| `memory/<日期>.md` | 每日紀錄 | 整理重點後, 依內容放到合適的層 (bot 層, owner 私訊, 或某個對話的 `memory/`), 原檔不必搬 | 流水帳不適合進 context |
| `TOOLS.md` | 這台機器的工具, 裝置, 路徑筆記 | 不含機密的放 bot 層 `memory/tools.md`, 在 bot 層 `CLAUDE.md` 指過去 | token, 密碼改用 `/router cred add` |
| `HEARTBEAT.md` | 定期自動執行的工作 | 先保留原檔, 等 router 的排程 (cron) 功能改版後再轉 | router 目前還沒有排程 |
| `BOOTSTRAP.md` | 首次啟動的訪談 | 不用搬 | router 有自己的初次設定訪談 (`<bootstrap>`) |
| `skills/` | 技能 | `<home>/bot<id>/.claude/skills/` | 有特權動作的走技能審核 ([憑證與技能](credentials-and-skills.md)) |
| 其他自訂 `.md` | 專題資料 | 所有對話都用得上的放 bot 層 `memory/`; 私人的放 owner 私訊的 `memory/` | 判斷標準: guest 看到會不會有問題 |

判斷放哪一層的原則: 所有 bot 都要遵守的放全域, 這隻 bot 的個性與通用知識放 bot 層, 私人或只屬於某個對話的放那個對話的 `memory/`. 訊息紀錄可以用 `import-v1` 匯入 ([架構](architecture.md#訊息紀錄)).

## 驗證

這份文件說的事由下列測試對照 (改文件或改測試時兩邊一起看):

| 文件的哪一節 | 測試 |
|---|---|
| 讀寫權限 (依角色): 對話層 `CLAUDE.md` 與 `memory/` 所有角色讀寫, guest 的其他檔只讀 `attachments/`, `.chat/` 不能改, guest 沒有 Bash | `router/test/phase3.test.ts`「five role templates: …」「guest: its own CLAUDE.md and memory/ …」; `router/test/phase1.test.ts`「user settings …」 |
| 讀寫權限: bot 層 `CLAUDE.md` 與 `memory/` admin 讀寫 (含 Bash 的 sandbox), power, user, guest 唯讀; bot 的 `.claude/skills` 唯讀, 其他對話讀不到 | `router/test/phase3.test.ts`「bot memory and the bot's CLAUDE.md: …」 |
| 讀寫權限: `..` 與 symlink 跳不出允許範圍 | `router/test/phase3.test.ts`「permcheck follows symlinks: …」, 「bot memory and the bot's CLAUDE.md: …」(`memory/../.claude/skills`), 「guest: …」(`memory/../.chat`) |
| 讀寫權限, 用真的 Claude Code 執行 (`LIVE=1`) | `router/test/role-live.test.ts`「guest: writes its own CLAUDE.md and memory/ …」「admin: writes the bot's CLAUDE.md with Write and Bash …」「bot memory: … Write there works for admin only」「bot memory: … admin writes it (sandbox allowWrite)」 |
| 本文件的讀寫權限表與角色範本一致 | `router/test/phase3.test.ts`「docs/session-and-memory.md: …」 |
| 對話層記憶在對話資料夾 (`autoMemoryDirectory`), 兩種模式讀同一份 | `router/test/managed.test.ts`「the workers' auto memory lives in the conversation folder …」 |
| 分身一律帶 `--setting-sources project,local` | `router/test/jobs.test.ts` (啟動旗標), `router/test/e2e-jobs.test.ts` |
| 自動繼承上層的 `CLAUDE.md`, 各層一覽: 使用者層不載入 (兩種模式, 所有角色), 對話資料夾往上的各層會載入 | `router/test/managed.test.ts`「the user layer's CLAUDE.md is not loaded: …」(用真的 claude 跑 `/context`, 不呼叫模型, 隔離的 HOME 與設定目錄; 沒裝 claude 時略過) |
| session 接續與旗標比對 | `router/test/jobs.test.ts`, `router/test/e2e-jobs.test.ts`, `router/test/e2e-wake.test.ts` |
| session 存在哪裡, 共用名冊 | `router/test/managed.test.ts`「launcher: …」「bwrap options: …」「config managed.shareSessions: …」; `router/test/e2e-managed.test.ts`「a message: …」 |
| 從終端機看 session | `router/test/managed.test.ts`「managed attach target: …」「managed agents\|attach: …」; `router/test/e2e-managed.test.ts`「managed agents and attach from the terminal: …」 |
| managed 模式的自動遷移 (複製, 信任, bypass, 舊 job, `migrated.json`, dry-run, 退回 legacy) | `router/test/managed.test.ts`「migration: …」「copy back …」「managed migrate: …」「config folder: …」; `router/test/e2e-managed.test.ts`「managed start: …」 |
