"use client";

/**
 * GlobeView.tsx — Three.js 3-D Earth globe + magnified encounter inset
 *
 * Two-level visualization:
 *   1. Persistent midpoint markers — every conjunction event receives one
 *      InstancedMesh instance positioned at the event's geographic midpoint
 *      (average lat/lon of primary and secondary at each event's own TCA).
 *      At Earth scale a 0.40 km object separation is sub-pixel; one marker
 *      per event pair avoids overlap and accurately represents the data.
 *
 *      Markers are NOT a simultaneous orbital snapshot. Each event's position
 *      was evaluated at that event's own TCA. Different events have different
 *      TCAs; combining them on one globe is a multi-epoch composite used
 *      only for situational awareness, not for orbital mechanics.
 *
 *   2. Magnified encounter inset (Canvas 2-D) — shows the primary and
 *      secondary objects at a readable pixel separation (~180 px) connected
 *      by a red dashed line. Labelled "Encounter geometry magnified — not to
 *      scale". Separate PRIMARY/SECONDARY labels and NORAD IDs are provided
 *      here because on the globe they would overlap at true Earth scale.
 *
 * Scene re-creation strategy:
 *   The Three.js effect depends only on `events` (the static list).
 *   The selected-event overlay is updated via a React ref so that hovering
 *   or clicking a row does NOT recreate the entire scene.
 *
 * NOTE: Globe auto-spin is a cosmetic display effect only.
 *       It does NOT represent the passage of orbital time or satellite motion.
 */

import { useEffect, useRef, useCallback } from "react";
import { X } from "lucide-react";
import * as THREE from "three";
import type { ConjunctionEvent } from "@/lib/types";
import { getRiskTier } from "@/lib/types";

// ── constants ─────────────────────────────────────────────────────────────────
const DEG        = Math.PI / 180;
const R_EARTH_KM = 6371;

/**
 * Maximum number of context arc lines rendered across all events.
 * Priority: CRITICAL → HIGH → ELEVATED → top MONITOR by descending Pc.
 * Lines are decorative only; they do NOT represent propagated trajectories.
 */
export const MAX_CONTEXT_LINES = 60;

// ── helpers ───────────────────────────────────────────────────────────────────

/** lat/lon (deg) + altKm → Three.js XYZ on the scaled globe sphere */
export function geoToVec3(lat: number, lon: number, altKm: number): THREE.Vector3 {
  const r     = 1 + (altKm / R_EARTH_KM) * 0.8 + 0.06;
  const phi   = (90 - lat)  * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta)
  );
}

/**
 * Geographic midpoint via 3-D unit-vector average.
 * This correctly handles antimeridian crossing (e.g. 179.9° and -179.9°)
 * where simple arithmetic averaging would give 0° instead of ±180°.
 */
