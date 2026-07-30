/**
 * Road ribbon segmentation — only when triangle count warrants multi-draw.
 *
 * Current Ash Spire circuit: ~560 road tris + ~1120 apron ≈ 1680 total.
 * Draw-call overhead of 10–20 segments is NOT worth it at that density.
 * When denser tracks / more samples push road tris past the threshold,
 * we split into AABB-culled chunks (same total tris, fewer on-screen).
 */
import * as THREE from "three";
import type { TrackSample } from "../../types";
import type { CullAABB, CullSphere } from "./cpuTerrainCull";

/** Segment if road-only triangle count reaches this (2 tris per sample). */
export const ROAD_SEGMENT_TRI_THRESHOLD = 3000;

export type RoadSegment = {
  id: number;
  /** Inclusive sample start, exclusive end (wraps handled by caller) */
  i0: number;
  i1: number;
  road: THREE.BufferGeometry;
  apron: THREE.BufferGeometry;
  sphere: CullSphere;
  aabb: CullAABB;
  triCount: number;
};

export type RoadBuildResult =
  | {
      mode: "mono";
      road: THREE.BufferGeometry;
      apron: THREE.BufferGeometry;
      stripes: THREE.BufferGeometry;
      edgeLines: THREE.BufferGeometry;
      roadTris: number;
      apronTris: number;
    }
  | {
      mode: "segmented";
      segments: RoadSegment[];
      stripes: THREE.BufferGeometry;
      edgeLines: THREE.BufferGeometry;
      roadTris: number;
      apronTris: number;
      samplesPerSeg: number;
    };

export function roadTriCount(sampleCount: number): number {
  // one quad = 2 tris per sample interval
  return sampleCount * 2;
}

export function shouldSegmentRoad(
  sampleCount: number,
  threshold = ROAD_SEGMENT_TRI_THRESHOLD,
): boolean {
  return roadTriCount(sampleCount) >= threshold;
}

function zoneColor(zone: string): [number, number, number] {
  if (zone === "arena") return [0.42, 0.38, 0.34];
  if (zone === "hazard") return [0.4, 0.32, 0.28];
  if (zone === "jump") return [0.36, 0.36, 0.4];
  return [0.34, 0.32, 0.3];
}

function pushQuad(
  pos: number[],
  col: number[],
  uv: number[],
  a: number[],
  b: number[],
  c: number[],
  d: number[],
  ca: [number, number, number],
  cb: [number, number, number],
  i: number,
  n: number,
) {
  const u0 = i / n;
  const u1 = (i + 1) / n;
  pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  pos.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
  col.push(...ca, ...ca, ...cb, ...ca, ...cb, ...cb);
  uv.push(u0, 0, u0, 1, u1, 1, u0, 0, u1, 1, u1, 0);
}

function sampleEdges(a: TrackSample, b: TrackSample, apronW: number) {
  const ax = -Math.cos(a.yaw);
  const az = Math.sin(a.yaw);
  const bx = -Math.cos(b.yaw);
  const bz = Math.sin(b.yaw);
  const hwA = a.width * 0.5;
  const hwB = b.width * 0.5;
  const bankA = (a as TrackSample & { bank?: number }).bank ?? 0;
  const bankB = (b as TrackSample & { bank?: number }).bank ?? 0;
  // Bank: positive cross → left edge up (outer on right turns)
  const aLy = a.y + 0.02 + bankA * 0.45;
  const aRy = a.y + 0.02 - bankA * 0.45;
  const bLy = b.y + 0.02 + bankB * 0.45;
  const bRy = b.y + 0.02 - bankB * 0.45;
  const aL = [a.x + ax * hwA, aLy, a.z + az * hwA];
  const aR = [a.x - ax * hwA, aRy, a.z - az * hwA];
  const bL = [b.x + bx * hwB, bLy, b.z + bz * hwB];
  const bR = [b.x - bx * hwB, bRy, b.z - bz * hwB];
  const aLo = [a.x + ax * (hwA + apronW), a.y - 0.02 + bankA * 0.2, a.z + az * (hwA + apronW)];
  const aRo = [a.x - ax * (hwA + apronW), a.y - 0.02 - bankA * 0.2, a.z - az * (hwA + apronW)];
  const bLo = [b.x + bx * (hwB + apronW), b.y - 0.02 + bankB * 0.2, b.z + bz * (hwB + apronW)];
  const bRo = [b.x - bx * (hwB + apronW), b.y - 0.02 - bankB * 0.2, b.z - bz * (hwB + apronW)];
  return { aL, aR, bL, bR, aLo, aRo, bLo, bRo };
}

function expandBounds(
  b: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  x: number,
  y: number,
  z: number,
) {
  b.minX = Math.min(b.minX, x);
  b.minY = Math.min(b.minY, y);
  b.minZ = Math.min(b.minZ, z);
  b.maxX = Math.max(b.maxX, x);
  b.maxY = Math.max(b.maxY, y);
  b.maxZ = Math.max(b.maxZ, z);
}

function geoFromArrays(
  positions: number[],
  colors: number[],
  uvs: number[],
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  const uv = g.getAttribute("uv");
  if (uv && !g.getAttribute("uv2")) g.setAttribute("uv2", uv.clone());
  return g;
}

/**
 * Build track ribbon. Uses mono mesh when under tri threshold;
 * otherwise splits into culled segments (samplesPerSeg intervals each).
 */
