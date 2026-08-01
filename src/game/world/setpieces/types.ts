/**
 * Built structure, as data.
 *
 * Six circuits already differ in every value the LOOK is made of — sky, sun,
 * fog, sand ramp, skyline, grade (see ../environments). What they did not
 * differ in was DESIGN: the same road ribbon across the same procedurally
 * scattered ground, wearing six palettes. Foundry Pit is described as an
 * industrial brawl pit and Rustline as a scrapyard gauntlet, and neither had a
 * single built object that made it read as a place.
 *
 * WHY THIS IS NOT PART OF `EnvironmentDef`. That type states its own rule
 * plainly: an environment SWAPS parameters, it does not STACK features, and
 * nothing in it may make one circuit mount a mesh another circuit does not.
 * Setpieces are exactly the thing that rule forbids — Foundry Pit mounts
 * furnace stacks and Sable Run mounts almost nothing — so they get their own
 * registry rather than smuggling a feature toggle into a file that has
 * promised not to have any. The two systems meet only in the frame.
 *
 * THE BUDGET, which is the design constraint and not an afterthought:
 *
 *  - One family is ONE geometry, ONE material and ONE InstancedMesh, so it is
 *    ONE draw call however many instances it has. Circuits are authored to 1-4
 *    families. Adding a fifth family to a circuit costs a draw call for as long
 *    as that circuit is loaded, whether or not anything is on screen.
 *  - Every family is culled per instance by ScatterLayer, the same machinery the
 *    desert scatter and the guard rail use — distance first, then frustum, with
 *    the survivors packed to the front of the buffer so hidden instances do not
 *    run a vertex shader.
 *  - `density` and `range` are per-tier, and the low tier is expected to be
 *    given a shorter draw distance rather than holes in a wall. A wall with
 *    every third module missing reads as broken; an emptier horizon does not.
 *
 * THE CORRECTNESS CONSTRAINT, which has bitten this repo repeatedly: none of
 * this participates in physics. A structure overlapping drivable surface is not
 * an ugly structure, it is one the player drives straight through. Placement
 * therefore goes through `getSurfaceAt` against the WHOLE loop (see
 * ./placement.ts) — an offset taken from one track sample proves nothing,
 * because every circuit here doubles back on itself.
 */
import type { TrackSample } from "../../types";
import type { AnyTrackId } from "../../track";
import type { TierScale } from "../scatter";

/** Hex string. Parsed once, at material build. */
export type Hex = string;

export type Zone = TrackSample["zone"];

/**
 * Which merged geometry a family draws. See ./geometry.ts.
 *
 * A closed union rather than a callback so the whole catalogue of structures in
 * the game is one list you can read, and so a preset cannot quietly introduce a
 * geometry that nothing has costed.
 */
export type SetpieceShape =
  | "slagWall"
  | "furnaceStack"
  | "furnaceTap"
  | "chokeGate"
  | "wreckStack"
  | "containerWall"
  | "craneArm"
  | "monolith"
  | "pipeRun"
  | "pumpStation"
  | "distanceMarker"
  | "kilnShell";

export type SetpieceMaterial = {
  color: Hex;
  roughness: number;
  metalness: number;
  /**
   * Self-lit parts — a tap hole, a warning lamp.
   *
   * three's emissive is a material uniform, so it lifts the WHOLE family
   * uniformly and cannot be masked by vertex colour. Anything that wants to
   * glow in one place therefore has to be its own small family riding on
   * another family's anchors (`follows`), which is why `furnaceTap` exists as a
   * separate shape instead of as a bright box inside `furnaceStack`.
   */
  emissive?: Hex;
  emissiveIntensity?: number;
  envMapIntensity?: number;
};

/**
 * A window over the lap, as a fraction of the sample list.
 *
 * `[0.05, 0.5]` is the first half of the circuit. Wraps when `from > to`. This
 * is what lets the Dead Mile's outbound leg carry the pipeline and its return
 * leg carry nothing but distance markers — the single clearest way to make a
 * 1.7km loop read as a point-to-point haul rather than as a lap of anything.
 */
export type ArcWindow = [from: number, to: number];

