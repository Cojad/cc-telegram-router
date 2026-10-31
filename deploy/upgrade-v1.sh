#!/bin/bash
# 從 v1 (官方 telegram plugin 的 fork, 單一 session, deploy/switch.sh fork) 升級到 v2 router.
# README「從 v1 升級」與 docs/operations.md「從 v1 升級」說明整個流程. 測試: router/test/upgradev1.test.ts.
#
# 由一個全新的 Claude Code session 執行: 在終端機開一個不帶 --channels 的普通 claude, 讓它讀
# README「從 v1 升級」. 不要在 v1 的 Telegram session (以 --channels plugin:telegram@claude-plugins-official
# 啟動的) 裡執行: 腳本一開始就會偵測到並停下 (結束碼 3), 不做任何事.
#
# 流程:
#   1. 先 dry run: deploy/upgrade-v1.sh --dry-run [參數]
#      什麼都不寫, 不裝, 不啟動, 不動 v1, 只檢查並印出報告:
#        (a) 可以從 v1 帶入的值與來源 (token 只寫「有, bot id」, 絕不印值)
#        (b) 用預設值的項目與預設值
#        (c) 要問使用者的問題, 每題寫明用哪個參數回答
#        (d) 要先處理的問題 (錯誤, 或要人操作的事), 每項附原因, 路徑與修法
#      結尾是「還剩幾題沒答」與「補上後重跑的完整指令」.
#   2. 照報告問使用者, 把答案加成參數, 再跑 dry run, 直到沒有未答的問題.
#   3. dry run 全部通過時會印出正式執行的指令 (同樣的參數, 去掉 --dry-run). 正式執行一開始做同樣的檢查,
#      只要還有沒答的題目或要先處理的問題, 就印出報告並停下, 不做任何寫入.
#   正式執行可以重複: 已完成的步驟會跳過, 從中斷處續跑.
#
# 參數 (答案都用參數給, 重跑時原樣帶上):
#   --dry-run            只檢查, 印報告
#   --owner <uid>        v2 router 的 owner (最高權限) 的 Telegram uid. 或用 --claim: 不指定, router 啟動後認領
#   --home <dir>         router 的家目錄 (預設 ~/cc, 不能是 ~ 本身). 狀態目錄是 <home>/.router
#   --bot-name <名稱>    v2 裡這隻 bot 的名稱 (預設 cc; 英數, - 與 _)
#   --keep-access        沿用 v1 的 access.json (允許清單, 群組, mention 規則; 待配對的碼不沿用)
#   --no-access          不沿用, v2 從預設的配對模式開始
#   --skip-linger        linger 沒開也繼續 (router 會在使用者登出後停止)
#   --api-root <url>     Bot API server (預設官方 https://api.telegram.org; 自架的 telegram-bot-api 才要改)
#   --v1-state <dir>     v1 的狀態目錄 (預設 $TELEGRAM_STATE_DIR, 否則 ~/.claude/channels/telegram)
#
# 結束碼 (dry run 與正式執行相同):
#   0  dry run: 全部通過, 可以正式執行 / 正式執行: 升級完成
#   1  有要先修的錯誤 (報告的「要先處理」寫了原因與修法); 沒有做任何寫入 (正式執行中途失敗時, 已完成的步驟保留)
#   2  參數錯誤
#   3  還有題目沒答, 或要人操作 (關掉 v1 session, 開 linger, 認領 owner); 正式執行在寫入前停下
#
# 不印任何 token 值. 只讀 v1 的檔案, 不改不刪 (dry run 讀 messages.db 時用暫存資料夾裡的複本, 讀完刪除).

set -euo pipefail
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

ARGS=("$@")
DRY=0 OWNER="" CLAIM=0 HOME_DIR="" HOME_SET=0 BOT_NAME="cc" BOT_SET=0 ACCESS="" SKIP_LINGER=0 API_ROOT="" V1_STATE="" V1_SET=0
usage() { sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
need() { [ -n "${2:-}" ] && [ "${2#--}" = "$2" ] || { echo "$1 後面要接值" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --owner) need "$1" "${2:-}"; OWNER="$2"; shift 2 ;;
    --claim) CLAIM=1; shift ;;
    --home) need "$1" "${2:-}"; HOME_DIR="$2"; HOME_SET=1; shift 2 ;;
    --bot-name) need "$1" "${2:-}"; BOT_NAME="$2"; BOT_SET=1; shift 2 ;;
    --keep-access) [ "$ACCESS" = no ] && { echo "--keep-access 與 --no-access 只能選一個" >&2; exit 2; }; ACCESS=keep; shift ;;
    --no-access) [ "$ACCESS" = keep ] && { echo "--keep-access 與 --no-access 只能選一個" >&2; exit 2; }; ACCESS=no; shift ;;
    --skip-linger) SKIP_LINGER=1; shift ;;
    --api-root) need "$1" "${2:-}"; API_ROOT="${2%/}"; shift 2 ;;
    --v1-state) need "$1" "${2:-}"; V1_STATE="$2"; V1_SET=1; shift 2 ;;
    -h|--help) usage ;;
    *) echo "不認得的參數: $1" >&2; usage ;;
  esac
