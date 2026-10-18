#!/bin/bash
# Build and install cc-telegram-router (plan 03 「專案位置與部署」).
#
#   deploy/install.sh router   compile the router into the state dir, copy templates and the report scripts,
#                              and (once config.json exists) write the locator the plugin and hook use
#                              (~/.config/cc-telegram-router/router.json, shared/locate.ts)
#   deploy/install.sh plugin   bundle plugin v2 into the official plugin cache path and record its
#                              fingerprint in the state dir (<stateDir>/plugin-fingerprint.json), which
#                              the router checks the cache against (router/pluginguard.ts)
#   deploy/install.sh unit     install the systemd user unit (does not start it)
#   deploy/install.sh all
#
# The state dir (where the router, config.json and router.db live) can be
# anywhere. The first install names it: CC_ROUTER_STATE=<home>/.router
# deploy/install.sh router. Later runs take it from the locator file.
#
# Never touches config.json or access.json; those are created by hand once.
# The first plugin install backs up whatever was in the cache before
# (rollback: copy that backup back over the cache dir).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCATOR="$HOME/.config/cc-telegram-router/router.json"
PLUGIN_CACHE="$HOME/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7"
BACKUPS="$HOME/.claude/channels/telegram-versions"
UNIT_DIR="$HOME/.config/systemd/user"

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
  if [ -f "$STATE/config.json" ]; then
    "$STATE/cc-telegram-router" register
  else
    echo "還沒有 $STATE/config.json: 建立後執行 $STATE/cc-telegram-router register (或再跑一次 CC_ROUTER_STATE=$STATE $(basename "$0") router)"
  fi
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

install_unit() {
  state_dir unit
  mkdir -p "$UNIT_DIR"
  sed "s#@STATE@#$STATE#g; s#@HOME@#$HOME#g" "$REPO/deploy/cc-telegram-router.service" > "$UNIT_DIR/cc-telegram-router.service"
  systemctl --user daemon-reload
  echo "unit -> $UNIT_DIR/cc-telegram-router.service"
}

case "${1:-}" in
  router) install_router ;;
  plugin) install_plugin ;;
  unit) install_unit ;;
  all) install_router; install_plugin; install_unit ;;
  *) echo "usage: $(basename "$0") {router|plugin|unit|all}" >&2; exit 1 ;;
esac
