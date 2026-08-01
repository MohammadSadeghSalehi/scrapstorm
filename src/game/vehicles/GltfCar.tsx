/**
 * Vehicle meshes — user custom GLBs for every class (player + AI).
 * Templates cached once; clones share geometry. AI skips expensive clearcoat.
 */
import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { createGltfLoader } from "../world/gltfLoaders";
import type { VehicleState, VehicleClassId } from "../types";
import { ModularVehicleMesh } from "./meshes";
import { FRAME } from "../world/framePriority";
import { qualityManager } from "../world/quality";
import { attachVehicleDeformer } from "../world/damage/meshDeform";
import { isPbrLibraryReady } from "../world/webgl2/textureLibrary";
import { TIRE_RADIUS } from "../tires";

/**
 * Class → the meshes that class can be built from.
 *
 * This was one mesh per class, so a fifteen-rival ladder fielded three
 * silhouettes. The generated cars are appended as VARIANTS rather than
 * replacing anything: same handling, same class identity, different bodywork,
 * which is how a grid reads as a field of individuals instead of three cars
 * copied five times.
 *
 * Index 0 is the class's canonical car — it is what the player gets and what
 * the garage shows, so the class stays recognisable no matter what the AI is
 * driving.
 */
const MODEL_VARIANTS: Record<VehicleClassId, string[]> = {
  interceptor: [
    "/assets/meshes/custom/SM_MeshGen_WastelandCustomCar.glb",
    "/assets/meshes/custom/SM_MeshGen_WastelandBattleCar.glb",
  ],
  trickster: [
    "/assets/meshes/custom/SM_MeshGen_CustomWidebodyHatchback.glb",
    "/assets/meshes/custom/SM_MeshGen_ArmoredBattleCar.glb",
  ],
  bruiser: [
    "/assets/meshes/custom/SM_MeshGen_DesertCombatVehicle.glb",
    "/assets/meshes/custom/SM_MeshGen_ArmoredTankTruck.glb",
  ],
};

/** Canonical mesh per class — player, garage, and anything without an id. */
const MODEL_URL: Record<VehicleClassId, string> = {
  interceptor: MODEL_VARIANTS.interceptor[0]!,
  trickster: MODEL_VARIANTS.trickster[0]!,
  bruiser: MODEL_VARIANTS.bruiser[0]!,
};

/**
 * Stable variant choice from the vehicle id.
 *
 * Deliberately a hash rather than a counter or a random draw: the same rival
 * must arrive in the same car every time you race them, across sessions and
 * regardless of grid order or how many cars are in the field. A counter would
 * reshuffle the whole grid when one entrant changed, and a random draw would
 * mean a rival you have raced ten times shows up in a different car on the
 * eleventh.
 */
function variantFor(classId: VehicleClassId, vehicleId?: string): string {
  const list = MODEL_VARIANTS[classId];
  if (!vehicleId || list.length < 2) return list[0]!;
  let h = 2166136261;
  for (let i = 0; i < vehicleId.length; i++) {
    h ^= vehicleId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return list[(h >>> 0) % list.length]!;
}

/**
 * Decimated variants for AI cars (scripts/build-vehicle-lods.mjs).
 *
 * The three original meshes are 96-105k triangles each; lod1 is ~25k (-75%)
 * and holds the same bounding box, so the geometric facing rules resolve
 * identically.
 *
 * The generated cars have NO usable LOD. They are surface reconstructions made
 * of thousands of disconnected shells, and meshoptimizer preserves component
 * count — measured, they floor at ~30k triangles no matter what ratio or error
 * is requested, so lod1 and lod2 came out within 20 triangles of each other.
 * They ship as a single ~34k level, which is already a third of an original
 * hero mesh, and they are mapped to themselves here so the AI path does not
 * 404 looking for a level that cannot exist.
 */
const AI_URL: Record<string, string> = {
  "/assets/meshes/custom/SM_MeshGen_WastelandCustomCar.glb":
    "/assets/meshes/custom/lod/SM_MeshGen_WastelandCustomCar.lod1.glb",
  "/assets/meshes/custom/SM_MeshGen_CustomWidebodyHatchback.glb":
    "/assets/meshes/custom/lod/SM_MeshGen_CustomWidebodyHatchback.lod1.glb",
  "/assets/meshes/custom/SM_MeshGen_DesertCombatVehicle.glb":
    "/assets/meshes/custom/lod/SM_MeshGen_DesertCombatVehicle.lod1.glb",
};

/** Pilot mesh for garage showcase */
export const PILOT_URL =
  "/assets/meshes/characters/SM_MeshGen_FemaleRacerSuitHelmet.glb";

/** Light fallback only if a custom GLB fails */
const FALLBACK_URL = "/assets/meshes/kenney/race.glb";

/**
 * Full Euler (XYZ) so length=Z, height=Y, width=X, nose toward local -Z.
 * Calibrated against SM_MeshGen customs (native axes differ per asset).
 */
const CUSTOM_ORIENT: Record<string, [number, number, number]> = {
  // Intentionally empty. The geometric path below (align long axis to Z, then
  // flip so the taller half — the cabin — ends up at +Z) derives the right
  // facing for every current asset; verified against the raw vertex data with
  //   node scripts/inspect-mesh-orientation.mjs public/assets/meshes/custom/*.glb
  //
  // The hand-calibrated entries that used to live here carried an extra +PI on
  // WastelandCustomCar (PI/2 -> 3PI/2) and CustomWidebodyHatchback (0 -> PI),
  // so those two rendered exactly backwards. Only add an override when the
  // heuristic demonstrably fails for an asset, and record the measurement.
};

function assetKeyFromUrl(url: string): string {
  const base = url.split("/").pop() || "";
  return base.replace(/\.glb$/i, "");
}

function alignLongAxisToZ(root: THREE.Group) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  if (size.x > size.z * 1.08) {
    root.rotation.y += Math.PI / 2;
    root.updateMatrixWorld(true);
  }
}

