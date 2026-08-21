
---
# OrbitSafe AI — Development Notes

Space debris tracking and conjunction analysis dashboard.  
Primary AI development tool: **IBM Bob**.

---

## Concept

OrbitSafe AI is a real-time space debris conjunction warning and AI triage dashboard.

Low-Earth Orbit (LEO) is increasingly congested, making debris tracking and collision prevention a critical challenge. True conjunction risk requires projecting orbits forward in time and computing statistical encounter probabilities based on relative velocity, positional uncertainty, and encounter-plane geometry — not arbitrary distance thresholds.

---

## Architectural Transition: CelesTrak → Space-Track.org

During development the data ingestion layer was migrated from CelesTrak to Space-Track.org.

- **Primary rationale:** Space-Track.org is operated by 18th Space Defense Squadron (18 SDS) and is the authoritative source for General Perturbations (GP) element sets.
- **Rate limiting & reliability:** Authentication against Space-Track via REST (`/app/data/whoami`) provides stable, authenticated query access.
- **Granular filtering:** Server-side REST filters (e.g. `CREATION_DATE/>now-0.042`) reduce bandwidth and client processing.
- **Fallback strategy:** Successful responses automatically update `data/gp_fallback.json` for zero-downtime offline resilience.

CelesTrak references have been removed from all environment configuration and runtime code.

---

## Scope (Current)

1. **Data Ingestion & Caching** — authenticate against Space-Track.org; maintain disk-backed JSON fallback for offline use.

2. **Screening Probability of Collision (Pc)** — propagate orbits via SGP4; compute a *screening Pc* using assumed isotropic positional uncertainty (σ = 200 m) and a simplified 2-D Gaussian integral. This is **not** a CDM-quality operational Pc; it is an initial-pass screening estimate only.

3. **AI Triage** — the LLM explains and contextualises the deterministically computed metrics. It does **not** calculate or invent collision probability. All maneuver recommendations are advisory only; authoritative decisions require object-specific covariance/CDM data and review by a qualified flight-dynamics team.

4. **Interactive Dashboard** — Next.js/React frontend with Three.js 3-D globe, two-level conjunction visualization, and interactive triage drawer.

5. **Project Documentation** — full `README.md` covering orbital mechanics, API pipelines, and IBM Bob development history.

---

## Technical Stack

| Layer | Technology |
|---|---|
| Development AI | IBM Bob (primary tool and astrodynamics collaborator) |
| Backend | FastAPI (Python) |
| LLM / orchestration | LangChain + OpenAI-compatible client (IBM Granite / GPT-4o-mini) |
| Orbital mechanics | `sgp4`, `scipy`, `numpy` |
| Frontend | Next.js, React, Tailwind CSS, Three.js |
| Persistence | SQLite (v2 schema with TCA position fields) |
| Telemetry source | Space-Track.org REST API |

---

## Core Physics

### SGP4 Propagation

GP element sets are propagated forward using `sgp4` to find the Time of Closest Approach (TCA) via bisection.

### Spatiotemporal Candidate Discovery

The previous implementation built a KD-Tree only at the current epoch (`t0`). A pair that is currently far apart but converging was completely missed.

The current implementation uses a spatiotemporal coarse prefilter:

1. Propagate all selected satellites at coarse 5-minute intervals over a 24-hour window (289 epochs).
2. At each epoch, query a KD-Tree for pairs within the 200 km screening radius.
3. Collect the **union** of all candidate pairs encountered at any epoch.
4. Cap at 1,500 pairs (deterministic sort before truncation) for scan time predictability.
5. Run fine TCA bisection only for those candidate pairs.

This ensures converging pairs are found even if they are far apart at `t0`.

**Performance trade-off:** coarse 5-minute steps may miss very fast relative approaches where the objects enter and exit the screening radius within one step interval. This limitation is documented in `scan_metadata.prefilter_limitation`.

### Epoch-Aware TEME → Geodetic Conversion

SGP4 returns TEME/ECI position vectors. Geographic placement requires rotating the inertial X-Y axes by −GMST (Greenwich Mean Sidereal Time) before computing latitude, longitude, and altitude.

The simplified IAU 1982 GMST formula is used:

```
GMST = 280.46061837° + 360.98564736629° × days_since_J2000
```

Accuracy: ~0.1–0.3° for dates within a few years of J2000, adequate for globe visualisation. A spherical Earth model is used; WGS-84 oblateness is not applied (acceptable ≤ 20 km altitude error at LEO altitudes).

The old implementation used `atan2(y, x)` directly without applying GMST, which produced inertial (not Earth-fixed) longitude. This has been corrected.

### Screening Probability of Collision

```
Pc ≈ (HBR²) / (2π σ²) × exp(−d² / (2σ²))
```

where:
- `σ = 200 m` — assumed isotropic positional uncertainty (not object-specific covariance)
- `HBR = 5 m` — combined hard-body radius
- `d` — miss distance at TCA

This is a **screening estimate** only. It does not use object-specific covariance matrices or covariance projection into the encounter plane. It is not equivalent to a CDM-quality Alfano solution.

### Stratified Altitude Sampling

Objects are sampled across altitude bins (50 km width, 300–1200 km) proportionally, replacing the previous altitude-sorted truncation that biased the sample toward the lowest-altitude objects.

---

## Visualization Design

### Two-Level Architecture

1. **True-position globe marker** — each conjunction pair is rendered as a single midpoint glyph at its real TCA lat/lon on the Earth-scale globe. At typical LEO altitudes a 0.40 km separation is sub-pixel; one glyph per pair avoids overlap.

2. **Magnified encounter inset** — a Canvas 2-D overlay inside the globe panel displays the primary and secondary at a readable pixel separation (~180 px). A red dashed connector, object labels, miss distance, TCA, and risk tier are shown. The inset is explicitly labelled **"Encounter geometry magnified — not to scale"**.

No approach-direction arrows are drawn. Scalar relative speed alone does not determine the 3-D approach direction; drawing arrows would fabricate information not available from GP data alone.

### Globe Auto-Spin

The globe auto-spin is a **cosmetic display effect only**. It does not represent the passage of orbital time or satellite motion along their orbits.

---

## Scientific Limitations

- Pc uses assumed isotropic σ = 200 m, not object-specific covariance matrices.
- No full encounter-plane covariance projection.
- Relative velocity is not used to construct covariance geometry.
- Spatiotemporal prefilter uses a 5-minute coarse step; fast-approach pairs (closing faster than 200 km / 300 s ≈ 0.67 km/s) may be missed.
- Earth model is spherical; WGS-84 oblateness is not applied.
- GMST formula accuracy is ~0.1–0.3°; adequate for visualisation, not precision geodesy.

---

## IBM Bob Development History

IBM Bob served as the primary full-stack engineer and astrodynamics collaborator for every phase of development:

- Initial FastAPI scaffold and SGP4 pipeline design
- Space-Track.org authentication and GP catalog ingestion
- KD-Tree prefilter → spatiotemporal coarse prefilter architecture
- TEME→geodetic GMST-aware conversion
- Stratified altitude sampling
- SQLite persistence with idempotent v2 migration and TCA position fields
- Three.js globe: two-level visualization, absolute-overlay encounter inset, ResizeObserver fix
- LLM system prompt constraints: screening Pc, no collision-certainty language, advisory-only maneuvers
- Full backend pytest suite (21 tests) and frontend Jest suite (20 tests)
- README.md and documentation accuracy corrections

---
