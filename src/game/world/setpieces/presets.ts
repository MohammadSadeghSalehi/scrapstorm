/**
 * One built world per circuit.
 *
 * The environments already made six circuits look different. This makes them BE
 * different: Foundry Pit is walled in and Sable Run is not, and that is a
 * property of the layout rather than of the light on it.
 *
 * ── the far limit, which is not negotiable ───────────────────────────
 *
 * HeightmapTerrain sizes its patch to the circuit's bounding box plus 130m a
 * side; past that edge the world is flat sand tiles at y = -2.5 while
 * `duneProfile` — the curve every placement here settles onto — keeps climbing
 * to roadY + 1.1 + dune*16. A structure placed beyond the patch therefore stands
 * on ground that is not drawn, several metres above tiles that are. So no
 * `field` family runs past ~105m from the run-off edge, and that is a hard
 * ceiling rather than an art choice. It costs less than it sounds: 105m off the
 * verge is already the far mid ground, and the actual horizon belongs to the
 * skyline ranges in Atmosphere.
 *
 * ── the cost, per circuit, at the high tier ──────────────────────────
 *
 * Measured, not estimated — `measureActiveSetpieces()` in ./audit.ts walks the
 * built layers headlessly and reports exactly this:
 *
 *   ash_spire     0 draw calls,    0 inst,     0 tris   (deliberately; see below)
 *   cinder_bowl   1 draw call,     9 inst,   900 tris
 *   foundry_pit   4 draw calls,  122 inst,  6096 tris
 *   rustline      3 draw calls,  136 inst,  7404 tris
 *   sable_run     1 draw call,    16 inst,   768 tris
 *   dead_mile     3 draw calls,  110 inst,  7712 tris
 *
 * These are TOTALS, not per-frame: every family is distance- and frustum-culled
 * per instance, so a typical frame submits a fraction of them. For scale, the
 * desert scatter on these same circuits is 3 draw calls and 46k-79k triangles,
 * and the road ribbon alone is tens of thousands more. The two heaviest
 * circuits here are the two whose whole identity is enclosure — the only thing
 * that could justify being heavier than the others — and the two cheapest are
 * the two whose identity is emptiness.
 *
 * The low tier never pays the full bill: continuous families keep every module
 * but lose more than half their draw distance, and landmark families drop to
 * 45% density on top of that.
 */
import type { SetpieceDef } from "./types";
import type { AnyTrackId } from "../../track";
import type { TierScale } from "../scatter/layerData";

/**
 * Continuous structure is never thinned by tier — a wall with every third
 * module missing reads as broken, where an emptier horizon does not. The saving
 * comes out of draw distance instead. Same policy as the guard rail's.
 */
const SOLID: TierScale = { low: 1, medium: 1, high: 1 };
const NEAR_RANGE: TierScale = { low: 0.42, medium: 0.72, high: 1 };
/** Landmarks: big, far, and the first thing a weak machine should lose some of. */
const LANDMARK_DENSITY: TierScale = { low: 0.45, medium: 0.75, high: 1 };
const WIDE_RANGE: TierScale = { low: 0.5, medium: 0.78, high: 1 };

/**
 * ── Ash Spire — nothing ──────────────────────────────────────────────
 *
 * This is a decision, not an omission. Ash Spire is the circuit the entire look
 * was tuned against; it is what the QA baselines show and what every other
 * circuit is measured as a departure FROM. It already carries the shared set
 * dressing — SCENERY landmarks, Poly Haven decor, guard rail and hoardings —
 * and adding a structure family here would change the reference while the
 * reference is what the other five are being judged against.
 *
 * If it ever wants one, the honest choice is the spire its name promises, as a
 * single `field` family of one or two instances. Not this pass.
 */
const ASH_SPIRE: SetpieceDef = {
  id: "ash_spire",
  intent:
    "The reference desert stadium. Left alone on purpose — everything else is a departure from this.",
  families: [],
};

/**
 * ── Cinder Bowl — where the ash came from ────────────────────────────
 *
 * A light touch, because the brief on this circuit is to keep it recognisable.
 * Nine burnt-out kilns in the mid ground, no more, and nothing near the road:
 * the bowl's character is its hairpin and its molten horizon, and neither wants
 * competition. What they buy is causality — the ground is described as ash and
 * clinker, and until now nothing in frame had ever burned anything.
 */
