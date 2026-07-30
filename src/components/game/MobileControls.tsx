import { useCallback, useRef } from "react";
import type { InputController } from "@/game/input";
import type { MatchPhase } from "@/game/types";
import { haptic } from "@/game/haptics";

export function MobileControls({
  input,
  phase,
  onPause,
}: {
  input: InputController;
  phase: MatchPhase;
  onPause: () => void;
}) {
  if (phase !== "racing" && phase !== "countdown") return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 sm:hidden">
      <div className="pointer-events-auto absolute bottom-4 left-3 flex items-end gap-2">
        <SteerPad input={input} />
        <div className="flex flex-col gap-2">
          <HoldButton
            label="Boost"
            onHold={(v) => {
              input.touchBoost = v;
              if (v) haptic("boost");
            }}
          />
          <button
            type="button"
            className="touch-btn h-12 w-12 text-[0.65rem] font-medium uppercase tracking-wide"
            onTouchStart={(e) => {
              e.preventDefault();
              input.touchBrake = true;
              haptic("tap");
            }}
            onTouchEnd={() => {
              input.touchBrake = false;
            }}
            onMouseDown={() => {
              input.touchBrake = true;
            }}
            onMouseUp={() => {
              input.touchBrake = false;
            }}
            onMouseLeave={() => {
              input.touchBrake = false;
            }}
          >
            Drift
          </button>
        </div>
      </div>

      <div className="pointer-events-auto absolute bottom-4 right-3 flex flex-col items-end gap-2">
        <button
          type="button"
          className="touch-btn h-11 w-11 text-xs font-medium"
          onClick={() => {
            haptic("ui");
            onPause();
          }}
          aria-label="Pause"
        >
          II
        </button>
        <div className="flex gap-2">
          <HoldButton
            label="Def"
            onHold={(v) => {
              input.touchDefense = v;
              if (v) haptic("tap");
            }}
          />
          <HoldButton
            label="Ult"
            onHold={(v) => {
              input.touchUltimate = v;
              if (v) haptic("boost");
            }}
          />
        </div>
        <HoldButton
          label="Fire"
          large
          onHold={(v) => {
            input.touchFire = v;
            if (v) haptic("fire");
          }}
        />
      </div>
    </div>
  );
}

function HoldButton({
  label,
  onHold,
  large,
}: {
  label: string;
  onHold: (v: boolean) => void;
  large?: boolean;
}) {
  return (
    <button
      type="button"
      className={`touch-btn font-medium uppercase tracking-wide ${
        large ? "h-16 w-16 text-sm" : "h-12 w-12 text-[0.65rem]"
      }`}
      onTouchStart={(e) => {
        e.preventDefault();
        onHold(true);
      }}
      onTouchEnd={() => onHold(false)}
      onTouchCancel={() => onHold(false)}
      onMouseDown={() => onHold(true)}
      onMouseUp={() => onHold(false)}
      onMouseLeave={() => onHold(false)}
    >
      {label}
    </button>
  );
}

function SteerPad({ input }: { input: InputController }) {
  const padRef = useRef<HTMLDivElement>(null);
  const active = useRef(false);

  const update = useCallback(
    (clientX: number) => {
      const el = padRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const x = (clientX - rect.left) / rect.width;
      const steer = (0.5 - x) * 2;
      input.touchSteer = Math.max(-1, Math.min(1, steer));
    },
    [input],
  );

  const end = useCallback(() => {
    active.current = false;
    input.touchSteer = 0;
  }, [input]);

  return (
    <div
      ref={padRef}
      className="relative h-28 w-36 touch-none rounded-2xl border border-border bg-surface/55 backdrop-blur-sm"
      onTouchStart={(e) => {
        e.preventDefault();
        active.current = true;
        update(e.touches[0].clientX);
      }}
      onTouchMove={(e) => {
        e.preventDefault();
        if (active.current) update(e.touches[0].clientX);
      }}
      onTouchEnd={end}
      onTouchCancel={end}
      onMouseDown={(e) => {
        active.current = true;
        update(e.clientX);
      }}
      onMouseMove={(e) => {
        if (active.current) update(e.clientX);
      }}
      onMouseUp={end}
      onMouseLeave={end}
    >
      <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-3 text-[0.65rem] font-medium uppercase tracking-wider text-muted">
        <span>A</span>
        <span>Steer</span>
        <span>D</span>
      </div>
    </div>
  );
}
