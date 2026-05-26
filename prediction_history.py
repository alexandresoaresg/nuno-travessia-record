"""Append-only history of prediction snapshots for model calibration and review."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from goal_confidence import build_model_reliability_summary, compute_goal_confidence

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
    recent_pace_min: float | None = None,
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
    recent_km_day = round((24 * 60) / recent_pace_min, 2) if recent_pace_min else None
    return {
        "kmDayGlobal": round(current_km / (elapsed_h / 24), 2) if elapsed_h > 0 else None,
        "kmAt40": float(km_at40) if km_at40 is not None else None,
        "kmDay40": round((km_at40 / 40) * 24, 2) if km_at40 is not None else None,
        "weightedKmDay": round((24 * 60) / weighted_pace_min, 2) if weighted_pace_min else None,
        "recentKmDay": recent_km_day,
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
        perf.get("recentPaceMin"),
    )

    finishes = _scenario_finishes(pred)
    finishes["_proven"] = proven

    remaining = float(goal.get("remainingKm") or current.get("remainingKm") or 0)
    rec_km_day = _required_km_per_day(goal.get("recordDeadlineFromStart", ""), remaining)

    stale_h = pred.get("dataStaleHours")
    anchor = pred.get("projectionAnchor")
    regime_info = pred.get("regime") or {}
    regime = regime_info.get("regime") if isinstance(regime_info, dict) else regime_info
    conf_kw = dict(
        finishes=finishes,
        performance=perf,
        data_stale_hours=stale_h,
        projection_anchor=anchor,
        confidence_pct=pred.get("confidencePct"),
        regime=regime,
        forecast_suspended=bool(pred.get("forecastSuspended")),
    )
    cal_conf = compute_goal_confidence(
        deadline_str=goal.get("calendarDeadline", ""),
        required_pace_str=goal.get("requiredPaceCalendar"),
        required_km_day=goal.get("kmPerDayCalendar"),
        reference_km=(goal.get("calendarPaceNow") or {}).get("km"),
        current_km=int(current.get("km") or 0),
        **conf_kw,
    )
    rec_conf = compute_goal_confidence(
        deadline_str=goal.get("recordDeadlineFromStart", ""),
        required_pace_str=goal.get("requiredPaceRecord"),
        required_km_day=rec_km_day,
        reference_km=(goal.get("recordPaceNow") or {}).get("km"),
        current_km=int(current.get("km") or 0),
        **conf_kw,
    )
    model_reliability = build_model_reliability_summary(pred, perf)

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
        "modelReliability": model_reliability,
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
