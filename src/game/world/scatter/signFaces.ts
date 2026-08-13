/**
 * What the roadside signs SAY, and the atlas they say it on.
 *
 * ── why the faces are drawn and not loaded ────────────────────────────
 *
 * Same three reasons StartGantry gives for its own atlas, and they have not got
 * any weaker: generated lettering is misspelled and unlocalisable, `public/`
 * is gitignored so a generated PNG is an asset no clone has, and Vite caches the
 * public directory listing at startup so a new file 404s until the server is
 * restarted. A canvas is reproducible by definition and readable in a diff.
 *
 * Grok WAS used, and only for art direction — `scripts/gen-signage.mjs` writes
 * five reference sheets into `refs/signage/` and prints their area-weighted
 * palettes. `SIGN_PALETTE` below is transcribed from that readout.
 *
 * ── why one atlas serves two families ─────────────────────────────────
 *
 * The post-mounted plates and the verge hoardings are two InstancedMeshes with
 * two materials, because they are two geometries and two base colours (see
 * RoadsideFurniture). They share ONE texture, because a texture is not a draw
 * call: 1024x1024 carries sixteen plate faces and six hoarding faces, which is
 * the entire written world outside the gantry, for 5.6MB with mipmaps.
 *
 * ── the layout, and the white band nobody will guess at ───────────────
 *
 * Instancing has no per-instance UV, so the shader is patched to remap `vMapUv`
 * through a per-instance rect (see `SIGN_UV_CHUNK`). That transform applies to
 * EVERY vertex of the module, not just the plate — so the post, the frame and
 * the footing are also dragged into whichever cell the instance drew. They
 * cannot simply point at a corner of the atlas; the corner moves with the cell.
 *
 * So every cell reserves a band along its bottom edge, filled pure white, and
 * all non-face geometry points at the centre of it. White because that makes the
 * structure `materialColour x vertexColour x 1` — bit for bit what it was before
 * there was a texture at all, so adding artwork to the plate could not silently
 * re-tone the post holding it up.
 *
 * ── and the mirroring rule ────────────────────────────────────────────
 *
 * A back face samples the same UVs with the winding reversed, which is a mirror.
 * The gantry's answer is a rotated twin per panel; the answer here is different
 * and stronger: each face is a SINGLE front quad standing just proud of an
 * opaque backing box, so there is no back face to read through. A sign is blank
 * on the back, which is also what a sign is actually like.
 */
import { getTrackDef, type AnyTrackId } from "../../track";
import { mulberry32 } from "./placement";

/* ── palette ──────────────────────────────────────────────────────────── */

/**
 * Read off `refs/signage/`, with `node scripts/gen-signage.mjs --palette` for
 * the area-weighted grid and the images themselves for the accents (an 8x8
 * average is dominated by the backdrop and cannot see a chevron).
 *
 * Two of these are not what you would guess and both came from the reference:
 *
 * `sheet` is NOT white. Retroreflective sheeting that has been outside for a
 * decade chalks to a warm bone; a pure white plate reads as printed paper, which
 * is the clearest single tell that a sign has been pasted into a world rather
 * than left standing in it.
 *
 * `legend` is not black either, and it is slightly BLUE. Every dark ground in
 * the reference sheets sits around #2b2f36 rather than a neutral charcoal —
 * which is what stops the plate reading as a hole punched in the desert, and
 * what keeps it from flaring under the bloom pass.
 */
export const SIGN_PALETTE = {
  /** Bleached retroreflective sheeting. Takes the whole `surfaces.stripe` lift. */
  sheet: "#e8e2d6",
  /** Older, greyer sheeting. */
  sheetOld: "#d2cabb",
  /** Legend and borders. */
  legend: "#262a31",
  /** Chevrons, arrows, league marks, numeral halos. */
  amber: "#ee9420",
  /** The hotter accent: kickers, hazard stripes, tally strokes. */
  ember: "#c8541c",
  /** Painted (not retroreflective) plate ground. */
  charcoal: "#2b2f36",
  /** Bare cut steel showing at an edge or a bolt. */
  steel: "#8d8880",
  /**
   * Rain streaking. Grey-brown, not black — the weathering reference is
   * unambiguous about this, and a black streak reads as soot rather than as ten
   * years of runoff carrying dust down a plate.
   */
  streak: "#6d6455",
  /** Structure band. Pure white on purpose; see the note above. */
  blank: "#ffffff",
} as const;

const FONT_STENCIL = "Impact, 'Arial Narrow', Haettenschweiler, sans-serif";
const FONT_PLAIN = "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";

/* ── atlas geometry ───────────────────────────────────────────────────── */

export const ATLAS_SIZE = 1024;

/**
 * Cell height, shared by both zones.
 *
 * The two families have different plate aspects (the plate is 2.42 x 1.32, the
 * hoarding panel 4.6 x 1.55) so their cells differ in WIDTH. Keeping the height
 * common is what lets the two zones stack without either wasting a strip or
 * needing its own row arithmetic.
 */
const CELL_H = 170;