/**
 * Put length on Z and the nose on -Z (the sim's forward, see physics.ts where
 * forward = [-sin(yaw), -cos(yaw)]). Both steps are geometric, so a new asset
 * orients itself without hand calibration.
 */
function faceForwardLongAxis(root: THREE.Group) {
  alignLongAxisToZ(root);
  orientRearTowardPosZ(root);
}

function orientRearTowardPosZ(root: THREE.Group) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (!Number.isFinite(box.min.x)) return;
  const midZ = (box.min.z + box.max.z) * 0.5;
  let maxYPos = -Infinity;
  let maxYNeg = -Infinity;
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.attributes.position;
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / 250));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      mesh.localToWorld(v);
      if (v.z >= midZ) maxYPos = Math.max(maxYPos, v.y);
      else maxYNeg = Math.max(maxYNeg, v.y);
    }
  });
  if (
    Number.isFinite(maxYNeg) &&
    Number.isFinite(maxYPos) &&
    maxYNeg > maxYPos + 0.04
  ) {
    root.rotation.y += Math.PI;
    root.updateMatrixWorld(true);
  }
}

/** Apply calibrated full-Euler orient for customs; heuristic for others. */
function applyCustomFacing(root: THREE.Group, url: string) {
  const key = assetKeyFromUrl(url);
  const orient = CUSTOM_ORIENT[key];
  root.rotation.set(0, 0, 0);
  if (orient) {
    root.rotation.set(orient[0], orient[1], orient[2], "XYZ");
  } else {
    alignLongAxisToZ(root);
    orientRearTowardPosZ(root);
  }
  root.updateMatrixWorld(true);
  root.userData.yaw = root.rotation.y;
  root.userData.orient = orient ?? null;
}

const TARGET_LEN: Record<VehicleClassId, number> = {
  interceptor: 4.35,
  trickster: 4.05,
  bruiser: 5.1,
};

type PaintKind = "body" | "glass" | "dark" | "chrome" | "rubber" | "light";
const KINDS: PaintKind[] = [
  "body",
  "glass",
  "dark",
  "chrome",
  "rubber",
  "light",
];

type WheelSlot = {
  pivot: THREE.Group;
  spin: THREE.Group;
  isFront: boolean;
  side: number;
  tireIndex: number;
};

type MergedPack = {
  geos: Partial<Record<PaintKind, THREE.BufferGeometry>>;
  nativeLen: number;
  meshCount: number;
  drawCalls: number;
  size: [number, number, number];
};

const templateCache = new Map<string, THREE.Group>();
const templatePromise = new Map<string, Promise<THREE.Group>>();
const mergedCache = new Map<string, MergedPack | null>();

function makeLoader() {
  // Shared factory so vehicles pick up Draco/KTX2 as well as meshopt.
  return createGltfLoader();
}

function centerAndMeasure(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
  root.userData.nativeLen = Math.max(size.x, size.z, 0.01);
  root.userData.nativeHeight = size.y;
  root.userData.nativeSize = [size.x, size.y, size.z] as [
    number,
    number,
    number,
  ];
  return root.userData.nativeLen as number;
}

function loadTemplate(url: string): Promise<THREE.Group> {
  const hit = templateCache.get(url);
  if (hit) return Promise.resolve(hit);
  const pending = templatePromise.get(url);
  if (pending) return pending;
  const p = new Promise<THREE.Group>((resolve, reject) => {
    makeLoader().load(
      url,
      (gltf) => {
        const root = gltf.scene;
        root.traverse((o) => {
          o.frustumCulled = true;
        });
        centerAndMeasure(root);
        templateCache.set(url, root);
        resolve(root);
      },
      undefined,
      reject,
    );
  });
  templatePromise.set(url, p);
  return p;
}

function isKenneyStyle(root: THREE.Object3D): boolean {
  let wheels = 0;
  root.traverse((o) => {
    if (/^wheel-(front|back)-(left|right)$/i.test(o.name)) wheels++;
  });
  return wheels >= 4;
}

function classifyPart(name: string, matName: string): PaintKind {
  const s = `${name} ${matName}`.toLowerCase();
  if (/wheel|tire|tyre|rubber/.test(s)) return "rubber";
  if (/glass|window|windshield|canopy|trans|lens/.test(s)) return "glass";
  if (/light|lamp|emiss|brake|head|tail|glow|led/.test(s)) return "light";
  if (/chrome|grille|bumper|rim|spoke|metal_chrome/.test(s)) return "chrome";
  if (/interior|cabin|seat|floor|dash|spoiler|underside/.test(s)) return "dark";
  if (/paint|body|car|truck|toycar|exterior/.test(s)) return "body";
  return "body";
}