done
[ -n "$OWNER" ] && [ "$CLAIM" = 1 ] && { echo "--owner 與 --claim 只能選一個" >&2; exit 2; }
if [ -n "$OWNER" ] && ! [[ "$OWNER" =~ ^[0-9]{1,20}$ ]]; then echo "--owner 要是數字 uid, 收到: $OWNER" >&2; exit 2; fi
[[ "$BOT_NAME" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || { echo "--bot-name 只能用英數, - 與 _ (最多 32 字): $BOT_NAME" >&2; exit 2; }
if [ -n "$API_ROOT" ] && ! [[ "$API_ROOT" =~ ^https?://[^[:space:]]+$ ]]; then echo "--api-root 要是 http(s) 網址: $API_ROOT" >&2; exit 2; fi
case "${HOME_DIR:-/}" in /*) ;; *) echo "--home 要是絕對路徑: $HOME_DIR" >&2; exit 2 ;; esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$REPO/deploy/upgrade-v1.sh"
HOME_DIR="$(realpath -m "${HOME_DIR:-$HOME/cc}")"
STATE="$HOME_DIR/.router"
MARKS="$STATE/.v1-upgrade"
V1_STATE="${V1_STATE:-${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}}"
PLUGIN_CACHE="$HOME/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7"
UNIT_FILE="$HOME/.config/systemd/user/cc-telegram-router.service"
# where other processes are looked up (tests point it at a made-up tree); this script's own ancestors are always read from /proc
PROC_ROOT="${CCTR_V1UP_PROC_ROOT:-/proc}"
V1_CHANNEL="plugin:telegram@claude-plugins-official"

# ---------- 程序偵測 ----------
# 這個程序的命令列有 --channels plugin:telegram@claude-plugins-official 這兩個參數嗎 ($1: cmdline 檔)
has_v1_channel_args() {
  local prev="" a
  [ -r "$1" ] || return 1
  while IFS= read -r -d '' a; do
    [ "$prev" = --channels ] && [ "$a" = "$V1_CHANNEL" ] && return 0
    [ "$a" = "--channels=$V1_CHANNEL" ] && return 0
    prev="$a"
  done < "$1"
  return 1
}
in_router_home() { case "$1" in "$HOME_DIR"|"$HOME_DIR"/*) return 0 ;; esac; return 1; }
ppid_of() { awk '/^PPid:/{print $2}' "/proc/$1/status" 2>/dev/null || true; }
# 執行這支腳本的是不是 v1 的 Telegram session: 往上找祖先程序 (legacy 模式 router 的 worker 在 <home> 底下, 不算)
v1_ancestor() {
  local p
  p="$(ppid_of $$)"
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    if has_v1_channel_args "/proc/$p/cmdline" && ! in_router_home "$(readlink "/proc/$p/cwd" 2>/dev/null || true)"; then echo "$p"; return 0; fi
    p="$(ppid_of "$p")"
  done
  return 1
}
short_cmd() { local c; c="$(tr '\0' ' ' < "$1" 2>/dev/null || true)"; printf '%s' "${c:0:120}"; }
# 其他還在跑的 v1: 每行 "pid 說明"
v1_others() {
  local holder="" d pid cwd exe
  if [ -f "$V1_STATE/bot.pid" ]; then
    holder="$(tr -dc '0-9' < "$V1_STATE/bot.pid" 2>/dev/null || true)"
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      exe="$(basename "$(readlink "$PROC_ROOT/$holder/exe" 2>/dev/null || true)")"
      case "$exe" in bun*) echo "$holder v1 plugin 的 poller ($V1_STATE/bot.pid; 正在用 v1 的 token 收訊息): $(short_cmd "$PROC_ROOT/$holder/cmdline")" ;; *) holder="" ;; esac
    else holder=""; fi
  fi
  for d in "$PROC_ROOT"/[0-9]*; do
    [ -e "$d" ] || continue
    pid="${d##*/}"
    { [ "$pid" = "$$" ] || [ "$pid" = "$holder" ]; } && continue
    cwd="$(readlink "$d/cwd" 2>/dev/null || true)"
    if has_v1_channel_args "$d/cmdline" && ! in_router_home "$cwd"; then
      echo "$pid 以 --channels $V1_CHANNEL 啟動的 Claude Code session (cwd ${cwd:-?}): $(short_cmd "$d/cmdline")"
    elif [ "$cwd" = "$PLUGIN_CACHE" ] && tr '\0' ' ' < "$d/cmdline" 2>/dev/null | grep -q 'server\.ts'; then
      echo "$pid 跑在官方 plugin 快取裡的 v1 plugin (bun server.ts): $(short_cmd "$d/cmdline")"
    fi
  done
  return 0
}

# ---------- 0. 執行者不能是 v1 session (dry run 也一樣, 什麼都還沒做) ----------
if anc="$(v1_ancestor)"; then
  echo "cc-telegram-router v1 → v2 升級"
  echo
  echo "✋ 停下: 執行這支腳本的 Claude Code session 就是 v1 的 Telegram session (程序 $anc 以 --channels $V1_CHANNEL 啟動)."
  echo "   它的 plugin 正在用同一個 token 收訊息; 升級會換掉它的 plugin 快取, 而它還開著會跟 router 搶訊息 (409 衝突)."
  echo "   什麼都沒做. 請使用者:"
  echo "     1. 在這個 session 輸入 /exit 關掉它"
  echo "     2. 在終端機開一個不帶 --channels 的普通 claude, 請它讀 $REPO/README.md 的「從 v1 升級」並照做"
  echo "   以後不要再用 --channels $V1_CHANNEL 啟動: v2 的訊息由 router 收, 每個對話有自己的背景 session."
  echo
  echo "結果: 執行者是 v1 session, 沒有做任何事 (結束碼 3)."
  exit 3
fi

# ---------- 檢查 (dry run 與正式執行都先做, 不寫入) ----------
CARRY=() DEFAULTS=() QUESTIONS=() ISSUES=() HUMAN=() PLAN=() SUGGEST=()
q()     { QUESTIONS+=("$1"); SUGGEST+=("$2"); }    # q <問題與回答方式> <建議加的參數>
issue() { ISSUES+=("$1"); }                        # 要先修的錯誤 (原因與修法)
human() { HUMAN+=("$1"); }                         # 要人操作的事
TOKEN="" BOT_ID="" CFG_EXISTS=0 CFG_OWNERS="" CFG_BOT="" BUN_OK=0 ACC_SUMMARY="" ACC_UIDS="" CLAUDE_BIN=""

if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then issue "PATH 裡找不到 bun, 但 $HOME/.bun/bin/bun 存在. 修法: export PATH=\"\$HOME/.bun/bin:\$PATH\" 後重跑 (長期: 加進 ~/.bashrc)"
  else issue "找不到 bun. 修法: curl -fsSL https://bun.sh/install | bash (裝到 ~/.bun/bin, 不用 sudo), 再 export PATH=\"\$HOME/.bun/bin:\$PATH\" 後重跑"; fi
else
  BUN_V="$(bun --version 2>/dev/null || echo 0)"
  need_bun="$(sed -n 's/.*"bun": *">=\([0-9.]*\)".*/\1/p' "$REPO/package.json" | head -n 1)"; need_bun="${need_bun:-1.4.3}"
  if [ "$(printf '%s\n%s\n' "$need_bun" "$BUN_V" | sort -V | head -n 1)" != "$need_bun" ]; then issue "bun $BUN_V ($(command -v bun)) 太舊, 需要 >= $need_bun. 修法: bun upgrade 後重跑"
  else
    BUN_OK=1; CARRY+=("bun $BUN_V ($(command -v bun))")
    off="$(bun -e 'const { depsOutOfStep } = await import(process.argv[1]); process.stdout.write(String(depsOutOfStep(process.argv[2]).length))' "$REPO/deploy/preflight.ts" "$REPO" 2>/dev/null || echo "?")"
    [ "$off" = 0 ] && PLAN+=("會跳過: repo 的相依套件已跟 bun.lock 一致") || PLAN+=("會做: bun install --frozen-lockfile (相依套件跟 bun.lock 不一致: $off 個)")
  fi
fi
if command -v claude >/dev/null 2>&1; then
  CLAUDE_BIN="$(command -v claude)"; CLAUDE_V="$(claude --version 2>/dev/null | head -n 1 || true)"
  if [ -n "$CLAUDE_V" ]; then DEFAULTS+=("worker 用的 claude: $CLAUDE_BIN ($CLAUDE_V)"); else issue "$CLAUDE_BIN --version 沒有輸出. 修法: 在終端機手動跑 claude --version 看錯誤"; fi
else issue "找不到 claude. 修法: 照 https://code.claude.com/docs 安裝 Claude Code, 或把它的資料夾 (常見 ~/.local/bin) 加進 PATH"; fi
command -v git >/dev/null 2>&1 || issue "找不到 git. 修法: 請使用者安裝 (Debian/Ubuntu: sudo apt-get install git)"
if [ ! -f "$REPO/router/main.ts" ] || ! sed -n 's/^ *"version": *"\([0-9]*\)\..*/\1/p' "$REPO/package.json" | head -n 1 | grep -qE '^([2-9]|[1-9][0-9]+)$'; then
  issue "$REPO 不是 v2 的 cc-telegram-router. 修法: 先 git pull 到最新 main (或重新 git clone), 用新版裡的 deploy/upgrade-v1.sh"
fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then :
else issue "systemctl --user 不能用 (router 要以 systemd user unit 常駐). 修法: 用一般使用者直接登入的 Linux 執行 (不是 root, 不是沒有 systemd 的容器; sudo -u 切過來的 shell 通常沒有 XDG_RUNTIME_DIR)"; fi
[ "$(id -u)" = 0 ] && issue "不要用 root 執行. 修法: 用平常跑 Claude Code 的那個使用者執行"

# v1 的狀態
if [ ! -d "$V1_STATE" ]; then
  issue "找不到 v1 的狀態目錄 $V1_STATE. 修法: v1 當時設過 TELEGRAM_STATE_DIR 的話用 --v1-state <那個目錄>"
else
  if [ ! -f "$V1_STATE/.env" ]; then
    issue "$V1_STATE/.env 不存在 (v1 的 bot token 放在這裡). 修法: token 若在 shell 環境變數裡, 請使用者自己把一行 TELEGRAM_BOT_TOKEN=<token> 寫進這個檔 (權限 600, 不要貼在對話裡)"
  else
    line="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$V1_STATE/.env" 2>/dev/null | tail -n 1 || true)"
    TOKEN="${line#TELEGRAM_BOT_TOKEN=}"; TOKEN="${TOKEN%$'\r'}"; TOKEN="${TOKEN#\"}"; TOKEN="${TOKEN%\"}"; TOKEN="${TOKEN#\'}"; TOKEN="${TOKEN%\'}"
    if [ -z "$TOKEN" ]; then issue "$V1_STATE/.env 裡沒有 TELEGRAM_BOT_TOKEN=. 修法: 只看變數名稱 grep -E '^[A-Za-z_]+=' $V1_STATE/.env | cut -d= -f1; token 要由使用者自己寫入"
    elif ! [[ "$TOKEN" =~ ^[0-9]{1,20}:[A-Za-z0-9_-]{35}$ ]]; then issue "$V1_STATE/.env 的 TELEGRAM_BOT_TOKEN 格式不對 (應該是 <數字>:<35 個字元>, 現在長度 ${#TOKEN}). 修法: 多半多了空白或換行; 請使用者到 @BotFather 確認後自己重寫這一行"
    else
      BOT_ID="${TOKEN%%:*}"
      if [ "$BUN_OK" = 1 ]; then
        ROOT="${API_ROOT:-https://api.telegram.org}"
        me="$(V1UP_TOKEN="$TOKEN" V1UP_ROOT="$ROOT" bun -e '
          const t = process.env.V1UP_TOKEN, root = process.env.V1UP_ROOT
          try {
            const r = await fetch(`${root}/bot${t}/getMe`, { signal: AbortSignal.timeout(15000) })
            const j = await r.json().catch(() => ({}))
            if (!j.ok) console.log(`ERR ${r.status} ${String(j.description ?? "").split(t).join("<token>")}`)
            else console.log(`OK @${j.result.username}`)
          } catch (e) { console.log(`NET ${String(e).split(t).join("<token>")}`) }' 2>&1 || true)"
        case "$me" in
          OK*) CARRY+=("bot token: 有, bot id $BOT_ID (${me#OK }, 用 $ROOT 的 getMe 驗證通過; 來源 $V1_STATE/.env, 值不顯示)") ;;
          "ERR 401"*) issue "Telegram 說 v1 的 token 無效 (401, 多半在 @BotFather revoke 過). 修法: 請使用者用 @BotFather 的 /token 取得目前的 token, 自己寫進 $V1_STATE/.env 的 TELEGRAM_BOT_TOKEN= 那行 (不要貼在對話裡)" ;;
          ERR*) issue "用 $ROOT 驗證 token 失敗: ${me#ERR }. 修法: 確認 Bot API server; 自架的用 --api-root <網址>" ;;
          *) issue "連不到 $ROOT 驗證 token: ${me#NET }. 修法: 檢查網路 (curl -sS -o /dev/null -w '%{http_code}' $ROOT); 自架的用 --api-root <網址>" ;;
        esac
      fi
    fi
  fi
  if [ -f "$V1_STATE/access.json" ] && [ "$BUN_OK" = 1 ]; then
    acc="$(bun -e '
      try { const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
        const extra = ["mentionPatterns", "ackReaction", "replyToMode", "textChunkLimit", "chunkMode"].filter(k => a[k] !== undefined)
        console.log(`OK 私訊模式 ${a.dmPolicy ?? "pairing"}, 允許清單 ${(a.allowFrom ?? []).length} 人, 群組 ${Object.keys(a.groups ?? {}).length} 個, 待配對 ${Object.keys(a.pending ?? {}).length} 個 (不沿用)${extra.length ? `, 其他設定 ${extra.join(", ")}` : ""}`)
        console.log(`UIDS ${(a.allowFrom ?? []).join(", ")}`)
      } catch (e) { console.log(`ERR ${e}`) }' "$V1_STATE/access.json")"
    case "$acc" in
      OK*) ACC_SUMMARY="$(echo "$acc" | sed -n 's/^OK //p')"; ACC_UIDS="$(echo "$acc" | sed -n 's/^UIDS //p')"; CARRY+=("access.json: $ACC_SUMMARY (來源 $V1_STATE/access.json)") ;;
      *) issue "$V1_STATE/access.json 讀不了 (${acc#ERR }). 修法: 修好 JSON, 或用 --no-access 不沿用" ;;
    esac
  elif [ ! -f "$V1_STATE/access.json" ]; then DEFAULTS+=("access.json: v1 沒有, v2 用預設 (私訊用配對碼)"); fi
  if [ -f "$V1_STATE/messages.db" ] && [ "$BUN_OK" = 1 ]; then
    # router/importv1.ts openCopy: a copy (with its -wal) in a temporary folder, removed after; nothing next to v1's file
    msg="$(bun -e '
      const { openCopy } = await import(process.argv[2]); const fs = require("fs")
      const g = d => d ? new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "?"
      try { const c = openCopy(process.argv[1])
        try { const r = c.db.query("SELECT count(*) n, count(DISTINCT chat_id) c, min(ts) a, max(ts) z FROM messages").get()
          console.log(`OK ${r.n} 則, ${r.c} 個對話, ${g(r.a)} ~ ${g(r.z)} (GMT+8)`) } finally { c.close() }
      } catch (e) { console.log(`ERR ${e}`) }' "$V1_STATE/messages.db" "$REPO/router/importv1.ts")"
    case "$msg" in OK*) CARRY+=("訊息紀錄 messages.db: ${msg#OK } (來源 $V1_STATE/messages.db, 正式執行時以 cctr import-v1 匯入)") ;; *) issue "$V1_STATE/messages.db 讀不了 (${msg#ERR }). 修法: sqlite3 $V1_STATE/messages.db 'pragma integrity_check' 檢查; 不要匯入就請使用者先把它改名" ;; esac
  elif [ ! -f "$V1_STATE/messages.db" ]; then DEFAULTS+=("訊息紀錄: v1 沒有 messages.db, 不匯入"); fi
  n_inbox="$(find "$V1_STATE/inbox" -maxdepth 1 -type f 2>/dev/null | wc -l)"
  [ "$n_inbox" -gt 0 ] && CARRY+=("照片 inbox/: $n_inbox 個檔案留在 $V1_STATE/inbox (不搬; v2 用同一隻 bot 的 file_id 仍可重新下載)")
