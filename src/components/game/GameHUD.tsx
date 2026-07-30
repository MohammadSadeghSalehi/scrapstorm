/**
 * In-race HUD — position, lap, speed, combat bars, ability chips, minimap.
 */
import { memo, useMemo } from "react";
import type { MatchPhase, SimState, TrackId, VehicleClassId } from "@/game/types";
import { VEHICLE_CLASSES } from "@/game/classes";
import { HANDLING, RACE } from "@/game/balance";
import { TRACK_SAMPLES, TRACK_DEFS } from "@/game/track";

export type RivalHud = {
  id: string;
  name: string;
  position: number;
  x: number;
  z: number;
  finished: boolean;
  isPlayer: boolean;
  color: string;
};

export type PlayerHud = {
  id: string;
  name: string;
  classId: VehicleClassId;
  position: number;
  lap: number;
  health: number;
  maxHealth: number;
  shield: number;
  speed: number;
  uiAccel: number;
  boostTimer: number;
  weaponCharge: number;
  shieldCharge: number;
  ultimateCharge: number;
  primaryCooldown: number;
  defenseCooldown: number;
  ultimateActive: number;
  defenseActive: number;
  driftMeter: number;
  tireTemp: number;
  tireTempBand: string;
  offroadAmount: number;
  surface: string;
  lockTargetId: string | null;
  nearMissBoost: number;
  invuln: number;
  color: string;
};

export type HudSlice = {
  phase: MatchPhase;
  raceTime: number;
  countdown: number;
  selectedTrack: TrackId;
  events: { message: string; kind: string }[];
  player: PlayerHud | null;
  rivals: RivalHud[];
  fieldSize: number;
};

export function snapshotHud(state: SimState): HudSlice {
  const player = state.vehicles.find((v) => v.isPlayer) ?? null;
  return {
    phase: state.phase,
    raceTime: state.raceTime,
    countdown: state.countdown,
    selectedTrack: state.selectedTrack,
    events: state.events.slice(0, 4).map((e) => ({
      message: e.message,
      kind: e.kind,
    })),
    fieldSize: state.vehicles.length,
    player: player
      ? {
          id: player.id,
          name: player.name,
          classId: player.classId,
          position: player.position,
          lap: player.lap,
          health: player.health,
          maxHealth: player.maxHealth,
          shield: player.shield,
          speed: player.speed,
          uiAccel: player.uiAccel,
          boostTimer: player.boostTimer,
          weaponCharge: player.weaponCharge,
          shieldCharge: player.shieldCharge,
          ultimateCharge: player.ultimateCharge,
          primaryCooldown: player.primaryCooldown,
          defenseCooldown: player.defenseCooldown,
          ultimateActive: player.ultimateActive,
          defenseActive: player.defenseActive,
          driftMeter: player.driftMeter,
          tireTemp: player.tireTemp,
          tireTempBand: player.tireTempBand,
          offroadAmount: player.offroadAmount,
          surface: player.surface,
          lockTargetId: player.lockTargetId,
          nearMissBoost: player.nearMissBoost,
          invuln: player.invuln,
          color: player.color,
        }
      : null,
    rivals: state.vehicles.map((v) => ({
      id: v.id,
      name: v.name,
      position: v.position,
      x: v.x,
      z: v.z,
      finished: v.finished,
      isPlayer: v.isPlayer,
      color: v.color,
    })),
  };
}

function fmtTime(t: number) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const whole = Math.floor(r);
  const frac = Math.floor((r - whole) * 100);
  return `${m}:${whole.toString().padStart(2, "0")}.${frac.toString().padStart(2, "0")}`;
}

function hudSpeed(speed: number) {
  return Math.round(Math.abs(speed) * 4);
}

function gearFromSpeed(speed: number, max: number) {
  const r = Math.min(1, Math.abs(speed) / Math.max(1, max));
  if (r < 0.12) return 1;
  if (r < 0.28) return 2;
  if (r < 0.48) return 3;
  if (r < 0.7) return 4;
  if (r < 0.88) return 5;
  return 6;
}

function tireLabel(band: string, temp: number) {
  const t = Math.round(temp);
  if (band === "cold") return { text: `${t}° · COLD`, bar: "bg-sky-400" };
  if (band === "warm") return { text: `${t}° · WARMING`, bar: "bg-emerald-400/80" };
  if (band === "optimal") return { text: `${t}° · READY`, bar: "bg-emerald-400" };
  if (band === "hot") return { text: `${t}° · HOT`, bar: "bg-amber-400" };
  return { text: `${t}° · CRITICAL`, bar: "bg-rose-500" };
}

