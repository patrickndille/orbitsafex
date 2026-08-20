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
| **$P_c$ Engine** | Computes the Probability of Collision by integrating a bivariate Gaussian over the combined hard-body cross-section in the encounter plane (Alfano 2-D method) |
| **KD-Tree Pre-filter** | Limits $O(n^2)$ brute-force checking to an $O(n \log n)$ spatial query — only pairs within 100 km in ECI coordinates proceed to full SGP4 analysis |
| **SQLite Persistence** | Every completed scan is stored in a local SQLite database (`orbitsafe.db`), enabling full historical scan review without data loss |
| **FastAPI Backend** | Exposes async REST endpoints for scanning, AI triage, and scan history retrieval |
| **LangChain + LLM** | Routes conjunction metrics to a ChatOpenAI-compatible model to generate structured, rendered Markdown + LaTeX evasive maneuver recommendations |
| **Next.js Dashboard** | Renders a responsive operator UI with a live 3-D Earth globe, a searchable/filterable conjunction table, a slide-in AI triage drawer, and a scan history panel |

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
        │  ① Space-Track fetch   │  │  SystemMessage (expert   │
        │  ② LEO altitude filter │  │    ops assistant)        │
        │  ③ KD-Tree pre-filter  │  │  HumanMessage (metrics)  │
        │  ④ SGP4 propagation    │  │  → structured Markdown + │
        │  ⑤ TCA bisection       │  │    LaTeX recommendation  │
        │  ⑥ Pc 2-D integration  │  └─────────────────────────┘
        └──────┬─────────────────┘
               │
        ┌──────▼──────────────────────────────────────────────┐
        │            services/db.py  (SQLite)                  │
        │  scans(id, scanned_at, event_count)                  │
        │  conjunction_events(scan_id, norad_id, pc_value, …)  │
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

**LEO band filter:** After propagating the full catalog, OrbitSafe AI retains only objects in the **300–1,200 km altitude band** — the shell of highest conjunction density — before applying the spatial pre-filter. Objects are sorted by altitude so the KD-Tree receives spatially coherent input.

### Probability of Collision ($P_c$) — Alfano 2-D Method

The $P_c$ calculation projects the combined positional covariance of both objects onto the **2-D encounter plane** perpendicular to the relative velocity vector at TCA. Within this plane, the probability distribution of the miss vector is a bivariate Gaussian:

$$P_c = \frac{1}{2\pi\sqrt{|C|}} \iint_{A} \exp\!\left(-\frac{1}{2}\,\vec{r}^{\,T} C^{-1} \vec{r}\right) dx\, dy$$

Where:
- $C$ = 2×2 combined covariance matrix in the encounter plane (isotropic $\sigma = 200\ \text{m}$ per object)
- $A$ = combined hard-body cross-section (disk of radius $r_{HBR} = 5\ \text{m}$ for LEO spacecraft)
- $\vec{r}$ = displacement vector from the nominal miss point to the integration variable

The integral is evaluated numerically using `scipy.integrate.dblquad` over the hard-body disk.

**Risk thresholds:**

| Tier | $P_c$ Range | Operator Action |
|---|---|---|
| 🔴 **CRITICAL** | $P_c \geq 1 \times 10^{-4}$ | Immediate maneuver planning required |
| 🟠 **HIGH** | $1 \times 10^{-5} \leq P_c < 1 \times 10^{-4}$ | Active monitoring, maneuver on standby |
| 🟡 **ELEVATED** | $1 \times 10^{-6} \leq P_c < 1 \times 10^{-5}$ | Increased watch cadence |
| 🟢 **MONITOR** | $P_c < 1 \times 10^{-6}$ | Routine tracking |

### $O(n^2)$ Mitigation — KD-Tree Spatial Index

With thousands of active LEO objects, a naïve pairwise check would require millions of SGP4 calls per scan. OrbitSafe AI builds a **`scipy.spatial.KDTree`** on 3-D ECI position vectors and queries for all pairs within 100 km. This reduces candidate pairs by roughly 99.9%, making real-time scans operationally feasible.

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

1. A **`SystemMessage`** establishes the LLM as an expert Space Operations AI specialising in conjunction triage and orbital mechanics, with instructions to structure the response in four numbered sections.
2. A **`HumanMessage`** passes the full conjunction payload — satellite name, NORAD ID, miss distance, relative velocity, $P_c$ value, and pre-computed risk tier — with an instruction to assume a standard LEO spacecraft with a ~1 N hydrazine thruster.

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

**Section 3 — Recommended Evasive Maneuver**

Specifies the burn vector and sizing for a standard LEO hydrazine thruster (~1 N):

- **Burn direction**: Prograde or retrograde along-track (altitude change shifts the orbital period, moving the satellite out of the conjunction geometry)
- **$\Delta V$ estimate**: Typically $0.05\ \text{m/s}$ to $0.1\ \text{m/s}$ for LEO conjunctions — expressed as $\Delta V \approx 0.05\text{--}0.1\ \text{m/s}$
- **Thruster duration**: Derived from $\Delta V = F \cdot t / m$ (e.g. a 1 N thruster on a 500 kg satellite requires $\sim 25\text{--}50\ \text{s}$ for this $\Delta V$ range)
- **Miss distance achieved**: Projected miss distance after maneuver execution