fi

# 安裝位置與既有的 v2 設定
[ "$HOME_DIR" = "$(realpath -m "$HOME")" ] && issue "--home 不能是使用者的家目錄本身 ($HOME). 修法: 用它底下的資料夾, 例如 --home $HOME/cc"
if [ -f "$STATE/config.json" ]; then
  CFG_EXISTS=1
  if [ "$BUN_OK" = 1 ]; then
    cfg="$(bun -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const b = (j.bots ?? []).find(b => String(b.token ?? "").split(":")[0] === process.argv[2]); console.log(`OK ${(j.owners ?? []).join(",")}|${b ? b.name : ""}|${(j.bots ?? []).map(b => b.name).join(",")}`) } catch (e) { console.log(`ERR ${e}`) }' "$STATE/config.json" "${BOT_ID:-none}")"
    case "$cfg" in
      OK*) cfg="${cfg#OK }"; CFG_OWNERS="${cfg%%|*}"; rest="${cfg#*|}"; CFG_BOT="${rest%%|*}"
        if [ -n "$BOT_ID" ] && [ -z "$CFG_BOT" ]; then issue "$STATE/config.json 已存在, 但裡面沒有 v1 這隻 bot (id $BOT_ID; 現有: ${rest#*|}). 修法: 這不是 v1 升級留下的設定, 請使用者決定改用別的 --home, 或在終端機用 deploy/install.sh setup 加入這隻 bot"
        else PLAN+=("會跳過: $STATE/config.json 已存在 (bot ${CFG_BOT:-?}, owner ${CFG_OWNERS:-無}), 沿用"); fi ;;
      *) issue "$STATE/config.json 不是合法的 JSON (${cfg#ERR }). 修法: 在終端機執行 deploy/install.sh setup 修正, 或修好後重跑" ;;
    esac
  fi
