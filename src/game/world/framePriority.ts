/**
 * R3F useFrame priority bands.
 * Lower number runs first (R3F sorts ascending).
 *
 * Pipeline:
 *   SIM (-10) → pose vehicles/camera (0) → late FX / cull stats (5+)
 *
 * Why this matters: if meshes pose BEFORE the fixed-step sim, the car trails
 * the camera by a full catch-up window (multi-step debt) — the "camera moves,
 * car frozen" class of bugs.
 */
export const FRAME = {
  /** Fixed-timestep sim, input sample, audio edges */
  SIM: -10,
  /** Trails/skids that sample previous pose */
  PRE_POSE: -2,
  /** Vehicle meshes, chase camera, garage orbit */
  POSE: 0,
  /** Particles, post-FX flags, debug publishers */
  LATE: 5,
  /** Cull stats / non-critical telemetry */
  TELEMETRY: 10,
} as const;

export type FramePriority = (typeof FRAME)[keyof typeof FRAME];
