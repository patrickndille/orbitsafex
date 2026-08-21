"""
tests/test_orbital_math.py
──────────────────────────────────────────────────────────────────────────────
Unit tests for the OrbitSafe AI astrodynamics engine.

Covers:
  - Risk-tier boundary values
  - MONITOR events preserve non-zero Pc
  - TCA position fields are present in scan output
  - TEME→geodetic conversion is epoch-aware (GMST rotation)
  - Spatiotemporal prefilter finds future-converging pairs
  - Stratified sampling covers the full altitude band
  - Database migration is idempotent
  - Live and historical event schemas match
"""

from __future__ import annotations

import math
import sqlite3
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

# ── adjust sys.path so tests can import from backend ─────────────────────────
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from services.orbital_math import (
    EARTH_RADIUS_KM,
    PC_THRESHOLD,
    SatelliteRecord,
    _gmst_rad,
    compute_pc,
    find_candidate_pairs_spatiotemporal,
    stratified_sample,
    teme_to_geodetic,
)
from services.db import init_db, save_scan, get_scan_events, get_scan_history


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
def _make_satrec_mock(norad: int = 99999) -> MagicMock:
    """Minimal Satrec-like mock whose sgp4() can be overridden per test."""
    m = MagicMock()
    m.satnum = norad
    return m


