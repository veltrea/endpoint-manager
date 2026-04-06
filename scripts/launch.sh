#!/usr/bin/env bash
set -euo pipefail

PORT_HTTP="${EM_HTTP_PORT:-3798}"
PORT_WS="${EM_WS_PORT:-3797}"
NODE="$HOME/.nvm/versions/node/v22.17.0/bin/node"
# スクリプトは scripts/ にいるので、プロジェクトルートは1つ上
DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── すでに起動済みか確認 ──────────────────────────────
if lsof -ti ":$PORT_HTTP" >/dev/null 2>&1; then
  echo "[launch] サービスは既に起動中 (port $PORT_HTTP)"
else
  echo "[launch] サービスを起動中..."
  cd "$DIR"
  "$NODE" --import tsx/esm src/index.ts \
    > "$DIR/endpoint-manager.log" 2>&1 &
  SVC_PID=$!
  echo "[launch] PID: $SVC_PID → endpoint-manager.log"

  # HTTP サーバーが応答するまで待機（最大 10 秒）
  for i in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:$PORT_HTTP/" >/dev/null 2>&1; then
      echo "[launch] サーバー起動完了"
      break
    fi
    sleep 0.5
  done
fi

# ── Chrome アプリモードで開く ────────────────────────
APP_URL="http://127.0.0.1:$PORT_HTTP/"

if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS: Chrome → Chromium → デフォルトブラウザ の順で試す
  if open -Ra "Google Chrome" 2>/dev/null; then
    open -na "Google Chrome" --args \
      --app="$APP_URL" \
      --window-size=1400,900 \
      --user-data-dir="$HOME/.config/endpoint-manager/chrome-profile"
  elif open -Ra "Chromium" 2>/dev/null; then
    open -na "Chromium" --args \
      --app="$APP_URL" \
      --window-size=1400,900 \
      --user-data-dir="$HOME/.config/endpoint-manager/chrome-profile"
  else
    echo "[launch] Chrome/Chromium が見つかりません。ブラウザで開きます"
    open "$APP_URL"
  fi

elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  for browser in google-chrome chromium-browser chromium; do
    if command -v "$browser" >/dev/null 2>&1; then
      "$browser" --app="$APP_URL" --window-size=1400,900 &
      break
    fi
  done

elif [[ "$OSTYPE" == "msys"* || "$OSTYPE" == "cygwin"* ]]; then
  # Windows (Git Bash / WSL)
  start chrome --app="$APP_URL"
fi

echo "[launch] Endpoint Manager → $APP_URL"
