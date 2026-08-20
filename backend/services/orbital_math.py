"""
orbital_math.py
────────────────────────────────────────────────────────────────────────────────
Core astrodynamics engine for OrbitSafe AI.

Pipeline
  1. Fetch live GP data from Space-Track.org (3-hour in-memory cache,
     local JSON fallback on every successful fetch)
  2. Build a KD-Tree altitude index to pre-filter candidate pairs  (O(n log n))
  3. For each candidate pair run SGP4 forward-propagation to find TCA
  4. Project the combined covariance onto the 2-D encounter plane
  5. Integrate the 2-D Gaussian over the combined hard-body area → Pc
"""

from __future__ import annotations

import itertools
import logging
import math
import time
import datetime
import os
import json
from dataclasses import dataclass, field
from typing import List, Optional, Tuple
from pathlib import Path

import numpy as np
from scipy.integrate import dblquad
from scipy.spatial import KDTree
from sgp4.api import Satrec, WGS72, jday

# Unit conversion constants
DEG2RAD = math.pi / 180.0
XP3O15 = 1440.0 / (2.0 * math.pi)   # converts rev/day → rad/min

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────
EARTH_RADIUS_KM = 6371.0        # mean Earth radius
ALT_BIN_WIDTH_KM = 50.0         # altitude bin for spatial pre-filter
PROPAGATION_STEP_S = 60.0       # seconds between propagation steps
PROPAGATION_WINDOW_H = 24.0     # hours to look ahead
HARD_BODY_RADIUS_M = 5.0        # combined hard-body radius (metres)
DEFAULT_SIGMA_M = 200.0         # 1-σ position uncertainty (metres), isotropic
PC_THRESHOLD = 1e-6             # report only conjunctions above this Pc

logger = logging.getLogger("orbital_math")

# ──────────────────────────────────────────────────────────────────────────────
# GP Source Configuration
# ──────────────────────────────────────────────────────────────────────────────
_GP_SOURCE = os.environ.get("GP_SOURCE", "auto").lower()
_FALLBACK_PATH = Path(__file__).parent.parent / "data" / "gp_fallback.json"
SPACE_TRACK_USERNAME = os.environ.get("SPACE_TRACK_USERNAME", "")
SPACE_TRACK_PASSWORD = os.environ.get("SPACE_TRACK_PASSWORD", "")

# Active source tracking for health endpoint
_active_gp_source: str = "none"
_gp_cache_info: dict = {"age_seconds": None, "record_count": 0, "last_fetch_source": "none", "last_fetch_ts": 0.0}

# ──────────────────────────────────────────────────────────────────────────────
# GP data cache — stale-while-revalidate pattern
# ──────────────────────────────────────────────────────────────────────────────
#   _gp_cache_data  – last successful payload (survives transient errors)
#   _gp_cache_ts    – Unix timestamp of that fetch
#   _GP_CACHE_TTL   – how long before we attempt a refresh (3 h)
# ──────────────────────────────────────────────────────────────────────────────
_GP_CACHE_TTL     = 10800          # 3 hours — Space-Track GP update cadence
_FETCH_MAX_RETRIES = 3             # retries for transient errors
_FETCH_BACKOFF_BASE = 2.0          # seconds; doubled each retry

_gp_cache_data: Optional[list] = None
_gp_cache_ts:   float          = 0.0


def _resolve_source_order(source: str) -> list[str]:
    """Return ordered list of data sources to try based on GP_SOURCE env var.

    Supported values: "auto" | "space-track" | "local"
    """
    if source == "space-track":
        return ["space-track", "local"]
    if source == "local":
        return ["local"]
    # "auto" default: Space-Track → local fallback
    return ["space-track", "local"]


def _fetch_space_track() -> Optional[list[dict]]:
    """Fetch GP data from Space-Track.org if credentials are configured."""
    if not SPACE_TRACK_USERNAME or not SPACE_TRACK_PASSWORD:
        return None
    from services.space_track import SpaceTrackClient
    client = SpaceTrackClient(SPACE_TRACK_USERNAME, SPACE_TRACK_PASSWORD)
    return client.fetch_gp_data()


def _load_local_fallback() -> Optional[list[dict]]:
    """Load GP data from local fallback file."""
    if _FALLBACK_PATH.exists():
        try:
            records = json.loads(_FALLBACK_PATH.read_text())
            logger.info("Loaded %d GP records from local fallback", len(records))
            return records
        except Exception as exc:
            logger.error("Failed to load local fallback: %s", exc)
    return None


