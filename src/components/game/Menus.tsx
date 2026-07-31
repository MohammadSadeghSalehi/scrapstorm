import type { ReactNode } from "react";
import { CLASS_ORDER, VEHICLE_CLASSES } from "@/game/classes";
import { WORLD, LORE, briefingFor } from "@/game/story";
import { PAINTS, type MetaState } from "@/game/meta";
import { TRACK_DEFS, type TrackId } from "@/game/track";
import type { SimState, VehicleClassId } from "@/game/types";
import { GhostDuelPanel } from "./GhostDuelPanel";

export function MenuOverlay({
  state,
  name,
  meta,
  onName,
  onClass,
  onTrack,
  onStartGarage,
  onStartRace,
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
  onName: (n: string) => void;
  onClass: (c: VehicleClassId) => void;
  onTrack: (t: TrackId) => void;
  onStartGarage: () => void;
  onStartRace: () => void;
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
      <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-bg/55 p-4 backdrop-blur-[2px]">
        <div className="pointer-events-auto panel-shell w-full max-w-xs animate-rise">
          <p className="text-[0.65rem] font-medium uppercase tracking-[0.16em] text-muted">
            Paused
          </p>
          <h2 className="mt-1 font-display text-xl font-semibold text-fg">Race frozen</h2>
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
          <p className="mt-3 text-center text-[0.65rem] text-muted">Esc / P</p>
        </div>
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

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex flex-col justify-between p-5 sm:p-8">
      <div className="max-w-md animate-rise">
        <p className="text-[0.65rem] font-medium uppercase tracking-[0.2em] text-muted">
          Combat racing
        </p>
        <h1 className="mt-1.5 font-display text-4xl font-semibold tracking-tight text-fg sm:text-5xl">
          Scrapstorm
        </h1>
        <p className="mt-1 text-[0.65rem] font-medium uppercase tracking-[0.18em] text-accent">
          {WORLD.circuit}
        </p>
        <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted">
          {WORLD.tagline} Three classes. Outlaw heats. Live scrap.
        </p>
        <p className="mt-2 max-w-xs text-[0.7rem] leading-relaxed text-muted/90">
          {LORE[0].body}
        </p>
      </div>

      <div className="pointer-events-auto w-full max-w-[16rem] animate-rise sm:max-w-xs">
        <button type="button" className="btn-primary w-full" onClick={onStartGarage}>
          Enter garage
        </button>
        <p className="mt-2.5 text-center text-[0.7rem] text-muted">
          {meta.scrap} scrap
          {meta.wins > 0 ? ` · ${meta.wins}W` : ""}
        </p>
      </div>
    </div>
  );
}

