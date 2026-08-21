/**
 * __tests__/conjunction-table-interaction.test.tsx
 * ──────────────────────────────────────────────────────────────────────────────
 * Tests for ConjunctionTable hover/selection interaction semantics.
 *
 * Asserts:
 *   1. Hovering a row calls onHoverEvent with that event.
 *   2. Mouse-leave from row calls onHoverEvent(null) → inset should unmount.
 *   3. Click-locked selection persists after mouse-leave (onSelectEvent stays set).
 *   4. Clicking the already-selected row calls onSelectEvent with the same event
 *      (so the page-level toggle can deselect it).
 *   5. The selected row has distinguishable styling from unselected rows.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import ConjunctionTable from "../components/ConjunctionTable";
import type { ConjunctionEvent } from "../lib/types";

// Minimal event fixture
const makeEvent = (norad: number, secondaryNorad: number, pc = 4.29e-5): ConjunctionEvent => ({
  norad_id:              norad,
  sat_name:              `SAT-${norad}`,
  secondary_norad_id:    secondaryNorad,
  secondary_name:        `SAT-${secondaryNorad}`,
  tca_iso:               "2026-08-21T12:00:00Z",
  miss_distance_km:      0.40,
  relative_velocity_kms: 7.5,
  pc_value:              pc,
  primary_lat:           51.4,
  primary_lon:           -20.3,
  primary_alt_km:        408.2,
  secondary_lat:         51.5,
  secondary_lon:         -20.4,
  secondary_alt_km:      408.6,
  position_source:       "tca",
});

const EVT_A = makeEvent(11111, 22222, 4.29e-5); // HIGH
const EVT_B = makeEvent(33333, 44444, 3.0e-7);  // ELEVATED

describe("ConjunctionTable hover/selection semantics", () => {
  it("calls onHoverEvent with the event when mouse enters a row", () => {
    const onHover = jest.fn();
    render(
      <ConjunctionTable
        events={[EVT_A, EVT_B]}
        loading={false}
        onSelectEvent={jest.fn()}
        onHoverEvent={onHover}
      />
    );
    const row = screen.getByText("SAT-11111").closest("tr")!;
    fireEvent.mouseEnter(row);
    expect(onHover).toHaveBeenCalledWith(EVT_A);
  });

  it("calls onHoverEvent(null) when mouse leaves — inset should unmount", () => {
    const onHover = jest.fn();
    render(
      <ConjunctionTable
        events={[EVT_A, EVT_B]}
        loading={false}
        onSelectEvent={jest.fn()}
        onHoverEvent={onHover}
      />
    );
    const row = screen.getByText("SAT-11111").closest("tr")!;
    fireEvent.mouseEnter(row);
    fireEvent.mouseLeave(row);
    // Last call must be null — signalling the inset to unmount
    const calls = onHover.mock.calls;
    expect(calls[calls.length - 1][0]).toBeNull();
  });

  it("calling onSelectEvent does NOT clear it on mouse-leave (click-lock is external state)", () => {
    // The table is responsible for forwarding the click; the parent (page.tsx) holds state.
    // This test verifies that clicking a row fires onSelectEvent but does NOT call
    // onHoverEvent(null) — so mouse-leave still controls the hover state independently.
    const onSelect = jest.fn();
    const onHover  = jest.fn();
    render(
      <ConjunctionTable
        events={[EVT_A]}
        loading={false}
        onSelectEvent={onSelect}
        onHoverEvent={onHover}
        selectedEvent={null}
      />
    );
    const row = screen.getByText("SAT-11111").closest("tr")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(row);
    // onSelectEvent should have been called
    expect(onSelect).toHaveBeenCalledWith(EVT_A);
    // onHoverEvent should NOT have been set to null by the click
    const calls = onHover.mock.calls;
    expect(calls[calls.length - 1][0]).not.toBeNull();
  });

  it("click fires onSelectEvent again for already-selected row (enables toggle-deselect)", () => {
    const onSelect = jest.fn();
    render(
      <ConjunctionTable
        events={[EVT_A]}
        loading={false}
        onSelectEvent={onSelect}
        selectedEvent={EVT_A}         // simulate already-selected
      />
    );
    const row = screen.getByText("SAT-11111").closest("tr")!;
    fireEvent.click(row);
    // Table always fires onSelectEvent; page.tsx handler decides whether to
    // keep or clear the selection
    expect(onSelect).toHaveBeenCalledWith(EVT_A);
  });

  it("selected row has different background class from unselected rows", () => {
    render(
      <ConjunctionTable
        events={[EVT_A, EVT_B]}
        loading={false}
        onSelectEvent={jest.fn()}
        selectedEvent={EVT_A}
      />
    );
    const selectedRow   = screen.getByText("SAT-11111").closest("tr")!;
    const unselectedRow = screen.getByText("SAT-33333").closest("tr")!;
    // Selected row must have the ring class applied (TIER_SELECTED_BG)
    expect(selectedRow.className).toContain("ring-");
    // Unselected row must NOT have the ring class
    expect(unselectedRow.className).not.toContain("ring-");
  });

  it("shows no rows when loading", () => {
    render(
      <ConjunctionTable
        events={[EVT_A]}
        loading={true}
        onSelectEvent={jest.fn()}
      />
    );
    expect(screen.getByText(/Running orbital scan/i)).toBeInTheDocument();
    expect(screen.queryByText("SAT-11111")).not.toBeInTheDocument();
  });
});