def _maybe_write_fallback(records: list[dict]) -> None:
    """Write/update local fallback file on every successful fetch."""
    try:
        _FALLBACK_PATH.parent.mkdir(exist_ok=True)
        _FALLBACK_PATH.write_text(json.dumps(records))
        logger.debug("Updated local GP fallback (%d records)", len(records))
    except Exception as exc:
        logger.warning("Failed to write local fallback: %s", exc)


def _update_cache(records: list[dict], source: str) -> list[dict]:
    """Update in-memory cache and metadata."""
    global _gp_cache_data, _gp_cache_ts, _active_gp_source, _gp_cache_info
    now = time.time()
    _gp_cache_data = records
    _gp_cache_ts = now
    _active_gp_source = source
    _gp_cache_info = {
        "age_seconds": 0,
        "record_count": len(records),
        "last_fetch_source": source,
        "last_fetch_ts": now,
    }
    return records


def fetch_gp_data() -> list[dict]:
    """
    Fetch GP records with priority: Space-Track → local fallback.
    Controlled by GP_SOURCE env var: "auto" | "space-track" | "local"
    """
    global _gp_cache_data, _gp_cache_ts, _gp_cache_info

    sources = _resolve_source_order(_GP_SOURCE)

    for src in sources:
        records: Optional[list[dict]] = None

        try:
            if src == "space-track":
                records = _fetch_space_track()
            elif src == "local":
                records = _load_local_fallback()
        except Exception as exc:
            logger.warning("Source %s raised exception: %s", src, exc)
            records = None

        if records:
            logger.info("Source %s succeeded with %d records", src, len(records))
            _maybe_write_fallback(records)
            return _update_cache(records, src)
        else:
            logger.debug("Source %s returned no records", src)

    # All sources failed — return stale cache if available
    if _gp_cache_data is not None:
        cache_age = time.time() - _gp_cache_ts
        logger.warning(
            "All sources failed; returning stale cache (%d records, age %.0f s, last source: %s)",
            len(_gp_cache_data), cache_age, _active_gp_source
        )
        _gp_cache_info["age_seconds"] = cache_age
        return _gp_cache_data

    raise RuntimeError("No GP data source available and no cached data")


def get_active_gp_source() -> str:
    """Return the source that last successfully provided data."""
    return _active_gp_source


def get_gp_cache_info() -> dict:
    """Return cache metadata for health endpoint."""
    info = dict(_gp_cache_info)
    if _gp_cache_ts:
        info["age_seconds"] = time.time() - _gp_cache_ts
    return info


# ──────────────────────────────────────────────────────────────────────────────
# Data classes
# ──────────────────────────────────────────────────────────────────────────────
@dataclass
class SatelliteRecord:
    norad_id: int
    name: str
    satrec: Satrec
    altitude_km: float = 0.0          # approximate current altitude
    pos_km: np.ndarray = field(default_factory=lambda: np.zeros(3))
    vel_kms: np.ndarray = field(default_factory=lambda: np.zeros(3))


@dataclass
class ConjunctionEvent:
    primary_norad: int
    primary_name: str
    secondary_norad: int
    secondary_name: str
    tca_unix: float                    # Unix timestamp of TCA
    miss_distance_km: float
    relative_velocity_kms: float
    pc_value: float


# ──────────────────────────────────────────────────────────────────────────────
# SGP4 helpers
# ──────────────────────────────────────────────────────────────────────────────
# SGP4 error code descriptions for debug logging
_SGP4_ERRORS = {
    1: "mean eccentricity < 0 or >= 1",
    2: "mean motion < 0",
    3: "pert eccentricity < 0 or > 1",
    4: "semi-latus rectum < 0",
    5: "epoch elements are sub-orbital",
    6: "satellite has decayed",
}


