/**
 * Per-circuit built structure.
 *
 * One `ScatterLayer` per family, which is one InstancedMesh and one draw call
 * each, culled per instance by distance and then frustum with the survivors
 * packed to the front of the buffer. That machinery is shared verbatim with the
 * desert scatter and the guard rail rather than reimplemented — a second cull
 * loop with its own subtly different throttling is how a frame budget goes
 * missing without anyone being able to say where.
 *
 * Rebuilt only on a track change. Deliberately NOT keyed on quality tier: the
 * instance lists are tier-independent by construction (a tier draws a shorter
 * prefix and a nearer range), and rebuilding placement mid-race would put a
 * multi-millisecond stall exactly where it is least affordable.
 */
import { useEffect, useMemo } from "react";
import { getTrackEpoch } from "../../track";
import { ScatterLayer } from "../scatter/ScatterLayer";
import { buildSetpieceLayers } from "./build";

export function Setpieces() {
  const epoch = getTrackEpoch();
  // Placement is derived from TRACK_SAMPLES, which is swapped wholesale on a
  // track change; the epoch is the only signal that happened.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const built = useMemo(() => buildSetpieceLayers(), [epoch]);

  useEffect(() => built.dispose, [built]);

  return (
    <group>
      {built.layers.map((l, i) => (
        <ScatterLayer
          key={l.id}
          data={l.data}
          density={l.family.density}
          range={l.family.range}
          // Phase-offset per family so no single frame repacks every layer on
          // the circuit. Offset past the three scatter fields and the two
          // furniture layers, which take phases 0-2 and 0-1.
          phase={i + 2}
        />
      ))}
    </group>
  );
}
