/**
 * Vehicle meshes — user custom GLBs for every class (player + AI).
 * Templates cached once; clones share geometry. AI skips expensive clearcoat.
 */
import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { VehicleState, VehicleClassId } from "../types";
import { ModularVehicleMesh } from "./meshes";
import { FRAME } from "../world/framePriority";
import { qualityManager } from "../world/quality";
import { isPbrLibraryReady } from "../world/webgl2/textureLibrary";
import { TIRE_RADIUS } from "../tires";

/** Class → custom mesh (user-authored). Shared by player and AI. */
const MODEL_URL: Record<VehicleClassId, string> = {
  interceptor: "/assets/meshes/custom/SM_MeshGen_WastelandCustomCar.glb",
  trickster: "/assets/meshes/custom/SM_MeshGen_CustomWidebodyHatchback.glb",
  bruiser: "/assets/meshes/custom/SM_MeshGen_DesertCombatVehicle.glb",
};

const AI_URL = MODEL_URL;

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
  const loader = new GLTFLoader();
  try {
    loader.setMeshoptDecoder(MeshoptDecoder);
  } catch {
    /* optional */
  }
  return loader;
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
 * MeshGen GLBs ship metallicFactor=1 + a non-standard MR map that turns
 * bodies into black chrome. Keep albedo, force readable metal/rough,
 * skip metalnessMap. Brighten base color so dark albedos stay visible.
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
    const src = (
      Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    ) as THREE.MeshStandardMaterial | undefined;

    const map = src?.map ?? null;
    const normalMap =
      !hero || tier === "low" ? null : (src?.normalMap ?? null);
    const emissiveMap = src?.emissiveMap ?? null;

    const metalness = 0.18;
    const roughness = 0.55;
    const baseColor = ghost
      ? new THREE.Color(color).multiplyScalar(0.55)
      : new THREE.Color(1.25, 1.22, 1.18);

    let mat: THREE.Material;
    if (usePhysical) {
      mat = new THREE.MeshPhysicalMaterial({
        map,
        normalMap,
        emissiveMap,
        color: baseColor,
        metalness,
        roughness,
        clearcoat: 0.18,
        clearcoatRoughness: 0.42,
        envMapIntensity: 1.15,
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
        envMapIntensity: 1.05,
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
): THREE.Group {
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
      1.25 - dirt * 0.35,
      1.22 - dirt * 0.35,
      1.18 - dirt * 0.35,
    );
    body.roughness = Math.min(0.92, 0.45 + dmg * 0.4);
    if ("clearcoat" in body) {
      (body as THREE.MeshPhysicalMaterial).clearcoat = Math.max(
        0.05,
        0.28 - dmg * 0.25,
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
}: {
  vehicle: VehicleState;
  vehicleId?: string;
  sim?: { state: { vehicles: VehicleState[] } };
  ghost?: boolean;
  forceHero?: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const [shell, setShell] = useState<THREE.Object3D | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useRef(vehicle);
  const spinAccum = useRef([0, 0, 0, 0]);
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
  const hero = vehicle.isPlayer || forceHero;

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
      );
      const meshes = (clone.userData.meshCount as number) || 0;
      if (meshes < 1) {
        setFailed(true);
        return;
      }
      setShell(clone);
      setFailed(false);
      if (vehicle.isPlayer && typeof window !== "undefined") {
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
      const primary = hero
        ? MODEL_URL[vehicle.classId]
        : AI_URL[vehicle.classId];
      try {
        const tpl = await loadTemplate(primary);
        mount(tpl, primary);
      } catch {
        try {
          const tpl = await loadTemplate(FALLBACK_URL);
          mount(tpl, FALLBACK_URL);
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
  ]);

  useEffect(() => {
    if (!shell) return;
    applyDamageLook(shell, color, vehicle.damageVisual);
  }, [shell, color, vehicle.damageVisual]);

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

    if (v.isPlayer && typeof window !== "undefined") {
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

    if (!v.isPlayer && !forceHero) {
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
