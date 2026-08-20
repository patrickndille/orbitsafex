"use client";

/**
 * ScanHistoryDrawer.tsx
 * Slide-in panel showing previous scan summaries.
 * Clicking a scan row loads its full event list.
 */

import { useEffect, useState } from "react";
import { X, History, ChevronRight, Loader2, ArrowLeft } from "lucide-react";
import clsx from "clsx";
import type { ScanSummary, ConjunctionEvent } from "@/lib/types";
import { getRiskTier, formatPc } from "@/lib/types";
import { fetchHistory, fetchHistoricalScan } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called when the user clicks "Load into dashboard" for a historical scan */
  onLoadScan: (events: ConjunctionEvent[]) => void;
}

export default function ScanHistoryDrawer({ open, onClose, onLoadScan }: Props) {
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detail view state
  const [detailScan, setDetailScan] = useState<ScanSummary | null>(null);
  const [detailEvents, setDetailEvents] = useState<ConjunctionEvent[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Fetch history list when panel opens
  useEffect(() => {
    if (!open) return;
    setDetailScan(null);
    setDetailEvents([]);
    setLoading(true);
    setError(null);
    fetchHistory(30)
      .then((r) => setScans(r.scans))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open]);

  const openDetail = async (scan: ScanSummary) => {
    setDetailScan(scan);
    setDetailEvents([]);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const r = await fetchHistoricalScan(scan.id);
      setDetailEvents(r.events);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <aside
        className={clsx(
          "fixed top-0 right-0 h-full w-full max-w-[480px] z-50",
          "bg-space-900 border-l border-slate-700/60 overflow-y-auto",
          "transform transition-transform duration-300 ease-in-out",
          open ? "translate-x-0" : "translate-x-full"
        )}
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/50 bg-space-800/60">
          <div className="flex items-center gap-2">
            {detailScan && (
              <button
                onClick={() => { setDetailScan(null); setDetailEvents([]); }}
                className="p-1 rounded text-slate-400 hover:text-slate-200 transition"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <History className="w-5 h-5 text-blue-400" />
            <h2 className="text-base font-bold text-slate-100">
              {detailScan
                ? `Scan #${detailScan.id} — ${detailScan.scanned_at.replace("T", " ").replace("Z", "")} UTC`
                : "Scan History"}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── Content ─────────────────────────────────────────────── */}
        <div className="px-6 py-4">

          {/* ── List view ── */}
          {!detailScan && (
            <>
              {loading && (
                <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                  <span className="text-sm">Loading history…</span>
                </div>
              )}

              {error && !loading && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
                  {error}
                </div>
              )}

              {!loading && !error && scans.length === 0 && (
                <p className="text-sm text-slate-500 py-8 text-center">
                  No scan history yet. Run a scan to start recording.
                </p>
              )}

              {!loading && scans.map((scan) => (
                <button
                  key={scan.id}
                  onClick={() => openDetail(scan)}
                  className="w-full flex items-center justify-between px-4 py-3 mb-2 rounded-lg border border-slate-700/50 bg-space-800/60 hover:bg-space-800 hover:border-blue-500/40 transition text-left group"
                >
                  <div>
                    <div className="text-sm font-medium text-slate-200">
                      Scan #{scan.id}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {scan.scanned_at.replace("T", " ").replace("Z", " UTC")}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold text-blue-400 bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 rounded">
                      {scan.event_count} event{scan.event_count !== 1 ? "s" : ""}
                    </span>
                    <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-blue-400 transition" />
                  </div>
                </button>
              ))}
            </>
          )}

          {/* ── Detail view ── */}
          {detailScan && (
            <>
              {detailLoading && (
                <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                  <span className="text-sm">Loading events…</span>
                </div>
              )}

              {detailError && !detailLoading && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
                  {detailError}
                </div>
              )}

              {!detailLoading && detailEvents.length > 0 && (
                <>
                  <button
                    onClick={() => { onLoadScan(detailEvents); onClose(); }}
                    className="w-full mb-4 py-2 rounded-lg bg-blue-500/10 border border-blue-500/40 text-blue-400 text-sm font-medium hover:bg-blue-500/20 transition"
                  >
                    Load into Dashboard
                  </button>
                  <div className="space-y-2">
                    {detailEvents.map((evt, idx) => {
                      const tier = getRiskTier(evt.pc_value);
                      const tierColour =
                        tier === "CRITICAL" ? "text-red-400" :
                        tier === "HIGH" ? "text-orange-400" :
                        tier === "ELEVATED" ? "text-yellow-400" : "text-green-400";
                      return (
                        <div
                          key={idx}
                          className="px-3 py-2.5 rounded-lg border border-slate-700/50 bg-space-800/60 text-xs"
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-medium text-slate-200">{evt.sat_name}</span>
                            <span className={clsx("font-mono font-semibold", tierColour)}>
                              {formatPc(evt.pc_value)}
                            </span>
                          </div>
                          <div className="text-slate-500">
                            vs {evt.secondary_name} · {evt.miss_distance_km.toFixed(2)} km miss
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
