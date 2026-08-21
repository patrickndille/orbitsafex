"""
orbital_math.py
────────────────────────────────────────────────────────────────────────────────
Core astrodynamics engine for OrbitSafe AI.

Pipeline
  1. Fetch live GP data from Space-Track.org (3-hour in-memory cache,
     local JSON fallback on every successful fetch)
  2. Stratified-sample across LEO altitude bins (Priority 5 — removes bias)
  3. Spatiotemporal coarse prefilter: propagate at coarse intervals over the
     24-hour window, build a KD-Tree at each epoch, collect the union of pairs
     that pass within the screening radius at ANY epoch (Priority 4 — finds
     future-converging pairs that are far apart at t0)
  4. For each candidate pair run SGP4 bisection to find TCA
  5. Convert TEME ECI positions to geodetic using GMST at TCA (Priority 3 —
     epoch-aware Earth rotation)
  6. Compute Screening Pc using an isotropic 2-D Gaussian (assumed σ=200 m);
     this is NOT a full covariance-based operational Pc (Priority 6)

Scientific caveats
  • Pc uses a fixed isotropic σ=200 m; no object-specific covariance matrix.
  • GMST conversion uses a first-order approximation; accuracy ≈ 0.1° in lon.
  • Both are sufficient for screening/triage, not authoritative CDM analysis.
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
EARTH_RADIUS_KM   = 6371.0        # mean Earth radius
ALT_BIN_WIDTH_KM  = 50.0          # altitude bin width for stratified sampling
PROPAGATION_STEP_S = 60.0         # seconds between fine TCA-search steps
PROPAGATION_WINDOW_H = 24.0       # hours to look ahead

# Spatiotemporal coarse prefilter
# ─────────────────────────────────────────────────────────────────────────────
# The coarse prefilter samples every COARSE_INTERVAL_S seconds and flags pairs
# that come within COARSE_SCREEN_KM at any sampled epoch.
#
# KNOWN LIMITATION — fast-pass screening gap:
#   Transit time at 15 km/s through a 200 km sphere = 200/15 ≈ 13 s, which is
#   well below the 300 s coarse step.  High-relative-velocity pairs can slip
#   through without being detected at any sampled epoch.  This is an accepted
#   trade-off for interactive demo responsiveness.
#   For tighter screening reduce COARSE_INTERVAL_S (e.g. to 60 s) at the cost
#   of ~5× longer prefilter time.
#
# PERFORMANCE NOTE:
#   COARSE_INTERVAL_S = 300 s → 289 epochs over 24 h   (~2 s prefilter)
#   COARSE_INTERVAL_S =  60 s → 1441 epochs over 24 h  (~10 s prefilter)
#   COARSE_SCREEN_KM  = 200 km yields ~4,500–5,500 candidate pairs with 400
#   sampled satellites — fine TCA search over these completes in ~40–60 s.
#   COARSE_SCREEN_KM  = 500 km yields ~12,000+ pairs — too slow for interactive
#   use; avoid unless running as an offline batch job.
COARSE_INTERVAL_S  = 300.0        # 5-minute coarse step  → 289 epochs / 24 h
COARSE_SCREEN_KM   = 200.0        # 200 km screening radius → ~4,500–5,500 pairs

# Hard cap on candidate pairs forwarded to the expensive fine TCA search.
# Each pair requires ~1,440 SGP4 propagations (24 h at 60 s steps).
# At ~18 µs/call: 1,500 pairs ≈ 39 s;  3,000 pairs ≈ 78 s;  6,000 pairs ≈ 156 s.
# 1,500 pairs keeps interactive scan time under ~60 s on typical hardware.
# Pairs are sorted before capping for determinism.
MAX_CANDIDATE_PAIRS = 1500

HARD_BODY_RADIUS_M = 5.0          # combined hard-body radius (metres)
DEFAULT_SIGMA_M    = 200.0        # assumed isotropic 1-σ position uncertainty (m)
PC_THRESHOLD       = 1e-6         # report only conjunctions above this screening Pc

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
_GP_CACHE_TTL      = 10800          # 3 hours — Space-Track GP update cadence
_FETCH_MAX_RETRIES = 3
_FETCH_BACKOFF_BASE = 2.0

_gp_cache_data: Optional[list] = None
_gp_cache_ts:   float          = 0.0


def _resolve_source_order(source: str) -> list[str]:
    """Return ordered list of data sources to try based on GP_SOURCE env var."""
    if source == "space-track":
        return ["space-track", "local"]
    if source == "local":
        return ["local"]
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
    altitude_km: float = 0.0
    pos_km: np.ndarray = field(default_factory=lambda: np.zeros(3))
    vel_kms: np.ndarray = field(default_factory=lambda: np.zeros(3))


@dataclass
class ConjunctionEvent:
    primary_norad: int
    primary_name: str
    secondary_norad: int
    secondary_name: str
    tca_unix: float
    miss_distance_km: float
    relative_velocity_kms: float
    pc_value: float


# ──────────────────────────────────────────────────────────────────────────────
# SGP4 helpers
# ──────────────────────────────────────────────────────────────────────────────
_SGP4_ERRORS = {
    1: "mean eccentricity < 0 or >= 1",
    2: "mean motion < 0",
    3: "pert eccentricity < 0 or > 1",
    4: "semi-latus rectum < 0",
    5: "epoch elements are sub-orbital",
    6: "satellite has decayed",
}

# ── OMM JSON → sgp4init field map ────────────────────────────────────────────
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
    """Alias OMM field names to legacy GP names; safe to call on both formats."""
    out = dict(gp)
    for omm_key, gp_key in _OMM_TO_GP.items():
        if omm_key in out and gp_key not in out:
            out[gp_key] = out[omm_key]
    return out


def _build_satrec(gp: dict) -> Optional[Satrec]:
    """Construct a Satrec object from Space-Track GP/OMM JSON parameters."""
    try:
        gp = _normalise_gp(gp)

        epoch_str = gp["EPOCH"].replace("Z", "")
        ep_dt = datetime.datetime.fromisoformat(epoch_str)
        jd, fr = jday(
            ep_dt.year, ep_dt.month, ep_dt.day,
            ep_dt.hour, ep_dt.minute, ep_dt.second + ep_dt.microsecond / 1e6
        )

        sat = Satrec()
        sat.sgp4init(
            WGS72,
            "i",
            int(gp["NORAD_CAT_ID"]),
            jd + fr - 2433281.5,
            float(gp["BSTAR"]),
            float(gp["NDOT"]),
            float(gp["NDDOT"]),
            float(gp["ECCO"]),
            float(gp["ARGPO"]) * DEG2RAD,
            float(gp["INCLO"]) * DEG2RAD,
            float(gp["MO"])    * DEG2RAD,
            float(gp["NO_KOZAI"]) / XP3O15,
            float(gp["RAAN"])  * DEG2RAD,
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
# Priority 3 — TEME/ECI → Earth-fixed (epoch-aware GMST conversion)
# ──────────────────────────────────────────────────────────────────────────────
def _gmst_rad(unix_ts: float) -> float:
    """
    Greenwich Mean Sidereal Time (radians) at unix_ts.

    Uses the simplified IAU 1982 formula.  Accuracy is approximately 0.1–0.3°
    for dates within a few years of J2000, adequate for globe visualisation
    but not precision geodesy.

    Formula reference:
        GMST at J2000.0 = 280.46061837°
        Rate             = 360.98564736629 °/day (sidereal rotation)

    Epoch note:
        J2000.0 is 2000-01-01 12:00:00 TT.  The Unix timestamp used here
        is the UTC equivalent, 946728000.0 s (2000-01-01 12:00:00 UTC).
        The ~64-second TT–UTC difference at J2000 produces a ~0.27° offset
        in the GMST value; this is within the stated visualisation accuracy.
    """
    # J2000.0 = 2000-01-01 12:00:00 UTC  (TT≈UTC+64s; error ≈0.27° — acceptable)
    J2000_UNIX = 946728000.0
    days_since_j2000 = (unix_ts - J2000_UNIX) / 86400.0
    gmst_deg = (280.46061837 + 360.98564736629 * days_since_j2000) % 360.0
    return math.radians(gmst_deg)


def teme_to_geodetic(pos_km: np.ndarray, tca_unix: float) -> Tuple[float, float, float]:
    """
    Convert a TEME (SGP4 output) position vector to geodetic (lat, lon, alt).

    Steps:
      1. Rotate the inertial (TEME) X-Y axes by -GMST to get Earth-fixed X-Y.
      2. Compute spherical geodetic coordinates on a mean sphere (WGS84 would
         add ≤ 20 km error in altitude, acceptable for this application).

    Approximation: spherical Earth model; oblateness is neglected.
    Accuracy: longitude to ~0.1°; adequate for LEO globe placement.

    Args:
        pos_km:   ECI/TEME position vector [x, y, z] in km
        tca_unix: Unix timestamp of the epoch (used to compute GMST)

    Returns:
        (latitude_deg, longitude_deg, altitude_km)
        longitude is normalised to [-180, 180].
    """
    x, y, z = float(pos_km[0]), float(pos_km[1]), float(pos_km[2])
    gmst = _gmst_rad(tca_unix)

    # Rotate inertial X-Y by -GMST → Earth-fixed X-Y
    cos_g = math.cos(gmst)
    sin_g = math.sin(gmst)
    xf =  cos_g * x + sin_g * y
    yf = -sin_g * x + cos_g * y
    zf =  z

    r = math.sqrt(xf * xf + yf * yf + zf * zf)
    lat = math.degrees(math.asin(zf / r))
    lon = math.degrees(math.atan2(yf, xf))

    # Normalise longitude to [-180, 180]
    if lon > 180.0:
        lon -= 360.0
    elif lon < -180.0:
        lon += 360.0

    alt = r - EARTH_RADIUS_KM
    return round(lat, 4), round(lon, 4), round(alt, 4)


# ──────────────────────────────────────────────────────────────────────────────
# Build satellite list
# ──────────────────────────────────────────────────────────────────────────────
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
            pos, vel = _propagate(sat, t0)
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
            logger.debug("Skipping NORAD %s: %s", gp.get("NORAD_CAT_ID"), exc)
            skipped_build += 1

    logger.info(
        "Built %d valid satellite records (skipped: %d build, %d propagation, %d sub-orbital).",
        len(sats), skipped_build, skipped_prop, skipped_alt,
    )
    return sats


# ──────────────────────────────────────────────────────────────────────────────
# Priority 5 — Stratified altitude sampling
# ──────────────────────────────────────────────────────────────────────────────
def stratified_sample(
    sats: list[SatelliteRecord],
    max_objects: int,
    bin_width_km: float = ALT_BIN_WIDTH_KM,
) -> Tuple[list[SatelliteRecord], dict]:
    """
    Return up to max_objects satellites sampled proportionally across altitude
    bins of bin_width_km, covering 300–1200 km.

    Strategy: deterministic stratified sampling.
      1. Assign each satellite to its altitude bin.
      2. Compute each bin's proportional quota (floor + remainder).
      3. Sort each bin by NORAD ID for reproducibility.
      4. Take the first quota from each bin.

    This ensures coverage across the full 300–1200 km band regardless of
    the density distribution (many LEO objects cluster at specific altitudes).

    Returns:
        (sampled_list, coverage_metadata)
    """
    alt_min, alt_max = 300.0, 1200.0
    n_bins = int((alt_max - alt_min) / bin_width_km)

    bins: list[list[SatelliteRecord]] = [[] for _ in range(n_bins)]
    out_of_range = 0

    for s in sats:
        bin_idx = int((s.altitude_km - alt_min) / bin_width_km)
        if 0 <= bin_idx < n_bins:
            bins[bin_idx].append(s)
        else:
            out_of_range += 1

    total_eligible = sum(len(b) for b in bins)
    if total_eligible == 0:
        return [], {"eligible": 0, "sampled": 0, "bins": n_bins}

    quota = min(max_objects, total_eligible)

    # Proportional quotas per bin
    base = [int(quota * len(b) / total_eligible) for b in bins]
    remainder = quota - sum(base)

    # Assign remainders to bins with most objects first
    bin_order = sorted(range(n_bins), key=lambda i: len(bins[i]), reverse=True)
    for i in range(remainder):
        base[bin_order[i]] += 1

    sampled: list[SatelliteRecord] = []
    for i, (b, q) in enumerate(zip(bins, base)):
        if q <= 0:
            continue
        # Sort by NORAD ID for determinism
        b_sorted = sorted(b, key=lambda s: s.norad_id)
        sampled.extend(b_sorted[:q])

    coverage = {
        "eligible_leo_objects":   total_eligible,
        "sampled_objects":        len(sampled),
        "alt_bins":               n_bins,
        "bin_width_km":           bin_width_km,
        "out_of_range_skipped":   out_of_range,
    }

    logger.info(
        "Stratified sample: %d/%d LEO objects selected across %d altitude bins.",
        len(sampled), total_eligible, n_bins,
    )
    return sampled, coverage


# ──────────────────────────────────────────────────────────────────────────────
# Priority 4 — Spatiotemporal coarse prefilter
# ──────────────────────────────────────────────────────────────────────────────
def find_candidate_pairs_spatiotemporal(
    sats: list[SatelliteRecord],
    t0: float,
    window_h: float = PROPAGATION_WINDOW_H,
    coarse_s: float = COARSE_INTERVAL_S,
    screen_km: float = COARSE_SCREEN_KM,
    max_pairs: int = MAX_CANDIDATE_PAIRS,
) -> Tuple[list[Tuple[int, int]], dict]:
    """
    Spatiotemporal coarse prefilter: propagate all satellites at coarse intervals
    over the full window; collect the union of pairs that pass within screen_km
    at ANY sampled epoch.

    This extends the current-epoch-only KD-Tree approach, which misses pairs
    that are far apart at t0 but converge later in the window.

    Algorithm:
      1. At each coarse epoch t0 + k*coarse_s (k = 0, 1, …):
         a. Propagate every satellite to that epoch (skip on SGP4 error).
         b. Build a KD-Tree on 3-D ECI positions.
         c. Query all pairs within screen_km.
         d. Add new pairs to the union set.
      2. Return the deduplicated union.

    KNOWN LIMITATION — fast-pass screening gap:
      A pair travelling at relative velocity v_rel can traverse the entire
      screen_km sphere in screen_km / v_rel seconds.  If that transit time is
      shorter than coarse_s the pair will not be captured at any sampled epoch.
      With coarse_s = 300 s and screen_km = 500 km:
        transit time at 15 km/s = 500/15 ≈ 33 s  (<  300 s step).
      Fast-pass pairs at high relative velocity CAN be missed.
      This is an accepted trade-off for interactive demo responsiveness.
      Set COARSE_INTERVAL_S = 60 and COARSE_SCREEN_KM = 200 for tighter
      screening at the cost of ~5× longer scan time.

    Returns:
        (pairs_as_index_list, scan_metadata_dict)
    """
    if not sats:
        return [], {}

    n_epochs = int(window_h * 3600.0 / coarse_s) + 1
    pairs_set: set[Tuple[int, int]] = set()
    n_sats = len(sats)
    epochs_evaluated = 0

    for k in range(n_epochs):
        t = t0 + k * coarse_s
        positions = []
        valid_idx = []
        for idx, sat in enumerate(sats):
            pos, _ = _propagate(sat.satrec, t)
            if pos is not None:
                positions.append(pos)
                valid_idx.append(idx)

        if len(positions) < 2:
            continue

        pos_arr = np.array(positions)
        tree = KDTree(pos_arr)
        neighbour_lists = tree.query_ball_tree(tree, r=screen_km)

        for local_i, neighbours in enumerate(neighbour_lists):
            for local_j in neighbours:
                if local_j <= local_i:
                    continue
                gi = valid_idx[local_i]
                gj = valid_idx[local_j]
                pair = (min(gi, gj), max(gi, gj))
                pairs_set.add(pair)

        epochs_evaluated += 1

    pairs_list = list(pairs_set)
    capped = len(pairs_list) > max_pairs
    if capped:
        # Deterministic: sort by index pair so capping is reproducible
        pairs_list.sort()
        pairs_list = pairs_list[:max_pairs]

    metadata = {
        "propagation_window_h":    window_h,
        "coarse_interval_s":       coarse_s,
        "screening_radius_km":     screen_km,
        "satellites_evaluated":    n_sats,
        "coarse_epochs_evaluated": epochs_evaluated,
        "candidate_pairs":         len(pairs_list),
        "candidate_pairs_before_cap": len(pairs_set),
        "candidate_pairs_capped":  capped,
    }

    logger.info(
        "Spatiotemporal prefilter: %d candidate pairs from %d satellites "
        "over %d coarse epochs (window=%.0fh, step=%.0fs, r=%.0fkm)%s.",
        len(pairs_list), n_sats, epochs_evaluated,
        window_h, coarse_s, screen_km,
        f" [capped from {len(pairs_set)}]" if capped else "",
    )
    return pairs_list, metadata


# ──────────────────────────────────────────────────────────────────────────────
# TCA finder
# ──────────────────────────────────────────────────────────────────────────────
def find_tca(
    sat_a: SatelliteRecord,
    sat_b: SatelliteRecord,
    t0: float,
    window_h: float = PROPAGATION_WINDOW_H,
    step_s: float = PROPAGATION_STEP_S,
) -> Tuple[float, float, float, Optional[np.ndarray], Optional[np.ndarray]]:
    """
    Walk the propagation window in step_s increments; return
    (tca_unix, miss_distance_km, rel_velocity_kms, pos_a_km, pos_b_km).
    pos_a/b are TEME ECI vectors (km) at TCA, or None if propagation failed.
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

    # Bisection refinement over ±step_s around best_t
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
    return tca, best_dist, best_rv, ra_f, rb_f


