// lib/types.ts  –  shared TypeScript interfaces

export interface ConjunctionEvent {
  norad_id: number;
  sat_name: string;
  secondary_norad_id: number;
  secondary_name: string;
  tca_iso: string;              // ISO-8601 UTC
  miss_distance_km: number;
  relative_velocity_kms: number;
  pc_value: number;             // Probability of Collision 0–1; 0 = MONITOR sentinel

  // Geographic positions at TCA (from ECI vectors) — used by GlobeView
  primary_lat?: number;
  primary_lon?: number;
  primary_alt_km?: number;
  secondary_lat?: number;
  secondary_lon?: number;
  secondary_alt_km?: number;
}

export interface ScanResponse {
  count: number;
  events: ConjunctionEvent[];
}

export interface TriageRequest {
  sat_name: string;
  norad_id: number;
  miss_distance_km: number;
  relative_velocity_kms: number;
  pc_value: number;
}

export interface TriageResponse {
  norad_id: number;
  sat_name: string;
  risk_tier: string;
  pc_value: number;
  summary: string;
}

export interface ScanSummary {
  id: number;
  scanned_at: string;   // ISO-8601 UTC
  event_count: number;
}

export interface HistoryListResponse {
  scans: ScanSummary[];
}

export interface HistoryScanResponse {
  scan_id: number;
  count: number;
  events: ConjunctionEvent[];
}

export type RiskTier = "CRITICAL" | "HIGH" | "ELEVATED" | "MONITOR";

export function getRiskTier(pc: number): RiskTier {
  if (pc >= 1e-4) return "CRITICAL";
  if (pc >= 1e-5) return "HIGH";
  if (pc >= 1e-6) return "ELEVATED";
  return "MONITOR";
}

export function formatPc(pc: number): string {
  if (pc === 0) return "< 1e-6";
  return pc.toExponential(2);
}
