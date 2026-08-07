/**
 * Authored menu art, with a fallback that has to stand on its own.
 *
 * Every image this module serves lives at `/assets/ui/<name>.png` and every one
 * of them is OPTIONAL. `public/assets/` is gitignored by design, art is
 * generated out of band, and a screen that breaks — or worse, quietly loses its
 * hierarchy — because one texture 404'd is not a screen that ships.
 *
 * So the contract is the same one CutsceneLoop already uses for video, tightened
 * by what §4 of AGENTS.md cost us with the weapon meshes: a graceful fallback
 * that is *silent* makes total failure indistinguishable from working. Every
 * miss warns once, by name, so a wrong filename shows up in the console instead
 * of hiding behind a plausible-looking CSS panel.
 *
 * Probing is done ONCE PER NAME PER SESSION at module scope, not per component.
 * The board mounts fifteen rival portraits and remounts on every tab switch; a
 * per-component probe would re-issue those requests each time and, on the miss
 * path, re-run fifteen 404s.
 */
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/** Resolved: true = usable, false = absent, undefined = still probing. */
const resolved = new Map<string, boolean>();
const pending = new Map<string, Set<() => void>>();

const url = (name: string) => `/assets/ui/${name}.png`;

function settle(name: string, ok: boolean) {
  resolved.set(name, ok);
  if (!ok) {
    // Named, once. See the module note — a silent fallback is a trap.
    console.warn(`[ui-art] missing ${url(name)} — falling back to CSS`);
  }
  const waiters = pending.get(name);
  pending.delete(name);
  waiters?.forEach((fn) => fn());
}

function probe(name: string) {
  if (resolved.has(name) || pending.has(name)) return;
  pending.set(name, new Set());
  // A bare Image() is enough: we only need to know whether the decode succeeds,
  // and the browser cache means the later <img> or background-image is free.
  const img = new Image();
  img.onload = () => settle(name, img.naturalWidth > 0);
  img.onerror = () => settle(name, false);
  img.src = url(name);
}

/**
 * Whether an art asset is present. Returns false while probing, so the first
 * paint is always the fallback and the texture swaps in when it lands — which
 * is the right way round: a blank hole waiting for a texture is worse than a
 * styled panel that gets better.
 */
export function useUiArt(name: string | null): boolean {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!name) return;
    if (resolved.has(name)) return;
    probe(name);
    const set = pending.get(name);
    if (!set) {
      bump();
      return;
    }
    set.add(bump);
    return () => {
      set.delete(bump);
    };
  }, [name]);
  return name ? resolved.get(name) === true : false;
}

/** Background-image style for an asset, or nothing if it is not there. */
export function artStyle(
  name: string,
  ok: boolean,
  extra?: CSSProperties,
): CSSProperties | undefined {
  if (!ok) return extra;
  return {
    backgroundImage: `url(${url(name)})`,
    backgroundSize: "100% 100%",
    backgroundRepeat: "no-repeat",
    ...extra,
  };
}

/**
 * A panel. `art` names an optional plate texture drawn *under* the content at
 * low opacity — the CSS plate stays underneath either way, so the texture adds
 * material rather than being load-bearing for contrast.
 *
 * `primary` is the hierarchy switch: exactly one plate per screen should set it.
 */
export function Plate({
  children,
  art = "plate",
  primary = false,
  className = "",
  style,
}: {
  children: ReactNode;
  art?: string | null;
  primary?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const ok = useUiArt(primary && art === "plate" ? "plate-lit" : art);
  const texture = primary && art === "plate" ? "plate-lit" : art;
  return (
    <div
      className={`plate ${primary ? "plate-primary" : ""} ${className}`}
      style={style}
    >
      {ok && texture && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] bg-cover bg-center opacity-[0.5] mix-blend-luminosity"
          style={{ backgroundImage: `url(${url(texture)})` }}
        />
      )}
      <div className="relative">{children}</div>
    </div>
  );
}

/**
 * A full-bleed backdrop image behind a screen. Renders nothing at all when the
 * asset is absent, so the screen falls back to whatever is already behind it
 * (the looping clip, or the shell gradient).
 */
