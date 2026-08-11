/**
 * Front end: title, garage, and the quick-heat aftermath.
 *
 * The hierarchy rule for every screen in this file, and the thing that was
 * missing before: ONE plate is primary, ONE control is amber, and everything
 * else is quiet. Previously the garage drew eight bordered boxes of identical
 * weight, so the eye had nowhere to land and "Start race" was no louder than
 * the paint swatches.
 *
 * The second constraint is the looping footage behind these screens at 0.85.
 * Text does not sit on video. Text sits on a plate, and the plate sits on the
 * video — see `.plate` in styles.css.
 */
import type { CSSProperties, ReactNode } from "react";
import { CLASS_ORDER, VEHICLE_CLASSES } from "@/game/classes";
import { WORLD, LORE, briefingFor } from "@/game/story";
import { PAINTS, type MetaState } from "@/game/meta";
import {
  currentRank,
  nextRival,
  TRACK_UNLOCKS,
  type CareerState,
} from "@/game/missions";
import { TRACK_DEFS, type TrackId } from "@/game/track";
import type { SimState, VehicleClassId } from "@/game/types";
import { GhostDuelPanel } from "./GhostDuelPanel";
import { Grain, Insignia, Plate, Stamp } from "./UiArt";

export function MenuOverlay({
  state,
  name,
  meta,
  career,
  onName,
  onClass,
  onTrack,
  onStartGarage,
  onStartRace,
  onCareer,
  onBackMenu,
  onReplay,
  onResume,
  onRestart,
  onSelectPaint,
  onUnlockPaint,
  ghostOn,
  onGhostToggle,
}: {
  state: SimState;
  name: string;
  meta: MetaState;
  career: CareerState;
  onName: (n: string) => void;
  onClass: (c: VehicleClassId) => void;
  onTrack: (t: TrackId) => void;
  onStartGarage: () => void;
  onStartRace: () => void;
  onCareer: () => void;
  onBackMenu: () => void;
  onReplay: () => void;
  onResume: () => void;
  onRestart: () => void;
  onSelectPaint: (paintId: string) => void;
  onUnlockPaint: (paintId: string) => void;
  ghostOn: boolean;
  onGhostToggle: (on: boolean) => void;
}) {
  if (state.phase === "paused") {
    return (
      <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-bg/60 p-4 backdrop-blur-[3px]">
        <Grain opacity={0.1} />
        <Plate primary className="pointer-events-auto w-full max-w-xs animate-plate p-5">
          <p className="eyebrow">Race held</p>
          <h2 className="stencil mt-1 text-3xl text-fg">Paused</h2>
          <div className="mt-4 flex flex-col gap-2">
            <button type="button" className="btn-primary" onClick={onResume}>
              Resume
            </button>
            <button type="button" className="btn-secondary" onClick={onRestart}>
              Restart
            </button>
            <button type="button" className="btn-secondary" onClick={onBackMenu}>
              Main menu
            </button>
          </div>
          <p className="mt-3 text-center font-mono text-[0.62rem] text-muted">Esc / P</p>
        </Plate>
      </div>
    );
  }

  if (state.phase === "racing" || state.phase === "countdown") return null;

  if (state.phase === "finished") {
    return <Results state={state} meta={meta} onReplay={onReplay} onMenu={onBackMenu} />;
  }

  if (state.phase === "garage") {
    return (
      <GaragePanel
        state={state}
        name={name}
        meta={meta}
        career={career}
        onName={onName}
        onClass={onClass}
        onTrack={onTrack}
        onStartRace={onStartRace}
        onBackMenu={onBackMenu}
        onSelectPaint={onSelectPaint}
        onUnlockPaint={onUnlockPaint}
        ghostOn={ghostOn}
        onGhostToggle={onGhostToggle}
      />
    );
  }

  const rank = currentRank(career);
  const target = nextRival(career);

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex flex-col justify-between p-5 sm:p-8">
      <Grain opacity={0.13} />

      {/*
        THE TITLE IS THE HERO, and it is set against the footage rather than on
        a panel — the one place in the game where that is legible, because the
        type is enormous and carries its own shadow. Everything smaller than the
        wordmark gets a backing.
      */}
      <div className="relative max-w-xl animate-rise">
        <div className="flex items-center gap-2.5">
          <Insignia
            name="insignia-league"
            alt=""
            className="h-7 w-7 opacity-90"
            fallback={
              <span
                aria-hidden
                className="inline-block h-4 w-[3px] bg-[var(--color-signal)]"
              />
            }
          />
          <p className="eyebrow eyebrow-signal">
            {WORLD.network} · {WORLD.era}
          </p>
        </div>

        <h1 className="animate-arc stencil mt-2 text-[3.4rem] leading-[0.82] text-fg drop-shadow-[0_6px_28px_rgba(0,0,0,0.85)] sm:text-[5.5rem]">
          <Insignia
            name="wordmark"
            alt={WORLD.league}
            className="h-[3.4rem] w-auto sm:h-[5.5rem]"
            fallback={
              <>
                Scrap<span className="text-[var(--color-signal)]">storm</span>
              </>
            }
          />
        </h1>

        <div className="rule-oxide mt-3 max-w-sm" />

        <p className="mt-2.5 max-w-sm text-sm leading-relaxed text-fg/85 drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)]">
          {WORLD.tagline}
        </p>
        <p className="mt-1.5 max-w-sm text-[0.72rem] leading-relaxed text-muted drop-shadow-[0_2px_10px_rgba(0,0,0,0.9)]">
          {LORE[0].body}
        </p>
      </div>

      <div className="flex items-end justify-between gap-4">
        <div className="pointer-events-auto w-full max-w-[17rem] animate-rise-delay">
          {/*
            Career first and garage second, because the career is the game now.
            The garage remains a one-click quick heat — a free-play race with no
            objectives, no stake and no bearing on the board — and that is worth
            keeping: it is where you learn a circuit before you wager on it.

            The two are no longer twin pills. Career is an amber slab that names
            the specific person standing between you and the next rank; quick
            heat is a rule-and-label underneath it. The size difference IS the
            recommendation.
          */}
          <button
            type="button"
            className="btn-primary w-full flex-col !items-start !gap-0 !py-2.5 text-left"
            onClick={onCareer}
          >
            <span className="text-[1.05rem] leading-tight">
              {target ? "Continue career" : "Start career"}
            </span>
            <span className="font-sans text-[0.62rem] font-semibold uppercase tracking-[0.14em] opacity-75">
              {target ? `Next · #${target.rank} ${target.name}` : "Fifteen names on the Scrapline"}
            </span>
          </button>

          <button
            type="button"
            className="mt-2.5 flex w-full items-center justify-between border-b border-border pb-1.5 text-left font-display text-sm uppercase tracking-[0.1em] text-muted transition-colors hover:text-fg"
            onClick={onStartGarage}
          >
            Quick heat
            <span className="font-sans text-[0.58rem] normal-case tracking-normal text-muted/70">
              free run, any circuit
            </span>
          </button>

          {/* The standing plate is hidden on narrow screens, so the same three
              numbers get a one-line form here rather than disappearing. */}
          <p className="mt-2 font-mono text-[0.65rem] text-muted sm:hidden">
            {meta.scrap} scrap
            {rank <= 15 ? ` · rank ${rank}` : ""}
            {career.markers > 0 ? ` · ${career.markers}M` : ""}
          </p>
        </div>

        {/* Standing, on its own plate. Small, factual, bottom-right — the
            counterweight that keeps the layout from being a single left column. */}
        <Plate className="pointer-events-none hidden animate-rise-delay px-3.5 py-2.5 sm:block">
          <div className="flex items-stretch gap-3.5 text-right">
            <Readout label="Rank" value={rank > 15 ? "—" : String(rank)} />
            <span className="w-px self-stretch bg-border" />
            <Readout label="Markers" value={String(career.markers)} />
            <span className="w-px self-stretch bg-border" />
            <Readout label="Scrap" value={String(meta.scrap)} />
          </div>
          <p className="mt-1.5 text-right text-[0.58rem] uppercase tracking-[0.14em] text-muted/80">
            {WORLD.circuit}
          </p>
        </Plate>
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="eyebrow !text-[0.52rem]">{label}</p>
      <p className="stencil mt-0.5 text-xl tabular-nums text-fg">{value}</p>
    </div>
  );
}

