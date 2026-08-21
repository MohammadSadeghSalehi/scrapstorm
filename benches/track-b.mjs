/**
 * Scrapstorm-Bench Track B: agent tickets against the gold tree.
 *
 *   node benches/track-b.mjs
 *
 * Player-visible specs live in benches/tickets/. Hidden checks below encode
 * the traps those tickets are about. A model is scored by receiving a ticket
 * (not this file) and a tree that has had the trap reintroduced.
 *
 * This run is the gold baseline: every check must pass on main.
 * Headless. No browser. No GPU. No paid APIs.
 */
import { src, exists, check, section, summary } from "./lib.mjs";

section("T01 meshopt GLB loader");
{
  const factory = src("src/game/world/gltfLoaders.ts");
  check("createGltfLoader wires MeshoptDecoder", factory.includes("MeshoptDecoder"));
  check("createGltfLoader is exported", /export function createGltfLoader/.test(factory));
  const car = src("src/game/vehicles/GltfCar.tsx");
  check("GltfCar uses createGltfLoader", car.includes("createGltfLoader()"));
  const weapons = src("src/game/world/weaponMeshes.ts");
  check("weapon meshes use createGltfLoader", weapons.includes("createGltfLoader()"));
  const pilot = src("src/game/vehicles/PilotMesh.tsx");
  check(
    "PilotMesh does not use a bare GLTFLoader",
    !pilot.includes("new GLTFLoader") && pilot.includes("createGltfLoader()"),
  );
}

section("T02 getTrackSamples live binding");
{
  const track = src("src/game/track.ts");
  check("getTrackSamples is exported", track.includes("export function getTrackSamples"));
  const sim = src("src/game/sim.ts");
  check("sim.ts calls getTrackSamples", sim.includes("getTrackSamples()"));
  const consumers = [
    "src/components/game/GameHUD.tsx",
    "src/game/worldProps.ts",
    "src/game/world/culling/CulledBeacons.tsx",
    "src/game/world/SceneryDecor.tsx",
    "src/game/world/scatter/driftRibbon.ts",
    "src/game/world/Atmosphere.tsx",
  ];
  for (const f of consumers) {
    check(
      `${f} does not import the TRACK_SAMPLES binding`,
      !/import\s*\{[^}]*\bTRACK_SAMPLES\b/.test(src(f)),
    );
  }
  const profile = src("scripts/check-track-profile.mjs");
  check("track-profile gate uses the accessor", profile.includes("getTrackSamples()"));
}

section("T03 capsuleContact aliasing");
{
  const cc = src("src/game/setpieceColliders.ts");
  check(
    "capsuleContact has no module-level shared Contact",
    !/const contact: Contact = /.test(cc),
  );
  check("misses return a fresh copy", cc.includes("return { ...MISS }"));
  const wp = src("src/game/worldProps.ts");
  check(
    "worldProps does not stash the contact object",
    !/contacts\.push\(\s*hit\s*\)/.test(wp) && !/hits\.push\(\s*hit\s*\)/.test(wp),
  );
}

section("T04 useFrame priority / SceneRenderer");
{
  const pri = src("src/game/world/framePriority.ts");
  check("FRAME.SIM is negative (runs before pose)", /SIM:\s*-\d+/.test(pri));
  const scene = src("src/game/world/GameScene.tsx");
  check("SceneRenderer exists for the no-composer path", scene.includes("function SceneRenderer"));
  check("low tier uses SceneRenderer, not a hidden canvas", scene.includes('tier === "low"'));
  const post = src("src/game/world/PostFX.tsx");
  check("PostFX still mounts EffectComposer", post.includes("<EffectComposer"));
}

section("T05 ground height vs literal y");
{
  const track = src("src/game/track.ts");
  check("getGroundHeight is exported", track.includes("export function getGroundHeight"));
  const sim = src("src/game/sim.ts");
  check("wreck respawn uses getGroundHeight", sim.includes("getGroundHeight(v.x, v.z)"));
  const wp = src("src/game/worldProps.ts");
  check("worldProps rest height is ground-relative", wp.includes("getGroundHeight") || wp.includes("GROUND-RELATIVE"));
}

section("T06 race-gate watchdog");
{
  const gate = src("src/game/world/raceGate.ts");
  check("gate has a finite world watchdog", /WORLD_BUDGET_MS\s*=\s*\d+/.test(gate));
  check("isSimHeld is exported", gate.includes("export function isSimHeld"));
  const scene = src("src/game/world/GameScene.tsx");
  check("SimDriver refuses to tick while held", scene.includes("isSimHeld()"));
  check("tickets folder is present", exists("benches/tickets/T01-meshopt.md"));
}

summary("Track B");
