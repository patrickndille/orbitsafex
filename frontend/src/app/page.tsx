"use client";

/**
 * page.tsx  –  OrbitSafe AI main dashboard
 *
 * Layout:
 *   ┌─ Header bar ──────────────────────────────────────────────┐
 *   ├─ Stats strip (event counts per tier) ─────────────────────┤
 *   ├─ Globe (left, 40%)  │  Table (right, 60%) ───────────────┤
 *   └─ Triage drawer (slide-in from right) ────────────────────┘
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import {
  Satellite,
  RefreshCw,
  AlertTriangle,
  ShieldAlert,
  Activity,
  Globe2,
  CheckCircle2,
  History,
} from "lucide-react";
import clsx from "clsx";

import ConjunctionTable from "@/components/ConjunctionTable";
import TriageDrawer from "@/components/TriageDrawer";
import ScanHistoryDrawer from "@/components/ScanHistoryDrawer";
import type { ConjunctionEvent } from "@/lib/types";
import { fetchConjunctions } from "@/lib/api";
import { getRiskTier } from "@/lib/types";

// Three.js globe must be imported dynamically (browser-only)
const GlobeView = dynamic(() => import("@/components/GlobeView"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center text-slate-500 text-sm">
      Loading 3D globe…
    </div>
  ),
});

// ── Stat card ────────────────────────────────────────────────────────────────
function StatCard({
  icon: Icon,
  label,
  value,
  colour,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  colour: string;
  sub?: string;
}) {
  return (
    <div className="flex items-center gap-3 bg-space-800/60 border border-slate-700/50 rounded-xl px-4 py-3">
      <div className={clsx("p-2 rounded-lg", colour)}>
        <Icon className="w-4 h-4" />
      </div>
      <div>
        <div className="text-lg font-bold text-slate-100 leading-none">{value}</div>
        <div className="text-xs text-slate-500 mt-0.5">{label}</div>
        {sub && <div className="text-xs text-slate-600">{sub}</div>}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [events, setEvents] = useState<ConjunctionEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastScan, setLastScan] = useState<Date | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<ConjunctionEvent | null>(null);
  const [hoveredEvent, setHoveredEvent]   = useState<ConjunctionEvent | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Globe always shows the hovered row first; falls back to the open triage event
  const globeEvent = hoveredEvent ?? selectedEvent;

  const runScan = useCallback(async () => {
    setLoading(true);
    setScanError(null);
    try {
      const data = await fetchConjunctions(400);
      setEvents(data.events);
      setLastScan(new Date());
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-scan on mount
  useEffect(() => {
    runScan();
  }, [runScan]);

  // Derived stats
  const byTier = {
    CRITICAL: events.filter((e) => getRiskTier(e.pc_value) === "CRITICAL").length,
    HIGH:     events.filter((e) => getRiskTier(e.pc_value) === "HIGH").length,
    ELEVATED: events.filter((e) => getRiskTier(e.pc_value) === "ELEVATED").length,
    MONITOR:  events.filter((e) => getRiskTier(e.pc_value) === "MONITOR").length,
  };

  return (
    <div className="min-h-screen flex flex-col bg-space-950 text-slate-100">

      {/* ── Header ────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-700/50 bg-space-900/80 backdrop-blur sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-blue-500/20 border border-blue-500/30">
            <Satellite className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-100 leading-none">OrbitSafe AI</h1>
            <p className="text-xs text-slate-500">Space Debris Conjunction &amp; Collision Avoidance</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* System status */}
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-500">
            <span className={clsx(
              "w-2 h-2 rounded-full",
              loading ? "bg-yellow-400 animate-pulse" :
              scanError ? "bg-red-400" : "bg-green-400"
            )} />
            {loading ? "Scanning…" : scanError ? "Error" : "Nominal"}
          </div>

          {lastScan && !loading && (
            <span className="hidden md:block text-xs text-slate-600 font-mono">
              Last scan: {lastScan.toUTCString().substring(17, 25)} UTC
            </span>
          )}

          <button
            onClick={() => setHistoryOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-400 text-sm font-medium hover:border-slate-500 hover:text-slate-200 transition"
          >
            <History className="w-3.5 h-3.5" />
            History
          </button>

          <button
            onClick={runScan}
            disabled={loading}
            className={clsx(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition",
              loading
                ? "bg-slate-800 border-slate-700 text-slate-500 cursor-not-allowed"
                : "bg-blue-500/10 border-blue-500/40 text-blue-400 hover:bg-blue-500/20"
            )}
          >
            <RefreshCw className={clsx("w-3.5 h-3.5", loading && "animate-spin")} />
            {loading ? "Scanning…" : "Refresh Scan"}
          </button>
        </div>
      </header>

      {/* ── Stats strip ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 px-6 py-4">
        <StatCard
          icon={ShieldAlert}
          label="Critical (Pc ≥ 1×10⁻⁴)"
          value={byTier.CRITICAL}
          colour="bg-red-500/20 text-red-400"
        />
        <StatCard
          icon={AlertTriangle}
          label="High (Pc ≥ 1×10⁻⁵)"
          value={byTier.HIGH}
          colour="bg-orange-500/20 text-orange-400"
        />
        <StatCard
          icon={Activity}
          label="Elevated (Pc ≥ 1×10⁻⁶)"
          value={byTier.ELEVATED}
          colour="bg-yellow-500/20 text-yellow-400"
        />
        <StatCard
          icon={CheckCircle2}
          label="Monitor"
          value={byTier.MONITOR}
          colour="bg-green-500/20 text-green-400"
        />
        <StatCard
          icon={Globe2}
          label="Total Events"
          value={events.length}
          colour="bg-blue-500/20 text-blue-400"
          sub="tracked this scan"
        />
      </div>

      {/* ── Error banner ──────────────────────────────────────────────── */}
      {scanError && (
        <div className="mx-6 mb-3 flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            <strong>Scan error:</strong> {scanError}. Make sure the FastAPI backend is running on{" "}
            <code className="font-mono text-red-400">localhost:8000</code>.
          </span>
        </div>
      )}

      {/* ── Main content (Globe + Table) ──────────────────────────────── */}
      <div className="flex-1 grid grid-cols-1 xl:grid-cols-5 gap-4 px-6 pb-6">

        {/* Globe column */}
        <div className="xl:col-span-2 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
              <Globe2 className="w-4 h-4 text-blue-400" />
              LEO Orbital Visualization
            </h2>
            <span className="text-xs text-slate-600">Drag to rotate · Auto-spin enabled</span>
          </div>
          <div className="flex-1 min-h-[380px] xl:min-h-[500px] rounded-xl border border-slate-700/50 overflow-hidden bg-space-900">
            <GlobeView events={events} selectedEvent={globeEvent} />
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 px-1">
            {[
              { colour: "bg-red-500",    label: "Critical" },
              { colour: "bg-orange-500", label: "High" },
              { colour: "bg-yellow-500", label: "Elevated" },
              { colour: "bg-green-500",  label: "Monitor" },
              { colour: "bg-slate-400",  label: "Active satellite" },
              { colour: "bg-cyan-400",   label: "Secondary / debris (selected)" },
            ].map(({ colour, label }) => (
              <span key={label} className="flex items-center gap-1.5">
                <span className={clsx("w-2 h-2 rounded-full", colour)} />
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Table column */}
        <div className="xl:col-span-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
              <Activity className="w-4 h-4 text-blue-400" />
              Conjunction Event Log
            </h2>
            <span className="text-xs text-slate-600">Sorted by Pc · Click row for AI triage</span>
          </div>
          <div className="flex-1 min-h-[500px]">
            <ConjunctionTable
              events={events}
              loading={loading}
              onSelectEvent={setSelectedEvent}
              onHoverEvent={setHoveredEvent}
            />
          </div>
        </div>
      </div>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <footer className="px-6 py-3 border-t border-slate-800 text-xs text-slate-700 flex items-center justify-between">
        <span>OrbitSafe AI · Orbital data via Space-Track.org · SGP4 propagation · LangChain triage</span>
        <span>Built with IBM Bob</span>
      </footer>

      {/* ── Triage Drawer ─────────────────────────────────────────────── */}
      <TriageDrawer
        event={selectedEvent}
        onClose={() => setSelectedEvent(null)}
      />

      {/* ── Scan History Drawer ───────────────────────────────────────── */}
      <ScanHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onLoadScan={(historicalEvents) => {
          setEvents(historicalEvents);
          setLastScan(null);
        }}
      />
    </div>
  );
}