export function ArtBackdrop({
  name,
  opacity = 0.55,
  className = "",
}: {
  name: string;
  opacity?: number;
  className?: string;
}) {
  const ok = useUiArt(name);
  if (!ok) return null;
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 bg-cover bg-center ${className}`}
      style={{ backgroundImage: `url(${url(name)})`, opacity }}
    />
  );
}

/**
 * A tiling dust/scratch pass over a whole screen.
 *
 * This is the cheapest thing in the system that makes six separately-authored
 * screens read as one product: the same grain on all of them. Falls back to a
 * procedural dither rather than to nothing, because "no grain here" is visible
 * as an inconsistency the moment another screen has it.
 */
export function Grain({ opacity = 0.16 }: { opacity?: number }) {
  const ok = useUiArt("grain");
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 z-[1] ${ok ? "" : "grain-fallback"}`}
      style={
        ok
          ? {
              backgroundImage: `url(${url("grain")})`,
              backgroundRepeat: "repeat",
              backgroundSize: "256px 256px",
              opacity,
            }
          : { opacity: opacity * 0.9 }
      }
    />
  );
}

/**
 * A mark: league insignia, class badge, circuit plate, rival portrait.
 *
 * Falls back to `fallback` — normally a stencilled initial or a coloured chip —
 * so the layout keeps its shape and its meaning either way. That matters more
 * for the board than anywhere else: fifteen missing portraits must still read
 * as fifteen distinct people, not as fifteen empty squares.
 */
export function Insignia({
  name,
  alt,
  className = "",
  fallback,
}: {
  name: string;
  alt: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const ok = useUiArt(name);
  if (!ok) return <>{fallback ?? null}</>;
  return <img src={url(name)} alt={alt} className={className} draggable={false} />;
}

/**
 * An overprint stamp — BEATEN, LOCKED, CLEARED. Absolutely positioned by the
 * caller. Falls back to type set in the stamp's own colour, which is honestly
 * most of the effect: the rotation and the overlap are what sell it.
 */
export function Stamp({
  name,
  label,
  tone,
  className = "",
}: {
  name: string;
  label: string;
  tone: string;
  className?: string;
}) {
  const ok = useUiArt(name);
  // The tilt is an independent `rotate`, not part of the keyframe: reduced
  // motion kills the animation, and a stamp printed perfectly square is not a
  // stamp.
  const tilt: CSSProperties = { rotate: "-7.5deg" };
  if (ok) {
    return (
      <img
        src={url(name)}
        alt={label}
        draggable={false}
        style={tilt}
        className={`animate-stamp pointer-events-none absolute select-none ${className}`}
      />
    );
  }
  // `className` carries the caller's position AND its height, and that height
  // is chosen for the image. Centring the type inside that box is what keeps
  // the fallback from rendering as a tall empty rectangle with a word stuck at
  // the top of it.
  return (
    <span
      aria-hidden
      className={`stencil animate-stamp pointer-events-none absolute inline-flex select-none items-center justify-center border-2 px-2 text-[0.7rem] tracking-[0.14em] opacity-80 ${className}`}
      style={{ ...tilt, color: tone, borderColor: tone }}
    >
      {label}
    </span>
  );
}

/**
 * Between-screen transition.
 *
 * The shell swaps whole overlays on a state change, so a screen change was an
 * instant cut — the single biggest reason the menus felt like a settings dialog
 * rather than a front end. This wraps the swap in a shutter that wipes across
 * once per change.
 *
 * Two deliberate constraints:
 *  - The shutter is `pointer-events-none` and children are NEVER unmounted or
 *    delayed. The new screen is live and clickable the instant it renders; the
 *    wipe is decoration over the top of an already-usable screen. A transition
 *    that eats a click is a bug wearing an animation.
 *  - Nothing plays on the first mount. A wipe on page load is a flash of black
 *    over a screen the player has not seen yet.
 */
export function ScreenStage({
  screenKey,
  children,
}: {
  screenKey: string;
  children: ReactNode;
}) {
  const previous = useRef(screenKey);
  const [wipe, setWipe] = useState(0);

  useEffect(() => {
    if (previous.current === screenKey) return;
    previous.current = screenKey;
    setWipe((n) => n + 1);
  }, [screenKey]);

  return (
    <>
      {children}
      {wipe > 0 && (
        <div
          key={wipe}
          aria-hidden
          className="animate-shutter pointer-events-none absolute inset-0 z-[70] bg-[linear-gradient(90deg,rgba(10,8,6,0)_0%,rgba(10,8,6,0.96)_22%,rgba(10,8,6,0.96)_78%,rgba(143,59,23,0.5)_100%)]"
          onAnimationEnd={() => setWipe(0)}
        />
      )}
    </>
  );
}
