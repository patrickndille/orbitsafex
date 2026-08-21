"use client";

/**
 * TriageDrawer.tsx
 * Slide-in side-panel that shows AI evasive maneuver recommendations.
 * Triggers POST /api/triage when opened.
 */

import { useEffect, useState } from "react";
import { X, AlertTriangle, Zap, Loader2, RefreshCw } from "lucide-react";
import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Components } from "react-markdown";
import type { ConjunctionEvent, TriageResponse } from "@/lib/types";
import { getRiskTier, formatPc } from "@/lib/types";
import { requestTriage } from "@/lib/api";

interface Props {
  event: ConjunctionEvent | null;
  onClose: () => void;
}

const TIER_COLOUR: Record<string, string> = {
  CRITICAL: "text-red-400 border-red-500/50 bg-red-500/10",
  HIGH:     "text-orange-400 border-orange-500/50 bg-orange-500/10",
  ELEVATED: "text-yellow-400 border-yellow-500/50 bg-yellow-500/10",
  MONITOR:  "text-green-400 border-green-500/50 bg-green-500/10",
};

const TIER_GLOW: Record<string, string> = {
  CRITICAL: "shadow-[0_0_30px_rgba(239,68,68,0.15)]",
  HIGH:     "shadow-[0_0_30px_rgba(249,115,22,0.12)]",
  ELEVATED: "shadow-[0_0_30px_rgba(234,179,8,0.10)]",
  MONITOR:  "",
};

// ── Markdown component overrides — dark-theme styled ─────────────────────────
const MARKDOWN_COMPONENTS: Components = {
  // Paragraphs — standard spacing
  p: ({ children }) => (
    <p className="mb-3 last:mb-0 text-slate-200 leading-relaxed">{children}</p>
  ),
  // Bold
  strong: ({ children }) => (
    <strong className="font-semibold text-slate-100">{children}</strong>
  ),
  // Italic
  em: ({ children }) => (
    <em className="italic text-slate-300">{children}</em>
  ),
  // Unordered list
  ul: ({ children }) => (
    <ul className="mb-3 space-y-1 pl-4 list-disc marker:text-slate-500">{children}</ul>
  ),
  // Ordered list
  ol: ({ children }) => (
    <ol className="mb-3 space-y-1 pl-4 list-decimal marker:text-slate-500">{children}</ol>
  ),
  // List item
  li: ({ children }) => (
    <li className="text-slate-200 leading-relaxed pl-1">{children}</li>
  ),
  // H1–H3 headings (LLM occasionally uses these for section headers)
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-base font-bold text-slate-100 border-b border-slate-700/60 pb-1">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-1.5 text-sm font-bold text-slate-100">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1 text-sm font-semibold text-blue-300">{children}</h3>
  ),
  // Inline code
  code: ({ children, className }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code className="block bg-space-950/80 border border-slate-700/60 rounded-md px-3 py-2 text-xs font-mono text-green-300 overflow-x-auto my-2">
          {children}
        </code>
      );
    }
    return (
      <code className="bg-slate-700/60 rounded px-1 py-0.5 text-xs font-mono text-green-300">
        {children}
      </code>
    );
  },
  // Fenced code block wrapper — strip the pre since code handles it
  pre: ({ children }) => <>{children}</>,
  // Horizontal rule
  hr: () => <hr className="my-3 border-slate-700/60" />,
  // Blockquote
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-blue-500/50 pl-3 my-2 text-slate-400 italic">
      {children}
    </blockquote>
  ),
};

