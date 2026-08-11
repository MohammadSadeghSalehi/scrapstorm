#!/usr/bin/env node
/**
 * Strict bounding box vs percentile bounding box, for the weapon meshes.
 *
 * WHY THIS EXISTS. WeaponMounts seats a prop on a car by adding HALF THE MESH
 * BOX HEIGHT to the measured roof, which is exactly right for a mesh whose box
 * is its silhouette. These assets are surface reconstructions — thousands of
 * disconnected shells, fewer triangles than vertices — and reconstruction
 * leaves specks floating clear of the body that decimation cannot remove,
 * because meshoptimizer preserves component count. `computeBoundingBox` is a
 * strict min/max, so one speck 40cm above a turret makes the box 40cm taller
 * than the turret and the prop is seated half that clear of the roof.
 *
 * That was the diagnosis for hardware hovering over some cars and not others.
 * It is a claim about the DATA, so it is checkable against the data rather than
 * by looking at the game: if the strict box and a 1st/99th percentile box agree,
 * the theory is wrong and the float is somewhere else entirely.
 *
 * Reads refs/mesh/weapons — the SOURCE meshes, before the import pipeline
 * compresses them. A self-contained GLB reader rather than @gltf-transform,
 * which this repo only ever invokes through `npx` and is not installed: the
 * whole point of this check is that it can be run at any time without a
 * network. Uncompressed float POSITION only, which is what the generator emits;
 * anything else is reported rather than guessed at.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = existsSync("refs/mesh/weapons")
  ? "refs/mesh/weapons"
  : "public/assets/meshes/weapons";

/** Minimal GLB -> { json, bin }. */
function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
  let off = 12;
  let json = null;
  let bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const start = off + 8;
    const chunk = buf.subarray(start, start + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
    else if (type === 0x004e4942) bin = chunk;
    off = start + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

const COMPONENT = { 5126: Float32Array };

function positions(path) {
  const { json, bin } = readGlb(path);
  if (!json || !bin) return { err: "no chunks" };
  if (json.extensionsUsed?.some((e) => /meshopt|draco/i.test(e))) {
    return { err: `compressed (${json.extensionsUsed.join(", ")})` };
  }
  const out = [];
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const ai = prim.attributes?.POSITION;
      if (ai === undefined) continue;
      const acc = json.accessors[ai];
      const Ctor = COMPONENT[acc.componentType];
      if (!Ctor || acc.type !== "VEC3") return { err: "unsupported accessor" };
      const bv = json.bufferViews[acc.bufferView];
      const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      // Interleaved data would need the stride walked element by element; the
      // generator does not emit it, so this reports rather than mis-reads.
      if (bv.byteStride && bv.byteStride !== 12) return { err: "interleaved" };
      const arr = new Ctor(bin.buffer, bin.byteOffset + base, acc.count * 3);
      out.push(arr);
    }
  }
  return { arrays: out };
}

const pct = (s, q) =>
  s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))];

/*
 * Mirrors SPEC in src/game/world/weaponMeshes.ts.
 *
 * A percentage is not actionable — the meshes are scaled to a gameplay size, so
 * the only figure that says whether this is visible is the seating error in
 * CENTIMETRES on the finished prop. `align` is applied before the fit, which is
 * why the axis the length describes is not always the source Y.
 */
const SPEC = {
  ScrapMetalRocket: { length: 0.8, fit: "along", align: "z" },
  RustyIndustrialSawBlade: { length: 0.8, fit: "across", align: "z" },
  ImprovisedSpikedMine: { length: 0.55, fit: "along", align: "z" },
  WastelandHeavyTurret: { length: 1.15, fit: "along", align: "z" },
  ImprovisedQuadLauncher: { length: 1.1, fit: "along", align: "z" },
};

let worst = 0;
let worstName = "";
console.log(`reading ${DIR}\n`);

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".glb"))) {
  const name = file.replace(/^SM_MeshGen_|\.glb$/g, "");
  const { arrays, err } = positions(join(DIR, file));
  if (err) {
    console.log(`${name.padEnd(26)} SKIPPED — ${err}`);
    continue;
  }
  const xs = [];
  const ys = [];
  const zs = [];
  for (const a of arrays) {
    for (let i = 0; i < a.length; i += 3) {
      xs.push(a[i]);
      ys.push(a[i + 1]);
      zs.push(a[i + 2]);
    }
  }
  if (!ys.length) {
    console.log(`${name.padEnd(26)} no positions`);
    continue;
  }
  for (const s of [xs, ys, zs]) s.sort((a, b) => a - b);
  const ext = (s) => s[s.length - 1] - s[0];
  const rob = (s) => pct(s, 0.99) - pct(s, 0.01);

  const strict = ext(ys);
  const robust = rob(ys);
  const frac = strict > 0 ? 1 - robust / strict : 0;

  // The scale the loader applies: length / reference extent, where the
  // reference is the fit axis measured the SAME way the loader measures it.
  const spec = SPEC[name];
  let cm = null;
  if (spec) {
    const ref =
      spec.fit === "along" ? ext(zs) : Math.max(ext(xs), ext(ys));
    const s = ref > 0 ? spec.length / ref : 0;
    // Seated half the inflation too high, in finished metres.
    cm = ((strict - robust) * s * 100) / 2;
  }

  if (frac > worst) {
    worst = frac;
    worstName = name;
  }
  console.log(
    `${name.padEnd(26)} verts ${String(ys.length).padStart(7)}  ` +
      `inflated ${(frac * 100).toFixed(1)}%` +
      (cm === null ? "" : `  -> ${cm.toFixed(1)} cm too high on the finished prop`),
  );
}

console.log(
  `\nworst: ${worstName} at ${(worst * 100).toFixed(1)}% box inflation.\n` +
    (worst > 0.05
      ? "CONFIRMS the diagnosis: the strict box is materially taller than the body,\n" +
        "and by a different amount per asset — which is why only some looked wrong."
      : "REFUTES the diagnosis: the boxes agree, so the hover is not bbox inflation."),
);
