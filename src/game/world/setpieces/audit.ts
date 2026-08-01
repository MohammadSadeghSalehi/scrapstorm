/**
 * Static checks over the built setpieces, with no renderer.
 *
 * Same idea as `validateEnvironments()`: every rule here corresponds to a
 * mistake that is invisible in code review and expensive to find by driving.
 * For structures the stakes are higher than for scatter — nothing here has a
 * collider, so a 21m furnace stack overlapping the road is a solid-looking
 * building the player passes through at 40 m/s — and the failure is easy to
 * miss because it only shows up on one leg of one circuit.
 *
 * Runs headlessly through jiti, the same way scripts/check-track-profile.mjs
 * runs the track curve:
 *
 *   const sp = await jiti.import("src/game/world/setpieces/audit.ts");
 *   track.setActiveTrack(id);
 *   const problems = sp.auditActiveSetpieces();
 *
 * WHY THIS TESTS VERTICES AND NOT ANCHORS. The placement code already proves
 * each anchor is clear of the drivable surface by its family's nominal radius.
 * That radius is authored, so it can be wrong, and it is a circle, so it cannot
 * describe a crane whose jib reaches 18m one way and 5m the other. Transforming
 * the actual geometry is the only test that cannot be fooled by a footprint
 * number somebody guessed.
 */
import * as THREE from "three";
import { getActiveTrackId, getGroundHeight, getSurfaceAt } from "../../track";
import { APRON_M } from "../scatter/placement";
import { buildSetpieceLayers } from "./build";

/**
 * Height above a structure's own ground contact that a car can reach.
 *
 * Above this, geometry may overhang drivable surface without consequence — you
 * drive under it. Measured from the structure's base rather than from world
 * zero, because the desert climbs to +12m off the tarmac and a world-space
 * threshold would silently exempt everything standing on a dune, which is
 * exactly the geometry a naive check most wants to look at.
 */
const CAR_REACH_M = 4.0;

/** Tolerance on ground contact. Anything above this is a floating structure. */
const GROUND_EPSILON_M = 0.02;

export type SetpieceAudit = {
  family: string;
  instances: number;
  trisPerInstance: number;
  /**
   * Metres of clearance between the nearest drivable surface and the closest
   * piece of geometry within car reach. Negative means the player drives
   * through it.
   */
  clearance: number;
  /** Largest disagreement between an instance's origin and the ground under it. */
  groundError: number;
};

/** Per-family measurements for whichever circuit is active. */
export function measureActiveSetpieces(): SetpieceAudit[] {
  const built = buildSetpieceLayers();
  const out: SetpieceAudit[] = [];
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();

  for (const layer of built.layers) {
    const geo = layer.data.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
    const n = layer.data.total;
    let clearance = Infinity;
    let groundError = 0;

    for (let i = 0; i < n; i++) {
      m.fromArray(layer.data.matrices, i * 16);
      const ox = m.elements[12]!;
      const oy = m.elements[13]!;
      const oz = m.elements[14]!;
      groundError = Math.max(groundError, Math.abs(oy - getGroundHeight(ox, oz)));

      if (!pos) continue;
      for (let vi = 0; vi < pos.count; vi++) {
        v.fromBufferAttribute(pos, vi).applyMatrix4(m);
        if (v.y - oy > CAR_REACH_M) continue;
        const surf = getSurfaceAt(v.x, v.z);
        const slack = surf.dist - (surf.half + APRON_M);
        if (slack < clearance) clearance = slack;
      }
    }

    out.push({
      family: layer.id,
      instances: n,
      trisPerInstance: geo.index
        ? geo.index.count / 3
        : (pos?.count ?? 0) / 3,
      clearance,
      groundError,
    });
  }

  built.dispose();
  return out;
}

/** Human-readable problems with the active circuit's setpieces. Empty is pass. */
export function auditActiveSetpieces(): string[] {
  const id = getActiveTrackId();
  const problems: string[] = [];
  for (const r of measureActiveSetpieces()) {
    if (r.instances === 0) {
      problems.push(`${id}/${r.family}: family resolved to zero instances`);
    }
    if (r.clearance < 0) {
      problems.push(
        `${id}/${r.family}: overlaps drivable surface by ${(-r.clearance).toFixed(
          2,
        )}m within ${CAR_REACH_M}m of its base`,
      );
    }
    if (r.groundError > GROUND_EPSILON_M) {
      problems.push(
        `${id}/${r.family}: sits ${r.groundError.toFixed(
          2,
        )}m off the ground query — placement used a road plane or a literal, not getGroundHeight`,
      );
    }
  }
  return problems;
}
