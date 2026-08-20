"use client";

/**
 * GlobeView.tsx
 * Three.js 3-D Earth globe.
 *
 * Renders:
 *   • Procedural Earth sphere with specular/emissive shading
 *   • Atmosphere glow shell
 *   • Satellite position dots (representative background traffic)
 *   • Conjunction event nodes — colour-coded by risk tier, pulsing on CRITICAL/HIGH
 *   • Orbit-arc lines for flagged events
 *
 * When a conjunction event is selected:
 *   • Pulsing ring (torus) + wireframe halo sphere around both the primary
 *     and secondary object at their computed TCA lat/lon/alt
 *   • Bright red great-circle arc connecting the two targets
 *   • Camera group smoothly rotates to face the midpoint of the pair
 *
 * The component is dynamic-import only (no SSR) because Three.js
 * uses browser APIs.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { ConjunctionEvent } from "@/lib/types";
import { getRiskTier } from "@/lib/types";

// ── helpers ─────────────────────────────────────────────────────────────────
const DEG = Math.PI / 180;

/** Convert geographic lat/lon (degrees) + altitude (km) → Three.js XYZ.
 *  The globe uses R=1 for Earth surface; altitude scales proportionally. */
function geoToVec3(lat: number, lon: number, altKm: number): THREE.Vector3 {
  // Map real altitude to scene units: LEO ~400 km → r ≈ 1.063
  const R_EARTH_KM = 6371;
  const r = 1 + altKm / R_EARTH_KM;
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta)
  );
}

/** Deterministic pseudo-random lat/lon from a NORAD ID — fallback only */
function noradToLatLon(id: number): [number, number] {
  const seed = id * 0.6180339887;
  const lat = (((seed * 127.3) % 1) * 160) - 80;
  const lon = (((seed * 311.7) % 1) * 360) - 180;
  return [lat, lon];
}

/** Interpolate n points along the great circle between two unit vectors. */
function greatCirclePoints(a: THREE.Vector3, b: THREE.Vector3, n: number, r: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const ua = a.clone().normalize();
  const ub = b.clone().normalize();
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const v = ua.clone().lerp(ub, t).normalize().multiplyScalar(r);
    pts.push(v);
  }
  return pts;
}

// ── Risk colours ─────────────────────────────────────────────────────────────
const RISK_COLOUR: Record<string, number> = {
  CRITICAL: 0xef4444,
  HIGH:     0xf97316,
  ELEVATED: 0xeab308,
  MONITOR:  0x22c55e,
};

