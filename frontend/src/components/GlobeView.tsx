"use client";

/**
 * GlobeView.tsx — Three.js 3-D Earth globe + magnified encounter inset
 *
 * Two-level visualization:
 *   1. True-position globe marker — the conjunction midpoint is plotted at its
 *      real TCA lat/lon.  At Earth scale, 0.40 km separation is sub-pixel;
 *      one glyph per pair avoids overlap.
 *
 *   2. Magnified encounter inset (Canvas 2-D) — always shows two clearly
 *      separated and labelled objects connected by a bright red dashed line.
 *      Labelled "Encounter geometry magnified — not to scale".
 *      No approach-direction arrows are drawn because scalar relative speed
 *      alone does not determine 3-D approach direction.
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

// ── helpers ───────────────────────────────────────────────────────────────────

/** lat/lon (deg) + altKm → Three.js XYZ on the scaled globe sphere */
function geoToVec3(lat: number, lon: number, altKm: number): THREE.Vector3 {
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
function geoMidpoint(
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
function noradToLatLon(id: number): [number, number] {
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
const RISK_COLOUR: Record<string, number> = {
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

// ── props ─────────────────────────────────────────────────────────────────────
interface GlobeViewProps {
  events: ConjunctionEvent[];
  selectedEvent?: ConjunctionEvent | null;
  /** Called when the operator closes the inset (clears click-lock) */
  onCloseInset?: () => void;
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
export default function GlobeView({ events, selectedEvent, onCloseInset }: GlobeViewProps) {
  const mountRef    = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const frameRef    = useRef<number>(0);

  // Hold latest selectedEvent in a ref so the animation loop and overlay
  // update function can access it without triggering scene recreation.
  const selectedEventRef = useRef<ConjunctionEvent | null | undefined>(selectedEvent);
  selectedEventRef.current = selectedEvent;

  // selGroupRef lets the overlay-update effect reach the Three.js group
  // that was created in the scene-setup effect.
  const selGroupRef    = useRef<THREE.Group | null>(null);
  // Expose the buildOverlay function so the second effect can call it.
  const buildOverlayFn = useRef<((evt: ConjunctionEvent | null | undefined) => void) | null>(null);

  // Camera snap target shared between Effect 1 (writes initial value,
  // reads every animation frame) and Effect 2 (writes when selectedEvent
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

    const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
    sunLight.position.set(5, 3, 5);
    scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x1a2a4a, 1.2));

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
    group.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.18 })));

    // Earth sphere
    group.add(new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 64),
      new THREE.MeshPhongMaterial({
        color: 0x1a4fa8, emissive: 0x0a1f50,
        specular: 0x3a7bd5, shininess: 60,
      })
    ));

    // Continent patches
    const cMat = new THREE.MeshPhongMaterial({ color: 0x2d6a2d, emissive: 0x0f2b0f, shininess: 10 });
    ([ [40,-100,50,65],[-15,-55,45,45],[10,20,60,40],[50,20,40,60],[30,80,40,60],[-25,135,30,30] ] as
      [number,number,number,number][]).forEach(([lat, lon, latS, lonS]) => {
      group.add(new THREE.Mesh(
        new THREE.SphereGeometry(1.001, 8, 8,
          (lon * DEG) + Math.PI, lonS * DEG,
          (90 - lat - latS / 2) * DEG, latS * DEG),
        cMat
      ));
    });

    // Atmosphere
    group.add(new THREE.Mesh(
      new THREE.SphereGeometry(1.06, 32, 32),
      new THREE.MeshPhongMaterial({
        color: 0x4488cc, transparent: true, opacity: 0.12,
        side: THREE.FrontSide, depthWrite: false,
      })
    ));

    // LEO reference ring
    const leoRing = new THREE.Mesh(
      new THREE.TorusGeometry(1.18, 0.003, 4, 120),
      new THREE.MeshBasicMaterial({ color: 0x334466, transparent: true, opacity: 0.4 })
    );
    leoRing.rotation.x = Math.PI / 2;
    group.add(leoRing);

    // Background satellite dots
    const satGeo = new THREE.SphereGeometry(0.008, 6, 6);
    const satMat = new THREE.MeshBasicMaterial({ color: 0x94a3b8 });
    for (let i = 0; i < 60; i++) {
      const dot = new THREE.Mesh(satGeo, satMat);
      dot.position.copy(geoToVec3(Math.random() * 160 - 80, Math.random() * 360 - 180, 400));
      group.add(dot);
    }

    // Conjunction event nodes — single midpoint glyph per pair
    const eventNodes: THREE.Mesh[] = [];
    events.slice(0, 60).forEach((evt) => {
      const tier   = getRiskTier(evt.pc_value);
      const colour = RISK_COLOUR[tier] ?? 0xffffff;

      const pLat = evt.primary_lat    ?? noradToLatLon(evt.norad_id)[0];
      const pLon = evt.primary_lon    ?? noradToLatLon(evt.norad_id)[1];
      const pAlt = evt.primary_alt_km ?? 400;
      const sLat = evt.secondary_lat    ?? noradToLatLon(evt.secondary_norad_id)[0];
      const sLon = evt.secondary_lon    ?? noradToLatLon(evt.secondary_norad_id)[1];
      const sAlt = evt.secondary_alt_km ?? 400;

      // Use 3-D unit-vector midpoint to avoid antimeridian averaging error
      const [midLat, midLon] = geoMidpoint(pLat, pLon, sLat, sLon);
      const midAlt = (pAlt + sAlt) / 2;

      const node = new THREE.Mesh(
        new THREE.SphereGeometry(0.018, 8, 8),
        new THREE.MeshBasicMaterial({ color: colour })
      );
      node.position.copy(geoToVec3(midLat, midLon, midAlt));
      node.userData = { basePc: evt.pc_value, phase: Math.random() * Math.PI * 2 };
      group.add(node);
      eventNodes.push(node);

      const arcPts: THREE.Vector3[] = [];
      for (let a = 0; a <= 360; a += 4) {
        arcPts.push(geoToVec3(midLat * Math.cos(a * DEG * 0.5), midLon + a * 0.6, midAlt));
      }
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(arcPts),
        new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.18 })
      ));
    });

    // Selected-conjunction overlay group (updated without scene recreation)
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

      const core = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 12), overlayMat(0xffffff));
      core.position.copy(midPos);
      core.renderOrder = 999;
      selGroup.add(core);

      const halo = new THREE.Mesh(new THREE.SphereGeometry(0.062, 14, 14), overlayMat(pColour, 0.7));
      (halo.material as THREE.MeshBasicMaterial).wireframe = true;
      halo.position.copy(midPos);
      halo.renderOrder = 999;
      halo.userData.isHalo = true;
      selGroup.add(halo);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.080, 0.010, 8, 48),
        overlayMat(pColour, 0.95)
      );
      ring.position.copy(midPos);
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), midPos.clone().normalize());
      ring.renderOrder = 999;
      ring.userData.isPulseRing = true;
      selGroup.add(ring);

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

    // Expose to the selectedEvent effect
    buildOverlayFn.current = buildOverlay;

    // Draw initial overlay from the current ref value
    buildOverlay(selectedEventRef.current);

    // Point snap ref at the shared object — read by animation loop each frame.
    // This avoids storing snap state on the Three.js group (which would require
    // casting through _snapTarget and is unreliable across effect teardowns).
    const snap = snapRef.current;

    // Compute initial snap from current selectedEvent ref
    const initEvt = selectedEventRef.current;
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

      if (!isDragging) {
        if (snap.active) {
          group.rotation.y += (snap.rotY - group.rotation.y) * 0.05;
          group.rotation.x += (snap.rotX - group.rotation.x) * 0.05;
        } else {
          group.rotation.y += 0.0015;
        }
      }

      eventNodes.forEach((node) => {
        const { basePc, phase } = node.userData as { basePc: number; phase: number };
        const tier = getRiskTier(basePc);
        if (tier === "CRITICAL" || tier === "HIGH") {
          node.scale.setScalar(1 + 0.35 * Math.sin(t * 3 + phase));
        }
      });

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
      renderer.dispose();
      buildOverlayFn.current = null;
      selGroupRef.current    = null;
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, [events]); // ← only `events`; selectedEvent changes do NOT recreate the scene

  // ── Effect 2: update overlay when selectedEvent changes (no scene rebuild) ──
  useEffect(() => {
    // Update the encounter overlay (canvas 2-D inset is handled by React
    // rendering EncounterInset below; this updates the Three.js globe glyph).
    if (buildOverlayFn.current) {
      buildOverlayFn.current(selectedEvent);
    }

    // Update camera snap target via the shared ref — directly accessible from
    // both this effect and the animation loop without any scene traversal.
    if (selectedEvent) {
      const pLat = selectedEvent.primary_lat   ?? noradToLatLon(selectedEvent.norad_id)[0];
      const pLon = selectedEvent.primary_lon   ?? noradToLatLon(selectedEvent.norad_id)[1];
      const sLat = selectedEvent.secondary_lat ?? noradToLatLon(selectedEvent.secondary_norad_id)[0];
      const sLon = selectedEvent.secondary_lon ?? noradToLatLon(selectedEvent.secondary_norad_id)[1];
      const [midLat, midLon] = geoMidpoint(pLat, pLon, sLat, sLon);
      snapRef.current.rotY   = -(midLon * DEG) - Math.PI / 2;
      snapRef.current.rotX   = -(midLat * DEG) * 0.7;
      snapRef.current.active = true;
    } else {
      snapRef.current.active = false;
    }
  }, [selectedEvent]);

  return (
    <div className="w-full h-full flex flex-col">
      <div
        ref={mountRef}
        className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
        style={{ minHeight: "280px" }}
      />

      {selectedEvent && (
        <div className="px-3 pb-3 pt-2 bg-space-950/80 border-t border-red-900/30 shrink-0">
          <EncounterInset
            event={selectedEvent}
            locked={true}
            onClose={onCloseInset}
          />
        </div>
      )}
    </div>
  );
}
