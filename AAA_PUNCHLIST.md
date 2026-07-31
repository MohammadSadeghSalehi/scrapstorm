# Scrapstorm League — road to AAA

Target: *Need for Speed: Most Wanted (2005)*, with combat. Rewritten 2026-07-31
against the live source; the previous version had drifted badly out of date
(items marked "blocked" that shipped, items marked "done" that never attached).

---

## 0. THE GATE — nothing below this line matters until it is closed

**Frame time on the target GPU is unmeasured, and one reported reading was
14fps at 73ms average / 226ms peak.**

Everything in this document costs frame time. Planning visual work on top of an
unmeasured 14fps is how the last regression happened: a batch of quality
changes shipped together on a clean QA sweep, and the sweep says nothing about
frame time — it runs on SwiftShader at 20fps by construction.

### 0.1 Get a real profile, not a guess
- [ ] **GPU timer queries.** `EXT_disjoint_timer_query_webgl2` around each
  EffectComposer pass and each major draw group. Right now every perf claim in
  this project — including mine — is inference from draw counts. 238 draws and
  643k triangles is *nothing*; the cost is somewhere in fill rate, shader
  complexity, or main-thread stalls, and we do not know which.
- [ ] **Main-thread trace.** 226ms peaks are not a GPU problem. Suspects, in
  order: KTX2 transcode on load, `PMREMGenerator` for the HDRI, glTF parse,
  scenery batch build. All are one-time, so a peak *during racing* means
  something is being rebuilt mid-race.
- [ ] **Re-land what was cut blind.** Three things were disabled to stop the
  bleeding, each behind one flag: `dprMax` 2→1.5, terrain `attachGpuDetail`,
  the 49.6k crane beam. Restore one at a time with a reading between each.

### 0.2 Set a budget and hold to it
16.7ms at 60fps. Proposed split: 6ms geometry+shadow, 4ms post, 3ms main
thread, 3.7ms slack. **Anything below that fails to land, gets reverted, not
"optimised later".**

---

## 1. Where the remaining AAA gap actually is

Ranked by *visible delta per millisecond*, which is not the same as ranked by
effort.

### 1.1 Lighting — the single biggest gap (HIGH value, HIGH cost)
One directional light plus an HDRI is a 2010 lighting model. MW05's look came
from baked bounce.

- [ ] **Baked lightmaps / AO for static geometry.** Terrain, scenery, track
  furniture. Offline bake → a second UV set → `lightMap`. Prerender is
  explicitly on the table, and this is what it buys. Biggest single step
  toward "not a WebGL demo".
- [ ] **Multi-cascade CSM, properly.** Previously attempted and reverted at a
  cost of 151→81fps. It failed because CSM adds *one directional light per
  cascade at full intensity* and the receivers were never patched — a probe
  measured intensities of `[0.65, 0.3, 3, 3, 3]`. The fix is to route every
  shadow-receiving material through `csm.setupMaterial` **at creation time**
  (`GltfCar`, `procmat`, terrain, prop pools), not via a periodic sweep. Do not
  retry this without that change.
- [ ] **Split static/dynamic shadow maps.** `shadowMap.autoUpdate = false` is
  listed in the old plan as unsafe, and it is — vehicles move. Two lights: a
  static one refreshed rarely, a dynamic one for vehicles only.
- [ ] **Local reflection.** A handful of box-projected probes at the start/pit
  area. Screen-space reflections are not worth their cost here.

### 1.2 World density — the loudest "not AAA" tell (HIGH value, LOW cost)
The desert is empty. Real deserts are not, and neither is a MW05 roadside.

- [ ] **Instanced scatter fields.** Rocks, scrub, dead brush, debris drifts,
  tyre walls — thousands of instances, a handful of draws, distance-faded.
  Cheapest visual win on this list by a wide margin.
- [ ] **Roadside continuity.** Guard rails, run-off, kerbing, painted run-off
  markings, sponsor boards. The verge is currently posts and nothing else.
- [ ] **Ground-cover blending.** Sand drifts creeping onto the tarmac edge,
  darker aggregate in the racing line. The road already has wear via
  `roadWear.ts`; the *transition* is what is missing.
- [ ] **Replace the remaining primitives.** Some scenery still falls back to
  boxes and cylinders when a Poly Haven key fails to resolve.

### 1.3 Vehicles — the thing the player stares at (HIGH value, MED cost)
- [ ] **Deformation, not just a damage texture.** Vertex displacement on impact
  by proximity to hit point, accumulating. `debris.ts` already handles the
  detached pieces; the panel itself never changes shape.
- [ ] **Paint.** Clearcoat is listed as done, but a flake/metallic layer and a
  proper dirt buildup mask (accumulating off-road, wiped by speed) is what
  reads as expensive.
- [ ] **Wheels.** Rotation, steering, and suspension travel driven from the sim
  rather than approximated; brake-disc glow; tyre sidewall deformation on load.
