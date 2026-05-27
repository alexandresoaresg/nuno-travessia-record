"""Well-known cities snapped to the official Travessia route (Norte → Sul)."""

from __future__ import annotations

import math
from typing import Any

# lat, lng, major = shown on small profile chart when cities enabled
LANDMARKS: list[dict[str, Any]] = [
    {"name": "Viana do Castelo", "lat": 41.693, "lng": -8.834, "major": True},
    {"name": "Barcelos", "lat": 41.532, "lng": -8.615},
    {"name": "Porto", "lat": 41.158, "lng": -8.629, "major": True},
    {"name": "Aveiro", "lat": 40.641, "lng": -8.654, "major": True},
    {"name": "Figueira da Foz", "lat": 40.151, "lng": -8.861},
    {"name": "Leiria", "lat": 39.744, "lng": -8.807, "major": True},
    {"name": "Santarém", "lat": 39.236, "lng": -8.686, "major": True},
    {"name": "Grândola", "lat": 38.177, "lng": -8.567},
    {"name": "Sines", "lat": 37.956, "lng": -8.869},
    {"name": "Zambujeira do Mar", "lat": 37.525, "lng": -8.785},
    {"name": "Lagos", "lat": 37.103, "lng": -8.673, "major": True},
    {"name": "Sagres", "lat": 37.008, "lng": -8.947, "major": True},
]


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p = math.pi / 180.0
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin(
        (lon2 - lon1) * p / 2
    ) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def snap_landmarks_to_route(coords: list, dist_m: list[float]) -> list[dict[str, Any]]:
    """Return landmarks with km along official route."""
    if not coords or not dist_m:
        return []
    route_pts = [(float(c[1]), float(c[0])) for c in coords]
    out: list[dict[str, Any]] = []
    for lm in LANDMARKS:
        lat, lng = float(lm["lat"]), float(lm["lng"])
        best_i, best_d = 0, 1e18
        for i, (rlat, rlng) in enumerate(route_pts):
            d = _haversine_m(lat, lng, rlat, rlng)
            if d < best_d:
                best_d, best_i = d, i
        if best_d > 18000:
            continue
        km = round(dist_m[best_i] / 1000.0)
        entry: dict[str, Any] = {
            "km": km,
            "name": lm["name"],
            "major": bool(lm.get("major")),
            "offRouteKm": round(best_d / 1000.0, 1),
        }
        out.append(entry)
    out.sort(key=lambda x: x["km"])
    # drop duplicates within 8 km (keep major or closer)
    merged: list[dict[str, Any]] = []
    for item in out:
        if not merged or item["km"] - merged[-1]["km"] >= 8:
            merged.append(item)
            continue
        prev = merged[-1]
        if item.get("major") and not prev.get("major"):
            merged[-1] = item
        elif item.get("offRouteKm", 99) < prev.get("offRouteKm", 99):
            merged[-1] = item
    return merged
