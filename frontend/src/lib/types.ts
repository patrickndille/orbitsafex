// lib/types.ts  –  shared TypeScript interfaces

export interface ConjunctionEvent {
  norad_id: number;
  sat_name: string;
  secondary_norad_id: number;
  secondary_name: string;
  tca_iso: string;              // ISO-8601 UTC
  miss_distance_km: number;
  relative_velocity_kms: number;
  /**
   * Screening Probability of Collision (0–1).
   * 0 is a sentinel meaning the value was below the reporting threshold (1e-6).
   * This is an estimate using assumed isotropic covariance (σ=200 m) and is
   * NOT equivalent to a CDM-quality operational Pc value.
   */
  pc_value: number;

  // Geographic positions at TCA (from TEME/ECI vectors) — used by GlobeView
  primary_lat?: number;
  primary_lon?: number;
  primary_alt_km?: number;
  secondary_lat?: number;
  secondary_lon?: number;
  secondary_alt_km?: number;

  /**
   * "tca"             – coordinates derived from SGP4 at TCA
   * "legacy-fallback" – row predates position columns; coordinates unavailable
   */
  position_source?: "tca" | "legacy-fallback";
}

/** Coverage and prefilter metadata returned with every scan. */
export interface ScanMetadata {
  eligible_leo_objects?: number;
  sampled_objects?: number;
  alt_bins?: number;
  bin_width_km?: number;
  out_of_range_skipped?: number;
  propagation_window_h?: number;
  coarse_interval_s?: number;
  screening_radius_km?: number;
  satellites_evaluated?: number;
  coarse_epochs_evaluated?: number;
  candidate_pairs?: number;
  candidate_pairs_before_cap?: number;
  candidate_pairs_capped?: boolean;
  /** Explicit statement of the prefilter's fast-pass screening gap. */
  prefilter_limitation?: string;
}

export interface ScanResponse {
  scan_id?: number;
  count: number;
  events: ConjunctionEvent[];
  /** Top-level scan coverage metadata (not duplicated per event). */
  scan_metadata?: ScanMetadata;
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