function bakeMeshGeometry(
  src: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
): THREE.BufferGeometry {
  const posAttr = src.attributes.position;
  if (!posAttr || posAttr.count === 0) {
    return new THREE.BoxGeometry(0.05, 0.05, 0.05);
  }
  const v = new THREE.Vector3();
  const index = src.index;
  if (index) {
    const triCount = index.count;
    const posArr = new Float32Array(triCount * 3);
    for (let i = 0; i < triCount; i++) {
      const vi = index.getX(i);
      v.set(posAttr.getX(vi), posAttr.getY(vi), posAttr.getZ(vi)).applyMatrix4(
        matrix,
      );
      posArr[i * 3] = v.x;
      posArr[i * 3 + 1] = v.y;
      posArr[i * 3 + 2] = v.z;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    out.computeVertexNormals();
    out.computeBoundingBox();
    out.computeBoundingSphere();
    return out;
  }
  const count = posAttr.count;
  const posArr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(
      matrix,
    );
    posArr[i * 3] = v.x;
    posArr[i * 3 + 1] = v.y;
    posArr[i * 3 + 2] = v.z;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function mergeManual(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (list.length === 1) return list[0];
  let count = 0;
  for (const g of list) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of list) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos[o * 3] = p.getX(i);
      pos[o * 3 + 1] = p.getY(i);
      pos[o * 3 + 2] = p.getZ(i);
      if (n) {
        nor[o * 3] = n.getX(i);
        nor[o * 3 + 1] = n.getY(i);
        nor[o * 3 + 2] = n.getZ(i);
      }
      o++;
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  for (const g of list) g.dispose();
  return out;
}

function bakeAndMerge(tpl: THREE.Group): MergedPack {
  tpl.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(tpl.matrixWorld).invert();
  const buckets: Record<PaintKind, THREE.BufferGeometry[]> = {
    body: [],
    glass: [],
    dark: [],
    chrome: [],
    rubber: [],
    light: [],
  };
  let rawCount = 0;
  tpl.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    rawCount++;
    const srcMat = Array.isArray(mesh.material)
      ? mesh.material[0]
      : mesh.material;
    const kind = classifyPart(
      mesh.name,
      (srcMat as THREE.Material)?.name ?? "",
    );
    mesh.updateMatrixWorld(true);
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    buckets[kind].push(bakeMeshGeometry(mesh.geometry, m));
  });
  const geos: Partial<Record<PaintKind, THREE.BufferGeometry>> = {};
  let drawCalls = 0;
  for (const kind of KINDS) {
    if (buckets[kind].length === 0) continue;
    geos[kind] = mergeManual(buckets[kind]);
    drawCalls++;
  }
  const box = new THREE.Box3().setFromObject(tpl);
  const size = box.getSize(new THREE.Vector3());
  return {
    geos,
    nativeLen: Math.max(size.x, size.z, 0.01),
    meshCount: rawCount,
    drawCalls,
    size: [size.x, size.y, size.z],
  };
}

function getMergedPack(url: string, tpl: THREE.Group): MergedPack | null {
  if (mergedCache.has(url)) return mergedCache.get(url) ?? null;
  try {
    const pack = bakeAndMerge(tpl);
    mergedCache.set(url, pack);
    return pack;
  } catch {
    mergedCache.set(url, null);
    return null;
  }
}

function makeMats(
  color: string,
  accent: string,
  ghost: boolean,
  _hero: boolean,
) {
  const body = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.42,
    metalness: 0.28,
    envMapIntensity: 0.75,
    emissive: new THREE.Color(accent).multiplyScalar(0.08),
    transparent: ghost,
    opacity: ghost ? 0.4 : 1,
  });
  return {
    body,
    glass: new THREE.MeshStandardMaterial({
      color: "#0ea5e9",
      roughness: 0.12,
      metalness: 0.35,
      transparent: true,
      opacity: ghost ? 0.15 : 0.45,
    }),
    rubber: new THREE.MeshStandardMaterial({
      color: "#1c1917",
      roughness: 0.92,
      metalness: 0.05,
    }),
    light: new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 0.85,
      roughness: 0.35,
      metalness: 0.2,
    }),
    chrome: new THREE.MeshStandardMaterial({
      color: "#d6d3d1",
      roughness: 0.22,
      metalness: 0.85,
    }),
    dark: new THREE.MeshStandardMaterial({
      color: "#292524",
      roughness: 0.75,
      metalness: 0.15,
    }),
  };
}

/**
 * Holo Decoy — the trickster's defensive ability (classes.ts calls it "Holo
 * Decoy"; combat.ts sets decoyActive = 3.2s, and AI tricksters fire it too).
 *
 * It used to render as a second copy of the rival built from the procedural box
 * car at 35% opacity, in the rival's own paint, offset 4m to the side, with its
 * pose refreshed only when React re-rendered. Nothing about that says "ability":
 * a washed-out car in the rival's colours, overlapping the rival's silhouette,
 * is exactly what "a rival gets half invisible" describes. The decoy keeps the
 * silhouette of the car it impersonates — that is the whole point of a decoy —
 * but is shaded as something that is plainly not bodywork.
 */
const DECOY_COLOR = "#7dd3fc";
const DECOY_BASE_OPACITY = 0.55;
/** Metres the decoy peels out to. Lateral, not ahead — see the pose code. */
const DECOY_OFFSET = 4;
/** Seconds to materialise and peel clear of the car. */
const DECOY_DEPLOY = 0.32;
/** Seconds of collapse at the tail of decoyActive. */
const DECOY_COLLAPSE = 0.45;

/**
 * One material shared by every decoy on screen.
 *
 * Per-instance materials would compile a new shader program the first time each
 * decoy appears — a hitch in the middle of a fight, which is precisely when
 * decoys fire. One module-level unlit material is one program for the session,
 * and four simultaneous decoys add nothing to it.
 *
 * depthWrite MUST stay false. The old decoy inherited the modular car's ~40
 * depth-writing transparent boxes, so it punched holes in itself and in every
 * effect quad that happened to be drawn behind it.
 *
 * fog is off because the blend is additive: fogging an additive surface adds the
 * fog colour instead of fading toward it, so a distant decoy would get brighter
 * rather than softer.
 */
let decoyMaterial: THREE.MeshBasicMaterial | null = null;
function getDecoyMaterial(): THREE.MeshBasicMaterial {
  if (!decoyMaterial) {
    decoyMaterial = new THREE.MeshBasicMaterial({
      color: DECOY_COLOR,
      transparent: true,
      opacity: DECOY_BASE_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
      side: THREE.FrontSide,
    });
  }
  return decoyMaterial;
}

/**
 * Shimmer, written straight onto the shared material.
 *
 * Idempotent and driven off a shared clock, so it does not matter that every
 * live decoy runs it — the cost is two sines per decoy per frame, and only
 * while a decoy exists. A steady fade reads as a transparency bug; a signal
 * that stutters reads as a projection, which is the entire point here.
 */
function updateDecoyShimmer(t: number) {
  const mat = getDecoyMaterial();
  const pulse = 0.82 + 0.18 * Math.sin(t * 9.3);
  const dropout = Math.sin(t * 2.7) > 0.93 ? 0.35 : 1;
  mat.opacity = DECOY_BASE_OPACITY * pulse * dropout;
}

const decoyShellCache = new Map<string, THREE.Group>();