function GaragePanel({
  state,
  name,
  meta,
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

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex flex-col justify-end p-3 sm:p-4">
      <div className="pointer-events-none absolute left-3 top-3 right-3 flex items-center justify-between sm:left-4 sm:top-4 sm:right-4">
        <div className="hud-panel flex items-center gap-2.5 px-2.5 py-1.5">
          <div>
            <p className="text-[0.55rem] uppercase tracking-[0.12em] text-muted">Scrap</p>
            <p className="font-mono text-sm tabular-nums leading-none text-fg">{meta.scrap}</p>
          </div>
          <div className="h-5 w-px bg-border" />
          <div>
            <p className="text-[0.55rem] uppercase tracking-[0.12em] text-muted">Record</p>
            <p className="font-mono text-sm tabular-nums leading-none text-fg">
              {meta.wins}W · {meta.races}H
            </p>
          </div>
        </div>
        <button
          type="button"
          className="pointer-events-auto btn-secondary !min-h-9 !px-3 !py-1.5 !text-sm"
          onClick={onBackMenu}
        >
          Back
        </button>
      </div>

      <div className="pointer-events-auto mx-auto w-full max-w-lg animate-rise">
        <div className="panel-shell !p-3 sm:!p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[0.6rem] font-medium uppercase tracking-[0.14em] text-muted">
                Garage
              </p>
              <h2 className="truncate font-display text-lg font-semibold text-fg sm:text-xl">
                {c.name}
                <span className="ml-2 text-sm font-normal text-muted">{c.tagline}</span>
              </h2>
            </div>
            <input
              className="w-24 shrink-0 rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-fg outline-none ring-fg/15 focus:ring-2 sm:w-32"
              value={name}
              maxLength={16}
              onChange={(e) => onName(e.target.value)}
              placeholder="Name"
              aria-label="Callsign"
            />
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-1.5">
            {TRACK_DEFS.map((tr) => {
              const on = trackId === tr.id;
              return (
                <button
                  key={tr.id}
                  type="button"
                  onClick={() => onTrack(tr.id)}
                  className={`rounded-lg border px-2 py-1.5 text-left transition-colors ${
                    on
                      ? "border-fg/25 bg-bg-subtle"
                      : "border-border/80 bg-bg/30 hover:bg-bg-subtle/60"
                  }`}
                >
                  <span className="block text-sm font-semibold text-fg">{tr.name}</span>
                  <span className="block text-[0.6rem] text-muted">{tr.tagline}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-2.5 grid grid-cols-3 gap-1.5">
            {CLASS_ORDER.map((id) => {
              const cls = VEHICLE_CLASSES[id];
              const on = activeId === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onClass(id)}
                  className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                    on
                      ? "border-fg/25 bg-bg-subtle"
                      : "border-border/80 bg-bg/30 hover:bg-bg-subtle/60"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: cls.color }}
                    />
                    <span className="text-sm font-semibold text-fg">{cls.name}</span>
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

          <div className="mt-2 flex flex-wrap gap-1 text-[0.6rem] text-muted">
            <Tag>{c.primaryLabel}</Tag>
            <Tag>{c.defenseLabel}</Tag>
            <Tag>{c.ultimateLabel}</Tag>
          </div>

          <div className="mt-2.5 flex items-center gap-1.5">
            <span className="mr-0.5 text-[0.6rem] uppercase tracking-wider text-muted">Paint</span>
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
                  className={`h-7 w-7 shrink-0 rounded-full border-2 transition-transform ${
                    selected ? "scale-110 border-fg" : "border-border"
                  } ${!unlocked ? "opacity-50" : ""}`}
                  style={{ background: swatch }}
                  aria-label={p.name}
                />
              );
            })}
          </div>

          <label className="mt-2.5 flex cursor-pointer items-center justify-between rounded-lg border border-border/70 bg-bg/25 px-2.5 py-2">
            <span className="text-[0.7rem] text-fg/90">
              Replay ghost
              <span className="ml-1.5 text-[0.6rem] text-muted">
                translucent car of your best lap
              </span>
            </span>
            <input
              type="checkbox"
              checked={ghostOn}
              onChange={(e) => onGhostToggle(e.target.checked)}
              className="h-4 w-4 accent-amber-500"
            />
          </label>

          <details className="mt-2.5 rounded-lg border border-border/70 bg-bg/25">
            <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[0.65rem] font-medium uppercase tracking-wider text-muted">
              Ghost duel
            </summary>
            <div className="px-2 pb-2">
              <GhostDuelPanel trackId={trackId} name={name} />
            </div>
          </details>

          <div className="mt-3 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-left">
            <p className="text-[0.6rem] font-medium uppercase tracking-[0.16em] text-muted">
              Race brief
            </p>
            <p className="mt-1 text-[0.72rem] leading-snug text-fg/90">
              {briefingFor(state.selectedTrack)[0]}
            </p>
            <p className="mt-0.5 text-[0.68rem] leading-snug text-muted">
              {VEHICLE_CLASSES[state.selectedClass].description}
            </p>
          </div>
          <button type="button" className="btn-primary mt-3 w-full" onClick={onStartRace}>
            Start race
          </button>
          <p className="mt-1.5 text-center text-[0.6rem] leading-relaxed text-muted">
            A/D steer · W boost · Shift+steer drift · J fire · K def · L ult
          </p>
        </div>
      </div>
    </div>
  );
}

function StatBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0.08, Math.min(1, value)) * 100;
  return (
    <div>
      <div className="mb-0.5 text-[0.55rem] text-muted">{label}</div>
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

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-bg/50 p-4 backdrop-blur-[2px]">
      <div className="pointer-events-auto panel-shell w-full max-w-sm animate-rise">
        <p className="text-[0.65rem] font-medium uppercase tracking-[0.16em] text-muted">
          Heat complete
        </p>
        <h2 className="mt-1 font-display text-2xl font-semibold text-fg">
          {playerPlace === 1 ? "Podium" : `P${playerPlace}`}
        </h2>
        {earned > 0 && (
          <p className="mt-1 text-sm text-muted">
            +{earned} scrap · {meta.scrap} total
          </p>
        )}
        {(state.ghostSaved || state.ghostBeaten) && (
          <p className="mt-1 text-xs text-emerald-300/90">
            {state.ghostSaved ? "New personal-best ghost" : "Ghost beaten"}
          </p>
        )}
        <ol className="mt-3 space-y-1.5">
          {ordered.map((v, i) => (
            <li
              key={v.id}
              className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-sm ${
                v.isPlayer ? "border-fg/20 bg-bg-subtle" : "border-border/50 bg-bg/25"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted">P{i + 1}</span>
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: v.color }}
                />
                <span className={v.isPlayer ? "font-semibold text-fg" : "text-fg"}>{v.name}</span>
              </span>
              <span className="font-mono text-xs text-muted">
                {v.finished ? fmt(v.finishTime) : "DNF"}
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <button type="button" className="btn-primary flex-1" onClick={onReplay}>
            Race again
          </button>
          <button type="button" className="btn-secondary" onClick={onMenu}>
            Menu
          </button>
        </div>
      </div>
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
    <span className="rounded border border-border/70 bg-bg/40 px-1.5 py-0.5">{children}</span>
  );
}
