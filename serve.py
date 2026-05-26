#!/usr/bin/env python3
"""Static server with background data refresh (live 1 min, full 5 min)."""

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

from background_pipeline import start_worker

DIR = Path(__file__).resolve().parent
LIVE_INTERVAL_S = 60
FULL_INTERVAL_S = 300

_live_lock = threading.Lock()
_full_lock = threading.Lock()
_full_in_progress = threading.Event()
_state_lock = threading.Lock()
_state: dict = {
    "lastLiveAt": 0.0,
    "lastFullAt": 0.0,
    "lastLiveResult": None,
    "lastFullResult": None,
    "schedulerStarted": False,
}

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
    env = os.environ.copy()
    for key in _PROXY_KEYS:
        env.pop(key, None)
    return env


def _read_data_meta() -> dict:
    data_path = DIR / "data.json"
    if not data_path.exists():
        return {}
    try:
        data = json.loads(data_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    live = data.get("live") or {}
    return {
        "updatedAt": data.get("updatedAt"),
        "liveUpdatedAt": data.get("liveUpdatedAt"),
        "liveGpsTime": live.get("gpsTime"),
        "dataVersion": data.get("updatedAt"),
    }


def _run_script(script: str, *extra: str) -> dict:
    env = _subprocess_env()
    proc = subprocess.run(
        [sys.executable, str(DIR / script), *extra],
        cwd=str(DIR),
        capture_output=True,
        text=True,
        env=env,
    )
    combined = (proc.stdout or "") + (proc.stderr or "")
    meta = _read_data_meta()
    api_live = "live=online" in combined or "LIVE_OK" in combined
    api_log = "log=online" in combined
    ok = proc.returncode == 0 and (
        bool(meta.get("updatedAt")) or "LIVE_OK" in combined
    )
    return {
        "ok": ok,
        "apiLive": api_live,
        "apiLog": api_log,
        "fromCache": not api_live and not api_log and ok,
        "durationSec": None,
        **meta,
        "error": None if ok else (combined.strip()[-500:] or "failed"),
    }


def _live_patch_from_disk() -> dict:
    data_path = DIR / "data.json"
    if not data_path.exists():
        return {"ok": False}
    try:
        data = json.loads(data_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"ok": False}
    goal = dict(data.get("event", {}).get("goal") or {})
    goal.pop("_raceStart", None)
    live = data.get("live")
    return {
        "ok": bool(live),
        "live": live,
        "liveUpdatedAt": data.get("liveUpdatedAt"),
        "mapCurrent": (data.get("map") or {}).get("current"),
        "goal": goal,
        "updatedAt": data.get("updatedAt"),
        "dataVersion": data.get("updatedAt"),
        "liveGpsTime": (live or {}).get("gpsTime"),
    }


def get_live_payload() -> dict:
    patch = _live_patch_from_disk()
    with _state_lock:
        now = time.time()
        last = _state["lastLiveAt"]
        if last:
            patch["nextLiveInSec"] = round(max(0, LIVE_INTERVAL_S - (now - last)))
        patch["scheduler"] = _state["schedulerStarted"]
    return patch


def run_live_refresh(force: bool = False) -> dict:
    if not force:
        return get_live_payload()

    if _full_in_progress.is_set():
        out = get_live_payload()
        out["skipped"] = True
        out["reason"] = "full_refresh_in_progress"
        return out

    with _live_lock:
        now = time.time()
        with _state_lock:
            last = _state["lastLiveAt"]
            if not force and last and (now - last) < LIVE_INTERVAL_S - 5:
                out = dict(_state["lastLiveResult"] or get_live_payload())
                out["skipped"] = True
                out["nextLiveInSec"] = round(LIVE_INTERVAL_S - (now - last))
                return out

        t0 = time.time()
        result = _run_script("refresh_live.py")
        if not result.get("ok"):
            fallback = _run_script("refresh_live.py", "--offline")
            if fallback.get("ok"):
                result = fallback

        result["durationSec"] = round(time.time() - t0, 1)
        result["skipped"] = False
        result["nextLiveInSec"] = LIVE_INTERVAL_S
        result.update(_live_patch_from_disk())

        with _state_lock:
            _state["lastLiveAt"] = time.time()
            _state["lastLiveResult"] = dict(result)
        return dict(result)


def run_refresh(force: bool = False) -> dict:
    if not force:
        return get_status()

    with _full_lock:
        _full_in_progress.set()
        try:
            now = time.time()
            with _state_lock:
                last = _state["lastFullAt"]
                if not force and last and (now - last) < FULL_INTERVAL_S - 10:
                    out = dict(_state["lastFullResult"] or get_status())
                    out["skipped"] = True
                    out["nextFullInSec"] = round(FULL_INTERVAL_S - (now - last))
                    return out

            t0 = time.time()
            result = _run_script("refresh_data.py")
            if not result.get("ok"):
                result = _run_script("refresh_data.py", "--offline")

            result["durationSec"] = round(time.time() - t0, 1)
            result["skipped"] = False
            result["nextFullInSec"] = FULL_INTERVAL_S
            result["dataVersion"] = result.get("updatedAt")

            with _state_lock:
                _state["lastFullAt"] = time.time()
                _state["lastFullResult"] = dict(result)
            return dict(result)
        finally:
            _full_in_progress.clear()


def get_status() -> dict:
    with _state_lock:
        now = time.time()
        last_live = _state["lastLiveAt"]
        last_full = _state["lastFullAt"]
        last_live_result = _state["lastLiveResult"]
        last_full_result = _state["lastFullResult"]
        meta = _read_data_meta()
        last_error = None
        for res in (last_full_result, last_live_result):
            if res and not res.get("ok") and res.get("error"):
                last_error = str(res["error"]).split("\n")[0][:200]
                break
        return {
            "ok": bool(meta.get("updatedAt")),
            "scheduler": _state["schedulerStarted"],
            "liveIntervalSec": LIVE_INTERVAL_S,
            "fullIntervalSec": FULL_INTERVAL_S,
            "lastLiveAt": _ts(last_live),
            "lastFullAt": _ts(last_full),
            "lastRefreshOk": bool(
                (last_full_result or {}).get("ok") or (last_live_result or {}).get("ok")
            ),
            "lastError": last_error,
            "nextLiveInSec": round(max(0, LIVE_INTERVAL_S - (now - last_live)))
            if last_live
            else LIVE_INTERVAL_S,
            "nextFullInSec": round(max(0, FULL_INTERVAL_S - (now - last_full)))
            if last_full
            else FULL_INTERVAL_S,
            **meta,
        }


def _ts(epoch: float) -> str | None:
    if not epoch:
        return None
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(epoch))


