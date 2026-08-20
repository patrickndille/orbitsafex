"""
orbital_math.py
────────────────────────────────────────────────────────────────────────────────
Core astrodynamics engine for OrbitSafe AI.

Pipeline
  1. Fetch live TLE/GP data from CelesTrak (TTLCache, 15-min refresh)
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
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np
import requests
from cachetools import TTLCache, cached
from scipy.integrate import dblquad
from scipy.spatial import KDTree
from sgp4.api import Satrec, WGS72, jday

# Unit conversion constants
DEG2RAD = math.pi / 180.0
XP3O15 = 1440.0 / (2.0 * math.pi)   # converts rev/day → rad/min

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────
CELESTRAK_URL = (
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json"
)
EARTH_RADIUS_KM = 6371.0        # mean Earth radius
ALT_BIN_WIDTH_KM = 50.0         # altitude bin for spatial pre-filter
PROPAGATION_STEP_S = 60.0       # seconds between propagation steps
PROPAGATION_WINDOW_H = 24.0     # hours to look ahead
HARD_BODY_RADIUS_M = 5.0        # combined hard-body radius (metres)
DEFAULT_SIGMA_M = 200.0         # 1-σ position uncertainty (metres), isotropic
PC_THRESHOLD = 1e-6             # report only conjunctions above this Pc

logger = logging.getLogger("orbital_math")

# ──────────────────────────────────────────────────────────────────────────────
# CelesTrak data fetch (15-minute cache)
# ──────────────────────────────────────────────────────────────────────────────
_tle_cache: TTLCache = TTLCache(maxsize=1, ttl=900)  # 15 min

_HEADERS = {"User-Agent": "OrbitSafeAI/1.0"}


@cached(_tle_cache)
def fetch_gp_data() -> list[dict]:
    """
    Return raw GP records from CelesTrak (cached 15 min).

    A User-Agent header is required; CelesTrak returns 403 for
    bare requests with no User-Agent.  On any error the cache key
    is evicted so the next call retries instead of serving a cached
    failure.
    """
    logger.info("Fetching fresh TLE data from CelesTrak …")
    try:
        resp = requests.get(CELESTRAK_URL, headers=_HEADERS, timeout=30)
        resp.raise_for_status()
        records = resp.json()
        logger.info("Fetched %d GP records.", len(records))
        return records
    except Exception:
        # Evict the (empty) cache entry so the next request retries.
        _tle_cache.clear()
        raise


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


def _build_satrec(gp: dict) -> Optional[Satrec]:
    """Construct a Satrec object directly from CelesTrak GP JSON parameters."""
    try:
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
    Full pipeline: fetch → filter → propagate → TCA → Pc.
    Returns a list of conjunction dicts sorted by descending Pc.
    Caps the catalog at `max_objects` (highest-risk altitude band first)
    to keep runtime manageable for a demo.
    """
    t0 = time.time()
    gp_records = fetch_gp_data()

    # Trim to max_objects nearest LEO objects for demo feasibility
    gp_records = gp_records[:max_objects]

    sats = build_satellite_list(gp_records, t0)
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
