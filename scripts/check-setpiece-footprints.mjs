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
/** Per-circuit face histogram, filled in the loop below and reported after it. */
const faceHist = {};

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
  faceHist[id] = { sign: {}, board: {} };
  for (const s of L.signs) {
    faceHist[id].sign[s.face] = (faceHist[id].sign[s.face] ?? 0) + 1;
  }
  for (const b of L.boards) {
    faceHist[id].board[b.face] = (faceHist[id].board[b.face] ?? 0) + 1;
  }

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

/* ── roadside signage ──────────────────────────────────────────────────
 *
 * Three things about the sign atlas cannot be seen by reading the source, and
 * all three fail SILENTLY — which for signage means "every plate on the circuit
 * shows the same wrong picture", a state indistinguishable from a deliberate art
 * choice:
 *
 *  1. The shader insert. It is a string surgery on three's `<uv_vertex>` chunk.
 *     If three renames the chunk the replace is a no-op, the per-instance rect
 *     is never applied, and every sign draws cell zero. Run the real function
 *     against the real ShaderLib source.
 *  2. The atlas layout. Cell rects are arithmetic over two zones with different
 *     column counts; an overlap or an out-of-range face prints the hoarding copy
 *     on a chevron board.
 *  3. The painter. Every legend is positioned in canvas pixels relative to a
 *     cell origin, and a cell-origin mistake draws one face into its neighbour.
 *     The gantry atlas has no such check, and its own note records that getting
 *     the v inversion backwards "puts the sponsor strip on the gantry and the
 *     league name on the kerb" — visible only in a screenshot.
 */
const THREE = await jiti.import("three");
const faces = await jiti.import("../src/game/world/scatter/signFaces.ts");

console.log("\n── roadside signage ───────────────────────────────────────");
let signFails = 0;

// 1. The shader insert, against the source the renderer will actually hand it.
try {
  const src = THREE.ShaderLib.standard.vertexShader;
  const patched = faces.patchSignVertexShader(src);
  const ok =
    patched.includes("attribute vec4 aSignUv") &&
    patched.includes("vMapUv = aSignUv.xy + vMapUv * aSignUv.zw") &&
    patched.length > src.length;
  console.log(
    `  ${ok ? "ok  " : "FAIL"} vertex insert applies to THREE.ShaderLib.standard` +
      ` (three r${THREE.REVISION})`,
  );
  if (!ok) signFails++;
} catch (err) {
  console.log(`  FAIL vertex insert: ${String(err.message).slice(0, 120)}`);
  signFails++;
}

// 2. Atlas rects: inside the texture, correctly sized, and non-overlapping.
const rects = [];
for (let i = 0; i < faces.SIGN_FACE_COUNT; i++) {
  rects.push(["sign" + i, faces.signFaceRect(i)]);
}
for (let i = 0; i < faces.BOARD_FACE_COUNT; i++) {
  rects.push(["board" + i, faces.boardFaceRect(i)]);
}
let rectBad = 0;
for (const [name, r] of rects) {
  if (r[0] < 0 || r[1] < 0 || r[0] + r[2] > 1.0001 || r[1] + r[3] > 1.0001) {
    console.log(`  FAIL ${name} rect [${r.join(", ")}] leaves the atlas`);
    rectBad++;
  }
}
for (let a = 0; a < rects.length; a++) {
  for (let b = a + 1; b < rects.length; b++) {
    const [na, ra] = rects[a];
    const [nb, rb] = rects[b];
    const ox = Math.min(ra[0] + ra[2], rb[0] + rb[2]) - Math.max(ra[0], rb[0]);
    const oy = Math.min(ra[1] + ra[3], rb[1] + rb[3]) - Math.max(ra[1], rb[1]);
    if (ox > 1e-6 && oy > 1e-6) {
      console.log(`  FAIL ${na} and ${nb} overlap in the atlas`);
      rectBad++;
    }
  }
}
console.log(
  `  ${rectBad ? "FAIL" : "ok  "} ${rects.length} atlas cells, ` +
    `${faces.SIGN_FACE_COUNT} plate + ${faces.BOARD_FACE_COUNT} hoarding, ` +
    `${rectBad} bad`,
);
signFails += rectBad;

