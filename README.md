# Scrapstorm League

A browser combat racer. Need for Speed: Most Wanted (2005) if the fight was
the point. React + Three.js. Single player heats, three classes, six circuits,
a fifteen-rival career.

This repository is **source only**. Meshes, textures, HDRIs, audio, UI, and
cutscene video live on Hugging Face so a clone stays small.

**GitHub:** [MohammadSadeghSalehi/scrapstorm](https://github.com/MohammadSadeghSalehi/scrapstorm)
**Assets:** [MohammadSadeghSalehi/scrapstorm-assets](https://huggingface.co/datasets/MohammadSadeghSalehi/scrapstorm-assets)

There is no hosted demo and no paid cloud. You run it locally.

---

## Requirements

- **Node.js 22+**
- **Git**
- A current **Chrome** or Edge (WebGL2). Firefox works; Safari is untested.
- About **1.5 GB** disk for `node_modules` plus the asset pack (~420 MB)
- Optional: Python 3.10+ with `huggingface_hub` (the fetch script uses it)

A discrete GPU helps. The game is playable on a laptop 5080-class chip at
medium/high. Integrated GPUs should stay on low/medium.

---

## Run it (step by step)

### 1. Clone the code

```bash
git clone https://github.com/MohammadSadeghSalehi/scrapstorm.git
cd scrapstorm
```

### 2. Install Node dependencies

```bash
npm ci
```

If `npm ci` fails (no lockfile match), `npm install` is fine.

### 3. Fetch the art pack from Hugging Face

```bash
pip install -U huggingface_hub
node scripts/fetch-assets.mjs
```

This downloads into `public/assets/` (meshes, textures, HDRIs, audio, UI,
video). It is gitignored on purpose. Re-run the script any time; existing
files with matching hashes are skipped.

If the dataset is not public yet, you need a free Hugging Face account and:

```bash
huggingface-cli login
node scripts/fetch-assets.mjs
```

Paste a token from https://huggingface.co/settings/tokens (read is enough).

### 4. Start the dev server

```bash
npm run dev
```

Open **http://localhost:8080** (binds `0.0.0.0:8080`).

The first request can take 10–40 seconds of Vite transform. Wait for the
menu, then Continue career or Quick heat.

### 5. Play

| Key | Action |
|-----|--------|
| W | throttle |
| S | brake / reverse |
| A D | steer |
| Shift | drift |
| E | boost |
| J | fire |
| K | defense |
| L | ultimate |
| P / Esc | pause |
| ` | graphics debug (in a race) |

---

## Optional

**Regenerate music and voice** (needs an ElevenLabs key, not required to play
if you fetched the asset pack):

```bash
cp .env.example .env
# put ELEVENLABS_API_KEY in .env
node scripts/gen-music.mjs
node scripts/gen-vo.mjs
```

**Production build, still local:**

```bash
npm run build
npm run preview
```

**Headless gates** (no browser, no GPU):

```bash
npm run typecheck
npm run bench:smoke
```

---

## Layout

```
src/game/            simulation, physics, combat, missions (no three.js)
src/game/world/      renderer
src/components/game/ HUD, menus, loading
scripts/             asset fetch, smoke tests, generators
benches/             LLM eval harness (Track A today)
public/assets/       restored by fetch-assets.mjs, not in git
AGENTS.md            how to change this codebase without lying
```

The sim must stay renderer-free. That is what makes the smoke tests and the
benchmark possible.

---

## License

Source: MIT. Third-party art: see `NOTICE` and `public/assets/SOURCES.md`.

---

## Benchmark

`benches/` is Scrapstorm-Bench. Track A (regression gates) runs in CI and via
`npm run bench:smoke`. Tracks B (agent tickets) and C (one-shot / few-shot
game development) are specified in `benches/README.md`.
