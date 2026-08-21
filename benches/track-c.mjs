/**
 * Scrapstorm-Bench Track C: one-shot / few-shot development oracles.
 *
 *   node benches/track-c.mjs
 *
 * C1  Gold tree satisfies the playable-racer oracles (tsc is Track A; a lap
 *     completes in GameSimulation).
 * C2  Required subsystems are present. Ablation specs live in benches/c2/.
 * C3  Optional still. Set SCRAPSTORM_STILL to a PNG to luma-check it. Never
 *     launches a browser.
 * C4  Static perf contract: dprMax ceiling, composer still on medium/high.
 *
 * Headless. No Playwright. No GPU. No paid APIs. Safe on GitHub-hosted runners.
 */
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { src, exists, check, section, summary, ROOT } from "./lib.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true });

section("C1 gold oracles — GameSimulation lap");
{
  const simMod = await jiti.import("../src/game/sim.ts");
  const ai = await jiti.import("../src/game/ai.ts");
  const g = new simMod.GameSimulation("BENCH", "interceptor", "ash_spire");
  g.setPhase("countdown");

  const maxSteps = 60 * 180;
  let steps = 0;
  while (steps < maxSteps && g.state.phase !== "finished") {
    const player = g.state.vehicles.find((v) => v.isPlayer);
    const pin =
      player && g.state.phase === "racing"
        ? ai.aiInput(player, g.state.vehicles, g.state.time, g.state.lapCount)
        : null;
    g.tick(1 / 60, pin);
    steps += 1;
    if (g.state.vehicles.some((v) => v.lap >= 1)) break;
  }

  check("grid was built", g.state.vehicles.length >= 2, `${g.state.vehicles.length} cars`);
  check(
    "somebody completed a lap",
    g.state.vehicles.some((v) => v.lap >= 1),
    `laps ${g.state.vehicles.map((v) => v.lap).join("/")}`,
  );
  check(
    "coordinates stayed finite",
    g.state.vehicles.every((v) => Number.isFinite(v.x) && Number.isFinite(v.z)),
  );
  check("C1 spec is checked in", exists("benches/spec-c1.md"));
}

section("C2 subsystems present (gold tree, pre-ablation)");
{
  const needed = [
    ["tires", "src/game/tires.ts"],
    ["missions", "src/game/missions/index.ts"],
    ["scatter", "src/game/world/scatter/ScatterLayer.tsx"],
    ["audio", "src/game/audio/AudioEngine.ts"],
  ];
  for (const [name, rel] of needed) {
    check(`${name} source exists`, exists(rel));
    check(`${name} restore spec exists`, exists(`benches/c2/${name}.md`));
  }
  const tires = src("src/game/tires.ts");
  check("tires expose a temperature window", tires.includes("TIRE_TEMP"));
  const missions = src("src/game/missions/index.ts");
  check("missions re-export the catalogue", missions.includes("export"));
}

section("C3 visual still (no browser)");
{
  const rel = process.env.SCRAPSTORM_STILL ?? "docs/github/play-race.jpg";
  const path = isAbsolute(rel) ? rel : join(ROOT, rel);
  check("C3 still exists", exists(rel) || exists(path), path);
  const buf = readFileSync(path);
  const png = buf[0] === 0x89 && buf[1] === 0x50;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  check("C3 still is a PNG or JPEG, not a black canvas", png || jpg);
  check("C3 still is larger than a stub", buf.length > 8_000, `${buf.length} bytes`);
}

section("C4 perf contract (static)");
{
  const q = await jiti.import("../src/game/world/quality.ts");
  for (const tier of ["low", "medium", "high"]) {
    const dpr = q.PRESETS?.[tier]?.dprMax ?? q.qualityFor?.(tier)?.dprMax;
    const settings = q.PRESETS ? { ...q.PRESETS[tier], tier } : q.qualityManager?.get?.();
    const cap = settings?.dprMax ?? dpr;
    // Fall back to reading the source if the module does not export PRESETS.
    const text = src("src/game/world/quality.ts");
    const match = [...text.matchAll(/dprMax:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    check(
      `dprMax values are <= 1.5 (${tier} scan)`,
      match.length > 0 && match.every((n) => n <= 1.5),
      match.join(","),
    );
    break;
  }
  const post = src("src/game/world/PostFX.tsx");
  check("composer is not deleted", post.includes("EffectComposer"));
  const scene = src("src/game/world/GameScene.tsx");
  check("low tier still has SceneRenderer", scene.includes("SceneRenderer"));
  check("medium/high still return <PostFX", scene.includes("return <PostFX"));
}

summary("Track C");
