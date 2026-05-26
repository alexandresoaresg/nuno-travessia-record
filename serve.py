#!/usr/bin/env python3
"""Static server with /api/refresh to rebuild data.js on each page load."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DIR = Path(__file__).resolve().parent
MIN_REFRESH_INTERVAL_S = 15

_refresh_lock = threading.Lock()
_last_refresh_at = 0.0
_last_refresh_result: dict | None = None

_PROXY_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "GIT_HTTP_PROXY",
    "GIT_HTTPS_PROXY",
    "SOCKS_PROXY",
    "SOCKS5_PROXY",
    "socks_proxy",
    "socks5_proxy",
)


def _subprocess_env() -> dict[str, str]:
    """Child refresh without IDE proxy (avoids Tunnel connection failed 403)."""
    env = os.environ.copy()
    for key in _PROXY_KEYS:
        env.pop(key, None)
    return env


def run_refresh(force: bool = False) -> dict:
    global _last_refresh_at, _last_refresh_result
    with _refresh_lock:
        now = time.time()
        if (
            not force
            and _last_refresh_result
            and (now - _last_refresh_at) < MIN_REFRESH_INTERVAL_S
        ):
            out = dict(_last_refresh_result)
            out["skipped"] = True
            out["nextRefreshInSec"] = round(
                MIN_REFRESH_INTERVAL_S - (now - _last_refresh_at)
            )
            return out

        t0 = time.time()
        env = _subprocess_env()
        proc = subprocess.run(
            [sys.executable, str(DIR / "refresh_data.py")],
            cwd=str(DIR),
            capture_output=True,
            text=True,
            env=env,
        )
        combined = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            proc = subprocess.run(
                [sys.executable, str(DIR / "refresh_data.py"), "--offline"],
                cwd=str(DIR),
                capture_output=True,
                text=True,
                env=env,
            )
            combined = (proc.stdout or "") + (proc.stderr or "")

        updated_at = None
        live_time = None
        data_path = DIR / "data.json"
        data_ok = False
        if data_path.exists():
            try:
                data = json.loads(data_path.read_text(encoding="utf-8"))
                updated_at = data.get("updatedAt")
                live = data.get("live") or {}
                live_time = live.get("gpsTime")
                data_ok = bool(data.get("splits"))
            except (json.JSONDecodeError, OSError):
                pass

        api_live = "live=online" in combined
        api_log = "log=online" in combined
        _last_refresh_at = time.time()
        _last_refresh_result = {
            "ok": data_ok or proc.returncode == 0,
            "apiOnline": api_live or api_log,
            "apiLive": api_live,
            "apiLog": api_log,
            "fromCache": not api_live and not api_log and data_ok,
            "skipped": False,
            "updatedAt": updated_at,
            "liveGpsTime": live_time,
            "durationSec": round(_last_refresh_at - t0, 1),
        }
        if not _last_refresh_result["ok"]:
            _last_refresh_result["error"] = combined.strip()[-500:] or "refresh failed"
        return dict(_last_refresh_result)


class AnalyticsHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIR), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/refresh":
            qs = parse_qs(parsed.query)
            force = qs.get("force", ["0"])[0] in ("1", "true", "yes")
            self._send_refresh(force=force)
            return
        super().do_GET()

    def _send_refresh(self, force: bool = False):
        result = run_refresh(force=force)
        body = json.dumps(result, ensure_ascii=False).encode("utf-8")
        self.send_response(200 if result.get("ok") else 503)  # body always JSON
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
