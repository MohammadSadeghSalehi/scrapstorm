#!/usr/bin/env node
/**
 * Snap-weld a GLB so it can actually be simplified.
 *
 *   node scripts/spatial-weld.mjs in.glb out.glb [--tol 0.004]
 *
 * WHY. gltf-transform's `weld` merges only vertices that are already bitwise
 * identical, and image-to-3D output arrives already indexed — measured, it
 * merged 12 vertices out of 75,118 on the rocket. The mesh is nonetheless made
 * of thousands of DISCONNECTED SHELLS whose surfaces touch but whose vertices
 * differ in the last few decimal places. meshoptimizer preserves component
 * count and will not collapse an edge that is not shared, so the simplifier
 * floors: the rocket stopped at 11,652 triangles even at --ratio 0.001
 * --error 1, and its lod1 and lod2 came out within 20 triangles of each other.
 *
 * The fix is to make the shells share vertices. Quantising positions onto a
 * grid and re-indexing does that: surfaces that were 0.0001 apart become the
 * same vertex, the shells fuse into a connected manifold, and the simplifier
 * has edges to collapse.
 *
 * Tolerance is a FRACTION OF THE BOUNDING-BOX DIAGONAL, not an absolute, so the
 * same number is meaningful for a 30cm rocket and a 7m truck. Too small and
 * nothing fuses; too large and separate parts that should stay separate (a
 * barrel beside a wheel) merge into one blob. 0.004 is about a quarter of one
 * percent of the object's size.
 *
 * Normals are dropped, not averaged. A quantised vertex is shared by faces that
 * used to belong to different shells and can point in opposite directions;
 * averaging those gives a normal that is wrong for every face using it.
 * Dropping them lets the downstream tool recompute from the fused topology,
 * which is the only version that is actually correct.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath, ...rest] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: spatial-weld.mjs in.glb out.glb [--tol 0.004]");
  process.exit(1);
}
const tolIdx = rest.indexOf("--tol");
const TOL_FRAC = tolIdx > -1 ? Number(rest[tolIdx + 1]) : 0.004;

/* ── GLB container ────────────────────────────────────────────────── */

const buf = readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
let off = 12;
let json = null;
let bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
  else if (type === 0x004e4942) bin = Buffer.from(data);
  off += 8 + len + ((4 - (len % 4)) % 4);
}
if (!json || !bin) throw new Error("GLB missing JSON or BIN chunk");

const COMP = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(i) {
  const acc = json.accessors[i];
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const n = NUM[acc.type];
  const cs = COMP[acc.componentType];
  // A bufferView stride of 0 means tightly packed.
  const stride = bv.byteStride || n * cs;
  const out =
    acc.componentType === 5126
      ? new Float32Array(acc.count * n)
      : new Uint32Array(acc.count * n);
  for (let e = 0; e < acc.count; e++) {
    for (let c = 0; c < n; c++) {
      const p = base + e * stride + c * cs;
      out[e * n + c] =
        acc.componentType === 5126
          ? bin.readFloatLE(p)
          : acc.componentType === 5125
            ? bin.readUInt32LE(p)
            : acc.componentType === 5123
              ? bin.readUInt16LE(p)
              : bin.readUInt8(p);
    }
  }
  return { data: out, count: acc.count, n };
}

/* ── weld each primitive ──────────────────────────────────────────── */

const chunks = [];
let cursor = 0;
/** Indices of the bufferViews this script appends, so their offsets can be fixed. */
const appendedViews = [];
function pushBuffer(typedArray) {
  const b = Buffer.from(
    typedArray.buffer,
    typedArray.byteOffset,
    typedArray.byteLength,
  );
  const pad = (4 - (b.length % 4)) % 4;
  const view = {
    buffer: 0,
    byteOffset: cursor,
    byteLength: b.length,
  };
  chunks.push(b);
  if (pad) chunks.push(Buffer.alloc(pad));
  cursor += b.length + pad;
  json.bufferViews.push(view);
  appendedViews.push(json.bufferViews.length - 1);
  return json.bufferViews.length - 1;
}

const newAccessors = [];
let totalIn = 0;
let totalOut = 0;
let triIn = 0;
let triOut = 0;

