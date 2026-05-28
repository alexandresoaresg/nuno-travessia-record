"""Build prediction timeline and backtest rows from append-only history."""

from __future__ import annotations

import json
import math
import statistics
from datetime import datetime
from pathlib import Path
from typing import Any

from prediction_history import JSONL_PATH, HISTORY_DIR

CALENDAR_DEADLINE = "2026-05-31 23:59:59"


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(str(s).strip(), fmt)
        except ValueError:
            continue
    return None


def _finish_iso(snap: dict[str, Any]) -> str | None:
    scenarios = snap.get("scenarios") or {}
    main = scenarios.get("main") or {}
    fin = main.get("finish")
    if fin:
        return str(fin)
    goal = snap.get("goal") or {}
    return goal.get("predFinish")


def _margin_main(snap: dict[str, Any]) -> int | None:
    conf = snap.get("confidence") or {}
    cal = conf.get("calendar") or {}
    margins = cal.get("margins") or {}
    if margins.get("main") is not None:
        return int(margins["main"])
    fin = _parse_dt(_finish_iso(snap))
    dl = _parse_dt((snap.get("goal") or {}).get("calendarDeadline") or CALENDAR_DEADLINE)
    if fin and dl:
        return round((dl - fin).total_seconds() / 60)
    return None


def _calendar_conf(snap: dict[str, Any]) -> int | None:
    conf = snap.get("confidence") or {}
    cal = conf.get("calendar") or {}
    if cal.get("hybrid") and isinstance(cal["hybrid"], dict):
        pct = cal["hybrid"].get("pct")
        if pct is not None:
            return int(pct)
    if cal.get("pct") is not None:
        return int(cal["pct"])
    return None


def _load_all_snapshots() -> list[dict[str, Any]]:
    paths: list[Path] = []
    if JSONL_PATH.exists():
        paths.append(JSONL_PATH)
    index = HISTORY_DIR / "archive_index.txt"
    if index.exists():
        for line in index.read_text(encoding="utf-8").splitlines():
            name = line.strip()
            if name:
                p = HISTORY_DIR / name
                if p.exists():
                    paths.append(p)
    rows: list[dict[str, Any]] = []
    for path in paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    rows.sort(key=lambda r: r.get("recordedAt") or "")
    return rows


def _thin_snapshots(
    rows: list[dict[str, Any]],
    *,
    min_gap_min: float = 25.0,
    finish_delta_min: float = 20.0,
) -> list[dict[str, Any]]:
    """Drop noisy duplicates; keep km jumps and meaningful finish revisions."""
    if not rows:
        return []
    kept: list[dict[str, Any]] = []
    last_t: datetime | None = None
    last_km: int | None = None
    last_fin: datetime | None = None

    for row in rows:
        t = _parse_dt(row.get("recordedAt"))
        if not t:
            continue
        km = int((row.get("current") or {}).get("km") or 0)
        fin = _parse_dt(_finish_iso(row))

        keep = not kept
        if not keep and last_t:
            gap_min = (t - last_t).total_seconds() / 60.0
            if km != last_km:
                keep = True
            elif gap_min >= min_gap_min:
                keep = True
            elif fin and last_fin:
                if abs((fin - last_fin).total_seconds()) >= finish_delta_min * 60:
                    keep = True

        if keep:
            kept.append(row)
            last_t = t
            last_km = km
            last_fin = fin

    return kept


def _actual_crossings_by_km(splits: list[dict[str, Any]] | None) -> dict[int, datetime]:
    out: dict[int, datetime] = {}
    for s in splits or []:
        if s.get("unavailable") or s.get("partial"):
            continue
        km = s.get("km")
        ct = _parse_dt(s.get("crossing_time"))
        if km is None or not ct:
            continue
        try:
            out[int(km)] = ct
        except Exception:
            continue
    return out


