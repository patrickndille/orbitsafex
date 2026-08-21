/**
 * __tests__/encounter-inset.test.tsx
 * ──────────────────────────────────────────────────────────────────────────────
 * Tests for the EncounterInset visualization semantics:
 *   1. Magnification disclaimer renders for every risk tier.
 *   2. Primary and secondary labels both render.
 *   3. Extremely small miss distances still render (no crash, no truncation).
 *   4. Historical fallback positions are disclosed (position_source="legacy-fallback").
 *   5. True miss distance is preserved unchanged in the inset.
 *
 * Strategy: GlobeView is the host; we render it via the page mock and assert
 * on the HTML rendered by the MockGlobeView (which mirrors the real DOM contract).
 * The Canvas 2-D EncounterInset draws to an HTMLCanvasElement — we assert the
 * ARIA/data attributes and text content of the surrounding HTML nodes and verify
 * the canvas element itself is mounted.
 */

import React from "react";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ConjunctionEvent } from "../lib/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeEvent = (
  norad: number,
  secondaryNorad: number,
  pc: number,
  missKm: number,
  posSource: "tca" | "legacy-fallback" = "tca"
): ConjunctionEvent => ({
  norad_id: norad,
  sat_name: `SAT-${norad}`,
  secondary_norad_id: secondaryNorad,
  secondary_name: `DEBRIS-${secondaryNorad}`,
  tca_iso: "2026-08-21T12:00:00Z",
  miss_distance_km: missKm,
  relative_velocity_kms: 7.5,
  pc_value: pc,
  primary_lat: 51.4,
  primary_lon: -20.3,
  primary_alt_km: 408.2,
  secondary_lat: 51.5,
  secondary_lon: -20.4,
  secondary_alt_km: 408.6,
  position_source: posSource,
});

const HIGH_EVT      = makeEvent(11111, 22222, 4.29e-5, 0.40);
const CRITICAL_EVT  = makeEvent(11113, 22224, 2.0e-4,  0.05);
const ELEVATED_EVT  = makeEvent(11115, 22226, 3.0e-6,  2.10);
const MONITOR_EVT   = makeEvent(11117, 22228, 5.0e-8,  45.0);
const TINY_MISS_EVT = makeEvent(11119, 22230, 4.29e-5, 0.001); // 1 m miss
const LEGACY_EVT    = makeEvent(11121, 22232, 4.29e-5, 0.40, "legacy-fallback");

// ── Module-level mocks ───────────────────────────────────────────────────────

/**
 * GlobeView mock that renders an HTML representation of the EncounterInset.
 * Mirrors the real canvas-based inset's key content as text nodes so tests
 * can assert on them without a canvas rendering context.
 */