/** Post-mounted plates: four across, four down, in the top 680 rows. */
const SIGN_COLS = 4;
const SIGN_ROWS = 4;
const SIGN_CELL_W = ATLAS_SIZE / SIGN_COLS;
/** Verge hoardings: three across, two down, immediately below. */
const BOARD_COLS = 3;
const BOARD_ROWS = 2;
const BOARD_CELL_W = ATLAS_SIZE / BOARD_COLS;
const BOARD_ZONE_Y = SIGN_ROWS * CELL_H;

/**
 * Fraction of a cell's HEIGHT given to the artwork, per family.
 *
 * Derived from the plate's real proportions rather than chosen: the face has to
 * match the quad it lands on or the lettering arrives stretched. The remainder
 * of the cell is the white structure band.
 */
export const SIGN_FACE_FRAC = round4(SIGN_CELL_W / 1.8333 / CELL_H);
export const BOARD_FACE_FRAC = round4(BOARD_CELL_W / 2.9677 / CELL_H);

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * The sixteen plate faces.
 *
 * Ordered so that a left/right pair is always (n, n+1) — the layout code picks a
 * direction with `+ (curve > 0 ? 0 : 1)` and getting that backwards points every
 * chevron on the circuit into the infield.
 */
export const SIGN_FACE = {
  chevronL: 0,
  chevronR: 1,
  bendL: 2,
  bendR: 3,
  hairpinL: 4,
  hairpinR: 5,
  brake150: 6,
  brake100: 7,
  brake50: 8,
  sector1: 9,
  sector2: 10,
  sector3: 11,
  route: 12,
  hazard: 13,
  crest: 14,
  narrows: 15,
} as const;

export type SignFaceId = (typeof SIGN_FACE)[keyof typeof SIGN_FACE];

export const SIGN_FACE_COUNT = SIGN_COLS * SIGN_ROWS;

/** The six hoarding faces. */
export const BOARD_FACE = {
  league: 0,
  circuit: 1,
  timing: 2,
  traderA: 3,
  traderB: 4,
  notice: 5,
} as const;

export type BoardFaceId = (typeof BOARD_FACE)[keyof typeof BOARD_FACE];

export const BOARD_FACE_COUNT = BOARD_COLS * BOARD_ROWS;

/** `[u0, v0, du, dv]`, ready to hand to the per-instance attribute. */
export type UvRect = readonly [number, number, number, number];

/**
 * Cell rect in three's UV convention.
 *
 * v is measured from the BOTTOM while the canvas draws from the top, so the
 * first ROW of the canvas is the HIGHEST v. This is the same inversion the
 * gantry atlas carries a warning about, and it is worth repeating because
 * getting it wrong does not throw: it silently prints the hoarding copy on the
 * chevron boards, which is only visible from a screenshot.
 */
function cellRect(x: number, yTop: number, w: number, h: number): UvRect {
  return [
    x / ATLAS_SIZE,
    1 - (yTop + h) / ATLAS_SIZE,
    w / ATLAS_SIZE,
    h / ATLAS_SIZE,
  ];
}

export function signFaceRect(face: number): UvRect {
  const i = clampFace(face, SIGN_FACE_COUNT);
  const col = i % SIGN_COLS;
  const row = Math.floor(i / SIGN_COLS);
  return cellRect(col * SIGN_CELL_W, row * CELL_H, SIGN_CELL_W, CELL_H);
}

export function boardFaceRect(face: number): UvRect {
  const i = clampFace(face, BOARD_FACE_COUNT);
  const col = i % BOARD_COLS;
  const row = Math.floor(i / BOARD_COLS);
  return cellRect(
    col * BOARD_CELL_W,
    BOARD_ZONE_Y + row * CELL_H,
    BOARD_CELL_W,
    CELL_H,
  );
}

/**
 * Out-of-range face ids are clamped rather than thrown on.
 *
 * The layout derives faces from curvature percentiles and arc length, and a
 * circuit that produces an unexpected index should get the wrong picture, not a
 * black screen mid-race. The gate script asserts the range instead, where a
 * failure costs nothing.
 */
function clampFace(face: number, count: number): number {
  if (!Number.isFinite(face)) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(face)));
}

/* ── per-circuit copy ─────────────────────────────────────────────────── */

/**
 * The words. One entry per circuit, because the atlas is rebuilt on a track
 * change anyway and swapping strings inside an existing canvas pass is the
 * cheapest per-circuit variety available — no extra geometry, no extra texture,
 * no extra draw call.
 *
 * Everything here is length-budgeted against the cell it lands in and the gate
 * script measures it. A line that overflows is not clipped by the canvas, it is
 * squeezed by `maxWidth`, which turns a legend into a smear rather than an
 * error.
 */
export type SignCopy = {
  /** Route-marker line. Short: it sits under the league mark. */
  short: string;
  /** Hoarding headline. */
  name: string;
  /** The one thing that will hurt you here. */
  hazard: string;
  hazardSub: string;
  /** Two verge traders. `[headline, strapline]`. */
  traderA: [string, string];
  traderB: [string, string];
  /** Small print on the notice board. */
  notice: string;
};

