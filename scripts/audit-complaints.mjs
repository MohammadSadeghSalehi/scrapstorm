#!/usr/bin/env node
/**
 * Verify three reported bugs against the real modules, headlessly.
 *
 *   node scripts/audit-complaints.mjs
 *
 * Written because the same three things have now been reported as still broken
 * AFTER being reported as fixed. Claiming a fix from a code reading is what
 * produced that; this drives the actual collision path, the actual orientation
 * pipeline and the actual projectile table and prints what they do.
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const track = await jiti.import("../src/game/track.ts");
const colliders = await jiti.import("../src/game/setpieceColliders.ts");
const props = await jiti.import("../src/game/worldProps.ts");
const physics = await jiti.import("../src/game/physics.ts");
const classes = await jiti.import("../src/game/classes.ts");

const line = (s) => console.log(s);

/* ── 1. Do side objects actually stop a car? ──────────────────────── */

line("\n=== 1. SIDE-OBJECT COLLISION ===");
for (const id of track.TRACK_CATALOG.map((d) => d.id)) {
  track.setActiveTrack(id);
  colliders.rebuildSetpieceColliders?.();
  const S = track.getTrackSamples();

  // Sweep the verge band on both sides and count how much of it is covered by
  // a static collider a car would actually hit.
  let probed = 0;
  let hit = 0;
  for (let i = 0; i < S.length; i += 2) {
    const s = S[i];
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    for (const side of [-1, 1]) {
      // Just outside the run-off, where a rail or a stone lives.
      for (const extra of [2, 4, 6, 9]) {
        const d = s.width * 0.5 + extra;
        const x = s.x + rx * side * d;
        const z = s.z + rz * side * d;
        probed++;
        const near = colliders.querySetpieceColliders?.(x, z, 2.0) ?? [];
        let touched = false;
        for (const c of near) {
          const r = colliders.capsuleContact?.(c, x, z, 1.55);
          if (r && r.hit) touched = true;
        }
        if (touched) hit++;
      }
    }
  }
  line(
    `  ${id.padEnd(13)} ${hit}/${probed} verge probes hit a collider` +
      `  (${((hit / probed) * 100).toFixed(1)}%)`,
  );
}

/* ── 1b. Where a rail module EXISTS, is there a collider? ─────────── */

line("\n=== 1b. RAIL / BOARD MODULES vs THEIR COLLIDERS ===");
const layout = await jiti.import("../src/game/world/scatter/roadsideLayout.ts");
for (const id of track.TRACK_CATALOG.map((d) => d.id)) {
  track.setActiveTrack(id);
  colliders.rebuildSetpieceColliders?.();
  const mods = layout.roadsideLayout?.() ?? null;
  if (!mods) {
    line(`  ${id.padEnd(13)} layout module exports: ${Object.keys(layout).join(", ")}`);
    break;
  }
  /*
   * A rail module is a SEGMENT (ax,az -> bx,bz), not a point. The first version
   * of this check probed `m.x, m.z` — undefined on every rail module — and
   * reported 0/129 with complete confidence. Probe the midpoint AND both ends.
   */
  const pts = [];
  for (const r of mods.rail ?? []) {
    pts.push([(r.ax + r.bx) / 2, (r.az + r.bz) / 2]);
  }
  for (const b of mods.boards ?? []) {
    pts.push([b.x ?? (b.ax + b.bx) / 2, b.z ?? (b.az + b.bz) / 2]);
  }
  const list = pts;
  let covered = 0;
  for (const [px, pz] of pts) {
    if (!Number.isFinite(px) || !Number.isFinite(pz)) continue;
    const near = colliders.querySetpieceColliders?.(px, pz, 2.5) ?? [];
    let ok = false;
    for (const c of near) {
      const r = colliders.capsuleContact?.(c, px, pz, 0.9);
      if (r && r.hit) ok = true;
    }
    if (ok) covered++;
  }
  line(`  ${id.padEnd(13)} ${covered}/${list.length} modules have a collider at their own position`);
}

/* ── 2. Are the new car bodies oriented sanely? ───────────────────── */

line("\n=== 2. VEHICLE ORIENTATION ===");
line("  (long axis should be Z after alignment; a near-square bbox is a coin flip)");
const { readFileSync } = await import("node:fs");
function glbBounds(path) {
  const buf = readFileSync(path);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const ty = buf.readUInt32LE(off + 4);
    const d = buf.subarray(off + 8, off + 8 + len);
    if (ty === 0x4e4f534a) json = JSON.parse(d.toString("utf8"));
    else if (ty === 0x004e4942) bin = Buffer.from(d);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json?.accessors) return null;
  let min = null;
  let max = null;
  for (const m of json.meshes ?? []) {
    for (const p of m.primitives ?? []) {
      const a = json.accessors[p.attributes.POSITION];
      if (!a?.min) continue;
      min = min ? min.map((v, i) => Math.min(v, a.min[i])) : a.min.slice();
      max = max ? max.map((v, i) => Math.max(v, a.max[i])) : a.max.slice();
    }
  }
  if (!min) return null;
  return { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] };
}

const CARS = [
  "SM_MeshGen_WastelandCustomCar",
  "SM_MeshGen_CustomWidebodyHatchback",
  "SM_MeshGen_DesertCombatVehicle",
  "SM_MeshGen_WastelandBattleCar",
  "SM_MeshGen_ArmoredBattleCar",
  "SM_MeshGen_ArmoredTankTruck",
];
for (const c of CARS) {
  const b = glbBounds(`public/assets/meshes/custom/${c}.glb`);
  if (!b) {
    line(`  ${c.padEnd(38)} unreadable`);
    continue;
  }
  const long = b.x >= b.z ? "X" : "Z";
  const ratio = Math.max(b.x, b.z) / Math.min(b.x, b.z);
  const risky = ratio < 1.15;
  line(
    `  ${c.replace("SM_MeshGen_", "").padEnd(28)} ` +
      `X=${b.x.toFixed(2)} Y=${b.y.toFixed(2)} Z=${b.z.toFixed(2)}  long=${long}` +
      `  ratio=${ratio.toFixed(3)}${risky ? "   <-- AMBIGUOUS, heuristic is a coin flip" : ""}`,
  );
}

/* ── 3. What can actually fire a missile? ─────────────────────────── */

line("\n=== 3. WEAPONS ===");
for (const [id, def] of Object.entries(classes.VEHICLE_CLASSES)) {
  line(
    `  ${id.padEnd(12)} primary="${def.primaryLabel}"  ult="${def.ultimateLabel}"` +
      `  cd=${def.primaryCooldown}s`,
  );
}
line(`  physics exports drift query: ${typeof physics.isDrifting === "function"}`);
line(`  worldProps collide entry:    ${typeof props.collideVehiclesWithProps === "function"}`);
console.log("");