/**
 * Structures that follow the verge: walls, pipelines, container stacks.
 *
 * Anchors are taken in TRACK ORDER, because continuity is the whole point — a
 * wall is only a wall if consecutive modules line up.
 */
export type CorridorPlacement = {
  mode: "corridor";
  /** Track samples between modules. Sample spacing is ~3.1m on every circuit. */
  stride: number;
  /** Metres outward from the OUTER edge of the gravel run-off, before solving. */
  offset: number;
  /** Half-footprint across the road, for the clearance solve. */
  radius: number;
  /** Restrict to these zone tags. Omit for the whole circuit. */
  zones?: Zone[];
  arc?: ArcWindow;
  /**
   * `both` walls the corridor. `outside` puts the structure only where a car
   * leaves the road, which is what a barrier is for. `alternate` staggers the
   * sides so the road is framed without being tunnelled. `left`/`right` pin it
   * to one verge for the whole run — a pipeline that swaps sides halfway is not
   * a pipeline.
   */
  sides: "both" | "outside" | "alternate" | "left" | "right";
  /** Anchor offset, so two families on one circuit do not share posts. */
  phase?: number;
  /**
   * Modules on, then modules off. A solid ring of containers is a tunnel and
   * hides the circuit from itself; letting it break every so often is what
   * makes it read as a yard you are driving through rather than as a corridor
   * texture. `gapLen: 0` is continuous, which is right for a pipeline.
   */
  runLen?: number;
  gapLen?: number;
  /**
   * Join consecutive same-side anchors into a continuous run: each module is
   * aimed at the next anchor, pitched to take up the height difference, and
   * stretched along its local +X to close the gap. Geometry for a linked family
   * is authored spanning [0, span] in local X (see railModuleGeometry, which
   * established the convention).
   *
   * Unlinked families are placed AT the anchor, facing the road.
   */
  link: boolean;
  /** Uniform scale range, sampled per instance. */
  scale: [number, number];
  /** Extra yaw jitter for unlinked families, radians. */
  yawJitter?: number;
};

/**
 * Structures scattered in a band off the circuit: stacks, cranes, monoliths.
 *
 * These are the ones that carry the mid-ground silhouette, so they are big,
 * few, and separated from each other — two 20m furnace stacks intersecting is
 * not a busier skyline, it is a bug.
 */
export type FieldPlacement = {
  mode: "field";
  seed: number;
  /** Band start/end, measured outward from the outer edge of the run-off. */
  near: number;
  far: number;
  /** Half-footprint at the family's LARGEST scale. Big things need real room. */
  radius: number;
  /** Instances kept, at most. The band rarely yields this many at `separation`. */
  count: number;
  /** Minimum centre-to-centre distance between accepted instances, metres. */
  separation: number;
  zones?: Zone[];
  arc?: ArcWindow;
  scale: [number, number];
  /** Turn the structure's local +Z toward the racing line. */
  faceRoad: boolean;
};

export type SetpiecePlacement = CorridorPlacement | FieldPlacement;

export type SetpieceFamily = {
  /** Unique within a circuit. Also the key `reportDensity` publishes under. */
  id: string;
  shape: SetpieceShape;
  material: SetpieceMaterial;
  /**
   * Reuse another family's resolved anchors instead of placing independently.
   *
   * The named family must appear EARLIER in the list. This exists so a glowing
   * tap hole lands on the furnace it belongs to; deriving it from a second
   * field sample with the same seed would work right up until someone retuned
   * one of the two and silently decoupled them.
   */
  follows?: string;
  placement?: SetpiecePlacement;
  /** Fraction of instances drawn, per tier. Keep at 1 for anything continuous. */
  density: TierScale;
  /** Draw-distance multiplier per tier. Where the tier saving should come from. */
  range: TierScale;
  /** Draw distance at the high tier, metres, before the per-instance jitter. */
  limit: number;
  /**
   * Shadow casting is OFF by default and should stay off for anything numerous.
   * A structure earns it by being large, near the road and few — the choke gates
   * and the pipeline trestles do, two hundred wall modules do not.
   */
  castShadow?: boolean;
};

export interface SetpieceDef {
  id: AnyTrackId;
  /** One line of art direction. What every family below is serving. */
  intent: string;
  families: SetpieceFamily[];
}
