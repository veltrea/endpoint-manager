#!/usr/bin/env bash
PORT_HTTP="${EM_HTTP_PORT:-3798}"
PORT_WS="${EM_WS_PORT:-3797}"

for port in "$PORT_HTTP" "$PORT_WS"; do
  pids=$(lsof -ti ":$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "[stop] port $port → PID $pids を停止"
    kill $pids
  fi
done
echo "[stop] 完了"
