#!/usr/bin/env python3
"""Calculate per-kilometer split times from Stop&Go GPS tracking data."""

from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from typing import Iterable

API_BASE = "https://api.stopandgo.pro"

from pace_categories import categorize_segment


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def project_on_segment(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return 0.0, x1, y1
    t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return t, x1 + t * dx, y1 + t * dy


def decode_api_json(raw):
    if not raw:
        raise ValueError("Empty API response")
    if raw[:1] in (b"[", b"{"):
        text = raw.decode("utf-8")
    elif raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        text = raw.decode("utf-16")
    elif raw[:1] == b"\x00":
        text = raw[1:].decode("utf-16-le")
    else:
        text = raw.decode("utf-8", errors="replace")
    text = text.lstrip()
    if text.startswith("#"):
        text = text[text.find("["):]
    return json.loads(text)


def fetch_url(url):
    """Fetch without HTTP_PROXY — IDE/sandbox proxies break api.stopandgo.pro."""
    req = urllib.request.Request(url, headers={"User-Agent": "km-splits-script/1.0"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=120) as resp:
        return resp.read()


def load_route(path, id_evento, id_etapa):
    raw = open(path, "rb").read() if path else fetch_url(
        f"{API_BASE}/tracking/tracks.php?id_evento={id_evento}&id_etapa={id_etapa}"
    )
    routes = decode_api_json(raw)
    geom = routes[0]["source"]["data"]["geometry"]
    coords = geom["coordinates"]
    dist = geom.get("distanceInMeters")
    if not dist:
        dist = [0.0]
        total = 0.0
        for i in range(1, len(coords)):
            lon1, lat1 = float(coords[i - 1][0]), float(coords[i - 1][1])
            lon2, lat2 = float(coords[i][0]), float(coords[i][1])
            total += haversine_m(lat1, lon1, lat2, lon2)
            dist.append(total)
    return coords, dist


def load_gps_log(path, id_evento, id_etapa, device_name, start_time, end_time):
    if path:
        raw = open(path, "rb").read()
        if raw[:1] in (b"[", b"{"):
            return json.loads(raw.decode("utf-8"))
        return decode_api_json(raw)
    params = {"id_evento": id_evento, "id_etapa": id_etapa, "device_name": device_name}
    if start_time:
        params["start_time"] = start_time
    if end_time:
        params["end_time"] = end_time
    url = f"{API_BASE}/tracking/trackersLog.php?{urllib.parse.urlencode(params)}"
    return decode_api_json(fetch_url(url))


def distance_along_route(lat, lon, coords, dist_meters):
    best_dist = float("inf")
    best_along = 0.0
    for i in range(len(coords) - 1):
        lon1, lat1 = float(coords[i][0]), float(coords[i][1])
        lon2, lat2 = float(coords[i + 1][0]), float(coords[i + 1][1])
        t, plon, plat = project_on_segment(lon, lat, lon1, lat1, lon2, lat2)
        off_route = haversine_m(lat, lon, plat, plon)
        along = dist_meters[i] + t * (dist_meters[i + 1] - dist_meters[i])
        if off_route < best_dist:
            best_dist = off_route
            best_along = along
    return best_along, best_dist


def parse_time(value):
    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")


def format_duration(seconds):
    seconds = max(0, int(round(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def format_pace(seconds_per_km):
    if seconds_per_km <= 0 or math.isinf(seconds_per_km):
        return "-"
    m, s = divmod(int(round(seconds_per_km)), 60)
    return f"{m}:{s:02d}/km"


def parse_battery(row):
    raw = row.get("BatteryPercentage") or row.get("Battery")
    if raw is None or raw == "":
        return None
    try:
        return round(float(raw), 1)
    except (TypeError, ValueError):
        return None


def smooth_progress(samples):
    if not samples:
        return samples
    cleaned = [samples[0]]
    for item in samples[1:]:
        ts, dist, batt = item[0], item[1], item[2] if len(item) > 2 else None
        prev_dist = cleaned[-1][1]
        if dist + 500 < prev_dist:
            continue
        if dist < prev_dist:
            dist = prev_dist
        cleaned.append((ts, dist, batt))
    return cleaned


def interpolate_crossing(samples, target_m):
    """Return (crossing_time, battery_pct) at distance target_m along route."""
    for i in range(1, len(samples)):
        t0, d0 = samples[i - 1][0], samples[i - 1][1]
        t1, d1 = samples[i][0], samples[i][1]
        b0 = samples[i - 1][2] if len(samples[i - 1]) > 2 else None
        b1 = samples[i][2] if len(samples[i]) > 2 else None
        if d0 <= target_m <= d1:
            if d1 == d0:
                ts = t1
                batt = b1 if b1 is not None else b0
            else:
                ratio = (target_m - d0) / (d1 - d0)
                ts = t0 + timedelta(seconds=(t1 - t0).total_seconds() * ratio)
                if b0 is not None and b1 is not None:
                    batt = round(b0 + ratio * (b1 - b0), 1)
                else:
                    batt = b1 if b1 is not None else b0
            return ts, batt
    return None, None


def usable_splits(splits: list[dict]) -> list[dict]:
    """Splits with full km on the official route (exclude gaps and partial first segment)."""
    return [s for s in splits if not s.get("unavailable") and not s.get("partial")]


def _no_category_fields() -> dict:
    return {
        "category": None,
        "categoryLabel": "—",
        "categoryShort": "—",
        "categoryColor": None,
    }


def _unavailable_split(km: int) -> dict:
    return {
        "km": km,
        "unavailable": True,
        "crossing_time": None,
        "segment_time_s": None,
        "segment_time": "—",
        "pace": "—",
        "elapsed_time_s": None,
        "elapsed_time": "—",
        "battery_pct": None,
        "battery": "—",
        "category": "unknown",
        "categoryLabel": "Sem dados",
        "categoryShort": "—",
        "categoryColor": "#5a6a82",
    }


def compute_splits(samples, start_time=None):
    if not samples:
        return []
    samples = smooth_progress(samples)
    origin = start_time or samples[0][0]
    first_along_km = samples[0][1] / 1000.0
    first_marker_km = int(first_along_km) + 1
    max_km = int(samples[-1][1] // 1000)

    if first_marker_km > 1:
        print(
            f"Nota: GPS desde {samples[0][0].strftime('%H:%M')} mas no percurso oficial "
            f"ja em ~{first_along_km:.1f} km (km 1-{first_marker_km - 1} sem passagem registada)."
        )

    crossings = []
    for km in range(first_marker_km, max_km + 1):
        ts, batt = interpolate_crossing(samples, km * 1000.0)
        if ts:
            crossings.append((km, ts, batt))

    splits = []
    for km in range(1, first_marker_km):
        splits.append(_unavailable_split(km))

    for i, (km, ts, batt) in enumerate(crossings):
        prev_ts = samples[0][0] if i == 0 else crossings[i - 1][1]
        segment = (ts - prev_ts).total_seconds()
        is_partial = i == 0 and first_along_km > km - 1
        row = {
            "km": km,
            "unavailable": False,
            "crossing_time": ts.strftime("%Y-%m-%d %H:%M:%S"),
            "segment_time_s": segment,
            "segment_time": format_duration(segment),
            "pace": format_pace(segment),
            "elapsed_time_s": (ts - origin).total_seconds(),
            "elapsed_time": format_duration((ts - origin).total_seconds()),
            "battery_pct": batt,
            "battery": f"{batt:.0f}%" if batt is not None else "—",
            "partial": is_partial,
        }
        if is_partial:
            row.update(_no_category_fields())
        else:
            row.update(categorize_segment(segment))
        splits.append(row)
    return splits


def print_table(splits, athlete):
    print(f"\nSplits por km — {athlete}\n")
    print(f"{'Km':>4}  {'Hora passagem':<19}  {'Tempo km':>8}  {'Ritmo':>9}  {'Tempo acum.':>11}")
    print("-" * 58)
    for row in splits:
        print(
            f"{row['km']:4d}  {row['crossing_time']:<19}  {row['segment_time']:>8}  "
            f"{row['pace']:>9}  {row['elapsed_time']:>11}"
        )


def main():
    parser = argparse.ArgumentParser(description="Stop&Go km split calculator")
    parser.add_argument("--evento", type=int, default=4)
    parser.add_argument("--etapa", type=int, default=1)
    parser.add_argument("--device", default="535")
    parser.add_argument("--athlete", default="Nuno Faria")
    parser.add_argument("--start", default="2026-05-24 11:00:00")
    parser.add_argument("--log-start", default="2026-05-24 11:00:00")
    parser.add_argument("--log-end", default="2026-05-26 23:59:59")
    parser.add_argument("--route-file")
    parser.add_argument("--log-file")
    parser.add_argument("--json-out")
    parser.add_argument("--max-off-route-m", type=float, default=250.0)
    args = parser.parse_args()

    coords, dist_meters = load_route(args.route_file, args.evento, args.etapa)
    log = load_gps_log(args.log_file, args.evento, args.etapa, args.device, args.log_start, args.log_end)

    start_time = parse_time(args.start) if args.start else None
    samples = []
    skipped = 0
    for row in log:
        lat = float(row["Latitude"])
        lon = float(row["Longitude"])
        ts = parse_time(row["Time"])
        along, off_route = distance_along_route(lat, lon, coords, dist_meters)
        if off_route > args.max_off_route_m:
            skipped += 1
            continue
        samples.append((ts, along, parse_battery(row)))

    samples.sort(key=lambda x: x[0])
    if not samples:
        print("Sem pontos GPS validos.", file=sys.stderr)
        return 1

    splits = compute_splits(samples, start_time)
    print_table(splits, args.athlete)
    print(f"\nPontos GPS usados: {len(samples)} (ignorados {skipped} fora do percurso)")
    print(f"Distancia maxima estimada: {samples[-1][1]/1000:.2f} km")
    print(f"Percurso oficial: {dist_meters[-1]/1000:.1f} km")

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(splits, f, ensure_ascii=False, indent=2)
        print(f"JSON guardado em {args.json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
