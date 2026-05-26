"""Append-only history of prediction snapshots for model calibration and review."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

HISTORY_DIR = Path(__file__).resolve().parent / "history"
JSONL_PATH = HISTORY_DIR / "predictions.jsonl"
LATEST_PATH = HISTORY_DIR / "latest_snapshot.json"
MAX_JSONL_BYTES = 12 * 1024 * 1024


def _parse_pace_sec(pace_str: str | None) -> float | None:
    if not pace_str:
        return None
    m = re.match(r"(\d+):(\d+)/km", str(pace_str).strip())
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    return None


def _margin_minutes(deadline_str: str, finish_str: str | None) -> int | None:
    dl = _parse_dt(deadline_str)
    fin = _parse_dt(finish_str)
    if not dl or not fin:
        return None
    return round((dl - fin).total_seconds() / 60)


def _required_km_per_day(deadline_str: str, remaining_km: float) -> float | None:
    dl = _parse_dt(deadline_str)
    if not dl or remaining_km <= 0:
        return None
    hours_left = (dl - datetime.now()).total_seconds() / 3600
    if hours_left <= 0:
        return None
    return remaining_km / (hours_left / 24)


def proven_pace_stats(
    splits: list[dict],
    current_km: int,
    race_start: str,
    last_crossing: str,
    weighted_pace_min: float | None,
) -> dict[str, float | None]:
    start = _parse_dt(race_start) or _parse_dt(last_crossing)
    last = _parse_dt(last_crossing)
    if not start or not last:
        return {"kmDayGlobal": None, "kmAt40": None, "kmDay40": None, "weightedKmDay": None}

    km_at40 = None
    for s in splits:
        if s.get("unavailable") or s.get("partial") or not s.get("crossing_time"):
            continue
        ct = _parse_dt(s["crossing_time"])
        if not ct:
            continue
        h = (ct - start).total_seconds() / 3600
        if h <= 40:
            km_at40 = s["km"]

    elapsed_h = (last - start).total_seconds() / 3600
    return {
        "kmDayGlobal": round(current_km / (elapsed_h / 24), 2) if elapsed_h > 0 else None,
        "kmAt40": float(km_at40) if km_at40 is not None else None,
        "kmDay40": round((km_at40 / 40) * 24, 2) if km_at40 is not None else None,
        "weightedKmDay": round((24 * 60) / weighted_pace_min, 2) if weighted_pace_min else None,
    }


def compute_goal_confidence(
    *,
    deadline_str: str,
    required_pace_str: str | None,
    required_km_day: float | None,
    reference_km: float | None,
    current_km: int,
    finishes: dict[str, dict[str, Any]],
    performance: dict[str, Any],
) -> dict[str, Any]:
    weighted = performance.get("weightedPaceMin")
    m_opt = _margin_minutes(deadline_str, finishes.get("optimistic", {}).get("finish"))
    m_main = _margin_minutes(deadline_str, finishes.get("main", {}).get("finish"))
    m_pes = _margin_minutes(deadline_str, finishes.get("pessimistic", {}).get("finish"))
    if m_pes is None or m_main is None:
        return {"pct": None, "margins": {}}

    proven = finishes.get("_proven") or {}
    main_sc = finishes.get("main") or {}
    projected_km_day = main_sc.get("kmPerDay")
    demonstrated_candidates = [
        proven.get("kmDay40"),
        proven.get("kmDayGlobal"),
        projected_km_day,
    ]
    demonstrated_candidates = [
        float(v) for v in demonstrated_candidates if v is not None and float(v) > 0
    ]
    demonstrated = min(demonstrated_candidates) if demonstrated_candidates else None
    req_km_day = required_km_day

    pct = 0
    if m_pes >= 720:
        pct = 92 + min(5, (m_pes - 720) // 360)
    elif m_pes >= 360:
        pct = 86 + min(6, (m_pes - 360) // 60)
    elif m_pes >= 180:
        pct = 78 + min(8, (m_pes - 180) // 30)
    elif m_pes >= 60:
        pct = 68 + min(10, (m_pes - 60) // 12)
    elif m_pes >= 0:
        pct = 58 + min(10, m_pes // 6)
    elif m_pes >= -180:
        pct = 42 + min(18, (m_main + 180) // 25)
    elif m_pes >= -720:
        pct = 22 + min(22, (m_main + 360) // 30)
    elif m_main >= 0:
        pct = 36 + min(22, m_main // 12)
    else:
        pct = 8 + min(14, max(0, m_main + 720) // 90)

    if demonstrated is not None and req_km_day and req_km_day > 0:
        demo_ratio = demonstrated / req_km_day
        if m_pes >= 0:
            if demo_ratio >= 1.2:
                pct += 6
            elif demo_ratio >= 1.05:
                pct += 3
            elif demo_ratio >= 0.92:
                pass
            elif demo_ratio >= 0.8:
                pct -= 8
            else:
                pct -= 18
        elif m_pes >= -360:
            if demo_ratio >= 1.15:
                pct += 3
            elif demo_ratio < 0.9:
                pct -= 10
        elif demo_ratio < 1.0:
            pct -= 12

    req_sec = _parse_pace_sec(required_pace_str)
    km_day_proj = main_sc.get("kmPerDay")
    proj_sec = (24 * 3600 / km_day_proj) if km_day_proj and km_day_proj > 0 else None
    if req_sec and proj_sec:
        headroom = (req_sec - proj_sec) / req_sec
        if headroom > 0.08:
            pct += 6
        elif headroom > 0.02:
            pct += 3
        elif headroom < -0.08:
            pct -= min(18, round(-headroom * 35))

    if (
        m_pes >= 0
        and m_main >= 0
        and demonstrated is not None
        and req_km_day
        and demonstrated >= req_km_day * 1.05
    ):
        floor_demo = 52 + min(28, int(m_main / 15) + int((demonstrated / req_km_day - 1) * 22))
        pct = max(pct, floor_demo)

    if m_pes < 0:
        cap = 72
        if m_pes < -180:
            cap = 65 if m_main >= 0 else 50
        if m_pes < -720:
            cap = 58 if m_main >= 0 else 40
        if m_pes < -1200:
            cap = 52 if m_main >= 0 else 34
        if m_main < 0:
            cap = min(cap, 30)
        pct = min(pct, cap)

    stop_ratio = performance.get("stopRatioPct") or 0
    if m_pes < 180 and stop_ratio > 12:
        pct -= min(8, round((stop_ratio - 12) * 1.2))

    pct = round(max(5, min(92, pct)))
    return {
        "pct": pct,
        "margins": {"optimistic": m_opt, "main": m_main, "pessimistic": m_pes},
    }


def _scenario_finishes(prediction: dict[str, Any]) -> dict[str, dict[str, Any]]:
    scenarios = prediction.get("scenarios") or {}
    return {
        "main": {
            "finish": prediction.get("finishTimeIso") or prediction.get("finishTime"),
            "hours": prediction.get("remainingHours"),
            "kmPerDay": prediction.get("kmPerDayProjected"),
        },
        "optimistic": {
            "finish": prediction.get("optimisticFinishIso") or prediction.get("optimisticFinish"),
            "hours": scenarios.get("optimistic", {}).get("hours"),
            "kmPerDay": scenarios.get("optimistic", {}).get("kmPerDay"),
        },
        "pessimistic": {
            "finish": prediction.get("pessimisticFinishIso") or prediction.get("pessimisticFinish"),
            "hours": scenarios.get("pessimistic", {}).get("hours"),
            "kmPerDay": scenarios.get("pessimistic", {}).get("kmPerDay"),
        },
    }


def build_snapshot(analytics: dict[str, Any]) -> dict[str, Any]:
    pred = analytics.get("prediction") or {}
    perf = pred.get("performance") or {}
    goal = (analytics.get("event") or {}).get("goal") or {}
    current = analytics.get("current") or {}
    live = analytics.get("live")

    proven = proven_pace_stats(
        analytics.get("splits") or [],
        int(current.get("km") or 0),
        (analytics.get("event") or {}).get("startTime") or "",
        current.get("lastCrossing") or "",
        perf.get("weightedPaceMin") or pred.get("basePaceMin"),
    )

    finishes = _scenario_finishes(pred)
    finishes["_proven"] = proven

    remaining = float(goal.get("remainingKm") or current.get("remainingKm") or 0)
    rec_km_day = _required_km_per_day(goal.get("recordDeadlineFromStart", ""), remaining)

    cal_conf = compute_goal_confidence(
        deadline_str=goal.get("calendarDeadline", ""),
        required_pace_str=goal.get("requiredPaceCalendar"),
        required_km_day=goal.get("kmPerDayCalendar"),
        reference_km=(goal.get("calendarPaceNow") or {}).get("km"),
        current_km=int(current.get("km") or 0),
        finishes=finishes,
        performance=perf,
    )
    rec_conf = compute_goal_confidence(
        deadline_str=goal.get("recordDeadlineFromStart", ""),
        required_pace_str=goal.get("requiredPaceRecord"),
        required_km_day=rec_km_day,
        reference_km=(goal.get("recordPaceNow") or {}).get("km"),
        current_km=int(current.get("km") or 0),
        finishes=finishes,
        performance=perf,
    )

    sci = pred.get("science") or {}
    caps = sci.get("caps") if isinstance(sci.get("caps"), dict) else {}

    return {
        "recordedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "updatedAt": analytics.get("updatedAt"),
        "current": {
            "km": current.get("km"),
            "remainingKm": current.get("remainingKm"),
            "lastCrossing": current.get("lastCrossing"),
            "progressPct": current.get("progressPct"),
            "elapsed": current.get("elapsed"),
        },
        "live": (
            {
                "gpsTime": live.get("gpsTime"),
                "alongRouteKm": live.get("alongRouteKm"),
                "battery": live.get("battery"),
                "source": live.get("source"),
            }
            if live
            else None
        ),
        "goal": goal,
        "model": {
            "name": pred.get("model"),
            "version": pred.get("modelVersion"),
            "description": (pred.get("modelParams") or {}).get("description"),
            "params": pred.get("modelParams"),
            "scienceCaps": caps,
        },
        "performance": perf,
        "scenarios": {k: v for k, v in finishes.items() if not k.startswith("_")},
        "confidence": {"calendar": cal_conf, "record": rec_conf},
        "proven": proven,
        "forecastSample": (pred.get("forecast") or [])[:12],
    }


def _rotate_jsonl_if_needed() -> None:
    if not JSONL_PATH.exists() or JSONL_PATH.stat().st_size < MAX_JSONL_BYTES:
        return
    archived = HISTORY_DIR / f"predictions_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsonl"
    JSONL_PATH.rename(archived)
    with (HISTORY_DIR / "archive_index.txt").open("a", encoding="utf-8") as f:
        f.write(f"{archived.name}\n")


def append_snapshot(analytics: dict[str, Any]) -> Path:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    snap = build_snapshot(analytics)
    line = json.dumps(snap, ensure_ascii=False, separators=(",", ":"))
    _rotate_jsonl_if_needed()
    with JSONL_PATH.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    LATEST_PATH.write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")
    return JSONL_PATH


def load_latest() -> dict[str, Any] | None:
    if not LATEST_PATH.exists():
        return None
    return json.loads(LATEST_PATH.read_text(encoding="utf-8"))
