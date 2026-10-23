// Loads the replay corpus (JSON Lines). Shared by replay.test.mjs, replay-parity.mjs and the importer.
// See README.md in this directory for the row formats.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const corpusDir = path.dirname(fileURLToPath(import.meta.url));

export function readJsonl(file) {
  const rows = [];
  fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      try {
        rows.push(JSON.parse(t));
      } catch (e) {
        throw new Error(`${path.basename(file)}:${i + 1}: ${e.message}`);
      }
    });
  return rows;
}

export function loadCorpus(dir = corpusDir) {
  const commands = readJsonl(path.join(dir, "commands.jsonl"));
  const failures = readJsonl(path.join(dir, "failures.jsonl"));
  validate(commands, "commands.jsonl", ["id", "command"], (r) => r.expect == null || ["allow", "deny"].includes(r.expect));
  validate(
    failures,
    "failures.jsonl",
    ["id", "tool", "event", "text", "expect"],
    (r) => ["advice", "silent"].includes(r.expect) && ["failure", "result"].includes(r.event),
  );
  return { commands, failures };
}

function validate(rows, name, required, extra) {
  const seen = new Set();
  for (const r of rows) {
    for (const k of required) if (!(k in r)) throw new Error(`${name}: row ${r.id ?? "?"} lacks "${k}"`);
    if (!extra(r)) throw new Error(`${name}: row ${r.id} has an invalid expect/event value`);
    if (r.status != null && r.status !== "known-gap") throw new Error(`${name}: row ${r.id} has an unknown status "${r.status}"`);
    if (seen.has(r.id)) throw new Error(`${name}: duplicate id ${r.id}`);
    seen.add(r.id);
  }
}
