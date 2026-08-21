/** Tiny assert helper shared by Track B and Track C. */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const failures = [];

export function src(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`missing ${rel}`);
  return readFileSync(p, "utf8");
}

export function exists(rel) {
  return existsSync(join(ROOT, rel));
}

export function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(detail ? `${name}: ${detail}` : name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

export function section(title) {
  console.log(`\n── ${title} ──`);
}

export function summary(label) {
  console.log(`\n${label}: ${pass} ok, ${fail} fail`);
  if (fail) {
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
}

export { pass, fail, failures };