const COPY: Record<AnyTrackId, SignCopy> = {
  ash_spire: {
    short: "ASH SPIRE",
    name: "ASH SPIRE CIRCUIT",
    hazard: "ROCKFALL",
    hazardSub: "LOOSE SCREE 400M",
    traderA: ["SPIRE SALVAGE", "PLATE · AXLES · GLASS"],
    traderB: ["HIGH DESERT FUEL", "LAST PUMP FOR 60KM"],
    notice: "NO RECOVERY BEYOND THIS POINT",
  },
  cinder_bowl: {
    short: "CINDER BOWL",
    name: "CINDER BOWL",
    hazard: "HOT SURFACE",
    hazardSub: "EMBER DRIFT ACROSS",
    traderA: ["BOWL CLINKER CO", "SCRAP BY THE TONNE"],
    traderB: ["ASHFALL TYRES", "COMPOUND TO ORDER"],
    notice: "BURNS ARE YOUR OWN AFFAIR",
  },
  foundry_pit: {
    short: "FOUNDRY PIT",
    name: "FOUNDRY PIT",
    hazard: "SLAG SPILL",
    hazardSub: "MOLTEN LINE CROSSING",
    traderA: ["PIT FURNACE No.4", "BILLET · BAR · OFFCUT"],
    traderB: ["NIGHT SHIFT FUEL", "OPEN WHILE IT BURNS"],
    notice: "NO RECOVERY BEYOND THIS POINT",
  },
  rustline: {
    short: "RUSTLINE",
    name: "RUSTLINE GAUNTLET",
    hazard: "BROWN-OUT",
    hazardSub: "LIGHTS ON THROUGHOUT",
    traderA: ["RUSTLINE WRECKERS", "WE BUY WHAT IS LEFT"],
    traderB: ["GRIT FILTERS", "BREATHE ANOTHER YEAR"],
    notice: "TOWING CHARGED BY THE METRE",
  },
  sable_run: {
    short: "SABLE MILE",
    name: "SABLE MILE",
    hazard: "SALT CRUST",
    hazardSub: "NO SHADE FOR 12KM",
    traderA: ["PLAYA SALT WORKS", "BULK LOADS ONLY"],
    traderB: ["WHITE FLATS WATER", "FILL BEFORE THE RUN"],
    notice: "NO RECOVERY BEYOND THIS POINT",
  },
  dead_mile: {
    short: "DEAD MILE",
    name: "THE DEAD MILE",
    hazard: "PIPELINE",
    hazardSub: "BURIED LINE · NO DIGGING",
    traderA: ["MILE 40 DEPOT", "DIESEL · WATER · BEDS"],
    traderB: ["PIPELINE SPARES", "VALVES · SEALS · HOSE"],
    notice: "NEXT AID STATION 61KM",
  },
};

export function signCopy(id: AnyTrackId): SignCopy {
  return COPY[id] ?? COPY.ash_spire;
}

export function allSignCopy(): Record<AnyTrackId, SignCopy> {
  return COPY;
}

/* ── the painter ──────────────────────────────────────────────────────── */

/**
 * The subset of the 2D context this file uses.
 *
 * Spelled out rather than taking `CanvasRenderingContext2D` so the gate script
 * can hand in a recorder and assert that every stroke of every face lands inside
 * its own cell. That check does not exist for the gantry atlas and it is exactly
 * the check that would have caught the banner-on-the-kerb inversion.
 */
export interface SignCanvasCtx {
  // Widened to the DOM's own union so a real `CanvasRenderingContext2D` is
  // assignable; nothing here ever writes anything but a colour string.
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number, maxWidth?: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
}

/** Canvas-pixel rect. */
type Box = { x: number; y: number; w: number; h: number };

function signCell(i: number): { face: Box; band: Box } {
  const col = i % SIGN_COLS;
  const row = Math.floor(i / SIGN_COLS);
  const x = col * SIGN_CELL_W;
  const y = row * CELL_H;
  const fh = Math.round(CELL_H * SIGN_FACE_FRAC);
  return {
    face: { x, y, w: SIGN_CELL_W, h: fh },
    band: { x, y: y + fh, w: SIGN_CELL_W, h: CELL_H - fh },
  };
}

function boardCell(i: number): { face: Box; band: Box } {
  const col = i % BOARD_COLS;
  const row = Math.floor(i / BOARD_COLS);
  const x = col * BOARD_CELL_W;
  const y = BOARD_ZONE_Y + row * CELL_H;
  const fh = Math.round(CELL_H * BOARD_FACE_FRAC);
  return {
    face: { x, y, w: BOARD_CELL_W, h: fh },
    band: { x, y: y + fh, w: BOARD_CELL_W, h: CELL_H - fh },
  };
}

/** Where the structural geometry samples, in unit-cell coordinates. */
export const STRUCT_UV_SIGN: readonly [number, number] = [
  0.5,
  (1 - SIGN_FACE_FRAC) * 0.5,
];
export const STRUCT_UV_BOARD: readonly [number, number] = [
  0.5,
  (1 - BOARD_FACE_FRAC) * 0.5,
];
/** The v range the artwork occupies, in unit-cell coordinates. */
export const FACE_V_SIGN: readonly [number, number] = [1 - SIGN_FACE_FRAC, 1];
export const FACE_V_BOARD: readonly [number, number] = [1 - BOARD_FACE_FRAC, 1];

