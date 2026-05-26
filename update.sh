#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
mkdir -p cache

echo "A actualizar dados da API Stop&Go..."
if python3 "$DIR/refresh_data.py"; then
  :
else
  echo "Tentativa offline com cache..."
  python3 "$DIR/refresh_data.py" --offline
fi

echo ""
echo "Actualizado: $(grep -m1 updatedAt data.json 2>/dev/null || echo 'ver data.json')"
if [ -d "$DIR/raw" ]; then
  echo "Raw API:     $DIR/raw/ ($(ls -1 "$DIR/raw"/*_latest.* 2>/dev/null | wc -l | tr -d ' ') ficheiros latest)"
fi
echo "Abrir: ./serve.sh  ->  http://localhost:8080"
echo "(Recarrega a pagina no browser com Cmd+Shift+R)"
