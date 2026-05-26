#!/usr/bin/env python3
"""Static server with /api/refresh to rebuild data.js on each page load."""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

DIR = Path(__file__).resolve().parent
MIN_REFRESH_INTERVAL_S = 15

_refresh_lock = threading.Lock()
_last_refresh_at = 0.0
_last_refresh_result: dict | None = None


def run_refresh() -> dict:
    global _last_refresh_at, _last_refresh_result
    with _refresh_lock:
        now = time.time()
        if _last_refresh_result and (now - _last_refresh_at) < MIN_REFRESH_INTERVAL_S:
            out = dict(_last_refresh_result)
            out["skipped"] = True
            out["nextRefreshInSec"] = round(
                MIN_REFRESH_INTERVAL_S - (now - _last_refresh_at)
            )
            return out

        t0 = time.time()
        proc = subprocess.run(
            [sys.executable, str(DIR / "refresh_data.py")],
            cwd=str(DIR),
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            proc = subprocess.run(
                [sys.executable, str(DIR / "refresh_data.py"), "--offline"],
                cwd=str(DIR),
                capture_output=True,
                text=True,
            )

        updated_at = None
        live_time = None
        data_path = DIR / "data.json"
        if data_path.exists():
            try:
                data = json.loads(data_path.read_text(encoding="utf-8"))
                updated_at = data.get("updatedAt")
                live = data.get("live") or {}
                live_time = live.get("gpsTime")
            except (json.JSONDecodeError, OSError):
                pass

        _last_refresh_at = time.time()
        _last_refresh_result = {
            "ok": proc.returncode == 0,
            "skipped": False,
            "updatedAt": updated_at,
            "liveGpsTime": live_time,
            "durationSec": round(_last_refresh_at - t0, 1),
        }
        if proc.returncode != 0:
            _last_refresh_result["error"] = (
                proc.stderr.strip() or proc.stdout.strip() or "refresh failed"
            )[-500:]
        return dict(_last_refresh_result)


class AnalyticsHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIR), **kwargs)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/refresh":
            self._send_refresh()
            return
        super().do_GET()

    def _send_refresh(self):
        result = run_refresh()
        body = json.dumps(result, ensure_ascii=False).encode("utf-8")
        self.send_response(200 if result.get("ok") else 503)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    server = ThreadingHTTPServer(("127.0.0.1", port), AnalyticsHandler)
    print(f"Servidor: http://127.0.0.1:{port}")
    print("Refresh automatico: GET /api/refresh (ao carregar a pagina)")
    print("(Ctrl+C para parar)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
