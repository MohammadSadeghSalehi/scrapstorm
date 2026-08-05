/**
 * Authored cutscene playback.
 *
 * Nine clips live in public/assets/video (see scripts/import-videos.mjs). This
 * is the only place that knows they exist; everything else asks for a slot id.
 *
 * DESIGN RULES, all of them learned from how badly a cutscene can go wrong in a
 * game that is otherwise responsive:
 *
 *  - ALWAYS SKIPPABLE, and skippable on the FIRST frame. A clip you cannot get
 *    out of is worse than no clip, and one that only becomes skippable after a
 *    second of "please wait" is the same problem wearing a hat.
 *  - NEVER BLOCK ON THE NETWORK. Every gate has a timeout and the failure mode
 *    is to continue, not to hang. These are 3-14 MB files served over a dev
 *    server that has previously taken ten seconds to hand over a 118-byte
 *    asset; a cutscene that waits forever for one is a broken game.
 *  - MUTED BY DEFAULT and audio-ducked, because the music bed keeps playing
 *    underneath and two full-level sources fighting is worse than either.
 *  - ONE-SHOT CLIPS ARE REMEMBERED. The cold open is a story beat, not an
 *    interstitial; seeing it before every race would be actively hostile.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type CutsceneId =
  | "cold-open"
  | "title"
  | "menu-loop"
  | "garage"
  | "grid"
  | "rival"
  | "antagonist"
  | "victory"
  | "defeat";

const SRC = (id: CutsceneId) => `/assets/video/${id}.mp4`;

/**
 * Slots that play once per career rather than every time their moment occurs.
 *
 * Kept in sessionStorage rather than in the career save: a story beat should
 * not replay every time you open the menu, but it also should not be lost
 * forever because someone watched it on a machine they no longer have.
 */
const ONCE: ReadonlySet<CutsceneId> = new Set(["cold-open", "title", "antagonist"]);

const seenKey = (id: CutsceneId) => `scrapstorm.cutscene.${id}`;

export function hasSeenCutscene(id: CutsceneId): boolean {
  if (!ONCE.has(id)) return false;
  try {
    return sessionStorage.getItem(seenKey(id)) === "1";
  } catch {
    return false;
  }
}

function markSeen(id: CutsceneId) {
  if (!ONCE.has(id)) return;
  try {
    sessionStorage.setItem(seenKey(id), "1");
  } catch {
    /* private mode — replaying a beat is a far smaller problem than throwing */
  }
}

/**
 * A full-screen clip that reports when it is finished, for any reason.
 *
 * `onDone` fires exactly once, whether the clip ended, was skipped, failed to
 * load or timed out. Callers therefore never need to handle "it did not play" —
 * which is what keeps a missing asset from stalling the game.
 */
export function Cutscene({
  id,
  onDone,
  maxWaitMs = 4000,
  letterbox = false,
}: {
  id: CutsceneId;
  onDone: () => void;
  /** Give up waiting for playable data and continue. */
  maxWaitMs?: number;
  /**
   * Fit the whole frame inside the screen, showing bars, instead of filling it.
   *
   * Off by default. These clips are generated at whatever aspect the model
   * produced, and `object-contain` renders a 1:1 clip as a small square adrift
   * in a 16:9 screen — which reads as a broken overlay rather than a cutscene,
   * and looks nothing like the game it is cutting to. Filling the screen and
   * cropping the overflow is the right trade for a full-bleed beat; the subject
   * is centred in every one of these, so nothing important leaves frame.
   */
  letterbox?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const done = useRef(false);
  const [ready, setReady] = useState(false);

  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    markSeen(id);
    onDone();
  }, [id, onDone]);

  /*
   * Re-arm on a new clip even if this instance is reused.
   *
   * The call site keys by id so this should never fire, but a one-shot guard
   * that silently survives into the next clip is exactly the bug that hung the
   * game: the second clip in a sequence became unskippable and never reported
   * done. Cheap to make the component correct on its own terms rather than
   * relying on every caller remembering the key.
   */
  useEffect(() => {
    done.current = false;
    setReady(false);
  }, [id]);

  useEffect(() => {
    // Any key, any click. Deliberately not a labelled button: the prompt is
    // rendered separately so the input surface is the whole screen.
    const skip = () => finish();
    window.addEventListener("keydown", skip);
    window.addEventListener("pointerdown", skip);
    const t = window.setTimeout(() => {
      // Never seen enough data to start. Continue rather than sit on a black
      // screen waiting for a file that may not arrive.
      if (!ref.current || ref.current.readyState < 2) finish();
    }, maxWaitMs);
    return () => {
      window.removeEventListener("keydown", skip);
      window.removeEventListener("pointerdown", skip);
      window.clearTimeout(t);
    };
  }, [finish, maxWaitMs]);

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black">
      <video
        ref={ref}
        src={SRC(id)}
        autoPlay
        muted
        playsInline
        preload="auto"
        className={
          letterbox
            ? "max-h-full max-w-full object-contain"
            : "h-full w-full object-cover"
        }
        onCanPlay={() => setReady(true)}
        onEnded={finish}
        // A missing or undecodable file must not strand the player.
        onError={finish}
      />
      <div
        className={`pointer-events-none absolute bottom-6 right-8 font-mono text-[11px] tracking-wide text-white/45 transition-opacity duration-500 ${
          ready ? "opacity-100" : "opacity-0"
        }`}
      >
        press any key to skip
      </div>
    </div>
  );
}

/**
 * A silent looping clip behind a menu.
 *
 * Separate from Cutscene because the requirements invert: it never ends, never
 * blocks anything, and must fail completely silently — a menu whose background
 * video 404s should look like a menu with no background video, not like a
 * broken menu.
 */
export function CutsceneLoop({
  id,
  className = "",
  opacity = 0.55,
}: {
  id: CutsceneId;
  className?: string;
  opacity?: number;
}) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <video
      src={SRC(id)}
      autoPlay
      muted
      loop
      playsInline
      // Menu backdrops are decorative, so they wait their turn behind anything
      // the player is actually waiting for.
      preload="none"
      onError={() => setOk(false)}
      style={{ opacity }}
      className={`pointer-events-none absolute inset-0 h-full w-full object-cover ${className}`}
    />
  );
}