/**
 * Decoys mount mid-race, so building one has to be cheap.
 *
 * buildTexturedHero runs five full Box3.setFromObject passes over a 26k-triangle
 * mesh to derive facing and grounding. That is fine once per car at grid time
 * and a visible hitch if it runs every time somebody fires a decoy. Build one
 * oriented prototype per class and clone that: clone(true) copies three nodes
 * and shares both the geometry and the single material.
 *
 * The prototype's userData is flattened to plain values first. Object3D.copy
 * round-trips userData through JSON.stringify (three.core.js), and the build
 * leaves live Material and Object3D references in there — both implement
 * toJSON(), so cloning would quietly serialise the whole shell on every spawn.
 * Dropping bodyGroup here is also what keeps the damage/dent pass off a
 * hologram: the pose code skips it when the key is absent.
 */
function getDecoyShell(
  url: string,
  tpl: THREE.Group,
  classId: VehicleClassId,
): THREE.Group {
  let proto = decoyShellCache.get(url);
  if (!proto) {
    proto = buildTexturedHero(
      tpl,
      classId,
      DECOY_COLOR,
      DECOY_COLOR,
      false,
      false,
      url,
      false,
      true,
    );
    proto.userData = {
      decoy: true,
      meshCount: proto.userData.meshCount,
      drawCalls: proto.userData.drawCalls,
    };
    decoyShellCache.set(url, proto);
  }
  return proto.clone(true);
}

const WHEEL_SPECS = [
  { name: /^wheel-front-left$/i, isFront: true, side: -1, idx: 0 },
  { name: /^wheel-front-right$/i, isFront: true, side: 1, idx: 1 },
  { name: /^wheel-back-left$/i, isFront: false, side: -1, idx: 2 },
  { name: /^wheel-back-right$/i, isFront: false, side: 1, idx: 3 },
];

function buildKenneyVehicle(
  tpl: THREE.Group,
  classId: VehicleClassId,
  color: string,
  accent: string,
  ghost: boolean,
  castShadow: boolean,
): THREE.Group {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  bodyGroup.name = "body-suspension";
  root.add(bodyGroup);
  const wheels: WheelSlot[] = [];
  const clone = tpl.clone(true);
  const bodyMat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.4,
    metalness: 0.25,
    emissive: new THREE.Color(accent).multiplyScalar(0.1),
    transparent: ghost,
    opacity: ghost ? 0.4 : 1,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: "#292524",
    roughness: 0.8,
    metalness: 0.1,
  });
  const rubberMat = new THREE.MeshStandardMaterial({
    color: "#1c1917",
    roughness: 0.95,
    metalness: 0.02,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: "#38bdf8",
    roughness: 0.15,
    metalness: 0.3,
    transparent: true,
    opacity: 0.4,
  });
  const lightMat = new THREE.MeshStandardMaterial({
    color: accent,
    emissive: accent,
    emissiveIntensity: 0.9,
  });

  clone.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    const n = mesh.name || "";
    if (/^wheel-/i.test(n)) mesh.material = rubberMat;
    else if (/glass|window/i.test(n)) mesh.material = glassMat;
    else if (/body|paint|car/i.test(n) || n === "") mesh.material = bodyMat;
    else if (/light|lamp/i.test(n)) mesh.material = lightMat;
    else mesh.material = darkMat;
  });

  for (const spec of WHEEL_SPECS) {
    let wheelObj: THREE.Object3D | null = null;
    clone.traverse((o) => {
      if (spec.name.test(o.name)) wheelObj = o;
    });
    if (!wheelObj) continue;
    const w = wheelObj as THREE.Object3D;
    const worldPos = new THREE.Vector3();
    w.getWorldPosition(worldPos);
    w.parent?.remove(w);
    w.position.set(0, 0, 0);
    w.rotation.set(0, 0, 0);
    w.scale.set(1, 1, 1);
    const pivot = new THREE.Group();
    const spin = new THREE.Group();
    pivot.add(spin);
    spin.add(w);
    pivot.position.copy(worldPos);
    pivot.userData.restY = pivot.position.y;
    root.add(pivot);
    wheels.push({
      pivot,
      spin,
      isFront: spec.isFront,
      side: spec.side,
      tireIndex: spec.idx,
    });
  }

  bodyGroup.add(clone);
  const len = (tpl.userData.nativeLen as number) || 4;
  root.scale.setScalar(TARGET_LEN[classId] / len);
  // No blanket +PI — faceForwardLongAxis decides the flip from geometry.
  root.rotation.set(0, 0, 0);
  faceForwardLongAxis(root);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (Number.isFinite(box.min.y)) root.position.y -= box.min.y;
  for (const w of wheels) w.pivot.userData.restY = w.pivot.position.y;

  root.userData.meshCount = 8;
  root.userData.drawCalls = 8;
  root.userData.merged = false;
  root.userData.kenney = true;
  root.userData.bodyMat = bodyMat;
  root.userData.bodyGroup = bodyGroup;
  root.userData.wheelSpinners = [];
  root.userData.wheels = wheels;
  return root;
}

function buildFromMerged(
  pack: MergedPack,
  classId: VehicleClassId,
  color: string,
  accent: string,
  ghost: boolean,
  castShadow: boolean,
  hero: boolean,
): THREE.Group {
  const mats = makeMats(color, accent, ghost, hero);
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  bodyGroup.name = "body-suspension";
  root.add(bodyGroup);
  const wheelSpinners: THREE.Object3D[] = [];

  for (const kind of KINDS) {
    const geo = pack.geos[kind];
    if (!geo) continue;
    const mat =
      kind === "glass"
        ? mats.glass
        : kind === "rubber"
          ? mats.rubber
          : kind === "light"
            ? mats.light
            : kind === "chrome"
              ? mats.chrome
              : kind === "dark"
                ? mats.dark
                : mats.body;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = castShadow && kind === "body";
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.name = `merged-${kind}`;
    bodyGroup.add(mesh);
  }

  const s = TARGET_LEN[classId] / pack.nativeLen;
  root.scale.setScalar(s);
  root.rotation.set(0, 0, 0);
  faceForwardLongAxis(root);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (Number.isFinite(box.min.y)) root.position.y -= box.min.y;

  root.userData.meshCount = pack.meshCount;
  root.userData.drawCalls = pack.drawCalls;
  root.userData.merged = true;
  root.userData.bodyMat = mats.body;
  root.userData.bodyGroup = bodyGroup;
  root.userData.wheelSpinners = wheelSpinners;
  root.userData.wheels = [] as WheelSlot[];
  return root;
}

