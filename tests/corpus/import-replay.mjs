// Turns a JSON array or JSON Lines export of historical shell commands into unlabeled corpus rows.
//   node tests/corpus/import-replay.mjs <file> [--command=command] [--succeeded=succeeded]
//        [--exit-code=exit_code] [--source=name] [--start=1] [--prefix=r] > rows.jsonl
// Rows are de-duplicated by command text and carry no "expect": label them afterwards.

import fs from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node tests/corpus/import-replay.mjs <file.json|file.jsonl> [--command=f] [--succeeded=f] [--exit-code=f] [--source=s] [--start=n] [--prefix=p]");
  process.exit(2);
}
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const commandField = opt("command", "command");
const succeededField = opt("succeeded", "succeeded");
const exitCodeField = opt("exit-code", "");
const source = opt("source", "import");
const prefix = opt("prefix", "r");
let next = Number(opt("start", "1"));

const text = fs.readFileSync(file, "utf8");
let records;
try {
  records = JSON.parse(text);
  if (!Array.isArray(records)) records = records.commands ?? records.rows ?? records.items ?? [records];
} catch {
  records = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const seen = new Set();
let written = 0;
for (const rec of records) {
  const command = rec?.[commandField];
  if (typeof command !== "string" || !command.trim()) continue;
  if (seen.has(command)) continue;
  seen.add(command);
  let succeeded = null;
  if (typeof rec[succeededField] === "boolean") succeeded = rec[succeededField];
  else if (exitCodeField && Number.isInteger(rec[exitCodeField])) succeeded = rec[exitCodeField] === 0;
  const row = { id: `${prefix}${String(next++).padStart(4, "0")}`, command, source };
  if (succeeded !== null) row.succeeded = succeeded;
  process.stdout.write(`${JSON.stringify(row)}\n`);
  written++;
}
console.error(`${written} unique command(s) written from ${records.length} record(s)`);
