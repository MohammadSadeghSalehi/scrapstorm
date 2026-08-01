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
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  affordable,
  availableEvents,
  board,
  currentRank,
  duelMission,
  missionCost,
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
      ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
        : tone === "good"
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          : "border-border/70 bg-bg/40 text-muted";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[0.58rem] uppercase tracking-[0.1em] ${cls}`}
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
                ? "bg-rose-400"
                : bars >= 3
                  ? "bg-amber-400"
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

  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex flex-col bg-bg/70 backdrop-blur-sm">
      <div className="mx-auto flex h-full w-full max-w-2xl flex-col p-3 sm:p-5">
        {/* Standing */}
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[0.58rem] font-medium uppercase tracking-[0.2em] text-muted">
              The Scrapline
            </p>
            <h2 className="font-display text-xl font-semibold leading-tight text-fg sm:text-2xl">
              {rank > 15 ? "Unranked" : `Rank ${rank}`}
              {career.titles.length > 0 && (
                <span className="ml-2 align-middle text-xs font-normal text-accent">
                  {career.titles[career.titles.length - 1]}
                </span>
              )}
            </h2>
          </div>
          <button type="button" className="btn-secondary !min-h-9 !px-3 !py-1.5 !text-sm" onClick={onClose}>
            Back
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border/70 bg-surface/70 px-3 py-2">
          <span className="text-[0.65rem] text-muted">
            Markers <span className="font-mono text-fg">{career.markers}</span>
          </span>
          <span className="text-[0.65rem] text-muted">
            Scrap <span className="font-mono text-fg">{meta.scrap}</span>
          </span>
          <span className="flex items-center gap-1.5 text-[0.65rem] text-muted">
            League heat <HeatBars heat={career.heat} />
          </span>
          {target && (
            <span className="ml-auto text-[0.65rem] text-muted">
              Next: <span className="text-fg">#{target.rank} {target.name}</span>
            </span>
          )}
        </div>

        <div className="mt-3 flex gap-1.5">
          {(["events", "board"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] transition-colors ${
                tab === t
                  ? "border-fg/25 bg-bg-subtle text-fg"
                  : "border-border/70 bg-bg/25 text-muted hover:bg-bg-subtle/60"
              }`}
            >
              {t === "events" ? "Events" : "Blacklist"}
            </button>
          ))}
        </div>

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
          {tab === "events" ? (
            <>
              {byTrack.map(([trackId, list]) => (
                <div key={trackId} className="mb-3">
                  <p className="mb-1 text-[0.58rem] font-medium uppercase tracking-[0.16em] text-muted">
                    {getTrackDef(trackId).name}
                  </p>
                  <div className="space-y-1.5">
                    {list.map((m) => (
                      <EventRow
                        key={m.id}
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
                <div className="mb-3 rounded-lg border border-dashed border-border/70 bg-bg/20 px-3 py-2.5">
                  <p className="text-[0.65rem] font-semibold text-fg/80">
                    {getTrackDef(nextTrack[0]).name} — locked
                  </p>
                  <p className="mt-0.5 text-[0.65rem] text-muted">
                    {TRACK_BEATS[nextTrack[0]] ?? "A road you have not earned yet."}
                  </p>
                  <p className="mt-1 font-mono text-[0.6rem] text-amber-200/80">
                    {nextTrack[1] - career.markers} more markers
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-1.5">
              {[...rows].reverse().map((row) => (
                <RivalRow
                  key={row.rival.id}
                  row={row}
                  scrap={meta.scrap}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className="mt-2 self-start text-[0.6rem] uppercase tracking-[0.14em] text-muted/70 underline-offset-2 hover:underline"
          onClick={onReset}
        >
          Reset career
        </button>
      </div>
    </div>
  );
}

function EventRow({
  def,
  career,
  scrap,
  onSelect,
}: {
  def: MissionDef;
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
      className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
        canPay
          ? "border-border/80 bg-bg/30 hover:bg-bg-subtle/60"
          : "border-border/40 bg-bg/10 opacity-50"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-semibold text-fg">
          {def.name}
          {done && <span className="ml-1.5 text-[0.6rem] font-normal text-emerald-300/80">cleared</span>}
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
            <span className={canPay ? " text-amber-200/80" : " text-rose-300"}> · stake {cost}</span>
          )}
        </span>
      </div>
      {best && (
        <p className="mt-0.5 font-mono text-[0.58rem] text-muted/70">
          best P{best.place} · {best.time.toFixed(1)}s
        </p>
      )}
    </button>
  );
}

function RivalRow({
  row,
  scrap,
  onSelect,
}: {
  row: BoardEntry;
  scrap: number;
  onSelect: (id: string) => void;
}) {
  const r = row.rival;
  const duel = duelMission(r);
  const cost = missionCost(duel);
  const open = row.status === "available" && affordable(scrap, duel);
  const cls = VEHICLE_CLASSES[r.classId];
  return (
    <button
      type="button"
      disabled={!open}
      onClick={() => onSelect(duel.id)}
      className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
        row.status === "defeated"
          ? "border-emerald-500/25 bg-emerald-500/5"
          : open
            ? "border-fg/25 bg-bg-subtle hover:bg-bg-subtle/80"
            : "border-border/50 bg-bg/15 opacity-60"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted">#{r.rank}</span>
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: cls.color }}
        />
        <span className="truncate font-display text-sm font-semibold text-fg">{r.name}</span>
        <span className="truncate text-[0.6rem] text-muted">{r.crew}</span>
        <span className="ml-auto shrink-0">
          {row.status === "defeated" ? (
            <Chip tone="good">Beaten</Chip>
          ) : open ? (
            <Chip tone="warn">Open</Chip>
          ) : (
            <Chip>Locked</Chip>
          )}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[0.65rem] text-muted">{r.bio}</p>
      {row.status !== "defeated" && (
        <p className="mt-0.5 font-mono text-[0.58rem] text-muted/80">
          {row.markersShort > 0 && `${row.markersShort} markers short`}
          {row.markersShort > 0 && row.missing.length > 0 && " · "}
          {row.missing.length > 0 && `run ${row.missing.join(", ")}`}
          {row.status === "available" && cost > 0 && `stake ${cost}`}
        </p>
      )}
    </button>
  );
}

/* ── the brief ────────────────────────────────────────────────────────── */

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
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-bg/70 p-3 backdrop-blur-sm sm:p-5">
      <div className="panel-shell w-full max-w-md animate-rise !p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[0.58rem] font-medium uppercase tracking-[0.18em] text-muted">
              {trackDef.name} · {def.laps} lap{def.laps === 1 ? "" : "s"}
            </p>
            <h2 className="truncate font-display text-xl font-semibold text-fg">{def.name}</h2>
          </div>
          <button
            type="button"
            className="btn-secondary !min-h-8 !px-2.5 !py-1 !text-xs"
            onClick={onBack}
          >
            Back
          </button>
        </div>

        <div className="mt-2 space-y-0.5">
          {def.brief.map((line, i) => (
            <p key={i} className="text-[0.72rem] leading-snug text-fg/85">
              {line}
            </p>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          <Chip>{def.kind.replace("_", " ")}</Chip>
          {missionTags(def).map((t) => (
            <Chip key={t.label} tone={t.tone}>
              {t.label}
            </Chip>
          ))}
          {heatFloor > def.modifiers.heat + 0.01 && (
            <Chip tone="warn">Your heat raises this</Chip>
          )}
        </div>

        <div className="mt-2.5 rounded-lg border border-border/70 bg-bg/25 px-2.5 py-2">
          <p className="text-[0.58rem] font-medium uppercase tracking-[0.14em] text-muted">
            Objectives
          </p>
          <ul className="mt-1 space-y-0.5">
            {def.objectives.map((o, i) => (
              <li key={i} className="text-[0.7rem] leading-snug text-fg/90">
                {o.optional ? "◇ " : "· "}
                {o.label ?? describeObjective(o)}
                {o.optional && <span className="ml-1 text-[0.6rem] text-muted">bonus</span>}
              </li>
            ))}
          </ul>
        </div>

        {/* Class choice belongs on the brief, not in a garage two screens away:
            which car to bring IS the decision a brief exists to inform. */}
        <div className="mt-2.5 grid grid-cols-3 gap-1.5">
          {CLASS_ORDER.map((id) => {
            const c = VEHICLE_CLASSES[id];
            const on = classId === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onClass(id)}
                className={`rounded-lg border px-2 py-1.5 text-left transition-colors ${
                  on ? "border-fg/25 bg-bg-subtle" : "border-border/70 bg-bg/25 hover:bg-bg-subtle/60"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ background: c.color }}
                  />
                  <span className="truncate text-[0.72rem] font-semibold text-fg">{c.name}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-2.5 flex items-center justify-between text-[0.65rem]">
          <span className="text-muted">
            Pays <span className="font-mono text-fg">+{def.reward.markers}M</span>
            {" · "}
            <span className="font-mono text-fg">+{def.reward.scrap} scrap</span>
          </span>
          {cost > 0 && (
            <span className={canPay ? "text-amber-200/90" : "text-rose-300"}>
              Stake <span className="font-mono">{cost}</span> · you hold {meta.scrap}
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
    <div className="pointer-events-auto absolute inset-0 z-[55] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm animate-rise rounded-2xl border border-white/10 bg-[#12100e] p-5 shadow-2xl">
        {b.voice && (
          <p className="text-[0.58rem] font-semibold uppercase tracking-[0.22em] text-accent">
            {b.voice}
          </p>
        )}
        <h3 className="mt-1 font-display text-lg font-semibold text-fg">{b.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-fg/90">{b.body}</p>
        {b.flavor && (
          <p className="mt-2 text-[0.7rem] italic leading-relaxed text-muted">{b.flavor}</p>
        )}
        <button type="button" className="btn-primary mt-4 w-full" onClick={onNext}>
          {remaining > 1 ? `Continue (${remaining - 1} more)` : "Continue"}
        </button>
      </div>
    </div>
  );
}

/* ── aftermath ────────────────────────────────────────────────────────── */

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
  const won = summary.outcome === "complete";
  return (
    <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm">
      <div className="panel-shell w-full max-w-sm animate-rise !p-4">
        <p className="text-[0.58rem] font-medium uppercase tracking-[0.18em] text-muted">
          {def.name}
        </p>
        <h2
          className={`mt-0.5 font-display text-2xl font-semibold ${
            won ? "text-emerald-300" : "text-rose-300"
          }`}
        >
          {won ? "Objectives clear" : "Run lost"}
        </h2>

        <ul className="mt-3 space-y-1">
          {summary.objectives.map((o, i) => (
            <li key={i} className="flex items-baseline justify-between gap-2 text-[0.72rem]">
              <span
                className={
                  o.status === "met"
                    ? "text-emerald-300"
                    : o.status === "failed"
                      ? "text-rose-300"
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

        <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-border/70 bg-bg/25 px-2.5 py-2 text-center">
          <Stat label="Place" value={`P${summary.place}`} />
          <Stat label="Takedowns" value={String(summary.takedowns)} />
          <Stat
            label="Best lap"
            value={summary.bestLap ? `${summary.bestLap.toFixed(2)}s` : "—"}
          />
        </div>

        <div className="mt-2.5 space-y-1 text-[0.72rem]">
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

        {award.rivalDefeated && (
          <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
            <p className="text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-amber-200">
              Rank taken — #{award.rivalDefeated.rank}
            </p>
            <p className="mt-0.5 text-[0.72rem] text-fg/90">
              &ldquo;{award.rivalDefeated.beaten}&rdquo;
            </p>
            <p className="mt-1 text-[0.65rem] text-muted">
              You take {award.rivalDefeated.reward.pinkSlip}.
            </p>
          </div>
        )}

        {award.requalify && (
          <div className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2">
            <p className="text-[0.72rem] text-rose-200">
              They will not take your call again until you have run{" "}
              <span className="font-semibold">{award.requalify}</span>.
            </p>
          </div>
        )}

        {award.tracksUnlocked.length > 0 && (
          <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
            {award.tracksUnlocked.map((t) => (
              <p key={t} className="text-[0.72rem] text-emerald-200">
                {getTrackDef(t).name} is open. {TRACK_BEATS[t] ?? ""}
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
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[0.55rem] uppercase tracking-[0.12em] text-muted">{label}</p>
      <p className="font-display text-base font-semibold leading-tight text-fg">{value}</p>
    </div>
  );
}

function Line({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className={`font-mono ${good ? "text-fg" : "text-rose-300"}`}>{value}</span>
    </div>
  );
}
