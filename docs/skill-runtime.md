# 執行環境規格

特權技能的動作 (privileged.json, 見[技能與憑證](credentials-and-skills.md#特權技能)) 在什麼環境執行: 看得到哪些路徑, 拿到哪些環境變數, 連得到哪裡, 結果怎麼回到對話. 寫技能的人照這份寫就會動; worker 那邊的寫法說明在 `/telegram:bot-skill`. [README](../README.md) 的文件索引列出所有文件.

同一套環境用在所有特權執行: 對話的 `run_skill`, owner 終端機的 `cli skill run`, 每日與終端機的憑證更新 (refresh), 試跑 `skill_try`. 像手機 App 的隔離: 沙箱只看得到列出來的東西, 沒列的一律不存在.

## 掛載路徑

沙箱的根目錄是 bwrap 自己建的空 tmpfs (`router/sandboxfs.ts`), 上面只有:

| 路徑 | 權限 | 內容 |
|---|---|---|
| `/usr` | 唯讀 | 主機的系統程式與函式庫 (bash, curl, python3, git, ssh, zoneinfo, locale, `/usr/local/bin` 的工具) |
| `/bin`, `/sbin`, `/lib`, `/lib64`, `/lib32`, `/libx32` | 唯讀 | 主機是 merged-usr (這幾個是指向 `usr/` 的連結) 就照樣建連結, 否則唯讀掛上那個資料夾; 動態連結器在這裡 |
| `/etc` 的少數檔 | 唯讀 | `ld.so.cache`, `ld.so.conf(.d)`, `ssl/certs`, `ssl/openssl.cnf`, `ca-certificates`, `pki/tls/certs`, `pki/ca-trust`, `alternatives`, `nsswitch.conf`, `host.conf`, `gai.conf`, `protocols`, `services`, `networks`, `mime.types`, `magic`, `magic.mime`, `python3*`, `os-release`, `lsb-release`, `debian_version`, `locale.alias`; 主機沒有的略過. 沒有 `ssl/private`, `shadow`, `sudoers`, `hostname`, `machine-id` 這類檔 |
| `/etc/passwd`, `/etc/group`, `/etc/hosts` | 唯讀 | router 產生的 (`<stateDir>/sandbox-etc/`): 只有 root, 沙箱自己的使用者 (router 的 uid, 家目錄 `/tmp`) 與 nobody; hosts 只有 localhost. ssh 這類程式需要 passwd 裡有自己 |
| `/etc/resolv.conf` | 唯讀 | `nameserver 10.0.2.3` (見[網路](#網路)) |
| `/proc`, `/dev` | | 沙箱自己的 (獨立的 pid 空間) |
| `/tmp`, `/var/tmp`, `/dev/shm` | 可寫 | 沙箱私有的空 tmpfs, 每次執行都是空的, 跑完就消失 |
| 技能資料夾 | 唯讀 | 真實路徑 (例如 `<home>/bot<id>/.claude/skills/<技能>`); `run` 裡的 `scripts/x.sh` 換成這裡的絕對路徑 |
| `/cctr/creds/<環境變數>` | 唯讀 (只有 router 執行的 internal 動作可寫) | 動作 `creds` 宣告的憑證資料夾, 實際在 `<stateDir>/creds/<名稱>`; 腳本只看到 `/cctr` 路徑 |
| `/cctr/tools/bin` | 唯讀 | [工具箱](#工具箱) (ffmpeg, ffprobe, deno, uv), 實際在 `<stateDir>/toolbox/bin` |
| `/cctr/env` | 唯讀 | 技能的 [Python 環境](#python-套件-uv) (有 `pyproject.toml` 與 `uv.lock` 時), 實際在 `<stateDir>/skill-env/<key>` |
| `/cctr/python` | 唯讀 | Python 環境用的 uv 自己的 Python, 實際在 `<stateDir>/toolbox/python` |
| `/cctr/store/<環境變數>` | 可寫 | 動作 `store` 宣告的資料庫, 這次執行的工作副本 (見[資料庫 store](credentials-and-skills.md#資料庫-store)) |
| 對話資料夾 | 可寫 (`.chat` 唯讀) | 真實路徑, 讓對話的 worker 找得到輸出檔; 試跑時是 `<對話資料夾>/skill-try/<時間>-<動作>/`, 終端機時是 `--out` |
| config `sandboxExtraRo` 的路徑 | 唯讀 | owner 自己加的 (預設沒有), 結尾是 `/bin` 的放進 PATH |
| internal 動作的 `host.mounts` | 唯讀 | 見[主機存取 host](#主機存取-host) |

其他全部不存在: router 使用者的家目錄 (`~/.local` 裝的套件與工具也用不到), `/home`, `/root`, `/opt`, `/var` (除了 `/var/tmp`), `/run`, `/sys`, `/x` 這類資料夾, router 的家目錄 (其他對話), router 的 stateDir, 其他技能. 掛進來的路徑 (`/usr`, `sandboxExtraRo`, `host.mounts`) 裡如果有 router 的隱藏清單 (config `sandboxDenyRead`, router 的家目錄與 stateDir, 放在別處的 router socket), 資料夾蓋上空的 tmpfs, 檔案蓋上 `/dev/null`.

## 環境變數

沙箱裡的環境只有這些 (router 自己的環境變數不帶進去):

| 名稱 | 值 |
|---|---|
| `PATH` | `/cctr/env/bin` (有 Python 環境時), `/cctr/tools/bin` (有工具箱時), `sandboxExtraRo` 裡結尾是 `/bin` 的路徑, 然後 `/usr/local/bin:/usr/bin:/bin` |
| `VIRTUAL_ENV` | 有 Python 環境時: `/cctr/env` |
| `HOME`, `TMPDIR` | `/tmp` |
| `LANG` | `C.UTF-8` |
| `<creds 的環境變數>` | `/cctr/creds/<環境變數>` |
| `<store 的環境變數>` | `/cctr/store/<環境變數>` |
| `<http 的環境變數>_URL`, `_HEADER` | http 憑證的 base URL (結尾沒有 `/`) 與整行授權標頭 |
| `<bots 的環境變數>_API` | `<apiRoot>/bot<token>` (apiRoot: 試跑的固定值, 憑證自己的, config 的, 官方的, 取第一個有的); apiRoot 在主機本機時換成 `http://10.0.2.2:<埠>/...` (slirp 的主機別名, 只放行那個 port; 服務要聽在 127.0.0.1) |
| `CCTR_HOST` | 只有宣告了 `host.ports` 的 internal 動作: `10.0.2.2` (主機, 見[主機存取 host](#主機存取-host)) |
| internal 動作的 `host.env` | 照宣告 |

技能自己宣告的環境變數名稱不能是 `PATH`, `HOME`, `LANG`, `TMPDIR`, `TZ`, `CCTR_HOST`, `VIRTUAL_ENV`, 也不能互相重複.

## 工具箱

router 安裝時 (`deploy/install.sh router` 執行 `cc-telegram-router toolbox install --state <stateDir>`) 下載固定版本的工具, 每個檔案先核對 sha256 才解開 (只取指定的那個檔), 放在 `<stateDir>/toolbox/bin`, `installed.json` 記版本與檔案的 sha256 (`router/toolbox.ts`). 每個沙箱都唯讀掛在 `/cctr/tools/bin`, 排在 PATH 最前面 (在系統的同名程式之前):

| 工具 | 版本 | 來源 (GitHub release 固定 tag 的檔案) |
|---|---|---|
| ffmpeg, ffprobe | 7.0.2 (靜態版) | `eugeneware/ffmpeg-static` 的 `b6.1.1` (johnvansickle 的靜態版; 他自己的網址會換, BtbN 的 autobuild 會被刪) |
| deno | 2.9.7 | `denoland/deno` 的 `v2.9.7` |
| uv | 0.12.22 | `astral-sh/uv` 的 `0.12.22` |

- x86_64 與 aarch64 各有一份. 同版本再裝一次照舊保留 (檔案與記錄的 sha256 相同時); 有檔案不見就重裝.
- 某個工具下載失敗或 sha256 不符: 只有它沒裝 (舊版照舊), 其他照裝, `toolbox install` 結束碼 1, `install.sh` 只印警告, router 照常運作. 之後再跑 `cc-telegram-router toolbox install --state <stateDir>` 補裝; `toolbox status` 列出現況. `--mirror <資料夾或網址>` 從鏡像拿同名的檔案 (照樣核對 sha256).
- 動作宣告 `"tools": ["ffmpeg", "deno"]` (只能是工具箱裡的名稱, 算在核准雜湊裡): 宣告的工具沒裝時拒絕執行, 回傳 `exit -1` 與 `工具箱缺少這個動作需要的 <工具>, 沒有執行 (... cc-telegram-router toolbox install)`. 沒宣告的工具裝了也照樣在 PATH 上.
- 解開 zip 用 `python3`, tgz 用 `tar` (router 的必要條件), 主機本身不需要裝 ffmpeg, deno, uv.

## Python 套件 (uv)

技能資料夾放 `pyproject.toml` 與 `uv.lock` (用 `uv lock` 產生, 版本鎖死; git 來源鎖在完整的 commit; 可以加 `.python-version`) 就有自己的 Python 環境 (`router/skillenv.ts`). 只有其中一個檔時 privileged.json 照讀, 但核准與執行都拒絕. 這兩個檔 (和 `.python-version`) 算在核准雜湊裡, 改了技能就暫停; `.venv` 不算, `install_skill` 也不複製.

- **誰建, 在哪裡建**: router 建, 技能自己不建. 位置 `<stateDir>/skill-env/<key>/`, key 是 lock, pyproject, `.python-version`, uv 版本與 CPU 架構的雜湊, 同一份 lock 的技能共用. 建置在兩個白名單沙箱裡, 都在獨立網路 (外網 80, 443, 53, 22): (1) 只跑 uv 自己, 下載專案要的 Python (uv 自己的 python-build-standalone, uv 內建 sha256 核對) 到 `<stateDir>/toolbox/python`, 這是唯一可以寫那裡的時候; (2) `uv sync --locked --no-install-project --no-dev`, 套件的 build 會執行程式, 所以這時 Python 唯讀, uv 快取是這次自己的 (用完丟掉), 目標掛在執行時同一個路徑 `/cctr/env` (環境裡的指令與連結才對得上). 沙箱裡沒有 `/etc/uv` 也沒有使用者設定, uv 只讀專案自己的 `[tool.uv]` (index, git 來源). 失敗就什麼都不留.
- **執行時**: 唯讀掛在 `/cctr/env`, Python 在 `/cctr/python`, `PATH` 最前面是 `/cctr/env/bin`, 所以 `run` 寫 `"python3"` 就是環境裡的 Python, 不是系統的. 系統的 `/usr/bin/python3` 照樣在 (沒有 lock 的技能用它).
- **何時建**: `/router skill approve` (建好才記核准, 見[核准](#核准)); 執行時環境不見了 (stateDir 清過, 換了 uv 版本) 用同一份 lock 自動重建一次, 不重新審核, 建不起來就回 `exit -1` 與 `技能的 Python 環境建不起來, 沒有執行: ...`; `skill_try` 試跑草稿時另外建 (`skill-env/try-<key>`, 不跟已核准的技能共用). 沒有任何已核准技能用到, 而且 30 天沒用的環境, router 啟動兩分鐘後與之後每天清掉.
- **套件審核**: `uv.lock` 的每個套件 (含間接依賴, 專案本身除外) 分兩類: registry 是 `https://pypi.org/simple` 的交給套件審核的同一個模型與同一份 7 天快取 ([套件安裝審核](permissions.md#套件安裝審核)) 判斷風險; git, URL, 本機路徑與其他 index 是自訂來源, 一律人工審核. git 來源沒有鎖在完整 commit 的 lock 一律拒絕.
- `skill_try` 只建全部是 PyPI 而且都判定 low 的環境; 有自訂來源或其他風險的草稿拒絕試跑並列出原因, 等核准時由人看.

## 工作目錄

工作目錄是對話資料夾 (試跑與終端機見上表), 也是沙箱裡除了 `/tmp` 與資料庫副本以外唯一寫得到的地方. 輸出檔寫相對路徑即可. 不要從工作目錄載入程式或套件: 那裡對話自己寫得到.

## 網路

每次執行都有自己的網路空間 (`router/sandboxnet.ts`), 規則由 router 從沙箱外設定, 沙箱裡的程序沒有權限改:

- **外網**: 對話呼叫的動作 (`run_skill`, 終端機 `cli skill run`) 與所有試跑, tcp 與 udp 只開 port 80, 443, 53, 22, 其他 port 擋下; 動作可以宣告 `outbound_ports` 多開 (見[對外 port](#對外-port-outbound_ports)). router 自己執行的 internal 動作 (每日與終端機的憑證更新, 憑證被拒後的更新) 外網不限 port.
- **一律擋下**: 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8 (主機本機的服務, 例如瀏覽器的 CDP, ssh 轉發的 port), 169.254.0.0/16 (含雲端 metadata 169.254.169.254), 172.16.0.0/12 (docker 與主機所在內網), 192.168.0.0/16, 224.0.0.0/3, IPv6 的 `::`, `::1`, `::ffff:0:0/96`, `fc00::/7`, `fe80::/10`, `ff00::/8`, 以及主機自己的位址 (網卡上的全部位址, 加上 router 第一次需要時向雲端 metadata 查一次的 public IPv4). 擋網段的規則排在開 port 的規則前面, 所以 `outbound_ports` 開不了這些位址. 主機只有兩種例外: internal 動作 `host.ports` 宣告的 port, 以及 bot 憑證用的 Bot API 在主機本機時 (憑證自己的 `apiRoot`, 沒有就是 config 的 `apiRoot`, 是 `http://127.0.0.1:<埠>`, `localhost` 或 `[::1]`, 例如自架的 Bot API server; 終端機試跑的 `--api` 也是) 宣告了 `bots` 的動作連得到那一個 port (每個憑證各自的) (見[環境變數](#環境變數)).
- **沙箱自己的 loopback** (127.0.0.1) 照常可用, 跟主機的 127.0.0.1 無關 (試跑的假服務在這裡).
- **DNS**: `/etc/resolv.conf` 是 `nameserver 10.0.2.3` (slirp 內建的 DNS, 由主機端的 slirp 轉送), 不靠主機的 127.0.0.53. IPv6 外網目前不通 (slirp 沒開 IPv6), 只有 IPv4.
- **unix socket**: 網路空間擋不到檔案系統上的 unix socket, 而 connect 不需要寫入權限. 白名單檔案系統裡本來就沒有 `/run` 與任何 socket 檔, 另外 seccomp 規則 (`bwrap --seccomp`, 由 router 產生, x86_64 與 aarch64) 讓建立 AF_UNIX socket 的 `socket(2)` 失敗 (EPERM), 所以不論 socket 檔在哪個路徑都連不上; `socketpair(2)` 照常, TCP 與 UDP 照常; 也擋 `io_uring_setup` (io_uring 可以不經 `socket(2)` 建 socket), 與 32 位元, x32 的系統呼叫. 其他 CPU 架構做不出這條規則時拒絕執行. abstract socket 跟著網路空間隔開. 例外: 宣告了 `host.mounts` 的 internal 動作可以建 unix socket, 但只看得到它宣告掛進來的 socket 檔.
- **怎麼做的**: bwrap 加 `--unshare-net` 建獨立的網路空間, 用 `--info-fd` 回報沙箱的 pid, 用 `--block-fd` 讓動作先等著. router 從外面: (1) 對沙箱的網路空間下 `ioctl(NS_GET_USERNS)` 找到擁有它的 user namespace (沒有特權的 bwrap 為了掛 devpts 會先把使用者映射成 root, 之後再把沙箱移進巢狀的一層, 所以 `/proc/<pid>/ns/user` 會中途改變; 擁有網路空間的那層不會變, 而且在那層裡是 root); (2) `nsenter` 進那兩個空間載入 nft 規則; (3) 以路徑把那兩個空間交給 `slirp4netns --configure` (`--userns-path`, `--netns-type=path`; 只給 pid 時它會跟進巢狀那層而失敗), 給沙箱一張接得到外網的 tap0 (位址 10.0.2.100, 路由經 10.0.2.2); 沒有 `host.ports` 時加 `--disable-host-loopback`, 10.0.2.2 不會轉到主機; (4) slirp 回報就緒後才放動作執行. 跑完收掉 slirp. 每次執行的檔案 (resolv.conf, 規則, seccomp 程式) 放在 `<stateDir>/sandbox-run/run-*/`, 跑完刪掉, router 啟動時清掉上次留下的.
- 需要 `slirp4netns`, `nft`, `nsenter` 與 unprivileged user namespace (見 README 的 Requirements). 任何一項缺少或設定失敗 (套不上規則, slirp 沒有就緒) 時拒絕執行並說明 (回傳 `exit -1`, `沙箱的網路隔離失敗, 沒有執行: ...` 或 `這台主機缺少沙箱網路隔離需要的工具`), 不會改成不隔離, 也不會改成完全不能連網.

## 主機存取 host

只給 internal 動作 (router 自己執行, 對話不能呼叫), 例如憑證更新要修復通往瀏覽器的通道. 宣告在 privileged.json 的動作裡:

```json
"refresh-cookies": {
  "run": ["bash", "scripts/refresh.sh", "{cred:COOKIES}"],
  "internal": true,
  "creds": { "COOKIES": "example-cookies" },
  "host": {
    "ports": [9222, 2222],
    "mounts": ["/tmp/agent.sock", "~/.ssh/known_hosts"],
    "env": { "SSH_AUTH_SOCK": "/tmp/agent.sock" }
  }
}
```

- `ports`: 主機的 TCP port (1~65535), 經 `$CCTR_HOST` (10.0.2.2, slirp 把它轉到主機的 127.0.0.1) 連, 例如 `http://$CCTR_HOST:9222`, `ssh -p 2222 user@$CCTR_HOST`. 沙箱裡的 127.0.0.1 是沙箱自己. ssh 要沿用 `known_hosts` 裡 `[localhost]:2222` 的紀錄時加 `-o HostKeyAlias=[localhost]:2222`. 沒宣告的主機 port, 主機的其他位址與內網照樣連不到; 外網不限 port (internal 動作).
- `mounts`: 主機上唯讀可見的路徑, 絕對路徑或 `~/` 開頭 (router 使用者的家目錄), 不能是 `/` 或含 `..`; 有 `mounts` 時這個動作可以建 unix socket (例如連 ssh agent), 但沙箱裡只有宣告的 socket 檔.
- `env`: 額外的環境變數.
- 舊寫法: internal 動作頂層的 `mounts` 與 `env` 照 `host.mounts`, `host.env` 讀 (`skill_check` 提醒改寫); 寫在其他動作上沒有作用. `host` 寫在非 internal 動作上, privileged.json 讀取失敗, 核准會拒絕.
- 試跑 (`skill_try`) 一律不給主機存取.

## 對外 port outbound_ports

非 internal 動作預設只連得到外網的 80, 443, 53, 22. 要別的 port 時宣告 `"outbound_ports": [8443]` (1~65535 的整數陣列, 不重複, tcp 與 udp 都開). 只加開外網的 port, 主機與內網照樣擋下. internal 動作外網本來就不限 port, 寫了 privileged.json 讀取失敗. 試跑照宣告放行.

## 核准

`/router skill approve <技能>` (`router/skillapprove.ts`) 列出每個動作的內容 (`describeActions`). 有 `host` 或 `outbound_ports` 的技能**只有 owner 能核准**: admin 下指令會被拒, 回覆寫明原因 (哪個動作宣告了什麼) 並列出動作清單.

沒有要再看一眼的東西時一步核准 (跟以前一樣). 有的話先回**確認畫面**: 每一項以 ⚠️ 開頭 (主機存取, 額外的對外 port, 不是 low 或沒有審核結果的 PyPI 套件, 每個自訂來源的套件), 接著是動作清單與 uv.lock 的全部套件 (含模型的判斷), 最後一行 `確認核准: /router skill approve <技能> <確認碼>`. 確認碼是技能雜湊的前 8 碼, 畫面之後檔案被改過, 或打錯, 就回 `確認碼 ... 不符` 要重看畫面. 自訂來源與有風險的套件 owner 或 admin 都能確認, 主機存取與額外的對外 port 只有 owner.

有 `pyproject.toml` 與 `uv.lock` 的技能, 確認後 router 先回 `核准中: 正在建技能 <技能> 的 Python 環境 ...`, 建好才記下核准, 再發一則結果 (`已核准技能 ...`; 或 `沒有核准: Python 環境建不起來: ...`, `建環境的時候檔案被改過了`); 在 owner 的終端機 (`cli`) 下的指令會等到結果一起回. 結果出來前技能還不能用.

核准畫面以 `⚠️ 主機存取 (只有 owner 能核准): 連得到主機本機的 port ... (經 $CCTR_HOST), 可讀 ... (可以連 unix socket), 環境變數 ...; 主機其他 port 與內網照樣連不到` 與 `⚠️ 額外的對外 port ... (只有 owner 能核准)` 標出.

## exit code 與輸出

- exit 0 是成功, 其他是失敗 (資料庫不寫回). `exit -1` 是 router 沒有執行 (參數, 憑證, 網路隔離等原因, 後面接說明).
- 對話收到 `exit <碼>` 開頭, 加上 router 的註記 (憑證更新, 遮蔽, 資料庫寫回), 再加輸出 (stdout 與 stderr) 的最後 60 行 (最多 6000 字).
- 輸出會掃描憑證: 回傳文字裡出現的憑證內容 (cookie 值, http key, bot token) 遮蔽成 `<已遮蔽>`; 這次執行在對話資料夾寫出的文字檔含有憑證內容, 或檔名像 cookie 檔, 就刪除; 兩種都會通知 owner.

## 驗證

- `router/test/whitelist.test.ts` (10 項, 1 項要 `LIVE=1`; 真的 bwrap, slirp4netns, nft, 經 `run_skill` 與 refresh 的同一條路): [掛載路徑](#掛載路徑) (看不到與看得到的路徑, `/cctr/creds`, 工作目錄, 環境變數不含 stateDir 的路徑, passwd), [網路](#網路) (對話呼叫的動作只開 80, 443, 53, 22; 主機, 主機位址, metadata, 內網連不到; 不能建 unix socket), [對外 port](#對外-port-outbound_ports), 主機本機的 Bot API (有 `bots` 的動作經 10.0.2.2 只連得到那個 port, 沒有 `bots` 的連不到), [主機存取 host](#主機存取-host) (宣告的主機 port 經 `$CCTR_HOST` 連得到, 沒宣告的連不到, 外網不限 port, 只看得到宣告的 socket), privileged.json 的檢查與舊寫法, [核准](#核准) (只有 owner), `skill_check` 的提醒, nft 規則順序與 seccomp 程式; `LIVE=1` 實際連外網.
- `router/test/toolbox.test.ts` (6 項, 1 項要 `LIVE=1`): [工具箱](#工具箱)的安裝 (gz, zip, tgz, 只取指定的檔, sha256 不符只影響那個工具, 同版本保留, 檔案不見重裝, 不支援的 CPU, 網址鎖像), `toolbox status` 與指令用法, 真正的工具表 (x64 與 arm64, 固定 tag 的 GitHub release, sha256), `install.sh` 只警告; 沙箱裡 `/cctr/tools/bin` 排在 PATH 最前面, 缺工具時拒絕並說明, `tools` 只能寫工具箱的名稱; `LIVE=1` 下載真的工具並在沙箱裡執行.
- `router/test/skillenv.test.ts` (7 項, 3 項要 uv, 1 項另外要 `LIVE=1`; uv 用 `CCTR_TEST_UV` 指定或在 PATH 上, 沒有就跳過): [Python 套件 (uv)](#python-套件-uv)的 lock 解析 (PyPI 與自訂來源, git 的 commit, 兩個檔要一起), 用主機上的假套件 index 在沙箱裡建環境 (`/cctr/env` 排在 PATH 最前面, 第二次不再下載, 同一份 lock 共用, lock 與 pyproject 不符時建置失敗且不留東西, 改 uv.lock 技能暫停), [核准](#核准) (一步核准, 確認畫面與確認碼, 錯的確認碼, 先建好再核准, 建不起來不核准, 主機存取只限 owner, 套件清單與模型判斷, 沒有審核時 PyPI 也要人看), 指令把確認碼帶進去且 Telegram 另外收到結果, 終端機等結果, `skill_try` 拒絕自訂來源與不是 low 的套件; `LIVE=1` 用真的 PyPI 與 uv 自己的 Python 建環境.
- `router/test/skilltry.test.ts`: 網路的擋下與 unix socket (經試跑的同一個模組), 試跑的 port 與主機存取.
- `router/test/portability.test.ts`: bwrap 的白名單參數, 隱藏清單只在掛進來的路徑裡蓋上, config `sandboxExtraRo`.
- `router/test/e2e-compiled.test.ts`: 編譯版 router 照 systemd unit 啟動, 已核准技能的 `run_skill` 在白名單與獨立網路裡執行, 有 `bots` 的動作連得到主機本機的 Bot API; `toolbox status` 與 `toolbox install` 不需要 config.json (下載失敗結束碼 1), run_skill 用到 stateDir 的工具箱, 缺工具時拒絕; `LIVE=1` 而且有 uv 時從真的 PyPI lock 建環境並執行.
- `router/test/phase3-privskill.test.ts`: 沙箱的環境變數與 `/cctr` 路徑.