def _background_scheduler() -> None:
    """Server-side refresh; clients only read updated files."""
    time.sleep(2)

    def run_full():
        run_refresh(force=True)

    def run_live():
        run_live_refresh(force=True)

    threading.Thread(target=run_full, daemon=True, name="travessia-full-0").start()
    time.sleep(1)
    threading.Thread(target=run_live, daemon=True, name="travessia-live-0").start()

    next_live = time.time() + LIVE_INTERVAL_S
    next_full = time.time() + FULL_INTERVAL_S
    while True:
        now = time.time()
        if now >= next_full:
            threading.Thread(target=run_full, daemon=True, name="travessia-full").start()
            next_full = now + FULL_INTERVAL_S
            next_live = now + LIVE_INTERVAL_S
        elif now >= next_live:
            threading.Thread(target=run_live, daemon=True, name="travessia-live").start()
            next_live = now + LIVE_INTERVAL_S
        time.sleep(1)


def start_background_scheduler() -> None:
    with _state_lock:
        if _state["schedulerStarted"]:
            return
        _state["schedulerStarted"] = True
    t = threading.Thread(target=_background_scheduler, name="travessia-refresh", daemon=True)
    t.start()


class AnalyticsHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIR), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        force = qs.get("force", ["0"])[0] in ("1", "true", "yes")

        if path == "/api/status":
            self._send_json(get_status())
            return
        if path == "/api/live":
            self._send_json(run_live_refresh(force=force))
            return
        if path == "/api/refresh":
            self._send_json(run_refresh(force=force))
            return
        if path == "/api/analytics":
            self._send_analytics()
            return
        super().do_GET()

    def _send_json(self, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200 if payload.get("ok", True) else 503)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_analytics(self) -> None:
        data_path = DIR / "data.json"
        if not data_path.exists():
            self._send_json({"ok": False, "error": "data.json missing"})
            return
        body = data_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    start_worker()
    start_background_scheduler()
    server = ThreadingHTTPServer(("127.0.0.1", port), AnalyticsHandler)
    print(f"Servidor: http://127.0.0.1:{port}")
    print(f"Background: posicao live cada {LIVE_INTERVAL_S}s · dados completos cada {FULL_INTERVAL_S}s")
    print("API: /api/status · /api/live · /api/analytics (refresh so no servidor; ?force=1 manual)")
    print("(Ctrl+C para parar)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
