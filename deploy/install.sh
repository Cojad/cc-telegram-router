#!/bin/bash
# Build and install cc-telegram-router (plan 03 「專案位置與部署」).
#
#   deploy/install.sh router   compile the router into the state dir, copy templates and the report scripts,
#                              install the skills' toolbox (ffmpeg, deno, uv: <state>/toolbox, a failure only warns),
#                              and (once config.json exists) write the locator the plugin and hook use
#                              (~/.config/cc-telegram-router/router.json, shared/locate.ts)
#   deploy/install.sh plugin   bundle plugin v2 into the official plugin cache path and record its
#                              fingerprint in the state dir (<stateDir>/plugin-fingerprint.json), which
#                              the router checks the cache against (router/pluginguard.ts)
#   deploy/install.sh unit     install the systemd user unit (does not start it)
#   deploy/install.sh setup    the setup wizard (cc-telegram-router setup): make config.json and access.json,
#                              or change them (edit mode when config.json exists), then register
#   deploy/install.sh all
#
# The state dir (where the router, config.json and router.db live) can be
# anywhere. The first install names it: CC_ROUTER_STATE=<home>/.router
# deploy/install.sh router. Later runs take it from the locator file.
#
# Only setup writes config.json and access.json (router, when there is no
# config.json yet and it runs in a terminal, starts the wizard itself).
# The first plugin install backs up whatever was in the cache before
# (rollback: copy that backup back over the cache dir).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCATOR="$HOME/.config/cc-telegram-router/router.json"
PLUGIN_CACHE="$HOME/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7"
BACKUPS="$HOME/.claude/channels/telegram-versions"
UNIT_DIR="$HOME/.config/systemd/user"

# Before every job (deploy/preflight.ts): bun found and as new as package.json's
# engines, the repo's packages as bun.lock has them (bun install --frozen-lockfile
# when not), claude found. Stops with what to do when something is missing.
preflight() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "找不到 bun (command -v bun 沒有結果): 先照 https://bun.sh 的官方安裝程式安裝 bun 1.4.2 以上 (它放在 ~/.bun/bin), 開新的 shell 或把 ~/.bun/bin 加進 PATH 後重跑" >&2
    exit 1
  fi
  bun "$REPO/deploy/preflight.ts" || { echo "前置檢查沒過, 照上面的說明補好後重跑 $(basename "$0") ${1:-}" >&2; exit 1; }
}

# The state dir: CC_ROUTER_STATE, else the one the locator names (an earlier install).
state_dir() {
  if [ -n "${CC_ROUTER_STATE:-}" ]; then STATE="$(realpath -m "$CC_ROUTER_STATE")"; return; fi
  if [ -f "$LOCATOR" ]; then
    STATE="$(bun -e 'const j = await Bun.file(process.argv[1]).json(); process.stdout.write(String(j.stateDir ?? ""))' "$LOCATOR")"
    [ -n "$STATE" ] && return
  fi
  echo "沒有指定安裝位置: 第一次安裝請用 CC_ROUTER_STATE=<home>/.router $(basename "$0") $1 (例如 CC_ROUTER_STATE=\$HOME/cc/.router)" >&2
  exit 1
}

install_router() {
  state_dir router
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  bun build --compile "$REPO/router/main.ts" --outfile "$STATE/cc-telegram-router.new"
  mv -f "$STATE/cc-telegram-router.new" "$STATE/cc-telegram-router"
  rm -rf "$STATE/templates"
  cp -r "$REPO/templates" "$STATE/templates"
  rm -rf "$STATE/scripts"
  cp -r "$REPO/scripts" "$STATE/scripts"
  chmod +x "$STATE/scripts/"*.sh "$STATE/scripts/"*.py
  mkdir -p "$STATE/hooks"
  bun build --compile "$REPO/hooks/hook.ts" --outfile "$STATE/hooks/cc-hook.new"
  mv -f "$STATE/hooks/cc-hook.new" "$STATE/hooks/cc-hook"
  echo "router -> $STATE/cc-telegram-router, hook -> $STATE/hooks/cc-hook, report scripts -> $STATE/scripts"
  # the shared toolbox (ffmpeg, deno, uv; fixed versions, sha256 checked): a tool that fails only fails
  # the skills that need it, so the install goes on (docs/skill-runtime.md 「工具箱」)
  if ! "$STATE/cc-telegram-router" toolbox install --state "$STATE"; then
    echo "警告: 工具箱有工具沒有裝好 (見上面), 需要它的特權技能會拒絕執行; 之後可以再跑 $STATE/cc-telegram-router toolbox install --state $STATE" >&2
  fi
  if [ ! -f "$STATE/config.json" ] && [ -t 0 ] && [ -t 1 ]; then
    echo "還沒有 $STATE/config.json: 開始設定嚮導 (Ctrl-C 取消, 之後可以用 $(basename "$0") setup 再跑)"
    "$STATE/cc-telegram-router" --config "$STATE/config.json" setup || true
  fi
  if [ -f "$STATE/config.json" ]; then
    "$STATE/cc-telegram-router" register
  else
    echo "還沒有 $STATE/config.json: 在終端機執行 $(basename "$0") setup 用嚮導建立 (或照 docs/operations.md 手寫後執行 $STATE/cc-telegram-router register)"
  fi
}