function GaragePanel({
  state,
  name,
  meta,
  career,
  onName,
  onClass,
  onTrack,
  onStartRace,
  onBackMenu,
  onSelectPaint,
  onUnlockPaint,
  ghostOn,
  onGhostToggle,
}: {
  state: SimState;
  name: string;
  meta: MetaState;
  career: CareerState;
  onName: (n: string) => void;
  onClass: (c: VehicleClassId) => void;
  onTrack: (t: TrackId) => void;
  onStartRace: () => void;
  onBackMenu: () => void;
  onSelectPaint: (paintId: string) => void;
  onUnlockPaint: (paintId: string) => void;
  ghostOn: boolean;
  onGhostToggle: (on: boolean) => void;
}) {
  const activeId = state.selectedClass;
  const c = VEHICLE_CLASSES[activeId];
  const selectedPaint = meta.selectedPaint[activeId] ?? "stock";
  const trackId = state.selectedTrack ?? "ash_spire";
  const track = TRACK_DEFS.find((t) => t.id === trackId) ?? TRACK_DEFS[0]!;

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex flex-col justify-end p-3 sm:p-4">
      <Grain opacity={0.12} />

      <div className="pointer-events-none absolute left-3 right-3 top-3 flex items-center justify-between sm:left-4 sm:right-4 sm:top-4">
        <div className="hud-panel flex items-center gap-3 px-3 py-1.5">
          <Readout label="Scrap" value={String(meta.scrap)} />
          <span className="h-6 w-px bg-border" />
          <Readout label="Record" value={`${meta.wins}W·${meta.races}H`} />
        </div>
        <button
          type="button"
          className="pointer-events-auto btn-secondary !min-h-9 !px-3 !py-1.5 !text-xs"
          onClick={onBackMenu}
        >
          Back
        </button>
      </div>

      {/*
        TWO COLUMNS FROM sm UP.
        One tall column meant "Start race" sat below the fold of its own panel
        on short windows, under a paint row and a details disclosure. The split
        is by question: the left column is WHAT YOU DRIVE AND WHERE, the right
        is HOW IT LOOKS AND WHAT YOU ARE WALKING INTO. The action lives at the
        bottom of the right column, always visible.
      */}
      <Plate
        primary
        className="pointer-events-auto mx-auto w-full max-w-3xl animate-plate p-3 sm:p-4"
      >
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow eyebrow-signal">Garage · {track.name}</p>
            <h2 className="stencil mt-0.5 truncate text-2xl text-fg sm:text-3xl">
              {c.name}
            </h2>
            <p className="text-[0.7rem] text-muted">{c.tagline}</p>
          </div>
          <label className="shrink-0 text-right">
            <span className="eyebrow !text-[0.52rem]">Callsign</span>
            <input
              className="mt-0.5 block w-28 rounded-sm border border-border bg-bg/70 px-2 py-1 text-right font-display text-sm uppercase tracking-[0.08em] text-fg outline-none focus:border-[var(--color-signal)] sm:w-36"
              value={name}
              maxLength={16}
              onChange={(e) => onName(e.target.value)}
              placeholder="Runner"
              aria-label="Callsign"
            />
          </label>
        </div>

        <div className="rule-oxide mt-2.5" />

        <div className="mt-3 grid gap-3 sm:grid-cols-[1.15fr_1fr]">
          {/* ── left: the machine and the road ───────────────────────── */}
          <div>
            <p className="eyebrow mb-1.5">Circuit</p>
            {/*
              FREE PLAY REACHES EVERY CIRCUIT; the career still gates the ladder.

              Gating the quick heat too was a defensible call — unlocking roads
              is the ladder's only pacing device — but it had a consequence
              nobody weighed: four of the six circuits, and therefore four of
              the six ENVIRONMENTS, were unreachable without grinding the board.
              A furnace pit at night and a dust-storm gauntlet that a player
              cannot get to are not content.
            */}
            <div className="grid grid-cols-2 gap-1 stagger">
              {TRACK_DEFS.map((tr, i) => {
                const on = trackId === tr.id;
                // Career screens still consult trackUnlocked(career, tr.id).
                const open = true;
                return (
                  <button
                    key={tr.id}
                    type="button"
                    disabled={!open}
                    onClick={() => onTrack(tr.id)}
                    style={{ "--i": i } as CSSProperties}
                    className={`tile flex items-center gap-2 px-2 py-1.5 ${on ? "tile-on" : ""}`}
                  >
                    <Insignia
                      name={`circuit-${tr.id}`}
                      alt=""
                      className="h-6 w-6 shrink-0 opacity-80"
                      fallback={
                        <span
                          aria-hidden
                          className="stencil h-6 w-6 shrink-0 rounded-sm border border-border/70 text-center text-[0.7rem] leading-6 text-muted"
                        >
                          {tr.name.slice(0, 2)}
                        </span>
                      }
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-display text-[0.85rem] font-semibold uppercase tracking-[0.03em] text-fg">
                        {tr.name}
                      </span>
                      <span className="block truncate text-[0.58rem] text-muted">
                        {open
                          ? tr.tagline
                          : `Locked · ${TRACK_UNLOCKS[tr.id] - career.markers} markers`}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="eyebrow mb-1.5 mt-3">Class</p>
            <div className="grid grid-cols-3 gap-1">
              {CLASS_ORDER.map((id) => {
                const cls = VEHICLE_CLASSES[id];
                const on = activeId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onClass(id)}
                    className={`tile flex flex-col items-center gap-1 px-2 py-2 ${on ? "tile-on" : ""}`}
                  >
                    <Insignia
                      name={`class-${id}`}
                      alt=""
                      className="h-8 w-auto opacity-90"
                      fallback={
                        <span
                          aria-hidden
                          className="block h-1.5 w-8 rounded-full"
                          style={{ background: cls.color }}
                        />
                      }
                    />
                    <span className="font-display text-[0.78rem] font-semibold uppercase tracking-[0.04em] text-fg">
                      {cls.name}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-2.5 grid grid-cols-6 gap-1.5">
              <StatBar label="Spd" value={c.maxSpeed / 65} />
              <StatBar label="Acc" value={c.accel / 62} />
              <StatBar label="Trn" value={c.turnRate / 3.5} />
              <StatBar label="Hull" value={c.health / 160} />
              <StatBar label="Grip" value={c.grip} />
              <StatBar label="Sand" value={1 - c.offroadPenalty / 1.4} />
            </div>

            <div className="mt-2 flex flex-wrap gap-1 text-[0.58rem] text-muted">
              <Tag>{c.primaryLabel}</Tag>
              <Tag>{c.defenseLabel}</Tag>
              <Tag>{c.ultimateLabel}</Tag>
            </div>
          </div>

          {/* ── right: finish, options, and the decision ─────────────── */}
          <div className="flex flex-col">
            <p className="eyebrow mb-1.5">Paint</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {PAINTS.map((p) => {
                const unlocked = meta.unlockedPaints.includes(p.id) || p.cost === 0;
                const selected = selectedPaint === p.id;
                const swatch = p.id === "stock" ? c.color : p.hex;
                return (
                  <button
                    key={p.id}
                    type="button"
                    title={unlocked ? p.name : `${p.name} · ${p.cost} scrap`}
                    onClick={() => {
                      if (unlocked) onSelectPaint(p.id);
                      else onUnlockPaint(p.id);
                    }}
                    className={`h-7 w-7 shrink-0 rounded-sm border transition-transform ${
                      selected
                        ? "scale-110 border-[var(--color-signal)] shadow-[0_0_0_1px_rgba(242,165,22,0.35)]"
                        : "border-border"
                    } ${!unlocked ? "opacity-45" : ""}`}
                    style={{ background: swatch }}
                    aria-label={p.name}
                    aria-pressed={selected}
                  />
                );
              })}
            </div>

            <label className="mt-2.5 flex cursor-pointer items-center justify-between rounded-sm border border-border/70 bg-bg/40 px-2.5 py-2">
              <span className="text-[0.7rem] text-fg/90">
                Replay ghost
                <span className="ml-1.5 text-[0.58rem] text-muted">
                  translucent car of your best lap
                </span>
              </span>
              <input
                type="checkbox"
                checked={ghostOn}
                onChange={(e) => onGhostToggle(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-signal)]"
              />
            </label>

            <details className="mt-1.5 rounded-sm border border-border/70 bg-bg/40">
              <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-muted">
                Ghost duel
              </summary>
              <div className="px-2 pb-2">
                <GhostDuelPanel trackId={trackId} name={name} />
              </div>
            </details>

            {/* The brief is what makes this a decision rather than a form. It
                gets the oxide left rule so it reads as quoted, not as another
                boxed control. */}
            <div className="mt-2.5 border-l-2 border-[var(--color-oxide)] pl-2.5">
              <p className="eyebrow">Race brief</p>
              <p className="mt-1 text-[0.74rem] leading-snug text-fg/90">
                {briefingFor(state.selectedTrack)[0]}
              </p>
              <p className="mt-1 text-[0.66rem] leading-snug text-muted">
                {VEHICLE_CLASSES[state.selectedClass].description}
              </p>
            </div>

            <div className="mt-auto pt-3">
              <button type="button" className="btn-primary w-full" onClick={onStartRace}>
                Start race
              </button>
              <p className="mt-1.5 text-center font-mono text-[0.58rem] leading-relaxed text-muted">
                {/* Read off input.ts, not off memory: W is throttle and BOOST
                    is E/R. This line said "W boost" and sent players hunting
                    for a nitro that was never on that key. */}
                A/D steer · W gas · E boost · Shift+steer drift · J fire · K def · L ult
              </p>
            </div>
          </div>
        </div>
      </Plate>
    </div>
  );
}

function StatBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0.08, Math.min(1, value)) * 100;
  return (
    <div>
      <div className="mb-0.5 text-[0.52rem] uppercase tracking-[0.1em] text-muted">
        {label}
      </div>
      <div className="bar-track h-1">
        <div className="bar-fill bg-fg/70" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Results({
  state,
  meta,
  onReplay,
  onMenu,
}: {
  state: SimState;
  meta: MetaState;
  onReplay: () => void;
  onMenu: () => void;
}) {
  const ordered = [...state.vehicles].sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.raceProgress - a.raceProgress;
  });
  const player = state.vehicles.find((v) => v.isPlayer);
  const playerPlace = player ? ordered.findIndex((v) => v.id === player.id) + 1 : 0;
  const earned = state.scrapEarned;
  const won = playerPlace === 1;

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-bg/60 p-4 backdrop-blur-[3px]">
      <Grain opacity={0.12} />
      <Plate primary className="pointer-events-auto w-full max-w-md animate-plate p-0">
        {/*
          THE OUTCOME IS A BANNER, NOT A LINE OF TEXT.
          It was an eyebrow and a heading in the same weight as every other
          panel head in the game, so winning and coming eighth looked identical
          until you read them. The place number is now the largest thing on the
          screen and it wipes on.
        */}
        <div
          className={`animate-sweep relative overflow-hidden rounded-t-[5px] border-b px-4 py-3 ${
            won
              ? "border-[var(--color-signal)]/40 bg-[linear-gradient(100deg,rgba(242,165,22,0.22),transparent_70%)]"
              : "border-[var(--color-oxide)]/50 bg-[linear-gradient(100deg,rgba(143,59,23,0.28),transparent_70%)]"
          }`}
        >
          <p className="eyebrow">Heat complete</p>
          <div className="flex items-baseline gap-3">
            <span
              className={`stencil text-[3.2rem] leading-none ${
                won ? "text-[var(--color-signal)]" : "text-fg"
              }`}
            >
              {won ? "P1" : `P${playerPlace}`}
            </span>
            <span className="stencil text-lg text-fg/70">
              {won ? "Took the flag" : "Out of the money"}
            </span>
          </div>
          {earned > 0 && (
            <p className="mt-0.5 font-mono text-[0.7rem] text-muted">
              +{earned} scrap · {meta.scrap} held
            </p>
          )}
          {won && (
            <Stamp
              name="stamp-cleared"
              label="Cleared"
              tone="var(--color-signal)"
              className="right-4 top-4 h-12 w-auto"
            />
          )}
        </div>

        <div className="p-4">
          {(state.ghostSaved || state.ghostBeaten) && (
            <p className="mb-2 text-[0.7rem] text-[var(--color-verdigris)]">
              {state.ghostSaved ? "New personal-best ghost" : "Ghost beaten"}
            </p>
          )}
          <ol className="stagger space-y-1">
            {ordered.map((v, i) => (
              <li
                key={v.id}
                style={{ "--i": i } as CSSProperties}
                className={`flex items-center justify-between border-l-2 px-2.5 py-1 text-sm ${
                  v.isPlayer
                    ? "border-[var(--color-signal)] bg-bg-subtle"
                    : "border-transparent bg-bg/30"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="stencil w-6 text-right text-[0.85rem] tabular-nums text-muted">
                    {i + 1}
                  </span>
                  <span
                    className="inline-block h-3 w-[3px] rounded-[1px]"
                    style={{ background: v.color }}
                  />
                  <span className={v.isPlayer ? "font-semibold text-fg" : "text-fg/85"}>
                    {v.name}
                  </span>
                </span>
                <span className="font-mono text-xs tabular-nums text-muted">
                  {v.finished ? fmt(v.finishTime) : "DNF"}
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex gap-2">
            <button type="button" className="btn-primary flex-1" onClick={onReplay}>
              Race again
            </button>
            <button type="button" className="btn-secondary" onClick={onMenu}>
              Menu
            </button>
          </div>
        </div>
      </Plate>
    </div>
  );
}

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm border border-border/70 bg-bg/40 px-1.5 py-0.5 uppercase tracking-[0.08em]">
      {children}
    </span>
  );
}
