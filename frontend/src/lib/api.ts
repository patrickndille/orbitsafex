// lib/api.ts – typed API client

import type {
  ScanResponse,
  TriageRequest,
  TriageResponse,
  HistoryListResponse,
  HistoryScanResponse,
} from "./types";

const BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export async function fetchConjunctions(
  maxObjects = 400,
  timeoutMs = 360_000  // 6 minutes — scan takes ~35 s with 5-min coarse step
): Promise<ScanResponse> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Orbital scan timed out after ${timeoutMs / 1000}s. The backend may still be running; try Refresh Scan.`)),
    timeoutMs
  );
  try {
    const res = await fetch(
      `${BASE}/api/scan_conjunctions?max_objects=${maxObjects}`,
      { cache: "no-store", signal: controller.signal }
    );
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`scan_conjunctions failed [${res.status}]: ${detail}`);
    }
    return res.json() as Promise<ScanResponse>;
  } catch (err) {
    // Re-wrap AbortError so the message is operator-readable
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        controller.signal.reason instanceof Error
          ? controller.signal.reason.message
          : `Orbital scan timed out after ${timeoutMs / 1000}s. The backend may still be running; try Refresh Scan.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

export async function fetchHistory(limit = 20): Promise<HistoryListResponse> {
  const res = await fetch(`${BASE}/api/history?limit=${limit}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`history failed [${res.status}]: ${detail}`);
  }
  return res.json() as Promise<HistoryListResponse>;
}

export async function fetchHistoricalScan(
  scanId: number
): Promise<HistoryScanResponse> {
  const res = await fetch(`${BASE}/api/history/${scanId}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`history/${scanId} failed [${res.status}]: ${detail}`);
  }
  return res.json() as Promise<HistoryScanResponse>;
}
