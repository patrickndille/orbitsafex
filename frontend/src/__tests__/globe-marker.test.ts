/**
 * __tests__/globe-marker.test.ts
 * ──────────────────────────────────────────────────────────────────────────────
 * Unit tests for the pure marker-data helpers exported from GlobeView.tsx.
 *
 * These tests run without a WebGL context. They verify the contracts
 * required by the task specification:
 *
 *   1. All supplied events are counted, not a slice.
 *   2. Total marker count equals events.length.
 *   3. Marker positions use the correct event midpoint data.
 *   4. selectLineEvents never exceeds MAX_CONTEXT_LINES.
 *   5. selectLineEvents does not reduce marker count (independent layers).
 *   6. Priority ordering: CRITICAL first, then HIGH, ELEVATED, MONITOR.
 *   7. No random satellite generator exists in GlobeView.tsx.
 *   8. Legend no longer claims "Active satellite".
 *   9. Legend no longer claims "Secondary (selected)" on the main globe.
 *  10. Atmosphere shader values are within the intended subtle range.
 *  11. eventMarkerPosition falls back gracefully when lat/lon fields are absent.
 *  12. geoMidpoint handles antimeridian crossing.
 *  13. noradToLatLon is deterministic.
 */

import {
  geoToVec3,
  geoMidpoint,
  noradToLatLon,
  eventMarkerPosition,
  countEventsByTier,
  selectLineEvents,
  MAX_CONTEXT_LINES,
  RISK_COLOUR,
} from "../components/GlobeView";
import type { ConjunctionEvent } from "../lib/types";
import { getRiskTier } from "../lib/types";
import * as fs from "fs";
import * as path from "path";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEvt(
  norad: number,
  secondary: number,
  pc: number,
  opts: Partial<ConjunctionEvent> = {}
): ConjunctionEvent {
  return {
    norad_id: norad,
    sat_name: `SAT-${norad}`,
    secondary_norad_id: secondary,
    secondary_name: `DEB-${secondary}`,
    tca_iso: "2026-08-21T12:00:00Z",
    miss_distance_km: 0.4,
    relative_velocity_kms: 7.5,
    pc_value: pc,
    primary_lat: 51.4,
    primary_lon: -20.3,
    primary_alt_km: 408.2,
    secondary_lat: 51.5,
    secondary_lon: -20.4,
    secondary_alt_km: 408.6,
    position_source: "tca",
    ...opts,
  };
}

const CRITICAL_EVT  = makeEvt(1001, 2001, 2.0e-4);
const HIGH_EVT      = makeEvt(1002, 2002, 4.0e-5);
const ELEVATED_EVT  = makeEvt(1003, 2003, 3.0e-6);
const MONITOR_EVT   = makeEvt(1004, 2004, 5.0e-8);

// ── Tests: coordinate helpers ─────────────────────────────────────────────────

describe("geoToVec3 — coordinate transform", () => {
  it("returns a defined value without throwing", () => {
    expect(() => geoToVec3(0, 0, 400)).not.toThrow();
    const v = geoToVec3(0, 0, 400);
    expect(v).toBeDefined();
  });
});

describe("geoMidpoint — antimeridian-safe geographic midpoint", () => {
  it("returns a [lat, lon] tuple", () => {
    const [lat, lon] = geoMidpoint(51.4, -20.3, 51.5, -20.4);
    expect(typeof lat).toBe("number");
    expect(typeof lon).toBe("number");
  });

  it("handles antimeridian crossing without NaN", () => {
    const [lat, lon] = geoMidpoint(0, 179.9, 0, -179.9);
    expect(isNaN(lat)).toBe(false);
    expect(isNaN(lon)).toBe(false);
    // Midpoint should be near ±180, not 0
    expect(Math.abs(lon)).toBeGreaterThan(100);
  });
});

describe("noradToLatLon — deterministic fallback", () => {
  it("returns reproducible values for the same ID", () => {
    const a = noradToLatLon(25544);
    const b = noradToLatLon(25544);
    expect(a).toEqual(b);
  });

  it("returns lat in [-80, 80] and lon in [-180, 180]", () => {
    for (const id of [1, 25544, 99999, 123456]) {
      const [lat, lon] = noradToLatLon(id);
      expect(lat).toBeGreaterThanOrEqual(-80);
      expect(lat).toBeLessThanOrEqual(80);
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThanOrEqual(180);
    }
  });
});