- [ ] **Interior / cockpit.** Even a low-detail one, for the chase camera to
  see through glass.

### 1.4 Image pipeline (MED value, MED cost — gated on §0)
- [ ] **TAA.** Needs velocity buffers and reprojection. Also unlocks temporal
  upsampling, which *gives* frame time back — arguably this belongs in §0.
- [ ] **LUT grade from a texture.** `GradeEffect.ts` does ASC CDL + split-tone
  in-shader; an authored 32³ LUT is both cheaper and far more art-directable.
- [ ] **Depth of field** for replays and the garage only. Not in-race.
- [ ] **Screen-space contact shadows** under the car — small, and it is what
  stops a vehicle looking pasted onto the road.

### 1.5 Camera and game feel (HIGH value, LOW cost)
This is where MW05 actually lives, and it is nearly free.

- [ ] **Impact hitstop.** 40–80ms of frozen time on a heavy hit, then a snap
  back. Single largest perceived-weight gain available.
- [ ] **Speed-reactive camera.** FOV widening, pull-back, shake, and the
  existing radial motion blur all driven off one curve.
- [ ] **Replay rig.** Track-side cameras, cut on lap events. Also the thing
  that makes the world worth having built.
- [ ] **Render interpolation between fixed sim steps.** Still pending, still
  causing microstutter at 120/144Hz.
- [ ] **Steering ramp** before yaw — raw keyboard input is twitchy.

### 1.6 Audio (MED value, LOW cost)
- [ ] **Real engine samples**, multi-layer, crossfaded by RPM *and* load, with
  off-throttle overrun. The synth bed is the most obviously indie thing in the
  build.
- [ ] **Spatialisation.** Opponents, weapons and impacts through `PannerNode`
  with a proper listener; AI fire currently emits no audio at all.
- [ ] **Surface-dependent tyre noise**, tied to the same surface query physics
  already uses.
- [ ] **Reverb zones** — the canyon stretch should sound like a canyon.

### 1.7 Content and story (user-supplied assets)
- [ ] Video cutscenes (user generates) + ElevenLabs VO over them.
- [ ] A second and third circuit. `cinder_bowl` exists but is thin.
- [ ] Rival characters with voiced taunts tied to combat events.

---

## 2. Ordering

Strictly sequential. Each phase ends with an fps reading on the target GPU
before the next begins.

| # | phase | why here |
|---|---|---|
| 1 | §0 profile + budget | every estimate below is currently a guess |
| 2 | §1.5 camera/feel | near-zero cost, largest perceived gain |
| 3 | §1.2 world density | cheap, and the loudest visual tell |
| 4 | §1.4 TAA | pays for itself via temporal upsampling |
| 5 | §1.1 lightmaps | biggest delta, but expensive and needs the headroom |
| 6 | §1.1 CSM | only after `setupMaterial`-at-creation is in |
| 7 | §1.3 vehicles | high value, but wasted if the frame is already full |
| 8 | §1.6 audio | independent of frame time, can run in parallel |
| 9 | §1.7 content | needs the engine work to be worth filming |

Audio (§1.6) is the one track that can proceed in parallel — it does not
compete for frame time.

---

## 3. Process rules, learned the hard way

1. **One change, one measurement.** Stacked batches are how 102fps became
   14fps with no way to tell which change did it.
2. **The QA sweep is a correctness tool.** It runs on SwiftShader. A clean
   sweep is not a performance result and never was.
3. **Verify by probe, not by eye.** In this session alone: mesh winding was
   inverted while the comment claimed otherwise; a texture silently never
   attached and the scene still looked fine. Both were caught by numbers
   disagreeing with the code, and neither would have been caught by looking.
4. **A count that moves the wrong way is a bug.** Adding a texture must raise
   the texture count.
5. **Estimates are not evidence.** The terrain fBm layer was estimated at 1–3%
   and shipped without profiling. It is now disabled pending a real number.

---

## 4. Done (kept for provenance)

Asset pipeline: vehicle LODs, KTX2/Basis (−207MB VRAM), decoder wiring,
concurrent preload behind a gate.
Render: colour-managed PBR + ACES, GTAO, SMAA, ASC CDL grade, dynamic
resolution, radial motion blur, player-following shadow cascade.
World: heightmap terrain with exact road-corridor carving, instanced scenery
and edge posts, grid culling, continuous ridged-multifractal mountain ranges
with aerial perspective, camera-anchored backdrop.
Physics: fixed-step sim with carried remainder, mass-scaled prop collisions,
frangible verge posts, wall-sliding barriers, surface-aware drag, off-road dust.
Placement: every prop, scenery and decor item rests on the real ground query
(verified, worst float 0.0000m) and clear of the tarmac.
Audio: voBus + ducking + limiter, music crossfade, ElevenLabs announcer.
Tooling: QA harness, Vite polling watcher (WSL/`/mnt/c` fires no inotify events,
so the dev server had been serving stale code for every edit without a restart).
