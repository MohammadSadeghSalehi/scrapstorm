# Working on Scrapstorm League

For agents picking this up cold. Everything here was learned by getting it
wrong first; none of it is style preference.

**What this is:** a browser combat racer — React + Three.js + @react-three/fiber
+ @react-three/postprocessing, TypeScript, Vite. The target is a combat version
of Need for Speed Most Wanted 2005. Tagged `v1.0.0`.

---

## 1. The one rule that matters

**Never report a fix you have not driven.** This project shipped the same three
bugs "fixed" across multiple rounds because a code reading looked correct:

- weapon meshes that never decoded, silently masked by a fallback
- a projectile slot permanently invisible from a `k < 3` loop bound
- props double-offset across two files that were each correct in isolation

And the harnesses lie too. A guard-rail check was written **four times** and was
wrong four different ways: sampling verge points where rails are not, probing
`m.x/m.z` on objects that are line segments, probing a segment midpoint that hits
a degenerate-distance guard, and collecting a **shared mutable result object** N
times so `.filter()` only ever saw the last value. The rails had worked
throughout.

So: drive the real module, print numbers, and when a result is suspiciously
clean *or* suspiciously damning, suspect the check before the code. Say plainly
what is measured and what is inferred.

---

## 2. Gates — run before claiming anything

All headless, no renderer, safe while the user is playing.

```bash
node node_modules/typescript/bin/tsc --noEmit
node scripts/mission-smoke.mjs             # 743 checks, real GameSimulation
node scripts/balance-classes.mjs           # 432 races/class, win rate + position
node scripts/balance-grid.mjs              # grid geometry in the track frame
node scripts/check-track-profile.mjs       # road discontinuity, jump launch speed
node scripts/check-setpiece-footprints.mjs
node scripts/probe-audio.mjs               # 68 DSP assertions, Web Audio stubbed
```

`scripts/perf-probe.mjs` uses Playwright — see §3 before running it.

Each exists because something shipped broken while looking correct. Extend them
rather than adding a parallel one.

---

## 3. Machine safety — non-negotiable

A parallel software-GL sweep once froze this machine and cost the user a reboot.

- **Never run two browsers at once.** One Playwright process, `taskset -c 0-5`,
  `nice -n 19`, viewport ≤ 1280×720, one tier per run, hard `timeout`.
- The dev server may already be running on 8081 — check before starting another.
- Subagents must be told explicitly not to run `qa-visual.mjs`, `perf-probe.mjs`,
  a dev server, or a browser. They will otherwise, and concurrent runs corrupt
  each other's numbers.

Dev server (WSL; first request costs 10–40s of cold transform — absorb it with
`curl` before handing the URL to the user):

```bash
wsl.exe -e bash -lc 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null; cd /mnt/c/Users/sadeg/scrapstorm-league-source && node node_modules/vite/bin/vite.js dev --host 0.0.0.0 --port 8081'
```

---

## 4. Traps that silently invalidate work

**`export let` does not survive jiti.** It is a live binding under real ESM, but
jiti transpiles to CJS and snapshots the namespace property at module init. So
after `setActiveTrack("cinder_bowl")`, reading `TRACK_SAMPLES` returns
*ash_spire's* array while `getActiveTrackId()` correctly reports the new id —
a check that looks like it passes. Use `getTrackSamples()`, `getCheckpoints()`,
`getEdgeMarkers()`, `getScenery()`. **Hit five times.**

**Vite caches the public directory listing at startup.** A newly added file
under `public/` 404s no matter how many reloads; a *regenerated* file at a known
path works fine. Restart the server after adding assets. Cost an hour twice.

**Every generated `.glb` requires `EXT_meshopt_compression`.** A bare
`new GLTFLoader()` rejects them, calls `onError`, and the caller silently keeps
its placeholder. Use `createGltfLoader()` from `world/gltfLoaders.ts`. This is
why the weapon art was invisible for three rounds — and why a graceful fallback
should still `console.warn`: it made total failure indistinguishable from
working.

**r3f stops rendering if any `useFrame` declares priority > 0.** This scene has
thirty. The EffectComposer (priority 1) was the only thing drawing, so low tier
rendered **zero draw calls while reporting 161.8 fps**. Anything that renders
outside the composer needs an explicit `SceneRenderer` at priority 1.

**`capsuleContact` returns a shared mutable object** (allocation-free by design).
Read it immediately; never collect results into an array.

**Ground truth is `getGroundHeight(x, z)`.** Never a literal `y`, never a track
sample's `y` — that is the *road plane*, and the desert climbs well above it off
the tarmac. This bug class recurred more than any other.

---

## 5. Architecture, briefly

