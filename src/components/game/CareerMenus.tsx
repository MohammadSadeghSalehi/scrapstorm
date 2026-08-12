/**
 * Career front end — the board, the brief, the beat, the aftermath.
 *
 * Everything here is a view over data that already exists in src/game/missions.
 * No screen in this file computes availability, cost, payout or unlock state;
 * it asks career.ts. That is the whole reason the board and the ladder cannot
 * drift apart, and why the headless smoke test is able to prove things about
 * what the player can reach without rendering anything.
 *
 * Presentation rule that runs through all four screens: say what a run WANTS
 * before it starts, and what it COST after it ends. A progression system the
 * player has to infer is a progression system they will ignore.
 *
 * ── the Blacklist is the spine, so it is built as a BOARD ──────────────
 *
 * Fifteen names is the game. Rendering them as fifteen equal rows made the
 * ladder read as a settings list: nothing said which one was next, nothing
 * recorded what you had already taken, and the rank numbers — the only thing
 * the whole mode is about — were 12px monospace.
 *
 * The board now has three states with three different weights. The next target
 * is a full-width dossier and the only amber thing on the screen. Names you
 * have taken are desaturated and overprinted. Names you cannot reach yet are
 * dim plates that say exactly what is missing. A rank spine down the left edge
 * shows all fifteen at once with your position on it, so the climb is visible
 * even when only four dossiers fit on screen.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  affordable,
  availableEvents,
  board,
  currentRank,
  duelMission,
  missionCost,
  missionVerdict,
  nextRival,
  TRACK_UNLOCKS,
  type BoardEntry,
  type CareerAward,
  type CareerState,
  type MissionDef,
  type MissionRunSummary,
} from "@/game/missions";
import { CLASS_ORDER, VEHICLE_CLASSES } from "@/game/classes";
import { getTrackDef, type AnyTrackId } from "@/game/track";
import { beat as storyBeat, TRACK_BEATS, type StoryBeat } from "@/game/story";
import type { MetaState } from "@/game/meta";
import type { VehicleClassId } from "@/game/types";
import { ArtBackdrop, Grain, Insignia, Plate, Stamp } from "./UiArt";

/* ── small shared parts ───────────────────────────────────────────────── */

function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "warn" | "danger" | "good";
}) {
  const cls =
    tone === "danger"
      ? "border-[var(--color-ember)]/45 bg-[var(--color-ember)]/12 text-[#f0a292]"
      : tone === "warn"
        ? "border-[var(--color-signal)]/45 bg-[var(--color-signal)]/12 text-[#f6c664]"
        : tone === "good"
          ? "border-[var(--color-verdigris)]/45 bg-[var(--color-verdigris)]/12 text-[#8fc9b5]"
          : "border-border/70 bg-bg/45 text-muted";
  return (
    <span
      className={`rounded-sm border px-1.5 py-0.5 text-[0.56rem] font-semibold uppercase tracking-[0.12em] ${cls}`}
    >
      {children}
    </span>
  );
}

function HeatBars({ heat }: { heat: number }) {
  const bars = Math.round(Math.max(1, Math.min(5, heat)));
  return (
    <span className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`h-3 w-1 rounded-[1px] ${
            i <= bars
              ? bars >= 4
                ? "bg-[var(--color-ember)]"
                : bars >= 3
                  ? "bg-[var(--color-signal)]"
                  : "bg-fg/70"
              : "bg-fg/15"
          }`}
        />
      ))}
    </span>
  );
}

/** One line of what a mission is going to do to you, from its modifiers. */
function missionTags(def: MissionDef): { label: string; tone: "neutral" | "warn" | "danger" }[] {
  const m = def.modifiers;
  const out: { label: string; tone: "neutral" | "warn" | "danger" }[] = [];
  if (m.bountyOnPlayer) out.push({ label: "Bounty on you", tone: "danger" });
  if (m.elimination) out.push({ label: `Cut every ${m.elimination.everySec}s`, tone: "danger" });
  if (!m.weaponsFree) out.push({ label: "Weapons cold", tone: "neutral" });
  if (m.protectSlot !== null) out.push({ label: "Escort", tone: "warn" });
  if (m.catchUp === 0) out.push({ label: "No rubber band", tone: "neutral" });
  if (m.heat >= 0.7) out.push({ label: "Manhunt heat", tone: "danger" });
  else if (m.heat >= 0.4) out.push({ label: "High heat", tone: "warn" });
  return out;
}