function paintUnmerged(
  tpl: THREE.Group,
  classId: VehicleClassId,
  color: string,
  accent: string,
  ghost: boolean,
  castShadow: boolean,
  hero: boolean,
): THREE.Group {
  const clone = tpl.clone(true);
  const len = (tpl.userData.nativeLen as number) || 4;
  clone.scale.setScalar(TARGET_LEN[classId] / len);
  clone.rotation.set(0, 0, 0);
  faceForwardLongAxis(clone);
  const mats = makeMats(color, accent, ghost, hero);
  let kept = 0;
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const srcMat = Array.isArray(mesh.material)
      ? mesh.material[0]
      : mesh.material;
    const kind = classifyPart(
      mesh.name,
      (srcMat as THREE.Material)?.name ?? "",
    );
    kept++;
    mesh.castShadow = castShadow && kind === "body";
    mesh.receiveShadow = true;
    const mat =
      kind === "glass"
        ? mats.glass
        : kind === "rubber"
          ? mats.rubber
          : kind === "light"
            ? mats.light
            : kind === "chrome"
              ? mats.chrome
              : kind === "dark"
                ? mats.dark
                : mats.body;
    mesh.material = mat;
  });
  clone.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(clone);
  if (Number.isFinite(box.min.y)) clone.position.y -= box.min.y;
  clone.userData.meshCount = kept;
  clone.userData.drawCalls = kept;
  clone.userData.merged = false;
  clone.userData.bodyMat = mats.body;
  clone.userData.bodyGroup = clone;
  clone.userData.wheelSpinners = [];
  clone.userData.wheels = [];
  return clone;
}

function hasEmbeddedTextures(tpl: THREE.Object3D): boolean {
  let ok = false;
  tpl.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m && "map" in m && (m as THREE.MeshStandardMaterial).map) ok = true;
    }
  });
  return ok;
}

/**
 * Hero paint constants, shared by the build path and the damage pass.
 *
 * They live together because the damage pass used to hard-code its own values
 * and silently overwrote whatever the material was constructed with — it runs
 * once on mount at damage 0, so raising clearcoat at construction alone had no
 * visible effect at all.
 */
const PAINT_ROUGHNESS = 0.42;
const PAINT_CLEARCOAT = 0.6;
const PAINT_CLEARCOAT_ROUGHNESS = 0.1;

/**
 * MeshGen GLBs ship metallicFactor=1 + a non-standard MR map that turns
 * bodies into black chrome. Keep albedo, force readable metal/rough,
 * skip metalnessMap. Base colour stays at ~1.0 — the earlier 1.25 lift was
 * compensating for a missing specular response, not for dark albedos.
 */
function buildTexturedHero(
  tpl: THREE.Group,
  classId: VehicleClassId,
  color: string,
  accent: string,
  ghost: boolean,
  castShadow: boolean,
  url = "",
  hero = true,
  decoy = false,
): THREE.Group {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  bodyGroup.name = "body-suspension";
  root.add(bodyGroup);

  const clone = tpl.clone(true);
  let bodyMat: THREE.Material | null = null;
  let meshCount = 0;
  const tier = qualityManager.get().tier;
  const usePhysical = hero && tier === "high" && !ghost;

  clone.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    meshCount++;
    if (decoy) {
      // A projection has no albedo, no normal map and casts nothing. Skipping
      // all of it is what makes a decoy one cheap unlit draw rather than a
      // second fully shaded car.
      mesh.material = getDecoyMaterial();
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      if (!bodyMat) bodyMat = mesh.material;
      return;
    }
    const src = (
      Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    ) as THREE.MeshStandardMaterial | undefined;

    const map = src?.map ?? null;
    const normalMap =
      !hero || tier === "low" ? null : (src?.normalMap ?? null);
    const emissiveMap = src?.emissiveMap ?? null;

    const metalness = 0.18;
    // Hero paint is glossier than the AI satin. This is a uniform value on a
    // material that already compiles, so the hero benefits on every tier while
    // the three background cars are untouched.
    const roughness = hero ? PAINT_ROUGHNESS : 0.55;
    // Back to ~1.0. At 1.25 the albedo was already past white before ACES got
    // to it, so the paint clipped to a single flat value and there was nothing
    // for a specular highlight to sit *on top of* — the main reason the cars
    // read as matte plastic rather than lacquer.
    const baseColor = ghost
      ? new THREE.Color(color).multiplyScalar(0.55)
      : new THREE.Color(1.0, 0.99, 0.97);

    let mat: THREE.Material;
    if (usePhysical) {
      mat = new THREE.MeshPhysicalMaterial({
        map,
        normalMap,
        emissiveMap,
        color: baseColor,
        metalness,
        roughness,
        // Automotive paint is a pigmented base under a thin, near-mirror
        // lacquer. At 0.18/0.42 the coat was both too weak and too rough to
        // separate from the base lobe, so it cost a shader branch and bought
        // nothing. USE_CLEARCOAT is already defined at any non-zero value, so
        // raising it is a uniform change with no extra per-frame cost.
        clearcoat: PAINT_CLEARCOAT,
        clearcoatRoughness: PAINT_CLEARCOAT_ROUGHNESS,
        envMapIntensity: 1.25,
        emissive: new THREE.Color(accent),
        emissiveIntensity: 0.04,
        transparent: ghost,
        opacity: ghost ? 0.4 : 1,
        side: THREE.FrontSide,
      });
    } else {
      mat = new THREE.MeshStandardMaterial({
        map,
        normalMap,
        emissiveMap,
        color: baseColor,
        metalness,
        roughness,
        envMapIntensity: hero ? 1.15 : 1.05,
        emissive: new THREE.Color(accent),
        emissiveIntensity: ghost ? 0.02 : 0.04,
        transparent: ghost,
        opacity: ghost ? 0.4 : 1,
        side: THREE.FrontSide,
      });
    }
    if (map) {
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = hero && tier === "high" ? 8 : 4;
      map.needsUpdate = true;
    }
    if (normalMap) {
      normalMap.anisotropy = 4;
      normalMap.needsUpdate = true;
    }
    mesh.material = mat;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    if (!bodyMat) bodyMat = mat;
  });

  bodyGroup.add(clone);

  applyCustomFacing(root, url);
  root.updateMatrixWorld(true);
  const orientedBox = new THREE.Box3().setFromObject(root);
  const orientedSize = orientedBox.getSize(new THREE.Vector3());
  const nativeLen = Math.max(orientedSize.z, orientedSize.x, 0.5);
  const s = TARGET_LEN[classId] / nativeLen;
  root.scale.setScalar(s);
  root.updateMatrixWorld(true);
  root.userData.yaw = root.rotation.y;

  const box = new THREE.Box3().setFromObject(root);
  if (Number.isFinite(box.min.y)) root.position.y -= box.min.y;

  root.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(root);
  if (Number.isFinite(box2.min.y) && Math.abs(box2.min.y) > 0.001) {
    root.position.y -= box2.min.y;
  }

  const finalSize = box2.getSize(new THREE.Vector3());
  root.userData.meshCount = meshCount;
  root.userData.drawCalls = meshCount;
  root.userData.merged = false;
  root.userData.kenney = false;
  root.userData.textured = true;
  root.userData.customUrl = url;
  // Undamaged targets the damage pass ramps away from, so it can never quietly
  // undo the paint the car was actually built with.
  root.userData.paintRoughness = hero ? PAINT_ROUGHNESS : 0.55;
  root.userData.paintClearcoat = usePhysical ? PAINT_CLEARCOAT : 0;
  root.userData.bodyMat = bodyMat;
  root.userData.bodyGroup = bodyGroup;
  root.userData.wheelSpinners = [];
  root.userData.wheels = [] as WheelSlot[];
  root.userData.sizeAfter = finalSize.toArray();
  root.userData.nativeSize = [
    orientedSize.x,
    orientedSize.y,
    orientedSize.z,
  ];
  return root;
}

