// Prints the next release version: the newest v… release's patch raised by one,
// or tauri.conf.json's version when that is higher (raise it there for a minor
// or major version). Release tags arrive on stdin, one per line:
//   gh release list --json tagName -q '.[].tagName' | node scripts/version.mjs
import { readFileSync } from "node:fs";

const parse = (v) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

const configured = parse(
  JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).version,
);
const released = readFileSync(0, "utf8")
  .split(/\r?\n/)
  .map((t) => /^v(\d+\.\d+\.\d+)$/.exec(t.trim())?.[1])
  .filter(Boolean)
  .map(parse)
  .reduce((best, v) => (!best || newer(v, best) ? v : best), null);

const next = released ? [released[0], released[1], released[2] + 1] : configured;
console.log((newer(configured, next) ? configured : next).join("."));