const CINDER_BOWL: SetpieceDef = {
  id: "cinder_bowl",
  intent:
    "Kilns that made the ash. Mid-ground silhouettes against the sunset, nothing at the verge.",
  families: [
    {
      id: "kilns",
      shape: "kilnShell",
      material: {
        color: "#7a6154",
        roughness: 0.93,
        metalness: 0.04,
        envMapIntensity: 0.7,
      },
      placement: {
        mode: "field",
        seed: 0x0c1b47,
        near: 20,
        far: 70,
        // The fallen slab reaches ~6.6m from centre before scale; at 1.2x that is
        // 7.9m. A radius smaller than the geometry's own reach is a clearance
        // test that passes on paper and fails in the frame.
        radius: 7.9,
        count: 9,
        separation: 48,
        scale: [0.85, 1.2],
        faceRoad: true,
      },
      density: LANDMARK_DENSITY,
      range: WIDE_RANGE,
      limit: 340,
      // No shadow. These sit 20-70m out and the cascade is ~55m, so most of the
      // family would be submitted to the shadow pass to land outside it — a
      // draw call for nothing. What sells them is silhouette against the
      // sunset, which needs no shadow at all.
    },
  ],
};

/**
 * ── Foundry Pit — an enclosed arena ──────────────────────────────────
 *
 * The layout is already a brawl: two 36-40m bowls joined by 20m chokes, and a
 * lap short enough that you are never more than a corner from the pack. What it
 * had no way to SAY was that it is a pit. A bowl reads as a bowl because you
 * cannot see out of it, and a choke reads as a choke because something heavy is
 * standing at the entrance to it.
 *
 * Three ideas, in the order they matter:
 *
 *  - The slag wall runs both verges for the whole lap, 6m tall and set back
 *    behind the hoardings the way a real circuit's retaining wall sits behind
 *    its advertising. It is what removes the horizon from the two bowls.
 *  - Choke gates stand ONLY on the `narrow` zones, in pairs, five a side. They
 *    are the only structure on the circuit that appears twice per lap in the
 *    same place, so they become the landmark you brake for.
 *  - Fourteen furnace stacks at 21m carry the skyline over the wall, and their
 *    tap holes are the only warm light in the frame that is not the sky. The
 *    environment already grades this circuit as a working smelter at night; the
 *    stacks are what the smelter is.
 */
const FOUNDRY_PIT: SetpieceDef = {
  id: "foundry_pit",
  intent:
    "A working pit you cannot see out of. Walls at both verges, gates at the chokes, furnaces over the top of it.",
  families: [
    {
      id: "pitWall",
      shape: "slagWall",
      material: {
        color: "#4a423d",
        roughness: 0.94,
        metalness: 0.05,
        envMapIntensity: 0.5,
      },
      placement: {
        mode: "corridor",
        stride: 4,
        // Set back past the hoarding band (offset 5.5 + radius 3), so the wall
        // stands behind the advertising instead of through it. Height, not
        // proximity, is what does the enclosing here.
        offset: 10.5,
        radius: 2.2,
        sides: "both",
        runLen: 12,
        gapLen: 4,
        link: true,
        // Linked families take X from the fit to the next anchor; this scales
        // the section, i.e. the wall's height and thickness. 1.5 puts the
        // coping at 6.15m — above eye line from a car at any distance it is
        // seen from.
        scale: [1.5, 1.5],
      },
      density: SOLID,
      range: NEAR_RANGE,
      limit: 300,
    },
    {
      id: "chokeGates",
      shape: "chokeGate",
      material: {
        color: "#6b625a",
        roughness: 0.88,
        metalness: 0.06,
        envMapIntensity: 0.6,
      },
      placement: {
        mode: "corridor",
        stride: 4,
        // Tight: offset is only a starting hint, and the clearance solve pushes
        // to radius + margin past the run-off anyway. Starting here means the
        // gates end up as close as they are permitted to be, which is the point.
        offset: 3.6,
        radius: 2.4,
        zones: ["narrow"],
        sides: "both",
        link: false,
        scale: [1.0, 1.18],
        yawJitter: 0.06,
      },
      density: SOLID,
      range: NEAR_RANGE,
      limit: 260,
      // Few, large, and right beside the road at the one place everyone is
      // looking. Worth a shadow where two hundred wall modules are not.
      castShadow: true,
    },
    {
      id: "furnaces",
      shape: "furnaceStack",
      material: {
        color: "#5c534c",
        roughness: 0.9,
        metalness: 0.12,
        envMapIntensity: 0.55,
      },
      placement: {
        mode: "field",
        seed: 0x2f9a11,
        near: 22,
        far: 95,
        radius: 9.4,
        count: 14,
        separation: 42,
        scale: [0.85, 1.15],
        faceRoad: true,
      },
      density: LANDMARK_DENSITY,
      range: WIDE_RANGE,
      limit: 420,
    },
    {
      id: "furnaceTaps",
      shape: "furnaceTap",
      // Rides the stacks' anchors, so the glow is on the furnace rather than
      // near it. Its own family only because emissive is a material uniform.
      follows: "furnaces",
      material: {
        color: "#2a1008",
        roughness: 0.6,
        metalness: 0.0,
        emissive: "#ff6a20",
        emissiveIntensity: 2.4,
        envMapIntensity: 0.2,
      },
      density: LANDMARK_DENSITY,
      range: WIDE_RANGE,
      limit: 420,
    },
  ],
};