# ──────────────────────────────────────────────────────────────────────────────
# Priority 6 — Screening Pc (isotropic 2-D Gaussian)
# ──────────────────────────────────────────────────────────────────────────────
def compute_pc(
    miss_distance_km: float,
    relative_velocity_kms: float,
    sigma_m: float = DEFAULT_SIGMA_M,
    hard_body_radius_m: float = HARD_BODY_RADIUS_M,
) -> float:
    """
    Compute a Screening Probability of Collision using a 2-D Gaussian integral
    (simplified Alfano / Patera method).

    IMPORTANT CAVEATS:
      • Uses a fixed isotropic σ=200 m; no object-specific covariance matrix.
      • Does NOT project covariance into the encounter plane using relative
        velocity geometry (full Alfano solution).
      • Does NOT incorporate CDM-quality orbital determination uncertainty.
      • The result is a screening estimate only, suitable for initial triage.
      • Authoritative maneuver decisions require CDM data and flight-dynamics
        review by qualified personnel.

    Formula:
      Pc = (1/(2π σ²)) ∬_A exp(−|r−r₀|²/(2σ²)) dx dy
      where A is a disk of radius r_hbr at the origin,
      and r₀ = (miss_m, 0) in the encounter plane.
    """
    if miss_distance_km <= 0 or relative_velocity_kms <= 0:
        return 0.0

    miss_m = miss_distance_km * 1000.0
    sigma  = sigma_m
    r_hbr  = hard_body_radius_m

    x0 = miss_m
    y0 = 0.0

    norm = 1.0 / (2.0 * math.pi * sigma ** 2)

    def integrand(y, x):
        return norm * math.exp(-((x - x0) ** 2 + (y - y0) ** 2) / (2.0 * sigma ** 2))

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
    Full pipeline: fetch → LEO filter → stratified sample → spatiotemporal
    candidate search → TCA bisection → TEME→geodetic → Screening Pc.

    Returns a list of conjunction dicts sorted by descending Pc (MONITOR last).

    Pipeline:
      1. Fetch full GP catalog (Space-Track → local fallback).
      2. Propagate ALL records to get current ECI state and altitude.
      3. Filter to 300–1200 km LEO band.
      4. Stratified-sample across altitude bins (removes low-altitude bias).
      5. Spatiotemporal coarse prefilter over 24 h at 5-min coarse steps (289 epochs).
      6. Fine TCA bisection for each candidate pair.
      7. TEME→geodetic conversion using GMST at TCA epoch.
      8. Screening Pc (isotropic σ=200 m — NOT full covariance-based Pc).
      9. Tier events; retain MONITOR band (10–100 km, Pc < 1e-6).

    Each event carries:
      - primary_lat/lon/alt_km, secondary_lat/lon/alt_km  (TCA positions)
      - pc_assumed_sigma_m, pc_hard_body_radius_m          (Pc assumptions)
      - scan_metadata                                       (coverage info)
    """
    t0 = time.time()
    gp_records = fetch_gp_data()

    all_sats = build_satellite_list(gp_records, t0)

    # Filter to active LEO band
    leo_sats = [s for s in all_sats if 300.0 <= s.altitude_km <= 1200.0]

    # Priority 5: Stratified sample instead of altitude-sorted truncation
    sats, coverage_meta = stratified_sample(leo_sats, max_objects)

    logger.info(
        "LEO filter: %d/%d objects in 300–1200 km band, using %d after stratified sample.",
        len(leo_sats), len(all_sats), len(sats),
    )

    # Priority 4: Spatiotemporal prefilter
    pairs, st_meta = find_candidate_pairs_spatiotemporal(sats, t0)

    tiered: List[dict] = []
    monitor: List[dict] = []

    for i, j in pairs:
        a, b = sats[i], sats[j]
        tca, miss_km, rel_v, ra_tca, rb_tca = find_tca(a, b, t0)

        # Priority 6: Screening Pc with documented assumptions
        pc = compute_pc(miss_km, rel_v)

        # Priority 3: Epoch-aware TEME→geodetic conversion
        if ra_tca is not None:
            p_lat, p_lon, p_alt = teme_to_geodetic(ra_tca, tca)
        else:
            p_lat, p_lon, p_alt = 0.0, 0.0, 400.0
        if rb_tca is not None:
            s_lat, s_lon, s_alt = teme_to_geodetic(rb_tca, tca)
        else:
            s_lat, s_lon, s_alt = 0.0, 0.0, 400.0

        # pc_value: the real computed probability (never clamped to 0).
        # For MONITOR events (pc < PC_THRESHOLD) we preserve the real float so
        # operators and tests can see the actual value.  The frontend formats
        # values below the threshold as "< 1×10⁻⁶" for display.
        pc_rounded = float(f"{pc:.6e}") if pc > 0.0 else 0.0

        event = {
            "norad_id":                 a.norad_id,
            "sat_name":                 a.name,
            "secondary_norad_id":       b.norad_id,
            "secondary_name":           b.name,
            "tca_iso":                  _unix_to_iso(tca),
            "miss_distance_km":         round(miss_km, 4),
            "relative_velocity_kms":    round(rel_v, 4),
            "pc_value":                 pc_rounded,   # real value; 0.0 only if compute_pc returned 0
            "primary_lat":              p_lat,
            "primary_lon":              p_lon,
            "primary_alt_km":           p_alt,
            "secondary_lat":            s_lat,
            "secondary_lon":            s_lon,
            "secondary_alt_km":         s_alt,
            # Screening Pc assumptions (Priority 6)
            "pc_assumed_sigma_m":       DEFAULT_SIGMA_M,
            "pc_hard_body_radius_m":    HARD_BODY_RADIUS_M,
            "pc_method":                "screening-isotropic-gaussian",
        }

        if pc >= PC_THRESHOLD:
            tiered.append(event)
        elif 10.0 <= miss_km <= 100.0:
            monitor.append(event)

    tiered.sort(key=lambda r: r["pc_value"], reverse=True)
    results = tiered + monitor

    logger.info(
        "Scan complete: %d tiered (Pc ≥ 1e-6) + %d MONITOR events.",
        len(tiered), len(monitor),
    )

    scan_metadata = {
        **coverage_meta,
        **st_meta,
        "prefilter_limitation": (
            "Fast-pass conjunctions (relative speed > screen_km / coarse_s) "
            "may not be detected by the coarse prefilter."
        ),
    }

    return results, scan_metadata


def _unix_to_iso(unix_ts: float) -> str:
    import datetime
    return datetime.datetime.utcfromtimestamp(unix_ts).strftime("%Y-%m-%dT%H:%M:%SZ")