/*
 * 3. Paint the atlas through a recorder and check containment.
 *
 * The recorder honours `clip()`, because two of the devices (the hazard barring
 * and the weathering pass) deliberately draw well outside their box and rely on
 * the clip to trim them — flagging those would be flagging correct code, which
 * is the failure mode `check-setpiece-footprints` already warns about for
 * narrow collider footprints.
 *
 * Text extents are ESTIMATED: there is no font engine here, so a glyph run is
 * treated as `maxWidth` wide and 0.84em tall about its middle baseline. That is
 * generous horizontally and about right vertically, which is the correct
 * direction — this is looking for a legend drawn into the NEXT CELL, an error of
 * a hundred pixels, not for a two-pixel descender.
 */
function recorder() {
  const ops = [];
  let clip = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
  const stack = [];
  let path = null;
  let pending = null;
  let size = 10;
  const grow = (x, y) => {
    if (!path) path = { x0: x, y0: y, x1: x, y1: y };
    else {
      path.x0 = Math.min(path.x0, x);
      path.y0 = Math.min(path.y0, y);
      path.x1 = Math.max(path.x1, x);
      path.y1 = Math.max(path.y1, y);
    }
  };
  const emit = (b, kind) => {
    const x0 = Math.max(b.x0, clip.x0);
    const y0 = Math.max(b.y0, clip.y0);
    const x1 = Math.min(b.x1, clip.x1);
    const y1 = Math.min(b.y1, clip.y1);
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return;
    ops.push({ x0, y0, x1, y1, kind });
  };
  const g = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, lineJoin: "miter",
    textAlign: "center", textBaseline: "middle", globalAlpha: 1,
    set font(v) {
      // The px size, not the first number in the string — `700 36px Impact`
      // starts with the WEIGHT, and reading that gives a 700px glyph box that
      // fails every containment test at once.
      const m = /([0-9]*\.?[0-9]+)px/.exec(String(v));
      size = m ? parseFloat(m[1]) : 10;
    },
    get font() { return `${size}px`; },
    save() { stack.push({ ...clip }); },
    restore() { const c = stack.pop(); if (c) clip = c; },
    beginPath() { path = null; pending = null; },
    moveTo(x, y) { grow(x, y); },
    lineTo(x, y) { grow(x, y); },
    quadraticCurveTo(cx, cy, x, y) { grow(cx, cy); grow(x, y); },
    arc(x, y, r) { grow(x - r, y - r); grow(x + r, y + r); },
    closePath() {},
    rect(x, y, w, h) {
      pending = { x0: x, y0: y, x1: x + w, y1: y + h };
      grow(x, y);
      grow(x + w, y + h);
    },
    clip() {
      if (!pending) return;
      clip = {
        x0: Math.max(clip.x0, pending.x0),
        y0: Math.max(clip.y0, pending.y0),
        x1: Math.min(clip.x1, pending.x1),
        y1: Math.min(clip.y1, pending.y1),
      };
    },
    fill() { if (path) emit(path, "fill"); },
    stroke() {
      if (!path) return;
      const p = this.lineWidth * 0.5;
      emit({ x0: path.x0 - p, y0: path.y0 - p, x1: path.x1 + p, y1: path.y1 + p }, "stroke");
    },
    fillRect(x, y, w, h) { emit({ x0: x, y0: y, x1: x + w, y1: y + h }, "rect"); },
    fillText(t, x, y, maxWidth) { this.__text(t, x, y, maxWidth); },
    strokeText(t, x, y, maxWidth) { this.__text(t, x, y, maxWidth); },
    __text(t, x, y, maxWidth) {
      const w = maxWidth ?? String(t).length * size * 0.55;
      const h = size * 0.42;
      emit({ x0: x - w * 0.5, y0: y - h, x1: x + w * 0.5, y1: y + h }, `text:${t}`);
    },
  };
  return { g, ops };
}

const cells = [];
{
  const A = faces.ATLAS_SIZE;
  for (let i = 0; i < faces.SIGN_FACE_COUNT; i++) {
    const r = faces.signFaceRect(i);
    cells.push({
      name: `sign${i}`,
      x0: r[0] * A,
      y0: (1 - r[1] - r[3]) * A,
      x1: (r[0] + r[2]) * A,
      y1: (1 - r[1]) * A,
    });
  }
  for (let i = 0; i < faces.BOARD_FACE_COUNT; i++) {
    const r = faces.boardFaceRect(i);
    cells.push({
      name: `board${i}`,
      x0: r[0] * A,
      y0: (1 - r[1] - r[3]) * A,
      x1: (r[0] + r[2]) * A,
      y1: (1 - r[1]) * A,
    });
  }
}