---

**Section 4 — Urgency Timeline**

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

Every AI triage response displayed in the drawer is followed by the fixed footer:

> *AI recommendations are advisory only. All maneuvers require flight-dynamics team authorisation.*

This disclaimer is hardcoded in `TriageDrawer.tsx` and is not part of the LLM output.

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

### Schema

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
    pc_value              REAL    NOT NULL
);
```

Indexed on `scan_id` and `pc_value DESC` for fast history retrieval sorted by risk.

### Scan History UI

The **History** button in the dashboard header opens the `ScanHistoryDrawer`:

- **List view** — all past scans (newest first) showing scan ID, UTC timestamp, and event count
- **Detail view** — click any scan to see its full conjunction event list, sorted by descending $P_c$
- **Load into Dashboard** — replaces the live event table and globe with a historical scan for comparison

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
│       ├── orbital_math.py         # SGP4 engine, KD-Tree, TCA bisection, Pc
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

Click any row in the conjunction table (or the **Triage** button) to open the AI drawer. The backend calls the LLM and streams back a structured Markdown + LaTeX evasive maneuver recommendation.

### 5. View Scan History

Click **"History"** in the dashboard header to browse all past scans. Select any scan to inspect its event list or load it into the main dashboard for comparison.

---

## 🔧 API Reference

### `GET /api/scan_conjunctions`

Triggers a full orbital scan. Fetches GP data from Space-Track.org, propagates the LEO band via SGP4, applies KD-Tree pre-filtering, computes $P_c$ for each candidate pair, and persists results to SQLite.

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
      "pc_value": 2.34e-4
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
  "risk_tier": "CRITICAL (immediate action required)",
  "pc_value": 2.34e-4,
  "summary": "**1. Risk Assessment**\n\n* **Status:** CRITICAL...\n\n**3. Recommended Evasive Maneuver**\n\n* $\\Delta V \\approx 0.05\\ \\text{m/s}$ prograde burn..."
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
| `OPENAI_BASE_URL` | ✅ | Base URL for OpenAI-compatible endpoint |
| `LLM_MODEL` | ✅ | Model identifier (e.g. `gpt-4o-mini`, `ibm/granite-3-8b-instruct`) |
| `SPACE_TRACK_USERNAME` | ✅ | Space-Track.org registered email |
| `SPACE_TRACK_PASSWORD` | ✅ | Space-Track.org password |
| `GP_SOURCE` | ➖ | `auto` (default) \| `space-track` \| `local` |

---

## 🤝 IBM Bob: Primary Development Tool

**IBM Bob was the primary development tool used to build every component of OrbitSafe AI**, serving as Lead Full-Stack AI Engineer and Astrodynamicist throughout the project.

### Code Generation
- **`services/orbital_math.py`** — Bob generated the complete SGP4 propagation pipeline, TCA bisection search, LEO altitude filter, KD-Tree spatial pre-filter, and Alfano $P_c$ 2-D Gaussian integration from the physics specification in `NOTES.md`.
- **`services/space_track.py`** — Bob designed the Space-Track.org authenticated REST client, including the `whoami`-based login verification pattern (HTTP 200 is always returned on login regardless of credential validity) and the session re-auth retry on 401.
- **`services/db.py`** — Bob designed the SQLite persistence layer with `scans` and `conjunction_events` tables, `save_scan()`, `get_scan_history()`, and `get_scan_events()`, integrated into the FastAPI lifespan handler.
- **`app.py`** — Bob designed the FastAPI architecture with async endpoints, Pydantic v2 validation schemas, CORS middleware, LangChain message chain construction (structured 4-section system prompt), LLM risk-tier classification logic, and the history endpoints.
- **`GlobeView.tsx`** — Bob architected the Three.js scene: star field, Earth sphere with continent patches, atmosphere shell, animated pulsing risk nodes, orbit arc lines, mouse-drag rotation, and auto-spin loop — as a fully SSR-safe dynamic import.
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

## ⚠️ Limitations & Future Work

- **Covariance data** — Full conjunction analysis requires object-specific covariance matrices (CDM/CSM format). OrbitSafe AI uses a uniform isotropic $\sigma = 200\ \text{m}$ as a conservative approximation.
- **Catalog size** — Demo is capped at 400 LEO objects for runtime feasibility. Production deployment would use `asyncio` + `ProcessPoolExecutor` for the full ~27,000 object catalog.
- **Maneuver planning** — Actual burn execution requires integration with flight dynamics software (GMAT, Orekit). The LLM output is advisory only.
- **Fragmentation modelling** — Does not currently model breakup events or cascading debris (Kessler syndrome modelling).
- **Real-time covariance updates** — Space-Track CDM (Conjunction Data Message) files provide object-specific covariance; ingesting these would significantly improve $P_c$ accuracy.

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

*IBM AI Builders Challenge with IBM Bob · August 2026 · Advance Space Exploration with AI*
*Primary development tool: **IBM Bob***
