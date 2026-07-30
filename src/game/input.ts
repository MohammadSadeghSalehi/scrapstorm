import type { PlayerInput } from "./types";

export function createEmptyInput(seq = 0): PlayerInput {
  return {
    sequence: seq,
    steering: 0,
    throttle: 1,
    brake: false,
    firePrimary: false,
    useDefense: false,
    useUltimate: false,
    boost: false,
  };
}

export class InputController {
  keys = new Set<string>();
  touchSteer = 0;
  touchBrake = false;
  touchFire = false;
  touchDefense = false;
  touchUltimate = false;
  touchBoost = false;
  autoAccel = true;
  sequence = 0;
  forcedSteer: number | null = null;
  forcedThrottle: number | null = null;
  pausePressed = false;
  private pauseLatched = false;

  constructor() {
    if (typeof window === "undefined") return;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clear);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.clear();
    });
  }

  dispose() {
    if (typeof window === "undefined") return;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
      e.preventDefault();
    }
    if (e.code === "Escape" || e.code === "KeyP") {
      if (!this.pauseLatched) {
        this.pausePressed = true;
        this.pauseLatched = true;
      }
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    if (e.code === "Escape" || e.code === "KeyP") {
      this.pauseLatched = false;
    }
  };

  clear = () => {
    this.keys.clear();
  };

  /** Consume one-shot pause edge */
  consumePause(): boolean {
    if (this.pausePressed) {
      this.pausePressed = false;
      return true;
    }
    return false;
  }

  sample(): PlayerInput {
    let steer = 0;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) steer += 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) steer -= 1;
    steer += this.touchSteer;
    if (this.forcedSteer !== null) steer = this.forcedSteer;
    steer = Math.max(-1, Math.min(1, steer));

    // Throttle: W / Up (or auto-cruise). Boost is SEPARATE (E / R) — not W.
    const wantsThrottle =
      this.keys.has("KeyW") ||
      this.keys.has("ArrowUp");
    const boost =
      this.touchBoost ||
      this.keys.has("KeyE") ||
      this.keys.has("KeyR");

    let throttle = this.autoAccel ? 0.78 : 0;
    if (wantsThrottle) throttle = 1;
    if (boost) throttle = 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) throttle = 0;
    if (this.forcedThrottle !== null) throttle = this.forcedThrottle;

    const brake =
      this.touchBrake ||
      this.keys.has("ShiftLeft") ||
      this.keys.has("ShiftRight") ||
      this.keys.has("KeyS") ||
      this.keys.has("ArrowDown");

    // S/down only — Shift is the handbrake and must not back the car up.
    const reverse =
      this.touchBrake ||
      this.keys.has("KeyS") ||
      this.keys.has("ArrowDown");

    const firePrimary =
      this.touchFire || this.keys.has("KeyJ") || this.keys.has("Space");
    const useDefense = this.touchDefense || this.keys.has("KeyK");
    const useUltimate = this.touchUltimate || this.keys.has("KeyL");

    this.sequence += 1;
    return {
      sequence: this.sequence,
      steering: steer,
      throttle,
      brake,
      reverse,
      firePrimary,
      useDefense,
      useUltimate,
      boost,
    };
  }
}
