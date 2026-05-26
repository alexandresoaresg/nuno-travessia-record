"""Min/max air temperature during moving windows (Open-Meteo archive + cache)."""

from __future__ import annotations

import json
import urllib.parse
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import km_splits as km

LONG_STOP_THRESHOLD_S = 3600
WEATHER_CACHE = Path(__file__).resolve().parent / "cache" / "weather_hourly.json"


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(str(s).strip(), fmt)
        except ValueError:
            continue
    return None


def _usable_splits(splits: list[dict]) -> list[dict]:
    return [
        s
        for s in splits
        if not s.get("unavailable") and not s.get("partial") and s.get("crossing_time")
    ]


def _moving_intervals(day_segs: list[dict]) -> list[tuple[datetime, datetime]]:
    intervals: list[tuple[datetime, datetime]] = []
    for s in day_segs:
        t = float(s.get("segment_time_s") or 0)
        end = _parse_dt(s.get("crossing_time"))
        if not end or t <= 0 or t >= LONG_STOP_THRESHOLD_S:
            continue
        start = end - timedelta(seconds=t)
        intervals.append((start, end))
    if not intervals:
        return []
    intervals.sort(key=lambda x: x[0])
    merged: list[tuple[datetime, datetime]] = [intervals[0]]
    for start, end in intervals[1:]:
        prev_s, prev_e = merged[-1]
        if start <= prev_e:
            merged[-1] = (prev_s, max(prev_e, end))
        else:
            merged.append((start, end))
    return merged


def _intervals_overlap(a0: datetime, a1: datetime, b0: datetime, b1: datetime) -> bool:
    return a0 < b1 and b0 < a1


def _load_cache() -> dict[str, Any]:
    if not WEATHER_CACHE.exists():
        return {}
    try:
        return json.loads(WEATHER_CACHE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_cache(cache: dict[str, Any]) -> None:
    WEATHER_CACHE.parent.mkdir(parents=True, exist_ok=True)
    WEATHER_CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def _cache_key(lat: float, lon: float, start_date: str, end_date: str) -> str:
    return f"{round(lat, 2):.2f},{round(lon, 2):.2f},{start_date},{end_date}"


def _fetch_hourly(lat: float, lon: float, start_date: str, end_date: str, *, offline: bool) -> dict[str, float] | None:
    cache = _load_cache()
    key = _cache_key(lat, lon, start_date, end_date)
    if key in cache:
        return {k: float(v) for k, v in cache[key].items()}

    if offline:
        return None

    params = urllib.parse.urlencode(
        {
            "latitude": round(lat, 4),
            "longitude": round(lon, 4),
            "start_date": start_date,
            "end_date": end_date,
            "hourly": "temperature_2m",
            "timezone": "Europe/Lisbon",
        }
    )
    url = f"https://archive-api.open-meteo.com/v1/archive?{params}"
    try:
        raw = km.fetch_url(url)
        data = json.loads(raw)
        times = data.get("hourly", {}).get("time") or []
        temps = data.get("hourly", {}).get("temperature_2m") or []
        hourly = {
            t: float(v)
            for t, v in zip(times, temps)
            if v is not None
        }
        cache[key] = hourly
        _save_cache(cache)
        return hourly
    except Exception:
        return None


def _gps_centroid(gps_log: list[dict], intervals: list[tuple[datetime, datetime]]) -> tuple[float, float] | None:
    lats: list[float] = []
    lons: list[float] = []
    for row in gps_log:
        t = _parse_dt(row.get("Time"))
        if not t:
            continue
        if not any(a <= t <= b for a, b in intervals):
            continue
        try:
            lats.append(float(row["Latitude"]))
            lons.append(float(row["Longitude"]))
        except (KeyError, TypeError, ValueError):
            continue
    if not lats:
        return None
    return sum(lats) / len(lats), sum(lons) / len(lons)


def _temps_for_intervals(
    hourly: dict[str, float],
    intervals: list[tuple[datetime, datetime]],
) -> list[float]:
    picked: list[float] = []
    for ts, temp in hourly.items():
        try:
            hour_start = datetime.strptime(ts, "%Y-%m-%dT%H:%M")
        except ValueError:
            continue
        hour_end = hour_start + timedelta(hours=1)
        if any(_intervals_overlap(hour_start, hour_end, a, b) for a, b in intervals):
            picked.append(temp)
    return picked


def enrich_days_with_temperature(
    days: list[dict[str, Any]],
    splits: list[dict],
    gps_log: list[dict],
    *,
    offline: bool = False,
) -> None:
    """Attach tempMinC / tempMaxC / tempSource to each day (moving time only)."""
    usable = _usable_splits(splits)
    for day in days:
        km_from = int(day.get("kmFrom") or 0)
        km_to = int(day.get("kmTo") or 0)
        day_segs = [s for s in usable if km_from <= s["km"] <= km_to]
        intervals = _moving_intervals(day_segs)
        if not intervals:
            day["tempMinC"] = None
            day["tempMaxC"] = None
            day["tempSource"] = None
            continue

        centroid = _gps_centroid(gps_log, intervals)
        if not centroid:
            day["tempMinC"] = None
            day["tempMaxC"] = None
            day["tempSource"] = None
            continue

        lat, lon = centroid
        start_date = min(a for a, _ in intervals).strftime("%Y-%m-%d")
        end_date = max(b for _, b in intervals).strftime("%Y-%m-%d")
        hourly = _fetch_hourly(lat, lon, start_date, end_date, offline=offline)
        if not hourly:
            day["tempMinC"] = None
            day["tempMaxC"] = None
            day["tempSource"] = "sem dados (offline ou API indisponível)"
            continue

        temps = _temps_for_intervals(hourly, intervals)
        if not temps:
            day["tempMinC"] = None
            day["tempMaxC"] = None
            day["tempSource"] = "Open-Meteo (sem horas sobrepostas)"
            continue

        day["tempMinC"] = round(min(temps), 1)
        day["tempMaxC"] = round(max(temps), 1)
        day["tempSource"] = "Open-Meteo (2 m, horas em movimento)"
