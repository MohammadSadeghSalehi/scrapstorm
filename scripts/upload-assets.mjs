/**
 * Push local public/assets to Hugging Face.
 *
 * Needs a write token:
 *   huggingface-cli login
 *   node scripts/upload-assets.mjs
 *
 * Creates the dataset repo if you own the namespace.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "public", "assets");
const REPO = process.env.SCRAPSTORM_ASSETS_REPO ?? "Sadegh97/scrapstorm-assets";

if (!existsSync(join(SRC, "meshes")) && !existsSync(join(SRC, "textures"))) {
  console.error("public/assets looks empty. Nothing to upload.");
  process.exit(1);
}

const pyCandidates = ["python", "python3", "py"];
let py = null;
for (const c of pyCandidates) {
  const probe = spawnSync(c, ["-c", "import huggingface_hub"], { shell: false });
  if (probe.status === 0) {
    py = c;
    break;
  }
}
if (!py) {
  console.error("pip install -U huggingface_hub  then  huggingface-cli login");
  process.exit(1);
}

const code = `
from huggingface_hub import HfApi, create_repo
from pathlib import Path
import os
repo = os.environ["SCRAPSTORM_ASSETS_REPO"]
src = Path(os.environ["SCRAPSTORM_ASSETS_DIR"])
card = Path(os.environ.get("SCRAPSTORM_DATASET_CARD", ""))
api = HfApi()
create_repo(repo, repo_type="dataset", exist_ok=True, private=False)
print("uploading", src, "->", repo)
api.upload_folder(
    folder_path=str(src),
    repo_id=repo,
    repo_type="dataset",
    commit_message="Sync Scrapstorm League runtime assets",
    ignore_patterns=[".git", ".gitattributes", ".cache", "README.md"],
)
if card.exists():
    api.upload_file(
        path_or_fileobj=str(card),
        path_in_repo="README.md",
        repo_id=repo,
        repo_type="dataset",
        commit_message="Sync dataset card",
    )
print("uploaded", repo)
`;
const r = spawnSync(py, ["-c", code], {
  stdio: "inherit",
  env: {
    ...process.env,
    SCRAPSTORM_ASSETS_REPO: REPO,
    SCRAPSTORM_ASSETS_DIR: SRC,
    SCRAPSTORM_DATASET_CARD: join(ROOT, "hf", "dataset-card.md"),
  },
});
process.exit(r.status ?? 1);