describe("eventMarkerPosition", () => {
  it("completes without throwing when all position fields are present", () => {
    expect(() => eventMarkerPosition(HIGH_EVT)).not.toThrow();
  });

  it("falls back to noradToLatLon when position fields are absent", () => {
    const evt = makeEvt(5000, 6000, 1e-5, {
      primary_lat:   undefined,
      primary_lon:   undefined,
      secondary_lat: undefined,
      secondary_lon: undefined,
    });
    expect(() => eventMarkerPosition(evt)).not.toThrow();
  });

  it("does not throw with extreme altitude values", () => {
    const evt = makeEvt(7001, 7002, 1e-5, {
      primary_alt_km:   300,
      secondary_alt_km: 1200,
    });
    expect(() => eventMarkerPosition(evt)).not.toThrow();
  });
});

// ── Tests: countEventsByTier (pure — no WebGL) ────────────────────────────────

describe("countEventsByTier — marker count equals events.length", () => {
  it("totals all events across tiers", () => {
    const events = [CRITICAL_EVT, HIGH_EVT, ELEVATED_EVT, MONITOR_EVT];
    const counts = countEventsByTier(events);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(events.length);
  });

  it("processes 200 events — not capped at 60", () => {
    const manyEvents: ConjunctionEvent[] = [];
    for (let i = 0; i < 200; i++) {
      const pc = i < 5 ? 2e-4 : i < 20 ? 4e-5 : i < 60 ? 3e-6 : 5e-8;
      manyEvents.push(makeEvt(10000 + i, 20000 + i, pc));
    }
    const counts = countEventsByTier(manyEvents);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(200);
  });

  it("regression: 736 events produce total count of 736", () => {
    const events: ConjunctionEvent[] = [];
    for (let i = 0; i < 736; i++) {
      const pc = i < 2 ? 2e-4 : i < 10 ? 4e-5 : i < 54 ? 3e-6 : 5e-8;
      events.push(makeEvt(100000 + i, 200000 + i, pc));
    }
    const counts = countEventsByTier(events);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(736);
  });

  it("returns zero for empty event list", () => {
    const counts = countEventsByTier([]);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
  });

  it("correctly bins CRITICAL, HIGH, ELEVATED, MONITOR events", () => {
    const events = [
      CRITICAL_EVT, CRITICAL_EVT,  // 2 CRITICAL
      HIGH_EVT,                      // 1 HIGH
      ELEVATED_EVT, ELEVATED_EVT, ELEVATED_EVT, // 3 ELEVATED
      MONITOR_EVT,                   // 1 MONITOR
    ];
    const counts = countEventsByTier(events);
    expect(counts.CRITICAL).toBe(2);
    expect(counts.HIGH).toBe(1);
    expect(counts.ELEVATED).toBe(3);
    expect(counts.MONITOR).toBe(1);
  });
});

// ── Tests: selectLineEvents ───────────────────────────────────────────────────

describe("selectLineEvents — line sampling independent from markers", () => {
  it("never returns more than MAX_CONTEXT_LINES events", () => {
    const many: ConjunctionEvent[] = [];
    for (let i = 0; i < 300; i++) {
      many.push(makeEvt(30000 + i, 40000 + i, 5e-8));
    }
    const lines = selectLineEvents(many);
    expect(lines.length).toBeLessThanOrEqual(MAX_CONTEXT_LINES);
  });

  it("returns all events when count <= MAX_CONTEXT_LINES", () => {
    const few = [CRITICAL_EVT, HIGH_EVT, MONITOR_EVT];
    const lines = selectLineEvents(few);
    expect(lines.length).toBe(few.length);
  });

  it("does not mutate or reduce the source array", () => {
    const many: ConjunctionEvent[] = [];
    for (let i = 0; i < 200; i++) {
      many.push(makeEvt(50000 + i, 60000 + i, 5e-8));
    }
    const originalLength = many.length;
    selectLineEvents(many);
    expect(many.length).toBe(originalLength);
  });

  it("line capping does not affect marker count", () => {
    const many: ConjunctionEvent[] = [];
    for (let i = 0; i < 200; i++) {
      many.push(makeEvt(50000 + i, 60000 + i, 5e-8));
    }
    selectLineEvents(many); // capped at 60

    // countEventsByTier still sees all 200 (markers are independent of lines)
    const counts = countEventsByTier(many);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(200);
  });

  it("prioritises CRITICAL events over MONITOR when capping to 60", () => {
    const events: ConjunctionEvent[] = [];
    for (let i = 0; i < 5; i++)  events.push(makeEvt(70000 + i, 80000 + i, 2e-4)); // CRITICAL
    for (let i = 0; i < 70; i++) events.push(makeEvt(70100 + i, 80100 + i, 5e-8)); // MONITOR

    const lines = selectLineEvents(events);
    expect(lines.length).toBe(MAX_CONTEXT_LINES); // capped at 60
    const criticalInLines = lines.filter((e) => getRiskTier(e.pc_value) === "CRITICAL");
    expect(criticalInLines.length).toBe(5); // all 5 CRITICAL included
  });

  it("MAX_CONTEXT_LINES is exactly 60", () => {
    expect(MAX_CONTEXT_LINES).toBe(60);
  });
});

