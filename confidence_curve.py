"""Confidence % along the route (recomputed at each km band)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from goal_confidence import compute_goal_confidence
from prediction_history import proven_pace_stats
from prediction_model import build_prediction, _parse_dt


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


def _record_km_day_at(deadline_str: str, remaining_km: float, as_of: datetime) -> float | None:
    dl = _parse_dt(deadline_str)
    if not dl or remaining_km <= 0:
        return None
    hours_left = (dl - as_of).total_seconds() / 3600
    if hours_left <= 0:
        return None
    return remaining_km / (hours_left / 24)


def _confidence_at_prediction(
    prediction: dict[str, Any],
    goal: dict[str, Any],
    *,
    current_km: int,
    last_crossing: str,
    race_start: str,
    splits: list[dict],
    total_km: float,
    as_of: datetime | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Same inputs as dashboard cards (server prediction snapshot)."""
    perf = prediction.get("performance") or {}
    finishes = _scenario_finishes(prediction)
    finishes["_proven"] = proven_pace_stats(
        splits,
        current_km,
        race_start,
        last_crossing,
        perf.get("weightedPaceMin") or prediction.get("basePaceMin"),
        perf.get("recentPaceMin"),
    )
    regime_info = prediction.get("regime") or {}
    regime = regime_info.get("regime") if isinstance(regime_info, dict) else regime_info
    now = as_of or datetime.now()
    remaining = max(0.0, total_km - current_km)
    rec_km_day = _record_km_day_at(goal.get("recordDeadlineFromStart", ""), remaining, now)

    conf_kw = dict(
        finishes=finishes,
        performance=perf,
        data_stale_hours=prediction.get("dataStaleHours"),
        projection_anchor=prediction.get("projectionAnchor"),
        confidence_pct=prediction.get("confidencePct"),
        regime=regime,
        forecast_suspended=bool(prediction.get("forecastSuspended")),
    )
    cal = compute_goal_confidence(
        deadline_str=goal.get("calendarDeadline", ""),
        required_pace_str=goal.get("requiredPaceCalendar"),
        required_km_day=goal.get("kmPerDayCalendar"),
        reference_km=(goal.get("calendarPaceNow") or {}).get("km"),
        current_km=current_km,
        **conf_kw,
    )
    rec = compute_goal_confidence(
        deadline_str=goal.get("recordDeadlineFromStart", ""),
        required_pace_str=goal.get("requiredPaceRecord"),
        required_km_day=rec_km_day,
        reference_km=(goal.get("recordPaceNow") or {}).get("km"),
        current_km=current_km,
        **conf_kw,
    )
    return cal, rec


def _upsert_current_point(
    points: list[dict[str, Any]],
    *,
    prediction: dict[str, Any],
    goal: dict[str, Any],
    current_km: int,
    last_crossing: str,
    race_start: str,
    splits: list[dict],
    total_km: float,
) -> list[dict[str, Any]]:
    cal, rec = _confidence_at_prediction(
        prediction,
        goal,
        current_km=current_km,
        last_crossing=last_crossing,
        race_start=race_start,
        splits=splits,
        total_km=total_km,
    )
    if cal.get("pct") is None:
        return points
    out = [p for p in points if p.get("km") != current_km]
    out.append(
        {
            "km": current_km,
            "time": last_crossing,
            "calendarPct": cal["pct"],
            "calendarBasePct": cal.get("basePct"),
            "recordPct": rec.get("pct"),
            "modelReliabilityPct": prediction.get("confidencePct"),
            "isCurrent": True,
        }
    )
    out.sort(key=lambda p: p["km"])
    return out


