"use client";

/**
 * ConjunctionTable.tsx
 * Interactive table of conjunction events.
 * Features: sort by Pc, NORAD ID search, risk-tier filter, row click → triage.
 */

import { useState, useMemo } from "react";
import { Search, Filter, ArrowUpDown, AlertTriangle, Eye, ChevronLeft, ChevronRight } from "lucide-react";
import type { ConjunctionEvent } from "@/lib/types";
import { getRiskTier, formatPc } from "@/lib/types";
import clsx from "clsx";

const PAGE_SIZE = 25;

interface Props {
  events: ConjunctionEvent[];
  loading: boolean;
  /** Optional elapsed seconds to show while loading */
  loadingElapsed?: number;
  onSelectEvent: (event: ConjunctionEvent) => void;
  /** The currently click-locked selection (persists after hover ends) */
  selectedEvent?: ConjunctionEvent | null;
  /** Called with the hovered event (or null on mouse-leave) */
  onHoverEvent?: (event: ConjunctionEvent | null) => void;
}

const TIER_BADGE: Record<string, string> = {
  CRITICAL: "badge-critical",
  HIGH:     "badge-high",
  ELEVATED: "badge-elevated",
  MONITOR:  "badge-monitor",
};

const TIER_ROW_BG: Record<string, string> = {
  CRITICAL: "bg-red-500/5 hover:bg-red-500/10 pulse-critical",
  HIGH:     "bg-orange-500/5 hover:bg-orange-500/10",
  ELEVATED: "bg-yellow-500/5 hover:bg-yellow-500/10",
  MONITOR:  "hover:bg-slate-800/50",
};

/** Extra classes applied to the click-locked selected row */
const TIER_SELECTED_BG: Record<string, string> = {
  CRITICAL: "bg-red-500/20 ring-1 ring-red-500/50",
  HIGH:     "bg-orange-500/20 ring-1 ring-orange-500/50",
  ELEVATED: "bg-yellow-500/20 ring-1 ring-yellow-500/50",
  MONITOR:  "bg-slate-700/40 ring-1 ring-slate-500/50",
};