fi

# 問題: owner
if [ "$CFG_EXISTS" = 1 ] && [ -n "$CFG_OWNERS" ]; then CARRY+=("owner: $CFG_OWNERS (來源 $STATE/config.json)")
elif [ -n "$OWNER" ]; then CARRY+=("owner: $OWNER (--owner)")
elif [ "$CLAIM" = 1 ]; then DEFAULTS+=("owner: 不指定 (--claim), router 啟動後私訊 bot /start <認領碼> 認領")
else q "誰是 v2 router 的 owner (最高權限)? 要使用者決定, 不能猜. v1 允許清單裡的 uid: ${ACC_UIDS:-無} (通常是使用者自己的 uid, 私訊 @userinfobot 可查). 回答: --owner <uid>; 不想現在決定: --claim (router 啟動後私訊 bot /start <認領碼>)" "--owner <uid>"; fi
# 問題: 家目錄
if [ "$HOME_SET" = 1 ]; then CARRY+=("家目錄: $HOME_DIR (--home), 狀態目錄 $STATE")
elif [ "$CFG_EXISTS" = 1 ]; then CARRY+=("家目錄: $HOME_DIR (已有安裝), 狀態目錄 $STATE")
else DEFAULTS+=("家目錄: $HOME_DIR (預設), 狀態目錄 $STATE"); q "router 的家目錄放哪裡? 每個 Telegram 對話一個資料夾, 預設 $HOME_DIR. 回答: --home <絕對路徑> (用預設也要寫出來確認)" "--home $HOME_DIR"; fi
# 問題: bot 名稱
if [ "$CFG_EXISTS" = 1 ] && [ -n "$CFG_BOT" ]; then CARRY+=("bot 名稱: $CFG_BOT (來源 $STATE/config.json)")
elif [ "$BOT_SET" = 1 ]; then CARRY+=("bot 名稱: $BOT_NAME (--bot-name)")
else DEFAULTS+=("bot 名稱: cc (預設)"); q "v2 裡這隻 bot 叫什麼名字? 用在 /router 指令與資料夾名稱, 預設 cc. 回答: --bot-name <名稱> (英數, - 與 _; 用預設也要寫出來確認)" "--bot-name cc"; fi
# 問題: 沿用 access.json
if [ -f "$STATE/access.json" ]; then PLAN+=("會跳過: $STATE/access.json 已存在, 不覆蓋")
elif [ -n "$ACC_SUMMARY" ]; then
  if [ "$ACCESS" = keep ]; then CARRY+=("存取設定: 沿用 v1 的 access.json (--keep-access)")
  elif [ "$ACCESS" = no ]; then DEFAULTS+=("存取設定: 不沿用 v1 (--no-access), 用預設 (私訊用配對碼, 只有 owner 直接可以私訊)")
  else DEFAULTS+=("存取設定: 預設沿用 v1 的 access.json"); q "要沿用 v1 的存取設定嗎? ($ACC_SUMMARY). 沿用: 原本能私訊的人與群組照舊; 不沿用: 從配對模式重新開始, 群組要重新加. 回答: --keep-access 或 --no-access" "--keep-access"; fi
