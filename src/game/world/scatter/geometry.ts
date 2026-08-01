/**
 * Procedural geometry for the scatter fields and roadside furniture.
 *
 * Everything here is authored as ONE geometry per visual element, because the
 * whole point of the exercise is draw calls: a guard-rail post and its beam are
 * a single mesh so a kilometre of Armco is one InstancedMesh, not two.
 *
 * Nothing loads. Poly Haven props are available (see polyHavenAssets) and are
 * used for the hero set dressing, but a 1k-triangle photogrammetry boulder is
 * the wrong trade at a thousand instances — a 20-triangle faceted rock is
 * indistinguishable past ~15m and fifty times cheaper.
 *
 * Vertex colours carry two things the instance transform cannot: a baked
 * ambient-occlusion darkening toward the base (which is what stops an
 * unshadowed object reading as pasted onto the sand), and per-part tinting
 * inside a merged module, so one material can draw a dark post and a bright
 * galvanised beam.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mulberry32 } from "./placement";

/**
 * Uniformly coloured box, ready to merge into a module.
 *
 * Exported for setpieces/, which builds its structures out of the same
 * primitive for the same reason: one merged geometry per structure family means
 * a circuit's worth of walls, stacks and gantries is one draw call. A second
 * copy of this helper over there would be a second place for the vertex-colour
 * convention (and the clearGroups() line, which is load-bearing) to drift.
 */
export function coloredBox(
  w: number,
  h: number,
  d: number,
  pos: [number, number, number],
  rgb: [number, number, number],
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(pos[0], pos[1], pos[2]);
  const n = g.attributes.position!.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = rgb[0];
    c[i * 3 + 1] = rgb[1];
    c[i * 3 + 2] = rgb[2];
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  // Groups only matter for multi-material meshes; merging drops them and the
  // module draws with one material, which is the entire point.
  g.clearGroups();
  return g;
}

export function mergeOrThrow(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error("scatter: geometry merge failed");
  return merged;
}

/**
 * Faceted desert rock, unit height, base at y = 0.
 *
 * 20 triangles. Per-instance non-uniform scale and yaw supply the variety that
 * would otherwise cost extra geometry buckets — and therefore extra draw calls.
 */
