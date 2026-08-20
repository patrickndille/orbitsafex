"""
db.py – Lightweight SQLite persistence for OrbitSafe AI.

Schema
  scans(id, scanned_at, event_count)
  conjunction_events(id, scan_id, norad_id, sat_name, secondary_norad_id,
                     secondary_name, tca_iso, miss_distance_km,
                     relative_velocity_kms, pc_value)

Usage
  from services.db import save_scan, get_scan_history
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any

_DB_PATH = Path(__file__).parent.parent / "data" / "orbitsafe.db"


def _connect() -> sqlite3.Connection:
    _DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Create tables if they do not already exist."""
    with _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS scans (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                scanned_at  TEXT    NOT NULL,
                event_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS conjunction_events (
                id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                scan_id               INTEGER NOT NULL REFERENCES scans(id),
                norad_id              INTEGER NOT NULL,
                sat_name              TEXT    NOT NULL,
                secondary_norad_id    INTEGER NOT NULL,
                secondary_name        TEXT    NOT NULL,
                tca_iso               TEXT    NOT NULL,
                miss_distance_km      REAL    NOT NULL,
                relative_velocity_kms REAL    NOT NULL,
                pc_value              REAL    NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_ce_scan_id  ON conjunction_events(scan_id);
            CREATE INDEX IF NOT EXISTS idx_ce_pc_value ON conjunction_events(pc_value DESC);
        """)


def save_scan(events: list[dict]) -> int:
    """Persist a full scan result.  Returns the new scan_id."""
    import datetime
    scanned_at = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO scans (scanned_at, event_count) VALUES (?, ?)",
            (scanned_at, len(events)),
        )
        scan_id: int = cur.lastrowid  # type: ignore[assignment]

        conn.executemany(
            """
            INSERT INTO conjunction_events
                (scan_id, norad_id, sat_name, secondary_norad_id, secondary_name,
                 tca_iso, miss_distance_km, relative_velocity_kms, pc_value)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    scan_id,
                    e["norad_id"],
                    e["sat_name"],
                    e["secondary_norad_id"],
                    e["secondary_name"],
                    e["tca_iso"],
                    e["miss_distance_km"],
                    e["relative_velocity_kms"],
                    e["pc_value"],
                )
                for e in events
            ],
        )
    return scan_id


def get_scan_history(limit: int = 20) -> list[dict[str, Any]]:
    """Return the most recent *limit* scan summaries (newest first)."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, scanned_at, event_count FROM scans ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_scan_events(scan_id: int) -> list[dict[str, Any]]:
    """Return all conjunction events for a given scan, sorted by descending Pc."""
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT norad_id, sat_name, secondary_norad_id, secondary_name,
                   tca_iso, miss_distance_km, relative_velocity_kms, pc_value
            FROM conjunction_events
            WHERE scan_id = ?
            ORDER BY pc_value DESC
            """,
            (scan_id,),
        ).fetchall()
    return [dict(r) for r in rows]
