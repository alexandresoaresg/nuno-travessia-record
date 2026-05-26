"""Classify each km segment by pace (ultra-trail context)."""

from __future__ import annotations

CATEGORIES = [
    {"id": "corrida_forte", "label": "Corrida forte", "short": "Forte", "max_s": 360, "color": "#22c55e"},
    {"id": "corrida", "label": "Corrida", "short": "Corrida", "max_s": 450, "color": "#3d8bfd"},
    {"id": "corrida_leve", "label": "Corrida leve", "short": "Leve", "max_s": 600, "color": "#38bdf8"},
    {"id": "andar", "label": "Andar", "short": "Andar", "max_s": 900, "color": "#a78bfa"},
    {"id": "paragem", "label": "Paragem", "short": "Paragem", "max_s": None, "color": "#f59e0b"},
]


def categorize_segment(segment_time_s: float) -> dict:
    for cat in CATEGORIES:
        if cat["max_s"] is None or segment_time_s < cat["max_s"]:
            return {
                "category": cat["id"],
                "categoryLabel": cat["label"],
                "categoryShort": cat["short"],
                "categoryColor": cat["color"],
            }
    return {
        "category": "paragem",
        "categoryLabel": "Paragem",
        "categoryShort": "Paragem",
        "categoryColor": "#f59e0b",
    }


def category_legend() -> list[dict]:
    ranges = [
        ("corrida_forte", "< 6:00 / km"),
        ("corrida", "6:00 - 7:30 / km"),
        ("corrida_leve", "7:30 - 10:00 / km"),
        ("andar", "10:00 - 15:00 / km"),
        ("paragem", ">= 15:00 / km"),
    ]
    by_id = {c["id"]: c for c in CATEGORIES}
    out = []
    for cid, pace_range in ranges:
        c = by_id[cid]
        out.append({
            "id": cid,
            "label": c["label"],
            "short": c["short"],
            "color": c["color"],
            "paceRange": pace_range,
        })
    return out


def summarize_categories(splits: list[dict]) -> dict:
    counts = {c["id"]: 0 for c in CATEGORIES}
    usable = [s for s in splits if not s.get("unavailable") and not s.get("partial")]
    for s in usable:
        cid = s.get("category", categorize_segment(s["segment_time_s"])["category"])
        counts[cid] = counts.get(cid, 0) + 1
    total = len(usable) or 1
    return {
        "counts": counts,
        "total": len(usable),
        "pct": {k: round(100 * v / total, 1) for k, v in counts.items()},
    }
