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
import { CutsceneLoop } from "./Cutscene";

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

  /*
   * Five steps, abstracted.
   *
   * The label was the raw internal step name, which tells a player nothing and
   * changes whenever the load order is retuned. These are the five things that
   * are actually happening, in order, and the pill row shows WHERE IN THE RUN
   * you are — which is the information a progress bar alone cannot carry.
   */
  const STEPS = ["Surfaces", "Machines", "Terrain", "Dressing", "Warming"];
  const stepIndex = Math.min(
    STEPS.length - 1,
    Math.floor((gate.pct / 100) * STEPS.length),
  );

  return (
    <div className="pointer-events-auto absolute inset-0 z-[60] overflow-hidden">
      {/*
        The clip runs FULL BLEED with no scrim over it.
        It was behind `bg-bg/80 backdrop-blur-sm`, which is the right treatment
        for a panel that has to stay readable over live gameplay and the wrong
        one for a loading screen, where the footage IS the screen. Legibility
        now comes from the readout having its own backing, not from dimming
        everything behind it.
      */}
      <CutsceneLoop id="grid" opacity={1} />

      {/* Just enough gradient in the top-right to seat the readout — a corner
          wash rather than a full-screen mask. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_55%_45%_at_88%_10%,rgba(8,6,5,0.82),transparent_70%)]" />

      <div className="absolute right-6 top-5 w-[19rem] max-w-[calc(100vw-3rem)]">
        <div className="flex items-baseline justify-between">
          <p className="font-display text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-amber-400/90">
            {building ? "Warming the grid" : "Preparing race"}
          </p>
          <span className="font-mono text-sm tabular-nums text-amber-300">
            {gate.pct}%
          </span>
        </div>

        {/* Segmented rather than continuous: a bar that only fills tells you how
            far, and a bar that also lights up in stages tells you what is left. */}
        <div className="mt-2 flex gap-[3px]">
          {STEPS.map((label, i) => (
            <div
              key={label}
              className={`h-[3px] flex-1 overflow-hidden rounded-full ${
                i < stepIndex ? "bg-amber-500" : "bg-white/12"
              }`}
            >
              {i === stepIndex && (
                <div
                  className="h-full rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.9)] transition-[width] duration-300"
                  style={{
                    width: `${Math.max(6, ((gate.pct / 100) * STEPS.length - i) * 100)}%`,
                  }}
                />
              )}
            </div>
          ))}
        </div>

        <div className="mt-2 flex justify-between text-[0.58rem] uppercase tracking-[0.12em]">
          {STEPS.map((label, i) => (
            <span
              key={label}
              className={
                i === stepIndex
                  ? "text-amber-300"
                  : i < stepIndex
                    ? "text-stone-400"
                    : "text-stone-600"
              }
            >
              {label}
            </span>
          ))}
        </div>

        <p className="mt-2 text-right text-[0.62rem] text-stone-400">
          {building
            ? "Compiling and uploading"
            : slow
              ? "Still downloading — large packs"
              : "Loading up front so the race runs clean"}
        </p>
      </div>
    </div>
  );
}