function cloneForVehicle(
  url: string,
  tpl: THREE.Group,
  classId: VehicleClassId,
  color: string,
  accent: string,
  ghost: boolean,
  castShadow: boolean,
  hero: boolean,
  decoy = false,
): THREE.Group {
  // Ahead of every other path: a decoy is always the holo shell regardless of
  // which asset backed it, including the Kenney fallback.
  if (decoy) return getDecoyShell(url, tpl, classId);
  if (isKenneyStyle(tpl)) {
    return buildKenneyVehicle(tpl, classId, color, accent, ghost, castShadow);
  }
  if (hasEmbeddedTextures(tpl)) {
    return buildTexturedHero(
      tpl,
      classId,
      color,
      accent,
      ghost,
      castShadow,
      url,
      hero,
    );
  }
  const pack = getMergedPack(url, tpl);
  if (pack && pack.drawCalls > 0) {
    return buildFromMerged(
      pack,
      classId,
      color,
      accent,
      ghost,
      castShadow,
      hero,
    );
  }
  return paintUnmerged(tpl, classId, color, accent, ghost, castShadow, hero);
}

/** Preload all class customs (cached once, clones are cheap). */
export function preloadCarModels(_heroClass?: VehicleClassId): Promise<void> {
  const urls = new Set<string>(Object.values(MODEL_URL));
  return Promise.all(
    [...urls].map(async (url) => {
      try {
        await loadTemplate(url);
      } catch {
        /* optional */
      }
    }),
  ).then(() => undefined);
}

export function preloadHeroModel(classId: VehicleClassId): Promise<void> {
  return loadTemplate(MODEL_URL[classId])
    .then(() => undefined)
    .catch(() => undefined);
}

function applyDamageLook(root: THREE.Object3D, colorHex: string, dmg: number) {
  const body = root.userData.bodyMat as
    | THREE.MeshPhysicalMaterial
    | THREE.MeshStandardMaterial
    | undefined;
  if (!body) return;
  if (root.userData.textured && "map" in body && body.map) {
    const dirt = Math.min(0.55, dmg * 0.55);
    body.color.setRGB(
      1.0 - dirt * 0.3,
      0.99 - dirt * 0.3,
      0.97 - dirt * 0.3,
    );
    // Ramp away from what the car was built with rather than from a second,
    // hard-coded set of values — otherwise this call flattens the hero's paint
    // back to AI satin the moment it first runs at damage 0.
    const baseRough = (root.userData.paintRoughness as number) ?? 0.45;
    const baseCoat = (root.userData.paintClearcoat as number) ?? 0;
    body.roughness = Math.min(0.92, baseRough + dmg * 0.45);
    if ("clearcoat" in body && baseCoat > 0) {
      const phys = body as THREE.MeshPhysicalMaterial;
      // Damage scuffs and dulls the lacquer; it does not strip it off.
      phys.clearcoat = Math.max(0.12, baseCoat - dmg * 0.45);
      phys.clearcoatRoughness = Math.min(
        0.55,
        PAINT_CLEARCOAT_ROUGHNESS + dmg * 0.45,
      );
    }
    body.emissiveIntensity = 0.04 + dmg * 0.08;
    return;
  }
  const c = new THREE.Color(colorHex);
  if (dmg > 0.15)
    c.lerp(new THREE.Color("#57534e"), Math.min(0.55, dmg * 0.55));
  body.color.copy(c);
  if ("emissive" in body) body.emissive.copy(c);
  body.emissiveIntensity = 0.16 + dmg * 0.2;
  body.roughness = 0.28 + dmg * 0.45;
  if ("clearcoat" in body) {
    (body as THREE.MeshPhysicalMaterial).clearcoat = Math.max(
      0,
      0.55 - dmg * 0.5,
    );
  }
  body.metalness = 0.22 + dmg * 0.12;
}