// ── Props ────────────────────────────────────────────────────────────────────
interface GlobeViewProps {
  events: ConjunctionEvent[];
  selectedEvent?: ConjunctionEvent | null;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function GlobeView({ events, selectedEvent }: GlobeViewProps) {
  const mountRef  = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const frameRef  = useRef<number>(0);

  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;
    const W = container.clientWidth;
    const H = container.clientHeight;

    // ── Scene ──────────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020712);

    // ── Camera ────────────────────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 1000);
    camera.position.set(0, 0, 3.2);

    // ── Renderer ──────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // ── Lights ────────────────────────────────────────────────────────────
    const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
    sunLight.position.set(5, 3, 5);
    scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x1a2a4a, 1.2));

    // ── Stars ─────────────────────────────────────────────────────────────
    const starGeo = new THREE.BufferGeometry();
    const starVerts: number[] = [];
    for (let i = 0; i < 6000; i++) {
      const r = 80 + Math.random() * 120;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starVerts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
      );
    }
    starGeo.setAttribute("position", new THREE.Float32BufferAttribute(starVerts, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.18 })));

    // ── Earth ─────────────────────────────────────────────────────────────
    const earthGeo = new THREE.SphereGeometry(1, 64, 64);
    const earthMat = new THREE.MeshPhongMaterial({
      color: 0x1a4fa8,
      emissive: 0x0a1f50,
      specular: 0x3a7bd5,
      shininess: 60,
    });
    const earth = new THREE.Mesh(earthGeo, earthMat);
    scene.add(earth);

    // land-mass approximation
    const continentMat = new THREE.MeshPhongMaterial({
      color: 0x2d6a2d,
      emissive: 0x0f2b0f,
      shininess: 10,
    });
    const continents: [number, number, number, number][] = [
      [40, -100, 50, 65],   // North America
      [-15, -55, 45, 45],   // South America
      [10, 20, 60, 40],     // Africa
      [50, 20, 40, 60],     // Europe/W. Asia
      [30, 80, 40, 60],     // Asia
      [-25, 135, 30, 30],   // Australia
    ];
    continents.forEach(([lat, lon, latS, lonS]) => {
      const geo = new THREE.SphereGeometry(1.001, 8, 8,
        (lon * DEG) + Math.PI, lonS * DEG,
        (90 - lat - latS / 2) * DEG, latS * DEG
      );
      scene.add(new THREE.Mesh(geo, continentMat));
    });

    // ── Atmosphere shell ──────────────────────────────────────────────────
    const atmGeo = new THREE.SphereGeometry(1.06, 32, 32);
    const atmMat = new THREE.MeshPhongMaterial({
      color: 0x4488cc,
      transparent: true,
      opacity: 0.12,
      side: THREE.FrontSide,
      depthWrite: false,
    });
    scene.add(new THREE.Mesh(atmGeo, atmMat));

    // ── LEO reference ring ────────────────────────────────────────────────
    const leoRingGeo = new THREE.TorusGeometry(1.18, 0.003, 4, 120);
    const leoRingMat = new THREE.MeshBasicMaterial({ color: 0x334466, opacity: 0.4, transparent: true });
    const leoRing = new THREE.Mesh(leoRingGeo, leoRingMat);
    leoRing.rotation.x = Math.PI / 2;
    scene.add(leoRing);

    // ── Background satellite dots ─────────────────────────────────────────
    const satDotGeo = new THREE.SphereGeometry(0.008, 6, 6);
    const satDotMat = new THREE.MeshBasicMaterial({ color: 0x94a3b8 });
    for (let i = 0; i < 60; i++) {
      const lat = Math.random() * 160 - 80;
      const lon = Math.random() * 360 - 180;
      const dot = new THREE.Mesh(satDotGeo, satDotMat);
      dot.position.copy(geoToVec3(lat, lon, 400));
      scene.add(dot);
    }

    // ── Conjunction event nodes ───────────────────────────────────────────
    const eventNodes: THREE.Mesh[] = [];
    events.slice(0, 60).forEach((evt) => {
      const tier  = getRiskTier(evt.pc_value);
      const colour = RISK_COLOUR[tier] ?? 0xffffff;
      const lat = evt.primary_lat  ?? noradToLatLon(evt.norad_id)[0];
      const lon = evt.primary_lon  ?? noradToLatLon(evt.norad_id)[1];
      const alt = evt.primary_alt_km ?? 400;

      const nodeGeo = new THREE.SphereGeometry(0.018, 8, 8);
      const nodeMat = new THREE.MeshBasicMaterial({ color: colour });
      const node    = new THREE.Mesh(nodeGeo, nodeMat);
      node.position.copy(geoToVec3(lat, lon, alt));
      node.userData = { id: evt.norad_id, basePc: evt.pc_value, phase: Math.random() * Math.PI * 2 };
      scene.add(node);
      eventNodes.push(node);

      // orbit arc suggestion
      const arcPoints: THREE.Vector3[] = [];
      for (let a = 0; a <= 360; a += 4) {
        arcPoints.push(geoToVec3(lat * Math.cos(a * DEG * 0.5), lon + a * 0.6, alt));
      }
      const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPoints);
      scene.add(new THREE.Line(arcGeo, new THREE.LineBasicMaterial({
        color: colour, transparent: true, opacity: 0.25,
      })));
    });

    // ── Selected conjunction overlay ──────────────────────────────────────
    // Objects that need to be removed/updated when selectedEvent changes
    const selGroup = new THREE.Group();
    scene.add(selGroup);

    const buildSelectionOverlay = (evt: ConjunctionEvent | null | undefined) => {
      // Clear previous overlay
      while (selGroup.children.length) selGroup.remove(selGroup.children[0]);
      if (!evt) return;

      const tier   = getRiskTier(evt.pc_value);
      const colour = RISK_COLOUR[tier] ?? 0xef4444;

      const pLat = evt.primary_lat   ?? noradToLatLon(evt.norad_id)[0];
      const pLon = evt.primary_lon   ?? noradToLatLon(evt.norad_id)[1];
      const pAlt = evt.primary_alt_km  ?? 400;
      const sLat = evt.secondary_lat ?? noradToLatLon(evt.secondary_norad_id)[0];
      const sLon = evt.secondary_lon ?? noradToLatLon(evt.secondary_norad_id)[1];
      const sAlt = evt.secondary_alt_km ?? 400;

      const posA = geoToVec3(pLat, pLon, pAlt);
      const posB = geoToVec3(sLat, sLon, sAlt);

      // Helper: add a pulsing ring + halo sphere at a position
      const addHighlight = (pos: THREE.Vector3, col: number) => {
        // Outer wireframe sphere (halo)
        const haloGeo = new THREE.SphereGeometry(0.045, 12, 12);
        const haloMat = new THREE.MeshBasicMaterial({
          color: col, wireframe: true, transparent: true, opacity: 0.55,
        });
        const halo = new THREE.Mesh(haloGeo, haloMat);
        halo.position.copy(pos);
        halo.userData.isHalo = true;
        selGroup.add(halo);

        // Equatorial ring (torus lying flat around the node)
        const ringGeo = new THREE.TorusGeometry(0.055, 0.006, 8, 40);
        const ringMat = new THREE.MeshBasicMaterial({
          color: col, transparent: true, opacity: 0.85,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(pos);
        // Orient the ring to face outward from Earth centre
        ring.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          pos.clone().normalize()
        );
        ring.userData.isPulseRing = true;
        selGroup.add(ring);

        // Bright core dot
        const coreGeo = new THREE.SphereGeometry(0.024, 8, 8);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
        const core    = new THREE.Mesh(coreGeo, coreMat);
        core.position.copy(pos);
        selGroup.add(core);
      };

      addHighlight(posA, colour);
      addHighlight(posB, 0xff2222); // secondary always red

      // Great-circle arc between the two objects
      const arcR   = (posA.length() + posB.length()) / 2;
      const arcPts = greatCirclePoints(posA, posB, 80, arcR);
      const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPts);
      const arcMat = new THREE.LineBasicMaterial({
        color: 0xff1111,
        transparent: true,
        opacity: 0.9,
        linewidth: 2,          // note: linewidth >1 only on WebGL2 with LineMaterial
      });
      selGroup.add(new THREE.Line(arcGeo, arcMat));

      // Dashed mid-point label sphere (bright white, slightly larger)
      const midPos = posA.clone().lerp(posB, 0.5).normalize().multiplyScalar(arcR);
      const midGeo = new THREE.SphereGeometry(0.012, 8, 8);
      const midMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const mid    = new THREE.Mesh(midGeo, midMat);
      mid.position.copy(midPos);
      selGroup.add(mid);
    };

    buildSelectionOverlay(selectedEvent);

    // ── Mouse drag rotation ───────────────────────────────────────────────
    let isDragging = false;
    let prevX = 0, prevY = 0;
    const group = new THREE.Group();
    scene.children.filter(c => c !== sunLight).forEach(c => group.add(c));
    scene.add(group);

    const onDown = (e: MouseEvent) => { isDragging = true; prevX = e.clientX; prevY = e.clientY; };
    const onUp   = () => { isDragging = false; };
    const onMove = (e: MouseEvent) => {
      if (!isDragging) return;
      group.rotation.y += (e.clientX - prevX) * 0.005;
      group.rotation.x += (e.clientY - prevY) * 0.003;
      group.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, group.rotation.x));
      prevX = e.clientX; prevY = e.clientY;
    };
    container.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mousemove", onMove);

    // ── Camera snap-to for selected event ─────────────────────────────────
    // Compute the target yaw/pitch that centres the conjunction midpoint.
    let targetRotY = group.rotation.y;
    let targetRotX = group.rotation.x;
    if (selectedEvent) {
      const pLat = selectedEvent.primary_lat   ?? noradToLatLon(selectedEvent.norad_id)[0];
      const pLon = selectedEvent.primary_lon   ?? noradToLatLon(selectedEvent.norad_id)[1];
      const sLat = selectedEvent.secondary_lat ?? noradToLatLon(selectedEvent.secondary_norad_id)[0];
      const sLon = selectedEvent.secondary_lon ?? noradToLatLon(selectedEvent.secondary_norad_id)[1];
      const midLat = (pLat + sLat) / 2;
      const midLon = (pLon + sLon) / 2;
      // We want the midpoint to face the camera (camera is at +Z).
      // The group's Y rotation maps longitude; X maps latitude.
      targetRotY = -(midLon * DEG) - Math.PI;
      targetRotX = -(midLat * DEG) * 0.8; // slight damping on pitch
    }

    // ── Resize handler ────────────────────────────────────────────────────
    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    // ── Animation loop ────────────────────────────────────────────────────
    let t = 0;
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      t += 0.016;

      // Auto-spin when not dragging
      if (!isDragging) {
        if (selectedEvent) {
          // Lerp toward the snap-to target
          group.rotation.y += (targetRotY - group.rotation.y) * 0.04;
          group.rotation.x += (targetRotX - group.rotation.x) * 0.04;
        } else {
          group.rotation.y += 0.0015;
        }
      }

      // Pulse CRITICAL/HIGH event nodes
      eventNodes.forEach((node) => {
        const { basePc, phase } = node.userData as { basePc: number; phase: number };
        const tier = getRiskTier(basePc);
        if (tier === "CRITICAL" || tier === "HIGH") {
          const pulse = 1 + 0.35 * Math.sin(t * 3 + phase);
          node.scale.setScalar(pulse);
        }
      });

      // Pulse the selection rings
      selGroup.children.forEach((child) => {
        if ((child as THREE.Mesh).userData?.isPulseRing) {
          const pulse = 1 + 0.25 * Math.sin(t * 4);
          child.scale.setScalar(pulse);
        }
        if ((child as THREE.Mesh).userData?.isHalo) {
          const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
          mat.opacity = 0.3 + 0.25 * Math.sin(t * 2.5);
        }
      });

      renderer.render(scene, camera);
    };
    animate();

    // ── Cleanup ───────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", onResize);
      container.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mousemove", onMove);
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [events, selectedEvent]); // re-run when events or selection changes

  return (
    <div
      ref={mountRef}
      className="w-full h-full rounded-xl overflow-hidden cursor-grab active:cursor-grabbing"
      style={{ minHeight: "420px" }}
    />
  );
}
