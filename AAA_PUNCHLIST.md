# Scrapstorm League — AAA Punch-List

## Measured baseline (medium tier, 960x540)
`draws=302  tris=1.17M  programs=92  textures=101`
Player-reported on a real GPU: **57fps / 17.5ms / max 27.9ms**.

## Next up, in leverage order
1. **Vehicle LODs** — each custom car is ~100k tris (`scripts/inspect-mesh-orientation.mjs`
   reports 96-105k) with no LOD, so a 4-car grid spends ~400k tris/frame on vehicles.
   Needs offline decimation (`@gltf-transform/cli` + meshoptimizer).
2. **KTX2 + Draco compression** — 43MB JPEG / 45MB meshes / 22MB HDRI still
   uncompressed. Decoders are already wired (`gltfLoaders.ts`), transcoders staged
   by `scripts/copy-decoders.mjs`. This is the remaining cause of first-load hitching.
3. **Baked lightmaps** + true multi-cascade CSM (three's `CSM.js` is bundled).
4. **TAA** over SMAA — also unlocks temporal upsampling.
5. Terrain: triplanar/slope-blended detail maps; the heightmap is now sampled
   properly but still uses a single tiled sand set.

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