export function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.attributes.position as THREE.BufferAttribute;

  /*
   * PolyhedronGeometry is non-indexed, so each of the twelve corners appears
   * three to five times in the buffer. Displacing per *vertex* would move those
   * copies independently and split the solid into twenty floating triangles;
   * keying the displacement on the quantised position keeps shared corners
   * welded.
   */
  const rng = mulberry32(0x51c7a3);
  const warp = new Map<string, number>();
  const key = (x: number, y: number, z: number) =>
    `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;

  for (let i = 0; i < pos.count; i++) {
    const k = key(pos.getX(i), pos.getY(i), pos.getZ(i));
    let f = warp.get(k);
    if (f === undefined) {
      f = 0.62 + rng() * 0.55;
      warp.set(k, f);
    }
    // Squashed on Y: boulders sit, they do not stand.
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f * 0.72, pos.getZ(i) * f);
  }
  pos.needsUpdate = true;

  // Non-indexed + computeVertexNormals gives per-face normals, i.e. flat
  // shading without paying for the derivative instructions `flatShading` adds.
  g.computeVertexNormals();

  g.computeBoundingBox();
  const bb = g.boundingBox!;
  g.translate(0, -bb.min.y, 0);
  const height = Math.max(1e-3, bb.max.y - bb.min.y);
  g.scale(1 / height, 1 / height, 1 / height);

  // Baked contact darkening. These cast no shadow (see ScatterField), so
  // without it a rock is uniformly lit on all sides and floats off the sand.
  const p2 = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p2.count * 3);
  for (let i = 0; i < p2.count; i++) {
    const t = Math.min(1, Math.max(0, p2.getY(i)));
    const v = 0.52 + t * 0.48;
    col[i * 3] = v;
    col[i * 3 + 1] = v * 0.99;
    col[i * 3 + 2] = v * 0.96;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * Dead scrub tuft — a fan of tapered blades, unit height, base at y = 0.
 *
 * Blades rather than the usual crossed alpha-cards: there is no foliage texture
 * in this project, and an untextured crossed quad reads as exactly what it is,
 * two intersecting rectangles. Seven triangles have a real silhouette from
 * every angle and need no alpha test, so the tuft stays in the opaque pass.
 */
export function scrubGeometry(blades = 7): THREE.BufferGeometry {
  const rng = mulberry32(0x9d31f2);
  const pos: number[] = [];
  const col: number[] = [];

  const base: [number, number, number] = [0.30, 0.26, 0.15];
  const tip: [number, number, number] = [1.0, 0.92, 0.62];

  for (let i = 0; i < blades; i++) {
    const az = (i / blades) * Math.PI * 2 + rng() * 0.5;
    const dx = Math.cos(az);
    const dz = Math.sin(az);
    // Perpendicular, so the blade has width across its own facing direction.
    const px = -dz;
    const pz = dx;

    const halfW = 0.045 + rng() * 0.045;
    const root = 0.06 + rng() * 0.1;
    const h = 0.55 + rng() * 0.45;
    const lean = 0.22 + rng() * 0.38;

    const ax = dx * root;
    const az0 = dz * root;
    const tx = dx * lean;
    const tz = dz * lean;

    pos.push(
      ax + px * halfW, 0, az0 + pz * halfW,
      ax - px * halfW, 0, az0 - pz * halfW,
      tx, h, tz,
    );
    col.push(...base, ...base, ...tip);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  // uv is unused by the scrub material but keeps the attribute set uniform if
  // this geometry is ever merged with a boxed module.
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2),
  );
  return g;
}

/**
 * Wind-drifted scrap — a cluster of flat panels half-buried in sand, unit
 * footprint, resting on y = 0.
 *
 * The cluster is baked into the geometry rather than instanced per panel: one
 * drift is one instance, so the field is one draw call instead of four.
 */
export function driftGeometry(panels = 4): THREE.BufferGeometry {
  const rng = mulberry32(0x2f8a41);
  const pos: number[] = [];
  const col: number[] = [];

  for (let i = 0; i < panels; i++) {
    const az = rng() * Math.PI * 2;
    const cx = (rng() - 0.5) * 1.1;
    const cz = (rng() - 0.5) * 1.1;
    const w = 0.28 + rng() * 0.4;
    const l = 0.34 + rng() * 0.5;
    // Panels lie nearly flat with one edge lifted, the way sheet metal settles
    // against a drift. A perfectly flat quad reads as a decal, not an object.
    const lift = 0.06 + rng() * 0.24;
    const c = Math.cos(az);
    const s = Math.sin(az);
    const ex = (x: number, z: number): [number, number] => [
      cx + x * c - z * s,
      cz + x * s + z * c,
    ];
    const [x0, z0] = ex(-w, -l);
    const [x1, z1] = ex(w, -l);
    const [x2, z2] = ex(w, l);
    const [x3, z3] = ex(-w, l);

    const dark: [number, number, number] = [0.42, 0.38, 0.33];
    const lit: [number, number, number] = [0.95, 0.9, 0.8];
    pos.push(x0, 0.01, z0, x1, 0.01, z1, x2, lift, z2);
    pos.push(x0, 0.01, z0, x2, lift, z2, x3, lift, z3);
    col.push(...dark, ...dark, ...lit, ...dark, ...lit, ...lit);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2),
  );
  return g;
}

/**
 * One Armco module: post at the local origin, beam running from it along local
 * +X to the NEXT post. Foot at y = 0.
 *
 * The beam spans [0, beamLen] rather than straddling the origin so a module can
 * be placed on one verge anchor and aimed at the next one. That is what makes
 * the rail a polyline through a corner instead of a ring of disconnected
 * tangent stubs — the difference is obvious on anything tighter than a sweeper.
 *
 * `beamLen` is the circuit's mean anchor spacing, passed in rather than fixed
 * because sample spacing differs per track; per-instance X scale then takes up
 * the local variation.
 */
export function railModuleGeometry(beamLen: number): THREE.BufferGeometry {
  const post: [number, number, number] = [0.30, 0.28, 0.25];
  const steel: [number, number, number] = [1.0, 0.99, 0.95];
  const rib: [number, number, number] = [0.62, 0.61, 0.58];
  const mid = beamLen * 0.5;
  return mergeOrThrow([
    coloredBox(0.14, 1.12, 0.14, [0, 0.56, 0], post),
    coloredBox(beamLen, 0.3, 0.075, [mid, 0.9, 0.09], steel),
    coloredBox(beamLen, 0.09, 0.05, [mid, 0.68, 0.11], rib),
  ]);
}

/**
 * Roadside hoarding, panel facing local +Z, feet at y = 0.
 *
 * The panel takes the full per-instance colour while the frame and the logo bar
 * are dark in vertex colour, so instancing one geometry still yields a row of
 * differently-liveried sponsor boards from a single draw call.
 */
export function boardGeometry(): THREE.BufferGeometry {
  const frame: [number, number, number] = [0.20, 0.19, 0.18];
  const panel: [number, number, number] = [1, 1, 1];
  const bar: [number, number, number] = [0.1, 0.1, 0.11];
  return mergeOrThrow([
    coloredBox(0.16, 2.5, 0.16, [-1.85, 1.25, 0], frame),
    coloredBox(0.16, 2.5, 0.16, [1.85, 1.25, 0], frame),
    coloredBox(4.6, 1.55, 0.12, [0, 2.4, 0.02], panel),
    coloredBox(4.62, 0.34, 0.17, [0, 1.95, 0.02], bar),
    coloredBox(4.8, 0.14, 0.2, [0, 3.26, 0.02], frame),
  ]);
}
