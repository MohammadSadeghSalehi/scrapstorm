/**
 * Draw-call / instance accounting for the world-density pass.
 *
 * Published to `window` for the same reason `__roadRibbon` and `__terrainCull`
 * are: every performance claim in this project so far has been inferred from
 * source rather than measured, and a scatter field is exactly the kind of
 * change that is cheap in theory and expensive in practice. This makes the
 * budget checkable from the console without a profiler.
 */

declare global {
  interface Window {
    __worldDensity?: Record<
      string,
      { draws: number; instances: number; tris: number }
    >;
  }
}

export function reportDensity(
  id: string,
  draws: number,
  instances: number,
  tris: number,
) {
  if (typeof window === "undefined") return;
  const store = (window.__worldDensity ??= {});
  store[id] = { draws, instances, tris };
}

/** Triangles in a geometry, indexed or not. */
export function triCount(geo: { index: { count: number } | null; attributes: { position?: { count: number } } }): number {
  const idx = geo.index;
  if (idx) return idx.count / 3;
  return (geo.attributes.position?.count ?? 0) / 3;
}
