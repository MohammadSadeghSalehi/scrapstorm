#!/usr/bin/env node
/**
 * Decide a vehicle's LENGTH axis from the vertex cloud, not the bounding box.
 *
 *   node scripts/measure-car-axis.mjs refs/mesh/cars/*.glb
 *
 * WHY. GltfCar aligns a car by taking the longer of the bounding box's X and Z
 * extents as its length. That works while a car is longer than it is wide, and
 * fails silently when it is not: the ArmoredTankTruck measures 6.80 x 6.78, a
 * 0.3% margin, so which axis "wins" is effectively arbitrary. Lose that coin
 * toss and the car is rotated 90 degrees — it drives sideways, which is exactly
 * what was reported.
 *
 * A bounding box is the wrong instrument because ONE wide feature sets it. A
 * turret, a ram plate or a pair of stacks makes a long vehicle measure square
 * while almost all of its mass still lies along its length.
 *
 * So this takes the principal axis of the horizontal vertex distribution
 * instead — the eigenvector of the 2x2 XZ covariance with the larger
 * eigenvalue. That answers "which way is this object actually extended", which
 * is the question, and one wide protrusion cannot dominate it the way it
 * dominates an extent.
 *
 * `confidence` is the eigenvalue ratio: 1.0 means genuinely square and nothing
 * can save it, while a normal car sits well above 2.
 */
import { readFileSync } from "node:fs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!files.length) {
  console.error("usage: measure-car-axis.mjs <file.glb> [...]");
  process.exit(1);
}

const COMP = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function positions(path) {
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
  if (!json || !bin) return null;
  if (json.extensionsRequired?.length) {
    // Compressed streams need a decoder; the uncompressed source in refs/ is
    // the right input for this measurement anyway.
    return { compressed: json.extensionsRequired.join(",") };
  }
  const out = [];
  for (const m of json.meshes ?? []) {
    for (const p of m.primitives ?? []) {
      const ai = p.attributes?.POSITION;
      if (ai === undefined) continue;
      const acc = json.accessors[ai];
      const bv = json.bufferViews[acc.bufferView];
      const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      const n = NUM[acc.type];
      const cs = COMP[acc.componentType];
      const stride = bv.byteStride || n * cs;
      for (let e = 0; e < acc.count; e++) {
        const o = base + e * stride;
        out.push([bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8)]);
      }
    }
  }
  return { pts: out };
}

for (const f of files) {
  const r = positions(f);
  const name = f.split(/[\\/]/).pop();
  if (!r) {
    console.log(`${name}: unreadable`);
    continue;
  }
  if (r.compressed) {
    console.log(`${name}: compressed (${r.compressed}) — measure the refs/ source`);
    continue;
  }
  const pts = r.pts;
  let cx = 0;
  let cz = 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    cx += p[0];
    cz += p[2];
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  cx /= pts.length;
  cz /= pts.length;

  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const p of pts) {
    const dx = p[0] - cx;
    const dz = p[2] - cz;
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
  }
  sxx /= pts.length;
  szz /= pts.length;
  sxz /= pts.length;

  // Eigenvalues of [[sxx, sxz], [sxz, szz]].
  const tr = sxx + szz;
  const det = sxx * szz - sxz * sxz;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  // Eigenvector for l1.
  let vx = sxz;
  let vz = l1 - sxx;
  if (Math.abs(vx) < 1e-9 && Math.abs(vz) < 1e-9) {
    vx = 1;
    vz = 0;
  }
  const vl = Math.hypot(vx, vz);
  vx /= vl;
  vz /= vl;

  const bboxLong = maxX - minX >= maxZ - minZ ? "X" : "Z";
  const pcaLong = Math.abs(vx) >= Math.abs(vz) ? "X" : "Z";
  const bboxRatio =
    Math.max(maxX - minX, maxZ - minZ) / Math.min(maxX - minX, maxZ - minZ);
  const conf = l2 > 1e-12 ? l1 / l2 : Infinity;

  console.log(
    `${name.replace("SM_MeshGen_", "").padEnd(30)} ` +
      `bbox ${(maxX - minX).toFixed(2)}x${(maxZ - minZ).toFixed(2)} -> ${bboxLong} (${bboxRatio.toFixed(3)})   ` +
      `pca -> ${pcaLong}  conf ${conf.toFixed(2)}  axis(${vx.toFixed(3)}, ${vz.toFixed(3)})` +
      (bboxLong !== pcaLong ? "   *** DISAGREE ***" : ""),
  );
}
