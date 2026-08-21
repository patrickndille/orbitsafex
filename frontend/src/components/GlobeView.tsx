"use client";

/**
 * GlobeView.tsx — Three.js 3-D Earth globe
 *
 * Architecture: everything (Earth, nodes, overlay) is added directly to
 * `group` which is the single rotating child of the scene.  selGroup is
 * also a child of `group` so the overlay rotates with the globe.
 *
 * Selected-conjunction overlay (built by buildOverlay):
 *   Per object (primary + secondary):
 *     • Bright core sphere (PRIMARY=white, SECONDARY=cyan)
 *     • Coloured wireframe halo (breathing opacity)
 *     • Torus ring oriented radially outward (pulsing scale)
 *   Connector:
 *     • TubeGeometry arc (depthTest:false) — always visible over globe
 *     • Animated dashes via opacity pulse
 *     • White midpoint dot
 *
 * Why TubeGeometry instead of THREE.Line:
 *   WebGL ignores linewidth > 1, and THREE.Line with depthTest:true is
 *   clipped by the Earth sphere wherever the arc passes through the
 *   globe interior.  A TubeGeometry is a real mesh — it can be rendered
 *   with depthTest:false so it always draws on top of everything.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { ConjunctionEvent } from "@/lib/types";
import { getRiskTier } from "@/lib/types";

// ── constants ────────────────────────────────────────────────────────────────
const DEG        = Math.PI / 180;
const R_EARTH_KM = 6371;

// ── helpers ──────────────────────────────────────────────────────────────────

/** lat/lon (deg) + altKm → Three.js XYZ on the scaled globe sphere */
function geoToVec3(lat: number, lon: number, altKm: number): THREE.Vector3 {
  // Exaggerate altitude slightly so LEO nodes are clearly above the surface
  const r     = 1 + (altKm / R_EARTH_KM) * 0.8 + 0.06;
  const phi   = (90 - lat)  * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta)
  );
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

/**
 * Build a TubeGeometry that follows a great-circle arc.
 * Using TubeGeometry (a real 3-D mesh) instead of THREE.Line because:
 *   • WebGL silently ignores linewidth > 1 — lines are always 1 px
 *   • depthTest:false on a mesh works correctly; on a Line it z-fights badly
 * The tube is rendered with depthTest:false so it draws on top of the globe
 * surface regardless of which side of the Earth the arc passes through.
 */
