# Scrapstorm-Bench

A harness for scoring language models on a **real-time 3D game**, not a toy
canvas demo.

The point is whether the model can keep physics, rendering, assets, and frame
time honest. A black canvas at 160 fps is a fail.

## Track A — regression (runs today)

Headless. No browser. No GPU.

```bash
npm run bench:smoke
```

Wraps the existing gates: typecheck, mission-smoke, track profile, setpiece
footprints, audio DSP, grid geometry.

CI runs the same set on every push to `main`.

## Track B — agent tickets (specified, not frozen)

Each ticket is a git tag `bench/Txx-<slug>`, a failing tree, a player-visible
spec in `benches/tickets/`, and hidden tests. Prompts must not include the
patch.

Candidates from this codebase's real traps (see `AGENTS.md`):

- Meshopt GLB silent fallback
- `export let` / jiti snapshot of track samples
- shared mutable `capsuleContact`
- r3f `useFrame` priority > 0 black canvas
- ground height vs road-plane `y`
- race-gate watchdog firing before the world mounts

Do not add tickets until those tags are frozen.

## Track C — one-shot / few-shot development (specified)

- **C1** From a 2–3 page spec, empty repo: playable combat racer.
- **C2** This repo minus one subsystem (tires, missions, scatter, audio).
- **C3** Visual match to a reference still (optional, VLM + human).
- **C4** Perf budget: do not drop below 40 fps at 1280×720 medium; no raising
  `dprMax`, no disabling the composer.

Oracles: `tsc`, a lap completed in `GameSimulation`, a non-black Playwright
still. Never two browsers at once.
