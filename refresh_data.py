#!/usr/bin/env python3
"""Fetch Stop&Go API data, compute km splits, rebuild data.js for the analytics site."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Local km_splits module
sys.path.insert(0, str(Path(__file__).resolve().parent))
import km_splits as km
from prediction_model import build_prediction
from pace_categories import category_legend, summarize_categories

DIR = Path(__file__).resolve().parent
DATA_DIR = DIR / "cache"
RAW_DIR = DIR / "raw"
DATA_DIR.mkdir(exist_ok=True)

_PROXY_KEYS = (
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy", "GIT_HTTP_PROXY", "GIT_HTTPS_PROXY",
    "SOCKS_PROXY", "SOCKS5_PROXY", "socks_proxy", "socks5_proxy",
)


def strip_proxy_env() -> None:
    for key in _PROXY_KEYS:
        os.environ.pop(key, None)

EVENTO = 4
ETAPA = 1
DEVICE = "535"
ATHLETE = "Nuno Faria"
RACE_START = "2026-05-24 11:00:00"
LOG_START = "2026-05-24 11:00:00"


def log_end_time() -> str:
    return (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")


def raw_file_suffix(data: bytes) -> str:
    if not data:
        return ".bin"
    if data[:1] in (b"[", b"{"):
        return ".json"
    if data[:2] in (b"\xff\xfe", b"\xfe\xff") or data[:1] == b"\x00":
        return ".utf16le"
    return ".bin"


def save_raw_api_file(stem: str, raw: bytes) -> Path:
    """Persist exact API response bytes under project raw/ (latest + timestamped copy)."""
    RAW_DIR.mkdir(exist_ok=True)
    ext = raw_file_suffix(raw)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    (RAW_DIR / f"{stem}_{ts}{ext}").write_bytes(raw)
    latest = RAW_DIR / f"{stem}_latest{ext}"
    latest.write_bytes(raw)
    return latest


def _pick_position_feature(data: dict) -> dict | None:
    features = data.get("features") or []
    for feat in features:
        props = feat.get("properties") or {}
        if str(props.get("deviceName")) == str(DEVICE):
            return feat
    return features[0] if features else None


def parse_live_position(raw: bytes, source: str, coords, dist_m) -> dict | None:
    """Parse position.php / position_new.php GeoJSON for the tracked device."""
    data = km.decode_api_json(raw)
    feat = _pick_position_feature(data)
    if not feat:
        return None
    geom = feat.get("geometry") or {}
    coords_geo = geom.get("coordinates") or [0, 0]
    lon, lat = float(coords_geo[0]), float(coords_geo[1])
    props = feat.get("properties") or {}

    gps_ts = int(props.get("gpsTimeUTC") or props.get("lastTime") or 0)
    if not gps_ts:
        return None
    offset_h = float(props.get("timezoneOffsetInHours") or 1.0)
    gps_utc = datetime.fromtimestamp(gps_ts, tz=timezone.utc)
    gps_local = gps_utc + timedelta(hours=offset_h)
    gps_time = gps_local.replace(tzinfo=None)

    batt_raw = props.get("battery")
    batt_pct = None
    if batt_raw is not None and batt_raw != "":
        try:
            batt_pct = round(float(batt_raw), 1)
        except (TypeError, ValueError):
            pass

    along_km = None
    off_m = None
    if coords is not None and dist_m is not None:
        along, off_m = km.distance_along_route(lat, lon, coords, dist_m)
        along_km = round(along / 1000, 1)

    now = datetime.now()
    lag_min = round((now - gps_time).total_seconds() / 60, 1)

    return {
        "lat": round(lat, 6),
        "lng": round(lon, 6),
        "alt": round(float(props.get("altitude") or 0), 1),
        "speed": round(float(props.get("speed") or 0), 1),
        "status": props.get("status"),
        "batteryPct": batt_pct,
        "battery": f"{batt_pct:.0f}%" if batt_pct is not None else "—",
        "gpsTime": gps_time.strftime("%Y-%m-%d %H:%M:%S"),
        "gpsTimeUtc": gps_utc.strftime("%Y-%m-%d %H:%M:%S"),
        "lagMinutes": lag_min,
        "alongRouteKm": along_km,
        "offRouteM": round(off_m, 0) if off_m is not None else None,
        "source": source,
        "deviceName": str(props.get("deviceName") or DEVICE),
        "name": props.get("name") or ATHLETE,
    }


def fetch_live_position(coords, dist_m) -> tuple[dict | None, Path | None]:
    """Live fix from position_new (preferred) or position."""
    for endpoint in ("position_new.php", "position.php"):
        url = (
            f"{km.API_BASE}/tracking/{endpoint}"
            f"?id_evento={EVENTO}&id_etapa={ETAPA}"
        )
        try:
            raw = km.fetch_url(url)
            live = parse_live_position(raw, endpoint.replace(".php", ""), coords, dist_m)
            if live:
                path = save_raw_api_file(
                    endpoint.replace(".php", ""), raw
                )
                return live, path
        except Exception as exc:
            print(f"    AVISO: {endpoint} falhou ({exc})")
    return None, None


def load_live_from_cache() -> dict | None:
    path = DATA_DIR / "live_position.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return None


def fetch_event_meta() -> tuple[dict, Path | None]:
    url = f"{km.API_BASE}/xcrono/resultados_percursos.php?id_evento={EVENTO}&id_etapas={ETAPA}"
    raw = km.fetch_url(url)
    path = save_raw_api_file("event_meta", raw)
    rows = km.decode_api_json(raw)
    return (rows[0] if rows else {}, path)




def downsample_line(points, max_pts=600):
    if len(points) <= max_pts:
        return points
    step = len(points) / max_pts
    out = []
    i = 0.0
    while int(i) < len(points) and len(out) < max_pts:
        out.append(points[int(i)])
        i += step
    if points[-1] not in out:
        out.append(points[-1])
    return out


def pos_at_distance_m(coords, dist_m, target_m):
    for i in range(len(coords) - 1):
        d0, d1 = dist_m[i], dist_m[i + 1]
        if d1 < target_m:
            continue
        if d0 > target_m:
            break
        seg = d1 - d0
        t = 0.0 if seg <= 0 else (target_m - d0) / seg
        lon1, lat1 = float(coords[i][0]), float(coords[i][1])
        lon2, lat2 = float(coords[i + 1][0]), float(coords[i + 1][1])
        alt1 = float(coords[i][2]) if len(coords[i]) > 2 else 0
        alt2 = float(coords[i + 1][2]) if len(coords[i + 1]) > 2 else alt1
        return [
            lat1 + t * (lat2 - lat1),
            lon1 + t * (lon2 - lon1),
            alt1 + t * (alt2 - alt1),
        ]
    last = coords[-1]
    return [float(last[1]), float(last[0]), float(last[2]) if len(last) > 2 else 0]


def _split_index_for_along(along_m: float, splits: list) -> int:
    for i, s in enumerate(splits):
        start = splits[i - 1]["km"] * 1000.0 if i > 0 else -1.0
        end = s["km"] * 1000.0
        if along_m <= end and along_m > start:
            return i
    return len(splits) - 1


def _finish_category_run(pts, idx_start, idx_end, splits, max_pts):
    if len(pts) < 2:
        return None
    pts = downsample_line(pts, max_pts)
    from_km = splits[idx_start]["km"]
    to_km = splits[idx_end]["km"]
    end_s = splits[idx_end]
    return {
        "km": to_km,
        "fromKm": from_km,
        "toKm": to_km,
        "kms": list(range(from_km, to_km + 1)),
        "color": end_s.get("categoryColor", "#3d8bfd"),
        "category": end_s.get("category", "corrida"),
        "categoryLabel": end_s.get("categoryLabel", "Corrida"),
        "pace": end_s["pace"],
        "segment": end_s["segment_time"],
        "points": pts,
    }


def build_category_segments(coords, dist_m, log, splits, max_pts=200):
    """Trilho GPS contínuo: funde troços consecutivos da mesma categoria (sem buracos)."""
    along_pts = []
    for row in log:
        lat, lon = float(row["Latitude"]), float(row["Longitude"])
        along, off = km.distance_along_route(lat, lon, coords, dist_m)
        if off > 250:
            continue
        along_pts.append((along, lat, lon))
    along_pts.sort(key=lambda x: x[0])
    if not along_pts or not splits:
        return []

    tagged = []
    for along, lat, lon in along_pts:
        idx = _split_index_for_along(along, splits)
        s = splits[idx]
        if s.get("unavailable") or s.get("partial"):
            cat = None
        else:
            cat = s.get("category", "corrida")
        tagged.append((lat, lon, idx, cat))

    runs = []
    idx_start = tagged[0][2]
    idx_end = tagged[0][2]
    cur_cat = tagged[0][3]
    run_pts = [[tagged[0][0], tagged[0][1]]]

    for lat, lon, idx, cat in tagged[1:]:
        if cat == cur_cat:
            run_pts.append([lat, lon])
            idx_end = idx
        else:
            if cur_cat is not None and len(run_pts) >= 2:
                seg = _finish_category_run(run_pts, idx_start, idx_end, splits, max_pts)
                if seg:
                    runs.append(seg)
            cur_cat = cat
            idx_start = idx
            idx_end = idx
            run_pts = [[lat, lon]]

    if cur_cat is not None and len(run_pts) >= 2:
        seg = _finish_category_run(run_pts, idx_start, idx_end, splits, max_pts)
        if seg:
            runs.append(seg)
    return runs


def build_map_data(coords, dist_m, log, splits, live=None):
    route_pts = [[float(c[1]), float(c[0])] for c in coords]
    route_ds = downsample_line(route_pts, 700)

    track_raw = []
    for row in log:
        track_raw.append([
            float(row["Latitude"]),
            float(row["Longitude"]),
            round(float(row.get("Altitude", 0) or 0), 1),
            row["Time"],
            round(float(row.get("Speed", 0) or 0), 1),
        ])
    track_ds = downsample_line(track_raw, 550)
    category_segments = build_category_segments(coords, dist_m, log, splits)

    split_pts = []
    for s in splits:
        pos = pos_at_distance_m(coords, dist_m, s["km"] * 1000)
        split_pts.append({
            "km": s["km"],
            "lat": round(pos[0], 6),
            "lng": round(pos[1], 6),
            "alt": round(pos[2], 1),
            "time": s["crossing_time"],
            "pace": s["pace"],
            "segment": s["segment_time"],
            "elapsed": s["elapsed_time"],
            "segment_s": s["segment_time_s"],
            "partial": s.get("partial", False),
            "category": s.get("category"),
            "categoryLabel": s.get("categoryLabel"),
            "categoryColor": s.get("categoryColor"),
        })

    if live:
        current = {
            "lat": live["lat"],
            "lng": live["lng"],
            "alt": live["alt"],
            "time": live["gpsTime"],
            "battery": live["battery"],
            "batteryPct": live["batteryPct"],
            "speed": live["speed"],
            "status": live["status"],
            "alongRouteKm": live.get("alongRouteKm"),
            "source": live["source"],
            "lagMinutes": live.get("lagMinutes"),
            "logTime": log[-1]["Time"] if log else None,
        }
    else:
        last_row = log[-1]
        current = {
            "lat": round(float(last_row["Latitude"]), 6),
            "lng": round(float(last_row["Longitude"]), 6),
            "alt": round(float(last_row.get("Altitude", 0) or 0), 1),
            "time": last_row["Time"],
            "source": "trackersLog",
        }

    all_pts = route_ds + track_ds
    for seg in category_segments:
        all_pts.extend(seg["points"])
    lats = [p[0] for p in all_pts]
    lngs = [p[1] for p in all_pts]
    bounds = [
        [min(lats), min(lngs)],
        [max(lats), max(lngs)],
    ]
    return {
        "route": route_ds,
        "track": track_ds,
        "categorySegments": category_segments,
        "splits": split_pts,
        "current": current,
        "bounds": bounds,
    }

def build_route_profile(coords, dist_m, total_km: int) -> list[dict]:
    profile = []
    for km_i in range(1, total_km + 1):
        m0, m1 = (km_i - 1) * 1000, km_i * 1000
        alts, gains, losses = [], 0.0, 0.0
        for i in range(len(coords) - 1):
            d0, d1 = dist_m[i], dist_m[i + 1]
            if d1 < m0 or d0 > m1:
                continue
            a0, a1 = float(coords[i][2]), float(coords[i + 1][2])
            if a1 > a0:
                gains += a1 - a0
            else:
                losses += a0 - a1
            alts.extend([a0, a1])
        profile.append({
            "km": km_i,
            "elevation": round(sum(alts) / len(alts), 1) if alts else 0,
            "gain": round(gains, 1),
            "loss": round(losses, 1),
        })
    return profile


def build_analytics(
    splits, coords, dist_m, event_meta, log, first_sample=None, live=None
) -> dict:
    total_km = dist_m[-1] / 1000
    profile_full = build_route_profile(coords, dist_m, int(total_km))
    chart_profile = profile_full[::2]

    available = km.usable_splits(splits)
    last = available[-1] if available else splits[-1]
    current_km = last["km"]
    race_start = event_meta.get("horainicio", RACE_START)
    first_along_km = round(first_sample[1] / 1000, 1) if first_sample else 0
    first_gps_time = (
        first_sample[0].strftime("%Y-%m-%d %H:%M:%S") if first_sample else None
    )
    prediction = build_prediction(
        available, profile_full, current_km, total_km, last["crossing_time"], race_start
    )
    return {
        "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "athlete": {"name": ATHLETE, "bib": 1, "device": DEVICE},
        "event": {
            "name": event_meta.get("descricao", "Travessia"),
            "totalKm": round(total_km, 1),
            "startTime": event_meta.get("horainicio", RACE_START),
            "firstAlongRouteKm": first_along_km,
            "firstGpsTime": first_gps_time,
            "firstSplitKm": available[0]["km"] if available else None,
            "partialKm": next((s["km"] for s in splits if s.get("partial")), None),
            "unavailableKmCount": sum(1 for s in splits if s.get("unavailable")),
        },
        "current": {
            "km": current_km,
            "remainingKm": round(total_km - current_km, 1),
            "lastCrossing": last["crossing_time"],
            "elapsed": last["elapsed_time"],
            "progressPct": round(100 * current_km / total_km, 1),
        },
        "splits": splits,
        "categoryLegend": category_legend(),
        "categorySummary": summarize_categories(splits),
        "routeProfile": chart_profile,
        "routeProfileFull": profile_full,
        "prediction": prediction,
        "live": live,
        "map": build_map_data(coords, dist_m, log, splits, live=live),
        "stats": {
            "fastest": min(available, key=lambda x: x["segment_time_s"]),
            "slowest": max(available, key=lambda x: x["segment_time_s"]),
            "movingCount": prediction["performance"]["movingSegments"],
            "gpsPoints": None,
        },
    }



def load_from_cache():
    """Use cache/*.json when API is unreachable."""
    cache = DATA_DIR
    event = json.loads((cache / "event_meta.json").read_text(encoding="utf-8"))
    event_meta = event[0] if isinstance(event, list) else event
    routes = json.loads((cache / "route.json").read_text(encoding="utf-8"))
    log = json.loads((cache / "gps_log.json").read_text(encoding="utf-8"))
    return event_meta, routes, log

def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="Use cache/ only")
    args_cli = ap.parse_args()
    if not args_cli.offline:
        strip_proxy_env()

    print("=== Actualizacao Travessia Analytics ===")
    print(f"Data/hora: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    raw_saved: list[Path] = []
    api_live = False
    api_log = False

    # Baseline from cache (route + log always needed for splits)
    event_meta, routes, log = load_from_cache()
    start = event_meta.get("horainicio", RACE_START)
    coords, dist_m = km.load_route(str(DATA_DIR / "route.json"), EVENTO, ETAPA)
    live = None

    if args_cli.offline:
        print("Modo offline: a usar cache/")
        print(f"    Pontos GPS (cache): {len(log)}")
        live = load_live_from_cache()
        if live:
            print(f"    Posicao live (cache): {live.get('gpsTime')} via {live.get('source')}")
    else:
        print("1/4 Posicao live (position_new / position)...")
        live, live_path = fetch_live_position(coords, dist_m)
        if live:
            api_live = True
            live["logTime"] = log[-1]["Time"] if log else None
            raw_saved.append(live_path)
            (DATA_DIR / "live_position.json").write_text(
                json.dumps(live, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print(
                f"    GPS ao vivo: {live['gpsTime']} · {live['battery']} "
                f"· km ~{live.get('alongRouteKm')} ({live['source']})"
            )
        else:
            live = load_live_from_cache()
            if live:
                print(f"    Live em cache: {live.get('gpsTime')}")
            else:
                print("    AVISO: sem posicao live")

        print("2/4 Meta do evento...")
        try:
            event_meta, raw_path = fetch_event_meta()
            if raw_path:
                raw_saved.append(raw_path)
            start = event_meta.get("horainicio", RACE_START)
            (DATA_DIR / "event_meta.json").write_text(
                json.dumps(event_meta, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except Exception as e:
            print(f"    AVISO: meta em cache ({e})")

        print("3/4 Percurso (tracks.php)...")
        try:
            route_raw = km.fetch_url(
                f"{km.API_BASE}/tracking/tracks.php?id_evento={EVENTO}&id_etapa={ETAPA}"
            )
            route_latest = save_raw_api_file("route", route_raw)
            raw_saved.append(route_latest)
            (DATA_DIR / "route_raw.bin").write_bytes(route_raw)
            routes = km.decode_api_json(route_raw)
            (DATA_DIR / "route.json").write_text(
                json.dumps(routes, ensure_ascii=False), encoding="utf-8"
            )
            coords, dist_m = km.load_route(str(route_latest), EVENTO, ETAPA)
        except Exception as e:
            print(f"    AVISO: percurso em cache ({e})")

        print("4/4 Log GPS (trackersLog.php)...")
        try:
            log_end = log_end_time()
            params = {
                "id_evento": EVENTO,
                "id_etapa": ETAPA,
                "device_name": DEVICE,
                "start_time": LOG_START,
                "end_time": log_end,
            }
            import urllib.parse
            url = f"{km.API_BASE}/tracking/trackersLog.php?{urllib.parse.urlencode(params)}"
            log_raw = km.fetch_url(url)
            gps_latest = save_raw_api_file("gps_log", log_raw)
            raw_saved.append(gps_latest)
            (DATA_DIR / "gps_log_raw.bin").write_bytes(log_raw)
            log = km.decode_api_json(log_raw)
            (DATA_DIR / "gps_log.json").write_text(
                json.dumps(log, ensure_ascii=False), encoding="utf-8"
            )
            api_log = True
            print(f"    Pontos GPS: {len(log)} (ate {log_end})")
            if live:
                live["logTime"] = log[-1]["Time"]
                (DATA_DIR / "live_position.json").write_text(
                    json.dumps(live, ensure_ascii=False, indent=2), encoding="utf-8"
                )
        except Exception as e:
            print(f"    AVISO: log em cache ({len(log)} pts) — {e}")

    print("5/5 Splits + data.js...")
    start_time = km.parse_time(start)
    samples, skipped = [], 0
    for row in log:
        lat, lon = float(row["Latitude"]), float(row["Longitude"])
        ts = km.parse_time(row["Time"])
        along, off = km.distance_along_route(lat, lon, coords, dist_m)
        if off > 250:
            skipped += 1
            continue
        batt = km.parse_battery(row)
        samples.append((ts, along, batt))
    samples.sort(key=lambda x: x[0])
    if not samples:
        print("ERRO: sem pontos GPS validos.", file=sys.stderr)
        return 1

    splits = km.compute_splits(samples, start_time)
    analytics = build_analytics(
        splits, coords, dist_m, event_meta, log, first_sample=samples[0], live=live
    )
    analytics["stats"]["gpsPoints"] = len(samples)
    analytics["stats"]["gpsSkipped"] = skipped

    (DIR / "km_splits.json").write_text(
        json.dumps(splits, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DIR / "data.json").write_text(
        json.dumps(analytics, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DIR / "data.js").write_text(
        "window.ANALYTICS = " + json.dumps(analytics, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )

    print()
    print(f"  Atleta:     {ATHLETE}")
    print(f"  Km actual:  {analytics['current']['km']} ({analytics['current']['progressPct']}%)")
    print(f"  Ultimo km:  {analytics['current']['lastCrossing']}")
    if analytics.get("live"):
        lv = analytics["live"]
        print(
            f"  GPS live:   {lv['gpsTime']} · {lv['battery']} · km ~{lv.get('alongRouteKm')} "
            f"({lv['source']})"
        )
    elif log:
        print(f"  Ultimo log: {log[-1]['Time']} (trackersLog)")
    print(f"  Chegada est:{analytics['prediction']['finishTime']} (~{analytics['prediction']['remainingHours']} h)")
    print(f"  Ficheiros:  data.js, data.json, km_splits.json")
    if raw_saved:
        print(f"  Raw API:    {RAW_DIR}/")
        for p in raw_saved:
            print(f"              {p.name} ({p.stat().st_size:,} bytes)")
    print("=== Concluido ===")
    print(f"API_STATUS: live={'online' if api_live else 'cache'} log={'online' if api_log else 'cache'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
