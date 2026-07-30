#!/usr/bin/env node
/**
 * Stage the Draco and KTX2/Basis transcoders into public/decoders/ so the
 * loaders in src/game/world/gltfLoaders.ts can fetch them at runtime.
 *
 *   node scripts/copy-decoders.mjs
 *
 * They ship inside the three package but live under node_modules, which Vite
 * does not serve as static files. Copying keeps everything self-hosted — no
 * CDN dependency, works offline and behind a strict CSP.
 *
 * Safe to re-run; it overwrites. Re-run after upgrading three.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "node_modules/three/examples/jsm/libs";
const DEST = "public/decoders";

const jobs = [
  { from: join(SRC, "draco"), to: join(DEST, "draco") },
  { from: join(SRC, "basis"), to: join(DEST, "basis") },
];

const dirSize = (dir) => {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
};

let missing = 0;
for (const { from, to } of jobs) {
  if (!existsSync(from)) {
    console.error(`  ! missing ${from} — is three installed?`);
    missing++;
    continue;
  }
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`  + ${to}  (${(dirSize(to) / 1024).toFixed(0)}KB)`);
}

if (missing) process.exitCode = 1;
else console.log(`\nDecoders staged in ${DEST}. Compressed glTF will now load.`);
