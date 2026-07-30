# Scrapstorm League — Local Dev Handoff

**What it is:** Browser 3D combat racer (arcade). React + TanStack Start + Three.js / R3F. Single-player heats with AI, class abilities, scrap meta, two tracks, ghosts.

**Not a monorepo.** App root = this folder. No git history is checked in here (sandbox had none) — init git yourself after copy.

---

## Quick start

```bash
# Requirements: Node 22+, modern Chromium/Firefox with WebGL2
cd scrapstorm-league   # or whatever you named the copy

# Prefer a clean install (node_modules from the sandbox may be Linux-only)
rm -rf node_modules
npm ci                 # or: npm install

npm run dev            # http://localhost:8080  (binds 0.0.0.0:8080)
```

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite + TanStack Start on **0.0.0.0:8080** |
| `npm run build` | Production build (Nitro → Vercel preset) + DB migrate |
| `npm run preview` | Serve production build on 8080 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:migrate` | PGLite / SQL migrations (`scripts/migrate.mjs`) |

Open **http://localhost:8080** — the game is the `/` route (`ScrapstormApp`).

### Optional: copy from this workspace

If you still have access to the sandbox tree:

```bash
# Exclude huge / regenerable junk
rsync -a --exclude node_modules --exclude .tanstack --exclude screenshots \
  --exclude artifacts --exclude .vercel \
  /workspace/ ./scrapstorm-league/
cd scrapstorm-league && npm ci && npm run dev
```

**Keep:** `src/`, `public/` (especially `public/assets/`), `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `scripts/`, `migrations/`.

**Safe to drop:** `node_modules/`, `screenshots/`, `artifacts/`, `.tanstack/`, `.vercel/`, `startup.sh` (sandbox-only revive hook).

**Size note:** `public/assets` is ~**430MB** (custom cars ~11MB each ×3, Amara props ~204MB, Polyhaven ~89MB). You need those GLBs for the current look.

---

## Stack

| Layer | Choice |
|-------|--------|
| UI / app shell | React 19, TanStack Router + Start, Tailwind v4 |
| 3D | Three **r185**, `@react-three/fiber`, `@react-three/drei`, postprocessing |
| State | In-memory `GameSimulation` (`src/game/sim.ts`) + React shell state |
| Meta / scrap | `localStorage` via `src/game/meta.ts` |
| DB (optional) | PGLite (`@electric-sql/pglite`) + Kysely — mostly auth/template, not race logic |
| Auth | better-auth scaffolding under `src/lib/auth` (game does not require login) |
| Deploy target | Vite build + Nitro `vercel` preset (gated to `command === "build"`) |

Path alias: `@/*` → `./src/*`.

---

## Project map

```
src/
  routes/
    index.tsx              → mounts ScrapstormApp
    __root.tsx
    api/rtc.ts             → P2P signaling stub
  components/game/
    ScrapstormApp.tsx      → shell UI, boot, garage, race lifecycle
    GameHUD.tsx            → in-race HUD / minimap / abilities
    Menus.tsx              → menu / garage chrome
    MobileControls.tsx
    GraphicsDebug.tsx      → backtick ` debug overlay
  game/
    sim.ts                 → race loop, phases, lap/position, AI tick glue
    physics.ts             → accel, brake, drag, collisions
    tires.ts               → spring-damper, temp, grip
    balance.ts             → torque / handling constants
    classes.ts             → interceptor / trickster / bruiser
    combat.ts              → weapons / abilities
    ai.ts                  → bot steering
    track.ts               → track samples, checkpoints, corridors
    input.ts               → keyboard + touch
    types.ts               → VehicleState, phases, input
    meta.ts                → scrap, paints, records
    story.ts               → VO / brief copy
    vehicles/
      GltfCar.tsx          → CUSTOM GLB load + orient + materials (player+AI)
      meshes.tsx           → procedural ModularVehicleMesh fallback
      PilotMesh.tsx
    world/
      GameScene.tsx        → R3F canvas, showcase vs race, cameras
      TrackMesh.tsx        → road ribbon + compact start gantry
      HeightmapTerrain.tsx
      Atmosphere.tsx, Effects.tsx, PostFX.tsx
      quality.ts           → adaptive low/med/high tiers
      culling/             → CPU terrain / edge / debris cull
      webgl2/              → renderer config, PBR texture library
      polyHavenAssets.ts
    audio/                 → procedural + sample bank
  lib/                     → auth, db, multiplayer helpers (secondary)
