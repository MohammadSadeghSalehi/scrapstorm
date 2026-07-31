# Scrapstorm League — AAA Punch-List

## Measured baseline (medium tier, 960x540, software GL)
`draws=280  tris=715k  programs=95  textures=113`
Down from `draws=302 tris=1.17M` via AI-car LODs and start-line prop thinning.

## Pipeline review — where AAA actually comes from

### 1. Asset pipeline (offline) — the biggest untapped tier
| item | state | note |
|---|---|---|
| Vehicle LODs | **done** | `build-vehicle-lods.mjs`; lod1 ~25k (-75%). lod2 not wired — error, not ratio, binds at ~23k, so it gains ~5% over lod1 and is not worth a distance switch on this topology |
| Draco / meshopt | decoders wired | `gltfLoaders.ts` + `copy-decoders.mjs`; geometry not yet encoded |
| KTX2 / Basis | **blocked** | needs a native `toktx`/`basisu`; textures are standalone JPEGs so `textureLibrary.ts` also needs `KTX2Loader`. Buys VRAM + main-thread decode, **not** download size (they are already 1024²) |
| Lightmap bake | not started | **highest visual leverage.** Bake bounce + AO offline; this is the single biggest gap vs a UE scene |
| HLOD / proxy merge | not started | merge distant scenery clusters into baked proxies |

### 2. Build / load
- Race assets now preload behind a gate (`prepareRaceAssets`): PBR library,
  vehicles, race props, set dressing, HDRI prefetch. Textures resident at green
  light rose 95 → 113.
- **Next:** PSO/shader manifest — enumerate material×light×shadow permutations at
  build time and warm them all during the countdown. `ShaderWarmup` currently
  does two timed `compileAsync` passes, which is a heuristic, not a guarantee.
- **Next:** streamed track sectors instead of whole-world upfront.

### 3. Runtime culling / batching
- Scenery instanced (~15-20 draws), edge posts instanced + grid-culled,
  terrain grid-culled. Frustum + distance culling present.
- **Missing:** occlusion culling (UE uses HW queries + a software rasteriser).
  Third leg of the stool; 280 draws is not yet the bottleneck so this is later.

### 4. Render / image quality
| item | state |
|---|---|
| Colour-managed PBR, ACES, sRGB | done |
| GTAO (N8AO, half-res) | done |
| Player-following shadow cascade | done (single tight cascade) |
| **Multi-cascade CSM** | not started — `three/examples/jsm/csm` is bundled |
| **TAA** | not started — needs velocity buffers + reprojection; also unlocks temporal upsampling |
| **LUT grade** | not started — needs an authored grading texture |
| Dynamic resolution | done (`AdaptiveResolution`, 60-100% of tier ceiling) |

### 5. Terrain / world
- Heightmap now sampled at 2.5m quads with exact road-corridor carving and
  slope-driven rock/sand blending.
- **Next:** triplanar detail maps + a second detail normal near the camera;
  currently one tiled sand set does all the work.

## Recommended order
1. **Lightmap bake** — biggest visual delta, and prerender is on the table.
2. **Multi-cascade CSM** — the most visible remaining real-time gap.
3. **TAA** — quality *and* perf (temporal upsampling).
4. KTX2 once an encoder is available; Draco encode is free to do now.
5. Terrain detail maps, then occlusion culling when draws justify it.

_Not safe as originally written:_ `shadowMap.autoUpdate = false` — vehicles move,
so freezing the map freezes their shadows. Needs split static/dynamic lights.


Audit of the live source across Visual / Performance / Feel / Audio.
`[x]` = applied, `[ ]` = pending. Batches are verified with `npx tsc --noEmit` once deps are installed.

## Batch 1 — Lighting foundation (APPLIED, pure value/composition, no build risk)
- [x] **V** Raise HDRI `environmentIntensity` (0.75/0.55/0.4 → 1.1/0.85/0.6) — `environment.tsx`
- [x] **V** Soft shadows + bigger maps on high (PCFSoft, 2048; medium 1024) — `quality.ts`
- [x] **V** Kill emissive "fake fill" wash on terrain + fix silent AO (missing `uv1`) — `HeightmapTerrain.tsx`
- [x] **V** Kill emissive wash on race ground plane + showcase floor — `GameScene.tsx`
- [x] **V** Add HDRI reflections to garage/showcase hero shot (was missing) — `GameScene.tsx`

## Batch 2 — Post-processing + AA (APPLIED, typecheck clean)
- [x] **V (HIGH)** Ungate PostFX from `high`-only → `tier !== "low"` so bloom/vignette/grade actually show — `GameScene.tsx` PostFxLive
- [x] **V (HIGH)** Add SMAA (or `multisampling={4}`) to EffectComposer — `PostFX.tsx`
- [ ] **V (MED)** Add ambient occlusion (N8AO/GTAO) + contact shadows under hero — `PostFX.tsx`, `GameScene.tsx`
- [x] **V (MED)** Color grade pass (HueSaturation/BrightnessContrast or LUT) for desert-dusk identity — `PostFX.tsx`
- [ ] **V (MED)** Hero paint: base color back to ~1.0, clearcoat 0.18→0.6 / roughness→0.1 — `GltfCar.tsx`
- [ ] **V (MED)** Let AI cars cast shadows within distance cap — `GltfCar.tsx`, `quality.ts`

