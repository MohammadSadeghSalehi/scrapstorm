#!/usr/bin/env node
/**
 * Guard the hand-derived collider footprints against the geometry drifting.
 *
 *   node scripts/check-setpiece-footprints.mjs
 *
 * WHY THIS EXISTS. `src/game/setpieceColliders.ts` carries a FOOTPRINT table:
 * the XZ extent of each set-piece shape AT CAR HEIGHT. That is deliberately not
 * the renderer's bounding volume — a furnace stack's bounding SPHERE is 13m for
 * a body that is 5.2m across, and colliding against the sphere would put an
 * invisible wall three car-widths from anything you can see.
 *
 * The cost of being right about that is a table derived by hand from
 * `world/setpieces/geometry.ts`, in a different file, with nothing connecting
 * them. Retune a furnace and the collider silently keeps the old number. The
 * pass that wrote it flagged exactly this and asked for an exported accessor.
 *
 * An accessor is the wrong shape here: the renderer has no notion of "at car
 * height" and adding one would put a gameplay concern into geometry code. What
 * is needed is a TRIPWIRE, and only ONE direction of it is sound: a footprint
 * must never be WIDER than the object it stands for, because that is an
 * invisible wall.
 *
 * The obvious symmetric rule — "and not much narrower either" — is WRONG, and
 * the first version of this script failed craneArm because of it. A crane is an
 * 18m jib on a 2.3m tower; at car height it IS the tower, and 19% of the
 * bounding extent is the correct answer. Anything with an overhang — cranes,
 * gantries, pipe trestles — legitimately has a footprint far narrower than its
 * bounds. A check that flags those is worse than no check, because it trains
 * you to ignore it.
 *
 * So narrowness is REPORTED and never fails. Only exceeding the geometry does.
 *
 * Exits non-zero so it can gate a commit.
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

/*
 * geometry.ts imports three, which is fine here (this is a script, not the sim)
 * but means the module must be loaded through jiti rather than parsed.
 */
const geom = await jiti.import("../src/game/world/setpieces/geometry.ts");
const colliders = await jiti.import("../src/game/setpieceColliders.ts");

const FOOTPRINT = colliders.FOOTPRINT ?? colliders.__FOOTPRINT;
if (!FOOTPRINT) {
  console.error(
    "setpieceColliders.ts does not export FOOTPRINT — export it (or __FOOTPRINT)\n" +
      "so this check can see it. Without that the table is unguarded.",
  );
  process.exit(1);
}

const GEO = geom.SETPIECE_GEOMETRY;
if (!GEO) {
  console.error("world/setpieces/geometry.ts does not export SETPIECE_GEOMETRY");
  process.exit(1);
}

/** The only sound bound: a collider must not be wider than what you can see. */
const MAX_FRAC = 1.05;

let failed = 0;
let checked = 0;

for (const [shape, fp] of Object.entries(FOOTPRINT)) {
  if (!fp) {
    // Null is a deliberate "no collider" — furnace taps ride their stack, and
    // the Dead Mile distance markers are 22cm posts that must not stop a car.
    console.log(`  --  ${shape.padEnd(16)} no collider by design`);
    continue;
  }
  const build = GEO[shape];
  if (typeof build !== "function") {
    console.log(`  ?  ${shape.padEnd(16)} no geometry entry — skipped`);
    continue;
  }
  let g;
  try {
    g = build();
  } catch (err) {
    console.log(`  ?  ${shape.padEnd(16)} geometry threw: ${String(err).slice(0, 60)}`);
    continue;
  }
  g.computeBoundingBox();
  const bb = g.boundingBox;
  // Half-extent in XZ, the axis a car actually runs into.
  const halfGeo = Math.max(
    (bb.max.x - bb.min.x) / 2,
    (bb.max.z - bb.min.z) / 2,
  );
  // Linked families use anchor-to-anchor segments and ignore halfX, so `r` is
  // the only number that describes their width.
  const used = Math.max(fp.r ?? 0, fp.halfX ?? 0);
  if (!Number.isFinite(halfGeo) || halfGeo < 1e-6) {
    // Some shapes are built from anchor pairs and have no meaningful extent
    // until placed; there is nothing to compare against here.
    console.log(`  --  ${shape.padEnd(16)} not measurable standalone`);
    continue;
  }
  const frac = used / halfGeo;
  checked++;

  const bad = frac > MAX_FRAC;
  if (bad) failed++;
  console.log(
    `  ${bad ? "FAIL" : "ok  "} ${shape.padEnd(16)} footprint ${used.toFixed(2)}m` +
      ` vs geometry half-extent ${halfGeo.toFixed(2)}m  (${(frac * 100).toFixed(0)}%)`,
  );
}

