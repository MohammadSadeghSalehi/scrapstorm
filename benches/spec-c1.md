# C1 — Playable combat racer, from a spec

This is the prompt a model gets for Track C1. The gold tree is this repository.
Oracles: `tsc --noEmit`, a lap completed in `GameSimulation`, coordinates finite.
No browser. No GPU. No hosted demo. No paid APIs.

## Premise

Scrapstorm League is a single-player browser combat racer. Need for Speed: Most
Wanted (2005) if the fight was the point. Three classes, six desert circuits, a
fifteen-rival career. The player is climbing the Scrapline to take a stolen car
back from Marrow, rank 1.

## Non-negotiable architecture

- Simulation (`src/game/sim.ts` and friends) must not import `three`.
- The renderer lives under `src/game/world/` and is allowed to be slow to start
  but must not hitch once a race is green-flagged.
- Track data is a live array. After `setActiveTrack(id)`, readers must call
  `getTrackSamples()`, never a captured `TRACK_SAMPLES` binding. jiti snapshots
  `export let`.
- Ground is `getGroundHeight(x, z)`, never a literal `y` on a road that is not
  a plane.
- Generated GLBs are Meshopt/Draco/KTX2. Load them with `createGltfLoader()`.
  A bare `GLTFLoader` fails silently and keeps the placeholder.
- r3f: `useFrame` priority `> 0` disables the default renderer. Low graphics
  tier must draw through `SceneRenderer`. Medium/high keep `EffectComposer`.
- A race must not start until the world is warm. `raceGate` holds the sim clock
  with a finite watchdog. A loading screen that never ends is worse than a hitch.

## Vehicle classes

| Class | Wins by | Pays with |
|---|---|---|
| Interceptor | Speed, reach, cadence | Thin hull. Loses every ram. |
| Bruiser | Mass, attrition, off-road | Understeer. Lowest Vmax. |
| Trickster | Rotation, mines, decoys | Middling at everything else. |

Hold fire until the weapon meter fills; the next shot is ordnance.

## Controls

W throttle, S brake/reverse, A/D steer, Shift drift, E boost, J fire, K defense,
L ultimate, P/Esc pause.

## Physics bar

A car on the ribbon must complete a lap under AI throttle without leaving the
finite plane. Wrecks respawn on the road, not in the infield, using
`getGroundHeight`. Static scenery is capsules, not infinite lines. Do not share
a mutable contact result across queries without copying the fields first.

## Presentation bar

Ash Spire is a desert stadium loop. The frame is a chase camera, a hull bar, a
minimap, and a post stack (bloom, grade, motion blur) that does **not** rebuild
every frame. Do not raise `dprMax` above 1.5. Do not delete the composer to
"fix" frame time.

## What "playable" means for the oracle

1. TypeScript emits no errors (`tsc --noEmit`).
2. `new GameSimulation("BENCH", "interceptor", "ash_spire")`, `startCountdown`,
   tick at 60 Hz with `aiInput` for the player, until some vehicle has `lap >= 1`
   inside 180 s of sim time.
3. Every vehicle has finite `x` and `z`.

A black canvas at 160 fps is a fail. This oracle cannot see the canvas; C3 is
the still check, and it is optional.

## Out of scope for C1

Multiplayer, accounts, Postgres, ElevenLabs, Hugging Face uploads, Playwright,
any paid cloud. Local `npm run dev` is the only run mode.