export function GltfVehicleMesh({
  vehicle,
  vehicleId,
  sim,
  ghost = false,
  forceHero = false,
  decoy = false,
}: {
  vehicle: VehicleState;
  vehicleId?: string;
  sim?: { state: { vehicles: VehicleState[] } };
  ghost?: boolean;
  forceHero?: boolean;
  /** Holo Decoy projection of `vehicleId`, not a car in its own right. */
  decoy?: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const [shell, setShell] = useState<THREE.Object3D | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useRef(vehicle);
  const spinAccum = useRef([0, 0, 0, 0]);
  const decoyAge = useRef(0);
  const { camera } = useThree();
  const id = vehicleId ?? vehicle.id;
  const color = vehicle.color || "#5eead4";
  const accent =
    vehicle.classId === "bruiser"
      ? "#fdba74"
      : vehicle.classId === "trickster"
        ? "#7dd3fc"
        : "#99f6e4";

  const wantsGltf = !ghost;
  // A decoy is never hero, even when the player is the one projecting it: it
  // takes the decimated AI mesh and skips clearcoat, shadows and normal maps.
  const hero = !decoy && (vehicle.isPlayer || forceHero);

  useEffect(() => {
    if (!wantsGltf) return;
    let alive = true;

    const mount = (tpl: THREE.Group, url: string) => {
      if (!alive) return;
      const cast = hero && qualityManager.get().tier !== "low";
      const clone = cloneForVehicle(
        url,
        tpl,
        vehicle.classId,
        color,
        accent,
        ghost,
        cast,
        hero,
        decoy,
      );
      const meshes = (clone.userData.meshCount as number) || 0;
      if (meshes < 1) {
        setFailed(true);
        return;
      }
      /*
       * Attach to `clone`, the ROOT — not userData.bodyGroup. The root's matrix
       * carries the normalisation scale and the faceForwardLongAxis flip, and
       * hits arrive in car metres; attaching below that chain would silently
       * apply every dent at the wrong scale and mirrored on flipped meshes.
       */
      attachVehicleDeformer(id, clone);
      setShell(clone);
      setFailed(false);
      if (vehicle.isPlayer && !decoy && typeof window !== "undefined") {
        clone.updateMatrixWorld(true);
        const bb = new THREE.Box3().setFromObject(clone);
        const sz = bb.getSize(new THREE.Vector3());
        (
          window as unknown as { __carDebug?: Record<string, unknown> }
        ).__carDebug = {
          key: vehicle.classId,
          url,
          gltf: true,
          kenney: !!clone.userData.kenney,
          textured: !!clone.userData.textured,
          customUrl: clone.userData.customUrl,
          yaw: clone.userData.yaw,
          orient: clone.userData.orient,
          pbr: isPbrLibraryReady(),
          meshes,
          drawCalls: clone.userData.drawCalls,
          merged: clone.userData.merged,
          wheels:
            (clone.userData.wheels as WheelSlot[] | undefined)?.length ?? 0,
          size: [sz.x, sz.y, sz.z],
          minY: bb.min.y,
          maxY: bb.max.y,
          scale: clone.scale.x,
        };
      }
    };

    const tryLoad = async () => {
      /*
       * The player and the garage always get the class's canonical car so the
       * class stays recognisable; AI entrants get a variant chosen from their
       * id. Passing `id` rather than `vehicle.id` matters for the decoy, which
       * carries the id of the car it impersonates — a decoy in different
       * bodywork would give the trick away instantly.
       */
      const full = hero
        ? MODEL_URL[vehicle.classId]
        : variantFor(vehicle.classId, id);
      // Keyed by URL now, and a generated car has no usable LOD, so this falls
      // through to the full mesh rather than 404ing on a level that cannot exist.
      const primary = hero ? full : (AI_URL[full] ?? full);
      try {
        const tpl = await loadTemplate(primary);
        mount(tpl, primary);
      } catch {
        try {
          // LOD missing (build step not run) — fall back to the full mesh
          // before dropping all the way to the generic Kenney car.
          const tpl = await loadTemplate(primary === full ? FALLBACK_URL : full);
          mount(tpl, primary === full ? FALLBACK_URL : full);
        } catch {
          if (alive) setFailed(true);
        }
      }
    };

    void tryLoad();
    return () => {
      alive = false;
    };
  }, [
    vehicle.classId,
    vehicle.isPlayer,
    forceHero,
    ghost,
    color,
    wantsGltf,
    accent,
    hero,
    decoy,
  ]);

  useEffect(() => {
    // A hologram does not take paint damage, and the shared decoy material must
    // never be written per instance — every decoy on screen shares it.
    if (!shell || decoy) return;
    applyDamageLook(shell, color, vehicle.damageVisual);
  }, [shell, color, vehicle.damageVisual, decoy]);

  useFrame((_, dt) => {
    if (sim) {
      const v = sim.state.vehicles.find((x) => x.id === id);
      if (v) live.current = v;
    } else live.current = vehicle;
    const v = live.current;
    const g = group.current;
    if (!g) return;

    const tires = v.tires ?? [];
    let avgC = 0.15;
    let frontC = 0.15;
    let rearC = 0.15;
    let leftC = 0.15;
    let rightC = 0.15;
    if (tires.length >= 4) {
      avgC =
        (tires[0].compress +
          tires[1].compress +
          tires[2].compress +
          tires[3].compress) /
        4;
      frontC = (tires[0].compress + tires[1].compress) * 0.5;
      rearC = (tires[2].compress + tires[3].compress) * 0.5;
      leftC = (tires[0].compress + tires[2].compress) * 0.5;
      rightC = (tires[1].compress + tires[3].compress) * 0.5;
    }
    const rideSink = Math.min(0.12, avgC * 0.35);
    g.position.set(v.x, v.y - rideSink, v.z);
    g.rotation.order = "YXZ";
    g.rotation.y = v.yaw;

    if (decoy) {
      decoyAge.current += dt;
      /*
       * Peel out sideways instead of popping in already 4m clear. Watching the
       * projection split off the car is what makes it read as an ability; a
       * translucent car that simply appears alongside reads as a duplicate.
       *
       * Lateral, NOT ahead, despite how it looks: the sim's forward is
       * (-sin yaw, -cos yaw) (physics.ts), and (cos yaw, -sin yaw) is
       * perpendicular to that.
       */
      const deploy = Math.min(1, decoyAge.current / DECOY_DEPLOY);
      const peel = 1 - (1 - deploy) ** 3;
      g.position.x += Math.cos(v.yaw) * DECOY_OFFSET * peel;
      g.position.z -= Math.sin(v.yaw) * DECOY_OFFSET * peel;
      // Projected up out of nothing and collapsed back into it. This envelope
      // is per-object on purpose — the shimmer lives on a shared material and
      // cannot carry a per-decoy lifetime.
      const collapse = Math.min(1, v.decoyActive / DECOY_COLLAPSE);
      g.scale.set(1, Math.max(0.02, peel * collapse), 1);
      updateDecoyShimmer(performance.now() * 0.001);
    }

    const bank = THREE.MathUtils.clamp(
      -v.lateral * 0.04 - v.speed * 0.001 + v.bodyRoll,
      -0.4,
      0.4,
    );
    const list =
      v.wreckTimer > 0
        ? Math.sin(v.wreckTimer * 14) * 0.35
        : v.damageVisual * 0.08 * Math.sin(v.x * 0.3);
    g.rotation.z = THREE.MathUtils.lerp(
      g.rotation.z,
      bank + list + (rightC - leftC) * 0.25,
      1 - Math.exp(-8 * dt),
    );
    g.rotation.x = THREE.MathUtils.lerp(
      g.rotation.x,
      -v.speed * 0.0012 +
        v.bodyPitch +
        (v.wreckTimer > 0 ? 0.25 : v.damageVisual * 0.04) +
        (rearC - frontC) * 0.2,
      1 - Math.exp(-6 * dt),
    );

    const body = shell?.userData.bodyGroup as THREE.Object3D | undefined;
    if (body) {
      const dmg = v.damageVisual;
      const stretch = 1 + Math.min(0.06, Math.abs(v.speed) * 0.0007);
      const squash = 1 / Math.sqrt(stretch);
      body.scale.set(
        squash * (1 - v.dentLeft * 0.14 - v.dentRight * 0.14),
        squash * (1 - dmg * 0.06),
        stretch * (1 - v.dentFront * 0.16 - v.dentRear * 0.12),
      );
      body.position.y = -Math.min(0.06, (frontC + rearC) * 0.08);
      body.position.x = (v.dentRight - v.dentLeft) * 0.14;
      body.position.z = v.dentFront * 0.12 - v.dentRear * 0.1;
      if (v.impactFlash > 0) {
        const j = v.impactFlash * 0.35;
        body.position.x += (Math.random() - 0.5) * j;
        body.position.y += (Math.random() - 0.5) * j * 0.5;
        body.position.z += (Math.random() - 0.5) * j;
      }
    }

    const wheels = shell?.userData.wheels as WheelSlot[] | undefined;
    if (wheels && wheels.length) {
      const radius = TIRE_RADIUS[v.classId] ?? 0.32;
      const spd = v.speed || 0;
      for (const w of wheels) {
        const t = tires[w.tireIndex];
        const rest = (w.pivot.userData.restY as number) ?? w.pivot.position.y;
        w.pivot.position.y = rest - (t?.compress ?? 0.15) * radius * 0.55;
        w.pivot.rotation.y = w.isFront ? v.steerAngle * 0.85 : 0;
        spinAccum.current[w.tireIndex] +=
          (spd / Math.max(0.28, radius)) * dt;
        w.spin.rotation.x = spinAccum.current[w.tireIndex];
      }
    }

    // !decoy: a player-projected decoy resolves to the player's own state, and
    // without this guard it would overwrite the player's telemetry with the
    // hologram's every frame.
    if (v.isPlayer && !decoy && typeof window !== "undefined") {
      (
        window as unknown as { __playerMesh?: Record<string, unknown> }
      ).__playerMesh = {
        x: v.x,
        y: v.y,
        z: v.z,
        yaw: v.yaw,
        visible: g.visible,
        children: g.children.length,
        hasShell: !!shell,
        avgCompress: avgC,
        merged: shell?.userData.merged,
        kenney: shell?.userData.kenney,
        textured: shell?.userData.textured,
        customUrl: shell?.userData.customUrl,
        wheels: wheels?.length ?? 0,
        drawCalls: shell?.userData.drawCalls,
        speed: v.speed,
        steer: v.steerAngle,
      };
    }

    if (decoy) {
      const dx = camera.position.x - v.x;
      const dz = camera.position.z - v.z;
      // Same 220m cut the real cars get. The old decoy path had none at all, so
      // it kept drawing after the car it belonged to had been culled — a lone
      // translucent car with nothing beside it.
      const near = dx * dx + dz * dz < 220 * 220;
      // Hard stutter as the projection dies, on top of the scale collapse.
      g.visible =
        near && (v.decoyActive > 0.18 || Math.sin(v.decoyActive * 120) > -0.2);
    } else if (!v.isPlayer && !forceHero) {
      const dx = camera.position.x - v.x;
      const dz = camera.position.z - v.z;
      const d2 = dx * dx + dz * dz;
      g.visible = d2 < 220 * 220;
    }
  }, FRAME.POSE);

  if (failed || !wantsGltf) {
    return (
      <ModularVehicleMesh
        vehicle={vehicle}
        vehicleId={vehicleId}
        sim={sim}
        ghost={ghost}
        forceHero={forceHero}
      />
    );
  }

  return (
    <group ref={group}>
      {shell && <primitive object={shell} />}
    </group>
  );
}