/**
 * ── Rustline — a corridor made of other people's cars ────────────────
 *
 * The design brief for this circuit is that the road should feel narrower than
 * it measures, and the layout has already done its half: 18-24m tarmac and a
 * chicane with a delivered radius of ~18m. What it needed was something at the
 * verge to measure against. An empty desert 6m from the tarmac makes a 20m road
 * feel like a runway.
 *
 * Container stacks sit as close as the clearance solve permits, 5m tall, in
 * broken runs so the yard stays legible rather than becoming a tunnel. Wrecks
 * fill the gaps between them at 4-30m — the layer that actually reads at speed,
 * because it is the one within a car's width of the racing line. Nine cranes at
 * 16m give the yard a skyline; their jibs are authored on the away-from-road
 * axis so an 18m boom can never end up over the tarmac.
 */
const RUSTLINE: SetpieceDef = {
  id: "rustline",
  intent:
    "A scrapyard corridor. Containers at the verge, wrecks in the gaps, crane jibs over the top — the road reads narrower than it measures.",
  families: [
    {
      id: "yardWall",
      shape: "containerWall",
      material: {
        color: "#8a6a4e",
        roughness: 0.85,
        metalness: 0.25,
        envMapIntensity: 0.75,
      },
      placement: {
        mode: "corridor",
        stride: 4,
        offset: 3.4,
        radius: 1.9,
        sides: "both",
        // Seven on, three off: roughly 87m of container to 37m of gap, which is
        // long enough to feel walled and short enough to keep the corners
        // readable.
        runLen: 7,
        gapLen: 3,
        link: true,
        scale: [0.95, 1.1],
      },
      density: SOLID,
      range: NEAR_RANGE,
      limit: 260,
    },
    {
      id: "wrecks",
      shape: "wreckStack",
      material: {
        color: "#8c6a52",
        roughness: 0.82,
        metalness: 0.34,
        envMapIntensity: 0.85,
      },
      placement: {
        mode: "field",
        seed: 0x6d21c4,
        // As close as the solve allows. This is the layer doing the work: at
        // 4m from the run-off edge it passes within a car's width, which is
        // what a sense of narrowness is actually made of.
        near: 4,
        far: 30,
        // Half-diagonal of the longest slab (2.5m) at the family's 1.35x ceiling.
        radius: 3.4,
        count: 46,
        separation: 11,
        scale: [0.9, 1.35],
        faceRoad: true,
      },
      density: { low: 0.5, medium: 0.8, high: 1 },
      range: NEAR_RANGE,
      limit: 200,
    },
    {
      id: "cranes",
      shape: "craneArm",
      material: {
        color: "#9a7434",
        roughness: 0.72,
        metalness: 0.4,
        envMapIntensity: 0.9,
      },
      placement: {
        mode: "field",
        seed: 0x41b8e2,
        near: 26,
        far: 85,
        // Only the counter-jib side needs covering — the 18m main jib is
        // authored along local -Z and `faceRoad` guarantees -Z points away from
        // the circuit, so the boom hangs over scrap by construction.
        radius: 7.0,
        count: 9,
        separation: 55,
        scale: [0.85, 1.1],
        faceRoad: true,
      },
      density: LANDMARK_DENSITY,
      range: WIDE_RANGE,
      limit: 400,
    },
  ],
};

/**
 * ── Sable Run — restraint ────────────────────────────────────────────
 *
 * The one circuit where the correct amount of set dressing is almost none.
 * A mile and a half of fourth-gear geometry on a black basalt playa under a
 * noon sun: the whole point is that there is nothing, and a scrapyard's worth
 * of structure at the verge would make it into a slower version of Rustline.
 *
 * So: one family, sixteen instances, 60-105m out and never nearer. They are not
 * there to be looked at. With nothing between the car and the ridge there is no
 * parallax, and with no parallax a 400m playa and a 4km one are the same image;
 * sixteen 13m remnants sliding past at different rates is the cheapest possible
 * way to say how far away the horizon is.
 */