# ── OMM JSON → sgp4init field map ───────────────────────────────────────────
# Space-Track OMM JSON uses CCSDS OMM field names.  Map each OMM key to the
# legacy GP key so _build_satrec works with both response formats.
#
# OMM field          Legacy GP field    Notes
# ─────────────────────────────────────────────────────────────────
# NORAD_CAT_ID       NORAD_CAT_ID       same in both
# OBJECT_NAME        OBJECT_NAME        same in both
# EPOCH              EPOCH              same in both
# MEAN_MOTION_DOT    NDOT               rev/day²
# MEAN_MOTION_DDOT   NDDOT              rev/day³
# BSTAR              BSTAR              same in both
# INCLINATION        INCLO              degrees
# RA_OF_ASC_NODE     RAAN               degrees
# ECCENTRICITY       ECCO               dimensionless
# ARG_OF_PERICENTER  ARGPO              degrees
# MEAN_ANOMALY       MO                 degrees
# MEAN_MOTION        NO_KOZAI           rev/day
# ─────────────────────────────────────────────────────────────────
_OMM_TO_GP: dict[str, str] = {
    "MEAN_MOTION_DOT":  "NDOT",
    "MEAN_MOTION_DDOT": "NDDOT",
    "INCLINATION":      "INCLO",
    "RA_OF_ASC_NODE":   "RAAN",
    "ECCENTRICITY":     "ECCO",
    "ARG_OF_PERICENTER":"ARGPO",
    "MEAN_ANOMALY":     "MO",
    "MEAN_MOTION":      "NO_KOZAI",
}


def _normalise_gp(gp: dict) -> dict:
    """
    Return a copy of *gp* with OMM field names aliased to legacy GP names.
    Records that already use legacy names pass through unchanged, so the
    function is safe to call on both FORMAT=json and FORMAT=JSON responses.
    """
    out = dict(gp)
    for omm_key, gp_key in _OMM_TO_GP.items():
        if omm_key in out and gp_key not in out:
            out[gp_key] = out[omm_key]
    return out


def _build_satrec(gp: dict) -> Optional[Satrec]:
    """Construct a Satrec object from Space-Track GP/OMM JSON parameters."""
    try:
        gp = _normalise_gp(gp)

        # Parse ISO epoch string into Julian Date components
        epoch_str = gp["EPOCH"].replace("Z", "")
        ep_dt = datetime.datetime.fromisoformat(epoch_str)
        jd, fr = jday(
            ep_dt.year, ep_dt.month, ep_dt.day,
            ep_dt.hour, ep_dt.minute, ep_dt.second + ep_dt.microsecond / 1e6
        )

        sat = Satrec()
        sat.sgp4init(
            WGS72,                                # WGS72 gravity model object
            "i",                                  # improved SGP4 mode
            int(gp["NORAD_CAT_ID"]),
            jd + fr - 2433281.5,                  # epoch: days since 1949-12-31 00:00 UT
            float(gp["BSTAR"]),
            float(gp["NDOT"]),
            float(gp["NDDOT"]),
            float(gp["ECCO"]),
            float(gp["ARGPO"]) * DEG2RAD,         # rad
            float(gp["INCLO"]) * DEG2RAD,         # rad
            float(gp["MO"]) * DEG2RAD,            # rad
            float(gp["NO_KOZAI"]) / XP3O15,       # rad/min
            float(gp["RAAN"]) * DEG2RAD,          # rad
        )
        return sat

    except Exception as exc:
        logger.debug("_build_satrec failed for NORAD %s: %s", gp.get("NORAD_CAT_ID"), exc)
        return None


def _propagate(satrec: Satrec, unix_ts: float) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    """Propagate to unix_ts; return (pos_km, vel_kms) or (None, None)."""
    dt = datetime.datetime.utcfromtimestamp(unix_ts)
    jd, fr = jday(dt.year, dt.month, dt.day, dt.hour, dt.minute,
                  dt.second + dt.microsecond / 1e6)
    e, r, v = satrec.sgp4(jd, fr)
    if e != 0:
        logger.debug(
            "SGP4 error %d (NORAD %s): %s",
            e, getattr(satrec, "satnum", "?"), _SGP4_ERRORS.get(e, "unknown")
        )
        return None, None
    return np.array(r), np.array(v)


# ──────────────────────────────────────────────────────────────────────────────
# Spatial pre-filter – altitude-binned KD-Tree
# ──────────────────────────────────────────────────────────────────────────────
def _current_state(satrec: Satrec, unix_ts: float) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    return _propagate(satrec, unix_ts)


