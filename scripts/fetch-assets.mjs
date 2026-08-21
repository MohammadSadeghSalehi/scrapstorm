/**
 * Restore public/assets from Hugging Face.
 *
 *   node scripts/fetch-assets.mjs
 *
 * Uses the huggingface_hub Python package (pip install huggingface_hub).
 * A public dataset needs no token. A gated/private one needs:
 *   huggingface-cli login
 * or HF_TOKEN in the environment.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "public", "assets");
const REPO = process.env.SCRAPSTORM_ASSETS_REPO ?? "Sadegh97/scrapstorm-assets";

mkdirSync(DEST, { recursive: true });

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: "inherit", shell: false });
}

const pyCandidates = [
  process.env.PYTHON,
  "python",
  "python3",
  "py",
].filter(Boolean);

let py = null;
for (const c of pyCandidates) {
  const probe = spawnSync(c, ["-c", "import huggingface_hub,sys; print(sys.executable)"], {
    encoding: "utf8",
    shell: false,
  });
  if (probe.status === 0 && probe.stdout?.trim()) {
    py = c;
    break;
  }
}

if (!py) {
  console.error(`
huggingface_hub is not installed.

  pip install -U huggingface_hub

Then re-run:

  node scripts/fetch-assets.mjs

If the dataset is private, also run:

  huggingface-cli login
`);
  process.exit(1);
}

console.log(`Fetching ${REPO} → ${DEST}`);
const code = `
from huggingface_hub import snapshot_download
import os
snapshot_download(
    repo_id=os.environ["SCRAPSTORM_ASSETS_REPO"],
    repo_type="dataset",
    local_dir=os.environ["SCRAPSTORM_ASSETS_DIR"],
    resume_download=True,
)
print("ok")
`;
const env = {
  ...process.env,
  SCRAPSTORM_ASSETS_REPO: REPO,
  SCRAPSTORM_ASSETS_DIR: DEST,
};
const r = spawnSync(py, ["-c", code], { stdio: "inherit", env, shell: false });
if (r.status !== 0) {
  console.error(`
Download failed.

  1. pip install -U huggingface_hub
  2. If 401/403: huggingface-cli login
     (token: https://huggingface.co/settings/tokens — read access)
  3. node scripts/fetch-assets.mjs
`);
  process.exit(r.status ?? 1);
}

const marker = join(DEST, "SOURCES.md");
if (!existsSync(marker)) {
  console.warn("Warning: SOURCES.md missing after download. Check the dataset layout.");
} else {
  console.log("Assets ready in public/assets/");
}
