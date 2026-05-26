"""Segment race into days between long night stops (>= 60 min)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

LONG_STOP_THRESHOLD_S = 3600


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    return None


def _fmt_duration(seconds: float | None) -> str:
    if seconds is None or seconds < 0:
        return "—"
    s = int(round(seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m"
    if m:
        return f"{m}m {sec:02d}s"
    return f"{sec}s"


def _pace_str(pace_min: float | None) -> str:
    if pace_min is None or pace_min <= 0:
        return "—"
    m = int(pace_min)
    sec = int(round((pace_min - m) * 60))
    return f"{m}:{sec:02d}/km"


def _usable_splits(splits: list[dict]) -> list[dict]:
    return [
        s
        for s in splits
        if not s.get("unavailable") and not s.get("partial") and s.get("crossing_time")
    ]


def _night_blocks(usable: list[dict]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    i = 0
    while i < len(usable):
        seg = usable[i]
        t = seg.get("segment_time_s") or 0
        if t < LONG_STOP_THRESHOLD_S:
            i += 1
            continue
        km_from = seg["km"]
        km_to = seg["km"]
        total_s = t
        end_cross = seg.get("crossing_time")
        j = i + 1
        while j < len(usable) and (usable[j].get("segment_time_s") or 0) >= LONG_STOP_THRESHOLD_S:
            total_s += usable[j].get("segment_time_s") or 0
            km_to = usable[j]["km"]
            end_cross = usable[j].get("crossing_time")
            j += 1
        blocks.append(
            {
                "kmFrom": km_from,
                "kmTo": km_to,
                "durationMin": round(total_s / 60, 1),
                "duration": _fmt_duration(total_s),
                "endCrossing": end_cross,
            }
        )
        i = j
    return blocks


def _km_distance(km_from: int, km_to: int) -> int:
    """Km covered along route from km_from through km_to (continuous, km 0 = start)."""
    return max(0, int(km_to) - int(km_from))


def build_days(
    splits: list[dict],
    *,
    race_start: str,
    current_km: int | None = None,
    profile_full: list[dict] | None = None,
    goal_km_per_day: float | None = None,
) -> dict[str, Any]:
    usable = _usable_splits(splits)
    if not usable:
        return {"days": [], "nightStops": [], "longStopThresholdMin": LONG_STOP_THRESHOLD_S // 60}

    nights = _night_blocks(usable)
    prof_by_km = {int(p["km"]): p for p in (profile_full or []) if p.get("km") is not None}

    # Continuous km ranges: day 1 from 0; each next day starts where previous ended.
    ranges: list[tuple[int, int, dict | None]] = []
    day_start = 0
    for nb in nights:
        day_end = nb["kmFrom"] - 1
        if day_end >= day_start:
            ranges.append((day_start, day_end, nb))
        day_start = nb["kmFrom"]

    last_km = int(current_km if current_km is not None else usable[-1]["km"])
    if last_km >= day_start:
        ranges.append((day_start, last_km, None))

    days: list[dict[str, Any]] = []
    for idx, (km_from, km_to, night_after) in enumerate(ranges, start=1):
        day_segs = [s for s in usable if km_from <= s["km"] <= km_to]
        moving_s = 0.0
        stop_s = 0.0
        cat_counts: dict[str, int] = {}
        for s in day_segs:
            t = float(s.get("segment_time_s") or 0)
            cat = s.get("category") or "unknown"
            if t >= LONG_STOP_THRESHOLD_S:
                stop_s += t
            else:
                moving_s += t
                cat_counts[cat] = cat_counts.get(cat, 0) + 1

        km_done = _km_distance(km_from, km_to)
        if km_from <= 0:
            start_cross = race_start
        elif day_segs:
            start_cross = day_segs[0].get("crossing_time")
        else:
            start_cross = race_start
        end_cross = day_segs[-1].get("crossing_time") if day_segs else None
        start_t = _parse_dt(start_cross) or _parse_dt(race_start)
        end_t = _parse_dt(end_cross)
        span_s = (end_t - start_t).total_seconds() if start_t and end_t else None
        active_hours = moving_s / 3600 if moving_s else None
        km_per_day = (km_done / active_hours * 24) if active_hours and active_hours > 0 and km_done else None
        moving_pace_min = (moving_s / 60) / km_done if km_done > 0 and moving_s > 0 else None

        gain = loss = 0.0
        for k in range(km_from, km_to + 1):
            p = prof_by_km.get(k)
            if p:
                gain += float(p.get("gain") or 0)
                loss += float(p.get("loss") or 0)

        in_progress = night_after is None and current_km is not None and km_to >= current_km

        day: dict[str, Any] = {
            "day": idx,
            "label": f"Dia {idx}" + (" · em curso" if in_progress else ""),
            "kmFrom": km_from,
            "kmTo": km_to,
            "km": km_done,
            "startTime": start_cross,
            "endTime": end_cross if not in_progress else None,
            "spanHours": round(span_s / 3600, 2) if span_s else None,
            "movingHours": round(active_hours, 2) if active_hours else None,
            "movingTime": _fmt_duration(moving_s),
            "shortStopMin": round(stop_s / 60, 1) if stop_s else 0,
            "kmPerDay": round(km_per_day, 1) if km_per_day else None,
            "movingPaceMin": round(moving_pace_min, 2) if moving_pace_min else None,
            "movingPace": _pace_str(moving_pace_min),
            "gainM": round(gain, 0),
            "lossM": round(loss, 0),
            "inProgress": in_progress,
            "categories": cat_counts,
            "nightAfter": night_after,
            "splitsFromKm": day_segs[0]["km"] if day_segs else None,
            "splitsToKm": day_segs[-1]["km"] if day_segs else None,
        }
        if goal_km_per_day and km_per_day is not None:
            day["vsGoalKmDay"] = round(km_per_day - goal_km_per_day, 1)
        days.append(day)

    return {
        "days": days,
        "nightStops": nights,
        "longStopThresholdMin": LONG_STOP_THRESHOLD_S // 60,
        "method": "Paragem noturna >=60 min (v4). Dia = km continuos desde 0; estatisticas dos splits disponiveis.",
    }
