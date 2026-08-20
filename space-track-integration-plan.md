# OrbitSafe AI – Space-Track Integration Plan

## Overview

CelesTrak is unreachable (ERR_CONNECTION_TIMED_OUT confirmed in browser) and is
**disabled** as a data source for now. The system falls back to a local JSON file
(`data/gp_fallback.json`, 31 659 records), but produces 0 conjunction candidates
because `run_conjunction_scan` takes the **first** `max_objects` records from the
raw catalog — which spans every orbital shell from LEO to GEO — so the KD-Tree
finds 0 pairs within 100 km.

Two fixes are required:

1. **Space-Track authentication** — `backend/services/space_track.py` exists but
   its `_login()` checks for a deprecated cookie name (`chocolatechip`) that
   Space-Track no longer sets, causing every login attempt to silently report
   failure. Authentication must be verified via a lightweight GET to `/app/data/whoami`
   which returns `{"logged_in": bool}`. The GP query URL also uses the slower
   `epoch/%3Enow-10` pattern instead of the recommended hourly `CREATION_DATE/%3Enow-0.042`.

2. **Space-Track GP query URL** — Per the API guidelines, the GP query must include
   `decay_date/null-val/CREATION_DATE/%3Enow-0.042` to retrieve only on-orbit objects
   updated in the last hour, and must use `format/json` to return OMM JSON that the
   existing `_normalise_gp()` mapper already handles.

3. **LEO altitude pre-filter in `run_conjunction_scan`** — After propagating all
   records to get ECI state, filter to the 300–1 200 km altitude band where
   conjunction density is highest, sort by altitude, then cap to `max_objects`.
   This gives the KD-Tree spatially coherent input and guarantees candidate pairs.

---

## Sub-Tasks

---

### Sub-Task 1 — Create `backend/services/space_track.py`

**Status:** `[ ] pending`

**Intent**
Create the `SpaceTrackClient` class that `orbital_math._fetch_space_track()` already
imports. It must authenticate via `POST /ajaxauth/login`, verify the session with a
lightweight `whoami` GET (not a cookie name check), fetch the full on-orbit GP
catalog with the correct query URL, and clean up by calling `GET /ajaxauth/logout`.

**Expected Outcomes**
- `_fetch_space_track()` in `orbital_math.py` no longer raises `ModuleNotFoundError`.
- A successful run logs `Space-Track authentication successful` and returns a list
  of dicts with OMM field names (handled by `_normalise_gp()`).
- An authentication failure logs an error and returns `None` (fallback to CelesTrak
  or local file).

**Todo List**
1. Create `backend/services/space_track.py` with a `SpaceTrackClient` class.
2. Define module-level constants:
   - `SPACE_TRACK_BASE = "https://www.space-track.org"`
   - `LOGIN_URL = f"{SPACE_TRACK_BASE}/ajaxauth/login"`
   - `WHOAMI_URL = f"{SPACE_TRACK_BASE}/app/data/whoami"`
   - `GP_QUERY_URL`: the correct per-guidelines URL (see Sub-Task 2 for the exact
     path; include `decay_date/null-val/CREATION_DATE/%3Enow-0.042/format/json`)
3. `__init__(self, username, password)` — store credentials, create
   `requests.Session()`, set `self._logged_in = False`.
4. `_login(self) -> bool`:
   - POST `{"identity": username, "password": password}` to `LOGIN_URL`.
   - On HTTP 200, verify authentication by GET `WHOAMI_URL`; parse the
     `logged_in` boolean from the JSON response.
   - Set `self._logged_in = True` only when `whoami["logged_in"] is True`.
   - Log success at INFO, failure at ERROR; return the bool.
5. `fetch_gp_data(self) -> Optional[list[dict]]`:
   - Call `_login()`; return `None` if it fails.
   - GET `GP_QUERY_URL`; raise on non-200.
   - Return parsed JSON list.
6. `logout(self) -> None`:
   - GET `f"{SPACE_TRACK_BASE}/ajaxauth/logout"` inside a try/except.
7. Use the class as a context manager (`__enter__`/`__exit__`) so `logout()` is
   always called, even on error.

**Relevant Context**
- `orbital_math.py:112` — `_fetch_space_track()` calls
  `SpaceTrackClient(username, password).fetch_gp_data()`.
- Login URL confirmed from how-to guide: `https://www.space-track.org/ajaxauth/login`
- Whoami URL confirmed from how-to guide: `https://www.space-track.org/app/data/whoami`
  returns `{"logged_in": bool, "identity": str|null, "session_expiration": str}`.
- OMM JSON field names (`INCLINATION`, `RA_OF_ASC_NODE`, `MEAN_MOTION`, etc.) are
  already handled by `_normalise_gp()` in `orbital_math.py:321`.

---

### Sub-Task 2 — Fix the Space-Track GP query URL

**Status:** `[ ] pending`

**Intent**
The GP query URL must use the exact pattern from the Space-Track API guidelines to
retrieve only currently on-orbit, recently-updated objects, and return OMM JSON that
`_normalise_gp()` already handles. The hourly-update variant is:

```
/basicspacedata/query/class/gp/decay_date/null-val/CREATION_DATE/%3Enow-0.042/format/json
```

`decay_date/null-val` excludes decayed satellites.  
`CREATION_DATE/%3Enow-0.042` limits to elements uploaded in the last ~60 minutes
(0.042 days ≈ 1 hour), matching the GP hourly update cadence.  
`format/json` returns OMM JSON (all fields in `gp_format.pdf`).

