/**
 * Ghost duel: local PB + optional rival ghost (paste code or P2P exchange).
 * Casual co-op only — no ranked authority.
 */
import type { GhostRun } from "./ghost";
import { getGhost, type GhostSample } from "./ghost";
import type { TrackId } from "./track";
import type { VehicleClassId } from "./types";

export type GhostDuelMsg =
  | { type: "hello"; name: string; trackId: TrackId }
  | { type: "ghost"; run: GhostRun }
  | { type: "ready"; trackId: TrackId };

let rivalGhost: GhostRun | null = null;
const listeners = new Set<() => void>();

export function getRivalGhost(): GhostRun | null {
  return rivalGhost;
}

export function setRivalGhost(run: GhostRun | null) {
  rivalGhost = run;
  for (const fn of listeners) fn();
}

export function subscribeRivalGhost(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Compact pasteable share code (base64 JSON, samples decimated). */
export function encodeGhostShare(run: GhostRun): string {
  const samples =
    run.samples.length > 400
      ? run.samples.filter((_, i) => i % Math.ceil(run.samples.length / 400) === 0)
      : run.samples;
  const payload = { ...run, samples };
  const json = JSON.stringify(payload);
  if (typeof btoa === "function") {
    return `SSG1.${btoa(unescape(encodeURIComponent(json)))}`;
  }
  return `SSG1.${Buffer.from(json, "utf8").toString("base64")}`;
}

export function decodeGhostShare(code: string): GhostRun | null {
  try {
    const raw = code.trim();
    const b64 = raw.startsWith("SSG1.") ? raw.slice(5) : raw;
    const json =
      typeof atob === "function"
        ? decodeURIComponent(escape(atob(b64)))
        : Buffer.from(b64, "base64").toString("utf8");
    const run = JSON.parse(json) as GhostRun;
    if (!run?.samples?.length || !run.trackId || !run.totalTime) return null;
    return run;
  } catch {
    return null;
  }
}

export function makeRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "SS-";
  for (let i = 0; i < 5; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return s;
}

export function localGhostForTrack(trackId: TrackId): GhostRun | null {
  return getGhost(trackId);
}

export function isGhostRun(v: unknown): v is GhostRun {
  if (!v || typeof v !== "object") return false;
  const g = v as GhostRun;
  return Array.isArray(g.samples) && typeof g.totalTime === "number" && !!g.trackId;
}

export type { GhostSample, GhostRun, TrackId, VehicleClassId };
