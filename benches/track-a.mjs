/**
 * Scrapstorm-Bench Track A: headless regression.
 *
 *   node benches/track-a.mjs
 *
 * Exits non-zero on the first failing gate. No renderer, no Playwright.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const gates = [
  ["typecheck", ["node", "node_modules/typescript/bin/tsc", "--noEmit"]],
  ["mission-smoke", ["node", "scripts/mission-smoke.mjs"]],
  ["probe-audio", ["node", "scripts/probe-audio.mjs"]],
  ["check-track-profile", ["node", "scripts/check-track-profile.mjs"]],
  ["check-setpiece-footprints", ["node", "scripts/check-setpiece-footprints.mjs"]],
  ["balance-grid", ["node", "scripts/balance-grid.mjs"]],
];

let failed = 0;
for (const [name, [cmd, ...args]] of gates) {
  console.log(`\n── Track A / ${name} ──`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: false });
  if (r.status !== 0) {
    console.log(`FAIL ${name} (exit ${r.status})`);
    failed += 1;
    break;
  }
  console.log(`ok   ${name}`);
}

process.exit(failed === 0 ? 0 : 1);