console.log(
  `\n${checked} shape(s) checked, ${failed} wider than their geometry.`,
);
if (failed) {
  console.log(
    "A footprint wider than its geometry is an invisible wall. Re-derive it at\n" +
      "car height (0-1.5m) from world/setpieces/geometry.ts, not from the\n" +
      "bounding volume — the bounding SPHERE of a furnace stack is 13m for a\n" +
      "body that is 5.2m across.",
  );
}

/* ── roadside furniture ────────────────────────────────────────────────
 *
 * The same tripwire, plus the two things a set piece never needed.
 *
 * A set piece is placed once, in the open, tens of metres from anything. The
 * roadside families are solved ONTO the verge, four of them, in bands a metre
 * apart, by a solver that pushes an anchor outward by however much it takes to
 * clear the run-off — which is a different amount for each family, because each
 * asks for a different clearance radius. Two consequences that cannot be seen by
 * reading:
 *
 *  1. A capsule can end up on drivable gravel. The solver's contract says it
 *     cannot, so this half of the check should always pass; it is here because
 *     the contract is five lines of retry loop in a different file and the
 *     symptom of breaking it is an invisible wall on the racing line. The
 *     MINIMUM clearance actually achieved is printed either way, because a check
 *     that only ever says "ok" teaches you nothing about how close it came.
 *
 *  2. Two families can end up solid in the same place. Nothing prevents it:
 *     rail asks for 0.70m of clearance and lamps for 0.75m, so on a stretch
 *     where the loop doubles back they are pushed out by different amounts and
 *     can cross. A car wedged between a guard rail and a lamp column standing
 *     inside it is not a bug anybody would guess at from the source.
 *
 * Runs every circuit, because these are solved per circuit and Ash Spire being
 * fine says nothing about the Dead Mile.
 */
const scatterGeom = await jiti.import("../src/game/world/scatter/geometry.ts");
const layoutMod = await jiti.import("../src/game/world/scatter/roadsideLayout.ts");
const placement = await jiti.import("../src/game/world/scatter/placement.ts");
const fieldsMod = await jiti.import("../src/game/world/scatter/fields.ts");
const track = await jiti.import("../src/game/track.ts");

const TRACKS = [
  "ash_spire",
  "cinder_bowl",
  "foundry_pit",
  "rustline",
  "sable_run",
  "dead_mile",
];

/** Triangles in a geometry, indexed or not. */
const tris = (g) =>
  g.index ? g.index.count / 3 : g.attributes.position.count / 3;

/** Half-extent in XZ — the axis a car actually runs into. */
function halfExtent(g) {
  g.computeBoundingBox();
  const b = g.boundingBox;
  return Math.max((b.max.x - b.min.x) / 2, (b.max.z - b.min.z) / 2);
}

console.log("\n── roadside furniture ─────────────────────────────────────");

// Same rule as above: a collider must never be wider than what you can see.
const lampGeo = scatterGeom.lampPostGeometry();
const signGeo = scatterGeom.signGeometry();
const wireGeo = scatterGeom.catenaryWireGeometry(30);
const glowGeo = scatterGeom.lampGlowGeometry();
const cactusGeo = scatterGeom.cactusGeometry();
const railGeo = scatterGeom.railModuleGeometry(4);
const boardGeo = scatterGeom.boardGeometry();

for (const [name, r, g] of [
  ["lampPost", layoutMod.LAMP_CAPSULE_R, lampGeo],
  ["sign", layoutMod.SIGN_CAPSULE_R, signGeo],
  ["guardRail", layoutMod.RAIL_CAPSULE_R, railGeo],
]) {
  const he = halfExtent(g);
  const frac = r / he;
  const bad = frac > MAX_FRAC;
  if (bad) failed++;
  console.log(
    `  ${bad ? "FAIL" : "ok  "} ${name.padEnd(16)} capsule ${r.toFixed(2)}m` +
      ` vs geometry half-extent ${he.toFixed(2)}m  (${(frac * 100).toFixed(0)}%)`,
  );
}

console.log(
  "\n  triangles per module: " +
    [
      ["lampPost", lampGeo],
      ["catenary", wireGeo],
      ["lampGlow", glowGeo],
      ["sign", signGeo],
      ["cactus", cactusGeo],
      ["guardRail", railGeo],
      ["hoarding", boardGeo],
    ]
      .map(([n, g]) => `${n} ${tris(g)}`)
      .join(", "),
);

