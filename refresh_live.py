#!/usr/bin/env python3
"""Lightweight refresh: live GPS position + map marker + goal pace-now references."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import km_splits as km
from refresh_data import (
    DATA_DIR,
    ETAPA,
    EVENTO,
    RACE_START,
    build_map_data,
    fetch_live_position,
    load_live_from_cache,
    pos_at_distance_m,
    strip_proxy_env,
)
from git_publish_data import print_publish_result, publish_data_changes

DIR = Path(__file__).resolve().parent


def _fmt_pace(seconds_per_km: float) -> str:
    if seconds_per_km <= 0:
        return "-"
    m = int(seconds_per_km // 60)
    s = int(round(seconds_per_km - 60 * m))
    return f"{m}:{s:02d}/km"


def _update_goal_time_fields(goal, *, total_km, current_km, coords, dist_m):
    record_dur_s = int((9 * 24 + 2) * 3600 + 29 * 60)
    try:
        start_dt = km.parse_time(goal.get("_raceStart") or RACE_START)
    except Exception:
        start_dt = km.parse_time(RACE_START)
    record_deadline = start_dt + timedelta(seconds=record_dur_s)
    calendar_deadline = datetime(2026, 5, 31, 23, 59, 59)
    remaining_km = max(0.1, total_km - current_km)
    now_dt = datetime.now()
    sec_left_record = max(0.0, (record_deadline - now_dt).total_seconds())
    sec_left_calendar = max(0.0, (calendar_deadline - now_dt).total_seconds())
    goal["recordDeadlineFromStart"] = record_deadline.strftime("%Y-%m-%d %H:%M:%S")
    goal["calendarDeadline"] = calendar_deadline.strftime("%Y-%m-%d %H:%M:%S")
    goal["requiredPaceRecord"] = _fmt_pace(sec_left_record / remaining_km)
    goal["requiredPaceCalendar"] = _fmt_pace(sec_left_calendar / remaining_km)
    goal["requiredClockPaceRecord"] = goal["requiredPaceRecord"]
    goal["requiredClockPaceCalendar"] = goal["requiredPaceCalendar"]
    goal["hoursLeftCalendar"] = round(sec_left_calendar / 3600, 1)
    goal["kmPerDayCalendar"] = round(remaining_km / max(1.0, sec_left_calendar) * 86400, 1)
    goal["kmPerHourCalendar"] = round(remaining_km / max(1.0, sec_left_calendar) * 3600, 2)
    goal["remainingKm"] = round(remaining_km, 1)
    elapsed_s = max(0.0, (now_dt - start_dt).total_seconds())
    record_km_now = min(total_km, (elapsed_s / max(1.0, record_dur_s)) * total_km)
    rp_pos = pos_at_distance_m(coords, dist_m, record_km_now * 1000.0)
    goal["recordPaceNow"] = {
        "km": round(record_km_now, 1),
        "lat": round(rp_pos[0], 6),
        "lng": round(rp_pos[1], 6),
        "alt": round(rp_pos[2], 1),
        "time": now_dt.strftime("%Y-%m-%d %H:%M:%S"),
    }
    cal_total_s = max(1.0, (calendar_deadline - start_dt).total_seconds())
    cal_km_now = min(total_km, (elapsed_s / cal_total_s) * total_km)
    cal_pos = pos_at_distance_m(coords, dist_m, cal_km_now * 1000.0)
    goal["calendarPaceNow"] = {
        "km": round(cal_km_now, 1),
        "lat": round(cal_pos[0], 6),
        "lng": round(cal_pos[1], 6),
        "alt": round(cal_pos[2], 1),
        "time": now_dt.strftime("%Y-%m-%d %H:%M:%S"),
        "deadline": calendar_deadline.strftime("%Y-%m-%d %H:%M:%S"),
    }


def refresh_live(*, offline: bool = False, git: bool = True, git_push: bool = True) -> dict:
    data_path = DIR / "data.json"
    if not data_path.exists():
        return {"ok": False, "error": "data.json missing - run refresh_data.py first"}
    analytics = json.loads(data_path.read_text(encoding="utf-8"))
    log_path = DATA_DIR / "gps_log.json"
    log = json.loads(log_path.read_text(encoding="utf-8")) if log_path.exists() else []
    coords, dist_m = km.load_route(str(DATA_DIR / "route.json"), EVENTO, ETAPA)
    total_km = dist_m[-1] / 1000.0
    current_km = float(analytics.get("current", {}).get("km") or 0)
    api_live = False
    live = None
    if not offline:
        live, _ = fetch_live_position(coords, dist_m)
        if live:
            api_live = True
            live["logTime"] = log[-1]["Time"] if log else None
            (DATA_DIR / "live_position.json").write_text(
                json.dumps(live, ensure_ascii=False, indent=2), encoding="utf-8"
            )
    if not live:
        live = load_live_from_cache()
    if not live:
        return {"ok": False, "error": "no live position"}
    analytics["live"] = live
    analytics["liveUpdatedAt"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    goal = dict(analytics.get("event", {}).get("goal") or {})
    _update_goal_time_fields(
        goal, total_km=total_km, current_km=current_km, coords=coords, dist_m=dist_m
    )
    goal.pop("_raceStart", None)
    analytics.setdefault("event", {})["goal"] = goal
    prediction = analytics.get("prediction") or {}
    proj_km = float(live.get("alongRouteKm") or current_km)
    try:
        proj_time = km.parse_time(live["gpsTime"])
    except Exception:
        proj_time = datetime.now()
    map_data = build_map_data(
        coords,
        dist_m,
        log,
        analytics.get("splits") or [],
        live=live,
        goal=goal,
        forecast=prediction.get("forecast") or [],
        projection_km=proj_km,
        projection_time=proj_time,
    )
    analytics["map"] = map_data
    data_path.write_text(json.dumps(analytics, ensure_ascii=False, indent=2), encoding="utf-8")
    (DIR / "data.js").write_text(
        "window.ANALYTICS = " + json.dumps(analytics, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    result = {
        "ok": True,
        "apiLive": api_live,
        "fromCache": not api_live,
        "liveGpsTime": live.get("gpsTime"),
        "liveUpdatedAt": analytics["liveUpdatedAt"],
        "updatedAt": analytics.get("updatedAt"),
        "alongRouteKm": live.get("alongRouteKm"),
        "mapCurrent": map_data.get("current"),
        "goal": goal,
        "live": live,
    }

    if git:
        git_result = publish_data_changes(
            DIR,
            paths=("data.js", "data.json"),
            kind="live",
            push=git_push,
        )
        result["git"] = git_result
        if not git_result.get("ok"):
            result["gitError"] = git_result.get("error")

    return result


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="Use cached live position only")
    ap.add_argument("--no-git", action="store_true", help="Do not auto-commit/push data files")
    ap.add_argument("--no-push", action="store_true", help="Commit only, do not push")
    args = ap.parse_args()
    if not args.offline:
        strip_proxy_env()
    result = refresh_live(
        offline=args.offline,
        git=not args.no_git,
        git_push=not args.no_push,
    )
    if not result.get("ok"):
        print(result.get("error", "refresh_live failed"), file=sys.stderr)
        return 1
    print(
        f"LIVE_OK gps={result.get('liveGpsTime')} km~{result.get('alongRouteKm')} "
        f"api={'online' if result.get('apiLive') else 'cache'}"
    )
    if result.get("git"):
        print_publish_result(result["git"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