export default function TriageDrawer({ event, onClose }: Props) {
  const [result, setResult] = useState<TriageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTriage = async (evt: ConjunctionEvent) => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await requestTriage({
        sat_name: evt.sat_name,
        norad_id: evt.norad_id,
        miss_distance_km: evt.miss_distance_km,
        relative_velocity_kms: evt.relative_velocity_kms,
        pc_value: evt.pc_value,
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Auto-fetch when a new event is selected
  useEffect(() => {
    if (event) {
      setResult(null);
      setError(null);
      fetchTriage(event);
    }
  }, [event?.norad_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isOpen = event !== null;
  const tier = event ? getRiskTier(event.pc_value) : "MONITOR";

  return (
    <>
      {/* Backdrop — no blur so the globe stays readable behind the drawer */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Drawer panel */}
      <aside
        className={clsx(
          "fixed top-0 right-0 h-full w-full max-w-[520px] z-50",
          "bg-space-900 border-l border-slate-700/60 overflow-y-auto",
          "transform transition-transform duration-300 ease-in-out",
          TIER_GLOW[tier],
          isOpen ? "translate-x-0" : "translate-x-full"
        )}
      >
        {event && (
          <div className="flex flex-col h-full">
            {/* ── Header ──────────────────────────────────────────── */}
            <div className={clsx("px-6 py-4 border-b border-slate-700/50", TIER_COLOUR[tier].split(" ").slice(2).join(" "))}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className={clsx("w-5 h-5", TIER_COLOUR[tier].split(" ")[0])} />
                    <span className={clsx("text-xs font-bold uppercase tracking-widest px-2 py-0.5 rounded border", TIER_COLOUR[tier])}>
                      {tier}
                    </span>
                  </div>
                  <h2 className="text-lg font-bold text-slate-100 leading-tight">
                    {event.sat_name}
                  </h2>
                  <p className="text-sm text-slate-400">
                    NORAD #{event.norad_id} · Conjunction Triage
                  </p>
                </div>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition mt-0.5"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* ── Metrics grid ────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-3 px-6 py-4 border-b border-slate-700/50">
              <MetricCard
                label="Screening Pc (est.)"
                value={formatPc(event.pc_value)}
                sub="σ=200 m assumed — not CDM-quality"
                highlight={tier !== "MONITOR"}
                highlightClass={TIER_COLOUR[tier].split(" ")[0]}
              />
              <MetricCard
                label="Predicted Miss Distance"
                value={`${event.miss_distance_km.toFixed(2)} km`}
                sub="at TCA"
              />
              <MetricCard
                label="Relative Velocity"
                value={`${event.relative_velocity_kms.toFixed(3)} km/s`}
                sub="at TCA"
              />
              <MetricCard
                label="Secondary Object"
                value={event.secondary_name}
                sub={`#${event.secondary_norad_id}`}
              />
              <MetricCard
                label="Time of Closest Approach (TCA)"
                value={new Date(event.tca_iso).toUTCString().substring(0, 25)}
                sub="UTC"
                fullWidth
              />
            </div>

            {/* ── Pc disclaimer ───────────────────────────────────── */}
            <div className="mx-6 my-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
              <strong>Screening estimate only.</strong> This Pc uses an assumed
              isotropic σ=200 m and a simplified Gaussian integral.
              It is <em>not</em> equivalent to a CDM-quality operational probability.
              Authoritative maneuver decisions require object-specific covariance
              data and review by a qualified flight-dynamics team.
            </div>

            {/* ── AI recommendation ───────────────────────────────── */}
            <div className="flex-1 px-6 py-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-300">
                  <Zap className="w-4 h-4 text-blue-400" />
                  AI Evasive Maneuver Recommendation
                </div>
                {!loading && (
                  <button
                    onClick={() => fetchTriage(event)}
                    className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-400 transition"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Refresh
                  </button>
                )}
              </div>

              {loading && (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-slate-500">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                  <span className="text-sm">Consulting AI operations assistant…</span>
                </div>
              )}

              {error && !loading && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
                  <p className="font-semibold mb-1">Triage request failed</p>
                  <p className="font-mono text-xs text-red-400">{error}</p>
                  <button
                    onClick={() => fetchTriage(event)}
                    className="mt-3 text-xs text-red-400 hover:text-red-200 underline"
                  >
                    Retry
                  </button>
                </div>
              )}

              {result && !loading && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-slate-700/60 bg-space-800/60 p-4">
                    <div className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wide">
                      Operations Summary
                    </div>
                    <div className="triage-prose text-sm text-slate-200 leading-relaxed">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={MARKDOWN_COMPONENTS}
                      >
                        {result.summary}
                      </ReactMarkdown>
                    </div>
                  </div>
                  <p className="text-xs text-slate-600 italic">
                    ⚠ AI recommendations are advisory only. Authoritative
                    maneuver decisions require object-specific covariance/CDM
                    data and review by a qualified flight-dynamics team.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

// ── Small metric card ────────────────────────────────────────────────────────
function MetricCard({
  label,
  value,
  sub,
  highlight,
  highlightClass,
  fullWidth,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  highlightClass?: string;
  fullWidth?: boolean;
}) {
  return (
    <div
      className={clsx(
        "bg-space-800/60 rounded-lg border border-slate-700/50 px-3 py-2.5",
        fullWidth && "col-span-2"
      )}
    >
      <div className="text-xs text-slate-500 mb-0.5">{label}</div>
      <div
        className={clsx(
          "font-mono font-semibold text-sm truncate",
          highlight && highlightClass ? highlightClass : "text-slate-200"
        )}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-slate-600">{sub}</div>}
    </div>
  );
}