/** Distance from a point to a capsule's axis, minus the capsule radius. */
function gapToCapsule(px, pz, c) {
  const sx = c.x1 - c.x0;
  const sz = c.z1 - c.z0;
  const len2 = sx * sx + sz * sz;
  let t = 0;
  if (len2 > 1e-8) {
    t = ((px - c.x0) * sx + (pz - c.z0) * sz) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  return Math.hypot(c.x0 + sx * t - px, c.z0 + sz * t - pz) - c.r;
}

let worstClear = Infinity;
let worstClearAt = "";
let worstGap = Infinity;
let worstGapAt = "";
let roadsideFails = 0;
const totals = { lamps: 0, wires: 0, signs: 0, rail: 0, boards: 0, cactus: 0 };

console.log(
  "\n  circuit        lamps  wires  signs   rail  boards  cactus   min clear  min gap",
);

for (const id of TRACKS) {
  track.setActiveTrack(id);
  const L = layoutMod.roadsideLayout();
  const fields = fieldsMod.buildScatterFields();
  totals.lamps += L.lamps.length;
  totals.wires += L.wires.length;
  totals.signs += L.signs.length;
  totals.rail += L.rail.length;
  totals.boards += L.boards.length;
  totals.cactus += fields.cactus.length;

  /*
   * Every wire span must join two columns on the SAME verge.
   *
   * `vergePoints` interleaves the two sides at every anchor, so a span list
   * built by walking that list directly would zigzag across the carriageway —
   * a distribution line hanging over the racing line, at eight metres, with no
   * collider under it. It would also look deliberate, which is what makes it
   * worth asserting rather than eyeballing.
   */
  for (const w of L.wires) {
    const a = L.lamps[w.a];
    const b = L.lamps[w.b];
    if (!a || !b || a.side !== b.side) {
      console.log(`  FAIL ${id}: wire span ${w.a}-${w.b} crosses the road`);
      roadsideFails++;
      break;
    }
  }

  // Clearance of each solid capsule from the outer edge of the drivable apron.
  let clear = Infinity;
  const probe = (x, z, r, what) => {
    const s = track.getSurfaceAt(x, z);
    const c = s.dist - (s.half + placement.APRON_M) - r;
    if (c < clear) clear = c;
    if (c < 0.15) {
      console.log(
        `  FAIL ${id}: ${what} at ${x.toFixed(1)},${z.toFixed(1)} is ${c.toFixed(2)}m from drivable surface`,
      );
      roadsideFails++;
    }
  };
  for (const l of L.lamps) probe(l.x, l.z, layoutMod.LAMP_CAPSULE_R, "lamp");
  for (const s of L.signs) probe(s.x, s.z, layoutMod.SIGN_CAPSULE_R, "sign");

  /*
   * Band separation, lamp against rail. Only this pair is checked because only
   * this pair is both SOLID and close: signs have no collider (see
   * RoadsideFurniture's SIGN_DENSITY note), and the hoardings sit 2.5m outboard
   * of the lamps.
   */
  const railCaps = L.rail.map((m) => ({
    x0: m.ax,
    z0: m.az,
    x1: m.bx,
    z1: m.bz,
    r: layoutMod.RAIL_CAPSULE_R,
  }));
  let gap = Infinity;
  for (const l of L.lamps) {
    for (const c of railCaps) {
      // Cheap reject: rail modules are ~4m long, so anything whose midpoint is
      // far away cannot be the nearest one.
      if (Math.abs(c.x0 - l.x) > 30 || Math.abs(c.z0 - l.z) > 30) continue;
      const g = gapToCapsule(l.x, l.z, c) - layoutMod.LAMP_CAPSULE_R;
      if (g < gap) gap = g;
    }
  }
  if (gap < 0) {
    console.log(`  FAIL ${id}: a lamp column overlaps the guard rail by ${(-gap).toFixed(2)}m`);
    roadsideFails++;
  }
  if (clear < worstClear) {
    worstClear = clear;
    worstClearAt = id;
  }
  if (gap < worstGap) {
    worstGap = gap;
    worstGapAt = id;
  }

  console.log(
    `  ${id.padEnd(14)}${String(L.lamps.length).padStart(5)}` +
      `${String(L.wires.length).padStart(7)}${String(L.signs.length).padStart(7)}` +
      `${String(L.rail.length).padStart(7)}${String(L.boards.length).padStart(8)}` +
      `${String(fields.cactus.length).padStart(8)}` +
      `${clear.toFixed(2).padStart(12)}m${(Number.isFinite(gap) ? gap.toFixed(2) : "n/a").padStart(9)}m`,
  );
}

console.log(
  `\n  totals across six circuits: ${totals.lamps} lamps, ${totals.wires} wire spans, ` +
    `${totals.signs} signs, ${totals.cactus} cactus stands`,
);
console.log(
  `  tightest clearance ${worstClear.toFixed(2)}m (${worstClearAt}), ` +
    `tightest lamp-to-rail gap ${worstGap.toFixed(2)}m (${worstGapAt})`,
);

failed += roadsideFails;
if (roadsideFails) {
  console.log(
    "\nA roadside capsule on drivable surface is an invisible wall on the racing\n" +
      "line. Widen the family's CLEAR_R in world/scatter/roadsideLayout.ts — the\n" +
      "verge solver pushes an anchor outward until it satisfies that radius, so\n" +
      "that is the knob, not the offset.",
  );
}
process.exit(failed ? 1 : 0);
