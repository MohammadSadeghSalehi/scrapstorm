/**
 * The screen the player waits behind while the race is actually built.
 *
 * It has one job beyond looking calm: to report progress that is TRUE. The
 * previous version drew a bar from the index of the step about to start, over
 * five steps of wildly different cost, so it moved in five equal jumps that had
 * no relationship to the time remaining — and then held at 80% for the longest
 * one. A bar that lies is worse than no bar, because the player learns to read
 * a stall as a crash.
 *
 * Everything here comes from `raceGate`: weighted asset progress for the
 * download and decode phase, then real per-stage progress while the mounted
 * world settles and its shaders compile.
 */
import { useEffect, useRef, useState } from "react";
import { getRaceGate, subscribeRaceGate, type RaceGateSnapshot } from "@/game/world/raceGate";

/**
 * How long before we admit this is taking a while.
 *
 * Not a failure state — the asset budget runs to tens of seconds on a cold cache
 * and that is a legitimate, expected wait. It just stops the screen reading as
 * frozen while a large texture pack comes down a six-connection pipe.
 */
const SLOW_AFTER_MS = 9000;

export function RaceLoadingScreen() {
  const [gate, setGate] = useState<RaceGateSnapshot>(() => getRaceGate());
  const [slow, setSlow] = useState(false);
  const opened = useRef(0);

  useEffect(() => subscribeRaceGate(setGate), []);

  useEffect(() => {
    if (!gate.active) {
      setSlow(false);
      opened.current = 0;
      return;
    }
    if (opened.current === 0) opened.current = Date.now();
    const t = window.setTimeout(
      () => setSlow(true),
      Math.max(0, SLOW_AFTER_MS - (Date.now() - opened.current)),
    );
    return () => window.clearTimeout(t);
  }, [gate.active, gate.generation]);

  if (!gate.active) return null;

  const building = gate.phase === "world";

  return (
    <div className="pointer-events-auto absolute inset-0 z-[60] flex items-center justify-center bg-bg/80 backdrop-blur-sm">
      <div className="w-full max-w-xs px-6 text-center">
        <p className="text-[0.65rem] font-medium uppercase tracking-[0.2em] text-muted">
          {building ? "Warming the grid" : "Preparing race"}
        </p>
        <p className="mt-1 font-display text-lg font-semibold text-fg">
          {gate.label}
        </p>
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-amber-500 transition-[width] duration-300"
            style={{ width: `${Math.max(4, gate.pct)}%` }}
          />
        </div>
        <div className="mt-2 flex items-baseline justify-between text-[0.65rem] text-muted">
          <span>
            {building
              ? "Compiling and uploading"
              : slow
                ? "Still downloading — large packs"
                : "Loading up front so the race runs clean"}
          </span>
          <span className="font-mono tabular-nums">{gate.pct}%</span>
        </div>
      </div>
    </div>
  );
}