```
src/game/
  sim.ts, physics.ts, tires.ts, combat.ts, ai.ts   fixed 1/60 step, deterministic
  track.ts          circuits as Catmull-Rom control lists + surface queries
  worldProps.ts     barrels/crates/posts, collision response
  setpieceColliders.ts   static capsules, 24m broadphase grid
  missions/         objectives, 15-rival ladder, career, story
  audio/            buses, engine/tyre/brake models, VO budget, reverb zones
  world/            everything three.js — never import this from the sim
    environments/   one EnvironmentDef per circuit drives sky/light/terrain/grade
    setpieces/      per-circuit built structure
    scatter/        instanced fields, guard rail, verge drift
    vfx/, damage/   pooled particles, procedural deformation, craters
src/components/game/   React shell, HUD, menus, cutscenes
```

**The sim must stay renderer-free.** `mission-smoke.mjs` constructs a real
`GameSimulation` headlessly; anything that pulls `three` into that graph breaks
it. `setpieceColliders.ts` imports scatter *placement* functions directly rather
than the package index for exactly this reason.

---

## 6. Design decisions that look wrong until explained

- **Static collision deflects, never impulses.** A static prop has
  `invSum = 1/massV`, so the shared restitution impulse works out to
  `-(1+e) × approach` and throws the car backwards. `deflectOffStatic()` cancels
  the normal component and keeps the tangential. Do not write a second one.
- **Guard rails break on the normal component, not on speed.** That is what makes
  them Armco rather than a wall: a glancing brush at 30 m/s holds and redirects;
  a 30° excursion at 25 m/s takes 7m of rail down.
- **The bruiser cannot win a race.** Measured with weapons cold: 2.8% win rate
  against 56.5% / 40.7%. It wins a *fight*, and the fight is worth exactly its
  pace deficit. Judge class balance with combat on.
- **Raising hull is not neutral.** It lengthens every fight, and a longer fight
  is worth less than a faster lap. +45% hull alone moved the three-way spread
  from 3.5 to 23.6 points. Scale damage with it.
- **A jump zone tag is a section-length decision.** `max grade = 8.41/L`,
  `launch speed = 0.317·L`. One global lift constant cannot serve six circuits.
- **Cutscenes must be keyed by id.** Reusing the component instance leaves its
  one-shot guard set from the previous clip, and the sequence hangs forever.

---

## 7. Conventions

- Commit from **WSL** as `MohammadSadeghSalehi <sadeghsalehi1997@gmail.com>`,
  always `git commit -F <file>` — apostrophes in messages break the nested shell
  quoting, repeatedly.
- Commit messages explain **why**, and record what was measured and what was
  rejected. They are the project's real design record.
- Comments explain why a naive implementation would be wrong, not what the line
  does. No changelog comments.
- `public/assets/` is gitignored by design. **Scripts are the deliverable**,
  binaries are reproducible: `import-meshgen.mjs`, `import-videos.mjs`,
  `gen-refs.mjs`, `gen-music.mjs`, `gen-vo.mjs`, `compress-textures.mjs`.
- The ElevenLabs key lives in `.env` and is gitignored. Never print or log it.
- Music prompts name **no artist** — instrumentation, tempo, key, production era
  only.

---

## 8. Known open items

1. **Weapon mounts float** rather than seating. The measured roof table
   (1.16m → 3.11m) is correct, so the error is in the seating maths. Measure it;
   do not guess.
2. **Generated weapon meshes floor at ~11.6k triangles.** Surface reconstruction
   produces thousands of disconnected shells and meshoptimizer preserves
   component count, so no flag goes lower. Needs a voxel remesh in Blender.
3. **No GI or baked lightmaps**, one shadow cascade. CSM was tried and reverted
   (151 → 81 fps) — it adds a directional light per cascade and needs
   `csm.setupMaterial` at material *creation* time.
4. KTX2 unavailable locally; GLB textures fall back to WebP. Worth ~25MB across
   the cars if `ktx` is installed.
5. The `title` cutscene is imported and serving but has no title card to hold
   under.

---

## 9. Before proposing performance work, say this

**Chromium picks the integrated GPU by default on this machine.** Measured:
25.3 fps on the Intel iGPU against **92.2 fps on the RTX 5080** — and the fast
one renders 2.8× the pixels, because the adaptive scaler stops cutting
resolution. Windows Graphics Settings, per browser.

A 102 → 14 fps regression was chased for weeks as a code problem and was mostly
this. Other things already measured and **exonerated**: the post chain (14% of
frame), `dprMax`, and GC/allocation (0 long tasks over 962 frames — the
"29 MB/s" figure came from a metric that misreported known allocations by 100×).
The real remaining target is that **N8AO costs ~25× more main-thread time than
GPU time**.