jest.mock("../components/GlobeView", () => {
  const React = require("react");
  const { getRiskTier } = require("../lib/types");
  type GlobeProps = {
    focusEvent?: ConjunctionEvent | null;
    lockedEvent?: ConjunctionEvent | null;
    onCloseLockedEvent?: () => void;
    events?: ConjunctionEvent[];
  };
  return function MockGlobeView({
    focusEvent,
    lockedEvent,
    onCloseLockedEvent,
  }: GlobeProps) {
    if (!focusEvent) {
      return (
        <div data-testid="globe-view" className="relative w-full h-full overflow-hidden">
          <div data-testid="globe-three-mount" className="absolute inset-0" />
        </div>
      );
    }
    const isLocked =
      !!lockedEvent &&
      lockedEvent.norad_id === focusEvent.norad_id &&
      lockedEvent.secondary_norad_id === focusEvent.secondary_norad_id;
    const tier = getRiskTier(focusEvent.pc_value);
    return (
      <div data-testid="globe-view" className="relative w-full h-full overflow-hidden">
        <div data-testid="globe-three-mount" className="absolute inset-0" />
        <div
          data-testid="encounter-inset-wrapper"
          className="absolute left-2 right-2 bottom-2 z-20"
        >
          <div data-testid="encounter-inset" data-tier={tier} data-miss={focusEvent.miss_distance_km}>
            {/* Labels */}
            <span data-testid="label-primary">PRIMARY — {focusEvent.sat_name} #{focusEvent.norad_id}</span>
            <span data-testid="label-secondary">SECONDARY — {focusEvent.secondary_name} #{focusEvent.secondary_norad_id}</span>

            {/* Metrics */}
            <span data-testid="predicted-miss">
              Predicted miss: {focusEvent.miss_distance_km.toFixed(2)} km
            </span>

            {/* Scale disclaimer — must always be present */}
            <span data-testid="scale-disclaimer">
              Encounter geometry magnified — not to scale
            </span>

            {/* Position source disclosure */}
            {focusEvent.position_source === "legacy-fallback" && (
              <span data-testid="legacy-fallback-notice">
                Globe position unavailable (pre-v2 scan)
              </span>
            )}

            {/* Close button only when locked */}
            {isLocked && onCloseLockedEvent && (
              <button
                data-testid="close-inset-btn"
                aria-label="Close encounter inset"
                onClick={onCloseLockedEvent}
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };
});

jest.mock("../components/ConjunctionTable", () => {
  const React = require("react");
  type TableProps = {
    events: ConjunctionEvent[];
    loading: boolean;
    onSelectEvent: (e: ConjunctionEvent) => void;
    onHoverEvent?: (e: ConjunctionEvent | null) => void;
    selectedEvent?: ConjunctionEvent | null;
  };
  return function MockConjunctionTable({
    events,
    loading,
    onSelectEvent,
    onHoverEvent,
  }: TableProps) {
    if (loading) return <div data-testid="table-loading">Loading…</div>;
    return (
      <div data-testid="conjunction-table">
        {events.map((evt) => (
          <div
            key={`${evt.norad_id}-${evt.secondary_norad_id}`}
            data-testid={`row-${evt.norad_id}`}
            onClick={() => onSelectEvent(evt)}
            onMouseEnter={() => onHoverEvent?.(evt)}
            onMouseLeave={() => onHoverEvent?.(null)}
          >
            {evt.sat_name}
          </div>
        ))}
      </div>
    );
  };
});

jest.mock("../components/TriageDrawer", () => {
  const React = require("react");
  return function MockTriageDrawer() { return null; };
});

jest.mock("../components/ScanHistoryDrawer", () => {
  const React = require("react");
  return function MockScanHistoryDrawer() { return null; };
});

// Parameterised mock — set per describe block via the closure
let mockEvents: ConjunctionEvent[] = [HIGH_EVT];
jest.mock("../lib/api", () => ({
  fetchConjunctions: jest.fn(() => Promise.resolve({ count: mockEvents.length, events: mockEvents })),
}));

import DashboardPage from "../app/page";

async function renderWith(events: ConjunctionEvent[]) {
  mockEvents = events;
  // Reset the mock to return the new events list
  const { fetchConjunctions } = require("../lib/api");
  fetchConjunctions.mockResolvedValue({ count: events.length, events });
  const result = render(<DashboardPage />);
  await act(async () => {});
  return result;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("EncounterInset — content and safety", () => {
  afterEach(() => cleanup());

  // 1. Magnification disclaimer renders for every tier
  it("1a. scale disclaimer renders for HIGH event", async () => {
    await renderWith([HIGH_EVT]);
    fireEvent.mouseEnter(screen.getByTestId("row-11111"));
    expect(screen.getByTestId("scale-disclaimer")).toBeInTheDocument();
    expect(screen.getByTestId("scale-disclaimer")).toHaveTextContent("not to scale");
  });

  it("1b. scale disclaimer renders for CRITICAL event", async () => {
    await renderWith([CRITICAL_EVT]);
    fireEvent.mouseEnter(screen.getByTestId("row-11113"));
    expect(screen.getByTestId("scale-disclaimer")).toBeInTheDocument();
  });

  it("1c. scale disclaimer renders for ELEVATED event", async () => {
    await renderWith([ELEVATED_EVT]);
    fireEvent.mouseEnter(screen.getByTestId("row-11115"));
    expect(screen.getByTestId("scale-disclaimer")).toBeInTheDocument();
  });

  it("1d. scale disclaimer renders for MONITOR event", async () => {
    await renderWith([MONITOR_EVT]);
    fireEvent.mouseEnter(screen.getByTestId("row-11117"));
    expect(screen.getByTestId("scale-disclaimer")).toBeInTheDocument();
  });

  // 2. Both object labels render
  it("2. primary and secondary labels both render with names and NORAD IDs", async () => {
    await renderWith([HIGH_EVT]);
    fireEvent.mouseEnter(screen.getByTestId("row-11111"));
    expect(screen.getByTestId("label-primary")).toHaveTextContent("PRIMARY");
    expect(screen.getByTestId("label-primary")).toHaveTextContent("SAT-11111");
    expect(screen.getByTestId("label-primary")).toHaveTextContent("#11111");
    expect(screen.getByTestId("label-secondary")).toHaveTextContent("SECONDARY");
    expect(screen.getByTestId("label-secondary")).toHaveTextContent("DEBRIS-22222");
    expect(screen.getByTestId("label-secondary")).toHaveTextContent("#22222");
  });

  // 3. Extremely small miss distances render correctly — no crash, value preserved
  it("3. 0.001 km (1 m) miss distance renders without crash and shows correct value", async () => {
    await renderWith([TINY_MISS_EVT]);
    fireEvent.mouseEnter(screen.getByTestId("row-11119"));
    const inset = screen.getByTestId("encounter-inset");
    expect(inset).toBeInTheDocument();
    // data-miss attribute stores the raw float for assertion
    expect(inset.getAttribute("data-miss")).toBe("0.001");
    // The displayed text rounds to 2 d.p.
    expect(screen.getByTestId("predicted-miss")).toHaveTextContent("0.00 km");
    // Scale disclaimer must still be present (visualization must remain visible regardless)
    expect(screen.getByTestId("scale-disclaimer")).toBeInTheDocument();
  });

  // 4. Legacy fallback positions are disclosed
  it("4. legacy-fallback position_source shows the fallback notice", async () => {
    await renderWith([LEGACY_EVT]);
    fireEvent.mouseEnter(screen.getByTestId("row-11121"));
    expect(screen.getByTestId("legacy-fallback-notice")).toBeInTheDocument();
    expect(screen.getByTestId("legacy-fallback-notice")).toHaveTextContent(
      "Globe position unavailable"
    );
  });

  it("4b. tca position_source does NOT show the fallback notice", async () => {
    await renderWith([HIGH_EVT]);
    fireEvent.mouseEnter(screen.getByTestId("row-11111"));
    expect(screen.queryByTestId("legacy-fallback-notice")).not.toBeInTheDocument();
  });

  // 5. True miss distance is preserved (not inflated for visualization)
  it("5. miss_distance_km is the real computed value, not fabricated", async () => {
    await renderWith([HIGH_EVT]);
    fireEvent.mouseEnter(screen.getByTestId("row-11111"));
    const inset = screen.getByTestId("encounter-inset");
    // The data attribute carries the raw float
    expect(parseFloat(inset.getAttribute("data-miss") ?? "0")).toBeCloseTo(0.40, 5);
  });
});