for (const mesh of json.meshes ?? []) {
  for (const prim of mesh.primitives ?? []) {
    if (prim.mode !== undefined && prim.mode !== 4) continue;
    const pos = readAccessor(prim.attributes.POSITION);
    const uv =
      prim.attributes.TEXCOORD_0 !== undefined
        ? readAccessor(prim.attributes.TEXCOORD_0)
        : null;
    const idx = prim.indices !== undefined ? readAccessor(prim.indices) : null;
    const indices = idx
      ? Array.from(idx.data)
      : Array.from({ length: pos.count }, (_, i) => i);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.data[i * 3], y = pos.data[i * 3 + 1], z = pos.data[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    const cell = diag * TOL_FRAC;

    const map = new Map();
    const remap = new Uint32Array(pos.count);
    const outPos = [];
    const outUv = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.data[i * 3], y = pos.data[i * 3 + 1], z = pos.data[i * 3 + 2];
      const key = `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
      let at = map.get(key);
      if (at === undefined) {
        at = outPos.length / 3;
        map.set(key, at);
        // Keep the FIRST position rather than the cell centre: snapping every
        // vertex to a lattice would visibly facet the silhouette.
        outPos.push(x, y, z);
        if (uv) outUv.push(uv.data[i * 2], uv.data[i * 2 + 1]);
      }
      remap[i] = at;
    }

    const outIdx = [];
    for (let t = 0; t < indices.length; t += 3) {
      const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
      // A triangle whose corners collapsed together has no area and would only
      // waste a vertex-shader invocation for ever after.
      if (a === b || b === c || a === c) continue;
      outIdx.push(a, b, c);
    }

    totalIn += pos.count;
    totalOut += outPos.length / 3;
    triIn += indices.length / 3;
    triOut += outIdx.length / 3;

    const posArr = new Float32Array(outPos);
    const posView = pushBuffer(posArr);
    json.accessors.push({
      bufferView: posView,
      componentType: 5126,
      count: posArr.length / 3,
      type: "VEC3",
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    });
    const posAcc = json.accessors.length - 1;

    let uvAcc;
    if (uv) {
      const uvArr = new Float32Array(outUv);
      const uvView = pushBuffer(uvArr);
      json.accessors.push({
        bufferView: uvView,
        componentType: 5126,
        count: uvArr.length / 2,
        type: "VEC2",
      });
      uvAcc = json.accessors.length - 1;
    }

    const idxArr = new Uint32Array(outIdx);
    const idxView = pushBuffer(idxArr);
    json.accessors.push({
      bufferView: idxView,
      componentType: 5125,
      count: idxArr.length,
      type: "SCALAR",
    });
    const idxAccessor = json.accessors.length - 1;

    // NORMAL is deliberately not carried over — see the header.
    prim.attributes = { POSITION: posAcc, ...(uvAcc !== undefined ? { TEXCOORD_0: uvAcc } : {}) };
    prim.indices = idxAccessor;
    newAccessors.push(posAcc);
  }
}

/* ── rewrite ──────────────────────────────────────────────────────── */

const newBin = Buffer.concat([bin, ...chunks]);
/*
 * The appended views recorded offsets relative to the START of the appended
 * region, because that is all pushBuffer could know at the time. Now that they
 * sit after the original BIN, shift exactly those views by its length — the
 * pre-existing views still address the untouched original bytes and must not
 * move.
 */
for (const i of appendedViews) json.bufferViews[i].byteOffset += bin.length;

json.buffers = [{ byteLength: newBin.length }];

const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
const binPad = (4 - (newBin.length % 4)) % 4;
const total =
  12 + 8 + jsonBuf.length + jsonPad + 8 + newBin.length + binPad;
const out = Buffer.alloc(total);
out.writeUInt32LE(0x46546c67, 0);
out.writeUInt32LE(2, 4);
out.writeUInt32LE(total, 8);
let p = 12;
out.writeUInt32LE(jsonBuf.length + jsonPad, p);
out.writeUInt32LE(0x4e4f534a, p + 4);
jsonBuf.copy(out, p + 8);
out.fill(0x20, p + 8 + jsonBuf.length, p + 8 + jsonBuf.length + jsonPad);
p += 8 + jsonBuf.length + jsonPad;
out.writeUInt32LE(newBin.length + binPad, p);
out.writeUInt32LE(0x004e4942, p + 4);
newBin.copy(out, p + 8);
writeFileSync(outPath, out);

console.log(
  `  weld tol=${TOL_FRAC}  verts ${totalIn} -> ${totalOut}` +
    `  tris ${triIn} -> ${triOut}`,
);