install_setup() {
  state_dir setup
  if [ ! -x "$STATE/cc-telegram-router" ]; then
    echo "$STATE/cc-telegram-router 不存在: 先執行 CC_ROUTER_STATE=$STATE $(basename "$0") router" >&2
    exit 1
  fi
  "$STATE/cc-telegram-router" --config "$STATE/config.json" setup
  "$STATE/cc-telegram-router" register
}

install_plugin() {
  if [ ! -f "$BACKUPS/v1-cache/.snapshotted" ] && [ -f "$PLUGIN_CACHE/server.ts" ]; then
    mkdir -p "$BACKUPS/v1-cache"
    cp -a "$PLUGIN_CACHE/." "$BACKUPS/v1-cache/"
    touch "$BACKUPS/v1-cache/.snapshotted"
    echo "backed up v1 plugin cache -> $BACKUPS/v1-cache"
  fi
  local tmp
  tmp="$(mktemp -d)"
  bun build "$REPO/plugin/server.ts" --target=bun --outfile "$tmp/server.js" >/dev/null
  cp -r "$REPO/plugin/.claude-plugin" "$REPO/plugin/.mcp.json" "$REPO/plugin/package.json" "$REPO/plugin/skills" "$tmp/"
  # Keep Claude Code's own marker files; replace everything else.
  find "$PLUGIN_CACHE" -mindepth 1 -maxdepth 1 ! -name '.in_use' -exec rm -rf {} +
  cp -a "$tmp/." "$PLUGIN_CACHE/"
  echo v2 > "$PLUGIN_CACHE/.deployed-version"
  rm -rf "$tmp"
  echo "plugin -> $PLUGIN_CACHE"
  # What we put there, for the router's check of the cache (router/pluginguard.ts).
  if plugin_state_dir; then
    bun "$REPO/router/pluginguard.ts" fingerprint "$PLUGIN_CACHE" "$STATE"
  else
    echo "沒有安裝位置 (CC_ROUTER_STATE 或位置檔), 沒記下 plugin 指紋: 裝好 router 後再跑一次 $(basename "$0") plugin" >&2
  fi
}

# Like state_dir, but only reports whether it is known (a plugin install may come before the router's).
plugin_state_dir() {
  if [ -n "${CC_ROUTER_STATE:-}" ]; then STATE="$(realpath -m "$CC_ROUTER_STATE")"; return 0; fi
  if [ -f "$LOCATOR" ]; then
    STATE="$(bun -e 'const j = await Bun.file(process.argv[1]).json(); process.stdout.write(String(j.stateDir ?? ""))' "$LOCATOR")"
    [ -n "$STATE" ] && return 0
  fi
  return 1
}

# The unit's PATH: the usual folders, with bun's folder (the worker's telegram plugin
# runs bun, plugin/.mcp.json) and claude's (config claudeBin, else the claude on PATH)
# in front when they are not among them. No bun: stop and say why.
unit_path() {
  local base="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/bin:/bin" bun claude dir extra=""
  bun="$(command -v bun || true)"
  if [ -z "$bun" ]; then
    echo "找不到 bun (command -v bun 沒有結果): worker 的 telegram plugin 要用 bun 執行, 沒有它 router 會一直報 plugin did not connect. 先安裝 bun (https://bun.sh), 或把它的資料夾加進 PATH 後重跑 $(basename "$0") unit" >&2
    return 1
  fi
  claude=""
  if [ -f "$STATE/config.json" ]; then
    claude="$(bun -e 'const j = await Bun.file(process.argv[1]).json(); process.stdout.write(String(j.claudeBin ?? ""))' "$STATE/config.json" 2>/dev/null || true)"
  fi
  case "$claude" in
    /*) ;;
    *) claude="$(command -v "${claude:-claude}" || true)" ;;
  esac
  [ -z "$claude" ] && echo "注意: 找不到 claude 執行檔, unit 的 PATH 不另外加它的資料夾 (config 的 claudeBin 寫絕對路徑最穩)" >&2
  for dir in "$(dirname "$bun")" ${claude:+"$(dirname "$claude")"}; do
    case ":$base:$extra" in *":$dir:"*) ;; *) extra="$extra$dir:" ;; esac
  done
  UNIT_PATH="$extra$base"
}

install_unit() {
  state_dir unit
  unit_path
  mkdir -p "$UNIT_DIR"
  sed "s#@STATE@#$STATE#g; s#@HOME@#$HOME#g; s#@PATH@#$UNIT_PATH#g" "$REPO/deploy/cc-telegram-router.service" > "$UNIT_DIR/cc-telegram-router.service"
  systemctl --user daemon-reload
  echo "unit -> $UNIT_DIR/cc-telegram-router.service (PATH=$UNIT_PATH)"
}

case "${1:-}" in
  router|plugin|unit|setup|all) preflight "$1" ;;
esac
case "${1:-}" in
  router) install_router ;;
  plugin) install_plugin ;;
  unit) install_unit ;;
  setup) install_setup ;;
  all) install_router; install_plugin; install_unit ;;
  *) echo "usage: $(basename "$0") {router|plugin|unit|setup|all}" >&2; exit 1 ;;
esac
