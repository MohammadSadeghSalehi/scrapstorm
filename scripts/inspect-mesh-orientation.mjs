#!/usr/bin/env node
/**
 * Report the native orientation of a .glb so vehicle facing can be calibrated
 * from geometry instead of guesswork.
 *
 *   node scripts/inspect-mesh-orientation.mjs public/assets/meshes/custom/*.glb
 *
 * Parses the GLB directly (no three.js/DOM), bakes node transforms, then:
 *   - reports the bounding box and which axis is longest (= vehicle length)
 *   - splits the long axis in half and compares silhouette height per half
 *
 * A car's cabin/roof sits toward the rear and the hood/nose is lower, so the
 * taller half is the REAR. That is the same signal `orientRearTowardPosZ` uses
 * at runtime — but CUSTOM_ORIENT bypasses the heuristic, so this is how you
 * check the hardcoded table against the actual asset.
 */
import { readFileSync } from "node:fs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!files.length) {
  console.error("usage: inspect-mesh-orientation.mjs <file.glb> [...]");
  process.exit(1);
}

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
    if (len % 4 === 0) off = off - ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

const ident = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return o;
}
function trs(node) {
  if (node.matrix) {
    // glTF matrices are column-major; transpose into our row-major convention.
    const m = node.matrix;
    return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
  }
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy - wz) * sy, (xz + wy) * sz, tx,
    (xy + wz) * sx, (1 - (xx + zz)) * sy, (yz - wx) * sz, ty,
    (xz - wy) * sx, (yz + wx) * sy, (1 - (xx + yy)) * sz, tz,
    0, 0, 0, 1,
  ];
}
const apply = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

function readPositions(json, bin, accIdx) {
  const acc = json.accessors[accIdx];
  if (acc.componentType !== 5126) return null; // FLOAT only
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride ?? 12;
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const o = base + i * stride;
    out.push([bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8)]);
  }
  return out;
}

for (const file of files) {
  const { json, bin } = parseGlb(readFileSync(file));
  const pts = [];
  const scene = json.scenes[json.scene ?? 0];
  const walk = (idx, parent) => {
    const node = json.nodes[idx];
    const world = mul(parent, trs(node));
    if (node.mesh != null) {
      for (const prim of json.meshes[node.mesh].primitives ?? []) {
        const p = readPositions(json, bin, prim.attributes.POSITION);
        if (p) for (const v of p) pts.push(apply(world, v));
      }
    }
    for (const c of node.children ?? []) walk(c, world);
  };
  for (const n of scene.nodes) walk(n, ident());

  if (!pts.length) {
    console.log(`${file}: no float POSITION data (quantized?)`);
    continue;
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const longAxis = size[0] > size[2] ? 0 : 2; // X or Z
  const axisName = longAxis === 0 ? "X" : "Z";
  const mid = (min[longAxis] + max[longAxis]) / 2;

  // Silhouette height each side of centre along the long axis.
  let hiPos = -Infinity, hiNeg = -Infinity;
  let sumPos = 0, nPos = 0, sumNeg = 0, nNeg = 0;
  for (const p of pts) {
    if (p[longAxis] >= mid) {
      hiPos = Math.max(hiPos, p[1]);
      sumPos += p[1];
      nPos++;
    } else {
      hiNeg = Math.max(hiNeg, p[1]);
      sumNeg += p[1];
      nNeg++;
    }
  }
  const meanPos = sumPos / Math.max(1, nPos);
  const meanNeg = sumNeg / Math.max(1, nNeg);
  const rear = hiPos > hiNeg ? `+${axisName}` : `-${axisName}`;
  const nose = hiPos > hiNeg ? `-${axisName}` : `+${axisName}`;

  console.log(`\n=== ${file.split(/[\\/]/).pop()} ===`);
  console.log(`  verts=${pts.length}  size X=${size[0].toFixed(2)} Y=${size[1].toFixed(2)} Z=${size[2].toFixed(2)}`);
  console.log(`  long axis: ${axisName}`);
  console.log(`  peak height  +${axisName}half=${hiPos.toFixed(3)}  -${axisName}half=${hiNeg.toFixed(3)}`);
  console.log(`  mean height  +${axisName}half=${meanPos.toFixed(3)}  -${axisName}half=${meanNeg.toFixed(3)}`);
  console.log(`  => taller half (REAR) is ${rear};  NOSE points ${nose}`);
}