## Batch 2.5 — Set dressing / assets (IN PROGRESS)
- [x] **V (HIGH)** Cache Poly Haven load failures + per-key URL fallbacks — `polyHavenAssets.ts`
  Every one of the 14 `PH_MODELS` paths 404s (the `03-polyhaven` / `04-amara` tarballs
  were never restored), and `SceneryDecor` re-requests each key for all 48–72 decor
  slots on every tier change → ~78 failed requests per load **and a world with zero
  scenery props**. Failures are now cached per key, and `barrel` / `barrelAlt` /
  `tyre` / `rim` / `coveredCar` fall back to equivalents already on disk.
- [ ] **V (HIGH)** Restore the real Poly Haven 1k pack (~45MB, CC0) so the other 9
  keys (crate, box, jerrycan, barrier, trash, hydrant, boulder, fence, pipes) populate
- [ ] **V (MED)** Regenerate the 3 AmaraSpatial props (`AMARA_MESH`: jersey barrier,
  water-filled barrier, traffic cone) — not on disk, not in the tarballs
- [x] **QA** Fix `qa-visual.mjs` blank captures (`toDataURL` returns an empty buffer
  under SwiftShader) → composite `page.screenshot` + flat-frame detection + real
  failed-request URLs; default to a single tier so the sweep can't saturate the CPU

## Batch 3 — Gameplay feel (PENDING)
- [ ] **F (HIGH)** Ramp raw keyboard steer before yaw (kills twitch) — `physics.ts`/`input.ts`
- [ ] **F (HIGH)** Render interpolation between fixed sim steps (fix 120/144Hz microstutter) — `sim.ts`, `GameScene.tsx`
- [ ] **F (MED)** Combat impact feedback: hitstop + shooter shake + damage numbers + haptic — `combat.ts`, `GameHUD.tsx`
- [ ] **F (MED)** Firmer collisions (restitution ~0.5, higher jCap) for combat weight — `physics.ts`
- [ ] **F (MED)** Make drift boost earned (threshold 0.16→0.4, minSpeed 2.5→12) — `balance.ts`
- [ ] **F (MED)** Symmetric, gentler rubberbanding (catchUpMax 0.28→~0.15) — `ai.ts`, `physics.ts`
- [ ] **F (LOW)** Power-slide + counter-steer reward; slower lateral decay — `physics.ts`
- [ ] **F (LOW)** Mobile auto-cruise 0.78→~0.95 (touch can't reach Vmax) — `input.ts`

## Batch 4 — Audio + ElevenLabs (PENDING)
- [ ] **A (HIGH)** Master DynamicsCompressor/limiter before destination (stops clipping) — `AudioEngine.ts`
- [ ] **A (HIGH)** Spatialize opponents/weapons/impacts (PannerNode + listener); emit AI-fire audio — `AudioEngine.ts`, `AudioDriver.tsx`, `combat.ts`
- [ ] **A (HIGH)** Real music crossfade (per-track gain ramps, not hard cut) — `AudioEngine.ts`
- [ ] **A (MED)** VO system: `voBus` + `playVoice()` + manifest; **ElevenLabs announcer** from `story.ts` — `AudioEngine.ts`, `SampleBank.ts`
- [ ] **A (MED)** Music ducking under impacts/VO/victory — `AudioEngine.ts`
- [ ] **A (MED)** Use real engine samples (idle/rev crossfade) over pure synth — `AudioEngine.ts`
- [ ] **A (LOW)** Raise music mix; mute procedural bed when MP3 track active; smooth gear-shift RPM dip

## Batch 5 — Performance (PENDING, larger)
- [ ] **P (HIGH)** GLB pipeline: Draco/meshopt geometry + KTX2 textures via gltf-transform; wire DRACOLoader+KTX2Loader; decode off main thread — `GltfCar.tsx`
- [ ] **P (HIGH)** LOD the GLTF car path (route through existing `meshLodForDistance`; drop clearcoat/normal/shadow at distance) — `GltfCar.tsx`
- [ ] **P (HIGH)** Make `preserveDrawingBuffer` conditional (only for `?capture` QA runs) — `GameScene.tsx`
- [ ] **P (MED)** Shadow map `autoUpdate=false`, refresh every N frames (static sun) — `configure.ts`
- [ ] **P (MED)** Pose projectiles/FX via refs/instancing, not `setState` every 8 frames — `Effects.tsx`, `GameScene.tsx`
- [ ] **P (MED)** Parallel + instanced SceneryDecor / Poly Haven props — `SceneryDecor.tsx`, `polyHavenAssets.ts`
- [ ] **P (MED)** KTX2 the PBR/HDRI texture packs; cache PMREM — `textureLibrary.ts`, `environment.tsx`
- [ ] **P (LOW)** Kill per-frame allocs in skid marks / worldVel / surface sampling — `Effects.tsx`, `physics.ts`

_Legend: V=visual, F=feel, A=audio, P=perf._