**Expected Outcomes**
- `GP_QUERY_URL` in `space_track.py` uses the exact path above.
- Fetched records contain OMM field names (`MEAN_MOTION`, `INCLINATION`, etc.) that
  pass through `_normalise_gp()` without any `KeyError`.
- Per-guidelines fetch rate: at most once per hour (the 3-hour `_GP_CACHE_TTL` in
  `orbital_math.py` already enforces this).

**Todo List**
1. Set `GP_QUERY_URL` in `space_track.py` to:
   ```
   SPACE_TRACK_BASE + "/basicspacedata/query/class/gp"
                    + "/decay_date/null-val"
                    + "/CREATION_DATE/%3Enow-0.042"
                    + "/format/json"
   ```
2. Confirm the session's GET request uses the full URL and that the response is
   parsed with `resp.json()` (not `json.loads(resp.text)`) for consistency.
3. Add a guard: if the returned list is empty (valid but no new data since last
   query), log a WARNING and return `None` so `fetch_gp_data()` in
   `orbital_math.py` falls through to CelesTrak or local fallback.

**Relevant Context**
- `space-track-api-guidelines.pdf`, GP class section — exact recommended URL for
  hourly retrieval.
- `space-track.org_basicspacedata_modeldef_class_gp_format.pdf` — full field list;
  all OMM fields are already mapped in `orbital_math._OMM_TO_GP`.
- `orbital_math.py:83` — `_GP_CACHE_TTL = 10800` (3 h) enforces the 1/hour limit.

---

### Sub-Task 3 — Fix LEO altitude pre-filter in `run_conjunction_scan`

**Status:** `[ ] pending`

**Intent**
`run_conjunction_scan` currently slices `gp_records[:max_objects]` from the raw
catalog before propagating. The raw catalog lists objects in arbitrary order —
mixing LEO, MEO, GEO and HEO — so the 400 objects fed to `build_satellite_list`
are spread across wildly different altitude shells. The KD-Tree query radius of
100 km finds 0 pairs because none of these objects share the same orbital
neighbourhood.

The fix: propagate ALL fetched records first to get real ECI altitudes, then filter
to the 300–1 200 km LEO band (highest conjunction density), sort by altitude
(ensures spatial clustering), and only then cap to `max_objects`.

**Expected Outcomes**
- `KD-Tree pre-filter: N candidate pairs from 400 satellites` logs a non-zero N.
- The conjunction table in the dashboard shows events.
- Scan runtime remains acceptable: propagating ~5 000 LEO objects at t0 is fast
  (one SGP4 call each); the expensive TCA search only runs on the small candidate
  set returned by the KD-Tree.

**Todo List**
1. In `run_conjunction_scan()` (`orbital_math.py:568`), replace the current
   `gp_records[:max_objects]` slice with the LEO-aware pipeline:
   ```python
   t0 = time.time()
   gp_records = fetch_gp_data()

   # Propagate full catalog to get current altitudes
   all_sats = build_satellite_list(gp_records, t0)

   # Keep only LEO band (300–1 200 km) — highest conjunction density
   leo_sats = [s for s in all_sats if 300.0 <= s.altitude_km <= 1200.0]

   # Sort by altitude so spatially adjacent objects are clustered
   leo_sats.sort(key=lambda s: s.altitude_km)

   # Cap to max_objects after the LEO filter
   sats = leo_sats[:max_objects]
   ```
2. Pass `sats` (already a `list[SatelliteRecord]`) directly to
   `find_candidate_pairs()`; remove the call to `build_satellite_list()` that
   previously used the sliced `gp_records`.
3. Update the docstring of `run_conjunction_scan()` to reflect the new pipeline.
4. Log the LEO filter outcome:
   ```python
   logger.info("LEO filter: %d/%d objects in 300–1200 km band, using %d.",
               len(leo_sats), len(all_sats), len(sats))
   ```

**Relevant Context**
- `orbital_math.py:568` — `run_conjunction_scan()`.
- `orbital_math.py:392` — `build_satellite_list()` already returns
  `list[SatelliteRecord]` with `altitude_km` populated.
- `orbital_math.py:434` — `find_candidate_pairs()` accepts `list[SatelliteRecord]`.
- Logs show `Built 400 valid satellite records` but `0 candidate pairs` because
  the 400 records span all altitude shells.

---

## Dependency Order

```
Sub-Task 1  (create space_track.py)
    ↓
Sub-Task 2  (fix GP query URL — part of space_track.py)
    ↓
Sub-Task 3  (fix LEO filter — independent of space_track.py, can run in parallel)
```

Sub-Tasks 1 and 2 are written into the same file and should be implemented together.
Sub-Task 3 touches only `orbital_math.py` and is independent.

## Post-Implementation Validation

After all sub-tasks:
- Start backend: `uvicorn app:app --reload`
- Trigger scan via `GET /api/scan_conjunctions?max_objects=400`
- Expected log sequence:
  ```
  Space-Track authentication successful
  Fetched NNNN GP records from Space-Track
  Source space-track succeeded with NNNN records
  LEO filter: MMMM/NNNN objects in 300–1200 km band, using 400
  Built 400 valid satellite records (skipped: ...)
  KD-Tree pre-filter: K candidate pairs from 400 satellites.   ← K > 0
  Scan complete: J conjunction events above Pc threshold.
  ```
- `GET /api/gp-source` should return `"active_source": "space-track"`.