export default function ConjunctionTable({ events, loading, loadingElapsed, onSelectEvent, selectedEvent, onHoverEvent }: Props) {
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<string>("ALL");
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let list = [...events];
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (e) =>
          e.norad_id.toString().includes(q) ||
          e.sat_name.toLowerCase().includes(q) ||
          e.secondary_name.toLowerCase().includes(q)
      );
    }
    if (tierFilter !== "ALL") {
      list = list.filter((e) => getRiskTier(e.pc_value) === tierFilter);
    }
    list.sort((a, b) =>
      sortAsc ? a.pc_value - b.pc_value : b.pc_value - a.pc_value
    );
    return list;
  }, [events, search, tierFilter, sortAsc]);

  // Reset to page 1 whenever the filtered set changes
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamp page in case filter reduced total pages
  const currentPage = Math.min(page, totalPages);
  const pageStart  = (currentPage - 1) * PAGE_SIZE;
  const pageEnd    = pageStart + PAGE_SIZE;
  const paginated  = filtered.slice(pageStart, pageEnd);

  const goTo = (p: number) => setPage(Math.max(1, Math.min(p, totalPages)));

  // Reset page to 1 when filter/search changes
  const handleSearch = (v: string) => { setSearch(v); setPage(1); };
  const handleTier   = (t: string) => { setTierFilter(t); setPage(1); };
  const handleSort   = () => { setSortAsc(!sortAsc); setPage(1); };

  return (
    <div className="flex flex-col h-full bg-space-900 rounded-xl border border-slate-700/50 overflow-hidden">
      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-slate-700/50 bg-space-800/60 shrink-0">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
          <input
            type="text"
            placeholder="Search NORAD ID or satellite name…"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="w-full bg-space-950/80 border border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
          />
        </div>

        {/* Tier filter */}
        <div className="flex items-center gap-1.5">
          <Filter className="text-slate-400 w-4 h-4" />
          {["ALL", "CRITICAL", "HIGH", "ELEVATED", "MONITOR"].map((t) => (
            <button
              key={t}
              onClick={() => handleTier(t)}
              className={clsx(
                "px-2.5 py-1 rounded-md text-xs font-medium border transition",
                tierFilter === t
                  ? t === "ALL"
                    ? "bg-blue-500/20 text-blue-400 border-blue-500/50"
                    : TIER_BADGE[t]
                  : "bg-transparent text-slate-400 border-slate-700 hover:border-slate-500"
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Event count */}
        <span className="ml-auto text-xs text-slate-500 whitespace-nowrap">
          {filtered.length} event{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────── */}
      <div className="overflow-auto flex-1">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10 bg-space-800 text-slate-400 text-xs uppercase tracking-wider">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Risk</th>
              <th className="px-4 py-2.5 text-left font-medium">Primary Satellite</th>
              <th className="px-4 py-2.5 text-left font-medium">Secondary Object</th>
              <th className="px-4 py-2.5 text-right font-medium">Miss Dist (km)</th>
              <th className="px-4 py-2.5 text-right font-medium">Rel. Velocity (km/s)</th>
              <th
                className="px-4 py-2.5 text-right font-medium cursor-pointer select-none group"
                onClick={handleSort}
              >
                <span className="flex items-center justify-end gap-1">
                  Pc Value
                  <ArrowUpDown className="w-3.5 h-3.5 text-slate-500 group-hover:text-blue-400 transition" />
                </span>
              </th>
              <th className="px-4 py-2.5 text-center font-medium">TCA (UTC)</th>
              <th className="px-4 py-2.5 text-center font-medium">AI Triage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {loading && (
              <tr>
                <td colSpan={8} className="py-16 text-center text-slate-500">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <span>Running orbital scan…</span>
                    {loadingElapsed !== undefined && loadingElapsed > 0 && (
                      <span className="text-xs font-mono tabular-nums text-slate-600">
                        {loadingElapsed}s elapsed · SGP4 propagation in progress
                      </span>
                    )}
                    {loadingElapsed !== undefined && loadingElapsed > 30 && (
                      <span className="text-xs text-slate-700 max-w-xs text-center">
                        Large catalog scan can take 1–3 min. The result will appear automatically.
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="py-16 text-center text-slate-500">
                  No conjunction events match the current filter.
                </td>
              </tr>
            )}
            {!loading &&
              paginated.map((evt) => {
                const tier = getRiskTier(evt.pc_value);
                const isSelected =
                  selectedEvent?.norad_id === evt.norad_id &&
                  selectedEvent?.secondary_norad_id === evt.secondary_norad_id;
                return (
                  <tr
                    key={`${evt.norad_id}-${evt.secondary_norad_id}`}
                    className={clsx(
                      "transition cursor-pointer",
                      isSelected ? TIER_SELECTED_BG[tier] : TIER_ROW_BG[tier]
                    )}
                    onClick={() => onSelectEvent(evt)}
                    onMouseEnter={() => onHoverEvent?.(evt)}
                    onMouseLeave={() => onHoverEvent?.(null)}
                  >
                    {/* Risk badge */}
                    <td className="px-4 py-2.5">
                      <span className={clsx("px-2 py-0.5 rounded text-xs font-semibold", TIER_BADGE[tier])}>
                        {tier}
                      </span>
                    </td>
                    {/* Primary */}
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-200">{evt.sat_name}</div>
                      <div className="text-xs text-slate-500">#{evt.norad_id}</div>
                    </td>
                    {/* Secondary */}
                    <td className="px-4 py-2.5">
                      <div className="text-slate-300">{evt.secondary_name}</div>
                      <div className="text-xs text-slate-500">#{evt.secondary_norad_id}</div>
                    </td>
                    {/* Miss dist */}
                    <td className="px-4 py-2.5 text-right font-mono text-slate-300">
                      {evt.miss_distance_km.toFixed(2)}
                    </td>
                    {/* Rel velocity */}
                    <td className="px-4 py-2.5 text-right font-mono text-slate-300">
                      {evt.relative_velocity_kms.toFixed(3)}
                    </td>
                    {/* Pc */}
                    <td className="px-4 py-2.5 text-right font-mono">
                      <span className={clsx(
                        "font-semibold",
                        tier === "CRITICAL" ? "text-red-400" :
                        tier === "HIGH" ? "text-orange-400" :
                        tier === "ELEVATED" ? "text-yellow-400" : "text-green-400"
                      )}>
                        {formatPc(evt.pc_value)}
                      </span>
                    </td>
                    {/* TCA */}
                    <td className="px-4 py-2.5 text-center text-slate-400 text-xs font-mono">
                      {new Date(evt.tca_iso).toUTCString().replace("GMT", "Z").substring(5, 25)}
                    </td>
                    {/* Triage CTA */}
                    <td className="px-4 py-2.5 text-center">
                      <button
                        onClick={(e) => { e.stopPropagation(); onSelectEvent(evt); }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-500/10 border border-blue-500/30 text-blue-400 text-xs font-medium hover:bg-blue-500/20 transition"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        Triage
                      </button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {/* ── Pagination + footer ─────────────────────────────────────────── */}
      {!loading && filtered.length > 0 && (
        <div className="px-4 py-2 border-t border-slate-800 flex items-center justify-between gap-3 shrink-0">
          {/* hint */}
          <div className="flex items-center gap-1 text-xs text-slate-600">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">Click row or &ldquo;Triage&rdquo; for AI advisory.</span>
          </div>

          {/* pagination controls */}
          {totalPages > 1 && (
            <div className="flex items-center gap-2 text-xs text-slate-400 ml-auto">
              <span className="text-slate-600 whitespace-nowrap">
                {pageStart + 1}–{Math.min(pageEnd, filtered.length)} of {filtered.length}
              </span>
              <button
                onClick={() => goTo(currentPage - 1)}
                disabled={currentPage === 1}
                className="p-1 rounded hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition"
                aria-label="Previous page"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              {/* page number pills — show at most 5 */}
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => {
                  if (totalPages <= 5) return true;
                  if (p === 1 || p === totalPages) return true;
                  return Math.abs(p - currentPage) <= 1;
                })
                .reduce<(number | "…")[]>((acc, p, i, arr) => {
                  if (i > 0 && typeof arr[i - 1] === "number" && (p as number) - (arr[i - 1] as number) > 1) {
                    acc.push("…");
                  }
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, idx) =>
                  p === "…" ? (
                    <span key={`ellipsis-${idx}`} className="px-1 text-slate-600">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => goTo(p as number)}
                      className={clsx(
                        "w-6 h-6 rounded text-xs font-medium transition",
                        currentPage === p
                          ? "bg-blue-500/30 text-blue-300 border border-blue-500/50"
                          : "hover:bg-slate-700 text-slate-400"
                      )}
                    >
                      {p}
                    </button>
                  )
                )}

              <button
                onClick={() => goTo(currentPage + 1)}
                disabled={currentPage === totalPages}
                className="p-1 rounded hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition"
                aria-label="Next page"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