function buildArcTube(
  posA: THREE.Vector3,
  posB: THREE.Vector3,
  arcR: number,
  colour: number,
  opacity: number,
  tubeRadius = 0.006
): THREE.Mesh {
  const pts = greatCircleArc(posA, posB, arcR);
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo   = new THREE.TubeGeometry(curve, 80, tubeRadius, 6, false);
  const mat   = new THREE.MeshBasicMaterial({
    color:       colour,
    transparent: true,
    opacity:     opacity,
    depthTest:   false,   // ← key: always renders on top of Earth
    depthWrite:  false,
    side:        THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 999; // draw after everything else
  return mesh;
}

// ── risk colours ─────────────────────────────────────────────────────────────
const RISK_COLOUR: Record<string, number> = {
  CRITICAL: 0xef4444,
  HIGH:     0xf97316,
  ELEVATED: 0xeab308,
  MONITOR:  0x22c55e,
};

// ── props ─────────────────────────────────────────────────────────────────────
interface GlobeViewProps {
  events: ConjunctionEvent[];
  selectedEvent?: ConjunctionEvent | null;
}

// ── component ────────────────────────────────────────────────────────────────
export default function GlobeView({ events, selectedEvent }: GlobeViewProps) {
  const mountRef    = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const frameRef    = useRef<number>(0);

  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;
    const W = container.clientWidth  || 600;
    const H = container.clientHeight || 400;

    // ── scene / camera / renderer ─────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020712);

    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 1000);
    camera.position.set(0, 0, 3.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // ── lights ────────────────────────────────────────────────────────────
    const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
    sunLight.position.set(5, 3, 5);
    scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x1a2a4a, 1.2));

    // ── single rotation group (the globe + all overlays live here) ────────
    const group = new THREE.Group();
    scene.add(group);

    // ── stars ─────────────────────────────────────────────────────────────
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

    // ── Earth sphere ──────────────────────────────────────────────────────
    group.add(new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 64),
      new THREE.MeshPhongMaterial({
        color: 0x1a4fa8, emissive: 0x0a1f50,
        specular: 0x3a7bd5, shininess: 60,
      })
    ));

    // continent patches
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

    // atmosphere
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

    // ── background satellite dots ─────────────────────────────────────────
    const satGeo = new THREE.SphereGeometry(0.008, 6, 6);
    const satMat = new THREE.MeshBasicMaterial({ color: 0x94a3b8 });
    for (let i = 0; i < 60; i++) {
      const dot = new THREE.Mesh(satGeo, satMat);
      dot.position.copy(geoToVec3(Math.random() * 160 - 80, Math.random() * 360 - 180, 400));
      group.add(dot);
    }

    // ── conjunction event nodes (primary + secondary of every event) ──────
    // Both objects in a conjunction pair are plotted so the secondary is always
    // visible on the globe even when it isn't the primary of another event.
    const eventNodes: THREE.Mesh[] = [];
    events.slice(0, 60).forEach((evt) => {
      const tier   = getRiskTier(evt.pc_value);
      const colour = RISK_COLOUR[tier] ?? 0xffffff;

      // ── Primary node ──
      const pLat = evt.primary_lat    ?? noradToLatLon(evt.norad_id)[0];
      const pLon = evt.primary_lon    ?? noradToLatLon(evt.norad_id)[1];
      const pAlt = evt.primary_alt_km ?? 400;

      const primaryNode = new THREE.Mesh(
        new THREE.SphereGeometry(0.018, 8, 8),
        new THREE.MeshBasicMaterial({ color: colour })
      );
      primaryNode.position.copy(geoToVec3(pLat, pLon, pAlt));
      primaryNode.userData = { basePc: evt.pc_value, phase: Math.random() * Math.PI * 2 };
      group.add(primaryNode);
      eventNodes.push(primaryNode);

      // faint orbit-arc suggestion for primary
      const arcPts: THREE.Vector3[] = [];
      for (let a = 0; a <= 360; a += 4) {
        arcPts.push(geoToVec3(pLat * Math.cos(a * DEG * 0.5), pLon + a * 0.6, pAlt));
      }
      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(arcPts),
        new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.22 })
      ));

      // ── Secondary node (smaller diamond-ish sphere, same tier colour) ──
      const sLat = evt.secondary_lat    ?? noradToLatLon(evt.secondary_norad_id)[0];
      const sLon = evt.secondary_lon    ?? noradToLatLon(evt.secondary_norad_id)[1];
      const sAlt = evt.secondary_alt_km ?? 400;

      const secondaryNode = new THREE.Mesh(
        new THREE.SphereGeometry(0.013, 8, 8),           // smaller than primary
        new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.75 })
      );
      secondaryNode.position.copy(geoToVec3(sLat, sLon, sAlt));
      secondaryNode.userData = { basePc: evt.pc_value, phase: Math.random() * Math.PI * 2 };
      group.add(secondaryNode);
      eventNodes.push(secondaryNode);
    });

    // ── selected-conjunction overlay ──────────────────────────────────────
    // selGroup is a child of `group` so it rotates with the globe.
    const selGroup = new THREE.Group();
    group.add(selGroup);

    const buildOverlay = (evt: ConjunctionEvent | null | undefined) => {
      // remove and dispose all previous children
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

      const tier = getRiskTier(evt.pc_value);
      // PRIMARY: tier colour (matches its event-log badge)
      // SECONDARY: bright cyan — visually distinct from primary at a glance
      const pColour = RISK_COLOUR[tier] ?? 0xef4444;
      const sColour = 0x00e5ff; // cyan — secondary/debris object

      const pLat = evt.primary_lat      ?? noradToLatLon(evt.norad_id)[0];
      const pLon = evt.primary_lon      ?? noradToLatLon(evt.norad_id)[1];
      const pAlt = evt.primary_alt_km   ?? 400;
      const sLat = evt.secondary_lat    ?? noradToLatLon(evt.secondary_norad_id)[0];
      const sLon = evt.secondary_lon    ?? noradToLatLon(evt.secondary_norad_id)[1];
      const sAlt = evt.secondary_alt_km ?? 400;

      const posA = geoToVec3(pLat, pLon, pAlt);
      const posB = geoToVec3(sLat, sLon, sAlt);

      // Render order: overlay always on top
      const overlayMat = (colour: number, opacity = 1.0) =>
        new THREE.MeshBasicMaterial({
          color: colour,
          transparent: true,
          opacity,
          depthTest:  false,
          depthWrite: false,
        });

      const addHighlight = (pos: THREE.Vector3, coreCol: number, ringCol: number, isPrimary: boolean) => {
        // 1. Core sphere — PRIMARY is white, SECONDARY is cyan so they're
        //    immediately distinguishable without needing a legend
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(0.030, 12, 12),
          overlayMat(coreCol)
        );
        core.position.copy(pos);
        core.renderOrder = 999;
        selGroup.add(core);

        // 2. Outer wireframe halo (breathing)
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(0.058, 14, 14),
          overlayMat(ringCol, 0.7)
        );
        halo.material.wireframe = true;
        halo.position.copy(pos);
        halo.renderOrder = 999;
        halo.userData.isHalo = true;
        selGroup.add(halo);

        // 3. Torus ring (pulsing) — oriented radially outward from Earth centre
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(isPrimary ? 0.075 : 0.055, 0.009, 8, 48),
          overlayMat(ringCol, 0.95)
        );
        ring.position.copy(pos);
        ring.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          pos.clone().normalize()
        );
        ring.renderOrder = 999;
        ring.userData.isPulseRing = true;
        selGroup.add(ring);
      };

      // Primary: white core, tier-colour ring
      addHighlight(posA, 0xffffff, pColour, true);
      // Secondary: cyan core, cyan ring — clearly different from primary
      addHighlight(posB, 0x00e5ff, sColour, false);

      // ── Conjunction arc — TubeGeometry so it's visible at any thickness ──
      // Arc radius floats slightly above both objects so it never clips into
      // the Earth surface.  depthTest:false means it draws over the globe.
      const arcR = Math.max(posA.length(), posB.length()) + 0.02;

      // Main bright arc
      const arcTube = buildArcTube(posA, posB, arcR, 0xff3030, 1.0, 0.008);
      arcTube.userData.isArcTube = true;
      selGroup.add(arcTube);

      // Softer glow halo around the arc (wider tube, lower opacity)
      const glowTube = buildArcTube(posA, posB, arcR, 0xff6060, 0.35, 0.016);
      glowTube.userData.isGlowTube = true;
      selGroup.add(glowTube);

      // Midpoint warning dot
      const midPt = posA.clone().lerp(posB, 0.5).normalize().multiplyScalar(arcR);
      const mid   = new THREE.Mesh(
        new THREE.SphereGeometry(0.016, 10, 10),
        overlayMat(0xff3030)
      );
      mid.position.copy(midPt);
      mid.renderOrder = 999;
      selGroup.add(mid);
    };

    buildOverlay(selectedEvent);

    // ── camera snap-to ────────────────────────────────────────────────────
    // geoToVec3 bakes theta = (lon + 180)°, so a point at longitude L lands at
    // theta = (L+180)°.  The camera sits at +Z; to bring longitude M to the
    // front hemisphere we need the group rotated so that theta + rotY = 90°:
    //   rotY = 90° - (M + 180)° = -(M + 90)° = -(M * DEG) - PI/2
    let targetRotY = 0;
    let targetRotX = 0;
    if (selectedEvent) {
      const pLat = selectedEvent.primary_lat   ?? noradToLatLon(selectedEvent.norad_id)[0];
      const pLon = selectedEvent.primary_lon   ?? noradToLatLon(selectedEvent.norad_id)[1];
      const sLat = selectedEvent.secondary_lat ?? noradToLatLon(selectedEvent.secondary_norad_id)[0];
      const sLon = selectedEvent.secondary_lon ?? noradToLatLon(selectedEvent.secondary_norad_id)[1];
      const midLon = (pLon + sLon) / 2;
      const midLat = (pLat + sLat) / 2;
      targetRotY = -(midLon * DEG) - Math.PI / 2;
      targetRotX = -(midLat * DEG) * 0.7;
    }

    // ── mouse drag ────────────────────────────────────────────────────────
    let isDragging = false;
    let prevX = 0, prevY = 0;

    const onDown = (e: MouseEvent) => {
      isDragging = true; prevX = e.clientX; prevY = e.clientY;
    };
    const onUp = () => { isDragging = false; };
    const onMove = (e: MouseEvent) => {
      if (!isDragging) return;
      group.rotation.y += (e.clientX - prevX) * 0.005;
      group.rotation.x += (e.clientY - prevY) * 0.003;
      group.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, group.rotation.x));
      // Sync snap target so lerp doesn't fight the user after dragging
      targetRotY = group.rotation.y;
      targetRotX = group.rotation.x;
      prevX = e.clientX; prevY = e.clientY;
    };
    container.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mousemove", onMove);

    // ── resize ────────────────────────────────────────────────────────────
    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    // ── animation loop ────────────────────────────────────────────────────
    let t = 0;
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      t += 0.016;

      // Rotation
      if (!isDragging) {
        if (selectedEvent) {
          group.rotation.y += (targetRotY - group.rotation.y) * 0.05;
          group.rotation.x += (targetRotX - group.rotation.x) * 0.05;
        } else {
          group.rotation.y += 0.0015;
        }
      }

      // Pulse high-risk event nodes
      eventNodes.forEach((node) => {
        const { basePc, phase } = node.userData as { basePc: number; phase: number };
        const tier = getRiskTier(basePc);
        if (tier === "CRITICAL" || tier === "HIGH") {
          node.scale.setScalar(1 + 0.35 * Math.sin(t * 3 + phase));
        }
      });

      // Animate selection overlay
      selGroup.children.forEach((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.userData?.isPulseRing) {
          mesh.scale.setScalar(1 + 0.28 * Math.sin(t * 4.5));
        }
        if (mesh.userData?.isHalo) {
          (mesh.material as THREE.MeshBasicMaterial).opacity =
            0.30 + 0.40 * Math.sin(t * 2.8);
        }
        // Pulse the glow tube opacity for a breathing effect
        if (mesh.userData?.isGlowTube) {
          (mesh.material as THREE.MeshBasicMaterial).opacity =
            0.20 + 0.25 * Math.sin(t * 3.2);
        }
        // Pulse the main arc tube slightly to attract attention
        if (mesh.userData?.isArcTube) {
          (mesh.material as THREE.MeshBasicMaterial).opacity =
            0.80 + 0.20 * Math.sin(t * 5.0);
        }
      });

      renderer.render(scene, camera);
    };
    animate();

    // ── cleanup ───────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", onResize);
      container.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mousemove", onMove);
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
  }, [events, selectedEvent]);

  return (
    <div
      ref={mountRef}
      className="w-full h-full rounded-xl overflow-hidden cursor-grab active:cursor-grabbing"
      style={{ minHeight: "420px" }}
    />
  );
}