public/assets/meshes/
  custom/                  → ★ primary race cars (3× ~11MB GLB)
  characters/              → pilot
  kenney/                  → fallback only if custom load fails
  amara/, polyhaven/, …    → props / scenery
```

### Boot path (important)

1. `ScrapstormApp` paints shell menu **first** (no Three on critical path).
2. Engine (`GameScene` + R3F) **dynamic-imports** after menu.
3. Race uses `RaceWorld`; garage/menu uses lighter `ShowcaseWorld`.
4. Car models: `GltfCar` → `MODEL_URL` customs for **every** class (player + AI).

Do not reintroduce Kenney as default AI unless you intentionally want LODs.

---

## Controls

| Action | Keys |
|--------|------|
| Steer | **A / D** or ← → |
| Throttle | **W** / ↑ (auto-accel on by default ~0.78) |
| Brake / reverse | **S** / ↓ |
| **Boost** | **E** or **R** (not W) |
| Primary fire | **J** or Space |
| Defense | **K** |
| Ultimate | **L** |
| Pause | **Esc** or **P** |
| Graphics debug | `` ` `` (backtick) |

Touch: `MobileControls` + haptics.

---

## Vehicle meshes (current truth)

Files (must exist under `public/`):

```
public/assets/meshes/custom/SM_MeshGen_WastelandCustomCar.glb      → interceptor
public/assets/meshes/custom/SM_MeshGen_CustomWidebodyHatchback.glb  → trickster
public/assets/meshes/custom/SM_MeshGen_DesertCombatVehicle.glb      → bruiser
public/assets/meshes/characters/SM_MeshGen_FemaleRacerSuitHelmet.glb
```

Logic lives in [`src/game/vehicles/GltfCar.tsx`](src/game/vehicles/GltfCar.tsx):

- `MODEL_URL` / `AI_URL` — both point at customs.
- `CUSTOM_ORIENT` — **calibrated Euler** per mesh so length is on **Z**, nose drive-forward:
  - Wasteland: `[0, -π/2, 0]`
  - Hatch: `[0, π, 0]`
  - Desert combat: `[0, π, 0]` (tall roof gun is intentional)
- Materials: **ignore** MeshGen metalness maps (`metallicFactor=1` made cars black). Fixed metalness ~0.18, roughness ~0.55, slight albedo boost.
- Fallback: `kenney/race.glb` only if load throws.
- Debug: `window.__carDebug` after player mesh mounts.

If a new GLB faces wrong: edit `CUSTOM_ORIENT` only — do not re-enable height heuristics first.

---

## Race / world systems

| System | File | Notes |
|--------|------|-------|
| Phases | `sim.ts` | menu → garage → countdown → racing → finished |
| Physics | `physics.ts` + `tires.ts` + `balance.ts` | Fixed step ~1/60, multi-step catch-up capped |
| Track | `track.ts` + `TrackMesh.tsx` | Corridor flatten on heightfield; compact start gantry (no full-road FOV planes) |
| Terrain | `HeightmapTerrain.tsx` + `terrainHeight.ts` | Dune field sample for ride height |
| Quality | `quality.ts` | Adaptive FPS tiers; PostFX high-only dynamic import |
| Frame order | `framePriority.ts` | SIM (−10) before POSE (0) — do not reverse |
| AI | `ai.ts` | Single-player only |
| Ghosts | `ghost.ts`, `ghostDuel.ts` | PB + rival code duel |

### Browser debug hooks (dev console)

```js
window.__scrapstorm          // getState, startRace, pause, resume, restart
window.__carDebug            // player mesh url, kenney?, size, orient
window.__playerMesh          // live pose
window.__quality.get()       // tier
window.__quality.setTier('high'|'medium'|'low', { auto: false })
window.__terrainCull         // cull stats
window.__webgl2Caps
```

Example:

```js
window.__scrapstorm.startRace()
// wait countdown…
window.__carDebug
```

---

## Known issues / watchlist

