// Compares the two engines' replay decisions row by row:
//   node --test tests/replay.test.mjs                      -> tests/.work/replay-node.json
//   pwsh -NoProfile -File tests/Invoke-ReplayTests.ps1    -> tests/.work/replay-ps.json
//   node tests/replay-parity.mjs
// Exit 0 when every row has the same decision and, for denials and advice, the same text.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "./corpus/load.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function read(name) {
  const p = path.join(here, ".work", name);
  if (!fs.existsSync(p)) {
    console.error(`missing ${p}; run the replay for that engine first`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const norm = (s) => String(s ?? "").replace(/\r\n/g, "\n").trim();
const node = read("replay-node.json");
const ps = read("replay-ps.json");
const { commands, failures } = loadCorpus();
const mismatches = [];

for (const r of commands) {
  const a = node.commands?.[r.id];
  const b = ps.commands?.[r.id];
  if (!a || !b) {
    mismatches.push(`${r.id}: missing in ${!a ? "node" : "powershell"}`);
    continue;
  }
  if (a.decision !== b.decision) mismatches.push(`${r.id}: node=${a.decision} powershell=${b.decision}  ${r.command.slice(0, 70).replace(/\n/g, " ")}`);
  else if (a.decision === "deny" && norm(a.reason) !== norm(b.reason)) mismatches.push(`${r.id}: deny reasons differ\n    node: ${norm(a.reason).slice(0, 120)}\n    pwsh: ${norm(b.reason).slice(0, 120)}`);
}
for (const r of failures) {
  const a = node.failures?.[r.id];
  const b = ps.failures?.[r.id];
  if (!a || !b) {
    mismatches.push(`${r.id}: missing in ${!a ? "node" : "powershell"}`);
    continue;
  }
  const an = a.advice ? "advice" : "silent";
  const bn = b.advice ? "advice" : "silent";
  if (an !== bn) mismatches.push(`${r.id}: node=${an} powershell=${bn}`);
  else if (an === "advice" && norm(a.advice) !== norm(b.advice)) mismatches.push(`${r.id}: advice texts differ\n    node: ${norm(a.advice).slice(0, 120)}\n    pwsh: ${norm(b.advice).slice(0, 120)}`);
}

console.log(`parity: ${commands.length} commands and ${failures.length} failures compared, ${mismatches.length} mismatch(es)`);
for (const m of mismatches) console.log(`  ${m}`);
process.exit(mismatches.length ? 1 : 0);
