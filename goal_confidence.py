"""
Goal confidence v5 — hybrid score for objective cards.

Base score: margin ladder vs deadline (pessimistic / main scenarios).
Hybrid: base × model reliability × regime × data freshness (aligned with prediction v4).
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

MODEL_RELIABILITY_MIN = 0.72
MODEL_RELIABILITY_MAX = 1.0
REGIME_FACTORS = {"normal": 1.0, "post_stop": 0.94, "in_long_stop": 0.88}
STALE_HOURS = 3.0


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


def _parse_pace_sec(pace_str: str | None) -> float | None:
    if not pace_str:
        return None
    m = re.match(r"(\d+):(\d+)/km", str(pace_str).strip())
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def model_reliability_factor(confidence_pct: float | None) -> float:
    if confidence_pct is None:
        return 0.88
    pct = max(40.0, min(92.0, float(confidence_pct)))
    return MODEL_RELIABILITY_MIN + (pct - 40.0) / 52.0 * (MODEL_RELIABILITY_MAX - MODEL_RELIABILITY_MIN)


def regime_confidence_factor(regime: str | None, forecast_suspended: bool = False) -> float:
    f = REGIME_FACTORS.get(regime or "normal", 1.0)
    if forecast_suspended:
        f = min(f, 0.90)
    return f


def data_reliability_factor(
    data_stale_hours: float | None,
    projection_anchor: str | None,
) -> float:
    if data_stale_hours is None or data_stale_hours <= STALE_HOURS:
        return 1.0
    if projection_anchor == "gps_live":
        return 0.94
    return 0.78


def apply_goal_confidence_hybrid(
    base_pct: float,
    *,
    confidence_pct: float | None,
    regime: str | None = None,
    forecast_suspended: bool = False,
    data_stale_hours: float | None = None,
    projection_anchor: str | None = None,
) -> dict[str, Any]:
    model_f = model_reliability_factor(confidence_pct)
    regime_f = regime_confidence_factor(regime, forecast_suspended)
    data_f = data_reliability_factor(data_stale_hours, projection_anchor)
    pct = round(max(5, min(92, base_pct * model_f * regime_f * data_f)))
    return {
        "pct": pct,
        "basePct": round(base_pct),
        "modelReliabilityPct": round(confidence_pct) if confidence_pct is not None else None,
        "modelFactor": round(model_f, 3),
        "regimeFactor": round(regime_f, 3),
        "dataFactor": round(data_f, 3),
        "regime": regime or "normal",
        "forecastSuspended": bool(forecast_suspended),
    }


def _compute_goal_confidence_base(
    *,
    deadline_str: str,
    required_pace_str: str | None,
    required_km_day: float | None,
    finishes: dict[str, dict[str, Any]],
    performance: dict[str, Any],
) -> tuple[int | None, dict[str, int | None], float | None, float | None]:
    m_opt = _margin_minutes(deadline_str, finishes.get("optimistic", {}).get("finish"))
    m_main = _margin_minutes(deadline_str, finishes.get("main", {}).get("finish"))
    m_pes = _margin_minutes(deadline_str, finishes.get("pessimistic", {}).get("finish"))
    if m_pes is None or m_main is None:
        return None, {}, None, None

    proven = finishes.get("_proven") or {}
    main_sc = finishes.get("main") or {}
    projected_km_day = main_sc.get("kmPerDay")
    demonstrated_candidates = [
        proven.get("kmDay40"),
        proven.get("recentKmDay"),
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

    base = round(max(5, min(92, pct)))
    margins = {"optimistic": m_opt, "main": m_main, "pessimistic": m_pes}
    return base, margins, demonstrated, req_km_day


def compute_goal_confidence(
    *,
    deadline_str: str,
    required_pace_str: str | None,
    required_km_day: float | None,
    reference_km: float | None,
    current_km: int,
    finishes: dict[str, dict[str, Any]],
    performance: dict[str, Any],
    data_stale_hours: float | None = None,
    projection_anchor: str | None = None,
    confidence_pct: float | None = None,
    regime: str | None = None,
    forecast_suspended: bool = False,
) -> dict[str, Any]:
    base, margins, _demonstrated, _req = _compute_goal_confidence_base(
        deadline_str=deadline_str,
        required_pace_str=required_pace_str,
        required_km_day=required_km_day,
        finishes=finishes,
        performance=performance,
    )
    if base is None:
        return {"pct": None, "margins": {}}

    hybrid = apply_goal_confidence_hybrid(
        float(base),
        confidence_pct=confidence_pct,
        regime=regime,
        forecast_suspended=forecast_suspended,
        data_stale_hours=data_stale_hours,
        projection_anchor=projection_anchor,
    )

    out: dict[str, Any] = {
        "pct": hybrid["pct"],
        "basePct": hybrid["basePct"],
        "hybrid": hybrid,
        "margins": margins,
    }
    if data_stale_hours is not None and data_stale_hours > STALE_HOURS and projection_anchor != "gps_live":
        out["staleData"] = True
        out["staleHours"] = round(data_stale_hours, 1)
    return out


def build_model_reliability_summary(
    prediction: dict[str, Any],
    performance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    perf = performance or prediction.get("performance") or {}
    regime_info = prediction.get("regime") or {}
    regime = regime_info.get("regime") if isinstance(regime_info, dict) else regime_info
    pct = prediction.get("confidencePct")
    stale_h = prediction.get("dataStaleHours")
    anchor = prediction.get("projectionAnchor")
    suspended = bool(prediction.get("forecastSuspended"))

    lines: list[dict[str, str]] = []
    p25 = perf.get("p25PaceMin")
    p75 = perf.get("p75PaceMin")
    if p25 is not None and p75 is not None:
        iqr = round(p75 - p25, 2)
        lines.append(
            {
                "k": "Variabilidade do ritmo (IQR)",
                "v": f"{iqr:.1f} min/km",
                "cls": "good" if iqr <= 4 else "warn" if iqr <= 7 else "bad",
            }
        )
    stop = perf.get("stopRatioPct")
    if stop is not None:
        lines.append(
            {
                "k": "Tempo em paragem",
                "v": f"{stop:.1f}% do percurso",
                "cls": "good" if stop <= 12 else "warn" if stop <= 18 else "bad",
            }
        )
    lines.append(
        {
            "k": "Regime v4",
            "v": _regime_label(regime, suspended),
            "cls": "good" if regime == "normal" and not suspended else "warn",
        }
    )
    if stale_h is not None:
        lines.append(
            {
                "k": "Idade dos splits",
                "v": f"{stale_h:.1f} h · âncora {anchor or 'splits'}",
                "cls": "good" if stale_h <= STALE_HOURS else "warn" if anchor == "gps_live" else "bad",
            }
        )

    desc = (
        "Mede a estabilidade do ritmo medido e a frescura dos dados — não a probabilidade de cumprir 31/05."
    )
    if pct is not None and pct < 55:
        desc += " Sinal fraco: as percentagens dos cartões são ajustadas para baixo."
    elif stale_h is not None and stale_h > STALE_HOURS and anchor != "gps_live":
        desc += " Splits antigos sem GPS live: confianca nas metas reduzida."

    return {"pct": round(pct) if pct is not None else None, "description": desc, "factors": lines}


def _regime_label(regime: str | None, forecast_suspended: bool) -> str:
    labels = {
        "normal": "Normal",
        "post_stop": "Recuperação pós-paragem longa",
        "in_long_stop": "Paragem longa activa",
    }
    base = labels.get(regime or "normal", regime or "normal")
    if forecast_suspended:
        return base + " · previsao km a km suspensa"
    return base