1. **Custom GLBs are heavy** (~11MB each ×3 classes). First race pays network + decode cost. Consider meshopt/Draco re-export or AI LOD later.
2. **MeshGen materials** are not production ORM; code deliberately strips metalness maps. Don’t “fix” by restoring GLB metalness without checking.
3. **Typecheck:** only known pre-existing noise is `GraphicsDebug.tsx` (`isWebGL2` on loose window type). Game code should be clean.
4. **`vite.config.ts`:** keep `nitro({ preset: "vercel" })` **build-only**. Enabling in dev opens a second port and breaks single-port preview.
5. **Port 8080 / host 0.0.0.0** is the Grok preview contract; locally you can change to 5173 if you want — only matters if you keep that config.
6. **No `.gitignore`** in the sandbox tree — add one before first commit (see below).
7. **Auth / PGLite / P2P** are template scaffolding; race does not depend on them. DB bootstrap runs on dev server start (`pgliteBootstrapPlugin`).
8. **Orientation QA** is best on a real GPU (SwiftShader under-lights dark wasteland albedo).
9. **Start gantry** was previously a ~23m DoubleSide plane that filled the FOV — current code uses compact poles + small board + thin road paint boxes only. Don’t reintroduce full-width planes.

### Recent fix log (as of handoff)

- Shell-first boot (dynamic import engine) to fix terrible initial load.
- Restored custom meshes for all racers (not Kenney AI).
- Material metalness clamp + orient calibration per class.
- Compact start gantry; removed FOV-blocking start planes.
- Boost = **E** (HUD + `input.ts`).

---

## Suggested `.gitignore`

```gitignore
node_modules/
dist/
.output/
.vercel/
.tanstack/
.DS_Store
*.log
screenshots/
artifacts/
.env
.env.*
!.env.example
```

---

## Local workflow tips

### Iterate on cars

1. Drop GLB into `public/assets/meshes/custom/`.
2. Point `MODEL_URL` in `GltfCar.tsx`.
3. Set `CUSTOM_ORIENT` via garage orbit + `window.__carDebug.size` (want long axis on Z, height ~1.2–2.5m for normal cars).
4. Hard refresh if browser caches old GLB (or rename file).

### Iterate on physics feel

- `balance.ts` — torque curve, drag, handling thresholds (drift boost).
- `tires.ts` — grip, temp, compress.
- `physics.ts` — collisions, grid soft collisions, reverse-speed clamps.

### Iterate on track

- `track.ts` — centerline samples, width, checkpoints.
- `TrackMesh.tsx` / `culling/roadSegments.ts` — ribbon build.
- `HeightmapTerrain.tsx` + corridor flatten in terrain sampling.

### Performance

```js
window.__quality.setTier('medium', { auto: false })
window.__quality.getFps()
```

PostFX and heavy shadows are tier-gated. AI cars use `MeshStandard` (no clearcoat); hero on high uses `MeshPhysical`.

### QA scripts (optional)

`scripts/` has Playwright helpers used in the sandbox (`browser-smoke.mjs`, various `qa-*.mjs`). Useful if you install Playwright browsers:

```bash
npx playwright install chromium
node scripts/browser-smoke.mjs http://127.0.0.1:8080/
```

---

## Deploy (Vercel-shaped)

```bash
npm run build    # must pass; Nitro vercel preset only on build
npm run preview  # smoke the built output locally
```

Watch for blank prod pages: asset base path / MIME type `text/html` on JS modules means SPA fallback is swallowing `/assets/*`. Dev HMR can work while prod is blank — always check `preview` after build.

---

## Design notes (product)

- **Classes:** Interceptor (speed), Trickster (tricks / phase), Bruiser (armor / cannon).
- **Tracks:** Ash Spire Circuit, Cinder Bowl.
- **Meta:** scrap currency, paints, win/heat records (`meta.ts`).
- **Tone:** outlaw wasteland combat racing — grit, not clean sim-racer chrome.
- Roadmap snapshot: `src/game/AAA_ROADMAP.md` (phases A–C marked done; multiplayer live + WebGPU later).

---

## First commits after clone

```bash
git init
# add .gitignore from above
git add .
git commit -m "Import Scrapstorm League — local handoff baseline"
npm ci
npm run dev
npm run typecheck
```

Then verify in browser: **Enter garage → pick class → Race → countdown shows custom mesh (not Kenney toy) → no gray wall in FOV → E Boost works**.

Good hunting.
