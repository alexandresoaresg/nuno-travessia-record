"""
Travessia prediction model v4 — athlete-calibrated, literature-bounded.

v4 adds (on top of v3):
- Recent moving-pace window (last ~15 km) for short-horizon forecasts
- Long-stop regime detection (paragem/sono >= 60 min)
- GPS-aware projection anchor when splits are stale
- Suspended km-a-km forecast during active long stops
- Stale-data penalty on model confidence

Primary signal: GPS km splits already run (pace, stops, night, climb response).
Literature sets caps and shape, not large additive penalties.

Sources (see SCIENCE["sources"] for URLs):
- Lambert et al., J Strength Cond Res 2004 — 100 km pacing profile.
- Cejuela-Anta & Esteve-Lanao, Sports 2018 — non-linear decay in 48 h ultra.
- Zingg et al., J Sports Sci Med 2016 — segment-to-segment loss in 100 km.
- Minetti et al., J Appl Physiol 2002 — uphill metabolic cost / pace penalty.
- Knechtle et al., Int J Sports Physiol Perform 2014 — multi-day ultra pacing & sleep.
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime, timedelta
from typing import Any

MOVING_THRESHOLD_S = 900  # 15 min/km segment treated as stop
LONG_STOP_THRESHOLD_S = 3600  # 60 min — sleep / long break
RECENT_WINDOW_KM = 15
SHORT_HORIZON_KM = 24  # blend recent pace for km ahead within this band
STALE_SPLIT_HOURS = 3.0
STALE_CONFIDENCE_CAP = 45
RECENT_PACE_BLEND = 0.65  # short horizon: recent vs global (main)
POST_STOP_RECENT_BLEND = 0.78

# Literature caps (applied to athlete-measured coefficients)
CAPS = {
    "fatigue_per_km_max": 0.0035,  # ~0.35% slower per km ahead (Cejuela/Lambert scale)
    "decay_per_10km_after_100_max": 0.035,  # Zingg ~3–5% per segment band
    "climb_sec_per_100m_min": 8.0,
    "climb_sec_per_100m_max": 40.0,
    "climb_sec_per_100m_prior": 18.0,  # Minetti-order magnitude for flat→uphill
    "night_factor_min": 1.0,
    "night_factor_max": 1.25,
    "stop_ratio_max": 0.25,
}

SCIENCE = {
    "label": "Literatura ultramaratona (100 km – multi-dia)",
    "modelVersion": 4,
    "modelName": "Janela recente, paragens longas, ancora GPS",
    "sources": [
        {
            "id": "lambert2004",
            "title": "Lambert et al. (2004)",
            "note": "100 km: ritmo estável na 1.ª metade; ~15% mais lento na 2.ª metade nos mais rápidos.",
            "url": "https://pubmed.ncbi.nlm.nih.gov/15279199/",
        },
        {
            "id": "cejuela2018",
            "title": "Cejuela-Anta & Esteve-Lanao (2018)",
            "note": "Ultra 48 h: decaimento não linear da velocidade com km e tempo de prova.",
            "url": "https://www.mdpi.com/2075-4663/6/3/62",
        },
        {
            "id": "zingg2016",
            "title": "Zingg et al. (2016)",
            "note": "100 km: ~3–5% de perda de velocidade por segmento vs anterior (elite).",
            "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC5131228/",
        },
        {
            "id": "minetti2002",
            "title": "Minetti et al. (2002)",
            "note": "Subida: custo metabólico ↑ — traduzido em penalização de ritmo por 100 m D+.",
            "url": "https://journals.physiology.org/doi/full/10.1152/japplphysiol.01177.2001",
        },
        {
            "id": "knechtle2014",
            "title": "Knechtle et al. (2014)",
            "note": "Ultra multi-dia: queda de velocidade com distância e tempo; sono/paragens variáveis.",
            "url": "https://pubmed.ncbi.nlm.nih.gov/24768874/",
        },
    ],
    "caps": CAPS,
}


def _linear_slope(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 3:
        return 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    return num / den if den else 0.0


def _percentile(vals: list[float], p: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    k = (len(s) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] * (c - k) + s[c] * (k - f)


def _is_night_hour(dt: datetime) -> bool:
    h = dt.hour
    return h >= 22 or h < 6


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(str(s).strip(), fmt)
        except ValueError:
            continue
    return None


def recent_moving_pace_sec(splits: list[dict], current_km: int, window_km: int = RECENT_WINDOW_KM) -> float | None:
    """Arithmetic mean pace from last `window_km` moving segments."""
    usable = [
        s
        for s in splits
        if not s.get("unavailable")
        and not s.get("partial")
        and s["segment_time_s"] < MOVING_THRESHOLD_S
        and s["km"] <= current_km
    ]
    if not usable:
        return None
    tail = usable[-window_km:]
    return statistics.mean(s["segment_time_s"] for s in tail)


def detect_regime(
    splits: list[dict],
    current_km: int,
    last_crossing: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Classify pacing regime for short-horizon behaviour."""
    now = now or datetime.now()
    split_time = _parse_dt(last_crossing)
    stale_h = (
        (now - split_time).total_seconds() / 3600.0 if split_time else 999.0
    )

    usable = [s for s in splits if not s.get("unavailable") and not s.get("partial")]
    last_seg = usable[-1] if usable else None

    regime = "normal"
    forecast_suspended = False
    last_stop_km = None
    last_stop_min = None
    note = None

    if last_seg and last_seg["segment_time_s"] >= LONG_STOP_THRESHOLD_S:
        last_stop_km = last_seg["km"]
        last_stop_min = round(last_seg["segment_time_s"] / 60, 1)
        if last_seg["km"] >= current_km:
            regime = "in_long_stop"
            forecast_suspended = True
            note = f"Paragem longa em curso no km {last_stop_km} (~{last_stop_min:.0f} min)"
        else:
            moved_since = [
                s
                for s in usable
                if s["km"] > last_stop_km
                and s["segment_time_s"] < MOVING_THRESHOLD_S
            ]
            if len(moved_since) < 3:
                regime = "post_stop"
                note = f"Retoma apos paragem km {last_stop_km} — ritmo recente priorizado"
            else:
                regime = "normal"
                note = f"Paragem km {last_stop_km} ja absorvida ({len(moved_since)} km movimento)"

    if stale_h > STALE_SPLIT_HOURS:
        note = (note + "; " if note else "") + f"Splits com {stale_h:.1f}h de atraso"

    return {
        "regime": regime,
        "forecastSuspended": forecast_suspended,
        "dataStaleHours": round(stale_h, 2),
        "dataStale": stale_h > STALE_SPLIT_HOURS,
        "lastStopKm": last_stop_km,
        "lastStopMin": last_stop_min,
        "note": note,
    }


