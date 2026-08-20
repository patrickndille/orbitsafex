"""
app.py – OrbitSafe AI  FastAPI backend
═══════════════════════════════════════════════════════════════════════════════
Endpoints
  GET  /api/scan_conjunctions   →  run orbital scan, return risk list
  POST /api/triage              →  LLM evasive-maneuver recommendation
  GET  /healthz                 →  liveness probe
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


@app.get("/api/scan_conjunctions", tags=["orbital"])
async def scan_conjunctions(max_objects: int = 400):
    """
    Trigger a full orbital scan.

    Fetches TLE data from CelesTrak (TTLCache 15 min), runs SGP4
    forward-propagation on KD-Tree pre-filtered pairs, and returns a
    list of conjunction events sorted by descending Pc.
    """
    try:
        from services.orbital_math import run_conjunction_scan
        events = run_conjunction_scan(max_objects=max_objects)
        return {"count": len(events), "events": events}
    except Exception as exc:
        logger.exception("Conjunction scan failed.")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/triage", tags=["ai"])
async def triage_conjunction(data: ConjunctionData):
    """
    AI-powered triage for a specific conjunction event.

    Accepts conjunction metrics and returns a natural-language
    risk assessment and evasive maneuver recommendation from the LLM.
    """
    risk_tier = (
        "CRITICAL (immediate action required)"
        if data.pc_value >= 1e-4
        else "HIGH" if data.pc_value >= 1e-5
        else "ELEVATED" if data.pc_value >= 1e-6
        else "MONITOR"
    )

    messages = [
        SystemMessage(
            content=(
                "You are an expert Space Operations AI specialising in satellite "
                "conjunction triage and orbital mechanics. Your role is to give "
                "mission operators concise, actionable recommendations based on "
                "Probability of Collision (Pc), miss distance, and relative velocity. "
                "Structure your response with: (1) Risk Assessment, (2) Physical "
                "Context, (3) Recommended Evasive Maneuver, (4) Urgency Timeline."
            )
        ),
        HumanMessage(
            content=(
                f"Triage request for conjunction event:\n"
                f"  Primary Satellite : {data.sat_name} (NORAD #{data.norad_id})\n"
                f"  Miss Distance     : {data.miss_distance_km:.3f} km\n"
                f"  Relative Velocity : {data.relative_velocity_kms:.3f} km/s\n"
                f"  Probability of Collision (Pc): {data.pc_value:.3e}\n"
                f"  Risk Tier         : {risk_tier}\n\n"
                "Provide a concise operational summary and recommended evasive "
                "maneuver burn direction and delta-V estimate. Assume a standard "
                "LEO spacecraft with a ~1 N hydrazine thruster."
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
            "summary": response.content,
        }
    except Exception as exc:
        logger.exception("LLM triage call failed.")
        raise HTTPException(status_code=500, detail=f"LLM error: {exc}") from exc
