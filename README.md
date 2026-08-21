# 🛰️ OrbitSafe AI

> **Real-time Space Debris Conjunction Warning & AI-Powered Evasive Maneuver Triage**

[![FastAPI](https://img.shields.io/badge/FastAPI-0.111-009688?logo=fastapi)](https://fastapi.tiangolo.com/)
[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)](https://nextjs.org/)
[![Three.js](https://img.shields.io/badge/Three.js-0.165-black?logo=three.js)](https://threejs.org/)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python)](https://python.org/)
[![Built with IBM Bob](https://img.shields.io/badge/Built%20with-IBM%20Bob-0f62fe)](https://ibm.com)

---

## 🎯 Problem Statement

Low-Earth orbit (LEO) is increasingly congested. As of 2026, space surveillance networks track tens of thousands of active objects and orbital debris. At relative velocities up to 15 km/s, even small objects pose catastrophic collision risks.

**Collision risk cannot be evaluated by raw distance thresholds alone.** Assessing true risk requires:

1. Forward-propagating each object's orbit to find when two objects are *actually* closest — the **Time of Closest Approach (TCA)**.
2. Integrating a 2-D probability density function over the combined hard-body cross-section to compute the **Probability of Collision ($P_c$)**.
3. Delivering that risk context to mission operators fast enough to plan and execute an evasive maneuver — which may require a burn decision **24–72 hours before TCA**.

Despite vast amounts of available tracking data, extracting actionable collision risk from raw orbital elements remains a specialist task. Mission operators — particularly those at small satellite teams, research institutions, and emerging space programs — need a fast, trustworthy bridge between raw GP telemetry and a maneuver decision they can act on with confidence. OrbitSafe AI provides that bridge: physics-rigorous orbital mechanics, an $O(n \log n)$ spatial pre-filter to handle thousands of objects in real time, and LLM-driven triage that translates $P_c$ metrics into immediate, structured, actionable guidance.

---

## 🏆 Challenge Theme

This project is a submission to the **[IBM AI Builders Challenge with IBM Bob](https://ibm.com) — August 2026**.

**Selected theme:** *Advance Space Exploration with AI*

OrbitSafe AI directly addresses the challenge's **Space debris tracking and collision avoidance systems** example solution area. It demonstrates how AI can transform space exploration from data-heavy to insight-driven systems by:

- Making authoritative USSF orbital telemetry accessible to operators without specialist astrodynamics training
- Using LLM reasoning to translate $P_c$ values, miss distances, and relative velocities into structured, actionable maneuver directives
- Pairing deterministic physics (SGP4 + Alfano $P_c$ integration) with AI triage so that AI-generated recommendations are always grounded in mathematically computed facts — the AI explains and guides, never guesses the collision probability

**IBM Bob** was the primary development tool used for every component: backend astrodynamics engine, FastAPI service layer, React/Next.js dashboard, Three.js globe, SQLite persistence, markdown rendering pipeline, and this documentation.

---

## 💡 Solution Description

OrbitSafe AI is a full-stack space situational awareness (SSA) platform:

| Layer | What it does |
|---|---|
| **Space-Track.org Ingestion** | Authenticates against the authoritative USSF/18 SDS GP catalog via session cookies, fetches live OMM/JSON element sets, and maintains a local disk fallback for offline resilience |
| **SGP4 Propagation** | Propagates every GP record forward using the `sgp4` library to compute current ECI position/velocity and find the Time of Closest Approach |
| **Screening $P_c$ Engine** | Computes a Screening Probability of Collision using an isotropic 2-D Gaussian integral (Alfano/Patera method, assumed σ=200 m). This is a screening estimate, not a CDM-quality operational Pc. |
| **Spatiotemporal Prefilter** | Propagates all satellites at 5-minute coarse intervals over the 24-hour window; builds a KD-Tree at each epoch to collect pairs that pass within 100 km at ANY future time — not just at t₀. This finds future-converging pairs that a snapshot filter would miss. |
| **Stratified Altitude Sampling** | When capping the evaluated object count, samples proportionally across 50-km altitude bins (300–1200 km) rather than truncating the sorted-by-altitude list, ensuring full-band coverage. |
| **Epoch-Aware Geodetic Conversion** | Converts SGP4 TEME/ECI output to Earth-fixed geographic coordinates using GMST at TCA, so globe positions reflect actual sub-satellite ground tracks. |
| **SQLite Persistence** | Every completed scan is stored with full TCA position fields (`primary_lat/lon/alt`, `secondary_lat/lon/alt`, `position_source`). Schema is idempotently migrated on startup. |
| **FastAPI Backend** | Exposes async REST endpoints for scanning, AI triage, and scan history retrieval. |
| **LangChain + LLM** | Routes conjunction metrics to a ChatOpenAI-compatible model to generate structured advisory Markdown + LaTeX recommendations. The LLM explains and contextualises the metrics — it does NOT calculate or invent collision probability. |
| **Next.js Dashboard** | Renders a responsive operator UI with a live 3-D Earth globe, magnified encounter inset, a searchable/filterable conjunction table, a slide-in AI triage drawer, and a scan history panel. |

---

## 🏗️ System Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           OPERATOR BROWSER                               │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                      Next.js 14 Frontend                           │  │
│  │                                                                    │  │
│  │  ┌────────────┐  ┌────────────────────┐  ┌──────────────────────┐ │  │
│  │  │ GlobeView  │  │  ConjunctionTable  │  │  TriageDrawer        │ │  │
│  │  │ (Three.js) │  │  Search/Filter/Pc  │  │  ReactMarkdown+KaTeX │ │  │
│  │  └────────────┘  └────────────────────┘  └──────────────────────┘ │  │
│  │                                                                    │  │
│  │  ┌────────────────────────────────────────────────────────────┐   │  │
│  │  │  ScanHistoryDrawer  (list → detail → load into dashboard)  │   │  │
│  │  └────────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────┬────────────────────────────────────┘  │
└──────────────────────────────────│──────────────────────────────────────┘
                                   │  HTTP / REST
               ┌───────────────────▼────────────────────────┐
               │          FastAPI Backend  (app.py)          │
               │                                             │
               │  GET  /api/scan_conjunctions                │
               │  POST /api/triage                           │
               │  GET  /api/history                          │
               │  GET  /api/history/{scan_id}                │
               │  GET  /api/gp-source                        │
               │  GET  /healthz                              │
               └──────┬───────────────────────┬─────────────┘
                      │                       │
        ┌─────────────▼──────────┐  ┌─────────▼───────────────┐
        │   orbital_math.py      │  │  LangChain / ChatOpenAI  │
        │                        │  │                           │
        │  ① Space-Track fetch          │  │  SystemMessage (expert  │
        │  ② LEO altitude filter        │  │    ops assistant;       │
        │  ③ Stratified altitude sample │  │    accuracy constraints)│
        │  ④ Spatiotemporal prefilter   │  │  HumanMessage (metrics) │
        │  ⑤ SGP4 propagation (TCA)     │  │  → structured Markdown  │
        │  ⑥ TEME→geodetic (GMST)       │  │    advisory; NOT Pc     │
        │  ⑦ Screening Pc (σ=200 m)     │  │    calculation          │
        │                               │  └─────────────────────────┘
        └──────┬─────────────────┘
               │
        ┌──────▼──────────────────────────────────────────────┐
        │            services/db.py  (SQLite v2)               │
        │  scans(id, scanned_at, event_count)                  │
        │  conjunction_events(scan_id, norad_id, pc_value,     │
        │    primary_lat, primary_lon, primary_alt_km,         │
        │    secondary_lat, secondary_lon, secondary_alt_km,   │
        │    position_source)                                  │
        └──────────────────────────────────────────────────────┘
               │
        ┌──────▼──────────────────────────────────────────────┐
        │        Space-Track.org  (external authoritative)     │
        │  POST /ajaxauth/login  → session cookie              │
        │  GET  /app/data/whoami → verify auth                 │
        │  GET  /basicspacedata/query/class/gp/…               │
        │        decay_date/null-val                           │
        │        CREATION_DATE/>now-0.042                      │
        │        format/json                                   │
        │                                                      │
        │  Fallback: data/gp_fallback.json  (auto-maintained)  │
        └──────────────────────────────────────────────────────┘
```

---

## 🔭 Orbital Mechanics: SGP4 & Probability of Collision

### Two-Line Element Sets (TLEs) and GP OMM Records

Space-Track.org provides orbital data in the **OMM (Orbit Mean-elements Message)** JSON format — the modern CCSDS standard superseding raw TLE text files. Each record encodes a satellite's mean orbital elements at a reference epoch:

- Inclination, RAAN, eccentricity, argument of perigee, mean anomaly, mean motion
- Drag coefficient (B\*) for atmospheric drag modelling
- NORAD catalog ID and object classification

OrbitSafe AI normalises both OMM JSON field names (`MEAN_MOTION`, `INCLINATION`, …) and legacy GP field names (`NO_KOZAI`, `INCLO`, …) through an internal mapping table, ensuring compatibility with any GP-class Space-Track response format.

### SGP4 Propagation

The **Simplified General Perturbations 4 (SGP4)** model propagates orbital element sets forward in time, accounting for:

- Earth's oblateness ($J_2$, $J_3$, $J_4$ zonal harmonics)
- Atmospheric drag (exponential density model)
- Solar/lunar gravitational perturbations (for high orbits)

OrbitSafe AI uses the **`sgp4`** Python library (the canonical Vallado C++ implementation) to compute ECI position/velocity vectors at each time step. The TCA is found by walking a 24-hour propagation window in 60-second steps, then bisecting the minimum-range interval over 20 iterations for sub-second accuracy.

**LEO band filter + stratified sample:** After propagating the full catalog, OrbitSafe AI retains only objects in the **300–1,200 km altitude band**. Rather than truncating the altitude-sorted list (which biases toward the lower band), it uses **deterministic stratified sampling** across 50-km altitude bins to ensure uniform coverage of the full LEO shell.

### Spatiotemporal Candidate Discovery

The previous snapshot-only KD-Tree query (built at t₀) missed pairs that are far apart at the start of the scan window but converge later. The current prefilter:

1. Propagates all selected satellites at **5-minute coarse intervals** over the 24-hour window (288 epochs).
2. Builds a KD-Tree at each epoch and collects pairs within 100 km.
3. Returns the **union of all pairs** found at any epoch for fine TCA refinement.

This captures future-converging pairs at essentially zero additional miss rate; LEO relative velocities (0–15 km/s) comfortably exceed the 333 m/s minimum detectable approach speed.

### Epoch-Aware TEME → Geodetic Conversion

SGP4 outputs positions in the TEME/ECI frame. The longitude of a satellite in inertial coordinates is NOT the same as its geographic longitude — Earth rotates by ~0.25°/min. OrbitSafe AI applies the **Greenwich Mean Sidereal Time (GMST)** rotation at TCA to convert ECI to Earth-fixed coordinates before computing latitude/longitude. The simplified IAU 1982 formula provides ~0.1° accuracy, sufficient for LEO globe placement.

### Screening Probability of Collision ($P_c$)

> **Important:** This is a **screening estimate**, not an authoritative CDM-quality Pc.

The screening $P_c$ integrates a bivariate Gaussian over the combined hard-body cross-section in the encounter plane:

$$P_c \approx \frac{1}{2\pi\sigma^2} \iint_{A} \exp\!\left(-\frac{|\vec{r}-\vec{r}_0|^2}{2\sigma^2}\right) dx\, dy$$

Where:
- $\sigma = 200\ \text{m}$ — **assumed isotropic positional uncertainty** (no object-specific covariance matrix)
- $A$ = combined hard-body cross-section (disk of radius $r_{HBR} = 5\ \text{m}$)
- $\vec{r}_0 = (d, 0)$ — miss vector in the encounter plane

**Limitations of this estimate:**
- No object-specific covariance matrix (CDM format would provide this)
- Does not fully project covariance geometry into the encounter plane
- Relative velocity is not used to construct covariance geometry

The integral is evaluated numerically via `scipy.integrate.dblquad`. Authoritative maneuver decisions require CDM-quality covariance data and review by a qualified flight-dynamics team.

**Risk thresholds:**

| Tier | $P_c$ Range | Operator Action |
|---|---|---|
| 🔴 **CRITICAL** | $P_c \geq 1 \times 10^{-4}$ | Immediate maneuver planning required |
| 🟠 **HIGH** | $1 \times 10^{-5} \leq P_c < 1 \times 10^{-4}$ | Active monitoring, maneuver on standby |
| 🟡 **ELEVATED** | $1 \times 10^{-6} \leq P_c < 1 \times 10^{-5}$ | Increased watch cadence |
| 🟢 **MONITOR** | $P_c < 1 \times 10^{-6}$ | Routine tracking |

### $O(n^2)$ Mitigation — Spatiotemporal KD-Tree

With thousands of active LEO objects, a naïve pairwise check would require millions of SGP4 calls per scan. The spatiotemporal prefilter builds `scipy.spatial.KDTree` instances at coarse epochs, eliminating pairs that never pass within 100 km across the 24-hour window. Only surviving candidate pairs proceed to full 60-second TCA bisection.

---

## 🌐 Space-Track.org Data Ingestion

OrbitSafe AI migrated from the CelesTrak public mirror to **Space-Track.org** — the authoritative USSF/18th Space Defense Squadron GP catalog — for improved data timeliness, granular server-side filtering, and reliable rate limit management.

### Authentication

Space-Track uses session-cookie authentication. A critical implementation detail: **the login endpoint always returns HTTP 200 regardless of whether credentials are valid.** OrbitSafe AI verifies authentication by issuing a follow-up `GET /app/data/whoami` after every login POST, checking the `logged_in` field in the JSON response.

```
POST /ajaxauth/login          →  {"identity": "...", "password": "..."}
GET  /app/data/whoami         →  {"logged_in": true, "identity": "user@example.com"}
```

### GP Query

```
GET /basicspacedata/query/class/gp
    /decay_date/null-val
    /CREATION_DATE/%3Enow-0.042
    /format/json
```

- `decay_date/null-val` — excludes re-entered/decayed objects
- `CREATION_DATE/>now-0.042` — only element sets uploaded in the last ~60 minutes (0.042 days), matching Space-Track's GP update cadence

### Caching & Resilience

| Mechanism | Detail |
|---|---|
| **In-memory cache** | 3-hour TTL; stale data returned on transient fetch failure |
| **Local disk fallback** | `data/gp_fallback.json` auto-written on every successful fetch |
| **Source control** | `GP_SOURCE` env var: `auto` (Space-Track → local) \| `space-track` \| `local` |
| **Rate limit handling** | HTTP 429 / 401 responses are caught; session re-auth attempted once before fallback |
| **Health endpoint** | `GET /api/gp-source` exposes active source, cache age, and record count |

---

## 🤖 AI Approach

### LangChain Message Chain

**LangChain + ChatOpenAI** powers the `/api/triage` endpoint. The LLM is OpenAI-API-compatible and configurable to target OpenAI GPT models, **IBM Granite/watsonx**, Gemini, or any compliant endpoint via environment variables.

**Message construction:**

1. A **`SystemMessage`** establishes the LLM as an expert Space Operations AI with strict accuracy constraints: it must acknowledge the Pc is a screening estimate, must not describe the event as a guaranteed collision, must use advisory language for maneuver candidates, and must always include the mandatory disclaimer. The LLM explains and contextualises the orbital mechanics metrics — **it does NOT calculate or invent collision probability**.
2. A **`HumanMessage`** passes the full conjunction payload — satellite name, NORAD ID, miss distance, relative velocity, screening Pc with its assumed σ, and pre-computed risk tier.

### Structured Output Schema

The LLM is instructed to produce a **4-section structured Markdown response** rendered in the triage drawer via `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex`:

---

**Section 1 — Risk Assessment**

Evaluates $P_c$ against operational thresholds:

- **CRITICAL** if $P_c \geq 1 \times 10^{-4}$: immediate maneuver planning required
- **HIGH** if $1 \times 10^{-5} \leq P_c < 1 \times 10^{-4}$: maneuver on standby
- **ELEVATED** if $1 \times 10^{-6} \leq P_c < 1 \times 10^{-5}$: increased watch cadence

All $P_c$ values and thresholds are rendered as LaTeX inline math (e.g. `$P_c = 4.29 \times 10^{-5}$`).

---

**Section 2 — Physical Context**

Covers orbital geometry and measurement uncertainties:

- Relative velocity ($\text{km/s}$) and its implication for encounter duration and $P_c$ sensitivity
- Whether the encounter is a coplanar near-co-circular geometry (trailing-edge) vs. a crossing geometry
- How tracking uncertainty ($\sigma = 200\ \text{m}$ isotropic) scales the risk at the reported miss distance
- Extended conjunction volume dwell time when relative velocity is near-zero

---

**Section 3 — Candidate Maneuver Options**

Specifies candidate burn vectors for flight-dynamics review, assuming a standard LEO hydrazine thruster (~1 N):

- **Burn direction**: Prograde or retrograde along-track (altitude change shifts the orbital period, moving the satellite out of the conjunction geometry)
- **$\Delta V$ estimate**: Typically $0.05\ \text{m/s}$ to $0.1\ \text{m/s}$ for LEO conjunctions — expressed as $\Delta V \approx 0.05\text{--}0.1\ \text{m/s}$
- **Thruster duration**: Derived from $\Delta V = F \cdot t / m$ (e.g. a 1 N thruster on a 500 kg satellite requires $\sim 25\text{--}50\ \text{s}$ for this $\Delta V$ range)
- **Miss distance achieved**: Projected miss distance after maneuver execution

---

**Section 4 — Recommended Next Steps**

Operational milestones keyed to TCA:

| Milestone | Action |
|---|---|
| $T - 12\ \text{h}$ | Conjunction confirmed; notify flight dynamics team; begin covariance updates |
| $T - 8\ \text{h}$ | Go/No-Go decision point for maneuver; upload burn parameters to spacecraft |
| $T - 4\ \text{h}$ | Burn execution window opens; final tracking data ingested |
| $T - 2\ \text{h}$ | Maneuver complete; post-burn orbit determination; re-evaluate $P_c$ |

---

**Mathematical Formatting Convention**

All equations, $P_c$ values, unit expressions, and delta-V estimates in the LLM response use LaTeX inline math notation:

- Probabilities: `$P_c = 2.34 \times 10^{-4}$`
- Velocities: `$\Delta V \approx 0.05\ \text{m/s}$`, `$0.001\ \text{km/s}$`
- Thresholds: `$1 \times 10^{-4}$`, `$1 \times 10^{-5}$`
- Times: `$T - 12\ \text{h}$`

The frontend renders these using KaTeX (via `rehype-katex`) with dark-theme colour overrides applied through the `.triage-prose` CSS scope.

---

**Mandatory Advisory Disclaimer**

Every AI triage response includes a mandatory disclaimer:

> *⚠ AI recommendations are advisory only. Authoritative maneuver decisions require object-specific covariance/CDM data and review by a qualified flight-dynamics team.*

This advisory appears both as a hardcoded footer in `TriageDrawer.tsx` and as a constraint in the LLM system prompt.

**AI role boundary:** The AI assistant explains the orbital mechanics, contextualises the risk metrics, and suggests candidate maneuvers for specialist review. The deterministic orbital calculations (SGP4, TCA, Pc) are computed by the Python astrodynamics engine — the LLM does not compute or invent collision probability.

---

### Rendered Triage Output

The `TriageDrawer` component renders the full structured response with:

- **`react-markdown`** — parses the markdown AST from the LLM string
- **`remark-gfm`** — GitHub Flavored Markdown: `**bold**`, bullet lists, numbered lists, tables
- **`remark-math`** — parses `$inline$` and `$$display$$` LaTeX math expressions
- **`rehype-katex`** — renders parsed math nodes to typeset HTML via KaTeX
- **Custom component overrides** — dark-theme Tailwind classes applied to every rendered element (`p`, `strong`, `ul`, `ol`, `h1`–`h3`, `code`, `blockquote`, `hr`)

---

## 🗄️ Data Persistence

Every completed orbital scan is automatically persisted to a local **SQLite database** (`backend/data/orbitsafe.db`), initialised at server startup via the FastAPI lifespan handler.

### Schema (v2)

```sql
CREATE TABLE scans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scanned_at  TEXT    NOT NULL,   -- ISO-8601 UTC
    event_count INTEGER NOT NULL
);

CREATE TABLE conjunction_events (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id               INTEGER NOT NULL REFERENCES scans(id),
    norad_id              INTEGER NOT NULL,
    sat_name              TEXT    NOT NULL,
    secondary_norad_id    INTEGER NOT NULL,
    secondary_name        TEXT    NOT NULL,
    tca_iso               TEXT    NOT NULL,
    miss_distance_km      REAL    NOT NULL,
    relative_velocity_kms REAL    NOT NULL,
    pc_value              REAL    NOT NULL,
    -- v2 position fields (added via idempotent migration)
    primary_lat           REAL,    -- geodetic lat at TCA (GMST-corrected)
    primary_lon           REAL,    -- geodetic lon at TCA (GMST-corrected)
    primary_alt_km        REAL,    -- altitude above mean sphere at TCA
    secondary_lat         REAL,
    secondary_lon         REAL,
    secondary_alt_km      REAL,
    position_source       TEXT     -- "tca" | "legacy-fallback"
);
```

Indexed on `scan_id` and `pc_value DESC`. `init_db()` applies schema v2 columns idempotently on every startup via `ALTER TABLE … ADD COLUMN` (with `OperationalError` catch for pre-existing columns). Existing databases migrate without data loss; legacy rows receive `position_source = 'legacy-fallback'`.

### Scan History UI

The **History** button in the dashboard header opens the `ScanHistoryDrawer`:

- **List view** — all past scans (newest first) showing scan ID, UTC timestamp, and event count
- **Detail view** — click any scan to see its full conjunction event list, sorted by descending $P_c$
- **Load into Dashboard** — replaces the live event table and globe with a historical scan; TCA positions are loaded from the stored coordinates
- **Legacy disclosure** — events with `position_source = "legacy-fallback"` (pre-v2 scans) display a visible warning rather than silently showing incorrect globe positions

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Orbital mechanics** | Python `sgp4` (Vallado), `numpy`, `scipy` |
| **Spatial indexing** | `scipy.spatial.KDTree` |
| **Data source** | Space-Track.org REST API (authenticated GP/OMM) |
| **Data persistence** | SQLite (stdlib `sqlite3`) |
| **Backend framework** | FastAPI (async, Pydantic v2) |
| **AI orchestration** | LangChain `langchain-openai`, `langchain-core` |
| **Frontend framework** | Next.js 14 (App Router) |
| **UI styling** | Tailwind CSS |
| **3-D visualization** | Three.js |
| **Markdown rendering** | `react-markdown` + `remark-gfm` |
| **Math typesetting** | `remark-math` + `rehype-katex` (KaTeX) |
| **Type safety** | TypeScript |
| **Primary dev tool** | **IBM Bob** |

---

## 📁 Project Structure

```
space-exploration-challenge/
├── backend/
│   ├── app.py                      # FastAPI server — all endpoints
│   ├── requirements.txt
│   ├── .env.example
│   ├── data/
│   │   ├── gp_fallback.json        # Auto-maintained GP offline fallback
│   │   └── orbitsafe.db            # SQLite scan history (auto-created)
│   └── services/
│       ├── __init__.py
│       ├── space_track.py          # Space-Track.org auth + GP fetch client
│       ├── orbital_math.py         # SGP4 engine, stratified sample, spatiotemporal
│       │                           # prefilter, TCA bisection, GMST conversion, Pc
│       └── db.py                   # SQLite persistence (init, save, query)
│
└── frontend/
    ├── package.json
    ├── next.config.js
    ├── tailwind.config.js
    ├── tsconfig.json
    └── src/
        ├── app/
        │   ├── layout.tsx           # Root layout — KaTeX CSS injection
        │   ├── page.tsx             # Main dashboard page
        │   └── globals.css          # Global styles + KaTeX dark-theme overrides
        ├── components/
        │   ├── GlobeView.tsx        # Three.js 3-D Earth globe (SSR-safe)
        │   ├── ConjunctionTable.tsx # Sortable/searchable/filterable event table
        │   ├── TriageDrawer.tsx     # AI triage drawer (ReactMarkdown + KaTeX)
        │   └── ScanHistoryDrawer.tsx# Historical scan browser + load-into-dash
        └── lib/
            ├── types.ts             # Shared TypeScript interfaces
            └── api.ts               # Typed fetch client for all endpoints
```

---

## 🚀 Quick Start (Windows PowerShell)

### Prerequisites

- Python 3.11+
- Node.js 20+
- A [Space-Track.org](https://www.space-track.org/auth/createAccount) account (free registration)
- An OpenAI-compatible API key (OpenAI, IBM watsonx, Gemini, etc.)

### 1. Backend Setup

```powershell
cd backend

# Create and activate Python virtual environment
python -m venv venv
.\venv\Scripts\Activate.ps1

# Install dependencies
pip install --upgrade pip
pip install -r requirements.txt

# Configure environment
Copy-Item .env.example .env
# Edit .env — set OPENAI_API_KEY, OPENAI_BASE_URL, LLM_MODEL,
#              SPACE_TRACK_USERNAME, SPACE_TRACK_PASSWORD

# Start the FastAPI server
uvicorn app:app --reload --host 0.0.0.0 --port 8000
```

API: `http://localhost:8000` · Interactive docs: `http://localhost:8000/docs`

### 2. Frontend Setup

```powershell
cd frontend

# Install dependencies
npm install

# Configure environment
Copy-Item .env.local.example .env.local
# Edit .env.local if backend runs on a non-default URL

# Start development server
npm run dev
```

Open `http://localhost:3000`.

### 3. Run a Scan

Click **"Refresh Scan"** in the dashboard header, or call the API directly:

```bash
curl "http://localhost:8000/api/scan_conjunctions?max_objects=400"
```

### 4. AI Triage

Click any row in the conjunction table (or the **Triage** button) to open the AI drawer. The backend calls the LLM and returns a structured Markdown + LaTeX advisory. The LLM explains and contextualises the orbital mechanics metrics — it does not calculate or invent collision probability. All maneuver recommendations are advisory only and require flight-dynamics review.

### 5. View Scan History

Click **"History"** in the dashboard header to browse all past scans. Select any scan to inspect its event list or load it into the main dashboard for comparison.

---

## 🔧 API Reference

### `GET /api/scan_conjunctions`

Triggers a full orbital scan. Fetches GP data from Space-Track.org, propagates the LEO band via SGP4, applies stratified altitude sampling, runs the spatiotemporal prefilter over 24 h at 5-min intervals, computes TCA and Screening Pc for each candidate pair, and persists results to SQLite.

**Query Parameters:**
- `max_objects` *(int, default 400)* — LEO objects to process after altitude filtering

**Response:**
```json
{
  "scan_id": 7,
  "count": 12,
  "events": [
    {
      "norad_id": 25544,
      "sat_name": "ISS (ZARYA)",
      "secondary_norad_id": 44238,
      "secondary_name": "COSMOS 2251 DEB",
      "tca_iso": "2026-08-15T14:23:07Z",
      "miss_distance_km": 0.842,
      "relative_velocity_kms": 13.7,
      "pc_value": 2.34e-4,
      "primary_lat": 51.45,
      "primary_lon": -20.38,
      "primary_alt_km": 408.2,
      "secondary_lat": 51.45,
      "secondary_lon": -20.38,
      "secondary_alt_km": 408.6,
      "pc_assumed_sigma_m": 200.0,
      "pc_hard_body_radius_m": 5.0,
      "pc_method": "screening-isotropic-gaussian"
    }
  ]
}
```

---

### `POST /api/triage`

AI-powered evasive maneuver recommendation.

**Request Body:**
```json
{
  "sat_name": "ISS (ZARYA)",
  "norad_id": 25544,
  "miss_distance_km": 0.842,
  "relative_velocity_kms": 13.7,
  "pc_value": 2.34e-4
}
```

**Response:**
```json
{
  "norad_id": 25544,
  "sat_name": "ISS (ZARYA)",
  "risk_tier": "CRITICAL (Pc ≥ 1×10⁻⁴)",
  "pc_value": 2.34e-4,
  "pc_method": "screening-isotropic-gaussian",
  "pc_assumed_sigma_m": 200.0,
  "advisory": "AI recommendations are advisory only. All maneuver decisions require object-specific covariance/CDM data and review by a qualified flight-dynamics team.",
  "summary": "**1. Risk Assessment**\n\n* **Status:** CRITICAL (screening Pc)...\n\n**3. Candidate Maneuver Options**\n\n* $\\Delta V \\approx 0.05\\ \\text{m/s}$ prograde burn (for FD review)..."
}
```

---

### `GET /api/history`

Returns the most recent scan summaries, newest first.

**Query Parameters:**
- `limit` *(int, default 20)* — maximum number of scans to return

**Response:**
```json
{
  "scans": [
    { "id": 7, "scanned_at": "2026-08-15T14:00:00Z", "event_count": 12 },
    { "id": 6, "scanned_at": "2026-08-15T11:00:00Z", "event_count": 9 }
  ]
}
```

---

### `GET /api/history/{scan_id}`

Returns the full conjunction event list for a historical scan, sorted by descending $P_c$.

**Response:**
```json
{
  "scan_id": 7,
  "count": 12,
  "events": [ ... ]
}
```

---

### `GET /api/gp-source`

Returns active data source status and cache metadata.

**Response:**
```json
{
  "configured_source": "auto",
  "active_source": "space-track",
  "cache": {
    "age_seconds": 1823,
    "record_count": 4217,
    "last_fetch_source": "space-track",
    "last_fetch_ts": 1731678000.0
  }
}
```

---

### `GET /healthz`

Liveness probe. Returns `{"status": "ok"}`.

---

## 🔑 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | API key for LLM triage endpoint |
| `OPENAI_BASE_URL` | ✅ | Base URL for OpenAI-compatible endpoint (OpenAI, IBM watsonx, Gemini, etc.) |
| `LLM_MODEL` | ✅ | Model identifier (e.g. `gpt-4o-mini`, `ibm/granite-3-8b-instruct`) |
| `SPACE_TRACK_USERNAME` | ✅ | Space-Track.org registered email |
| `SPACE_TRACK_PASSWORD` | ✅ | Space-Track.org password |
| `GP_SOURCE` | ➖ | `auto` (default) \| `space-track` \| `local` — CelesTrak is no longer supported |

---

## 🤝 IBM Bob: Primary Development Tool

**IBM Bob was the primary development tool used to build every component of OrbitSafe AI**, serving as Lead Full-Stack AI Engineer and Astrodynamicist throughout the project.

### Code Generation
- **`services/orbital_math.py`** — Bob generated the complete SGP4 propagation pipeline, TCA bisection search, LEO altitude filter, KD-Tree spatial pre-filter, and Alfano $P_c$ 2-D Gaussian integration from the physics specification in `NOTES.md`.
- **`services/space_track.py`** — Bob designed the Space-Track.org authenticated REST client, including the `whoami`-based login verification pattern (HTTP 200 is always returned on login regardless of credential validity) and the session re-auth retry on 401.
- **`services/db.py`** — Bob designed the SQLite persistence layer with `scans` and `conjunction_events` tables, `save_scan()`, `get_scan_history()`, and `get_scan_events()`, integrated into the FastAPI lifespan handler.
- **`app.py`** — Bob designed the FastAPI architecture with async endpoints, Pydantic v2 validation schemas, CORS middleware, LangChain message chain construction (structured 4-section system prompt), LLM risk-tier classification logic, and the history endpoints.
- **`GlobeView.tsx`** — Bob architected the Three.js scene: star field, NASA Blue Marble textured Earth, Fresnel atmosphere shader, cloud layer, `THREE.InstancedMesh` per-tier persistent midpoint markers for all conjunction events, context arc lines (limited subset), mouse-drag rotation, and auto-spin loop — as a fully SSR-safe dynamic import.
- **`ConjunctionTable.tsx`** — Bob built the interactive table with real-time NORAD/name search, multi-tier filter pills, sortable $P_c$ column with `useMemo` derivation, risk-colour row banding, and a `pulse-critical` CSS animation for the highest-risk rows.
- **`TriageDrawer.tsx`** — Bob designed the slide-in drawer with the structured metrics grid, async triage fetch lifecycle (loading/error/result states), retry logic, risk-tiered colour/glow theming, and the `ReactMarkdown` + KaTeX rendering pipeline.
- **`ScanHistoryDrawer.tsx`** — Bob built the two-level history panel (list → detail → load into dashboard) with animated slide-in transitions matching the triage drawer.
- **`page.tsx`** — Bob assembled the full responsive dashboard: sticky header with History + Refresh Scan buttons, per-tier stat cards, two-column Globe/Table grid with responsive breakpoints, scan error banner, and footer.

### Architecture & Debugging
- Bob identified that Space-Track's login endpoint always returns HTTP 200, leading to the `whoami`-verification pattern that correctly detects invalid credentials.
- Bob designed the architectural migration from CelesTrak to Space-Track including the `_resolve_source_order()` source priority chain, stale-while-revalidate in-memory cache, and automatic disk fallback writes.
- Bob caught that Three.js `Mesh` objects added directly to `scene` would not rotate with the drag group, refactoring all children into a `THREE.Group` before the animation loop.
- Bob solved the Next.js SSR/Three.js incompatibility with `dynamic(() => import(...), { ssr: false })` for `GlobeView`.
- Bob identified the `sgp4init` epoch and mean-motion parameter requirements that prevent silent propagation failures in the WGS72 model.

### UI & Markdown Rendering
- Bob selected the `space-950/900/800` dark colour palette, designed the risk-tier badge/glow system, created the `pulse-critical` keyframe animation, and authored the complete Tailwind configuration including custom `space` colour tokens.
- Bob integrated the `react-markdown` + `remark-math` + `rehype-katex` pipeline for structured AI output, including the `.triage-prose` CSS scope and KaTeX dark-theme colour overrides in `globals.css`.

### Documentation
- Bob wrote this entire README, including the updated ASCII architecture diagram, the LaTeX $P_c$ formula and risk tier table, the Space-Track authentication section, the structured output schema with full $\Delta V$ equations and urgency timeline, and all API reference examples.

---

## 📐 Mathematical Appendix

### SGP4 Equations of Motion (simplified)

$$\ddot{\vec{r}} = -\frac{\mu}{r^3}\vec{r} + \vec{a}_{J_2} + \vec{a}_{drag} + \vec{a}_{lunar/solar}$$

Where $\vec{a}_{J_2}$ is the dominant zonal harmonic perturbation due to Earth's equatorial bulge.

### $P_c$ Closed-Form Approximation (Patera 2001)

For small hard-body radius relative to covariance ($r_{HBR} \ll \sigma$):

$$P_c \approx \frac{r_{HBR}^2}{2\sigma^2} \exp\!\left(-\frac{d^2}{2\sigma^2}\right)$$

Where $d$ is the miss distance and $\sigma$ is the 1-$\sigma$ combined positional uncertainty. OrbitSafe AI evaluates the **exact double integral** via `scipy.integrate.dblquad` for maximum accuracy.

### Delta-V for Along-Track Maneuver

For a prograde/retrograde burn changing the semi-major axis by $\delta a$:

$$\Delta V \approx \frac{1}{2} \sqrt{\frac{\mu}{a}} \cdot \frac{\delta a}{a}$$

For LEO ($a \approx 6771\ \text{km}$, $\mu = 398600\ \text{km}^3/\text{s}^2$), a $\Delta V = 0.05\ \text{m/s}$ produces $\delta a \approx 85\ \text{m}$, shifting the satellite's along-track position by several kilometres within one orbit — sufficient to break a near-co-circular conjunction geometry.

---

## ⚠️ Limitations & Scientific Caveats

- **Screening Pc only** — OrbitSafe AI computes a Screening Pc using an assumed isotropic $\sigma = 200\ \text{m}$. This is NOT a CDM-quality operational probability. Authoritative maneuver decisions require object-specific covariance matrices (CDM/CSM format), full encounter plane projection, and review by a qualified flight-dynamics team.
- **Globe markers are per-TCA midpoints, not a simultaneous snapshot** — Each persistent globe marker represents the geographic midpoint of one conjunction event evaluated at that event's own TCA. Different events have different TCAs; the globe is a multi-epoch composite used for situational awareness only. It is NOT a simultaneous orbital snapshot.
- **Globe auto-spin is cosmetic** — The globe rotation in the dashboard is a display effect only. It does NOT represent the passage of orbital time or the motion of satellites toward TCA.
- **Encounter inset is not to scale** — The magnified encounter inset shows primary and secondary at a readable fixed separation for labelling purposes. The actual separation at Earth scale is sub-pixel; the inset is explicitly labelled "Encounter geometry magnified — not to scale".
- **Random catalog dots removed** — The globe no longer displays random decorative satellite dots. Any future background catalog layer must be driven by real object positions with clearly defined epochs.
- **Context arc lines limited** — Only the top-priority events (CRITICAL → HIGH → ELEVATED → top MONITOR, up to 60 total) receive decorative context arc lines. These lines are NOT propagated satellite trajectories. All events receive persistent midpoint markers regardless of line budget.
- **GMST approximation** — Longitude conversion uses the simplified IAU 1982 GMST formula (~0.1° accuracy). A full IAU 2000/2006 implementation would improve geographic precision.
- **Catalog coverage** — Stratified sampling of up to 500 LEO objects is used for demo runtime. Production deployment would require `asyncio` + `ProcessPoolExecutor` for the full ~27,000+ object catalog.
- **Maneuver recommendations are advisory** — The LLM suggests candidate maneuver vectors; it does not calculate or invent collision probability. Actual burn execution requires integration with flight dynamics software (GMAT, Orekit) and authorised execution by flight-dynamics personnel.
- **Fragmentation modelling** — Does not model breakup events or cascading debris (Kessler syndrome).

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

*IBM AI Builders Challenge with IBM Bob · August 2026 · Advance Space Exploration with AI*
*Primary development tool: **IBM Bob***
