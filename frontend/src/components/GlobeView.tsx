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
 *     • White core sphere
 *     • Coloured wireframe halo (breathing opacity)
 *     • Torus ring oriented radially outward (pulsing scale)
 *   Connector:
 *     • Bright red great-circle arc (80 segments)
 *     • White midpoint dot
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

/** 80-segment great-circle arc at radius r between two world-space vectors */
function greatCircleArc(a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.Vector3[] {
  const ua = a.clone().normalize();
  const ub = b.clone().normalize();
  return Array.from({ length: 81 }, (_, i) =>
    ua.clone().lerp(ub, i / 80).normalize().multiplyScalar(r)
  );
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
      // remove and dispose previous children
      selGroup.children.slice().forEach((c) => {
        if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
        selGroup.remove(c);
      });
      if (!evt) return;

      const tier    = getRiskTier(evt.pc_value);
      const pColour = RISK_COLOUR[tier] ?? 0xef4444;
      const sColour = 0xff2222; // secondary always red

      const pLat = evt.primary_lat      ?? noradToLatLon(evt.norad_id)[0];
      const pLon = evt.primary_lon      ?? noradToLatLon(evt.norad_id)[1];
      const pAlt = evt.primary_alt_km   ?? 400;
      const sLat = evt.secondary_lat    ?? noradToLatLon(evt.secondary_norad_id)[0];
      const sLon = evt.secondary_lon    ?? noradToLatLon(evt.secondary_norad_id)[1];
      const sAlt = evt.secondary_alt_km ?? 400;

      const posA = geoToVec3(pLat, pLon, pAlt);
      const posB = geoToVec3(sLat, sLon, sAlt);

      const addHighlight = (pos: THREE.Vector3, col: number) => {
        // 1. Bright white core
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(0.028, 10, 10),
          new THREE.MeshBasicMaterial({ color: 0xffffff })
        );
        core.position.copy(pos);
        selGroup.add(core);

        // 2. Coloured wireframe halo — breathing opacity via animation
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(0.055, 14, 14),
          new THREE.MeshBasicMaterial({ color: col, wireframe: true, transparent: true, opacity: 0.7 })
        );
        halo.position.copy(pos);
        halo.userData.isHalo = true;
        selGroup.add(halo);

        // 3. Torus ring, oriented outward from Earth — pulsing scale
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.068, 0.008, 8, 48),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95 })
        );
        ring.position.copy(pos);
        ring.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          pos.clone().normalize()
        );
        ring.userData.isPulseRing = true;
        selGroup.add(ring);
      };

      addHighlight(posA, pColour);
      addHighlight(posB, sColour);

      // 4. Bright red great-circle arc
      const arcR   = (posA.length() + posB.length()) / 2;
      selGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(greatCircleArc(posA, posB, arcR)),
        new THREE.LineBasicMaterial({ color: 0xff0000, transparent: true, opacity: 1.0 })
      ));

      // 5. White midpoint dot
      const mid = new THREE.Mesh(
        new THREE.SphereGeometry(0.014, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      mid.position.copy(posA.clone().lerp(posB, 0.5).normalize().multiplyScalar(arcR));
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
          mesh.scale.setScalar(1 + 0.30 * Math.sin(t * 4.5));
        }
        if (mesh.userData?.isHalo) {
          (mesh.material as THREE.MeshBasicMaterial).opacity =
            0.35 + 0.35 * Math.sin(t * 2.8);
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