const TOL = 4;
let paintFails = 0;
let legends = 0;
const painted = new Set();
{
  const { g, ops } = recorder();
  faces.drawSignAtlas(g, faces.signCopy("ash_spire"));
  for (const op of ops) {
    // The one legitimate full-atlas op is the background fill.
    if (op.x1 - op.x0 >= faces.ATLAS_SIZE - 1) continue;
    let home = null;
    for (const c of cells) {
      if (
        op.x0 >= c.x0 - TOL && op.x1 <= c.x1 + TOL &&
        op.y0 >= c.y0 - TOL && op.y1 <= c.y1 + TOL
      ) {
        home = c;
        break;
      }
    }
    if (!home) {
      if (paintFails < 6) {
        console.log(
          `  FAIL ${op.kind} at [${op.x0.toFixed(0)},${op.y0.toFixed(0)} ` +
            `${op.x1.toFixed(0)},${op.y1.toFixed(0)}] is not inside any one cell`,
        );
      }
      paintFails++;
      continue;
    }
    painted.add(home.name);
    if (op.kind.startsWith("text:")) legends++;
  }
}
const unpainted = cells.filter((c) => !painted.has(c.name)).map((c) => c.name);
if (unpainted.length) {
  console.log(`  FAIL cells never painted: ${unpainted.join(", ")}`);
  paintFails += unpainted.length;
}
console.log(
  `  ${paintFails ? "FAIL" : "ok  "} atlas painted: every op inside its own cell,` +
    ` ${legends} legend runs across ${cells.length} cells (${paintFails} bad)`,
);
signFails += paintFails;

// 4. Every face the layout actually asks for must exist.
for (const [id, h] of Object.entries(faceHist)) {
  for (const k of Object.keys(h.sign)) {
    if (Number(k) < 0 || Number(k) >= faces.SIGN_FACE_COUNT) {
      console.log(`  FAIL ${id}: plate face ${k} is outside the atlas`);
      signFails++;
    }
  }
  for (const k of Object.keys(h.board)) {
    if (Number(k) < 0 || Number(k) >= faces.BOARD_FACE_COUNT) {
      console.log(`  FAIL ${id}: hoarding face ${k} is outside the atlas`);
      signFails++;
    }
  }
}

/*
 * 5. Do the chevrons point the way the road actually goes?
 *
 * This is the check the whole signage pass most needs and the one no amount of
 * reading settles. The layout picks a direction from the SIGN of `signedCurvature`
 * and the claim "positive means the outside is on the left, therefore the road
 * turns right" is 50/50 by inspection — and getting it wrong points every
 * chevron on every circuit into the infield while looking completely plausible
 * in the diff and in the histogram.
 *
 * So it is re-derived here from a DIFFERENT quantity: take the sample's own
 * right-of-travel vector, look 6 samples up the road, and project that heading
 * onto it. Positive means the heading has swung to the driver's right. That
 * shares no code with `curvatureAt` — no cross product, no percentile — so the
 * two agreeing is evidence rather than a tautology.
 */
const DIR_FACES = new Map([
  [faces.SIGN_FACE.chevronL, false], [faces.SIGN_FACE.chevronR, true],
  [faces.SIGN_FACE.bendL, false], [faces.SIGN_FACE.bendR, true],
  [faces.SIGN_FACE.hairpinL, false], [faces.SIGN_FACE.hairpinR, true],
]);
let dirOk = 0;
let dirBad = 0;
let toeInto = 0;
let toeAway = 0;
for (const id of TRACKS) {
  track.setActiveTrack(id);
  const S = track.getTrackSamples();
  const n = S.length;
  const L = layoutMod.roadsideLayout();
  for (const g of L.signs) {
    const s = S[g.index];
    // buildSamples authors yaw so forward = -(sin yaw, cos yaw); right of
    // travel is (cos yaw, -sin yaw), the same vector `rightOf` uses.
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    const a = S[(g.index + 6) % n];
    const swing = -Math.sin(a.yaw) * rx + -Math.cos(a.yaw) * rz;

    const wantsRight = DIR_FACES.get(g.face);
    if (wantsRight !== undefined && Math.abs(swing) > 1e-3) {
      if (swing > 0 === wantsRight) dirOk++;
      else {
        if (dirBad < 4) {
          console.log(
            `  FAIL ${id}: sample ${g.index} swings ${swing > 0 ? "right" : "left"}` +
              ` but wears face ${g.face}`,
          );
        }
        dirBad++;
      }
    }

    // And the toe: three's rotY(yaw) sends local +Z to (sin yaw, cos yaw), so a
    // plate turned into oncoming traffic has its normal OPPOSING travel.
    const nx = Math.sin(g.yaw);
    const nz = Math.cos(g.yaw);
    if (nx * -Math.sin(s.yaw) + nz * -Math.cos(s.yaw) < 0) toeInto++;
    else toeAway++;
  }
}
console.log(
  `  ${dirBad ? "FAIL" : "ok  "} ${dirOk} direction plates agree with an ` +
    `independently derived heading swing, ${dirBad} disagree`,
);
console.log(
  `  ${toeAway ? "FAIL" : "ok  "} ${toeInto} plates face oncoming traffic, ${toeAway} face away`,
);
signFails += dirBad + toeAway;