function driftLabel(meter: number) {
  if (meter >= HANDLING.driftBoostOrange)
    return { label: "ORANGE", bar: "bg-amber-400" };
  if (meter >= HANDLING.driftBoostThreshold)
    return { label: "READY", bar: "bg-cyan-400" };
  return { label: "…", bar: "bg-fg/50" };
}

function AbilityChip({
  keyHint,
  label,
  ready,
  active,
  cool,
}: {
  keyHint: string;
  label: string;
  ready?: boolean;
  active?: boolean;
  cool?: number;
}) {
  const dim = !ready && !active;
  return (
    <div
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.7rem] backdrop-blur-sm ${
        active
          ? "border-accent/60 bg-accent/15 text-accent"
          : dim
            ? "border-border/60 bg-surface/50 text-muted"
            : "border-border bg-surface/80 text-fg"
      }`}
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-bg font-mono text-[0.65rem]">
        {keyHint}
      </span>
      <span className="font-medium">{label}</span>
      {cool != null && cool > 0.05 && (
        <span className="font-mono text-[0.6rem] text-muted">
          {cool.toFixed(1)}s
        </span>
      )}
    </div>
  );
}

function Minimap({
  trackId,
  rivals,
  player,
}: {
  trackId: TrackId;
  rivals: RivalHud[];
  player: PlayerHud | null;
}) {
  const path = useMemo(() => {
    const samples = TRACK_SAMPLES;
    if (!samples.length) return "";
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const s of samples) {
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.z < minZ) minZ = s.z;
      if (s.z > maxZ) maxZ = s.z;
    }
    const pad = 12;
    const w = Math.max(1, maxX - minX + pad * 2);
    const h = Math.max(1, maxZ - minZ + pad * 2);
    const sx = 100 / w;
    const sy = 100 / h;
    const pts = samples.map((s) => {
      const x = (s.x - minX + pad) * sx;
      const y = (s.z - minZ + pad) * sy;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return {
      d: `M ${pts.join(" L ")} Z`,
      project: (x: number, z: number) => ({
        x: (x - minX + pad) * sx,
        y: (z - minZ + pad) * sy,
      }),
    };
  }, [trackId]);

  if (!path) return null;
  return (
    <div className="h-28 w-28 rounded-xl border border-border/80 bg-surface/85 p-2 shadow-lg backdrop-blur-md sm:h-32 sm:w-32">
      <svg viewBox="0 0 100 100" className="h-full w-full">
        <path
          d={path.d}
          fill="none"
          stroke="rgba(245,245,244,0.35)"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
        {rivals.map((r) => {
          const p = path.project(r.x, r.z);
          return (
            <circle
              key={r.id}
              cx={p.x}
              cy={p.y}
              r={r.isPlayer ? 3.2 : 2.2}
              fill={r.isPlayer ? "#5eead4" : r.color || "#a8a29e"}
              stroke={r.isPlayer ? "#fff" : "transparent"}
              strokeWidth={r.isPlayer ? 0.8 : 0}
            />
          );
        })}
        {player &&
          (() => {
            const pr = rivals.find((r) => r.isPlayer);
            if (!pr) return null;
            const p = path.project(pr.x, pr.z);
            return (
              <circle
                cx={p.x}
                cy={p.y}
                r={4}
                fill="none"
                stroke="#5eead4"
                strokeWidth="0.7"
                opacity="0.7"
              />
            );
          })()}
      </svg>
    </div>
  );
}

function HudInner({
  hud,
  onPause,
}: {
  hud: HudSlice;
  onPause: () => void;
}) {
  if (hud.phase !== "racing" && hud.phase !== "countdown" && hud.phase !== "paused")
    return null;

  const player = hud.player;
  if (!player) return null;
  const def = VEHICLE_CLASSES[player.classId];
  const dmg = 1 - player.health / Math.max(1, player.maxHealth);
  const mph = hudSpeed(player.speed);
  const reverse = player.speed < -0.4;
  const gear = gearFromSpeed(player.speed, def.maxSpeed);
  const tire = tireLabel(player.tireTempBand, player.tireTemp);
  const drift = driftLabel(player.driftMeter);
  const offroad = player.offroadAmount > 0.18;
  const band = player.tireTempBand;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none text-fg">
      {/* Top row */}
      <div className="absolute left-3 right-3 top-3 flex items-start justify-between gap-2 sm:left-4 sm:right-4 sm:top-4">
        <div className="rounded-xl border border-border/80 bg-surface/85 px-3 py-2 backdrop-blur-md">
          <p className="text-[0.6rem] font-medium uppercase tracking-[0.16em] text-muted">
            Position
          </p>
          <p className="font-display text-2xl font-semibold leading-none">
            {player.position}
            <span className="text-base text-muted">/{hud.fieldSize}</span>
          </p>
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <div className="rounded-xl border border-border/80 bg-surface/85 px-4 py-2 text-center backdrop-blur-md">
            <p className="text-[0.6rem] font-medium uppercase tracking-[0.16em] text-muted">
              Lap
            </p>
            <p className="font-display text-2xl font-semibold leading-none">
              {Math.min(RACE.laps, player.lap + 1)}
              <span className="text-base text-muted">/{RACE.laps}</span>
            </p>
          </div>
          {hud.phase === "countdown" && (
            <div className="rounded-full border border-amber-500/40 bg-amber-950/70 px-3 py-1 text-center text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-amber-200 backdrop-blur-sm">
              Grid locked · heat live
            </div>
          )}
          {hud.phase === "racing" && hud.events[0] && (
            <div className="max-w-[14rem] truncate rounded-full border border-border/70 bg-surface/80 px-3 py-1 text-center text-[0.65rem] text-fg/90 backdrop-blur-sm">
              {hud.events[0].message}
            </div>
          )}
        </div>

        <div className="flex items-start gap-2">
          <div className="rounded-xl border border-border/80 bg-surface/85 px-3 py-2 text-right backdrop-blur-md">
            <p className="text-[0.6rem] font-medium uppercase tracking-[0.16em] text-muted">
              Time
            </p>
            <p className="font-mono text-lg font-semibold leading-none tabular-nums">
              {fmtTime(hud.raceTime)}
            </p>
          </div>
          <button
            type="button"
            className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border/80 bg-surface/85 text-sm font-semibold backdrop-blur-md"
            onClick={onPause}
            aria-label="Pause"
          >
            II
          </button>
        </div>
      </div>

      {hud.phase === "countdown" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="font-display text-7xl font-semibold tracking-tight text-fg drop-shadow-lg sm:text-8xl">
            {hud.countdown > 0.2 ? Math.ceil(hud.countdown) : "GO"}
          </div>
        </div>
      )}

      {offroad && hud.phase === "racing" && (
        <div className="absolute left-1/2 top-24 -translate-x-1/2 sm:top-28">
          <div className="rounded-full border border-amber-500/40 bg-amber-950/70 px-4 py-1.5 text-center text-xs font-semibold uppercase tracking-[0.18em] text-amber-200 backdrop-blur-sm">
            Off-road
            <span className="ml-2 font-mono text-[0.65rem] text-amber-200/70">
              −{Math.round(player.offroadAmount * 42)}% pace
            </span>
          </div>
        </div>
      )}

      {band === "critical" && hud.phase === "racing" && (
        <div className="absolute left-1/2 top-32 -translate-x-1/2 sm:left-auto sm:right-4 sm:top-28 sm:translate-x-0">
          <div className="rounded-full border border-rose-500/50 bg-rose-950/75 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-rose-200 backdrop-blur-sm">
            Tire blister — ease the scrub
          </div>
        </div>
      )}

      <div className="absolute right-3 top-20 hidden sm:block sm:right-4 sm:top-24">
        <Minimap
          trackId={hud.selectedTrack}
          rivals={hud.rivals}
          player={player}
        />
      </div>

      {/* Bottom combat panel */}
      <div className="absolute bottom-3 left-3 right-3 sm:bottom-4 sm:left-4 sm:right-auto sm:w-[22rem]">
        <div className="rounded-2xl border border-border/80 bg-surface/90 p-3 shadow-xl backdrop-blur-md">
          <div className="mb-2 flex items-center justify-between text-[0.65rem] uppercase tracking-[0.14em] text-muted">
            <span>Hull</span>
            <span className="font-mono text-fg">
              {Math.round(player.health)}/{Math.round(player.maxHealth)}
            </span>
          </div>
          <div className="bar-track mb-2 h-2">
            <div
              className={`bar-fill ${dmg > 0.55 ? "bg-danger" : "bg-fg"}`}
              style={{
                width: `${Math.max(0, Math.min(100, (player.health / player.maxHealth) * 100))}%`,
              }}
            />
            {player.shield > 0 && (
              <div
                className="bar-fill bg-accent absolute inset-y-0 left-0 opacity-60"
                style={{
                  width: `${Math.min(100, player.shield * 100)}%`,
                }}
              />
            )}
          </div>

          <div className="mb-1 flex items-center justify-between text-[0.65rem] uppercase tracking-[0.14em] text-muted">
            <span className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${tire.bar}`} />
              Tires
            </span>
            <span className="font-mono normal-case tracking-normal text-fg/90">
              {tire.text}
            </span>
          </div>
          <div className="bar-track mb-3 h-1.5">
            <div
              className={`bar-fill ${tire.bar}`}
              style={{
                width: `${Math.min(100, Math.max(8, player.tireTemp))}%`,
              }}
            />
          </div>

          <div className="mb-2 flex flex-wrap gap-1.5 text-[0.65rem] text-muted">
            <span>
              Weapon{" "}
              <span className="font-mono text-fg">
                {Math.round(player.weaponCharge * 100)}%
              </span>
            </span>
            <span className="text-border">·</span>
            <span>
              Drift{" "}
              <span className="font-mono text-fg">{drift.label}</span>
            </span>
            <span className="text-border">·</span>
            <span>
              Shield{" "}
              <span className="font-mono text-fg">
                {Math.round(player.shieldCharge * 100)}%
              </span>
            </span>
            <span className="text-border">·</span>
            <span>
              Ultimate{" "}
              <span className="font-mono text-fg">
                {Math.round(player.ultimateCharge * 100)}%
              </span>
            </span>
          </div>

          <div className="bar-track mb-1 h-1">
            <div
              className="bar-fill bg-fg/70"
              style={{ width: `${player.weaponCharge * 100}%` }}
            />
          </div>
          <div className="bar-track mb-1 h-1">
            <div
              className={`bar-fill ${drift.bar}`}
              style={{
                width: `${Math.min(100, (player.driftMeter / HANDLING.driftBoostMax) * 100)}%`,
              }}
            />
          </div>
          <div className="bar-track mb-1 h-1">
            <div
              className="bar-fill bg-sky-400/80"
              style={{ width: `${player.shieldCharge * 100}%` }}
            />
          </div>
          <div className="bar-track h-1">
            <div
              className="bar-fill bg-accent"
              style={{ width: `${player.ultimateCharge * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* Ability chips */}
      <div className="absolute bottom-3 left-1/2 hidden -translate-x-1/2 gap-2 sm:bottom-4 sm:flex">
        <AbilityChip
          keyHint="E"
          label="Boost"
          ready={player.boostTimer <= 0}
          active={player.boostTimer > 0}
        />
        <AbilityChip
          keyHint="J"
          label={def.primaryLabel}
          ready={player.primaryCooldown <= 0}
          cool={player.primaryCooldown}
        />
        <AbilityChip
          keyHint="K"
          label={def.defenseLabel}
          ready={player.defenseCooldown <= 0}
          active={player.defenseActive > 0}
          cool={player.defenseCooldown}
        />
        <AbilityChip
          keyHint="L"
          label={def.ultimateLabel}
          ready={player.ultimateCharge >= 0.98}
          active={player.ultimateActive > 0}
        />
      </div>

      {/* Speed cluster */}
      <div className="absolute bottom-3 right-3 sm:bottom-4 sm:right-4">
        <div className="flex items-end gap-3 rounded-2xl border border-border/80 bg-surface/90 px-3 py-2.5 backdrop-blur-md">
          <div className="text-center">
            <p className="text-[0.55rem] font-medium uppercase tracking-[0.16em] text-muted">
              Gear
            </p>
            <p className="font-display text-3xl font-semibold leading-none">
              {gear}
            </p>
          </div>
          <div className="h-10 w-px bg-border" />
          <div className="min-w-[4.5rem] text-right">
            <p className="text-[0.55rem] font-medium uppercase tracking-[0.16em] text-muted">
              Speed
            </p>
            <p className="font-display text-3xl font-semibold leading-none tabular-nums">
              {mph}
            </p>
            <p className="text-[0.6rem] text-muted">
              {reverse ? "mph reverse" : "mph"}
            </p>
          </div>
        </div>
        <p className="mt-1 text-right font-mono text-[0.65rem] text-muted">
          ACCEL{" "}
          <span className="text-fg">
            {player.uiAccel >= 0 ? "+" : ""}
            {(player.uiAccel * 0.12).toFixed(2)}g
          </span>
        </p>
      </div>

      {player.boostTimer > 0 && (
        <div className="pointer-events-none absolute inset-0 bg-accent/5" />
      )}
      {player.invuln > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-accent/40" />
      )}
    </div>
  );
}

export const GameHUD = memo(function GameHUD({
  hud,
  onPause,
}: {
  hud: HudSlice;
  onPause: () => void;
}) {
  return <HudInner hud={hud} onPause={onPause} />;
});