def _forecast_accuracy_summary(
    rows: list[dict[str, Any]],
    *,
    splits: list[dict[str, Any]] | None = None,
    current_km: int = 0,
) -> dict[str, Any] | None:
    actual_by_km = _actual_crossings_by_km(splits)
    if not actual_by_km:
        return None

    samples: list[dict[str, Any]] = []
    for row in rows:
        rec = _parse_dt(row.get("recordedAt"))
        cur = row.get("current") or {}
        km_at_snap = int(cur.get("km") or 0)
        points = row.get("forecastByKm") or []
        for p in points:
            km = p.get("km")
            pred_dt = _parse_dt(p.get("predictedCrossing"))
            if km is None or not pred_dt:
                continue
            km_i = int(km)
            actual_dt = actual_by_km.get(km_i)
            if not actual_dt:
                continue
            # Only validate forward-looking predictions made before the real crossing.
            if rec and rec >= actual_dt:
                continue
            if km_i > int(current_km):
                continue
            err_min = (pred_dt - actual_dt).total_seconds() / 60.0
            ahead_km = max(0, km_i - km_at_snap)
            bucket = "short" if ahead_km <= 25 else "mid" if ahead_km <= 75 else "long"
            samples.append({"km": km_i, "errMin": err_min, "aheadKm": ahead_km, "bucket": bucket})

    if not samples:
        return None

    def stats(vals: list[float]) -> dict[str, Any]:
        # Local imports to avoid relying on module-level imports in cached runtimes.
        import math as _math
        import statistics as _statistics
        abs_vals = [abs(v) for v in vals]
        mae = _statistics.mean(abs_vals)
        rmse = _math.sqrt(_statistics.mean([v * v for v in vals]))
        bias = _statistics.mean(vals)
        p50 = _statistics.median(abs_vals)
        p90 = sorted(abs_vals)[max(0, min(len(abs_vals) - 1, int(round((len(abs_vals) - 1) * 0.9))))]
        return {
            "n": len(vals),
            "maeMin": round(mae, 1),
            "rmseMin": round(rmse, 1),
            "biasMin": round(bias, 1),
            "p50AbsMin": round(p50, 1),
            "p90AbsMin": round(p90, 1),
        }

    by_bucket: dict[str, list[float]] = {"short": [], "mid": [], "long": []}
    for s in samples:
        by_bucket[s["bucket"]].append(float(s["errMin"]))

    return {
        "n": len(samples),
        "overall": stats([float(s["errMin"]) for s in samples]),
        "byHorizon": {
            k: stats(v) for k, v in by_bucket.items() if v
        },
        "latestSamples": samples[-30:],
    }


