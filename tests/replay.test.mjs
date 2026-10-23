// Replays tests/corpus/ through the extension's guard logic (guard.mjs):
//   node --test tests/replay.test.mjs
// Records every decision in tests/.work/replay-node.json (read by replay-parity.mjs), scores the
// decisions against the labels, and fails on any labeled row that is not a known gap or when
// precision or recall drop below tests/corpus/baseline.json. WINDOWS_GUARD_UPDATE_BASELINE=1
// rewrites the baseline from the current numbers instead of checking it. WINDOWS_GUARD_CORPUS_DIR
// points both the rows and the baseline at a corpus kept outside the repository.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as g from "../plugins/windows-guard/com.github.copilot/extensions/windows-guard/guard.mjs";
import { corpusDir, loadCorpus } from "./corpus/load.mjs";
import { compareToBaseline, scoreCommands, scoreFailures, summarize, toBaseline } from "./corpus/metrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workDir = path.join(here, ".work");
const outFile = path.join(workDir, "replay-node.json");
const corpus = process.env.WINDOWS_GUARD_CORPUS_DIR ? path.resolve(process.env.WINDOWS_GUARD_CORPUS_DIR) : corpusDir;
const baselineFile = path.join(corpus, "baseline.json");
const isWin = process.platform === "win32";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "wg-replay-"));

// Same minimal PATH as the unit tests: pwsh reachable for the parser, no Git-for-Windows head/grep.
const pwsh = g.findExecutable("pwsh") ?? g.findExecutable("powershell");
let pwshDir = pwsh ? path.dirname(pwsh) : null;
if (pwsh && !isWin) {
  const bin = path.join(work, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(pwsh, path.join(bin, path.basename(pwsh)));
  pwshDir = bin;
}
const minPath = [
  ...(isWin ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows"] : []),
  pwshDir,
]
  .filter(Boolean)
  .join(path.delimiter);
const env = { ...process.env, PATH: minPath, Path: minPath };
const log = () => {};

const { commands, failures } = loadCorpus(corpus);
console.log(`corpus: ${corpus}`);
const decisions = {};
const outcomes = {};
let baseline = null;
try {
  baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
} catch {
  baseline = null;
}

after(() => {
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("replay: shell-guard over the corpus commands", () => {
  it("records a decision for every row", async () => {
    // One pwsh process analyzes the whole corpus; shellGuard then hits the decision cache.
    await g.analyzeCommandBatch(
      commands.map((r) => r.command),
      { env, log },
    );
    for (const r of commands) {
      const d = await g.shellGuard(r.command, { env, log });
      decisions[r.id] = { decision: d ? "deny" : "allow", reason: d?.permissionDecisionReason ?? "" };
    }
    assert.equal(Object.keys(decisions).length, commands.length);
  });
  it("matches every labeled row that is not a known gap", () => {
    const m = scoreCommands(commands, decisions);
    console.log(summarize("commands", m));
    assert.deepEqual(m.failures, []);
  });
});

describe("replay: recovery-coach over the corpus failures", () => {
  it("records an outcome for every row", () => {
    for (const r of failures) {
      const advice =
        r.event === "failure"
          ? g.coachFailure(r.tool, r.toolArgs ?? {}, r.text, { env, log })
          : g.coachResult(r.tool, r.toolArgs ?? {}, r.text, { env, log });
      outcomes[r.id] = { advice: advice ?? null };
    }
    assert.equal(Object.keys(outcomes).length, failures.length);
  });
  it("matches every labeled row that is not a known gap", () => {
    const m = scoreFailures(failures, outcomes);
    console.log(summarize("failures", m));
    assert.deepEqual(m.failures, []);
  });
});

describe("replay: decisions file and baseline", () => {
  it("writes tests/.work/replay-node.json for the parity check", () => {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify({ engine: "node", commands: decisions, failures: outcomes }, null, 2)}\n`);
    assert.ok(fs.existsSync(outFile));
  });
  it("precision and recall are not below the corpus baseline.json", () => {
    const mc = scoreCommands(commands, decisions);
    const mf = scoreFailures(failures, outcomes);
    const current = { updated: new Date().toISOString().slice(0, 10), commands: toBaseline(mc), failures: toBaseline(mf) };
    if (process.env.WINDOWS_GUARD_UPDATE_BASELINE) {
      fs.writeFileSync(baselineFile, `${JSON.stringify(current, null, 2)}\n`);
      console.log(`baseline written: ${baselineFile}`);
      return;
    }
    assert.ok(baseline, `${baselineFile} is missing; run once with WINDOWS_GUARD_UPDATE_BASELINE=1`);
    const regressions = [
      ...compareToBaseline("commands", mc, baseline.commands),
      ...compareToBaseline("failures", mf, baseline.failures),
    ];
    assert.deepEqual(regressions, []);
  });
});
