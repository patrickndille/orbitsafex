"use client";

/**
 * GlobeView.tsx
 * Three.js 3-D Earth globe.
 *
 * Renders:
 *   • Procedural Earth sphere with specular/emissive shading
 *   • Atmosphere glow shell
 *   • Satellite position dots (white) derived from mock orbital positions
 *   • High-risk conjunction nodes (red pulsing spheres)
 *   • Orbit-arc lines for flagged events
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

/** Convert geographic lat/lon (degrees) + altitude (km) → ECI-like XYZ on the sphere */
function geoToVec3(lat: number, lon: number, r: number): THREE.Vector3 {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta)
  );
}

/** Deterministic pseudo-random lat/lon from a NORAD ID */
function noradToLatLon(id: number): [number, number] {
  const seed = id * 0.6180339887;
  const lat = (((seed * 127.3) % 1) * 160) - 80;
  const lon = (((seed * 311.7) % 1) * 360) - 180;
  return [lat, lon];
}

// ── Risk colours ─────────────────────────────────────────────────────────────
const RISK_COLOUR: Record<string, number> = {
  CRITICAL: 0xef4444,
  HIGH: 0xf97316,
  ELEVATED: 0xeab308,
  MONITOR: 0x22c55e,
};

// ── Props ────────────────────────────────────────────────────────────────────
interface GlobeViewProps {
  events: ConjunctionEvent[];
  selectedId?: number | null;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function GlobeView({ events, selectedId }: GlobeViewProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const frameRef = useRef<number>(0);

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

    // land-mass approximation: bright green continent patches
    const continentMat = new THREE.MeshPhongMaterial({
      color: 0x2d6a2d,
      emissive: 0x0f2b0f,
      shininess: 10,
    });
    const continents: [number, number, number, number][] = [
      // lat, lon, latSpan, lonSpan
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

    // ── LEO shell (orbit zone reference ring) ────────────────────────────
    const leoRingGeo = new THREE.TorusGeometry(1.18, 0.003, 4, 120);
    const leoRingMat = new THREE.MeshBasicMaterial({ color: 0x334466, opacity: 0.4, transparent: true });
    const leoRing = new THREE.Mesh(leoRingGeo, leoRingMat);
    leoRing.rotation.x = Math.PI / 2;
    scene.add(leoRing);

    // ── Satellite dots (non-event objects) ───────────────────────────────
    const SAT_R = 1.13;
    const satDotGeo = new THREE.SphereGeometry(0.008, 6, 6);
    const satDotMat = new THREE.MeshBasicMaterial({ color: 0x94a3b8 });
    for (let i = 0; i < 60; i++) {
      const lat = Math.random() * 160 - 80;
      const lon = Math.random() * 360 - 180;
      const dot = new THREE.Mesh(satDotGeo, satDotMat);
      dot.position.copy(geoToVec3(lat, lon, SAT_R));
      scene.add(dot);
    }

    // ── Conjunction event nodes ───────────────────────────────────────────
    const eventNodes: THREE.Mesh[] = [];
    events.slice(0, 40).forEach((evt) => {
      const tier = getRiskTier(evt.pc_value);
      const colour = RISK_COLOUR[tier] ?? 0xffffff;
      const [lat, lon] = noradToLatLon(evt.norad_id);
      const nodeGeo = new THREE.SphereGeometry(0.018, 8, 8);
      const nodeMat = new THREE.MeshBasicMaterial({ color: colour });
      const node = new THREE.Mesh(nodeGeo, nodeMat);
      node.position.copy(geoToVec3(lat, lon, 1.14));
      node.userData = { id: evt.norad_id, basePc: evt.pc_value, phase: Math.random() * Math.PI * 2 };
      scene.add(node);
      eventNodes.push(node);

      // orbit arc line for the event
      const arcPoints: THREE.Vector3[] = [];
      for (let a = 0; a <= 360; a += 4) {
        arcPoints.push(geoToVec3(lat * Math.cos(a * DEG * 0.5), lon + a * 0.6, 1.14));
      }
      const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPoints);
      const arcMat = new THREE.LineBasicMaterial({
        color: colour,
        transparent: true,
        opacity: 0.3,
      });
      scene.add(new THREE.Line(arcGeo, arcMat));
    });

    // ── Mouse drag rotation ───────────────────────────────────────────────
    let isDragging = false;
    let prevX = 0, prevY = 0;
    const group = new THREE.Group();
    // move everything into the group for rotation
    scene.children.filter(c => c !== sunLight).forEach(c => group.add(c));
    scene.add(group);

    const onDown = (e: MouseEvent) => { isDragging = true; prevX = e.clientX; prevY = e.clientY; };
    const onUp = () => { isDragging = false; };
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
      if (!isDragging) group.rotation.y += 0.0015; // auto-spin

      // Pulse high-risk nodes
      eventNodes.forEach((node) => {
        const { basePc, phase } = node.userData as { basePc: number; phase: number };
        const tier = getRiskTier(basePc);
        if (tier === "CRITICAL" || tier === "HIGH") {
          const pulse = 1 + 0.35 * Math.sin(t * 3 + phase);
          node.scale.setScalar(pulse);
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
  }, [events]); // re-render globe when events change

  return (
    <div
      ref={mountRef}
      className="w-full h-full rounded-xl overflow-hidden cursor-grab active:cursor-grabbing"
      style={{ minHeight: "420px" }}
    />
  );
}
