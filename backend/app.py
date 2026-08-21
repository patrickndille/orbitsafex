"""
app.py – OrbitSafe AI  FastAPI backend
═══════════════════════════════════════════════════════════════════════════════
Endpoints
  GET  /api/scan_conjunctions      →  run orbital scan, return risk list
  POST /api/triage                 →  LLM evasive-maneuver recommendation
  GET  /api/history                →  list of past scan summaries
  GET  /api/history/{scan_id}      →  events for a specific historical scan
  GET  /healthz                    →  liveness probe
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

import time
from services.orbital_math import get_active_gp_source, get_gp_cache_info
from services.db import init_db, save_scan, get_scan_history, get_scan_events

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s – %(message)s",
)
logger = logging.getLogger("orbitsafe")

# ──────────────────────────────────────────────────────────────────────────────
# LLM client (OpenAI-compatible – works with IBM watsonx, Gemini, etc.)
# ──────────────────────────────────────────────────────────────────────────────
_api_key = os.environ.get("OPENAI_API_KEY", "")
_base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
_model = os.environ.get("LLM_MODEL", "gpt-4o-mini")

llm = ChatOpenAI(
    model=_model,
    api_key=_api_key,
    base_url=_base_url,
    temperature=0.4,
    timeout=120.0,
)

# ──────────────────────────────────────────────────────────────────────────────
# Application
# ──────────────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(application: FastAPI):
    logger.info("OrbitSafe AI backend starting up …")
    init_db()
    logger.info("SQLite database initialised.")
    yield
    logger.info("OrbitSafe AI backend shutting down.")


app = FastAPI(
    title="OrbitSafe AI API",
    description="Space debris conjunction analysis and AI-driven triage.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ──────────────────────────────────────────────────────────────────────────────
# Schema
# ──────────────────────────────────────────────────────────────────────────────
class ConjunctionData(BaseModel):
    sat_name: str = Field(..., description="Primary satellite name")
    norad_id: int = Field(..., description="Primary NORAD catalog ID")
    miss_distance_km: float = Field(..., gt=0, description="Miss distance at TCA (km)")
    relative_velocity_kms: float = Field(..., gt=0, description="Relative speed at TCA (km/s)")
    pc_value: float = Field(..., ge=0, le=1, description="Probability of Collision")


# ──────────────────────────────────────────────────────────────────────────────
# Endpoints
# ──────────────────────────────────────────────────────────────────────────────
@app.get("/healthz", tags=["ops"])
async def health():
    return {"status": "ok"}


@app.get("/api/gp-source", tags=["ops"])
async def gp_source():
    return {
        "configured_source": os.environ.get("GP_SOURCE", "auto"),
        "active_source": get_active_gp_source(),
        "cache": get_gp_cache_info(),
    }


@app.get("/api/scan_conjunctions", tags=["orbital"])
async def scan_conjunctions(max_objects: int = 400):
    """
    Trigger a full orbital scan.

    Fetches GP data from Space-Track.org (3-hour cache, local fallback),
    runs SGP4 forward-propagation on spatiotemporal-prefiltered LEO pairs,
    and returns a list of conjunction events sorted by descending Pc.

    scan_metadata is returned at the top level (not duplicated per event)
    and includes coverage statistics and explicit prefilter limitations.
    """
    try:
        from services.orbital_math import run_conjunction_scan
        events, scan_metadata = run_conjunction_scan(max_objects=max_objects)
        scan_id = save_scan(events)
        logger.info("Scan persisted as scan_id=%d (%d events).", scan_id, len(events))
        return {
            "scan_id":       scan_id,
            "count":         len(events),
            "events":        events,
            "scan_metadata": scan_metadata,
        }
    except Exception as exc:
        logger.exception("Conjunction scan failed.")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/history", tags=["history"])
async def list_scans(limit: int = 20):
    """Return the most recent scan summaries (newest first)."""
    try:
        return {"scans": get_scan_history(limit=limit)}
    except Exception as exc:
        logger.exception("Failed to retrieve scan history.")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/history/{scan_id}", tags=["history"])
async def get_historical_scan(scan_id: int):
    """Return all conjunction events for a historical scan."""
    try:
        events = get_scan_events(scan_id)
        if not events:
            raise HTTPException(status_code=404, detail=f"Scan {scan_id} not found or has no events.")
        return {"scan_id": scan_id, "count": len(events), "events": events}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to retrieve scan %d.", scan_id)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/triage", tags=["ai"])
async def triage_conjunction(data: ConjunctionData):
    """
    AI-powered triage for a specific conjunction event.

    Accepts conjunction metrics and returns a natural-language risk assessment.
    The LLM explains and contextualises the metrics; it does NOT calculate or
    invent collision probability.  All recommendations are advisory only and
    require flight-dynamics team authorisation before any maneuver is executed.
    """
    risk_tier = (
        "CRITICAL (Pc ≥ 1×10⁻⁴)"
        if data.pc_value >= 1e-4
        else "HIGH (Pc ≥ 1×10⁻⁵)" if data.pc_value >= 1e-5
        else "ELEVATED (Pc ≥ 1×10⁻⁶)" if data.pc_value >= 1e-6
        else "MONITOR (Pc < 1×10⁻⁶)"
    )

    messages = [
        SystemMessage(
            content=(
                "You are an expert Space Operations AI assistant specialising in "
                "satellite conjunction triage and orbital mechanics. "
                "\n\nCRITICAL CONSTRAINTS — you MUST follow these:\n"
                "1. The Probability of Collision (Pc) value you are given is a "
                "SCREENING ESTIMATE computed using assumed isotropic positional "
                "uncertainty (σ=200 m) and a simplified 2-D Gaussian integral. "
                "It is NOT a CDM-quality operational Pc. Do not present it as "
                "definitive or authoritative.\n"
                "2. Do NOT describe the event as a guaranteed collision. Use "
                "language such as 'predicted close approach', 'screening Pc', "
                "or 'probability of collision estimate'.\n"
                "3. Do NOT recommend executing a maneuver directly. Use language "
                "such as 'candidate maneuver for flight-dynamics review' or "
                "'recommended for assessment by qualified personnel'.\n"
                "4. Always include the mandatory advisory: "
                "'All maneuver decisions require object-specific covariance/CDM "
                "data and review by a qualified flight-dynamics team.'\n"
                "5. Structure your response with: (1) Risk Assessment, "
                "(2) Physical Context, (3) Candidate Maneuver Options, "
                "(4) Recommended Next Steps."
            )
        ),
        HumanMessage(
            content=(
                f"Triage request for predicted close approach (conjunction event):\n"
                f"  Primary Satellite          : {data.sat_name} (NORAD #{data.norad_id})\n"
                f"  Miss Distance at TCA       : {data.miss_distance_km:.3f} km\n"
                f"  Relative Velocity at TCA   : {data.relative_velocity_kms:.3f} km/s\n"
                f"  Screening Pc (est.)        : {data.pc_value:.3e}\n"
                f"    (assumed σ=200 m isotropic; not CDM-quality)\n"
                f"  Risk Tier                  : {risk_tier}\n\n"
                "Provide a concise operational summary and candidate evasive "
                "maneuver direction and delta-V estimate for flight-dynamics review. "
                "Assume a standard LEO spacecraft with a ~1 N hydrazine thruster. "
                "Remind the operator that authoritative maneuver decisions require "
                "object-specific covariance data and CDM analysis."
            )
        ),
    ]

    try:
        response = await llm.ainvoke(messages)
        return {
            "norad_id": data.norad_id,
            "sat_name": data.sat_name,
            "risk_tier": risk_tier,
            "pc_value": data.pc_value,
            "pc_method": "screening-isotropic-gaussian",
            "pc_assumed_sigma_m": 200.0,
            "advisory": (
                "AI recommendations are advisory only. All maneuver decisions "
                "require object-specific covariance/CDM data and review by a "
                "qualified flight-dynamics team."
            ),
            "summary": response.content,
        }
    except Exception as exc:
        logger.exception("LLM triage call failed.")
        raise HTTPException(status_code=500, detail=f"LLM error: {exc}") from exc