/**
 * Rain streaking, rust bloom and pocks.
 *
 * Seeded, not `Math.random`. The gantry's version reseeds on every draw, which
 * is harmless there because it is drawn once; this atlas is redrawn on every
 * track change, and a sign whose dirt pattern reshuffles between races is a sign
 * the eye notices moving.
 *
 * The order is the order it happens on a real plate, and it matters: runoff
 * streaks come DOWN from the top edge and the fixings, rust blooms OUT from the
 * bolt holes, and the bullet pocks are on top of both because they are the most
 * recent thing to happen to it.
 */
function weather(g: SignCanvasCtx, b: Box, seed: number, strength = 1) {
  const rng = mulberry32(seed);
  g.save();
  g.beginPath();
  g.rect(b.x, b.y, b.w, b.h);
  g.clip();

  g.fillStyle = SIGN_PALETTE.streak;
  for (let i = 0; i < 40; i++) {
    g.globalAlpha = (0.06 + rng() * 0.1) * strength;
    const sx = b.x + rng() * b.w;
    const sw = 1 + rng() * 3.5;
    // Down from the TOP, not up from the bottom: water enters at the top edge.
    g.fillRect(sx, b.y, sw, b.h * (0.2 + rng() * 0.8));
  }

  // Bolt holes, and the rust that runs out of them. Four fixings, inset from
  // the corners, which is where the reference puts them.
  const bolts: [number, number][] = [
    [0.09, 0.16],
    [0.91, 0.16],
    [0.09, 0.84],
    [0.91, 0.84],
  ];
  for (const [u, v] of bolts) {
    const bx = b.x + b.w * u;
    const by = b.y + b.h * v;
    g.globalAlpha = 0.4 * strength;
    g.fillStyle = SIGN_PALETTE.ember;
    g.fillRect(bx - b.h * 0.05, by - b.h * 0.05, b.h * 0.1, b.h * 0.1);
    g.globalAlpha = 0.18 * strength;
    g.fillRect(bx - b.h * 0.02, by, b.h * 0.04, b.h * (0.1 + rng() * 0.35));
    g.globalAlpha = 0.75 * strength;
    g.fillStyle = SIGN_PALETTE.steel;
    g.beginPath();
    g.arc(bx, by, Math.max(1.2, b.h * 0.024), 0, Math.PI * 2);
    g.fill();
  }

  // Pocks. Small, dark, and clustered rather than evenly sprinkled — a plate is
  // shot at in bursts.
  g.fillStyle = SIGN_PALETTE.legend;
  let cx = b.x + b.w * rng();
  let cy = b.y + b.h * rng();
  for (let i = 0; i < 14; i++) {
    if (i % 5 === 0) {
      cx = b.x + b.w * rng();
      cy = b.y + b.h * rng();
    }
    g.globalAlpha = (0.35 + rng() * 0.4) * strength;
    const r = Math.max(0.8, b.h * (0.008 + rng() * 0.014));
    g.beginPath();
    g.arc(cx + (rng() - 0.5) * b.w * 0.22, cy + (rng() - 0.5) * b.h * 0.3, r, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

function border(g: SignCanvasCtx, b: Box, colour: string, t: number) {
  g.globalAlpha = 1;
  g.fillStyle = colour;
  g.fillRect(b.x, b.y, b.w, t);
  g.fillRect(b.x, b.y + b.h - t, b.w, t);
  g.fillRect(b.x, b.y, t, b.h);
  g.fillRect(b.x + b.w - t, b.y, t, b.h);
}

function ground(g: SignCanvasCtx, b: Box, colour: string) {
  g.globalAlpha = 1;
  g.fillStyle = colour;
  g.fillRect(b.x, b.y, b.w, b.h);
}

function text(
  g: SignCanvasCtx,
  s: string,
  cx: number,
  cy: number,
  px: number,
  colour: string,
  maxW: number,
  font = FONT_STENCIL,
) {
  g.globalAlpha = 1;
  g.fillStyle = colour;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${px}px ${font}`;
  g.fillText(s, cx, cy, maxW);
}

/**
 * The legend strip along the top of a warning plate, and the device area left
 * under it.
 *
 * Every warning plate in the reference pack has one, and it is the reason to
 * copy them: a bare symbol says "there is a corner", while a symbol with a
 * legend over it says which corner and how bad, in the player's language, at the
 * distance a headline is readable and a 20cm arrow is not. It is also how this
 * layer answers "more written signs" without adding a single instance.
 */
function header(
  g: SignCanvasCtx,
  b: Box,
  legend: string,
  onDark: boolean,
): Box {
  const hh = Math.round(b.h * 0.3);
  const strip: Box = { x: b.x, y: b.y, w: b.w, h: hh };
  ground(g, strip, onDark ? SIGN_PALETTE.sheet : SIGN_PALETTE.sheet);
  g.fillStyle = SIGN_PALETTE.ember;
  g.fillRect(b.x, b.y + hh - Math.max(2, b.h * 0.018), b.w, Math.max(2, b.h * 0.018));
  text(
    g,
    legend,
    b.x + b.w * 0.5,
    b.y + hh * 0.46,
    Math.round(hh * 0.72),
    SIGN_PALETTE.legend,
    b.w * 0.9,
  );
  return { x: b.x, y: b.y + hh, w: b.w, h: b.h - hh };
}

/**
 * A row of chevrons, pointing `dir` (-1 left, +1 right).
 *
 * Solid arrow heads, not two rotated bars — which is what the old
 * vertex-coloured plate was limited to. Two bars meeting at a point read as a
 * bent stick at any distance where the sign matters; a filled head keeps its
 * shape down to about eight pixels, which is where these are actually read.
 */
function chevrons(g: SignCanvasCtx, b: Box, dir: number) {
  const n = 3;
  const padX = b.w * 0.05;
  const slotW = (b.w - padX * 2) / n;
  const top = b.y + b.h * 0.14;
  const bot = b.y + b.h * 0.86;
  const midY = (top + bot) * 0.5;
  const thick = slotW * 0.5;
  g.globalAlpha = 1;
  g.fillStyle = SIGN_PALETTE.amber;
  for (let i = 0; i < n; i++) {
    const back = b.x + padX + slotW * i;
    const tip = back + slotW * 0.62;
    const x0 = dir > 0 ? back : b.x + b.w - (back - b.x);
    const x1 = dir > 0 ? tip : b.x + b.w - (tip - b.x);
    g.beginPath();
    g.moveTo(x1, midY);
    g.lineTo(x0, top);
    g.lineTo(x0 + (x1 - x0) * (thick / slotW) * 1.0, top);
    g.lineTo(x1 + (x1 - x0) * (thick / slotW), midY);
    g.lineTo(x0 + (x1 - x0) * (thick / slotW), bot);
    g.lineTo(x0, bot);
    g.closePath();
    g.fill();
  }
}

/**
 * A bend arrow: a shaft up the plate, an elbow, and a head pointing `dir`.
 *
 * `back` draws the hairpin variant, where the head returns toward the shaft —
 * which is the whole difference between "there is a corner" and "the road
 * doubles back on itself", and worth the extra six lines.
 *
 * The stem is stroked and the head is filled. A single filled outline loses its
 * stem first when it is minified, and a bend sign with no stem is a wedge.
 */
function bendArrow(g: SignCanvasCtx, b: Box, dir: number, back: boolean) {
  const cx = b.x + b.w * 0.5;
  const baseY = b.y + b.h * 0.9;
  const topY = b.y + b.h * 0.26;
  const reach = b.w * (back ? 0.17 : 0.24);
  const stemX = cx - dir * b.w * 0.14;
  g.globalAlpha = 1;
  g.strokeStyle = SIGN_PALETTE.legend;
  g.lineWidth = Math.max(4, b.h * 0.16);
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(stemX, baseY);
  g.quadraticCurveTo(stemX, topY, cx + dir * reach * 0.5, topY);
  if (back) {
    g.quadraticCurveTo(
      cx + dir * reach * 1.9,
      topY,
      cx + dir * reach * 1.4,
      b.y + b.h * 0.62,
    );
  } else {
    g.lineTo(cx + dir * reach, topY);
  }
  g.stroke();

  const hx = back ? cx + dir * reach * 1.4 : cx + dir * reach;
  const hy = back ? b.y + b.h * 0.62 : topY;
  const hs = b.h * 0.24;
  g.fillStyle = SIGN_PALETTE.legend;
  g.beginPath();
  if (back) {
    // Pointing back down the plate, toward the driver.
    g.moveTo(hx, hy + hs * 1.1);
    g.lineTo(hx - hs * 0.8, hy - hs * 0.3);
    g.lineTo(hx + hs * 0.8, hy - hs * 0.3);
  } else {
    g.moveTo(hx + dir * hs * 1.2, hy);
    g.lineTo(hx - dir * hs * 0.25, hy - hs);
    g.lineTo(hx - dir * hs * 0.25, hy + hs);
  }
  g.closePath();
  g.fill();

  // The dashed racing line trailing off the elbow, in amber. Straight from the
  // reference sheets, and it is what makes these read as a RACE circuit's signs
  // rather than a highway department's.
  g.fillStyle = SIGN_PALETTE.amber;
  for (let i = 0; i < 4; i++) {
    const t = 0.12 + i * 0.19;
    g.fillRect(stemX - dir * b.w * 0.1, baseY - (baseY - topY) * t, b.w * 0.05, b.h * 0.06);
  }
}

/**
 * Braking board: one huge numeral with an amber halo, a corner word, and
 * `bars` slashes under it.
 *
 * The halo is a stroke UNDER the fill rather than an outline over it, so the
 * numeral keeps its full weight. It is the single most distinctive thing in the
 * braking-board reference and it is also functional: a charcoal numeral on
 * bleached sheeting disappears into a dusty sky, and the amber edge is what
 * holds it together at 200m.
 */
function brakeBoard(
  g: SignCanvasCtx,
  b: Box,
  metres: number,
  bars: number,
  word: string,
) {
  const px = Math.round(b.h * 0.78);
  const cx = b.x + b.w * 0.42;
  const cy = b.y + b.h * 0.46;
  g.globalAlpha = 1;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${px}px ${FONT_STENCIL}`;
  g.strokeStyle = SIGN_PALETTE.amber;
  g.lineWidth = Math.max(3, b.h * 0.08);
  g.lineJoin = "round";
  g.strokeText(String(metres), cx, cy, b.w * 0.68);
  g.fillStyle = SIGN_PALETTE.legend;
  g.fillText(String(metres), cx, cy, b.w * 0.68);

  text(
    g,
    word,
    b.x + b.w * 0.82,
    b.y + b.h * 0.16,
    Math.round(b.h * 0.17),
    SIGN_PALETTE.amber,
    b.w * 0.32,
    FONT_PLAIN,
  );

  const bw = b.w * 0.09;
  const gap = b.w * 0.035;
  const total = bars * bw + (bars - 1) * gap;
  let x = b.x + b.w * 0.42 - total * 0.5;
  g.fillStyle = SIGN_PALETTE.legend;
  for (let i = 0; i < bars; i++) {
    g.beginPath();
    g.moveTo(x + bw * 0.4, b.y + b.h * 0.78);
    g.lineTo(x + bw, b.y + b.h * 0.78);
    g.lineTo(x + bw * 0.6, b.y + b.h * 0.94);
    g.lineTo(x, b.y + b.h * 0.94);
    g.closePath();
    g.fill();
    x += bw + gap;
  }
}

/** The league mark: a downward chevron cut with tally strokes. */
function leagueMark(g: SignCanvasCtx, cx: number, cy: number, r: number) {
  g.globalAlpha = 1;
  g.fillStyle = SIGN_PALETTE.amber;
  g.beginPath();
  g.moveTo(cx - r, cy - r * 0.72);
  g.lineTo(cx, cy + r * 0.36);
  g.lineTo(cx + r, cy - r * 0.72);
  g.lineTo(cx + r * 0.62, cy - r);
  g.lineTo(cx, cy - r * 0.18);
  g.lineTo(cx - r * 0.62, cy - r);
  g.closePath();
  g.fill();
  g.fillStyle = SIGN_PALETTE.charcoal;
  for (let i = 0; i < 5; i++) {
    g.fillRect(cx - r * 0.78 + i * r * 0.33, cy - r * 0.6, r * 0.09, r * 0.46);
  }
}

/** Diagonal hazard barring across a strip. */
function hazardBar(g: SignCanvasCtx, b: Box) {
  g.save();
  g.globalAlpha = 1;
  g.beginPath();
  g.rect(b.x, b.y, b.w, b.h);
  g.clip();
  g.fillStyle = SIGN_PALETTE.amber;
  g.fillRect(b.x, b.y, b.w, b.h);
  g.fillStyle = SIGN_PALETTE.legend;
  const p = b.h * 1.6;
  for (let x = -b.h * 2; x < b.w + b.h; x += p) {
    g.beginPath();
    g.moveTo(b.x + x, b.y + b.h);
    g.lineTo(b.x + x + b.h, b.y);
    g.lineTo(b.x + x + b.h + p * 0.45, b.y);
    g.lineTo(b.x + x + p * 0.45, b.y + b.h);
    g.closePath();
    g.fill();
  }
  g.restore();
}

/**
 * Draw the whole atlas.
 *
 * Every cell is painted, including ones the current circuit's layout will never
 * ask for. An unpainted cell is transparent black, and a plate that drew one
 * would be indistinguishable from a plate whose material failed to bind — which
 * is the exact ambiguity §4 of AGENTS.md is about.
 */
export function drawSignAtlas(g: SignCanvasCtx, copy: SignCopy) {
  g.globalAlpha = 1;
  g.fillStyle = SIGN_PALETTE.blank;
  g.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

  for (let i = 0; i < SIGN_FACE_COUNT; i++) {
    const { face, band } = signCell(i);
    // The structure band is painted BEFORE the face, so a face that overruns
    // its cell shows up in the atlas rather than being hidden by a later fill.
    g.globalAlpha = 1;
    g.fillStyle = SIGN_PALETTE.blank;
    g.fillRect(band.x, band.y, band.w, band.h);
    drawSignFace(g, i, face, copy);
  }
  for (let i = 0; i < BOARD_FACE_COUNT; i++) {
    const { face, band } = boardCell(i);
    g.globalAlpha = 1;
    g.fillStyle = SIGN_PALETTE.blank;
    g.fillRect(band.x, band.y, band.w, band.h);
    drawBoardFace(g, i, face, copy);
  }
  g.globalAlpha = 1;
}

function drawSignFace(g: SignCanvasCtx, i: number, b: Box, copy: SignCopy) {
  const P = SIGN_PALETTE;
  const cx = b.x + b.w * 0.5;
  const t = Math.max(3, Math.round(b.h * 0.05));

  switch (i) {
    case SIGN_FACE.chevronL:
    case SIGN_FACE.chevronR: {
      const left = i === SIGN_FACE.chevronL;
      ground(g, b, P.charcoal);
      chevrons(g, header(g, b, left ? "SHARP LEFT" : "SHARP RIGHT", true), left ? -1 : 1);
      border(g, b, P.legend, t);
      break;
    }

    case SIGN_FACE.bendL:
    case SIGN_FACE.bendR: {
      const left = i === SIGN_FACE.bendL;
      ground(g, b, P.sheet);
      bendArrow(g, header(g, b, left ? "LEFT BEND" : "RIGHT BEND", false), left ? -1 : 1, false);
      border(g, b, P.legend, t);
      break;
    }

    case SIGN_FACE.hairpinL:
    case SIGN_FACE.hairpinR: {
      const left = i === SIGN_FACE.hairpinL;
      ground(g, b, P.sheet);
      bendArrow(g, header(g, b, left ? "HAIRPIN LEFT" : "HAIRPIN RIGHT", false), left ? -1 : 1, true);
      border(g, b, P.ember, t);
      break;
    }

    case SIGN_FACE.brake150:
      ground(g, b, P.sheet);
      border(g, b, P.legend, t);
      brakeBoard(g, inset(b, t * 2), 150, 3, "BRAKE");
      break;
    case SIGN_FACE.brake100:
      ground(g, b, P.sheet);
      border(g, b, P.legend, t);
      brakeBoard(g, inset(b, t * 2), 100, 2, "ZONE");
      break;
    case SIGN_FACE.brake50:
      ground(g, b, P.sheet);
      border(g, b, P.ember, t);
      brakeBoard(g, inset(b, t * 2), 50, 1, "MARK");
      break;

    case SIGN_FACE.sector1:
    case SIGN_FACE.sector2:
    case SIGN_FACE.sector3: {
      const n = i - SIGN_FACE.sector1 + 1;
      ground(g, b, P.charcoal);
      border(g, b, P.amber, t);
      text(g, `SECTOR ${n}`, cx, b.y + b.h * 0.36, Math.round(b.h * 0.36), P.sheet, b.w * 0.84);
      g.fillStyle = P.amber;
      g.fillRect(b.x + b.w * 0.12, b.y + b.h * 0.6, b.w * 0.76, Math.max(2, t * 0.7));
      text(g, copy.short, cx, b.y + b.h * 0.79, Math.round(b.h * 0.2), P.amber, b.w * 0.84, FONT_PLAIN);
      break;
    }

    case SIGN_FACE.route:
      // Painted steel, not sheeting: a league route marker is sprayed through a
      // stencil onto whatever plate was to hand.
      ground(g, b, P.charcoal);
      border(g, b, P.steel, Math.max(2, t * 0.6));
      leagueMark(g, cx, b.y + b.h * 0.33, b.h * 0.23);
      text(g, copy.short, cx, b.y + b.h * 0.74, Math.round(b.h * 0.26), P.sheet, b.w * 0.86);
      break;

    case SIGN_FACE.hazard: {
      const bar = Math.round(b.h * 0.2);
      ground(g, b, P.sheet);
      hazardBar(g, { x: b.x, y: b.y, w: b.w, h: bar });
      hazardBar(g, { x: b.x, y: b.y + b.h - bar, w: b.w, h: bar });
      text(g, copy.hazard, cx, b.y + b.h * 0.43, Math.round(b.h * 0.26), P.legend, b.w * 0.88);
      text(g, copy.hazardSub, cx, b.y + b.h * 0.65, Math.round(b.h * 0.13), P.legend, b.w * 0.88, FONT_PLAIN);
      break;
    }

    case SIGN_FACE.crest: {
      ground(g, b, P.sheet);
      const dev = header(g, b, "CREST", false);
      // A filled hump on a ground line. The standard read, and the only one
      // that survives being three pixels tall.
      g.globalAlpha = 1;
      g.fillStyle = P.legend;
      g.beginPath();
      g.moveTo(dev.x + dev.w * 0.14, dev.y + dev.h * 0.78);
      g.quadraticCurveTo(
        dev.x + dev.w * 0.5,
        dev.y - dev.h * 0.22,
        dev.x + dev.w * 0.86,
        dev.y + dev.h * 0.78,
      );
      g.lineTo(dev.x + dev.w * 0.86, dev.y + dev.h * 0.9);
      g.lineTo(dev.x + dev.w * 0.14, dev.y + dev.h * 0.9);
      g.closePath();
      g.fill();
      border(g, b, P.legend, t);
      break;
    }

    case SIGN_FACE.narrows:
    default: {
      ground(g, b, P.sheet);
      const dev = header(g, b, "ROAD NARROWS", false);
      g.globalAlpha = 1;
      g.strokeStyle = P.legend;
      g.lineWidth = Math.max(4, dev.h * 0.16);
      g.lineJoin = "round";
      for (const s of [-1, 1] as const) {
        g.beginPath();
        g.moveTo(cx + s * dev.w * 0.3, dev.y + dev.h * 0.86);
        g.lineTo(cx + s * dev.w * 0.1, dev.y + dev.h * 0.14);
        g.stroke();
      }
      border(g, b, P.legend, t);
      break;
    }
  }
  weather(g, b, 0x51a7 + i * 977, 1);
}

function inset(b: Box, t: number): Box {
  return { x: b.x + t, y: b.y + t, w: b.w - t * 2, h: b.h - t * 2 };
}

function drawBoardFace(g: SignCanvasCtx, i: number, b: Box, copy: SignCopy) {
  const P = SIGN_PALETTE;
  const cx = b.x + b.w * 0.5;
  const t = Math.max(3, Math.round(b.h * 0.05));

  switch (i) {
    case BOARD_FACE.league:
      ground(g, b, P.charcoal);
      g.fillStyle = P.ember;
      g.fillRect(b.x, b.y + b.h * 0.76, b.w, Math.max(3, b.h * 0.07));
      leagueMark(g, b.x + b.w * 0.11, b.y + b.h * 0.4, b.h * 0.26);
      text(g, "SCRAPSTORM", b.x + b.w * 0.58, b.y + b.h * 0.34, Math.round(b.h * 0.4), P.sheet, b.w * 0.74);
      text(g, "S A L V A G E   L E A G U E", b.x + b.w * 0.58, b.y + b.h * 0.61, Math.round(b.h * 0.15), P.amber, b.w * 0.74, FONT_PLAIN);
      break;

    case BOARD_FACE.circuit:
      ground(g, b, P.charcoal);
      border(g, b, P.amber, t);
      text(g, copy.name, cx, b.y + b.h * 0.38, Math.round(b.h * 0.3), P.amber, b.w * 0.86);
      text(g, "SANCTIONED ROUND · OPEN CLASS", cx, b.y + b.h * 0.71, Math.round(b.h * 0.14), P.sheet, b.w * 0.86, FONT_PLAIN);
      break;

    case BOARD_FACE.timing:
      ground(g, b, P.sheet);
      border(g, b, P.legend, t);
      text(g, "SECTOR TIMING ACTIVE", cx, b.y + b.h * 0.33, Math.round(b.h * 0.24), P.legend, b.w * 0.86);
      g.fillStyle = P.ember;
      g.fillRect(b.x + b.w * 0.1, b.y + b.h * 0.52, b.w * 0.8, Math.max(2, b.h * 0.045));
      text(g, "TRANSPONDER MUST BE FITTED AND LIVE", cx, b.y + b.h * 0.72, Math.round(b.h * 0.13), P.legend, b.w * 0.86, FONT_PLAIN);
      break;

    case BOARD_FACE.traderA:
      ground(g, b, P.sheet);
      g.fillStyle = P.charcoal;
      g.fillRect(b.x, b.y, b.w, b.h * 0.44);
      text(g, copy.traderA[0], cx, b.y + b.h * 0.22, Math.round(b.h * 0.3), P.amber, b.w * 0.9);
      text(g, copy.traderA[1], cx, b.y + b.h * 0.63, Math.round(b.h * 0.2), P.ember, b.w * 0.9);
      text(g, "NO QUESTIONS · CASH ONLY", cx, b.y + b.h * 0.86, Math.round(b.h * 0.12), P.legend, b.w * 0.9, FONT_PLAIN);
      break;

    case BOARD_FACE.traderB:
      ground(g, b, P.sheetOld);
      g.fillStyle = P.amber;
      g.fillRect(b.x, b.y, b.w, b.h * 0.34);
      text(g, copy.traderB[0], cx, b.y + b.h * 0.17, Math.round(b.h * 0.24), P.charcoal, b.w * 0.9);
      text(g, copy.traderB[1], cx, b.y + b.h * 0.6, Math.round(b.h * 0.22), P.legend, b.w * 0.9);
      break;

    case BOARD_FACE.notice:
    default: {
      const bar = Math.round(b.h * 0.16);
      ground(g, b, P.sheet);
      hazardBar(g, { x: b.x, y: b.y + b.h - bar, w: b.w, h: bar });
      text(g, copy.notice, cx, b.y + b.h * 0.34, Math.round(b.h * 0.22), P.legend, b.w * 0.9);
      text(g, "LEAGUE MARSHALS DO NOT ATTEND", cx, b.y + b.h * 0.63, Math.round(b.h * 0.13), P.legend, b.w * 0.9, FONT_PLAIN);
      break;
    }
  }
  weather(g, b, 0x9d2b + i * 613, 0.85);
}


/**
 * The vertex-shader insert that makes one InstancedMesh carry many faces.
 *
 * three has no per-instance UV. The alternatives were a geometry (and therefore
 * a draw call) per face, or this. It is applied through `onBeforeCompile`, which
 * is a string surgery on a chunk name — and a string surgery that silently no-ops
 * gives EVERY sign on the circuit the same picture, which is precisely the class
 * of failure this project has shipped twice (a fallback masking a mesh that never
 * decoded, and a `k < 3` loop bound).
 *
 * So the patch is exported as a pure function of the shader source, it throws
 * when its anchor is missing, and `scripts/check-setpiece-footprints.mjs` runs it
 * against `THREE.ShaderLib.standard` — the very string the renderer will hand it
 * — so an upstream chunk rename fails a gate instead of flattening the signage.
 */
export const SIGN_UV_ANCHOR = "#include <uv_vertex>";

export function patchSignVertexShader(src: string): string {
  if (!src.includes(SIGN_UV_ANCHOR)) {
    throw new Error(
      `signFaces: cannot find "${SIGN_UV_ANCHOR}" in the vertex shader. ` +
        "three has renamed or removed the chunk; per-instance sign faces would " +
        "silently collapse to one picture without this insert.",
    );
  }
  return (
    "attribute vec4 aSignUv;\n" +
    src.replace(
      SIGN_UV_ANCHOR,
      `${SIGN_UV_ANCHOR}\n` +
        "#ifdef USE_MAP\n" +
        // uv_vertex has already written vMapUv from the geometry's own uv, which
        // is authored in UNIT-CELL space; this maps that cell onto the instance's
        // rect in the atlas. Doing it here rather than in the fragment shader
        // keeps it one madd per vertex instead of one per pixel.
        "  vMapUv = aSignUv.xy + vMapUv * aSignUv.zw;\n" +
        "#endif",
    )
  );
}
