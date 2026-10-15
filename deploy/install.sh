#!/bin/bash
# Build and install cc-telegram-router (plan 03 「專案位置與部署」).
#
#   deploy/install.sh router   compile the router into /x/cc/.router/, copy templates
#   deploy/install.sh plugin   bundle plugin v2 into the official plugin cache path
#   deploy/install.sh unit     install the systemd user unit (does not start it)
#   deploy/install.sh all
#
# Never touches config.json or access.json; those are created by hand once.
# The first plugin install backs up whatever was in the cache before
# (rollback: copy that backup back over the cache dir).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${CC_ROUTER_STATE:-/x/cc/.router}"
PLUGIN_CACHE="$HOME/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7"
BACKUPS="$HOME/.claude/channels/telegram-versions"
UNIT_DIR="$HOME/.config/systemd/user"

install_router() {
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  bun build --compile "$REPO/router/main.ts" --outfile "$STATE/cc-telegram-router.new"
  mv -f "$STATE/cc-telegram-router.new" "$STATE/cc-telegram-router"
  rm -rf "$STATE/templates"
  cp -r "$REPO/templates" "$STATE/templates"
  echo "router -> $STATE/cc-telegram-router"
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
  cp -r "$REPO/plugin/.claude-plugin" "$REPO/plugin/.mcp.json" "$REPO/plugin/package.json" "$tmp/"
  # Keep Claude Code's own marker files; replace everything else.
  find "$PLUGIN_CACHE" -mindepth 1 -maxdepth 1 ! -name '.in_use' -exec rm -rf {} +
  cp -a "$tmp/." "$PLUGIN_CACHE/"
  echo v2 > "$PLUGIN_CACHE/.deployed-version"
  rm -rf "$tmp"
  echo "plugin -> $PLUGIN_CACHE"
}

install_unit() {
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