const SABLE_RUN: SetpieceDef = {
  id: "sable_run",
  intent:
    "Empty on purpose. A handful of distant basalt remnants, there to give the horizon a scale and nothing else.",
  families: [
    {
      id: "remnants",
      shape: "monolith",
      material: {
        color: "#6e6a63",
        roughness: 0.95,
        metalness: 0.03,
        envMapIntensity: 0.85,
      },
      placement: {
        mode: "field",
        seed: 0x13d7a9,
        near: 60,
        far: 105,
        // Base slab half-diagonal (2.15m) at the 1.9x ceiling.
        radius: 4.2,
        count: 16,
        // Enormous, and that is the design: sixteen of these spread over 1.45km
        // is one every 90m of circuit, which is sparse enough that you never see
        // two at once.
        separation: 120,
        scale: [0.9, 1.9],
        // Free yaw. A rock that squares up to the road is a building.
        faceRoad: false,
      },
      density: LANDMARK_DENSITY,
      range: WIDE_RANGE,
      limit: 460,
      // Same reason as Cinder Bowl's kilns: 60m+ out is past the cascade, and
      // at noon on a playa the shadow would be directly underneath anyway.
    },
  ],
};

/**
 * ── The Dead Mile — a haul road, not a lap ───────────────────────────
 *
 * This circuit is authored to be driven as a point-to-point even though it
 * closes: 500m out along the pipeline, six metres of climb, a far turn around
 * the tanks and a completely different road home. Everything below serves the
 * one thing that makes that legible from the driver's seat — THE WAY OUT MUST
 * NOT LOOK LIKE THE WAY BACK.
 *
 *  - The pipeline runs continuously along one verge for the outbound leg only,
 *    and then stops. It is the circuit's name written down the side of the road.
 *  - Pumping stations punctuate the outbound run and the far turn.
 *  - The return leg has none of it. What it has is distance markers, alternating
 *    sides every ~50m, and nothing else at all. Half a lap of pipeline and half
 *    a lap of counting posts is the difference between "a long road" and "a
 *    haul", and it costs one extra draw call.
 */
const DEAD_MILE: SetpieceDef = {
  id: "dead_mile",
  intent:
    "A pipeline haul road. Out beside the line, back beside nothing but distance markers.",
  families: [
    {
      id: "pipeline",
      shape: "pipeRun",
      material: {
        color: "#9a9184",
        roughness: 0.66,
        metalness: 0.42,
        envMapIntensity: 0.95,
      },
      placement: {
        mode: "corridor",
        stride: 3,
        offset: 2.6,
        radius: 1.6,
        // One verge for the whole run. A pipeline that changes sides halfway is
        // not a pipeline.
        sides: "right",
        // Outbound leg only: sample 0 to just past the far turn.
        arc: [0.0, 0.46],
        link: true,
        scale: [1.0, 1.0],
      },
      density: SOLID,
      range: NEAR_RANGE,
      limit: 300,
    },
    {
      id: "pumps",
      shape: "pumpStation",
      material: {
        color: "#8e8778",
        roughness: 0.78,
        metalness: 0.3,
        envMapIntensity: 0.85,
      },
      placement: {
        mode: "field",
        seed: 0x77aa31,
        near: 16,
        far: 55,
        radius: 6.0,
        count: 10,
        separation: 90,
        arc: [0.0, 0.62],
        scale: [0.9, 1.1],
        faceRoad: true,
      },
      density: LANDMARK_DENSITY,
      range: WIDE_RANGE,
      limit: 380,
      castShadow: true,
    },
    {
      id: "markers",
      shape: "distanceMarker",
      material: {
        color: "#b9b2a4",
        roughness: 0.7,
        metalness: 0.1,
        envMapIntensity: 0.8,
      },
      placement: {
        mode: "corridor",
        // ~50m apart, alternating verges. Regular enough to count, sparse
        // enough that the return leg still reads as empty.
        stride: 16,
        offset: 2.0,
        radius: 1.0,
        sides: "alternate",
        arc: [0.5, 1.0],
        link: false,
        scale: [1.0, 1.15],
      },
      density: SOLID,
      range: NEAR_RANGE,
      limit: 240,
    },
  ],
};

export const SETPIECES: Record<AnyTrackId, SetpieceDef> = {
  ash_spire: ASH_SPIRE,
  cinder_bowl: CINDER_BOWL,
  foundry_pit: FOUNDRY_PIT,
  rustline: RUSTLINE,
  sable_run: SABLE_RUN,
  dead_mile: DEAD_MILE,
};

export const DEFAULT_SETPIECES = ASH_SPIRE;