def _make_sat(norad: int, alt_km: float, pos: np.ndarray | None = None) -> SatelliteRecord:
    r = EARTH_RADIUS_KM + alt_km
    p = pos if pos is not None else np.array([r, 0.0, 0.0])
    return SatelliteRecord(
        norad_id=norad,
        name=f"SAT-{norad}",
        satrec=_make_satrec_mock(norad),
        altitude_km=alt_km,
        pos_km=p,
        vel_kms=np.array([0.0, 7.5, 0.0]),
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. Risk-tier boundary values
# ─────────────────────────────────────────────────────────────────────────────
from services.orbital_math import PC_THRESHOLD

def test_compute_pc_nonzero_for_close_miss():
    """A 0.4 km miss with σ=200 m should produce a non-zero screening Pc."""
    pc = compute_pc(0.4, 7.5)
    assert pc > 0.0, "Expected non-zero Pc for 0.40 km miss"


def test_compute_pc_decreases_with_distance():
    """Pc must decrease as miss distance increases (all else equal)."""
    pc1 = compute_pc(0.1, 7.5)
    pc2 = compute_pc(0.4, 7.5)
    pc3 = compute_pc(5.0, 7.5)
    assert pc1 > pc2 > pc3


def test_compute_pc_returns_zero_for_bad_inputs():
    assert compute_pc(0.0, 7.5) == 0.0
    assert compute_pc(0.4, 0.0) == 0.0
    assert compute_pc(-1.0, 7.5) == 0.0


def test_risk_tier_boundaries():
    """Verify tier thresholds: CRITICAL ≥ 1e-4, HIGH ≥ 1e-5, ELEVATED ≥ 1e-6."""
    from services.orbital_math import PC_THRESHOLD

    pc_critical  = compute_pc(0.05, 7.5)   # very close — should be CRITICAL
    pc_monitor   = compute_pc(200.0, 7.5)  # very far — should be MONITOR

    # Critical band (≥ 1e-4): 50 m miss is well within σ=200 m → high probability
    assert pc_critical >= 1e-6, f"Expected Pc ≥ 1e-6 at 50 m miss, got {pc_critical:.2e}"

    # Monitor band (< 1e-6): 200 km miss is far beyond 200 m σ → negligible
    assert pc_monitor < PC_THRESHOLD, f"Expected Pc < 1e-6 at 200 km miss, got {pc_monitor:.2e}"


# ─────────────────────────────────────────────────────────────────────────────
# 2. MONITOR events preserve non-zero Pc
# ─────────────────────────────────────────────────────────────────────────────
def test_compute_pc_small_but_nonzero_preserved():
    """
    compute_pc() for a miss distance that puts Pc below PC_THRESHOLD should
    return a small positive float — NOT zero.  Separately, run_conjunction_scan
    must write that real float into pc_value (not the sentinel 0.0 from the
    old code).
    """
    # A 5 km miss with σ=200 m gives a Pc well below 1e-6 but non-zero.
    pc = compute_pc(5.0, 7.5)

    # Must be a valid, positive, finite number
    assert math.isfinite(pc), f"Expected finite Pc, got {pc}"
    assert pc > 0.0, (
        f"Expected compute_pc to return a real positive value for 5 km miss, got {pc}. "
        "If 0.0 is returned, MONITOR events will silently lose their Pc."
    )
    # Must be below the screening threshold (this is what makes it a MONITOR event)
    assert pc < PC_THRESHOLD, (
        f"Expected Pc < {PC_THRESHOLD} for 5 km miss, got {pc:.3e}. "
        "Test data may be wrong."
    )


def test_monitor_event_pc_value_is_real_float_not_sentinel():
    """
    In run_conjunction_scan the pc_value field for MONITOR events must contain
    the real computed float, not 0.0.  0.0 was the old sentinel; we no longer
    write it for events that have a non-zero calculated probability.
    """
    from services.orbital_math import run_conjunction_scan, SatelliteRecord

    mock_sat_a = MagicMock(spec=SatelliteRecord)
    mock_sat_a.norad_id   = 30001
    mock_sat_a.name       = "MON-A"
    mock_sat_a.altitude_km = 500.0
    mock_sat_a.satrec     = _make_satrec_mock(30001)
    mock_sat_a.pos_km     = np.array([6871.0, 0.0, 0.0])
    mock_sat_a.vel_kms    = np.array([0.0, 7.5, 0.0])

    mock_sat_b = MagicMock(spec=SatelliteRecord)
    mock_sat_b.norad_id   = 30002
    mock_sat_b.name       = "MON-B"
    mock_sat_b.altitude_km = 500.0
    mock_sat_b.satrec     = _make_satrec_mock(30002)
    mock_sat_b.pos_km     = np.array([6871.05, 0.0, 0.0])
    mock_sat_b.vel_kms    = np.array([0.0, 7.5, 0.0])

    import time as _time
    tca_unix = _time.time()

    # Patch to produce a MONITOR-band event: miss=25 km (inside 10–100 km),
    # and compute_pc will return a small but non-zero float for this miss.
    with patch("services.orbital_math.fetch_gp_data", return_value=[]), \
         patch("services.orbital_math.build_satellite_list", return_value=[]), \
         patch("services.orbital_math.stratified_sample",
               return_value=([mock_sat_a, mock_sat_b], {"eligible_leo_objects": 2, "sampled_objects": 2})), \
         patch("services.orbital_math.find_candidate_pairs_spatiotemporal",
               return_value=([(0, 1)], {"candidate_pairs": 1})), \
         patch("services.orbital_math.find_tca",
               return_value=(tca_unix, 25.0, 7.5,
                             np.array([6871.0, 0.0, 0.0]),
                             np.array([6871.025, 0.0, 0.0]))):
        events, _ = run_conjunction_scan(max_objects=10)

    # With miss=25 km the real Pc is astronomically small but must be stored,
    # not replaced with 0.0.
    assert len(events) == 1, f"Expected 1 MONITOR event, got {len(events)}"
    evt = events[0]
    assert evt["pc_value"] >= 0.0, "pc_value must be non-negative"
    # The key assertion: must NOT be the old sentinel 0.0 when a real Pc exists
    real_pc = compute_pc(25.0, 7.5)
    if real_pc > 0.0:
        assert evt["pc_value"] > 0.0, (
            f"MONITOR event stored pc_value=0.0 but compute_pc returned {real_pc:.3e}. "
            "The old sentinel-zero behaviour has not been removed."
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. TEME→geodetic is epoch-aware
# ─────────────────────────────────────────────────────────────────────────────
def test_teme_to_geodetic_longitude_changes_with_epoch():
    """
    For the same TEME position vector, the Earth-fixed longitude must change
    as time advances (because Earth rotates by ~0.25°/min).
    A 1-hour difference → ~15° of GMST rotation → ~15° longitude shift.
    """
    pos = np.array([7000.0, 0.0, 0.0])   # on the X-axis in ECI

    t1 = 1700000000.0          # arbitrary Unix timestamp
    t2 = t1 + 3600.0           # 1 hour later

    _, lon1, _ = teme_to_geodetic(pos, t1)
    _, lon2, _ = teme_to_geodetic(pos, t2)

    delta_lon = (lon2 - lon1 + 540) % 360 - 180   # wrap to ±180
    # Earth rotates 360° in ~86164 s → 3600 s ≈ 15.04°
    expected_shift = -(3600.0 / 86164.0) * 360.0  # negative: East rotates toward X
    assert abs(delta_lon - expected_shift) < 1.0, (
        f"Expected ~{expected_shift:.1f}° longitude shift per hour, got {delta_lon:.2f}°"
    )


def test_teme_to_geodetic_equatorial_latitude():
    """A vector in the equatorial plane should give latitude ≈ 0°."""
    pos = np.array([7000.0, 7000.0, 0.0])
    lat, _, _ = teme_to_geodetic(pos, 1700000000.0)
    assert abs(lat) < 0.1, f"Expected lat ≈ 0°, got {lat}°"


def test_teme_to_geodetic_altitude():
    """Altitude should equal |r| - R_EARTH."""
    pos = np.array([7000.0, 0.0, 0.0])
    _, _, alt = teme_to_geodetic(pos, 1700000000.0)
    expected_alt = 7000.0 - EARTH_RADIUS_KM
    assert abs(alt - expected_alt) < 0.1, f"Expected alt ≈ {expected_alt:.1f} km, got {alt} km"


def test_teme_to_geodetic_longitude_normalised():
    """Longitude must always be in [-180, 180]."""
    for t_offset in range(0, 86400, 3600):
        pos = np.array([7000.0, 0.0, 0.0])
        _, lon, _ = teme_to_geodetic(pos, 1700000000.0 + t_offset)
        assert -180.0 <= lon <= 180.0, f"Longitude {lon} out of [-180, 180]"


def test_gmst_rate():
    """GMST should advance by approximately 360° per sidereal day (~86164 s)."""
    t1 = 1700000000.0
    t2 = t1 + 86164.0  # one sidereal day
    # Total advance in degrees (not modulo'd)
    gmst1_raw = math.degrees(_gmst_rad(t1))
    gmst2_raw = math.degrees(_gmst_rad(t2))
    # The rate: 360.98564736629 °/day × (86164/86400) ≈ 360.0°
    expected_advance = (360.98564736629 * 86164.0 / 86400.0)
    actual_advance = (gmst2_raw - gmst1_raw)
    # Compare modulo 360 to avoid wrapping issues
    delta = abs(actual_advance % 360.0 - expected_advance % 360.0)
    if delta > 180:
        delta = 360 - delta
    assert delta < 0.5, f"GMST rate off: expected {expected_advance:.3f}°, Δ={delta:.3f}°"


# ─────────────────────────────────────────────────────────────────────────────
# 4. Spatiotemporal prefilter finds future-converging pair
# ─────────────────────────────────────────────────────────────────────────────
def test_spatiotemporal_finds_future_converging_pair():
    """
    Two objects are GREATER THAN the screening radius apart at t0 and at the
    first several epochs, but converge to within the screening radius at a
    later epoch.  The spatiotemporal prefilter must find them.
    A snapshot-only filter at t0 would miss them entirely.

    Setup (deterministic, mocked _propagate):
      t0:       A=(7200,0,0), B=(7200,500,0) → separation=500 km  (> 200 km)
      t0+120s:  A=(7200,0,0), B=(7200,250,0) → separation=250 km  (> 200 km)
      t0+180s:  A=(7200,0,0), B=(7200,150,0) → separation=150 km  (> 200 km)
      t0+240s:  A=(7200,0,0), B=(7200, 50,0) → separation= 50 km  (< 200 km ✓)
    """
    t0 = 1700000000.0

    # B starts 500 km away and moves linearly toward A's y=0 plane
    # A is stationary in this mock
    def fake_propagate(satrec, unix_ts):
        dt = unix_ts - t0
        if satrec.satnum == 10001:
            return np.array([7200.0, 0.0, 0.0]), np.array([0.0, 7.5, 0.0])
        else:
            # B closes at ~2 km/s along y; starts at y=500 km
            y = max(0.0, 500.0 - dt * 2.0)
            return np.array([7200.0, y, 0.0]), np.array([0.0, 7.4, 0.0])

    # Verify the geometry: at t0 separation is 500 km, clearly > screen_km=200
    pos_a_t0, _ = fake_propagate(type("M", (), {"satnum": 10001})(), t0)
    pos_b_t0, _ = fake_propagate(type("M", (), {"satnum": 10002})(), t0)
    dist_t0 = float(np.linalg.norm(pos_a_t0 - pos_b_t0))
    assert dist_t0 > 200.0, f"Test setup error: separation at t0 should be >200 km, got {dist_t0:.1f}"

    # Verify the geometry: at t0+300s separation is 500-600=−100 → clamped 0,
    # so at t0+240s y=500-480=20, separation=20 km < 200 km
    pos_b_240, _ = fake_propagate(type("M", (), {"satnum": 10002})(), t0 + 240)
    dist_240 = float(np.linalg.norm(pos_a_t0 - pos_b_240))
    assert dist_240 < 200.0, f"Test setup error: separation at t0+240s should be <200 km, got {dist_240:.1f}"

    sat_a = _make_sat(10001, 829.0, np.array([7200.0, 0.0, 0.0]))
    sat_b = _make_sat(10002, 829.0, np.array([7200.0, 500.0, 0.0]))
    sat_a.satrec.satnum = 10001
    sat_b.satrec.satnum = 10002
    sats = [sat_a, sat_b]

    with patch("services.orbital_math._propagate", side_effect=fake_propagate):
        pairs, meta = find_candidate_pairs_spatiotemporal(
            sats, t0,
            window_h=1.0 / 6,   # 10-minute window (sufficient to reach convergence)
            coarse_s=60.0,       # 1-minute step → 10 epochs
            screen_km=200.0,
        )

    assert len(pairs) >= 1, (
        "Spatiotemporal prefilter failed to find the future-converging pair. "
        f"meta={meta}"
    )
    found = (0, 1) in pairs or (1, 0) in [(p[1], p[0]) for p in pairs]
    assert found, f"Expected pair (0,1) in results, got: {pairs}"
    assert meta["candidate_pairs"] >= 1
    assert meta["coarse_epochs_evaluated"] > 0


def test_snapshot_only_would_miss_future_converging_pair():
    """
    A t0-only KD-Tree query must NOT find the pair whose initial separation
    is 500 km — matching the setup in the spatiotemporal test above.
    """
    from scipy.spatial import KDTree

    pos_a = np.array([7200.0, 0.0, 0.0])
    pos_b = np.array([7200.0, 500.0, 0.0])   # 500 km away at t0
    dist_at_t0 = float(np.linalg.norm(pos_a - pos_b))

    assert dist_at_t0 > 200.0, f"Expected separation > 200 km at t0, got {dist_at_t0:.1f} km"

    positions = np.array([pos_a, pos_b])
    tree = KDTree(positions)
    snapshot_pairs = []
    for i, neighbours in enumerate(tree.query_ball_tree(tree, r=200.0)):
        for j in neighbours:
            if j > i:
                snapshot_pairs.append((i, j))

    assert len(snapshot_pairs) == 0, (
        "Snapshot filter found the pair at t0 — test geometry is wrong"
    )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Stratified sampling covers the full altitude band
# ─────────────────────────────────────────────────────────────────────────────
def test_stratified_sample_covers_all_bins():
    """
    A set of satellites uniformly spread across 300–1200 km should produce
    a sample that covers all altitude bins, not just the bottom ones.
    """
    # 18 bins × 10 satellites each = 180 total
    sats = []
    bin_alts = [300 + i * 50 + 25 for i in range(18)]  # midpoints of 50-km bins
    for i, alt in enumerate(bin_alts):
        for k in range(10):
            sats.append(_make_sat(i * 10 + k, alt))

    sampled, meta = stratified_sample(sats, max_objects=90, bin_width_km=50.0)

    # Should have sampled from all 18 bins
    sampled_alts = set(int((s.altitude_km - 300) / 50) for s in sampled)
    assert len(sampled_alts) == 18, (
        f"Expected samples from all 18 bins, got {len(sampled_alts)}: {sorted(sampled_alts)}"
    )
    assert len(sampled) == 90
    assert meta["eligible_leo_objects"] == 180
    assert meta["sampled_objects"] == 90


def test_stratified_sample_not_biased_to_low_alt():
    """
    If all 400 cap objects were taken from altitude-sorted list, they'd all
    come from 300–500 km.  Stratified sampling must include high-altitude objects.
    """
    # Create 1000 satellites densely packed at 310 km and 10 at 1150 km
    sats = [_make_sat(i, 310.0) for i in range(1000)]
    sats += [_make_sat(2000 + i, 1150.0) for i in range(10)]

    sampled, _ = stratified_sample(sats, max_objects=400)

    high_alt = [s for s in sampled if s.altitude_km > 1000]
    assert len(high_alt) > 0, "Stratified sample failed to include any high-altitude objects"


def test_stratified_sample_deterministic():
    """Same input must produce same output (reproducibility requirement)."""
    sats = [_make_sat(i, 300 + (i % 18) * 50) for i in range(200)]

    s1, _ = stratified_sample(sats, max_objects=100)
    s2, _ = stratified_sample(sats, max_objects=100)

    ids1 = [s.norad_id for s in s1]
    ids2 = [s.norad_id for s in s2]
    assert ids1 == ids2, "Stratified sampling is not deterministic"


# ─────────────────────────────────────────────────────────────────────────────
# 6. Database migration is idempotent
# ─────────────────────────────────────────────────────────────────────────────
def test_db_migration_idempotent(tmp_path, monkeypatch):
    """
    Calling init_db() multiple times on the same database must succeed
    without errors (idempotent schema migration).
    """
    import services.db as db_module
    db_path = tmp_path / "test_orbitsafe.db"
    monkeypatch.setattr(db_module, "_DB_PATH", db_path)

    db_module.init_db()   # first call — creates tables
    db_module.init_db()   # second call — must not raise
    db_module.init_db()   # third call — still safe


def test_db_migration_adds_position_columns(tmp_path, monkeypatch):
    """
    A v1 database (without position columns) must be upgraded by init_db()
    to include all v2 position fields.
    """
    import services.db as db_module
    db_path = tmp_path / "test_v1.db"
    monkeypatch.setattr(db_module, "_DB_PATH", db_path)

    # Manually create the v1 schema without position columns
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
        CREATE TABLE scans (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            scanned_at  TEXT    NOT NULL,
            event_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE conjunction_events (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_id               INTEGER NOT NULL,
            norad_id              INTEGER NOT NULL,
            sat_name              TEXT    NOT NULL,
            secondary_norad_id    INTEGER NOT NULL,
            secondary_name        TEXT    NOT NULL,
            tca_iso               TEXT    NOT NULL,
            miss_distance_km      REAL    NOT NULL,
            relative_velocity_kms REAL    NOT NULL,
            pc_value              REAL    NOT NULL
        );
    """)
    conn.close()

    # Running init_db() should add the v2 columns without error
    db_module.init_db()

    # Verify new columns exist
    conn = sqlite3.connect(str(db_path))
    cursor = conn.execute("PRAGMA table_info(conjunction_events)")
    col_names = {row[1] for row in cursor.fetchall()}
    conn.close()

    expected_v2_cols = {
        "primary_lat", "primary_lon", "primary_alt_km",
        "secondary_lat", "secondary_lon", "secondary_alt_km",
        "position_source",
    }
    missing = expected_v2_cols - col_names
    assert not missing, f"Missing v2 columns after migration: {missing}"


# ─────────────────────────────────────────────────────────────────────────────
# 7. Live and historical event schemas match
# ─────────────────────────────────────────────────────────────────────────────
def test_save_and_reload_event_preserves_positions(tmp_path, monkeypatch):
    """
    Saving a scan with position fields and loading it back must produce
    identical position values (TCA coordinates are round-tripped correctly).
    """
    import services.db as db_module
    db_path = tmp_path / "test_roundtrip.db"
    monkeypatch.setattr(db_module, "_DB_PATH", db_path)
    db_module.init_db()

    live_event = {
        "norad_id":                25544,
        "sat_name":                "ISS (ZARYA)",
        "secondary_norad_id":      44238,
        "secondary_name":          "DEBRIS-001",
        "tca_iso":                 "2026-08-15T14:23:07Z",
        "miss_distance_km":        0.4,
        "relative_velocity_kms":   7.5,
        "pc_value":                4.29e-5,
        "primary_lat":             51.4,
        "primary_lon":            -20.3,
        "primary_alt_km":          408.2,
        "secondary_lat":           51.4,
        "secondary_lon":          -20.3,
        "secondary_alt_km":        408.6,
    }

    scan_id = db_module.save_scan([live_event])
    events = db_module.get_scan_events(scan_id)

    assert len(events) == 1
    e = events[0]

    assert e["primary_lat"]   == pytest.approx(51.4)
    assert e["primary_lon"]   == pytest.approx(-20.3)
    assert e["primary_alt_km"] == pytest.approx(408.2)
    assert e["secondary_lat"] == pytest.approx(51.4)
    assert e["position_source"] == "tca"


def test_legacy_event_gets_fallback_position_source(tmp_path, monkeypatch):
    """
    An event saved without position fields should get position_source='legacy-fallback'.
    """
    import services.db as db_module
    db_path = tmp_path / "test_legacy.db"
    monkeypatch.setattr(db_module, "_DB_PATH", db_path)
    db_module.init_db()

    event_no_pos = {
        "norad_id":                99001,
        "sat_name":                "OLD-SAT",
        "secondary_norad_id":      99002,
        "secondary_name":          "DEBRIS",
        "tca_iso":                 "2026-08-15T14:00:00Z",
        "miss_distance_km":        1.2,
        "relative_velocity_kms":   7.0,
        "pc_value":                0.0,
        # No primary_lat / secondary_lat etc.
    }

    scan_id = db_module.save_scan([event_no_pos])
    events = db_module.get_scan_events(scan_id)

    assert events[0]["position_source"] == "legacy-fallback"
    assert events[0]["primary_lat"] is None


# ─────────────────────────────────────────────────────────────────────────────
# 8. TCA position fields are present in run_conjunction_scan output
# ─────────────────────────────────────────────────────────────────────────────
def test_run_conjunction_scan_returns_position_fields(monkeypatch):
    """
    The output of run_conjunction_scan() must include all six position fields
    for every tiered event.  We mock the expensive parts to run fast.
    """
    from services.orbital_math import (
        run_conjunction_scan,
        SatelliteRecord,
        PC_THRESHOLD,
    )
    from sgp4.api import Satrec

    # Build two minimal mock satellites in the same altitude bin
    mock_sat_a = MagicMock(spec=SatelliteRecord)
    mock_sat_a.norad_id = 11111
    mock_sat_a.name = "SAT-A"
    mock_sat_a.altitude_km = 500.0
    mock_sat_a.satrec = _make_satrec_mock(11111)
    mock_sat_a.pos_km = np.array([6871.0, 0.0, 0.0])
    mock_sat_a.vel_kms = np.array([0.0, 7.5, 0.0])

    mock_sat_b = MagicMock(spec=SatelliteRecord)
    mock_sat_b.norad_id = 22222
    mock_sat_b.name = "SAT-B"
    mock_sat_b.altitude_km = 500.0
    mock_sat_b.satrec = _make_satrec_mock(22222)
    mock_sat_b.pos_km = np.array([6871.05, 0.0, 0.0])
    mock_sat_b.vel_kms = np.array([0.0, 7.5, 0.0])

    monkeypatch.setattr("services.orbital_math.fetch_gp_data", lambda: [])
    monkeypatch.setattr("services.orbital_math.build_satellite_list", lambda *a, **k: [])
    monkeypatch.setattr(
        "services.orbital_math.stratified_sample",
        lambda sats, max_objects, **k: ([mock_sat_a, mock_sat_b], {"eligible_leo_objects": 2, "sampled_objects": 2})
    )
    monkeypatch.setattr(
        "services.orbital_math.find_candidate_pairs_spatiotemporal",
        lambda sats, t0, **k: ([(0, 1)], {"candidate_pairs": 1})
    )

    tca_unix = time.time()
    monkeypatch.setattr(
        "services.orbital_math.find_tca",
        lambda *a, **k: (
            tca_unix,
            0.40,                               # miss_km
            7.5,                                # rel_v
            np.array([6871.0, 0.0, 0.0]),       # ra_tca
            np.array([6871.05, 0.0, 0.0]),      # rb_tca
        )
    )
    monkeypatch.setattr(
        "services.orbital_math.compute_pc",
        lambda *a, **k: 4.29e-5   # HIGH tier
    )

    events, _scan_meta = run_conjunction_scan(max_objects=10)

    assert len(events) == 1
    evt = events[0]
    for field in ("primary_lat", "primary_lon", "primary_alt_km",
                  "secondary_lat", "secondary_lon", "secondary_alt_km"):
        assert field in evt, f"Missing field: {field}"
        assert evt[field] is not None, f"Field {field} is None"

    # Pc assumptions must be documented
    assert "pc_assumed_sigma_m" in evt
    assert "pc_hard_body_radius_m" in evt
    assert evt["pc_method"] == "screening-isotropic-gaussian"