def build_satellite_list(gp_records: list[dict], t0: float) -> list[SatelliteRecord]:
    """Build SatelliteRecord list with current ECI state at t0."""
    sats: list[SatelliteRecord] = []
    skipped_build = 0
    skipped_prop  = 0
    skipped_alt   = 0

    for gp in gp_records:
        try:
            sat = _build_satrec(gp)
            if sat is None:
                skipped_build += 1
                continue
            pos, vel = _current_state(sat, t0)
            if pos is None:
                skipped_prop += 1
                continue
            alt = float(np.linalg.norm(pos)) - EARTH_RADIUS_KM
            if alt < 0:
                skipped_alt += 1
                continue
            sats.append(SatelliteRecord(
                norad_id=gp["NORAD_CAT_ID"],
                name=gp.get("OBJECT_NAME", f"NORAD-{gp['NORAD_CAT_ID']}"),
                satrec=sat,
                altitude_km=alt,
                pos_km=pos,
                vel_kms=vel,
            ))
        except Exception as exc:
            logger.debug("Skipping NORAD %s due to unexpected error: %s",
                         gp.get("NORAD_CAT_ID"), exc)
            skipped_build += 1

    logger.info(
        "Built %d valid satellite records (skipped: %d build errors, "
        "%d propagation errors, %d sub-orbital).",
        len(sats), skipped_build, skipped_prop, skipped_alt,
    )
    return sats


def find_candidate_pairs(sats: list[SatelliteRecord], delta_alt_km: float = 100.0) -> list[Tuple[int, int]]:
    """
    Use a KD-Tree on 3-D ECI positions to find pairs within 100 km.
    This reduces O(n²) brute-force to O(n log n) pre-filter.
    """
    if not sats:
        return []
    positions = np.array([s.pos_km for s in sats])
    tree = KDTree(positions)
    pairs_set = set()
    # Query all pairs within delta_alt_km km
    indices_list = tree.query_ball_tree(tree, r=delta_alt_km)
    for i, neighbours in enumerate(indices_list):
        for j in neighbours:
            if j <= i:
                continue
            pairs_set.add((i, j))
    logger.info("KD-Tree pre-filter: %d candidate pairs from %d satellites.",
                len(pairs_set), len(sats))
    return list(pairs_set)


# ──────────────────────────────────────────────────────────────────────────────
# TCA finder
# ──────────────────────────────────────────────────────────────────────────────
def find_tca(
    sat_a: SatelliteRecord,
    sat_b: SatelliteRecord,
    t0: float,
    window_h: float = PROPAGATION_WINDOW_H,
    step_s: float = PROPAGATION_STEP_S,
) -> Tuple[float, float, float]:
    """
    Walk the propagation window in `step_s` increments; return
    (tca_unix, miss_distance_km, rel_velocity_kms) at the minimum range epoch.
    Refines the minimum with a ±step_s binary-narrowing pass.
    """
    best_t = t0
    best_dist = float("inf")
    best_rv = 0.0
    t_end = t0 + window_h * 3600.0
    t = t0

    while t <= t_end:
        ra, va = _propagate(sat_a.satrec, t)
        rb, vb = _propagate(sat_b.satrec, t)
        if ra is None or va is None or rb is None or vb is None:
            t += step_s
            continue
        dist = float(np.linalg.norm(ra - rb))
        if dist < best_dist:
            best_dist = dist
            best_t = t
            best_rv = float(np.linalg.norm(va - vb))
        t += step_s

    # Refine with bisection over ±step_s around best_t
    lo, hi = best_t - step_s, best_t + step_s
    for _ in range(20):
        m1 = lo + (hi - lo) / 3
        m2 = hi - (hi - lo) / 3
        ra1, _ = _propagate(sat_a.satrec, m1)
        rb1, _ = _propagate(sat_b.satrec, m1)
        ra2, _ = _propagate(sat_a.satrec, m2)
        rb2, _ = _propagate(sat_b.satrec, m2)
        d1 = float(np.linalg.norm(ra1 - rb1)) if ra1 is not None and rb1 is not None else float("inf")
        d2 = float(np.linalg.norm(ra2 - rb2)) if ra2 is not None and rb2 is not None else float("inf")
        if d1 < d2:
            hi = m2
        else:
            lo = m1
    tca = (lo + hi) / 2
    ra_f, va_f = _propagate(sat_a.satrec, tca)
    rb_f, vb_f = _propagate(sat_b.satrec, tca)
    if ra_f is not None and va_f is not None and rb_f is not None and vb_f is not None:
        best_dist = float(np.linalg.norm(ra_f - rb_f))
        best_rv = float(np.linalg.norm(va_f - vb_f))
    return tca, best_dist, best_rv


