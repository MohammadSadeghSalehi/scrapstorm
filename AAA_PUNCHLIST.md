# Scrapstorm League — AAA Punch-List

Audit of the live source across Visual / Performance / Feel / Audio.
`[x]` = applied, `[ ]` = pending. Batches are verified with `npx tsc --noEmit` once deps are installed.

## Batch 1 — Lighting foundation (APPLIED, pure value/composition, no build risk)
- [x] **V** Raise HDRI `environmentIntensity` (0.75/0.55/0.4 → 1.1/0.85/0.6) — `environment.tsx`
- [x] **V** Soft shadows + bigger maps on high (PCFSoft, 2048; medium 1024) — `quality.ts`
- [x] **V** Kill emissive "fake fill" wash on terrain + fix silent AO (missing `uv1`) — `HeightmapTerrain.tsx`
- [x] **V** Kill emissive wash on race ground plane + showcase floor — `GameScene.tsx`
- [x] **V** Add HDRI reflections to garage/showcase hero shot (was missing) — `GameScene.tsx`

## Batch 2 — Post-processing + AA (PENDING, needs typecheck)
- [ ] **V (HIGH)** Ungate PostFX from `high`-only → `tier !== "low"` so bloom/vignette/grade actually show — `GameScene.tsx` PostFxLive
- [ ] **V (HIGH)** Add SMAA (or `multisampling={4}`) to EffectComposer — `PostFX.tsx`
- [ ] **V (MED)** Add ambient occlusion (N8AO/GTAO) + contact shadows under hero — `PostFX.tsx`, `GameScene.tsx`
- [ ] **V (MED)** Color grade pass (HueSaturation/BrightnessContrast or LUT) for desert-dusk identity — `PostFX.tsx`
- [ ] **V (MED)** Hero paint: base color back to ~1.0, clearcoat 0.18→0.6 / roughness→0.1 — `GltfCar.tsx`
- [ ] **V (MED)** Let AI cars cast shadows within distance cap — `GltfCar.tsx`, `quality.ts`

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
