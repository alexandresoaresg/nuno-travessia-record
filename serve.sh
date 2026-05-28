#!/bin/bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
PORT="${PORT:-8080}"

# Kill stale server on this port (avoids ERR_EMPTY_RESPONSE from hung Python)
if lsof -ti ":$PORT" >/dev/null 2>&1; then
  echo "A libertar porta $PORT..."
  lsof -ti ":$PORT" | xargs kill -9 2>/dev/null || true
  sleep 0.3
fi

echo "Servidor: http://127.0.0.1:$PORT"
echo "Background: GPS live cada 60s · dados completos cada 2 min"
echo "(Ctrl+C para parar)"
exec python3 "$DIR/serve.py" "$PORT"