# ──────────────────────────────────────────────────────────────────────────────
# Probability of Collision (Pc) – 2-D Gaussian integral (Alfano method)
# ──────────────────────────────────────────────────────────────────────────────
def compute_pc(
    miss_distance_km: float,
    relative_velocity_kms: float,
    sigma_m: float = DEFAULT_SIGMA_M,
    hard_body_radius_m: float = HARD_BODY_RADIUS_M,
) -> float:
    """
    Compute Pc by integrating a 2-D Gaussian (isotropic covariance, combined
    σ) over the combined hard-body cross-section in the encounter plane.

      Pc = (1 / (2π|C|^½)) ∬_A  exp(-½ rᵀ C⁻¹ r) dx dy

    where C = diag(σ², σ²), A is a disk of radius r_hbr = hard_body_radius_m,
    and the miss vector is along x in the encounter plane.
    """
    if miss_distance_km <= 0 or relative_velocity_kms <= 0:
        return 0.0

    # Convert to metres for consistent units
    miss_m = miss_distance_km * 1000.0
    sigma = sigma_m  # 1-σ positional uncertainty (m)
    r_hbr = hard_body_radius_m  # combined hard-body radius (m)

    # Offset of the primary in the encounter plane
    x0 = miss_m  # miss along x-axis
    y0 = 0.0

    norm = 1.0 / (2.0 * math.pi * sigma ** 2)

    def integrand(y, x):
        return norm * math.exp(-((x - x0) ** 2 + (y - y0) ** 2) / (2.0 * sigma ** 2))

    # Integrate over disk of radius r_hbr centred at origin
    try:
        pc, _ = dblquad(
            integrand,
            -r_hbr, r_hbr,
            lambda x: -math.sqrt(max(r_hbr ** 2 - x ** 2, 0)),
            lambda x:  math.sqrt(max(r_hbr ** 2 - x ** 2, 0)),
            epsabs=1e-12,
            epsrel=1e-8,
        )
    except Exception:
        pc = 0.0

    return max(pc, 0.0)


# ──────────────────────────────────────────────────────────────────────────────
# Public entry point
# ──────────────────────────────────────────────────────────────────────────────
def run_conjunction_scan(max_objects: int = 500) -> List[dict]:
    """
    Full pipeline: fetch → LEO filter → TCA → Pc.
    Returns a list of conjunction dicts sorted by descending Pc.

    Pipeline:
      1. Fetch full GP catalog (Space-Track → local fallback).
      2. Propagate ALL records to get current ECI state and altitude.
      3. Filter to 300–1 200 km LEO band (highest conjunction density).
      4. Sort by altitude so spatially adjacent objects cluster together.
      5. Cap to max_objects after the altitude filter.
      6. KD-Tree pre-filter → TCA bisection → Pc integration.

    Previous behaviour sliced gp_records[:max_objects] from the raw catalog
    which distributed objects across all shells, giving the KD-Tree 0 pairs.
    """
    t0 = time.time()
    gp_records = fetch_gp_data()

    # Propagate full catalog to obtain real ECI altitudes at t0
    all_sats = build_satellite_list(gp_records, t0)

    # Filter to active LEO band where conjunction risk is highest
    leo_sats = [s for s in all_sats if 300.0 <= s.altitude_km <= 1200.0]

    # Sort by altitude so the KD-Tree receives spatially coherent input
    leo_sats.sort(key=lambda s: s.altitude_km)

    # Cap to max_objects after the altitude filter
    sats = leo_sats[:max_objects]

    logger.info(
        "LEO filter: %d/%d objects in 300–1200 km band, using %d for scan.",
        len(leo_sats), len(all_sats), len(sats),
    )

    pairs = find_candidate_pairs(sats, delta_alt_km=100.0)

    results: List[dict] = []
    for i, j in pairs:
        a, b = sats[i], sats[j]
        tca, miss_km, rel_v = find_tca(a, b, t0)
        pc = compute_pc(miss_km, rel_v)
        if pc < PC_THRESHOLD:
            continue
        results.append({
            "norad_id": a.norad_id,
            "sat_name": a.name,
            "secondary_norad_id": b.norad_id,
            "secondary_name": b.name,
            "tca_iso": _unix_to_iso(tca),
            "miss_distance_km": round(miss_km, 4),
            "relative_velocity_kms": round(rel_v, 4),
            "pc_value": float(f"{pc:.6e}"),
        })

    results.sort(key=lambda r: r["pc_value"], reverse=True)
    logger.info("Scan complete: %d conjunction events above Pc threshold.", len(results))
    return results


def _unix_to_iso(unix_ts: float) -> str:
    import datetime
    return datetime.datetime.utcfromtimestamp(unix_ts).strftime("%Y-%m-%dT%H:%M:%SZ")