export function geoMidpoint(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): [number, number] {
  const toXYZ = (latDeg: number, lonDeg: number): [number, number, number] => {
    const la = latDeg * DEG;
    const lo = lonDeg * DEG;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  const [x1, y1, z1] = toXYZ(lat1, lon1);
  const [x2, y2, z2] = toXYZ(lat2, lon2);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const mz = (z1 + z2) / 2;
  const r = Math.sqrt(mx * mx + my * my + mz * mz);
  if (r < 1e-10) return [(lat1 + lat2) / 2, (lon1 + lon2) / 2]; // antipodal fallback
  const midLat = Math.asin(mz / r) / DEG;
  const midLon = Math.atan2(my, mx) / DEG;
  return [midLat, midLon];
}

/** Deterministic pseudo-random lat/lon from NORAD ID — positional fallback */
export function noradToLatLon(id: number): [number, number] {
  const seed = id * 0.6180339887;
  return [
    (((seed * 127.3) % 1) * 160) - 80,
    (((seed * 311.7) % 1) * 360) - 180,
  ];
}

/** 80-segment great-circle arc at radius r between two unit-sphere vectors */
function greatCircleArc(a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.Vector3[] {
  const ua = a.clone().normalize();
  const ub = b.clone().normalize();
  return Array.from({ length: 81 }, (_, i) =>
    ua.clone().lerp(ub, i / 80).normalize().multiplyScalar(r)
  );
}

function buildArcTube(
  posA: THREE.Vector3,
  posB: THREE.Vector3,
  arcR: number,
  colour: number,
  opacity: number,
  tubeRadius = 0.006
): THREE.Mesh {
  const pts  = greatCircleArc(posA, posB, arcR);
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo   = new THREE.TubeGeometry(curve, 80, tubeRadius, 6, false);
  const mat   = new THREE.MeshBasicMaterial({
    color:       colour,
    transparent: true,
    opacity,
    depthTest:   false,
    depthWrite:  false,
    side:        THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 999;
  return mesh;
}

// ── risk colours ──────────────────────────────────────────────────────────────
export const RISK_COLOUR: Record<string, number> = {
  CRITICAL: 0xef4444,
  HIGH:     0xf97316,
  ELEVATED: 0xeab308,
  MONITOR:  0x22c55e,
};

const RISK_CSS: Record<string, string> = {
  CRITICAL: "#ef4444",
  HIGH:     "#f97316",
  ELEVATED: "#eab308",
  MONITOR:  "#22c55e",
};

// ── marker data preparation ───────────────────────────────────────────────────

/**
 * Compute the world-space position for a conjunction event's midpoint marker.
 * Exported for unit testing without a WebGL context.
 */
export function eventMarkerPosition(evt: ConjunctionEvent): THREE.Vector3 {
  const pLat = evt.primary_lat    ?? noradToLatLon(evt.norad_id)[0];
  const pLon = evt.primary_lon    ?? noradToLatLon(evt.norad_id)[1];
  const pAlt = evt.primary_alt_km ?? 400;
  const sLat = evt.secondary_lat    ?? noradToLatLon(evt.secondary_norad_id)[0];
  const sLon = evt.secondary_lon    ?? noradToLatLon(evt.secondary_norad_id)[1];
  const sAlt = evt.secondary_alt_km ?? 400;
  const [midLat, midLon] = geoMidpoint(pLat, pLon, sLat, sLon);
  const midAlt = (pAlt + sAlt) / 2;
  return geoToVec3(midLat, midLon, midAlt);
}

/**
 * Group events by risk tier, returning a plain count map.
 * This pure function is exported for unit testing without any WebGL calls.
 */
export function countEventsByTier(events: ConjunctionEvent[]): Record<string, number> {
  const counts: Record<string, number> = {
    CRITICAL: 0, HIGH: 0, ELEVATED: 0, MONITOR: 0,
  };
  for (const evt of events) {
    const tier = getRiskTier(evt.pc_value);
    counts[tier] = (counts[tier] ?? 0) + 1;
  }
  return counts;
}

/**
 * Build one InstancedMesh per risk tier and add them to the scene group.
 * Returns the created meshes and the total instance count (= events.length).
 * Uses normal depth testing so far-side markers are correctly occluded.
 */
export function buildInstancedMarkers(
  events: ConjunctionEvent[],
  scene: THREE.Group
): { meshes: THREE.InstancedMesh[]; count: number } {
  const TIERS = ["CRITICAL", "HIGH", "ELEVATED", "MONITOR"] as const;
  const byTier: Record<string, ConjunctionEvent[]> = {
    CRITICAL: [], HIGH: [], ELEVATED: [], MONITOR: [],
  };
  for (const evt of events) {
    const tier = getRiskTier(evt.pc_value);
    byTier[tier].push(evt);
  }

  // Low-poly octahedron as marker geometry — 8 triangles, minimal vertex count
  const markerGeo = new THREE.OctahedronGeometry(0.013, 0);
  const dummy = new THREE.Object3D();
  const meshes: THREE.InstancedMesh[] = [];
  let totalCount = 0;

  for (const tier of TIERS) {
    const tierEvents = byTier[tier];
    if (tierEvents.length === 0) continue;

    const colour = RISK_COLOUR[tier];
    const mat = new THREE.MeshBasicMaterial({ color: colour });
    const iMesh = new THREE.InstancedMesh(markerGeo, mat, tierEvents.length);
    iMesh.frustumCulled = false; // keep all instances; Earth occludes far-side

    for (let i = 0; i < tierEvents.length; i++) {
      const pos = eventMarkerPosition(tierEvents[i]);
      dummy.position.copy(pos);
      dummy.updateMatrix();
      iMesh.setMatrixAt(i, dummy.matrix);
    }
    iMesh.instanceMatrix.needsUpdate = true;
    scene.add(iMesh);
    meshes.push(iMesh);
    totalCount += tierEvents.length;
  }

  // The shared markerGeo is referenced by all InstancedMeshes;
  // each mesh holds its own reference so we do not dispose here.
  return { meshes, count: totalCount };
}

/**
 * Select the top-priority events for context arc lines.
 * Returns at most MAX_CONTEXT_LINES events, prioritised by tier then Pc.
 * Line sampling DOES NOT reduce the persistent marker count.
 */
export function selectLineEvents(events: ConjunctionEvent[]): ConjunctionEvent[] {
  const TIER_RANK: Record<string, number> = {
    CRITICAL: 0, HIGH: 1, ELEVATED: 2, MONITOR: 3,
  };
  const sorted = [...events].sort((a, b) => {
    const ta = TIER_RANK[getRiskTier(a.pc_value)] ?? 4;
    const tb = TIER_RANK[getRiskTier(b.pc_value)] ?? 4;
    if (ta !== tb) return ta - tb;
    return b.pc_value - a.pc_value; // descending Pc within tier
  });
  return sorted.slice(0, MAX_CONTEXT_LINES);
}

// ── props ─────────────────────────────────────────────────────────────────────
interface GlobeViewProps {
  events: ConjunctionEvent[];
  /**
   * The event to display in the encounter inset — either hovered or selected.
   * When both exist, the parent passes `hoveredEvent ?? selectedEvent`.
   */
  focusEvent?: ConjunctionEvent | null;
  /**
   * The click-locked selection.  Used to decide whether to show the close
   * button and to keep the inset visible after mouse-leave.
   */
  lockedEvent?: ConjunctionEvent | null;
  /** Called when the operator dismisses the locked selection (× button). */
  onCloseLockedEvent?: () => void;
}

// ── EncounterInset — Canvas 2-D magnified encounter overlay ───────────────────
interface EncounterInsetProps {
  event: ConjunctionEvent;
  /** True when this event is click-locked (shows close button) */
  locked?: boolean;
  onClose?: () => void;
}

function EncounterInset({ event, locked, onClose }: EncounterInsetProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(2,7,18,0.92)";
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(239,68,68,0.6)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    const tier    = getRiskTier(event.pc_value);
    const riskCss = RISK_CSS[tier] ?? "#ef4444";

    const cx      = W / 2;
    const cy      = H / 2 - 10;
    const HALF_SEP = 90;
    const pX = cx - HALF_SEP;
    const sX = cx + HALF_SEP;
    const pY = cy;
    const sY = cy;

    // ── Red dashed connector ──────────────────────────────────────────────────
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = "#ff3030";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(pX + 14, pY);
    ctx.lineTo(sX - 14, sY);
    ctx.stroke();
    ctx.restore();

    // NOTE: No approach-direction arrows are drawn here.
    // Scalar relative speed (relative_velocity_kms) does not establish
    // the 3-D approach direction, so drawing arrows would be fabricated.

    // ── PRIMARY marker: white core + risk-colour ring ─────────────────────────
    ctx.beginPath();
    ctx.arc(pX, pY, 13, 0, Math.PI * 2);
    ctx.strokeStyle = riskCss;
    ctx.lineWidth   = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pX, pY, 9, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    // ── SECONDARY marker: cyan core + cyan ring ───────────────────────────────
    ctx.beginPath();
    ctx.arc(sX, sY, 11, 0, Math.PI * 2);
    ctx.strokeStyle = "#00e5ff";
    ctx.lineWidth   = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sX, sY, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#00e5ff";
    ctx.fill();

    // ── Object labels ─────────────────────────────────────────────────────────
    const pName = event.sat_name.length > 16
      ? event.sat_name.substring(0, 15) + "…"
      : event.sat_name;
    const sName = event.secondary_name.length > 16
      ? event.secondary_name.substring(0, 15) + "…"
      : event.secondary_name;

    ctx.font         = "bold 10px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";

    ctx.fillStyle = "#ffffff";
    ctx.fillText("PRIMARY", pX, pY - 26);
    ctx.font      = "9px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(pName, pX, pY - 16);
    ctx.fillText(`#${event.norad_id}`, pX, pY - 6);

    ctx.font      = "bold 10px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "#00e5ff";
    ctx.fillText("SECONDARY", sX, sY - 26);
    ctx.font      = "9px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(sName, sX, sY - 16);
    ctx.fillText(`#${event.secondary_norad_id}`, sX, sY - 6);

    // ── Metrics strip ─────────────────────────────────────────────────────────
    const metricsY = cy + 30;
    ctx.font         = "bold 11px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign    = "center";
    ctx.fillStyle    = riskCss;
    ctx.fillText(`Predicted miss: ${event.miss_distance_km.toFixed(2)} km`, cx, metricsY);

    const tcaStr = event.tca_iso
      ? `TCA: ${event.tca_iso.replace("T", " ").replace("Z", " UTC")}`
      : "";
    if (tcaStr) {
      ctx.font      = "10px 'Segoe UI', system-ui, sans-serif";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(tcaStr, cx, metricsY + 14);
    }

    // ── Tier badge ────────────────────────────────────────────────────────────
    const badgeW = 68;
    const badgeH = 18;
    const badgeX = cx - badgeW / 2;
    const badgeY = metricsY + 28;
    ctx.fillStyle   = riskCss + "30";
    ctx.strokeStyle = riskCss;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
    ctx.fill();
    ctx.stroke();
    ctx.font         = "bold 9px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle    = riskCss;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(tier, cx, badgeY + badgeH / 2);

    // ── Scale disclaimer ──────────────────────────────────────────────────────
    ctx.font         = "italic 8.5px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle    = "#475569";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Encounter geometry magnified — not to scale", cx, H - 10);

    // ── Title ─────────────────────────────────────────────────────────────────
    ctx.font         = "bold 9px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle    = "#64748b";
    ctx.textAlign    = "left";
    ctx.textBaseline = "top";
    ctx.fillText("CLOSE APPROACH DETAIL", 8, 7);
  }, [event]);

  useEffect(() => { draw(); }, [draw]);

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        width={420}
        height={200}
        className="w-full rounded-lg border border-red-900/40"
        style={{ display: "block" }}
      />
      {locked && onClose && (
        <button
          onClick={onClose}
          aria-label="Close encounter inset"
          className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center rounded bg-slate-800/80 border border-slate-600/60 text-slate-400 hover:text-slate-100 hover:bg-slate-700 transition"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// ── component ─────────────────────────────────────────────────────────────────
export default function GlobeView({
  events,
  focusEvent,
  lockedEvent,
  onCloseLockedEvent,
}: GlobeViewProps) {
  const mountRef    = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const frameRef    = useRef<number>(0);

  // focusEvent drives the Three.js globe overlay (glyph + arc).
  // We keep it in a ref so the animation loop and buildOverlay can read it
  // without being declared in the effect dependency array.
  const focusEventRef = useRef<ConjunctionEvent | null | undefined>(focusEvent);
  focusEventRef.current = focusEvent;

  // selGroupRef lets the overlay-update effect reach the Three.js group
  // that was created in the scene-setup effect.
  const selGroupRef    = useRef<THREE.Group | null>(null);
  // Expose the buildOverlay function so the second effect can call it.
  const buildOverlayFn = useRef<((evt: ConjunctionEvent | null | undefined) => void) | null>(null);

  // Camera snap target shared between Effect 1 (writes initial value,
  // reads every animation frame) and Effect 2 (writes when focusEvent
  // changes).  Using a plain object ref avoids any React re-render cost.
  const snapRef = useRef<{ rotY: number; rotX: number; active: boolean }>({
    rotY: 0, rotX: 0, active: false,
  });

  // ── Effect 1: build the static Three.js scene (depends only on `events`) ──
  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;
    const W = container.clientWidth  || 600;
    const H = container.clientHeight || 400;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020712);

    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 1000);
    camera.position.set(0, 0, 3.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Tuned lighting: directional "sun" + low ambient so the night side is
    // dark but not completely black and risk markers remain dominant.
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.8);
    sunLight.position.set(5, 3, 5);
    scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x1a2840, 0.6));

    const group = new THREE.Group();
    scene.add(group);

    // Stars
    const starVerts: number[] = [];
    for (let i = 0; i < 6000; i++) {
      const r  = 80 + Math.random() * 120;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      starVerts.push(
        r * Math.sin(ph) * Math.cos(th),
        r * Math.cos(ph),
        r * Math.sin(ph) * Math.sin(th)
      );
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.Float32BufferAttribute(starVerts, 3));
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.18 });
    group.add(new THREE.Points(starGeo, starMat));

    // ── Textured Earth ────────────────────────────────────────────────────────
    // Load textures via TextureLoader.  On failure we fall back to a plain
    // dark-blue material so the rest of the scene still renders correctly.
    const loader = new THREE.TextureLoader();
    const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    // Textures are tracked so they can be disposed on cleanup.
    const loadedTextures: THREE.Texture[] = [];

    const loadTex = (path: string, srgb = false): THREE.Texture | null => {
      try {
        const t = loader.load(
          path,
          undefined,
          undefined,
          (err) => {
            console.warn(`[GlobeView] Texture load failed: ${path}`, err);
          }
        );
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = maxAniso;
        loadedTextures.push(t);
        return t;
      } catch (err) {
        console.warn(`[GlobeView] TextureLoader threw for: ${path}`, err);
        return null;
      }
    };

    const dayTex  = loadTex("/textures/earth/earth-day.jpg",      true);
    const bumpTex = loadTex("/textures/earth/earth-bump.jpg",     false);
    const specTex = loadTex("/textures/earth/earth-specular.jpg", false);

    // Build the Earth material.  Falls back gracefully if textures are null
    // (texture load failures are caught above; Three.js accepts null for
    // optional map properties).
    const earthGeo = new THREE.SphereGeometry(1, 64, 64);
    const earthMat = new THREE.MeshPhongMaterial({
      map:       dayTex  ?? undefined,
      bumpMap:   bumpTex ?? undefined,
      bumpScale: 0.018,
      specularMap: specTex ?? undefined,
      specular:  new THREE.Color(0x4a7fb5),
      shininess: 28,
      // Fallback color shown while textures load or if they fail
      color: dayTex ? 0xffffff : 0x1a4fa8,
    });
    const earthMesh = new THREE.Mesh(earthGeo, earthMat);
    group.add(earthMesh);

    // ── Cloud layer ───────────────────────────────────────────────────────────
    // A second sphere slightly above the surface carries the cloud texture at
    // low opacity.  depthWrite: false prevents it from obscuring markers.
    // NOTE: cloud rotation is cosmetic only — not real weather or time.
    const cloudTex = loadTex("/textures/earth/earth-clouds.jpg", false);
    const cloudGeo = new THREE.SphereGeometry(1.010, 48, 48);
    const cloudMat = new THREE.MeshPhongMaterial({
      map:         cloudTex ?? undefined,
      alphaMap:    cloudTex ?? undefined,
      transparent: true,
      opacity:     0.30,
      depthWrite:  false,
      color:       0xffffff,
    });
    const cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
    group.add(cloudMesh);

    // ── Atmospheric rim (Fresnel-style ShaderMaterial) ────────────────────────
    // BackSide + additive blending creates a thin blue glow at the limb only.
    // Radius ≤ 1.03 and low peak alpha keep it as a subtle rim, not a haze.
    const atmosGeo = new THREE.SphereGeometry(1.03, 32, 32);
    const atmosMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          vNormal  = normalize(normalMatrix * normal);
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vViewDir = normalize(-mvPos.xyz);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          float rim = 1.0 - max(dot(vNormal, vViewDir), 0.0);
          rim = pow(rim, 4.5);
          gl_FragColor = vec4(0.20, 0.45, 0.85, rim * 0.25);
        }
      `,
      transparent: true,
      depthWrite:  false,
      side:        THREE.BackSide,
      blending:    THREE.AdditiveBlending,
    });
    const atmosMesh = new THREE.Mesh(atmosGeo, atmosMat);
    group.add(atmosMesh);

    // ── LEO reference ring ────────────────────────────────────────────────────
    const leoRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.18, 0.003, 4, 120),
      new THREE.MeshBasicMaterial({ color: 0x334466, transparent: true, opacity: 0.4 })
    );
    leoRing.rotation.x = Math.PI / 2;
    group.add(leoRing);

    // ── Persistent event markers (InstancedMesh per tier) ────────────────────
    // One octahedron instance per conjunction event, colored by risk tier.
    // Uses normal depth testing — far-side markers are correctly occluded.
    //
    // NOTE: These markers represent each event's conjunction location at that
    //       event's own TCA. They are NOT a simultaneous orbital snapshot;
    //       different events have different TCAs and the globe is a multi-epoch
    //       composite for situational awareness only.
    const { meshes: instancedMeshes, count: instancedCount } =
      buildInstancedMarkers(events, group);
    void instancedCount; // count available for diagnostics; not used at runtime

    // ── Context arc lines (limited subset only) ───────────────────────────────
    // Lines are decorative and do NOT represent propagated satellite trajectories.
    // Limited to MAX_CONTEXT_LINES to avoid visual clutter. Line sampling does
    // not reduce the persistent marker count above.
    const lineGeos: THREE.BufferGeometry[] = [];
    const lineMats: THREE.LineBasicMaterial[] = [];

    selectLineEvents(events).forEach((evt) => {
      const tier   = getRiskTier(evt.pc_value);
      const colour = RISK_COLOUR[tier] ?? 0xffffff;

      const pLat = evt.primary_lat    ?? noradToLatLon(evt.norad_id)[0];
      const pLon = evt.primary_lon    ?? noradToLatLon(evt.norad_id)[1];
      const pAlt = evt.primary_alt_km ?? 400;
      const sLat = evt.secondary_lat    ?? noradToLatLon(evt.secondary_norad_id)[0];
      const sLon = evt.secondary_lon    ?? noradToLatLon(evt.secondary_norad_id)[1];
      const sAlt = evt.secondary_alt_km ?? 400;

      const [midLat, midLon] = geoMidpoint(pLat, pLon, sLat, sLon);
      const midAlt = (pAlt + sAlt) / 2;

      const arcPts: THREE.Vector3[] = [];
      for (let a = 0; a <= 360; a += 4) {
        arcPts.push(geoToVec3(midLat * Math.cos(a * DEG * 0.5), midLon + a * 0.6, midAlt));
      }
      const lGeo = new THREE.BufferGeometry().setFromPoints(arcPts);
      const lMat = new THREE.LineBasicMaterial({
        color: colour, transparent: true, opacity: 0.18,
      });
      group.add(new THREE.Line(lGeo, lMat));
      lineGeos.push(lGeo);
      lineMats.push(lMat);
    });

    // ── Selected-conjunction overlay group ────────────────────────────────────
    // Updated without scene recreation via buildOverlayFn ref.
    // Shows temporary focus glyph + red true-position arc on hover/select;
    // cleared on mouse-leave if not click-locked.
    const selGroup = new THREE.Group();
    group.add(selGroup);
    selGroupRef.current = selGroup;

    const buildOverlay = (evt: ConjunctionEvent | null | undefined) => {
      selGroup.children.slice().forEach((c) => {
        const m = c as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose());
          else (m.material as THREE.Material).dispose();
        }
        selGroup.remove(c);
      });
      if (!evt) return;

      const tier    = getRiskTier(evt.pc_value);
      const pColour = RISK_COLOUR[tier] ?? 0xef4444;

      const pLat = evt.primary_lat    ?? noradToLatLon(evt.norad_id)[0];
      const pLon = evt.primary_lon    ?? noradToLatLon(evt.norad_id)[1];
      const pAlt = evt.primary_alt_km ?? 400;
      const sLat = evt.secondary_lat  ?? noradToLatLon(evt.secondary_norad_id)[0];
      const sLon = evt.secondary_lon  ?? noradToLatLon(evt.secondary_norad_id)[1];
      const sAlt = evt.secondary_alt_km ?? 400;

      // 3-D unit-vector midpoint — correct across the antimeridian
      const [midLat, midLon] = geoMidpoint(pLat, pLon, sLat, sLon);
      const midAlt = (pAlt + sAlt) / 2;
      const midPos = geoToVec3(midLat, midLon, midAlt);

      const overlayMat = (colour: number, opacity = 1.0) =>
        new THREE.MeshBasicMaterial({
          color: colour, transparent: true, opacity,
          depthTest: false, depthWrite: false,
        });

      // White core at conjunction midpoint
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 12), overlayMat(0xffffff));
      core.position.copy(midPos);
      core.renderOrder = 999;
      selGroup.add(core);

      // Risk-coloured wireframe halo
      const halo = new THREE.Mesh(new THREE.SphereGeometry(0.062, 14, 14), overlayMat(pColour, 0.7));
      (halo.material as THREE.MeshBasicMaterial).wireframe = true;
      halo.position.copy(midPos);
      halo.renderOrder = 999;
      halo.userData.isHalo = true;
      selGroup.add(halo);

      // Pulse ring
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.080, 0.010, 8, 48),
        overlayMat(pColour, 0.95)
      );
      ring.position.copy(midPos);
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), midPos.clone().normalize());
      ring.renderOrder = 999;
      ring.userData.isPulseRing = true;
      selGroup.add(ring);

      // Red arc — true-scale separation between primary and secondary at TCA.
      // At Earth scale the two endpoints will frequently appear coincident;
      // the magnified encounter inset shows the separation at readable scale.
      const posA = geoToVec3(pLat, pLon, pAlt);
      const posB = geoToVec3(sLat, sLon, sAlt);
      const arcR = Math.max(posA.length(), posB.length()) + 0.02;

      const arcTube = buildArcTube(posA, posB, arcR, 0xff3030, 1.0, 0.008);
      arcTube.userData.isArcTube = true;
      selGroup.add(arcTube);

      const glowTube = buildArcTube(posA, posB, arcR, 0xff6060, 0.35, 0.016);
      glowTube.userData.isGlowTube = true;
      selGroup.add(glowTube);
    };

    // Expose to the focusEvent effect
    buildOverlayFn.current = buildOverlay;

    // Draw initial overlay from the current ref value
    buildOverlay(focusEventRef.current);

    // Point snap ref at the shared object — read by animation loop each frame.
    const snap = snapRef.current;

    // Compute initial snap from current selectedEvent ref
    const initEvt = focusEventRef.current;
    if (initEvt) {
      const pLat = initEvt.primary_lat   ?? noradToLatLon(initEvt.norad_id)[0];
      const pLon = initEvt.primary_lon   ?? noradToLatLon(initEvt.norad_id)[1];
      const sLat = initEvt.secondary_lat ?? noradToLatLon(initEvt.secondary_norad_id)[0];
      const sLon = initEvt.secondary_lon ?? noradToLatLon(initEvt.secondary_norad_id)[1];
      const [midLat, midLon] = geoMidpoint(pLat, pLon, sLat, sLon);
      snap.rotY   = -(midLon * DEG) - Math.PI / 2;
      snap.rotX   = -(midLat * DEG) * 0.7;
      snap.active = true;
    }

    // Mouse drag
    let isDragging = false;
    let prevX = 0, prevY = 0;

    const onDown = (e: MouseEvent) => { isDragging = true; prevX = e.clientX; prevY = e.clientY; };
    const onUp   = () => { isDragging = false; };
    const onMove = (e: MouseEvent) => {
      if (!isDragging) return;
      group.rotation.y += (e.clientX - prevX) * 0.005;
      group.rotation.x += (e.clientY - prevY) * 0.003;
      group.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, group.rotation.x));
      snap.rotY = group.rotation.y;
      snap.rotX = group.rotation.x;
      prevX = e.clientX; prevY = e.clientY;
    };
    container.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mousemove", onMove);

    // ResizeObserver handles BOTH window resizes and container height changes
    // (e.g. EncounterInset mounting/unmounting changes the flex layout height).
    const onResize = () => {
      const { width, height } = container.getBoundingClientRect();
      if (width === 0 || height === 0) return; // ignore zero dims during transitions
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      // Keep the CSS canvas at 100% so it fills the div after resize
      renderer.domElement.style.width  = "100%";
      renderer.domElement.style.height = "100%";
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);
    // Also keep window resize for good measure (handles viewport scale changes)
    window.addEventListener("resize", onResize);

    // Animation loop
    // NOTE: auto-spin is cosmetic only — not time propagation.
    let t = 0;
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      t += 0.016;

      // Rotate cloud sphere extremely slowly relative to Earth (cosmetic only)
      cloudMesh.rotation.y = t * 0.0008;

      if (!isDragging) {
        if (snap.active) {
          group.rotation.y += (snap.rotY - group.rotation.y) * 0.05;
          group.rotation.x += (snap.rotX - group.rotation.x) * 0.05;
        } else {
          group.rotation.y += 0.0015;
        }
      }

      selGroup.children.forEach((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.userData?.isPulseRing) mesh.scale.setScalar(1 + 0.28 * Math.sin(t * 4.5));
        if (mesh.userData?.isHalo)
          (mesh.material as THREE.MeshBasicMaterial).opacity = 0.30 + 0.40 * Math.sin(t * 2.8);
        if (mesh.userData?.isGlowTube)
          (mesh.material as THREE.MeshBasicMaterial).opacity = 0.20 + 0.25 * Math.sin(t * 3.2);
        if (mesh.userData?.isArcTube)
          (mesh.material as THREE.MeshBasicMaterial).opacity = 0.80 + 0.20 * Math.sin(t * 5.0);
      });

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      container.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mousemove", onMove);

      // Dispose textures, geometries, and materials added by the texture upgrade
      loadedTextures.forEach((t) => t.dispose());
      earthGeo.dispose();
      earthMat.dispose();
      cloudGeo.dispose();
      cloudMat.dispose();
      atmosGeo.dispose();
      atmosMat.dispose();

      // Dispose instanced marker resources
      // Each mesh shares the same OctahedronGeometry, so only dispose the
      // geometry once (via the first mesh, if any exist).
      if (instancedMeshes.length > 0) {
        instancedMeshes[0].geometry.dispose();
      }
      instancedMeshes.forEach((m) => {
        (m.material as THREE.Material).dispose();
      });

      // Dispose context line resources
      lineGeos.forEach((g) => g.dispose());
      lineMats.forEach((m) => m.dispose());

      // Star resources
      starGeo.dispose();
      starMat.dispose();

      renderer.dispose();
      buildOverlayFn.current = null;
      selGroupRef.current    = null;
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, [events]); // ← only `events`; focusEvent changes do NOT recreate the scene

  // ── Effect 2: update Three.js globe glyph when focusEvent changes ────────────
  // React renders the EncounterInset overlay independently (see JSX below).
  useEffect(() => {
    if (buildOverlayFn.current) {
      buildOverlayFn.current(focusEvent);
    }

    // Camera snap follows focusEvent (hover preview or locked selection).
    if (focusEvent) {
      const pLat = focusEvent.primary_lat   ?? noradToLatLon(focusEvent.norad_id)[0];
      const pLon = focusEvent.primary_lon   ?? noradToLatLon(focusEvent.norad_id)[1];
      const sLat = focusEvent.secondary_lat ?? noradToLatLon(focusEvent.secondary_norad_id)[0];
      const sLon = focusEvent.secondary_lon ?? noradToLatLon(focusEvent.secondary_norad_id)[1];
      const [midLat, midLon] = geoMidpoint(pLat, pLon, sLat, sLon);
      snapRef.current.rotY   = -(midLon * DEG) - Math.PI / 2;
      snapRef.current.rotX   = -(midLat * DEG) * 0.7;
      snapRef.current.active = true;
    } else {
      snapRef.current.active = false;
    }
  }, [focusEvent]);

  // Determine if the currently displayed focusEvent is the click-locked one
  // (same pair by both NORAD IDs).
  const isLocked =
    !!lockedEvent &&
    !!focusEvent &&
    lockedEvent.norad_id === focusEvent.norad_id &&
    lockedEvent.secondary_norad_id === focusEvent.secondary_norad_id;

  return (
    /*
     * Positioned viewport: Three.js canvas is absolute-inset so it always
     * fills the full container — its height is NEVER changed by the overlay.
     * The EncounterInset is an absolute overlay anchored to the bottom of the
     * same container; it floats over the globe without affecting layout flow.
     */
    <div className="relative w-full h-full overflow-hidden">
      <div
        ref={mountRef}
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
      />

      {focusEvent && (
        <div
          className="absolute left-2 right-2 bottom-2 sm:left-3 sm:right-3 sm:bottom-3 z-20 pointer-events-none"
          data-testid="encounter-inset-wrapper"
        >
          {/* pointer-events-none on wrapper so globe drag works outside the card;
              pointer-events-auto restored on the card itself so buttons are clickable */}
          <div className="pointer-events-auto max-w-[480px] mx-auto">
            <EncounterInset
              event={focusEvent}
              locked={isLocked}
              onClose={isLocked ? onCloseLockedEvent : undefined}
            />
          </div>
        </div>
      )}
    </div>
  );
}
