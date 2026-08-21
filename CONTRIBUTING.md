# Contributing

Read `AGENTS.md` first. It is the project constitution. This file is the short
human version.

## Before you claim a fix

Drive the real module. Print numbers. A screenshot of a black canvas at 160 fps
is not a working renderer. Never report a visual fix you have not seen in a
browser.

## One browser at a time

Playwright, `qa-visual.mjs`, and `perf-probe.mjs` must not overlap. Viewport at
most 1280×720. The machine has frozen from two software-GL sessions.

## Gates (run these, in this order)

```bash
npm run typecheck
node scripts/mission-smoke.mjs
node scripts/balance-classes.mjs
node scripts/balance-grid.mjs
node scripts/check-track-profile.mjs
node scripts/check-setpiece-footprints.mjs
node scripts/probe-audio.mjs
```

`mission-smoke.mjs` constructs a real `GameSimulation` with no renderer. Do not
import `three` into the sim graph.

## Architecture that must not drift

- `src/game/sim.ts` and friends stay renderer-free.
- Track data: `getTrackSamples()`, never a captured `TRACK_SAMPLES` binding.
- Ground: `getGroundHeight(x, z)`, never a literal `y`.
- Generated GLBs: `createGltfLoader()` (Meshopt). A bare `GLTFLoader` fails
  silently and keeps the placeholder.
- r3f: any `useFrame` priority > 0 disables the default renderer. Low tier
  needs `SceneRenderer`.

## Assets

Binaries are not in git. `node scripts/fetch-assets.mjs` restores
`public/assets/` from Hugging Face. New art: add the file to the HF dataset,
add a sha256 line to the manifest, cite the license in `NOTICE` and
`public/assets/SOURCES.md`.

## Pull requests

- One concern per PR.
- Say what you measured and what you rejected.
- Do not bump `dprMax` or disable the composer to "fix" frame time.