fi
# 問題: linger
if [ "$SKIP_LINGER" = 1 ]; then DEFAULTS+=("linger: 不檢查 (--skip-linger), 使用者登出後 router 會停止")
elif [ "$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null || true)" = "Linger=yes" ]; then CARRY+=("linger: 已開 (登出後 router 繼續跑, 開機自動啟動)")
else q "linger 沒開: 沒開的話使用者登出後 router 就停止, 開機也不會自動啟動. 要開請使用者執行 sudo loginctl enable-linger $(id -un) (要 sudo, Claude 不能代做) 後重跑; 確定不需要就加 --skip-linger" "[--skip-linger]"; fi

DEFAULTS+=("Bot API: ${API_ROOT:-官方 https://api.telegram.org (預設; 自架的 telegram-bot-api 用 --api-root <網址>)}")
DEFAULTS+=("worker 的模型: claude-opus-5-5 (router 預設; 之後可用 /router config set model 改)")
DEFAULTS+=("channel 模式: managed (預設; bwrap 或 user namespace 不能用時 router 自動降級成 legacy)")

# 還在跑的 v1
others="$(v1_others)"
if [ -n "$others" ]; then
  human "舊的 v1 還在跑, 它會跟 router 搶同一個 token 的訊息 (409 衝突), 而且 v1 遇到 409 會不停地立刻重試. 請使用者在那個 Claude Code 裡 /exit 關掉它 (不要 kill, 讓它自己釋放 bot.pid) 後重跑:
$(echo "$others" | sed 's/^/         /')
       如果 bot.pid 指向的程序其實不是 v1 (pid 被重用), 確認後刪掉 $V1_STATE/bot.pid 再重跑."
fi

# 會做哪些步驟
if [ -x "$STATE/cctr" ] && [ "$(cat "$MARKS/router" 2>/dev/null || true)" = "$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo none)" ]; then PLAN+=("會跳過: router 已是這個版本 ($STATE/cctr)"); else PLAN+=("會做: 編譯 router 到 $STATE/cctr, 下載工具箱 (deploy/install.sh router)"); fi
[ "$CFG_EXISTS" = 1 ] || PLAN+=("會做: 寫 $STATE/config.json (沿用 v1 的 token, 權限 600)")
[ -f "$STATE/access.json" ] || PLAN+=("會做: 寫 $STATE/access.json ($([ "$ACCESS" = no ] || [ -z "$ACC_SUMMARY" ] && echo "預設" || echo "從 v1 複製, 清掉待配對的碼"))")
PLAN+=("會做: 寫位置檔 ~/.config/cc-telegram-router/router.json (cctr register)")
if [ "$(cat "$PLUGIN_CACHE/.deployed-version" 2>/dev/null || true)" = v2 ]; then PLAN+=("會做: 重新部署 plugin v2 (deploy/install.sh plugin)")
else PLAN+=("會做: 部署 plugin v2 到 router 的商店與官方快取 $PLUGIN_CACHE (v1 的快取先備份到 ~/.claude/channels/telegram-versions/v1-cache)"); fi
if [ -f "$UNIT_FILE" ]; then PLAN+=("會做: 更新 systemd user unit"); else PLAN+=("會做: 安裝 systemd user unit $UNIT_FILE"); fi
[ -f "$HOME_DIR/CLAUDE.md" ] || PLAN+=("會做: 從範例建立 $HOME_DIR/CLAUDE.md")
if [ -f "$MARKS/import" ]; then PLAN+=("會跳過: 訊息紀錄已匯入過"); elif [ -f "$V1_STATE/messages.db" ]; then PLAN+=("會做: 匯入 v1 訊息紀錄 (cctr import-v1)"); fi
PLAN+=("會做: 啟動 router (systemctl --user enable --now cc-telegram-router), 跑 cctr cli doctor")

