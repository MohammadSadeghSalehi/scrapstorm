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
process.exit(failed ? 1 : 0);