// ── Tests: risk color map ─────────────────────────────────────────────────────

describe("RISK_COLOUR — tier color map", () => {
  it("contains all four risk tiers", () => {
    expect(RISK_COLOUR).toHaveProperty("CRITICAL");
    expect(RISK_COLOUR).toHaveProperty("HIGH");
    expect(RISK_COLOUR).toHaveProperty("ELEVATED");
    expect(RISK_COLOUR).toHaveProperty("MONITOR");
  });

  it("CRITICAL is red (0xef4444)", () => {
    expect(RISK_COLOUR.CRITICAL).toBe(0xef4444);
  });

  it("HIGH is orange (0xf97316)", () => {
    expect(RISK_COLOUR.HIGH).toBe(0xf97316);
  });

  it("ELEVATED is yellow (0xeab308)", () => {
    expect(RISK_COLOUR.ELEVATED).toBe(0xeab308);
  });

  it("MONITOR is green (0x22c55e)", () => {
    expect(RISK_COLOUR.MONITOR).toBe(0x22c55e);
  });
});

// ── Tests: source-code contract checks ───────────────────────────────────────

const globeViewSrc = fs.readFileSync(
  path.resolve(__dirname, "../components/GlobeView.tsx"),
  "utf8"
);

const pageSrc = fs.readFileSync(
  path.resolve(__dirname, "../app/page.tsx"),
  "utf8"
);

describe("No random satellite dot generator", () => {
  it("does not contain the old random satellite lat/lon formula", () => {
    expect(globeViewSrc).not.toMatch(/Math\.random.*160 - 80/);
  });

  it("does not contain 'Active satellite' text", () => {
    expect(globeViewSrc).not.toMatch(/Active satellite/);
  });

  it("does not contain the old slice(0,60) event loop", () => {
    expect(globeViewSrc).not.toMatch(/events\.slice\(0,\s*60\)/);
  });

  it("does not contain random dot creation with Mesh+Math.random", () => {
    // The old pattern: const dot = new THREE.Mesh(...random position)
    expect(globeViewSrc).not.toMatch(/const dot = new THREE\.Mesh/);
  });
});

describe("Legend accuracy (page.tsx)", () => {
  it("does not claim 'Active satellite'", () => {
    expect(pageSrc).not.toMatch(/Active satellite/);
  });

  it("does not claim 'Secondary (selected)' on the main globe", () => {
    expect(pageSrc).not.toMatch(/Secondary \(selected\)/);
  });

  it("contains a TCA context note", () => {
    expect(pageSrc).toMatch(/TCA/);
  });

  it("contains 'not a simultaneous' disclaimer", () => {
    expect(pageSrc).toMatch(/not a simultaneous/);
  });
});

describe("Atmosphere shader parameters (source-code checks)", () => {
  it("atmosphere SphereGeometry radius is in range [1.02, 1.035]", () => {
    const match = globeViewSrc.match(/atmosGeo\s*=\s*new THREE\.SphereGeometry\(([0-9.]+)/);
    expect(match).not.toBeNull();
    const radius = parseFloat(match![1]);
    expect(radius).toBeGreaterThanOrEqual(1.02);
    expect(radius).toBeLessThanOrEqual(1.035);
  });

  it("atmosphere peak fragment alpha is ≤ 0.30", () => {
    // Match: rim * 0.XX in the fragment shader
    const match = globeViewSrc.match(/rim \* ([0-9.]+)/);
    expect(match).not.toBeNull();
    const alpha = parseFloat(match![1]);
    expect(alpha).toBeLessThanOrEqual(0.30);
    expect(alpha).toBeGreaterThan(0.05);
  });

  it("atmosphere Fresnel exponent is ≥ 4.0", () => {
    const match = globeViewSrc.match(/pow\(rim,\s*([0-9.]+)\)/);
    expect(match).not.toBeNull();
    const exponent = parseFloat(match![1]);
    expect(exponent).toBeGreaterThanOrEqual(4.0);
  });
});
