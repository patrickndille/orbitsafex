// lib/api.ts – typed API client

import type { ScanResponse, TriageRequest, TriageResponse } from "./types";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function fetchConjunctions(
  maxObjects = 400
): Promise<ScanResponse> {
  const res = await fetch(
    `${BASE}/api/scan_conjunctions?max_objects=${maxObjects}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`scan_conjunctions failed [${res.status}]: ${detail}`);
  }
  return res.json() as Promise<ScanResponse>;
}

export async function requestTriage(
  payload: TriageRequest
): Promise<TriageResponse> {
  const res = await fetch(`${BASE}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`triage failed [${res.status}]: ${detail}`);
  }
  return res.json() as Promise<TriageResponse>;
}
