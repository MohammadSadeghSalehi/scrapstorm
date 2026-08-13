/**
 * How much of the roadside each quality tier draws.
 *
 * Split out of RoadsideFurniture.tsx for exactly the reason setpieceGeometry.ts
 * was split from its component: jiti's transform does not take JSX, so anything
 * living in a `.tsx` cannot be MEASURED headlessly. These four numbers are the
 * entire draw-call budget of the roadside — the claim "the low tier gains
 * nothing" is a claim about this file — and a budget that can only be checked by
 * reading it is a budget that drifts.
 *
 * `scripts/check-setpiece-footprints.mjs` now prints instances and triangles per
 * tier from these tables and the real layout, and fails if a family that draws
 * nothing at the low tier starts drawing something.
 */
import type { TierScale } from "./layerData";

/**
 * Rail is never thinned by tier — a guard rail with every third module missing
 * looks broken in a way that an emptier desert does not. Range carries the
 * saving instead.
 */
export const RAIL_DENSITY: TierScale = { low: 1, medium: 1, high: 1 };
export const RAIL_RANGE: TierScale = { low: 0.45, medium: 0.75, high: 1 };

/**
 * Boards are no longer thinned either, and for a harder reason than the rail's.
 *
 * Density is a prefix of the instance list; colliders are not tiered at all.
 * At the old low-tier 0.5 the back half of the hoardings would have been solid
 * and invisible — a quality setting that spawns invisible walls. 26 extra
 * five-box instances at the bottom tier is the cheaper of the two problems.
 */
export const BOARD_DENSITY: TierScale = { low: 1, medium: 1, high: 1 };
export const BOARD_RANGE: TierScale = { low: 0.5, medium: 0.8, high: 1 };

/**
 * Sign plates. Unlike the two above these are thinned to NOTHING at the low
 * tier, and that is safe here for the one reason it is not safe there: a sign
 * has NO COLLIDER, so a hidden one cannot become an invisible wall.
 *
 * The precedent for leaving it uncollidable is already in setpieceColliders —
 * the Dead Mile's distance markers, `distanceMarker: null`, whose note reads "a
 * stick that stops the car is worse than a stick that does nothing". This is the
 * same object: a 0.14m post carrying a plate whose lower edge is at 2.0m, which
 * is above the roof of every car in the game. At any height a car occupies,
 * there is nothing here but the stick.
 *
 * The zero is also what makes the whole signage pass free at the bottom: a
 * layer with `density.low === 0` sets `mesh.visible = false`, and three's
 * `projectObject` bails before it binds a program — so the atlas is never even
 * uploaded on the machine that cannot afford it.
 */
export const SIGN_DENSITY: TierScale = { low: 0, medium: 0.7, high: 1 };
export const SIGN_RANGE: TierScale = { low: 0, medium: 0.8, high: 1 };