def build_confidence_curve(
    splits: list[dict],
    profile_full: list[dict],
    *,
    total_km: float,
    race_start: str,
    goal: dict[str, Any],
    step_km: int = 5,
    prediction: dict[str, Any] | None = None,
    current_km: int | None = None,
    last_crossing: str | None = None,
) -> dict[str, Any]:
    """Hybrid calendar/record confidence at each km (sampled every step_km)."""
    usable = [
        s
        for s in splits
        if not s.get("unavailable") and not s.get("partial") and s.get("crossing_time")
    ]
    if len(usable) < 3:
        return {"points": [], "stepKm": step_km}

    calendar_deadline = goal.get("calendarDeadline", "")
    record_deadline = goal.get("recordDeadlineFromStart", "")
    req_km_cal = goal.get("kmPerDayCalendar")
    remaining_total = float(goal.get("remainingKm") or 0)

    points: list[dict[str, Any]] = []
    last_km = usable[-1]["km"]

    for i, seg in enumerate(usable):
        km = int(seg["km"])
        if step_km > 1 and km != last_km and km % step_km != 0:
            continue
        cross = seg.get("crossing_time") or ""
        as_of = _parse_dt(cross)
        if not as_of:
            continue

        pred = build_prediction(
            splits,
            profile_full,
            km,
            total_km,
            cross,
            race_start,
            projection_time=as_of,
            projection_km=float(km),
            live=None,
            as_of=as_of,
        )
        perf = pred.get("performance") or {}
        finishes = _scenario_finishes(pred)
        proven = proven_pace_stats(
            splits,
            km,
            race_start,
            cross,
            perf.get("weightedPaceMin") or pred.get("basePaceMin"),
            perf.get("recentPaceMin"),
        )
        finishes["_proven"] = proven

        regime_info = pred.get("regime") or {}
        regime = regime_info.get("regime") if isinstance(regime_info, dict) else regime_info

        remaining = max(0.0, total_km - km)
        rec_km_day = None
        if record_deadline and remaining > 0:
            dl = _parse_dt(record_deadline)
            if dl:
                hours_left = (dl - as_of).total_seconds() / 3600
                if hours_left > 0:
                    rec_km_day = remaining / (hours_left / 24)

        conf_kw = dict(
            finishes=finishes,
            performance=perf,
            data_stale_hours=pred.get("dataStaleHours"),
            projection_anchor=pred.get("projectionAnchor"),
            confidence_pct=pred.get("confidencePct"),
            regime=regime,
            forecast_suspended=bool(pred.get("forecastSuspended")),
        )
        cal = compute_goal_confidence(
            deadline_str=calendar_deadline,
            required_pace_str=goal.get("requiredPaceCalendar"),
            required_km_day=req_km_cal,
            reference_km=(goal.get("calendarPaceNow") or {}).get("km"),
            current_km=km,
            **conf_kw,
        )
        rec = compute_goal_confidence(
            deadline_str=record_deadline,
            required_pace_str=goal.get("requiredPaceRecord"),
            required_km_day=rec_km_day,
            reference_km=(goal.get("recordPaceNow") or {}).get("km"),
            current_km=km,
            **conf_kw,
        )
        if cal.get("pct") is None:
            continue
        points.append(
            {
                "km": km,
                "time": cross,
                "calendarPct": cal["pct"],
                "calendarBasePct": cal.get("basePct"),
                "recordPct": rec.get("pct"),
                "modelReliabilityPct": pred.get("confidencePct"),
                "isCurrent": False,
            }
        )

    current_snapshot = None
    if prediction is not None and current_km is not None and last_crossing:
        points = _upsert_current_point(
            points,
            prediction=prediction,
            goal=goal,
            current_km=int(current_km),
            last_crossing=last_crossing,
            race_start=race_start,
            splits=splits,
            total_km=float(total_km),
        )
        last_pt = next((p for p in points if p.get("isCurrent")), None)
        if last_pt:
            current_snapshot = {
                "km": last_pt["km"],
                "calendarPct": last_pt["calendarPct"],
                "recordPct": last_pt["recordPct"],
            }

    return {
        "points": points,
        "stepKm": step_km,
        "current": current_snapshot,
        "label": "Confiança híbrida (31/05 e record) recalculada em cada km; o ponto actual coincide com os cartões.",
    }
