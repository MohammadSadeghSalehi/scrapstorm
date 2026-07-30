/**
 * Lightweight mobile haptics via Vibration API.
 * No-ops on desktop / unsupported browsers.
 */

export type HapticKind = "tap" | "boost" | "hit" | "fire" | "countdown" | "finish" | "ui";

const PATTERNS: Record<HapticKind, number | number[]> = {
  tap: 8,
  ui: 12,
  fire: 18,
  boost: [22, 30, 40],
  hit: [35, 20, 55],
  countdown: 25,
  finish: [40, 40, 60, 40, 80],
};

let enabled = true;

export function setHapticsEnabled(on: boolean) {
  enabled = on;
}

export function hapticsSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

export function haptic(kind: HapticKind) {
  if (!enabled || !hapticsSupported()) return;
  try {
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    /* ignore */
  }
}