def resolve_projection(
    *,
    current_km: int,
    last_crossing: str,
    live: dict | None,
    projection_km: float | None,
    projection_time: datetime | None,
    now: datetime | None = None,
) -> tuple[float, datetime, str, float]:
    """Pick projection anchor: fresher of split vs live GPS."""
    now = now or datetime.now()
    split_time = _parse_dt(last_crossing) or now
    proj_km = float(projection_km if projection_km is not None else current_km)
    proj_time = projection_time or split_time
    anchor = "split"

    if live:
        live_t = _parse_dt(live.get("gpsTime"))
        if live.get("alongRouteKm") is not None:
            along = float(live["alongRouteKm"])
            if along >= float(current_km) - 0.5:
                proj_km = max(float(current_km), along)
        if live_t and live_t >= split_time:
            proj_time = live_t
            anchor = "gps_live"

    if proj_time < split_time:
        proj_time = split_time
    if proj_km < float(current_km):
        proj_km = float(current_km)

    stale_h = (now - split_time).total_seconds() / 3600.0
    return proj_km, proj_time, anchor, stale_h


def analyze_athlete(splits: list[dict], current_km: int, race_start: str) -> dict[str, Any]:
    """Metrics from km splits already completed."""
    usable = [s for s in splits if not s.get("unavailable") and not s.get("partial")]
    moving = [s for s in usable if s["segment_time_s"] < MOVING_THRESHOLD_S]
    stopped = [s for s in usable if s["segment_time_s"] >= MOVING_THRESHOLD_S]

    paces = [s["segment_time_s"] for s in moving]
    kms = [s["km"] for s in moving]

    if moving:
        weights = [math.exp((s["km"] - current_km) / 12.0) for s in moving]
        wsum = sum(weights)
        weighted_pace = sum(s["segment_time_s"] * w for s, w in zip(moving, weights)) / wsum
    else:
        weighted_pace = 420.0

    median_pace = statistics.median(paces) if paces else weighted_pace
    p25 = _percentile(paces, 0.25) if paces else median_pace
    p75 = _percentile(paces, 0.75) if paces else median_pace

    fatigue_slope = _linear_slope(kms, paces)
    fatigue_per_km = max(0.0, fatigue_slope / weighted_pace) if weighted_pace else 0.0
    fatigue_per_km = min(fatigue_per_km, CAPS["fatigue_per_km_max"])

    if len(moving) >= 8:
        mid = len(moving) // 2
        early_avg = statistics.mean([s["segment_time_s"] for s in moving[:mid]])
        late_avg = statistics.mean([s["segment_time_s"] for s in moving[mid:]])
        fatigue_pct = max(0, (late_avg - early_avg) / early_avg) if early_avg else 0
    else:
        fatigue_pct = 0.0

    if usable:
        elapsed_s = usable[-1].get("elapsed_time_s") or 0
        dist_done = max(1, current_km - (usable[0]["km"] - 1))
        overall_pace = elapsed_s / dist_done
    else:
        overall_pace = median_pace

    stop_ratio = len(stopped) / len(usable) if usable else 0
    stop_ratio = min(stop_ratio, CAPS["stop_ratio_max"])
    stop_times = [s["segment_time_s"] for s in stopped]
    avg_stop_s = statistics.mean(stop_times) if stop_times else 0
    median_stop_s = statistics.median(stop_times) if stop_times else avg_stop_s

    night_paces, day_paces = [], []
    for s in moving:
        try:
            dt = datetime.strptime(s["crossing_time"], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        if _is_night_hour(dt):
            night_paces.append(s["segment_time_s"])
        else:
            day_paces.append(s["segment_time_s"])

    night_factor = 1.0
    if night_paces and day_paces:
        night_factor = statistics.mean(night_paces) / statistics.mean(day_paces)
    night_factor = max(CAPS["night_factor_min"], min(CAPS["night_factor_max"], night_factor))

    # Late-race slowdown already captured in fatigue_per_km (pace vs km regression).
    # Keep a small optional band decay for scenarios only (not double-counted in main).
    decay_per_10k = 0.0

    recent_sec = recent_moving_pace_sec(splits, current_km) or weighted_pace

    return {
        "kmCompleted": current_km,
        "recentPaceSec": recent_sec,
        "recentPaceMin": round(recent_sec / 60, 2),
        "recentWindowKm": RECENT_WINDOW_KM,
        "movingSegments": len(moving),
        "stoppedSegments": len(stopped),
        "stopRatioPct": round(100 * stop_ratio, 1),
        "stopProbPerKm": round(stop_ratio, 4),
        "avgStopMin": round(avg_stop_s / 60, 1) if avg_stop_s else 0,
        "medianStopMin": round(median_stop_s / 60, 1) if median_stop_s else 0,
        "avgStopSec": round(avg_stop_s, 0),
        "medianStopSec": round(median_stop_s, 0),
        "medianPaceMin": round(median_pace / 60, 2),
        "weightedPaceMin": round(weighted_pace / 60, 2),
        "p25PaceMin": round(p25 / 60, 2),
        "p75PaceMin": round(p75 / 60, 2),
        "overallPaceMin": round(overall_pace / 60, 2),
        "fatigueSlopeSecPerKm": round(fatigue_slope, 3),
        "fatiguePctEarlyLate": round(100 * fatigue_pct, 1),
        "fatiguePerKm": round(fatigue_per_km, 5),
        "decayPer10kmAfter100": round(decay_per_10k, 4),
        "nightSlowdownPct": round(100 * (night_factor - 1), 1),
        "nightFactor": round(night_factor, 3),
        "movingPaceSec": weighted_pace,
        "optimisticPaceSec": p25,
        "pessimisticPaceSec": p75,
    }


def estimate_climb_coeff(splits: list[dict], profile_full: list[dict]) -> float:
    """Learn sec/100m D+ from moving segments; clamp to literature range."""
    pairs = []
    for s in splits:
        if s.get("unavailable") or s.get("partial"):
            continue
        if s["segment_time_s"] >= MOVING_THRESHOLD_S:
            continue
        seg = profile_full[s["km"] - 1] if 0 < s["km"] <= len(profile_full) else None
        if not seg:
            continue
        pairs.append((seg.get("gain", 0), s["segment_time_s"]))
    if len(pairs) < 8:
        return CAPS["climb_sec_per_100m_prior"]
    high = [p for p in pairs if p[0] > 30]
    low = [p for p in pairs if p[0] < 10]
    if high and low:
        diff = statistics.mean([p[1] for p in high]) - statistics.mean([p[1] for p in low])
        avg_gain_diff = statistics.mean([p[0] for p in high]) - statistics.mean([p[0] for p in low])
        if avg_gain_diff > 20:
            coef = diff / (avg_gain_diff / 100.0)
            # Avoid outlier pairs (stops on climbs) dominating — cap below literature max
            return round(
                max(
                    CAPS["climb_sec_per_100m_min"],
                    min(28.0, coef, CAPS["climb_sec_per_100m_max"]),
                ),
                1,
            )
    return CAPS["climb_sec_per_100m_prior"]


def _scenario_params(athlete: dict, scenario: str) -> dict[str, float]:
    """Per-scenario knobs — all derived from athlete data, scaled for opt/pes."""
    if scenario == "optimistic":
        return {
            "moving_pace_s": athlete["optimisticPaceSec"],
            "fatigue_per_km": athlete["fatiguePerKm"] * 0.55,
            "stop_prob": athlete["stopProbPerKm"] * 0.75,
            "avg_stop_s": athlete["avgStopSec"] * 0.85,
            "night_factor": 1.0 + (athlete["nightFactor"] - 1.0) * 0.6,
            "decay_per_10k": athlete["decayPer10kmAfter100"] * 0.6,
        }
    if scenario == "pessimistic":
        return {
            "moving_pace_s": athlete["pessimisticPaceSec"],
            "fatigue_per_km": min(
                CAPS["fatigue_per_km_max"],
                athlete["fatiguePerKm"] * 1.35,
            ),
            "stop_prob": min(CAPS["stop_ratio_max"], athlete["stopProbPerKm"] * 1.35),
            "avg_stop_s": athlete["avgStopSec"] * 1.15,
            "night_factor": max(athlete["nightFactor"], 1.05),
            "decay_per_10k": CAPS["decay_per_10km_after_100_max"] * 0.6,
        }
    return {
        "moving_pace_s": athlete["movingPaceSec"],
        "fatigue_per_km": athlete["fatiguePerKm"],
        "stop_prob": athlete["stopProbPerKm"],
        "avg_stop_s": athlete.get("medianStopSec") or athlete["avgStopSec"],
        "night_factor": athlete["nightFactor"],
        "decay_per_10k": 0.0,
    }


def _effective_moving_pace_s(
    p: dict[str, float],
    athlete: dict,
    ahead_km: float,
    regime: str,
) -> float:
    """Blend global calibrated pace with recent window for short horizon / post-stop."""
    global_p = p["moving_pace_s"]
    recent = athlete.get("recentPaceSec") or global_p
    if regime == "in_long_stop":
        return global_p
    if regime == "post_stop":
        return POST_STOP_RECENT_BLEND * recent + (1.0 - POST_STOP_RECENT_BLEND) * global_p
    if ahead_km <= SHORT_HORIZON_KM:
        return RECENT_PACE_BLEND * recent + (1.0 - RECENT_PACE_BLEND) * global_p
    return global_p


def _pace_for_km(
    km_i: int,
    current_km: int,
    athlete: dict,
    profile_seg: dict,
    crossing_dt: datetime,
    scenario: str,
    *,
    regime: str = "normal",
) -> float:
    """
    Expected seconds for km_i (v4).

    E[time] = (1 − p_stop) × pace_mov × fatigue × night + p_stop × avg_stop + terrain

    fatigue = 1 + fatigue_per_km × km_ahead; after km 100 add Zingg-style band decay (capped).
    """
    p = _scenario_params(athlete, scenario)
    ahead = km_i - current_km
    p = dict(p)
    p["moving_pace_s"] = _effective_moving_pace_s(p, athlete, ahead, regime)

    # Linear fatigue from athlete regression; cap ~40% total slowdown (Lambert ~15% late-race band).
    fatigue_mult = min(1.4, 1.0 + p["fatigue_per_km"] * ahead)
    if scenario == "pessimistic" and km_i > 100 and p["decay_per_10k"] > 0:
        # Small extra band decay only in pessimistic scenario (Zingg 3–5%/segment order)
        bands = min(12, (km_i - 100) / 10.0)
        fatigue_mult = min(1.55, fatigue_mult * (1.0 + p["decay_per_10k"] * 0.15 * bands))

    gain = profile_seg.get("gain", 0) or 0
    loss = profile_seg.get("loss", 0) or 0
    climb = athlete.get("climbSecPer100m", CAPS["climb_sec_per_100m_prior"])
    terrain = climb * (gain / 100.0) - 0.25 * climb * (loss / 100.0)

    moving_part = (1.0 - p["stop_prob"]) * p["moving_pace_s"] * fatigue_mult
    stop_part = p["stop_prob"] * p["avg_stop_s"] if p["avg_stop_s"] > 0 else 0
    pace_s = moving_part + stop_part + terrain

    if _is_night_hour(crossing_dt):
        pace_s *= p["night_factor"]

  # Floor: never faster than optimistic moving pace; cap at 3× moving base
    floor = p["moving_pace_s"] * 0.85
    cap = p["moving_pace_s"] * 3.0
    return min(max(pace_s, floor), cap)


def _run_scenario(
    scenario: str,
    athlete: dict,
    profile_full: list[dict],
    projection_km: float,
    total_km: float,
    projection_time: datetime,
    *,
    regime: str = "normal",
    forecast_suspended: bool = False,
) -> tuple[float, list[dict]]:
    """Simulate remaining route from projection_km at projection_time."""
    cum = 0.0
    forecast: list[dict] = []
    floor_km = int(math.floor(projection_km + 1e-9))
    total_km_i = int(total_km)

    if forecast_suspended and scenario == "main":
        return 0.0, []

    def _append_forecast(km_i: int, pace_s: float, seg: dict) -> None:
        t_cross = projection_time + timedelta(seconds=cum)
        forecast.append({
            "km": km_i,
            "predicted_pace_min": round(pace_s / 60, 2),
            "predicted_crossing": t_cross.strftime("%Y-%m-%d %H:%M"),
            "predicted_crossing_iso": t_cross.strftime("%Y-%m-%d %H:%M:%S"),
            "gain": seg.get("gain", 0),
            "elevation": seg.get("elevation", 0),
            "scenario": scenario,
        })

    next_km = int(math.floor(projection_km)) + 1
    if next_km <= total_km_i:
        dist_km = next_km - projection_km
        if dist_km > 1e-9:
            seg = (
                profile_full[next_km - 1]
                if next_km <= len(profile_full)
                else {"gain": 0, "loss": 0, "elevation": 0}
            )
            t_at_seg = projection_time + timedelta(seconds=cum)
            pace_s = _pace_for_km(
                next_km, floor_km, athlete, seg, t_at_seg, scenario, regime=regime
            )
            cum += pace_s * dist_km
            ahead = next_km - floor_km
            if ahead % 5 == 0 or next_km == total_km_i or dist_km < 0.999:
                _append_forecast(next_km, pace_s, seg)

    for km_i in range(next_km + 1, total_km_i + 1):
        seg = (
            profile_full[km_i - 1]
            if km_i <= len(profile_full)
            else {"gain": 0, "loss": 0, "elevation": 0}
        )
        t_at_seg = projection_time + timedelta(seconds=cum)
        pace_s = _pace_for_km(
            km_i, floor_km, athlete, seg, t_at_seg, scenario, regime=regime
        )
        cum += pace_s
        ahead = km_i - floor_km
        if ahead % 5 == 0 or km_i == total_km_i:
            _append_forecast(km_i, pace_s, seg)

    return cum, forecast


def build_prediction(
    splits: list[dict],
    profile_full: list[dict],
    current_km: int,
    total_km: float,
    last_crossing: str,
    race_start: str,
    *,
    projection_time: datetime | None = None,
    projection_km: float | None = None,
    live: dict | None = None,
    as_of: datetime | None = None,
) -> dict[str, Any]:
    athlete = analyze_athlete(splits, current_km, race_start)
    athlete["climbSecPer100m"] = estimate_climb_coeff(splits, profile_full)

    now = as_of or projection_time or datetime.now()
    regime_info = detect_regime(splits, current_km, last_crossing, now=now)
    regime = regime_info["regime"]
    forecast_suspended = regime_info["forecastSuspended"]

    proj_km, proj_time, anchor, stale_h = resolve_projection(
        current_km=current_km,
        last_crossing=last_crossing,
        live=live,
        projection_km=projection_km,
        projection_time=projection_time,
        now=now,
    )

    try:
        start = _parse_dt(race_start) or proj_time
    except Exception:
        start = proj_time

    cum_main, forecast = _run_scenario(
        "main",
        athlete,
        profile_full,
        proj_km,
        total_km,
        proj_time,
        regime=regime,
        forecast_suspended=forecast_suspended,
    )
    cum_opt, _ = _run_scenario(
        "optimistic",
        athlete,
        profile_full,
        proj_km,
        total_km,
        proj_time,
        regime=regime,
    )
    cum_pes, _ = _run_scenario(
        "pessimistic",
        athlete,
        profile_full,
        proj_km,
        total_km,
        proj_time,
        regime=regime,
    )

    finish = proj_time + timedelta(seconds=cum_main)
    finish_opt = proj_time + timedelta(seconds=cum_opt)
    finish_pes = proj_time + timedelta(seconds=cum_pes)

    remaining_km = max(0.0, total_km - proj_km)
    hours_main = cum_main / 3600
    hours_opt = cum_opt / 3600
    hours_pes = cum_pes / 3600
    km_per_day = (remaining_km / (hours_main / 24)) if hours_main > 0 else 0
    km_per_day_opt = (remaining_km / (hours_opt / 24)) if hours_opt > 0 else 0
    km_per_day_pes = (remaining_km / (hours_pes / 24)) if hours_pes > 0 else 0

    pace_iqr = athlete["p75PaceMin"] - athlete["p25PaceMin"]
    confidence = max(40, min(92, 90 - pace_iqr * 3 - athlete["stopRatioPct"] * 0.25))
    if regime_info["dataStale"] and not (live and anchor == "gps_live"):
        confidence = min(confidence, STALE_CONFIDENCE_CAP)

    main_params = _scenario_params(athlete, "main")
    moving_min = athlete["movingPaceSec"] / 60
    recent_min = athlete["recentPaceMin"]
    clock_pace_min = round((hours_main * 60) / remaining_km, 2) if remaining_km > 0 else None

    return {
        "model": SCIENCE["modelName"],
        "modelVersion": SCIENCE["modelVersion"],
        "regime": regime_info,
        "dataStaleHours": regime_info["dataStaleHours"],
        "forecastSuspended": forecast_suspended,
        "projectionAnchor": anchor,
        "recentPaceMin": recent_min,
        "athleteWeight": 1.0,
        "scienceWeight": 0.0,
        "confidencePct": round(confidence, 0),
        "movingPaceMin": round(moving_min, 2),
        "basePaceMin": round(moving_min, 2),
        "projectedClockPaceMin": clock_pace_min,
        "fatigueRatePerKm": athlete["fatiguePerKm"],
        "climbSecPer100m": athlete["climbSecPer100m"],
        "kmPerDayProjected": round(km_per_day, 1),
        "finishTime": finish.strftime("%Y-%m-%d %H:%M"),
        "finishTimeIso": finish.strftime("%Y-%m-%d %H:%M:%S"),
        "finishDate": finish.strftime("%a %d %b %Y, %H:%M"),
        "remainingHours": round(hours_main, 1),
        "remainingDays": round(hours_main / 24, 1),
        "optimisticFinish": finish_opt.strftime("%Y-%m-%d %H:%M"),
        "optimisticFinishIso": finish_opt.strftime("%Y-%m-%d %H:%M:%S"),
        "pessimisticFinish": finish_pes.strftime("%Y-%m-%d %H:%M"),
        "pessimisticFinishIso": finish_pes.strftime("%Y-%m-%d %H:%M:%S"),
        "projectionKm": round(proj_km, 1),
        "projectionTime": proj_time.strftime("%Y-%m-%d %H:%M:%S"),
        "forecast": [
            {
                "km": round(proj_km, 1),
                "predicted_crossing": proj_time.strftime("%Y-%m-%d %H:%M"),
                "predicted_crossing_iso": proj_time.strftime("%Y-%m-%d %H:%M:%S"),
                "scenario": "main",
            },
            *forecast,
        ],
        "performance": athlete,
        "science": SCIENCE,
        "modelParams": {
            "description": (
                "v4: ritmo recente (15 km) no horizonte curto; paragens >=60 min suspendem forecast; "
                "E[min/km] = (1−p)×ritmo×fadiga×noite + p×paragem + terreno"
            ),
            "main": {
                "movingPaceMin": round(main_params["moving_pace_s"] / 60, 2),
                "stopProbPerKm": main_params["stop_prob"],
                "avgStopMin": round(main_params["avg_stop_s"] / 60, 1),
                "fatiguePerKm": main_params["fatigue_per_km"],
                "decayPer10kmAfter100": main_params["decay_per_10k"],
                "nightFactor": main_params["night_factor"],
                "climbSecPer100m": athlete["climbSecPer100m"],
                "recentPaceMin": recent_min,
            },
        },
        "scenarios": {
            "main": {"hours": round(hours_main, 1), "kmPerDay": round(km_per_day, 1)},
            "optimistic": {
                "hours": round(hours_opt, 1),
                "kmPerDay": round(km_per_day_opt, 1),
            },
            "pessimistic": {
                "hours": round(hours_pes, 1),
                "kmPerDay": round(km_per_day_pes, 1),
            },
        },
    }


def estimate_finish_from_km(
    athlete: dict,
    profile_full: list[dict],
    km_now: float,
    total_km: float,
    now: datetime,
    start: datetime,
    scenario: str = "main",
) -> datetime:
    """Estimate finish if at km_now at time `now` (same v3 model)."""
    cum, _ = _run_scenario(
        scenario, athlete, profile_full, float(km_now), total_km, now
    )
    return now + timedelta(seconds=cum)
