"""Background tasks (raw API archive, prediction history) — off the refresh hot path."""

from __future__ import annotations

import copy
import queue
import sys
import threading
from typing import Any, Callable

_task_queue: queue.Queue = queue.Queue()
_worker_lock = threading.Lock()
_worker_started = False


def _worker() -> None:
    while True:
        item = _task_queue.get()
        try:
            if item is None:
                return
            fn, args, kwargs = item
            fn(*args, **kwargs)
        except Exception as exc:
            print(f"background_pipeline: {exc}", file=sys.stderr)
        finally:
            _task_queue.task_done()


def start_worker() -> None:
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        _worker_started = True
        t = threading.Thread(target=_worker, name="travessia-bg-pipeline", daemon=True)
        t.start()


def enqueue(fn: Callable, *args: Any, **kwargs: Any) -> None:
    start_worker()
    _task_queue.put((fn, args, kwargs))


def enqueue_snapshot(analytics: dict[str, Any]) -> None:
    enqueue(_run_append_snapshot, copy.deepcopy(analytics))


def _run_append_snapshot(analytics: dict[str, Any]) -> None:
    from prediction_history import append_snapshot

    path = append_snapshot(analytics)
    print(f"  Historico (bg): {path.name} (+1 snapshot)", flush=True)
