"""
Hybrid finish prediction: athlete GPS/splits + ultrarunning literature priors.

References (simplified coefficients):
- Lambert et al. (JSSM 2004): faster 100 km runners maintain pace longer; ~15% drop late race.
- Cejuela-Anta & Esteve-Lanao, Sports 2018: non-linear speed decay in 48 h / ~230 km ultra.
- Zingg et al. (Dovepress): ~3–5% speed loss per segment in elite 100 km (Biel).
- Minetti et al. (J Appl Physiol 2002): uphill metabolic cost ~2–4× flat (pace penalty model).
- Multi-day 500–1000 km: circadian slowdown + sleep-debt stop fraction after ~36–48 h.
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime, timedelta
from typing import Any

# --- Literature priors (multi-day 500+ km) ---
SCIENCE = {
    "label": "Literatura ultramaratona (100 km – multi-dia)",
    "sources": [
        {"id": "lambert2004", "note": "100 km: elites mantêm ritmo ~50 km antes de desacelerar"},
        {"id": "cejuela2018", "note": "48 h: queda não-linear; maior perda nas primeiras 6 h / marathon"},
        {"id": "zingg100k", "note": "100 km: ~3–5% mais lento por segmento vs segmento anterior"},
        {"id": "minetti2002", "note": "Subida: custo energético ↑ — penalização ~18 s/100 m D+ em ritmo ultra"},
    ],
    "base_pace_decay_per_10km": 0.025,  # ~2.5% slower each 10 km after km 100
    "distance_fatigue_per_km": 0.0012,  # extra slowdown per km ahead (cumulative ultra)
    "climb_sec_per_100m": 18.0,
    "night_pace_factor": 1.08,  # 22:00–06:00
    "sleep_onset_hours": 36.0,
    "sleep_stop_min_per_6h": 25.0,  # expected extra stop min per 6 h after onset
    "finish_pace_floor_factor": 2.8,  # max slowdown vs start (ultra longo)
    "optimistic_factor": 0.92,
    "pessimistic_factor": 1.14,
}

MOVING_THRESHOLD_S = 900  # 15 min/km = paragem


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


def analyze_athlete(splits: list[dict], current_km: int, race_start: str) -> dict[str, Any]:
    """Extract real performance metrics from km splits."""
    moving = [s for s in splits if s["segment_time_s"] < MOVING_THRESHOLD_S]
    stopped = [s for s in splits if s["segment_time_s"] >= MOVING_THRESHOLD_S]

    paces = [s["segment_time_s"] for s in moving]
    kms = [s["km"] for s in moving]

    # Exponential-weighted recent pace (last ~30 km)
    if moving:
        weights = [math.exp((s["km"] - current_km) / 12.0) for s in moving]
        wsum = sum(weights)
        weighted_pace = sum(s["segment_time_s"] * w for s, w in zip(moving, weights)) / wsum
    else:
        weighted_pace = 420.0

    median_pace = statistics.median(paces) if paces else weighted_pace
    p25 = _percentile(paces, 0.25) if paces else median_pace
    p75 = _percentile(paces, 0.75) if paces else median_pace

    # Pace vs km regression (moving only)
    fatigue_slope = _linear_slope(kms, paces)  # sec per km per km index

    # Early vs late (by race progress)
    if len(moving) >= 8:
        mid = len(moving) // 2
        early_avg = statistics.mean([s["segment_time_s"] for s in moving[:mid]])
        late_avg = statistics.mean([s["segment_time_s"] for s in moving[mid:]])
        fatigue_pct = max(0, (late_avg - early_avg) / early_avg) if early_avg else 0
    else:
        fatigue_pct = 0.0

    # Overall elapsed pace
    if splits:
        elapsed_s = splits[-1].get("elapsed_time_s") or 0
        dist_done = max(1, current_km - (splits[0]["km"] - 1))
        overall_pace = elapsed_s / dist_done
    else:
        overall_pace = median_pace

    stop_ratio = len(stopped) / len(splits) if splits else 0
    avg_stop_s = statistics.mean([s["segment_time_s"] for s in stopped]) if stopped else 0

    # Night vs day from crossing times
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

    # Terrain response: correlate pace with gain if available in splits
    # (gain added later from profile in build_prediction)

    return {
        "kmCompleted": current_km,
        "movingSegments": len(moving),
        "stoppedSegments": len(stopped),
        "stopRatioPct": round(100 * stop_ratio, 1),
        "avgStopMin": round(avg_stop_s / 60, 1) if avg_stop_s else 0,
        "medianPaceMin": round(median_pace / 60, 2),
        "weightedPaceMin": round(weighted_pace / 60, 2),
        "p25PaceMin": round(p25 / 60, 2),
        "p75PaceMin": round(p75 / 60, 2),
        "overallPaceMin": round(overall_pace / 60, 2),
        "fatigueSlopeSecPerKm": round(fatigue_slope, 3),
        "fatiguePctEarlyLate": round(100 * fatigue_pct, 1),
        "nightSlowdownPct": round(100 * (night_factor - 1), 1),
        "basePaceSec": weighted_pace,
        "optimisticPaceSec": p25,
        "pessimisticPaceSec": p75,
        "fatiguePerKm": max(0, fatigue_slope / weighted_pace) if weighted_pace else 0.002,
    }


def _athlete_weight(km_done: float, total_km: float) -> float:
    """More race data → trust athlete curve more (cap 88%)."""
    progress = km_done / total_km if total_km else 0
    return min(0.88, 0.30 + 0.55 * progress + 0.003 * km_done)


def _science_base_pace(athlete_base_s: float, km_done: float) -> float:
    """Literature expects slightly slower sustainable pace in 500+ km vs short ultra."""
    long_ultra_factor = 1.04 + 0.00008 * max(0, km_done - 50)
    return athlete_base_s * min(long_ultra_factor, 1.18)


def _pace_for_km(
    km_i: int,
    current_km: int,
    km_done: float,
    total_km: float,
    athlete: dict,
    profile_seg: dict,
    elapsed_hours: float,
    crossing_dt: datetime,
    scenario: str,
) -> float:
    """Predict seconds for one km segment."""
    ahead = km_i - current_km
    w = _athlete_weight(km_done, total_km)
    sci = SCIENCE

    if scenario == "optimistic":
        base_s = athlete["optimisticPaceSec"]
        fatigue_k = athlete["fatiguePerKm"] * 0.6
        climb = sci["climb_sec_per_100m"] * 0.85
        night_f = 1.0 + (athlete.get("nightSlowdownPct", 0) / 100) * 0.5
    elif scenario == "pessimistic":
        base_s = athlete["pessimisticPaceSec"]
        fatigue_k = athlete["fatiguePerKm"] * 1.35 + sci["distance_fatigue_per_km"]
        climb = sci["climb_sec_per_100m"] * 1.2
        night_f = max(sci["night_pace_factor"], 1.0 + athlete.get("nightSlowdownPct", 0) / 100)
    else:
        base_s = athlete["basePaceSec"]
        fatigue_k = athlete["fatiguePerKm"]
        climb = _blend(athlete.get("climbSecPer100m", sci["climb_sec_per_100m"]), sci["climb_sec_per_100m"], w)
        night_f = _blend(
            1.0 + athlete.get("nightSlowdownPct", 0) / 100,
            sci["night_pace_factor"],
            1 - w,
        )

    science_base = _science_base_pace(base_s, km_done)
    blended_base = w * base_s + (1 - w) * science_base

    # Distance-based decay (literature + personal fatigue)
    decay_sci = 1 + sci["distance_fatigue_per_km"] * ahead
    decay_ath = 1 + fatigue_k * ahead
    decay = w * decay_ath + (1 - w) * decay_sci

    # Extra decay after km 100 (Zingg / Lambert style segment loss)
    if km_i > 100:
        extra_10k = (km_i - 100) / 10.0
        decay *= 1 + (1 - w) * sci["base_pace_decay_per_10km"] * extra_10k

    gain = profile_seg.get("gain", 0) or 0
    loss = profile_seg.get("loss", 0) or 0
    terrain = climb * (gain / 100.0) - 0.3 * climb * (loss / 100.0)

    pace_s = blended_base * decay + terrain

    if _is_night_hour(crossing_dt):
        pace_s *= night_f

    # Sleep-debt stops (multi-day): add average stop time spread per km
    if elapsed_hours >= sci["sleep_onset_hours"]:
        extra_h = elapsed_hours - sci["sleep_onset_hours"]
        stop_per_km = (sci["sleep_stop_min_per_6h"] / 60) * (extra_h / 6) / max(1, ahead)
        pace_s += stop_per_km * 60

    floor = blended_base * 0.75
    cap = blended_base * sci["finish_pace_floor_factor"]
    return min(max(pace_s, floor), cap)


def _blend(a: float, b: float, w_a: float) -> float:
    return w_a * a + (1 - w_a) * b


def estimate_climb_coeff(splits: list[dict], profile_full: list[dict]) -> float:
    """Learn sec/100m D+ from athlete moving segments."""
    pairs = []
    for s in splits:
        if s["segment_time_s"] >= MOVING_THRESHOLD_S:
            continue
        seg = profile_full[s["km"] - 1] if 0 < s["km"] <= len(profile_full) else None
        if not seg:
            continue
        pairs.append((seg.get("gain", 0), s["segment_time_s"]))
    if len(pairs) < 8:
        return SCIENCE["climb_sec_per_100m"]
    gains = [p[0] for p in pairs]
    paces = [p[1] for p in pairs]
    base_pace = statistics.median(paces)
    # Rough slope: extra sec per 100m gain vs flat median
    high = [p for p in pairs if p[0] > 30]
    low = [p for p in pairs if p[0] < 10]
    if high and low:
        diff = statistics.mean([p[1] for p in high]) - statistics.mean([p[1] for p in low])
        avg_gain_diff = statistics.mean([p[0] for p in high]) - statistics.mean([p[0] for p in low])
        if avg_gain_diff > 20:
            coef = max(8, min(45, diff / (avg_gain_diff / 100.0)))
            return round(coef, 1)
    return SCIENCE["climb_sec_per_100m"]


def build_prediction(
    splits: list[dict],
    profile_full: list[dict],
    current_km: int,
    total_km: float,
    last_crossing: str,
    race_start: str,
) -> dict[str, Any]:
    athlete = analyze_athlete(splits, current_km, race_start)
    athlete["climbSecPer100m"] = estimate_climb_coeff(splits, profile_full)

    now = datetime.strptime(last_crossing, "%Y-%m-%d %H:%M:%S")
    try:
        start = datetime.strptime(race_start, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        start = now
    elapsed_hours = (now - start).total_seconds() / 3600

    w_athlete = round(_athlete_weight(current_km, total_km), 2)

    def run_scenario(name: str) -> tuple[float, list[dict]]:
        cum = 0.0
        forecast = []
        t = now
        for km_i in range(current_km + 1, int(total_km) + 1):
            seg = profile_full[km_i - 1] if km_i <= len(profile_full) else {"gain": 0, "loss": 0, "elevation": 0}
            pace_s = _pace_for_km(
                km_i, current_km, current_km, total_km, athlete, seg, elapsed_hours + cum / 3600, t, name
            )
            cum += pace_s
            t = now + timedelta(seconds=cum)
            ahead = km_i - current_km
            if ahead % 5 == 0 or km_i == int(total_km):
                forecast.append({
                    "km": km_i,
                    "predicted_pace_min": round(pace_s / 60, 2),
                    "predicted_crossing": t.strftime("%Y-%m-%d %H:%M"),
                    "gain": seg.get("gain", 0),
                    "elevation": seg.get("elevation", 0),
                    "scenario": name,
                })
        return cum, forecast

    cum_main, forecast = run_scenario("main")
    cum_opt, _ = run_scenario("optimistic")
    cum_pes, _ = run_scenario("pessimistic")

    finish = now + timedelta(seconds=cum_main)
    finish_opt = now + timedelta(seconds=cum_opt)
    finish_pes = now + timedelta(seconds=cum_pes)

    # Confidence from spread of recent paces + scenario band
    pace_iqr = athlete["p75PaceMin"] - athlete["p25PaceMin"]
    confidence = max(35, min(92, 88 - pace_iqr * 4 - athlete["stopRatioPct"] * 0.3))

    return {
        "model": "Híbrido: performance real (GPS/splits) + priors literatura ultra 100 km – multi-dia",
        "modelVersion": 2,
        "athleteWeight": w_athlete,
        "scienceWeight": round(1 - w_athlete, 2),
        "confidencePct": round(confidence, 0),
        "basePaceMin": round(athlete["basePaceSec"] / 60, 2),
        "fatigueRatePerKm": round(athlete["fatiguePerKm"], 4),
        "climbSecPer100m": athlete["climbSecPer100m"],
        "finishTime": finish.strftime("%Y-%m-%d %H:%M"),
        "finishDate": finish.strftime("%a %d %b %Y, %H:%M"),
        "remainingHours": round(cum_main / 3600, 1),
        "remainingDays": round(cum_main / 86400, 1),
        "optimisticFinish": finish_opt.strftime("%Y-%m-%d %H:%M"),
        "pessimisticFinish": finish_pes.strftime("%Y-%m-%d %H:%M"),
        "forecast": forecast,
        "performance": athlete,
        "science": SCIENCE,
        "scenarios": {
            "main": {"hours": round(cum_main / 3600, 1)},
            "optimistic": {"hours": round(cum_opt / 3600, 1)},
            "pessimistic": {"hours": round(cum_pes / 3600, 1)},
        },
    }