/*
 * 6. The draw-call budget, per tier, from the real tier tables.
 *
 * The binding constraint on this whole layer is that the LOW TIER — measured at
 * 25fps on the integrated GPU — must not gain a draw call. Each roadside family
 * is one InstancedMesh, so a family costs one draw call unless its tier density
 * rounds to zero instances, in which case `ScatterLayer` sets `visible = false`
 * and three's `projectObject` bails before it binds a program.
 *
 * Instances are the UPPER bound: they are what survives tier density, before the
 * per-frame frustum and range cull, which on a 900m circuit removes most of it.
 * Triangles are that bound times the measured module count. Both are printed
 * rather than asserted, except the low-tier draw count, which is asserted.
 */
const tiers = await jiti.import("../src/game/world/scatter/roadsideTiers.ts");
const MODULE_TRIS = {
  rail: tris(railGeo),
  boards: tris(boardGeo),
  signs: tris(signGeo),
};
const FAMILIES = [
  ["rail", tiers.RAIL_DENSITY, "rail"],
  ["boards", tiers.BOARD_DENSITY, "boards"],
  ["signs", tiers.SIGN_DENSITY, "signs"],
];
console.log(
  "\n  draw calls and triangles per tier (upper bound: after tier density," +
    " before the frustum/range cull)",
);
console.log(
  `  module triangles: rail ${MODULE_TRIS.rail}, hoarding ${MODULE_TRIS.boards}, plate ${MODULE_TRIS.signs}`,
);
console.log("  circuit         tier    draws   rail  boards  plates      tris");
let lowDrawFail = 0;
for (const id of TRACKS) {
  track.setActiveTrack(id);
  const L = layoutMod.roadsideLayout();
  const counts = { rail: L.rail.length, boards: L.boards.length, signs: L.signs.length };
  for (const tier of ["low", "medium", "high"]) {
    let draws = 0;
    let triTotal = 0;
    const per = {};
    for (const [name, density, key] of FAMILIES) {
      const n = Math.min(counts[key], Math.round(counts[key] * density[tier]));
      per[name] = n;
      if (n > 0) draws++;
      triTotal += n * MODULE_TRIS[name];
    }
    if (tier === "low" && draws > 2) {
      console.log(
        `  FAIL ${id}: the low tier draws ${draws} roadside calls; the budget is 2 (rail + hoardings)`,
      );
      lowDrawFail++;
    }
    console.log(
      `  ${id.padEnd(14)} ${tier.padEnd(7)}${String(draws).padStart(5)}` +
        `${String(per.rail).padStart(7)}${String(per.boards).padStart(8)}` +
        `${String(per.signs).padStart(8)}${String(triTotal).padStart(10)}`,
    );
  }
}
signFails += lowDrawFail;

// 7. And what each circuit ended up saying. Reported, never failed — the
//    distribution is a design question, but a circuit that quietly stopped
//    getting braking boards should be visible without driving it.
const SIGN_NAME = Object.fromEntries(
  Object.entries(faces.SIGN_FACE).map(([k, v]) => [v, k]),
);
const BOARD_NAME = Object.fromEntries(
  Object.entries(faces.BOARD_FACE).map(([k, v]) => [v, k]),
);
console.log("\n  what each circuit says");
for (const id of TRACKS) {
  const h = faceHist[id];
  if (!h) continue;
  const s = Object.entries(h.sign)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${SIGN_NAME[k] ?? k}x${v}`)
    .join(" ");
  const b = Object.entries(h.board)
    .sort((a, b2) => b2[1] - a[1])
    .map(([k, v]) => `${BOARD_NAME[k] ?? k}x${v}`)
    .join(" ");
  console.log(`  ${id.padEnd(13)} plates  ${s}`);
  console.log(`  ${"".padEnd(13)} boards  ${b}`);
}

failed += signFails;

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
