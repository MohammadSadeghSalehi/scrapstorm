/**
 * Which guard-rail modules and hoardings have been smashed.
 *
 * Same job as world/edgeDamage.ts, and deliberately NOT the same registry.
 *
 * edgeDamage is keyed by rounded world XZ because a barrier collider and the
 * post it stands for share an EDGE_MARKERS position. Roadside furniture has no
 * such shared key, and borrowing that one would be actively wrong: a rail
 * module three metres from a verge post would round onto the post's key and
 * hide it instead. That failure mode is why the Dead Mile distance markers were
 * left unbreakable — it was cheaper to have them do nothing than to have them
 * delete something else.
 *
 * So this is keyed by INDEX into `roadsideLayout()`, which is the one list both
 * the renderer and the sim walk. An index is exact, costs nothing to compare,
 * and cannot alias onto a neighbour.
 *
 * Reset is driven from `rebuildSetpieceColliders()`, which spawnWorldProps
 * calls on every grid build (createState, setTrack, rebuildShowcase,
 * startCountdown) — the same call sites that already call resetEdgeDamage.
 */
const railDown = new Set<number>();
const boardDown = new Set<number>();
const lampDown = new Set<number>();
let version = 0;

export function downRailModule(i: number): void {
  if (railDown.has(i)) return;
  railDown.add(i);
  version += 1;
}

export function downLamp(i: number): void {
  if (lampDown.has(i)) return;
  lampDown.add(i);
  version += 1;
}

export function downBoard(i: number): void {
  if (boardDown.has(i)) return;
  boardDown.add(i);
  version += 1;
}

export function isRailDown(i: number): boolean {
  return railDown.size > 0 && railDown.has(i);
}

export function isBoardDown(i: number): boolean {
  return boardDown.size > 0 && boardDown.has(i);
}

export function isLampDown(i: number): boolean {
  return lampDown.size > 0 && lampDown.has(i);
}

/**
 * Bumped on each new casualty.
 *
 * ScatterLayer skips its repack when nothing about the view has changed, so
 * without a version to watch, a rail smashed while the camera sat still would
 * keep being drawn until the player moved.
 */
export function roadsideDamageVersion(): number {
  return version;
}

/** Call when a grid is built — the rail stands again. */
export function resetRoadsideDamage(): void {
  if (railDown.size === 0 && boardDown.size === 0 && lampDown.size === 0) return;
  railDown.clear();
  boardDown.clear();
  lampDown.clear();
  version += 1;
}