export function buildTrackRibbon(
  samples: TrackSample[],
  opts?: { triThreshold?: number; samplesPerSeg?: number },
): RoadBuildResult {
  const n = samples.length;
  const threshold = opts?.triThreshold ?? ROAD_SEGMENT_TRI_THRESHOLD;
  const roadTris = roadTriCount(n);
  const apronTris = n * 4; // two apron quads · 2 tris
  const segment = shouldSegmentRoad(n, threshold);
  const samplesPerSeg = opts?.samplesPerSeg ?? 20;
  const apronW = 5.5;

  const stripePos: number[] = [];
  const edgePos: number[] = [];

  // Always build stripes + edge lines as mono (cheap, thin)
  for (let i = 0; i < n; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % n];
    const { aL, aR, bL, bR } = sampleEdges(a, b, apronW);
    edgePos.push(aL[0], aL[1] + 0.04, aL[2], bL[0], bL[1] + 0.04, bL[2]);
    edgePos.push(aR[0], aR[1] + 0.04, aR[2], bR[0], bR[1] + 0.04, bR[2]);
    if (i % 4 === 0) {
      const mx = (a.x + b.x) * 0.5;
      const mz = (a.z + b.z) * 0.5;
      const my = (a.y + b.y) * 0.5 + 0.05;
      const fx = -Math.sin(a.yaw);
      const fz = -Math.cos(a.yaw);
      const sx = -fz;
      const sz = fx;
      const len = 1.8;
      const halfW = 0.18;
      stripePos.push(
        mx - fx * len + sx * halfW, my, mz - fz * len + sz * halfW,
        mx + fx * len + sx * halfW, my, mz + fz * len + sz * halfW,
        mx + fx * len - sx * halfW, my, mz + fz * len - sz * halfW,
        mx - fx * len + sx * halfW, my, mz - fz * len + sz * halfW,
        mx + fx * len - sx * halfW, my, mz + fz * len - sz * halfW,
        mx - fx * len - sx * halfW, my, mz - fz * len - sz * halfW,
      );
    }
  }

  const stripes = new THREE.BufferGeometry();
  stripes.setAttribute("position", new THREE.Float32BufferAttribute(stripePos, 3));
  const edgeLines = new THREE.BufferGeometry();
  edgeLines.setAttribute("position", new THREE.Float32BufferAttribute(edgePos, 3));

  if (!segment) {
    const positions: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const apronPos: number[] = [];
    const apronCol: number[] = [];
    const apronUv: number[] = [];
    const dirt: [number, number, number] = [0.42, 0.34, 0.24];

    for (let i = 0; i < n; i++) {
      const a = samples[i];
      const b = samples[(i + 1) % n];
      const e = sampleEdges(a, b, apronW);
      const cA = zoneColor(a.zone);
      const cB = zoneColor(b.zone);
      pushQuad(positions, colors, uvs, e.aL, e.aR, e.bR, e.bL, cA, cB, i, n);
      pushQuad(apronPos, apronCol, apronUv, e.aL, e.aLo, e.bLo, e.bL, dirt, dirt, i, n);
      pushQuad(apronPos, apronCol, apronUv, e.aRo, e.aR, e.bR, e.bRo, dirt, dirt, i, n);
    }

    return {
      mode: "mono",
      road: geoFromArrays(positions, colors, uvs),
      apron: geoFromArrays(apronPos, apronCol, apronUv),
      stripes,
      edgeLines,
      roadTris,
      apronTris,
    };
  }

  // Segmented path
  const segments: RoadSegment[] = [];
  const dirt: [number, number, number] = [0.42, 0.34, 0.24];
  let id = 0;
  for (let start = 0; start < n; start += samplesPerSeg) {
    const end = Math.min(start + samplesPerSeg, n);
    const positions: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const apronPos: number[] = [];
    const apronCol: number[] = [];
    const apronUv: number[] = [];
    const bounds = {
      minX: Infinity,
      minY: Infinity,
      minZ: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      maxZ: -Infinity,
    };
    let tri = 0;

    for (let i = start; i < end; i++) {
      const a = samples[i];
      const b = samples[(i + 1) % n];
      const e = sampleEdges(a, b, apronW);
      const cA = zoneColor(a.zone);
      const cB = zoneColor(b.zone);
      pushQuad(positions, colors, uvs, e.aL, e.aR, e.bR, e.bL, cA, cB, i, n);
      pushQuad(apronPos, apronCol, apronUv, e.aL, e.aLo, e.bLo, e.bL, dirt, dirt, i, n);
      pushQuad(apronPos, apronCol, apronUv, e.aRo, e.aR, e.bR, e.bRo, dirt, dirt, i, n);
      tri += 6; // 1 road quad + 2 apron quads
      for (const p of [e.aL, e.aR, e.bL, e.bR, e.aLo, e.aRo, e.bLo, e.bRo]) {
        expandBounds(bounds, p[0], p[1], p[2]);
      }
    }

    const cx = (bounds.minX + bounds.maxX) * 0.5;
    const cy = (bounds.minY + bounds.maxY) * 0.5;
    const cz = (bounds.minZ + bounds.maxZ) * 0.5;
    const r = Math.hypot(
      bounds.maxX - cx,
      bounds.maxY - cy,
      bounds.maxZ - cz,
    );

    segments.push({
      id: id++,
      i0: start,
      i1: end,
      road: geoFromArrays(positions, colors, uvs),
      apron: geoFromArrays(apronPos, apronCol, apronUv),
      sphere: { x: cx, y: cy, z: cz, r: r + 2 },
      aabb: { ...bounds },
      triCount: tri,
    });
  }

  return {
    mode: "segmented",
    segments,
    stripes,
    edgeLines,
    roadTris,
    apronTris,
    samplesPerSeg,
  };
}
