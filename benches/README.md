# Scrapstorm-Bench

A harness for scoring language models on a **real-time 3D game**, not a toy
canvas demo.

The point is whether the model can keep physics, rendering, assets, and frame
time honest. A black canvas at 160 fps is a fail.

Nothing here calls a paid API. Nothing here launches a browser. CI is GitHub
Actions on `ubuntu-latest` (free for a public repo).

```bash
npm run bench        # A + B + C
npm run bench:smoke  # A only
npm run bench:b
npm run bench:c
```

## Track A — regression (runs in CI)

Headless. No browser. No GPU.

Wraps: typecheck, mission-smoke, track profile, setpiece footprints, audio DSP,
grid geometry.

## Track B — agent tickets (gold baseline in CI)

Player-visible specs: `benches/tickets/T01`–`T06`. Hidden checks:
`benches/track-b.mjs`. Prompts for an eval must include the ticket, not the
hidden file.

To score a model: reintroduce one trap in a worktree, give it the ticket, run
`node benches/track-b.mjs`. Gold `main` must pass.

| Ticket | Trap |
|---|---|
| T01 | Meshopt GLB silent fallback (`new GLTFLoader`) |
| T02 | `export let` / jiti snapshot of `TRACK_SAMPLES` |
| T03 | shared mutable `capsuleContact` result |
| T04 | r3f `useFrame` priority > 0 black canvas |
| T05 | ground height vs road-plane `y` |
| T06 | race-gate watchdog / ticking while held |

## Track C — one-shot / few-shot (oracles in CI)

| Item | What runs | What does not |
|---|---|---|
| **C1** | Lap in `GameSimulation` on this gold tree. Spec: `benches/spec-c1.md`. | Empty-repo eval is local: point the same oracle at a candidate. |
| **C2** | Subsystem files present. Restore specs: `benches/c2/`. | Ablation is a copy you delete from; CI does not delete source. |
| **C3** | Optional. `SCRAPSTORM_STILL=/path/to.png`. | Playwright. Never in CI. Never two browsers. |
| **C4** | Static: `dprMax <= 1.5`, composer still mounted, `SceneRenderer` for low. | Live FPS. That needs a GPU and is a local protocol only. |

## Cost

- GitHub Actions: public repo, hosted `ubuntu-latest`, no extra runners.
- Hugging Face dataset: public, read is free, no token to play.
- No Vercel, Cloudflare, Neon, or ElevenLabs required to run or to CI.
- Playwright is a devDependency for local capture only and is not invoked here.