/** A rival's face, or their initial cut into a plate. Never an empty square. */
function Mugshot({
  id,
  name,
  color,
  className = "",
  dim = false,
}: {
  id: string;
  name: string;
  color: string;
  className?: string;
  dim?: boolean;
}) {
  return (
    <span
      className={`relative shrink-0 overflow-hidden rounded-sm border border-border/80 bg-bg ${
        dim ? "opacity-45 grayscale" : ""
      } ${className}`}
      style={{ boxShadow: `inset 0 0 0 1px ${color}33` }}
    >
      <Insignia
        name={`rival-${id}`}
        alt={name}
        className="h-full w-full object-cover"
        fallback={
          <span
            aria-hidden
            className="stencil flex h-full w-full items-center justify-center text-[1.4em] text-fg/45"
            style={{ background: `linear-gradient(150deg, ${color}22, transparent 70%)` }}
          >
            {name.slice(0, 2)}
          </span>
        }
      />
    </span>
  );
}

/* ── the board ────────────────────────────────────────────────────────── */

export function CareerBoard({
  career,
  meta,
  onSelect,
  onClose,
  onReset,
}: {
  career: CareerState;
  meta: MetaState;
  onSelect: (missionId: string) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  const [tab, setTab] = useState<"events" | "board">("events");
  const rows = useMemo(() => board(career), [career]);
  const events = useMemo(() => availableEvents(career), [career]);
  const target = nextRival(career);
  const rank = currentRank(career);

  // Events group by circuit so the list reads as a world rather than a queue.
  const byTrack = useMemo(() => {
    const map = new Map<AnyTrackId, MissionDef[]>();
    for (const m of events) {
      const list = map.get(m.trackId) ?? [];
      list.push(m);
      map.set(m.trackId, list);
    }
    return [...map.entries()];
  }, [events]);

  const nextTrack = useMemo(() => {
    const locked = (Object.entries(TRACK_UNLOCKS) as [AnyTrackId, number][])
      .filter(([, need]) => career.markers < need)
      .sort((a, b) => a[1] - b[1])[0];
    return locked ?? null;
  }, [career.markers]);

  // Board rows arrive rank 15 → 1; the wall reads top-down from the champion
  // being the thing at the end, so it is reversed once here rather than at
  // each of the two places that consume it.
  const wall = useMemo(() => [...rows].reverse(), [rows]);

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex flex-col bg-bg/82 backdrop-blur-sm">
      {/* The wall behind the wall. Absent by default — the blurred scrim under
          it is the fallback and is what shipped before. */}
      <ArtBackdrop name="board-wall" opacity={0.35} />
      <Grain opacity={0.14} />

      <div className="relative mx-auto flex h-full w-full max-w-4xl flex-col p-3 sm:p-5">
        {/* Standing. The rank numeral is the largest thing on the screen
            because the rank is the only score this mode keeps. */}
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow eyebrow-signal">The Scrapline · fifteen names</p>
            <h2 className="stencil mt-0.5 flex items-baseline gap-2 text-fg">
              <span className="text-[2.6rem] leading-none sm:text-[3.2rem]">
                {rank > 15 ? "—" : rank}
              </span>
              <span className="text-base text-muted">
                {rank > 15 ? "Unranked" : "of 15"}
              </span>
            </h2>
            {career.titles.length > 0 && (
              <p className="mt-0.5 text-[0.68rem] uppercase tracking-[0.14em] text-[var(--color-signal)]">
                {career.titles[career.titles.length - 1]}
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn-secondary !min-h-9 !px-3 !py-1.5 !text-xs"
            onClick={onClose}
          >
            Back
          </button>
        </div>

        <div className="rule-oxide mt-2.5" />

        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <Meter label="Markers" value={String(career.markers)} />
          <Meter label="Scrap" value={String(meta.scrap)} />
          <span className="flex items-center gap-1.5">
            <span className="eyebrow !text-[0.52rem]">League heat</span>
            <HeatBars heat={career.heat} />
          </span>
          {target && (
            <span className="ml-auto text-[0.65rem] text-muted">
              Next on the line{" "}
              <span className="font-display uppercase tracking-[0.06em] text-fg">
                #{target.rank} {target.name}
              </span>
            </span>
          )}
        </div>

        {/* Tabs as tabs, not as buttons: a hard amber underline on the live one
            and nothing at all on the other. Two pill buttons of equal weight
            never told you which view you were looking at. */}
        <div className="mt-3 flex gap-5 border-b border-border">
          {(["events", "board"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`-mb-px border-b-2 pb-1.5 font-display text-sm font-semibold uppercase tracking-[0.14em] transition-colors ${
                tab === t
                  ? "border-[var(--color-signal)] text-fg"
                  : "border-transparent text-muted hover:text-fg/80"
              }`}
            >
              {t === "events" ? "Events" : "Blacklist"}
            </button>
          ))}
        </div>

        <div key={tab} className="mt-3 min-h-0 flex-1 animate-rise overflow-y-auto pr-1">
          {tab === "events" ? (
            <>
              {byTrack.map(([trackId, list]) => (
                <div key={trackId} className="mb-4">
                  <div className="mb-1.5 flex items-center gap-2">
                    <Insignia
                      name={`circuit-${trackId}`}
                      alt=""
                      className="h-5 w-5 opacity-75"
                      fallback={null}
                    />
                    <p className="eyebrow">{getTrackDef(trackId).name}</p>
                    <span className="rule-oxide flex-1" />
                  </div>
                  <div className="stagger space-y-1">
                    {list.map((m, i) => (
                      <EventRow
                        key={m.id}
                        index={i}
                        def={m}
                        career={career}
                        scrap={meta.scrap}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {nextTrack && (
                <div className="mb-3 border-l-2 border-dashed border-[var(--color-oxide)]/70 py-1 pl-3">
                  <p className="font-display text-[0.85rem] font-semibold uppercase tracking-[0.06em] text-fg/80">
                    {getTrackDef(nextTrack[0]).name} — locked
                  </p>
                  <p className="mt-0.5 text-[0.68rem] text-muted">
                    {TRACK_BEATS[nextTrack[0]] ?? "A road you have not earned yet."}
                  </p>
                  <p className="mt-1 font-mono text-[0.62rem] text-[var(--color-signal)]/85">
                    {nextTrack[1] - career.markers} more markers
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="flex gap-3">
              <RankSpine rows={wall} targetRank={target?.rank ?? null} />
              <div className="stagger min-w-0 flex-1 space-y-2">
                {wall.map((row, i) => (
                  <RivalDossier
                    key={row.rival.id}
                    index={i}
                    row={row}
                    scrap={meta.scrap}
                    isTarget={target?.id === row.rival.id}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className="mt-2 self-start text-[0.58rem] uppercase tracking-[0.16em] text-muted/60 underline-offset-2 hover:text-muted hover:underline"
          onClick={onReset}
        >
          Reset career
        </button>
      </div>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="eyebrow !text-[0.52rem]">{label}</span>
      <span className="stencil text-base tabular-nums text-fg">{value}</span>
    </span>
  );
}

/**
 * The whole ladder at a glance, beside the dossiers that scroll.
 *
 * A scrolling list can only ever show you four names; the climb is fifteen. The
 * spine is the one element that shows the shape of the run — how much is behind
 * you, how much is left — without asking the player to scroll to find out.
 * Hidden below sm, where the horizontal budget belongs to the dossiers.
 */
function RankSpine({
  rows,
  targetRank,
}: {
  rows: BoardEntry[];
  targetRank: number | null;
}) {
  return (
    <div className="sticky top-0 hidden w-8 shrink-0 flex-col items-end gap-1 self-start pt-1 sm:flex">
      {rows.map((row) => {
        const beaten = row.status === "defeated";
        const here = row.rival.rank === targetRank;
        return (
          <div key={row.rival.id} className="flex items-center gap-1.5">
            <span
              className={`stencil text-[0.7rem] tabular-nums ${
                beaten
                  ? "text-[var(--color-verdigris)]/70"
                  : here
                    ? "text-[var(--color-signal)]"
                    : "text-muted/45"
              }`}
            >
              {row.rival.rank}
            </span>
            <span
              className={`h-3 w-[3px] rounded-[1px] ${
                beaten
                  ? "bg-[var(--color-verdigris)]/60"
                  : row.status === "available"
                    ? "bg-[var(--color-signal)]"
                    : "bg-fg/12"
              }`}
            />
          </div>
        );
      })}
    </div>
  );
}

function EventRow({
  def,
  index,
  career,
  scrap,
  onSelect,
}: {
  def: MissionDef;
  index: number;
  career: CareerState;
  scrap: number;
  onSelect: (id: string) => void;
}) {
  const done = career.completed.includes(def.id);
  const best = career.best[def.id];
  const cost = missionCost(def);
  const canPay = affordable(scrap, def);
  return (
    <button
      type="button"
      disabled={!canPay}
      onClick={() => onSelect(def.id)}
      style={{ "--i": index } as CSSProperties}
      className={`tile w-full px-2.5 py-2 ${done ? "opacity-80" : ""}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-display text-[0.95rem] font-semibold uppercase tracking-[0.03em] text-fg">
          {def.name}
          {done && (
            <span className="ml-2 text-[0.58rem] font-normal tracking-[0.12em] text-[var(--color-verdigris)]">
              cleared
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-[0.6rem] text-muted">
          {def.laps} lap{def.laps === 1 ? "" : "s"}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Chip>{def.kind.replace("_", " ")}</Chip>
        {missionTags(def).slice(0, 2).map((t) => (
          <Chip key={t.label} tone={t.tone}>
            {t.label}
          </Chip>
        ))}
        <span className="ml-auto font-mono text-[0.6rem] text-muted">
          +{def.reward.markers}M · +{def.reward.scrap}
          {cost > 0 && (
            <span
              className={
                canPay ? " text-[var(--color-signal)]/85" : " text-[var(--color-ember)]"
              }
            >
              {" "}
              · stake {cost}
            </span>
          )}
        </span>
      </div>
      {best && (
        <p className="mt-0.5 font-mono text-[0.56rem] text-muted/70">
          best P{best.place} · {best.time.toFixed(1)}s
        </p>
      )}
    </button>
  );
}

/**
 * One name on the board.
 *
 * Three weights, and they are the point of the whole screen:
 *  - `isTarget`  the amber dossier. The only one. Bigger portrait, the bio in
 *                full, and the action reads "Call them out" rather than a rank.
 *  - defeated    greyed, overprinted, and still on the wall. Removing beaten
 *                names would erase the progress the board exists to show.
 *  - locked      dim, with the exact requirement rather than the word "locked".
 */
function RivalDossier({
  row,
  index,
  scrap,
  isTarget,
  onSelect,
}: {
  row: BoardEntry;
  index: number;
  scrap: number;
  isTarget: boolean;
  onSelect: (id: string) => void;
}) {
  const r = row.rival;
  const duel = duelMission(r);
  const cost = missionCost(duel);
  const open = row.status === "available" && affordable(scrap, duel);
  const cls = VEHICLE_CLASSES[r.classId];
  const beaten = row.status === "defeated";
  const lit = isTarget && open;

  return (
    <button
      type="button"
      disabled={!open}
      onClick={() => onSelect(duel.id)}
      style={{ "--i": index } as CSSProperties}
      className={`plate relative block w-full overflow-hidden text-left transition-transform ${
        lit ? "plate-primary" : ""
      } ${open ? "hover:-translate-y-[1px]" : ""} ${
        beaten ? "opacity-70" : !open ? "opacity-55" : ""
      } ${lit ? "p-3" : "p-2.5"}`}
    >
      <div className="flex items-start gap-3">
        {/* The rank numeral is set as a plate number, not as a list index. */}
        <span
          className={`stencil shrink-0 tabular-nums leading-none ${
            lit
              ? "text-[3rem] text-[var(--color-signal)]"
              : beaten
                ? "text-[1.9rem] text-[var(--color-verdigris)]/60"
                : "text-[1.9rem] text-fg/35"
          }`}
        >
          {r.rank}
        </span>

        <Mugshot
          id={r.id}
          name={r.name}
          color={cls.color}
          dim={beaten}
          className={lit ? "h-16 w-14" : "h-11 w-10"}
        />

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span
              className={`truncate font-display font-semibold uppercase text-fg ${
                lit ? "text-xl tracking-[0.04em]" : "text-base tracking-[0.03em]"
              }`}
            >
              {r.name}
            </span>
            <span className="truncate text-[0.58rem] uppercase tracking-[0.14em] text-muted">
              {r.crew}
            </span>
            <span className="ml-auto shrink-0">
              {beaten ? (
                <Chip tone="good">Beaten</Chip>
              ) : open ? (
                <Chip tone="warn">{isTarget ? "Next" : "Open"}</Chip>
              ) : (
                <Chip>Locked</Chip>
              )}
            </span>
          </span>

          <p
            className={`mt-0.5 text-[0.68rem] leading-snug text-muted ${
              lit ? "" : "truncate"
            }`}
          >
            {r.bio}
          </p>

          {!beaten && (
            <p className="mt-1 font-mono text-[0.58rem] text-muted/85">
              {row.markersShort > 0 && `${row.markersShort} markers short`}
              {row.markersShort > 0 && row.missing.length > 0 && " · "}
              {row.missing.length > 0 && `run ${row.missing.join(", ")}`}
              {row.status === "available" && cost > 0 && (
                <span className="text-[var(--color-signal)]/85">stake {cost}</span>
              )}
            </p>
          )}

          {lit && (
            <span className="mt-2 inline-flex items-center gap-1.5 font-display text-[0.78rem] font-bold uppercase tracking-[0.14em] text-[var(--color-signal)]">
              Call them out
              <span aria-hidden>→</span>
            </span>
          )}
        </span>
      </div>

      {beaten && (
        <Stamp
          name="stamp-beaten"
          label="Beaten"
          tone="var(--color-verdigris)"
          className="right-4 top-1/2 h-10 w-auto -translate-y-1/2"
        />
      )}
    </button>
  );
}

/* ── the brief ────────────────────────────────────────────────────────── */

/**
 * Sell the stake before the player accepts it.
 *
 * The old brief was a stack of six equally-weighted boxes ending in a button —
 * a form. The run's own words are now the largest thing on it, the objectives
 * are a checklist rather than a bordered card, and the stake and the payout sit
 * together on one ledger rail directly above the action, because "what this
 * costs me if I lose" is the question the button is answering.
 */
export function MissionBrief({
  def,
  career,
  meta,
  classId,
  onClass,
  onStart,
  onBack,
}: {
  def: MissionDef;
  career: CareerState;
  meta: MetaState;
  classId: VehicleClassId;
  onClass: (c: VehicleClassId) => void;
  onStart: () => void;
  onBack: () => void;
}) {
  const cost = missionCost(def);
  const canPay = affordable(meta.scrap, def);
  const heatFloor = Math.min(
    1,
    Math.max(def.modifiers.heat, ((career.heat - 1) / 4) * 0.75),
  );
  const trackDef = getTrackDef(def.trackId);

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-bg/82 p-3 backdrop-blur-sm sm:p-5">
      <ArtBackdrop name={`circuit-wide-${def.trackId}`} opacity={0.3} />
      <Grain opacity={0.13} />

      <Plate primary className="relative w-full max-w-2xl animate-plate p-0">
        <div className="animate-sweep rounded-t-[5px] border-b border-border bg-[linear-gradient(100deg,rgba(143,59,23,0.3),transparent_72%)] px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="eyebrow eyebrow-signal">
                {trackDef.name} · {def.laps} lap{def.laps === 1 ? "" : "s"} ·{" "}
                {def.kind.replace("_", " ")}
              </p>
              <h2 className="stencil mt-0.5 truncate text-3xl text-fg sm:text-4xl">
                {def.name}
              </h2>
            </div>
            <button
              type="button"
              className="btn-secondary !min-h-8 !px-2.5 !py-1 !text-[0.7rem]"
              onClick={onBack}
            >
              Back
            </button>
          </div>
        </div>

        <div className="grid gap-4 p-4 sm:grid-cols-[1.1fr_1fr]">
          {/* ── what you are walking into ────────────────────────────── */}
          <div>
            {/* The brief in the crew's voice, quoted against an oxide rule
                rather than boxed. It is the only prose on the screen and it
                should read as somebody talking. */}
            <div className="border-l-2 border-[var(--color-oxide)] pl-3">
              {def.brief.map((line, i) => (
                <p key={i} className="text-[0.82rem] leading-relaxed text-fg/90">
                  {line}
                </p>
              ))}
            </div>

            <div className="mt-2.5 flex flex-wrap gap-1">
              {missionTags(def).map((t) => (
                <Chip key={t.label} tone={t.tone}>
                  {t.label}
                </Chip>
              ))}
              {heatFloor > def.modifiers.heat + 0.01 && (
                <Chip tone="warn">Your heat raises this</Chip>
              )}
            </div>

            <p className="eyebrow mt-3.5">Objectives</p>
            <ul className="mt-1.5 space-y-1">
              {def.objectives.map((o, i) => (
                <li key={i} className="flex gap-2 text-[0.74rem] leading-snug">
                  <span
                    aria-hidden
                    className={`mt-[0.35em] h-1.5 w-1.5 shrink-0 ${
                      o.optional
                        ? "rotate-45 border border-muted"
                        : "bg-[var(--color-signal)]"
                    }`}
                  />
                  <span className={o.optional ? "text-muted" : "text-fg/90"}>
                    {o.label ?? describeObjective(o)}
                    {o.optional && (
                      <span className="ml-1.5 text-[0.58rem] uppercase tracking-[0.12em] text-muted/80">
                        bonus
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* ── the decision ─────────────────────────────────────────── */}
          <div className="flex flex-col">
            {/* Class choice belongs on the brief, not in a garage two screens
                away: which car to bring IS the decision a brief exists to
                inform. */}
            <p className="eyebrow mb-1.5">Bring</p>
            <div className="grid grid-cols-3 gap-1">
              {CLASS_ORDER.map((id) => {
                const c = VEHICLE_CLASSES[id];
                const on = classId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onClass(id)}
                    aria-pressed={on}
                    className={`tile flex flex-col items-center gap-1 px-1.5 py-2 ${on ? "tile-on" : ""}`}
                  >
                    <Insignia
                      name={`class-${id}`}
                      alt=""
                      className="h-7 w-auto opacity-90"
                      fallback={
                        <span
                          aria-hidden
                          className="block h-1.5 w-7 rounded-full"
                          style={{ background: c.color }}
                        />
                      }
                    />
                    <span className="truncate font-display text-[0.7rem] font-semibold uppercase tracking-[0.04em] text-fg">
                      {c.name}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[0.66rem] leading-snug text-muted">
              {VEHICLE_CLASSES[classId].description}
            </p>

            {/*
              THE LEDGER. Stake and payout on one rail, immediately above the
              button that commits to both. They were previously a single small
              line of grey text under the class picker, which is where a player
              stops reading.
            */}
            <div className="mt-auto pt-3">
              <div className="flex items-stretch justify-between gap-2 border-y border-border py-2">
                <span>
                  <span className="eyebrow !text-[0.52rem]">Pays</span>
                  <span className="stencil block text-lg leading-tight text-fg">
                    +{def.reward.markers}M
                    <span className="ml-1.5 text-[0.8em] text-muted">
                      +{def.reward.scrap}
                    </span>
                  </span>
                </span>
                {cost > 0 && (
                  <span className="text-right">
                    <span className="eyebrow !text-[0.52rem]">Stake</span>
                    <span
                      className={`stencil block text-lg leading-tight ${
                        canPay ? "text-[var(--color-signal)]" : "text-[var(--color-ember)]"
                      }`}
                    >
                      −{cost}
                      <span className="ml-1.5 text-[0.8em] text-muted">
                        of {meta.scrap}
                      </span>
                    </span>
                  </span>
                )}
              </div>

              <button
                type="button"
                className="btn-primary mt-3 w-full"
                disabled={!canPay}
                onClick={onStart}
              >
                {canPay ? "Roll out" : "Not enough scrap"}
              </button>
            </div>
          </div>
        </div>
      </Plate>
    </div>
  );
}

/** Fallback wording for an objective with no authored label. */
function describeObjective(o: MissionDef["objectives"][number]): string {
  switch (o.kind) {
    case "finish_place":
      return o.place === 1 ? "Win the heat" : `Finish P${o.place} or better`;
    case "finish_race":
      return "Cross the line";
    case "takedowns":
      return `Wreck ${o.count} runner${o.count === 1 ? "" : "s"}`;
    case "survive_time":
      return `Survive ${Math.round(o.seconds)}s`;
    case "last_standing":
      return "Be the last car running";
    case "lead_for":
      return `Lead for ${Math.round(o.seconds)}s`;
    case "lap_pace":
      return "Set a lap under the target";
    case "race_pace":
      return "Beat the total time";
    case "wreck_target":
      return `Wreck the marked car${o.count && o.count > 1 ? ` x${o.count}` : ""}`;
    case "beat_rival":
      return "Finish ahead of the rival";
    case "no_wreck":
      return "Do not get wrecked";
    case "hull_above":
      return `Keep hull above ${Math.round(o.pct * 100)}%`;
    case "escort_alive":
      return `Keep the client above ${Math.round(o.minHullPct * 100)}%`;
    case "stay_near":
      return `Stay within ${o.metres}m of the client`;
  }
  /*
   * Fallback, deliberately not an exhaustiveness assert.
   *
   * This switch covers every objective kind that exists today, but the
   * catalogue grows — and the failure mode of a `never` assert here is that
   * adding an objective breaks the BUILD of a screen that only needed to print
   * a slightly worse sentence. A new kind should show up as unpolished copy on
   * the brief, not as a red build, and the objective's own `label` is the
   * primary path anyway; this is only reached when one was not authored.
   */
  return "Complete the objective";
}

/* ── story ────────────────────────────────────────────────────────────── */

export function StoryCard({
  beatId,
  onNext,
  remaining,
}: {
  beatId: string;
  onNext: () => void;
  remaining: number;
}) {
  const b: StoryBeat | undefined = storyBeat(beatId);
  if (!b) {
    // A missing beat must never block the flow. The smoke test asserts every
    // authored id resolves, so this is a safety net rather than a path.
    onNext();
    return null;
  }
  return (
    <div className="pointer-events-auto absolute inset-0 z-[55] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <Grain opacity={0.1} />
      {/* A radio call, not a dialog: the speaker's name is set as a transmission
          header and the body is left-ruled like the brief, so the two screens
          share one voice. */}
      <Plate className="w-full max-w-sm animate-plate p-5">
        {b.voice && (
          <p className="eyebrow eyebrow-signal flex items-center gap-2">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--color-signal)]" />
            {b.voice}
          </p>
        )}
        <h3 className="stencil mt-1.5 text-2xl text-fg">{b.title}</h3>
        <div className="mt-2.5 border-l-2 border-[var(--color-oxide)] pl-3">
          <p className="text-[0.85rem] leading-relaxed text-fg/90">{b.body}</p>
          {b.flavor && (
            <p className="mt-2 text-[0.7rem] italic leading-relaxed text-muted">{b.flavor}</p>
          )}
        </div>
        <button type="button" className="btn-primary mt-4 w-full" onClick={onNext}>
          {remaining > 1 ? `Continue · ${remaining - 1} more` : "Continue"}
        </button>
      </Plate>
    </div>
  );
}

/* ── aftermath ────────────────────────────────────────────────────────── */

/**
 * Land the outcome, then account for it.
 *
 * Won and lost used to differ only in the colour of one heading, so the two
 * most emotionally different moments in the game looked the same. The verdict
 * is now a banner that wipes on and carries a stamp, and the ledger below it is
 * ordered by what the player will look for first: what changed on the board,
 * then what changed in the bank.
 */
export function MissionResults({
  def,
  summary,
  award,
  onRetry,
  onBoard,
}: {
  def: MissionDef;
  summary: MissionRunSummary;
  award: CareerAward;
  onRetry: () => void;
  onBoard: () => void;
}) {
  /*
   * `missionVerdict`, not `outcome === "complete"`, and the third state is the
   * point: a race won on the road with an objective broken is neither a pass
   * nor "Run lost", and calling it the latter over a victory reel is what read
   * as the result screen being wrong. The objective list below still says
   * exactly which clause failed, and the award is unchanged.
   */
  const verdict = missionVerdict(summary);
  const won = verdict === "clear";
  const raceWon = verdict === "race-won";
  return (
    <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-bg/80 p-4 backdrop-blur-sm">
      <Grain opacity={0.13} />
      <Plate
        primary
        className={
          /*
           * overflow-x-hidden, and it is not redundant with overflow-y-auto.
           *
           * Setting only the y axis leaves x at `visible`, and "visible on one
           * axis, scrollable on the other" is not a combination CSS permits —
           * the spec promotes the visible axis to `auto`. So any child a
           * fraction of a pixel wider than the plate grows a full-width
           * horizontal scrollbar along the bottom of the results card, which is
           * the grey bar under RUN IT AGAIN. The overhanging child is the
           * verdict stamp: absolutely positioned, rotated, and deliberately
           * hanging off the right edge.
           *
           * Nothing on this card is meant to scroll sideways, so say so.
           */
          "max-h-[92dvh] w-full max-w-md animate-plate overflow-y-auto overflow-x-hidden p-0"
        }
      >
        <div
          className={`animate-sweep relative overflow-hidden rounded-t-[5px] border-b px-4 py-3.5 ${
            won
              ? "border-[var(--color-verdigris)]/40 bg-[linear-gradient(100deg,rgba(95,163,139,0.22),transparent_70%)]"
              : raceWon
                ? "border-[var(--color-signal)]/40 bg-[linear-gradient(100deg,rgba(242,165,22,0.22),transparent_70%)]"
                : "border-[var(--color-ember)]/40 bg-[linear-gradient(100deg,rgba(226,84,60,0.22),transparent_70%)]"
          }`}
        >
          <p className="eyebrow">{def.name}</p>
          <h2
            className={`stencil mt-0.5 text-[2.4rem] leading-none ${
              won
                ? "text-[var(--color-verdigris)]"
                : raceWon
                  ? "text-[var(--color-signal)]"
                  : "text-[var(--color-ember)]"
            }`}
          >
            {won ? "Objectives clear" : raceWon ? "Won on the road" : "Run lost"}
          </h2>
          {/*
            A race won with the brief unmet keeps the CLEARED stamp off — it was
            not cleared and the purse says so — but it does not get branded LOST
            either. The subline names the trade instead of leaving the player to
            work out why first place is wearing a failure stamp.
          */}
          {raceWon && (
            <p className="mt-1 font-mono text-[0.68rem] text-muted">
              First across the line · the brief went unmet
            </p>
          )}
          {!raceWon && (
            <Stamp
              name={won ? "stamp-cleared" : "stamp-lost"}
              label={won ? "Cleared" : "Lost"}
              tone={won ? "var(--color-verdigris)" : "var(--color-ember)"}
              className="right-4 top-1/2 h-11 w-auto -translate-y-1/2"
            />
          )}
        </div>

        <div className="p-4">
          <ul className="space-y-1">
            {summary.objectives.map((o, i) => (
              <li key={i} className="flex items-baseline justify-between gap-2 text-[0.74rem]">
                <span
                  className={
                    o.status === "met"
                      ? "text-[var(--color-verdigris)]"
                      : o.status === "failed"
                        ? "text-[var(--color-ember)]"
                        : "text-muted"
                  }
                >
                  {o.status === "met" ? "✓" : o.status === "failed" ? "✕" : "–"}{" "}
                  {o.optional ? "◇ " : ""}
                  {o.label}
                </span>
                <span className="shrink-0 font-mono text-[0.65rem] text-muted">{o.detail}</span>
              </li>
            ))}
          </ul>

          <div className="mt-3 grid grid-cols-3 gap-2 border-y border-border py-2.5 text-center">
            <Stat label="Place" value={`P${summary.place}`} />
            <Stat label="Takedowns" value={String(summary.takedowns)} />
            <Stat
              label="Best lap"
              value={summary.bestLap ? `${summary.bestLap.toFixed(2)}s` : "—"}
            />
          </div>

          {/* The board moves first — that is the score. Money second. */}
          {award.rivalDefeated && (
            <div className="mt-3 border-l-2 border-[var(--color-signal)] bg-[var(--color-signal)]/8 py-2 pl-3 pr-2.5">
              <p className="eyebrow eyebrow-signal">
                Rank taken — #{award.rivalDefeated.rank}
              </p>
              <p className="mt-1 text-[0.78rem] leading-snug text-fg/90">
                &ldquo;{award.rivalDefeated.beaten}&rdquo;
              </p>
              <p className="mt-1 text-[0.66rem] text-muted">
                You take {award.rivalDefeated.reward.pinkSlip}.
              </p>
            </div>
          )}

          <div className="mt-3 space-y-1 text-[0.74rem]">
            <Line label="Markers" value={`+${award.markers}`} good={award.markers > 0} />
            <Line label="Scrap" value={`+${award.scrap}`} good={award.scrap > 0} />
            {award.feeLost > 0 && (
              <Line label="Stake lost" value={`−${award.feeLost}`} good={false} />
            )}
            <Line
              label="League heat"
              value={`${award.heatBefore.toFixed(1)} → ${award.heatAfter.toFixed(1)}`}
              good={award.heatAfter >= award.heatBefore}
            />
          </div>

          {award.requalify && (
            <p className="mt-3 border-l-2 border-[var(--color-ember)] py-1 pl-3 text-[0.74rem] text-[#f0a292]">
              They will not take your call again until you have run{" "}
              <span className="font-semibold">{award.requalify}</span>.
            </p>
          )}

          {award.tracksUnlocked.length > 0 && (
            <div className="mt-3 border-l-2 border-[var(--color-verdigris)] py-1 pl-3">
              {award.tracksUnlocked.map((t) => (
                <p key={t} className="text-[0.74rem] text-[#8fc9b5]">
                  <span className="font-display uppercase tracking-[0.06em]">
                    {getTrackDef(t).name}
                  </span>{" "}
                  is open. <span className="text-muted">{TRACK_BEATS[t] ?? ""}</span>
                </p>
              ))}
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button type="button" className="btn-primary flex-1" onClick={onRetry}>
              {won ? "Run it again" : "Retry"}
            </button>
            <button type="button" className="btn-secondary" onClick={onBoard}>
              Board
            </button>
          </div>
        </div>
      </Plate>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="eyebrow !text-[0.52rem]">{label}</p>
      <p className="stencil mt-0.5 text-xl text-fg">{value}</p>
    </div>
  );
}

function Line({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className={`font-mono ${good ? "text-fg" : "text-[var(--color-ember)]"}`}>
        {value}
      </span>
    </div>
  );
}
