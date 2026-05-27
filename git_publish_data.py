"""Commit and push analytics data files after a successful refresh."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Sequence

REPO_DIR = Path(__file__).resolve().parent

DEFAULT_DATA_PATHS: tuple[str, ...] = (
    "data.js",
    "data.json",
    "km_splits.json",
)


def _auto_git_enabled(kind: str = "full") -> bool:
    if os.environ.get("TRAVESSIA_SKIP_GIT_PUBLISH", "").strip().lower() in ("1", "true", "yes"):
        return False
    if os.environ.get("TRAVESSIA_AUTO_GIT", "1").strip().lower() in ("0", "false", "no"):
        return False
    if kind == "live" and os.environ.get("TRAVESSIA_AUTO_GIT_LIVE", "1").strip().lower() in (
        "0",
        "false",
        "no",
    ):
        return False
    return True


def _run_git(args: list[str], *, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=False,
    )


def _commit_message(repo_dir: Path, *, kind: str) -> str:
    updated = "unknown"
    data_json = repo_dir / "data.json"
    if data_json.exists():
        try:
            payload = json.loads(data_json.read_text(encoding="utf-8"))
            updated = payload.get("updatedAt") or updated
            km = (payload.get("current") or {}).get("km")
            if km is not None:
                updated = f"{updated}, km {km}"
        except (OSError, json.JSONDecodeError, TypeError):
            pass
    label = "live" if kind == "live" else "full"
    return f"Refresh analytics snapshot ({label}, {updated})."


def publish_data_changes(
    repo_dir: Path | None = None,
    *,
    paths: Sequence[str] | None = None,
    kind: str = "full",
    push: bool = True,
    dry_run: bool = False,
) -> dict[str, Any]:
    if not _auto_git_enabled(kind):
        return {"ok": True, "committed": False, "reason": "auto_git_disabled"}

    root = (repo_dir or REPO_DIR).resolve()
    rel_paths = list(paths or DEFAULT_DATA_PATHS)
    existing = [p for p in rel_paths if (root / p).exists()]
    if not existing:
        return {"ok": True, "committed": False, "reason": "no_data_files"}

    inside = _run_git(["rev-parse", "--is-inside-work-tree"], cwd=root)
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return {"ok": True, "committed": False, "reason": "not_a_git_repo"}

    status = _run_git(["status", "--porcelain", "--", *existing], cwd=root)
    if status.returncode != 0:
        return {"ok": False, "committed": False, "error": status.stderr.strip() or "git status failed"}
    if not status.stdout.strip():
        return {"ok": True, "committed": False, "reason": "no_changes"}

    if dry_run:
        return {
            "ok": True,
            "committed": False,
            "dry_run": True,
            "would_commit": existing,
            "changes": status.stdout.strip(),
        }

    add = _run_git(["add", "--", *existing], cwd=root)
    if add.returncode != 0:
        return {"ok": False, "committed": False, "error": add.stderr.strip() or "git add failed"}

    msg = _commit_message(root, kind=kind)
    commit = _run_git(["commit", "-m", msg], cwd=root)
    if commit.returncode != 0:
        err = (commit.stderr or commit.stdout or "").strip()
        return {"ok": False, "committed": False, "error": err or "git commit failed"}

    out: dict[str, Any] = {
        "ok": True,
        "committed": True,
        "pushed": False,
        "message": msg,
        "files": existing,
    }

    if not push:
        return out

    push_res = _run_git(["push"], cwd=root)
    if push_res.returncode != 0:
        out["ok"] = False
        out["error"] = (push_res.stderr or push_res.stdout or "").strip() or "git push failed"
        return out

    out["pushed"] = True
    return out


def print_publish_result(result: dict[str, Any]) -> None:
    if result.get("dry_run"):
        print(f"  Git (dry-run): changes in {', '.join(result.get('would_commit', []))}")
        return
    if not result.get("committed"):
        reason = result.get("reason")
        if reason and reason not in ("no_changes", "auto_git_disabled"):
            print(f"  Git: skipped ({reason})")
        return
    msg = "commit"
    if result.get("pushed"):
        msg = "commit + push"
    elif result.get("error"):
        print(f"  Git: {msg} OK, push failed - {result['error']}")
        return
    print(f"  Git: {msg} - {result.get('message', '')}")