def build_prediction_evolution(
    *,
    current_km: int,
    current_finish_main: str | None,
    calendar_deadline: str | None = None,
    splits: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Timeline + backtest for Objetivos tab."""
    deadline = calendar_deadline or CALENDAR_DEADLINE
    raw = _load_all_snapshots()
    if not raw:
        return {
            "ok": False,
            "count": 0,
            "timeline": [],
            "backtest": [],
            "summary": None,
            "label": "Sem histórico de snapshots — corre refresh_data.py",
        }

    thin = _thin_snapshots(raw)
    timeline: list[dict[str, Any]] = []
    for row in thin:
        t = row.get("recordedAt")
        cur = row.get("current") or {}
        scenarios = row.get("scenarios") or {}
        km = int(cur.get("km") or 0)
        fin_main = _finish_iso(row)
        fin_opt = (scenarios.get("optimistic") or {}).get("finish")
        fin_pes = (scenarios.get("pessimistic") or {}).get("finish")
        margin = _margin_main(row)
        timeline.append(
            {
                "recordedAt": t,
                "km": km,
                "finishMain": fin_main,
                "finishOptimistic": fin_opt,
                "finishPessimistic": fin_pes,
                "marginMainMin": margin,
                "calendarConfPct": _calendar_conf(row),
                "kmPerDayMain": (scenarios.get("main") or {}).get("kmPerDay"),
                "modelVersion": (row.get("model") or {}).get("version"),
            }
        )

    # Append/sync current prediction if newer than last snapshot
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if current_finish_main:
        last = timeline[-1] if timeline else None
        fin_dt = _parse_dt(current_finish_main)
        dl = _parse_dt(deadline)
        margin_now = round((dl - fin_dt).total_seconds() / 60) if fin_dt and dl else None
        if (
            not last
            or last.get("km") != current_km
            or last.get("finishMain") != current_finish_main
        ):
            timeline.append(
                {
                    "recordedAt": now_str,
                    "km": current_km,
                    "finishMain": current_finish_main,
                    "finishOptimistic": None,
                    "finishPessimistic": None,
                    "marginMainMin": margin_now,
                    "calendarConfPct": None,
                    "kmPerDayMain": None,
                    "modelVersion": None,
                    "isCurrent": True,
                }
            )
        elif last:
            last["isCurrent"] = True
            if margin_now is not None:
                last["marginMainMin"] = margin_now

    backtest: list[dict[str, Any]] = []
    current_fin = current_finish_main or (timeline[-1].get("finishMain") if timeline else None)
    now = datetime.now()

    for row in reversed(thin[-12:]):
        t = _parse_dt(row.get("recordedAt"))
        if not t:
            continue
        cur = row.get("current") or {}
        km_then = int(cur.get("km") or 0)
        fin_then = _finish_iso(row)
        hours_elapsed = max(0.01, (now - t).total_seconds() / 3600.0)
        km_done = max(0, current_km - km_then)
        actual_kpd = round(km_done / (hours_elapsed / 24.0), 1) if km_done else 0.0

        revision_min: int | None = None
        if fin_then and current_fin:
            a = _parse_dt(fin_then)
            b = _parse_dt(current_fin)
            if a and b:
                revision_min = round((b - a).total_seconds() / 60)

        margin_then = _margin_main(row)
        margin_now = None
        if current_fin:
            dl = _parse_dt(deadline)
            fin_now = _parse_dt(current_fin)
            if dl and fin_now:
                margin_now = round((dl - fin_now).total_seconds() / 60)

        backtest.append(
            {
                "recordedAt": row.get("recordedAt"),
                "kmThen": km_then,
                "finishThen": fin_then,
                "finishNow": current_fin,
                "revisionMin": revision_min,
                "marginThenMin": margin_then,
                "marginNowMin": margin_now,
                "kmSince": km_done,
                "hoursSince": round(hours_elapsed, 1),
                "actualKmPerDay": actual_kpd if km_done else None,
            }
        )

    backtest.reverse()

    summary: dict[str, Any] | None = None
    if len(timeline) >= 2:
        first, last_pt = timeline[0], timeline[-1]
        fins = [_parse_dt(p.get("finishMain")) for p in timeline if p.get("finishMain")]
        fins = [f for f in fins if f]
        margins = [p["marginMainMin"] for p in timeline if p.get("marginMainMin") is not None]
        swing_h = 0.0
        if len(fins) >= 2:
            swing_h = round((max(fins) - min(fins)).total_seconds() / 3600.0, 1)
        rev_total: int | None = None
        if first.get("finishMain") and last_pt.get("finishMain"):
            a = _parse_dt(first["finishMain"])
            b = _parse_dt(last_pt["finishMain"])
            if a and b:
                rev_total = round((b - a).total_seconds() / 60)
        summary = {
            "snapshots": len(raw),
            "points": len(timeline),
            "firstAt": first.get("recordedAt"),
            "lastAt": last_pt.get("recordedAt"),
            "firstFinish": first.get("finishMain"),
            "currentFinish": last_pt.get("finishMain"),
            "finishSwingHours": swing_h,
            "revisionTotalMin": rev_total,
            "marginFirstMin": margins[0] if margins else None,
            "marginCurrentMin": margins[-1] if margins else None,
            "marginSwingMin": (max(margins) - min(margins)) if len(margins) >= 2 else None,
        }

    return {
        "ok": True,
        "count": len(raw),
        "timeline": timeline,
        "backtest": backtest,
        "forecastAccuracy": _forecast_accuracy_summary(raw, splits=splits, current_km=current_km),
        "summary": summary,
        "label": f"{len(timeline)} pontos · {len(raw)} snapshots gravados",
        "calendarDeadline": deadline,
    }