# 答案參數: 這次已給的 (重跑指令原樣帶上)
answer_args() {
  local out=()
  [ -n "$OWNER" ] && out+=(--owner "$OWNER")
  [ "$CLAIM" = 1 ] && out+=(--claim)
  [ "$HOME_SET" = 1 ] && out+=(--home "$HOME_DIR")
  [ "$BOT_SET" = 1 ] && out+=(--bot-name "$BOT_NAME")
  [ "$ACCESS" = keep ] && out+=(--keep-access)
  [ "$ACCESS" = no ] && out+=(--no-access)
  [ "$SKIP_LINGER" = 1 ] && out+=(--skip-linger)
  [ -n "$API_ROOT" ] && out+=(--api-root "$API_ROOT")
  [ "$V1_SET" = 1 ] && out+=(--v1-state "$V1_STATE")
  [ ${#out[@]} -gt 0 ] && printf ' %q' "${out[@]}"
  return 0
}

report() {
  local i n=0
  echo
  echo "(a) 從 v1 帶入 / 已確定的值:"
  for i in "${CARRY[@]}"; do echo "  ✅ $i"; done
  echo
  echo "(b) 用預設值的項目:"
  for i in "${DEFAULTS[@]}"; do echo "  ▫️  $i"; done
  echo
  echo "(c) 要問使用者的問題 (${#QUESTIONS[@]} 題):"
  [ ${#QUESTIONS[@]} -eq 0 ] && echo "  (沒有)"
  for i in "${QUESTIONS[@]}"; do n=$((n + 1)); echo "  ❓ Q$n. $i"; done
  echo
  echo "(d) 要先處理的問題 ($((${#ISSUES[@]} + ${#HUMAN[@]})) 項):"
  [ $((${#ISSUES[@]} + ${#HUMAN[@]})) -eq 0 ] && echo "  (沒有)"
  for i in "${ISSUES[@]}"; do echo "  ❌ $i"; done
  for i in "${HUMAN[@]}"; do echo "  ✋ $i"; done
  echo
  echo "正式執行時的步驟:"
  for i in "${PLAN[@]}"; do echo "  - $i"; done
  echo
  return 0
}
PENDING=$((${#QUESTIONS[@]} + ${#ISSUES[@]} + ${#HUMAN[@]}))
stop_pending() {
  local sugg="" s
  for s in "${SUGGEST[@]}"; do [ -n "$s" ] && sugg="$sugg $s"; done
  echo "還剩 ${#QUESTIONS[@]} 題沒答, ${#ISSUES[@]} 項錯誤要修, ${#HUMAN[@]} 項要人操作."
  echo "補上後重跑 dry run 的完整指令 (<...> 換成使用者的答案; 建議值要先跟使用者確認; [...] 是視答案才加的):"
  echo "  $(printf '%q' "$SELF") --dry-run$(answer_args)$sugg"
  [ "$1" = run ] && echo "這次是正式執行: 因為還有沒答的題目或要先處理的問題, 沒有做任何寫入."
  if [ ${#ISSUES[@]} -gt 0 ]; then echo; echo "結果: 有要先修的錯誤 (結束碼 1)."; exit 1; fi
  echo; echo "結果: 還有題目沒答或要人操作 (結束碼 3)."; exit 3
}

echo "cc-telegram-router v1 → v2 升級$([ "$DRY" = 1 ] && echo " (dry run: 只檢查, 不寫入)")"
echo "  repo:        $REPO ($(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$REPO/package.json" | head -n 1))"
echo "  v1 狀態目錄: $V1_STATE"
echo "  v2 家目錄:   $HOME_DIR"

if [ "$DRY" = 1 ]; then
  report
  [ "$PENDING" -gt 0 ] && stop_pending dry
  echo "還剩 0 題沒答. 全部通過, 正式執行的指令:"
  echo "  $(printf '%q' "$SELF")$(answer_args)"
  echo
  echo "結果: dry run 通過, 可以正式執行 (結束碼 0)."
  exit 0
fi
if [ "$PENDING" -gt 0 ]; then report; stop_pending run; fi
echo "  檢查通過 (沒有未答的題目), 開始升級."

# ---------- 正式執行 ----------
TOTAL=9 STEP=0
ORIG_CMD="$(printf '%q ' "$SELF" "${ARGS[@]}")"; ORIG_CMD="${ORIG_CMD% }"
step() { STEP=$((STEP + 1)); echo; echo "[第 $STEP/$TOTAL 步] $1"; }
ok()   { echo "  ✅ $1"; }
skip() { echo "  ⏭️  跳過: $1"; }
fail() {
  local why="$1" path="$2" l; shift 2
  echo "  ❌ 失敗: $why"
  [ -n "$path" ] && echo "     相關路徑: $path"
  echo "     建議修法:"; for l in "$@"; do echo "       - $l"; done
  echo "     修好後重跑同一個指令 (已完成的步驟會跳過): $ORIG_CMD"
  echo; echo "結果: 第 $STEP 步失敗, 已停下 (結束碼 1)."
  exit 1
}
HEAD_REV="$(git -C "$REPO" rev-parse HEAD)"

step "安裝 repo 的相依套件 (bun install --frozen-lockfile)"
log="$(cd "$REPO" && bun install --frozen-lockfile 2>&1)" || { echo "$log" | tail -n 20; fail "bun install --frozen-lockfile 失敗" "$REPO/bun.lock" "看上面最後 20 行; 網路問題就重跑" "lockfile 不符: git -C $REPO status 確認 bun.lock 沒被改"; }
ok "相依套件跟 bun.lock 一致"

step "編譯並安裝 router 到 $STATE (deploy/install.sh router, 含工具箱下載)"
if [ -x "$STATE/cctr" ] && [ "$(cat "$MARKS/router" 2>/dev/null || true)" = "$HEAD_REV" ]; then skip "這個版本已經裝過"
else
  CC_ROUTER_STATE="$STATE" "$REPO/deploy/install.sh" router </dev/null || fail "deploy/install.sh router 失敗" "$STATE" "看上面 install.sh 的訊息 (它會說缺什麼)" "磁碟滿也會失敗: df -h $HOME_DIR"
  mkdir -p "$MARKS"; echo "$HEAD_REV" > "$MARKS/router"
  ok "router 裝好: $STATE/cctr (install.sh 說「還沒有 config.json」是正常的, 下一步建立)"
fi

step "建立 config.json 與 access.json"
if [ -f "$STATE/config.json" ]; then skip "config.json 已存在"
else
  V1UP_TOKEN="$TOKEN" bun -e '
    const [path, state, home, owner, name, claude, root] = process.argv.slice(1)
    const cfg = { stateDir: state, home, owners: owner ? [owner] : [], claudeBin: claude, bots: [{ name, token: process.env.V1UP_TOKEN, ...(root ? { apiRoot: root } : {}) }] }
    const fs = require("fs")
    fs.writeFileSync(path + ".tmp", JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(path + ".tmp", path)' \
    "$STATE/config.json" "$STATE" "$HOME_DIR" "$OWNER" "$BOT_NAME" "$CLAUDE_BIN" "$API_ROOT" || fail "寫入 config.json 失敗" "$STATE/config.json" "確認 $STATE 可寫: ls -ld $STATE"
  ok "寫入 $STATE/config.json (權限 600; bot $BOT_NAME, owner ${OWNER:-無, 之後認領})"
fi
if [ -f "$STATE/access.json" ]; then skip "access.json 已存在, 不覆蓋"
elif [ "$ACCESS" = no ] || [ ! -f "$V1_STATE/access.json" ]; then
  bun -e 'const fs = require("fs"); const [p, o] = process.argv.slice(1); fs.writeFileSync(p, JSON.stringify({ dmPolicy: "pairing", allowFrom: o ? [o] : [], groups: {}, pending: {} }, null, 2) + "\n", { mode: 0o600 })' "$STATE/access.json" "$OWNER"
  ok "建立預設的 access.json (私訊用配對碼)"
else
  bun -e '
    const fs = require("fs"); const [src, dst, owner] = process.argv.slice(1)
    const a = JSON.parse(fs.readFileSync(src, "utf8"))
    a.pending = {}
    a.allowFrom = Array.isArray(a.allowFrom) ? a.allowFrom.map(String) : []
    if (owner && !a.allowFrom.includes(owner)) a.allowFrom.push(owner)
    fs.writeFileSync(dst + ".tmp", JSON.stringify(a, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(dst + ".tmp", dst)' \
    "$V1_STATE/access.json" "$STATE/access.json" "$OWNER" || fail "複製 v1 access.json 失敗" "$V1_STATE/access.json" "檔案壞了就改用 --no-access"
  ok "從 v1 複製 access.json (待配對的碼不沿用)"
fi

step "寫入位置檔 (cctr register)"
"$STATE/cctr" --config "$STATE/config.json" register || fail "cctr register 失敗" "$STATE/config.json" "看上面的訊息; config.json 欄位對照 docs/operations.md「設定欄位」"
ok "位置檔指向 $STATE"

step "部署 plugin v2 (router 商店 + 官方 plugin 快取; 第一次會把 v1 的快取備份到 ~/.claude/channels/telegram-versions/v1-cache)"
CC_ROUTER_STATE="$STATE" "$REPO/deploy/install.sh" plugin </dev/null || fail "deploy/install.sh plugin 失敗" "$PLUGIN_CACHE" "看上面的訊息; 權限問題時 ls -ld $PLUGIN_CACHE"
ok "plugin 部署完成 (之後用 --channels $V1_CHANNEL 開的 session 拿到的是 v2 plugin, 它不收訊息)"

step "安裝 systemd user unit 與共用 CLAUDE.md"
CC_ROUTER_STATE="$STATE" "$REPO/deploy/install.sh" unit </dev/null || fail "deploy/install.sh unit 失敗" "$UNIT_FILE" "看上面的訊息 (多半是找不到 bun)"
ok "unit: $UNIT_FILE"
if [ -f "$HOME_DIR/CLAUDE.md" ]; then skip "$HOME_DIR/CLAUDE.md 已存在"; else cp "$REPO/templates/CLAUDE.md.example" "$HOME_DIR/CLAUDE.md"; ok "從範例建立 $HOME_DIR/CLAUDE.md"; fi

step "匯入 v1 的訊息紀錄 (cctr import-v1)"
if [ -f "$MARKS/import" ]; then skip "已經匯入過 ($(cat "$MARKS/import"))"
elif [ ! -f "$V1_STATE/messages.db" ]; then skip "沒有 v1 messages.db"
else
  bot="$(bun -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const b = (j.bots ?? []).find(b => String(b.token ?? "").split(":")[0] === process.argv[2]); process.stdout.write(b?.name ?? "")' "$STATE/config.json" "$BOT_ID")"
  out="$("$STATE/cctr" --config "$STATE/config.json" import-v1 "$V1_STATE/messages.db" --bot "${bot:-$BOT_NAME}" 2>&1)" || fail "cctr import-v1 失敗: $out" "$V1_STATE/messages.db" "資料庫被鎖: 確認 v1 session 都關了再重跑" "檔案壞了: sqlite3 $V1_STATE/messages.db 'pragma integrity_check'"
  echo "$out ($(date '+%F %T'))" > "$MARKS/import"
  ok "$out"
fi

step "啟動 router 並檢查 (systemctl --user enable --now cc-telegram-router, cctr cli doctor)"
if systemctl --user is-active --quiet cc-telegram-router 2>/dev/null; then skip "router 已在執行"
else systemctl --user enable --now cc-telegram-router || fail "systemctl --user enable --now 失敗" "$UNIT_FILE" "看 systemctl --user status cc-telegram-router 與 journalctl --user -u cc-telegram-router -n 50"; fi
for _ in $(seq 1 30); do [ -S "$STATE/router.sock" ] && break; sleep 1; done
[ -S "$STATE/router.sock" ] || fail "30 秒內 router 的 socket 沒有出現" "$STATE/router.sock" "看 journalctl --user -u cc-telegram-router -n 80 --no-pager 找錯誤" "常見: config.json 欄位錯 (log 會寫哪一欄), bun 不在 unit 的 PATH (重跑 deploy/install.sh unit)"
doc="$("$STATE/cctr" --config "$STATE/config.json" cli doctor 2>&1 || true)"
echo "$doc" | sed 's/^/     /'
if echo "$doc" | grep -q '❌'; then fail "cli doctor 有 ❌ 項目" "$STATE" "照每一個 ❌ 後面的說明修, 修好後重跑"; fi
ok "router 在執行"

step "收尾"
echo "  v1 留下的東西 (沒有刪, 確認 v2 正常後可自行清理):"
echo "    - $V1_STATE (.env 的 token 仍是明文; access.json, messages.db, inbox/)"
echo "    - ~/.claude/channels/telegram-versions/ (v1 的快取備份, 退回 v1 時用)"
echo "    - 舊 v1 session 的對話紀錄在 ~/.claude/projects/, v2 的 worker 不接續它 (每個 Telegram 對話是新的 session)"
owners="$(bun -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write((j.owners ?? []).join(","))' "$STATE/config.json")"
if [ -z "$owners" ]; then
  code="$(journalctl --user -u cc-telegram-router -n 300 --no-pager 2>/dev/null | grep -o '/start [A-Za-z0-9_-]*」認領' | tail -n 1 | sed 's/」認領//' || true)"
  echo "  ✋ 要人操作: 認領 owner. 請使用者私訊 bot「${code:-/start <認領碼>}」(碼在 journalctl --user -u cc-telegram-router | grep 認領, 只在這次 router 執行期間有效). 認領後重跑同一個指令確認."
  echo; echo "結果: 升級完成, 剩 owner 認領 (結束碼 3)."
  exit 3
fi
echo; echo "結果: 升級完成 (結束碼 0). 私訊 bot 試試看; 有問題先跑 $STATE/cctr cli doctor."
