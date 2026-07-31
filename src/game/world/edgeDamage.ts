/**
 * Which edge posts have been smashed, shared between the sim and the renderer.
 *
 * Barrier colliders live in `sim.state.props`, but the posts themselves are
 * drawn by CulledEdgePosts from the static EDGE_MARKERS list. Without a shared
 * record, destroying a barrier either left a solid-looking post you drive
 * straight through, or forced the barrier to merely "yield" rather than break.
 *
 * Keyed by rounded world XZ because the collider and its post share a marker
 * position; that avoids threading an index through both systems.
 */
const downed = new Set<string>();
let version = 0;

export function edgeKey(x: number, z: number): string {
  return `${Math.round(x * 2)}|${Math.round(z * 2)}`;
}

export function downEdgeAt(x: number, z: number): void {
  const k = edgeKey(x, z);
  if (!downed.has(k)) {
    downed.add(k);
    version += 1;
  }
}

export function isEdgeDown(key: string): boolean {
  return downed.size > 0 && downed.has(key);
}

export function anyEdgeDown(): boolean {
  return downed.size > 0;
}

/** Bumped on each new casualty so the renderer can skip work when unchanged. */
export function edgeDamageVersion(): number {
  return version;
}

/** Call when a race restarts — posts stand again. */
export function resetEdgeDamage(): void {
  if (downed.size === 0) return;
  downed.clear();
  version += 1;
}
