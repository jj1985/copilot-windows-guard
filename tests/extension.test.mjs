// Unit tests for the extension's guard logic (guard.mjs). Plain `node --test`, no dependencies:
//   node --test tests/extension.test.mjs
// Covers the same cases as Invoke-HookTests.ps1 covers for the PowerShell scripts, plus the
// session-hook wiring that extension.mjs hands to joinSession. Work happens under the OS temp
// directory, and every git call is isolated from the machine's global and system config.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as g from "../plugins/windows-guard/com.github.copilot/extensions/windows-guard/guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..", "plugins", "windows-guard");
const rulesDir = path.join(pluginDir, "com.github.copilot", "rules");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "wg-node-"));
const isWin = process.platform === "win32";

process.env.GIT_CONFIG_GLOBAL = path.join(work, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
fs.writeFileSync(
  process.env.GIT_CONFIG_GLOBAL,
  "[user]\n\temail = t@example.com\n\tname = tests\n[core]\n\tautocrlf = false\n\tlongpaths = true\n",
);

const haveGit = Boolean(g.findExecutable("git"));
const pwsh = g.findExecutable("pwsh") ?? g.findExecutable("powershell");
// Guard tests run with a minimal PATH, so a Git-for-Windows grep/head/sed on the real PATH cannot
// turn an expected deny into an allow. pwsh stays reachable for the parser check.
let pwshDir = pwsh ? path.dirname(pwsh) : null;
if (pwsh && !isWin) {
  // On Linux and macOS the directory that holds pwsh also holds head, grep and sed, so expose
  // pwsh alone through a private bin directory.
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
const guardEnv = { ...process.env, PATH: minPath, Path: minPath };

const logLines = [];
const log = (m) => logLines.push(m);
const opts = { log };

after(() => {
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function newDir(name) {
  const d = path.join(work, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function newGitRepo(name) {
  const d = newDir(name);
  git(d, "init", "-q");
  git(d, "config", "core.autocrlf", "false");
  return d;
}

function eolInfo(p) {
  const b = fs.readFileSync(p);
  const s = b.toString("utf8");
  return {
    bytes: b.length,
    bom: b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf,
    crlf: (s.match(/\r\n/g) ?? []).length,
    lf: (s.match(/(?<!\r)\n/g) ?? []).length,
  };
}

function editPayload(dir, toolArgs, tool = "edit", asString = true) {
  return {
    sessionId: "s",
    timestamp: new Date(),
    workingDirectory: dir,
    toolName: tool,
    toolArgs: asString ? JSON.stringify(toolArgs) : toolArgs,
    toolResult: { resultType: "success", textResultForLlm: "ok" },
  };
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const utf8 = (s) => Buffer.from(s, "utf8");

// ---------------------------------------------------------------- normalize-eol
describe("normalizeEol", () => {
  const d = newDir("plain");

  it("BOM+CRLF file -> LF, no BOM (toolArgs as JSON string, relative path)", async () => {
    fs.writeFileSync(path.join(d, "a.txt"), Buffer.concat([BOM, utf8("one\r\ntwo\r\nthree\r\n")]));
    const r = await g.normalizeEol(editPayload(d, { path: "a.txt", old_str: "x", new_str: "y" }), opts);
    const i = eolInfo(path.join(d, "a.txt"));
    assert.deepEqual(i, { bytes: 14, bom: false, crlf: 0, lf: 3 });
    assert.equal(r[0].changed, true);
    assert.equal(r[0].bomRemoved, true);
  });

  it("CRLF without trailing newline -> LF, still no trailing newline (toolArgs object, absolute file_path)", async () => {
    fs.writeFileSync(path.join(d, "b.txt"), utf8("one\r\ntwo"));
    await g.normalizeEol(editPayload(d, { file_path: path.join(d, "b.txt") }, "create", false), opts);
    assert.deepEqual(eolInfo(path.join(d, "b.txt")), { bytes: 7, bom: false, crlf: 0, lf: 1 });
  });

  it(".bat file -> CRLF by extension list", async () => {
    fs.writeFileSync(path.join(d, "run.bat"), utf8("@echo off\necho hi\n"));
    await g.normalizeEol(editPayload(d, { path: "run.bat" }), opts);
    const i = eolInfo(path.join(d, "run.bat"));
    assert.equal(i.crlf, 2);
    assert.equal(i.lf, 0);
  });

  it("binary file (NUL byte) untouched", async () => {
    fs.writeFileSync(path.join(d, "img.bin"), Buffer.from([0x89, 0x50, 0x0d, 0x0a, 0x00, 0x0d, 0x0a]));
    await g.normalizeEol(editPayload(d, { path: "img.bin" }), opts);
    assert.equal(fs.statSync(path.join(d, "img.bin")).size, 7);
  });

  it("apply_patch: file path parsed from patch text", async () => {
    fs.writeFileSync(path.join(d, "p.txt"), utf8("a\r\nb\r\n"));
    const patch = "*** Begin Patch\n*** Update File: p.txt\n@@\n-a\n+b\n*** End Patch";
    await g.normalizeEol(editPayload(d, { patch }, "apply_patch"), opts);
    const i = eolInfo(path.join(d, "p.txt"));
    assert.equal(i.crlf, 0);
    assert.equal(i.lf, 2);
  });

  it("unknown toolArgs shape -> no files touched, NO PATH KEY logged", async () => {
    const before = logLines.length;
    const r = await g.normalizeEol(editPayload(d, { something: "else" }), opts);
    assert.deepEqual(r, []);
    assert.ok(logLines.slice(before).some((l) => l.startsWith("NO PATH KEY")));
  });

  it("WINDOWS_GUARD_DEFAULT_EOL=crlf keeps CRLF", async () => {
    fs.writeFileSync(path.join(d, "c.txt"), utf8("x\r\ny\r\n"));
    await g.normalizeEol(editPayload(d, { path: "c.txt" }), { ...opts, env: { ...process.env, WINDOWS_GUARD_DEFAULT_EOL: "crlf" } });
    const i = eolInfo(path.join(d, "c.txt"));
    assert.equal(i.crlf, 2);
    assert.equal(i.lf, 0);
  });

  it("WINDOWS_GUARD_KEEP_BOM_EXT keeps the BOM but still fixes the ending", async () => {
    fs.writeFileSync(path.join(d, "k.ps1"), Buffer.concat([BOM, utf8("a\r\nb\r\n")]));
    await g.normalizeEol(editPayload(d, { path: "k.ps1" }), { ...opts, env: { ...process.env, WINDOWS_GUARD_KEEP_BOM_EXT: ".ps1" } });
    assert.deepEqual(eolInfo(path.join(d, "k.ps1")), { bytes: 7, bom: true, crlf: 0, lf: 2 });
  });

  it("missing file -> nothing happens", async () => {
    const r = await g.normalizeEol(editPayload(d, { path: "nope.txt" }), opts);
    assert.deepEqual(r, []);
  });

  describe("git policies", { skip: !haveGit && "git not found" }, () => {
    it(".gitattributes eol=crlf wins for an untracked file", async () => {
      const gd = newGitRepo("attr");
      fs.writeFileSync(path.join(gd, ".gitattributes"), "*.txt text eol=crlf\n*.lf text eol=lf\n*.bin -text\n");
      fs.writeFileSync(path.join(gd, "x.txt"), utf8("a\nb\n"));
      await g.normalizeEol(editPayload(gd, { path: "x.txt" }), opts);
      const i = eolInfo(path.join(gd, "x.txt"));
      assert.equal(i.crlf, 2);
      assert.equal(i.lf, 0);

      fs.writeFileSync(path.join(gd, "y.lf"), Buffer.concat([BOM, utf8("a\r\nb\r\n")]));
      await g.normalizeEol(editPayload(gd, { path: "y.lf" }), opts);
      assert.deepEqual(eolInfo(path.join(gd, "y.lf")), { bytes: 4, bom: false, crlf: 0, lf: 2 });

      fs.writeFileSync(path.join(gd, "z.bin"), utf8("a\r\nb\r\n"));
      const r = await g.normalizeEol(editPayload(gd, { path: "z.bin" }), opts);
      assert.equal(eolInfo(path.join(gd, "z.bin")).crlf, 2, "-text file left alone");
      assert.equal(r[0].skipped, true);
    });

    it("tracked CRLF file (index i/crlf) edited to LF -> restored to CRLF", async () => {
      const gd = newGitRepo("index");
      fs.writeFileSync(path.join(gd, "t.cs"), utf8("a\r\nb\r\n"));
      git(gd, "add", "t.cs");
      git(gd, "commit", "-q", "-m", "init");
      fs.writeFileSync(path.join(gd, "t.cs"), utf8("a\nb-edited\n"));
      await g.normalizeEol(editPayload(gd, { path: "t.cs" }), opts);
      const i = eolInfo(path.join(gd, "t.cs"));
      assert.equal(i.crlf, 2);
      assert.equal(i.lf, 0);
    });

    it("core.autocrlf=true -> working tree CRLF", async () => {
      const gd = newGitRepo("autocrlf");
      git(gd, "config", "core.autocrlf", "true");
      fs.writeFileSync(path.join(gd, "n.txt"), utf8("a\nb\n"));
      await g.normalizeEol(editPayload(gd, { path: "n.txt" }), opts);
      const i = eolInfo(path.join(gd, "n.txt"));
      assert.equal(i.crlf, 2);
      assert.equal(i.lf, 0);
    });
  });
});

// ---------------------------------------------------------------- shell-guard
describe("shellGuard", () => {
  async function expectGuard(cmd, expectDeny, hint = "") {
    const d = await g.shellGuard(cmd, { ...opts, env: guardEnv });
    const denied = Boolean(d && d.permissionDecision === "deny");
    assert.equal(denied, expectDeny, `decision for: ${cmd}\n${JSON.stringify(d)}`);
    if (hint) {
      const reason = d?.permissionDecisionReason ?? "";
      assert.ok(reason.toLowerCase().includes(hint.toLowerCase()), `hint '${hint}' missing in: ${reason}`);
    }
  }
  const parserOpts = { skip: !pwsh && "no PowerShell host for the parser check" };

  it("deny: heredoc", () => expectGuard("cat <<EOF > x.txt\nhello\nEOF", true));
  it("deny: head -5 file.txt", () => expectGuard("head -5 file.txt", true, "Select-Object"));
  it("deny: | grep | head", () => expectGuard("dotnet build 2>&1 | grep error | head -20", true, "Select-String"));
  it("deny: 2>/dev/null", () => expectGuard("ls 2>/dev/null", true, "2>$null"));
  it("deny: echo > file", () => expectGuard('echo "hello" > out.txt', true, "edit/create tool"));
  it("allow: echo > file # wg:allow", () => expectGuard('echo "hello" > out.txt # wg:allow', false));
  it("deny: Set-Content without encoding", () => expectGuard('"text" | Set-Content out.txt', true, "utf8NoBOM"));
  it("allow: Out-File -Encoding utf8NoBOM", () => expectGuard("Get-Content x.txt | Out-File -Encoding utf8NoBOM -FilePath y.txt", false));
  it("deny: $home assignment", () => expectGuard("$home = 'C:\\x'; Remove-Item -Recurse -Force $home", true, "HOME"));
  it("deny: unterminated string (parser)", parserOpts, () => expectGuard('echo "unterminated', true, "cannot parse"));
  it("deny: bash escaped quotes", () => expectGuard('echo "{\\"a\\":1}"', true));
  it("deny: VAR=value cmd", () => expectGuard("FOO=bar npm run build", true, "$env:"));
  it("deny: export VAR=value", () => expectGuard("export FOO=bar", true, "$env:"));
  it("deny: dir /s", () => expectGuard("dir /s *.cs", true, "Get-ChildItem"));
  it("deny: python -c file write", () => expectGuard("python -c \"open('x','w').write('hi')\"", true, "create tool"));
  it("deny: find . -name", () => expectGuard('find . -name "*.cs"', true, "Get-ChildItem"));
  it("deny: bash for loop (parser)", parserOpts, () => expectGuard("for f in *.txt; do echo $f; done", true, "cannot parse"));
  it("deny: echo -e", () => expectGuard('echo -e "a\\nb"', true, "Write-Output"));
  it("allow: Select-Object -First", () => expectGuard("Get-Content x.txt | Select-Object -First 5", false));
  it("allow: 2>$null", () => expectGuard("dotnet build 2>$null", false));
  it("allow: 2>&1 | Select-String", () => expectGuard("dotnet build 2>&1 | Select-String error", false));
  it("allow: npm run build -- --flag", () => expectGuard("npm run build -- --flag", false));
  it("allow: doubled single quote", () => expectGuard("git commit -m 'it''s done'", false));
  it("allow: gh pr create --body-file", () => expectGuard("gh pr create --body-file body.md", false));
  it("allow: if block", () => expectGuard("if ($x -gt 5) { 'big' }", false));
  it("allow: Where-Object -gt", () => expectGuard("Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1000 }", false));
  it("allow: curl.exe", () => expectGuard("curl.exe -s https://example.com", false));
  it("allow: PowerShell for loop", () => expectGuard("for ($i = 0; $i -lt 3; $i++) { $i }", false));
  it("allow: variable assignment", () => expectGuard('$x = 5; Write-Output "x is $x"', false));
  it("allow: node -e console.log", () => expectGuard('node -e "console.log(1)"', false));
  it("allow: JSON in single quotes", () => expectGuard("npm run build -- '{\\\"a\\\":1}'", false));
  it("allow: [IO.File]::WriteAllText", () => expectGuard("[IO.File]::WriteAllText('x.txt', 'hi', [Text.UTF8Encoding]::new($false))", false));
  it("deny: > inside a quoted pattern (heuristic)", () => expectGuard('Get-Content x | Select-String -Pattern "a>b"', true));
  it("allow: > inside a quoted pattern # wg:allow", () => expectGuard('Get-Content x | Select-String -Pattern "a>b" # wg:allow', false));
  it("allow: empty or missing command", async () => {
    assert.equal(await g.shellGuard("", opts), null);
    assert.equal(await g.shellGuard(undefined, opts), null);
  });
  it("WINDOWS_GUARD_PARSER=off skips the parser", async () => {
    const d = await g.shellGuard('echo "unterminated', { ...opts, env: { ...guardEnv, WINDOWS_GUARD_PARSER: "off" } });
    assert.equal(d, null);
  });
  it("parser host found on PATH", parserOpts, async () => {
    const errors = await g.parsePowerShell("Get-ChildItem | Select-Object -First 1", { ...opts, env: guardEnv });
    assert.deepEqual(errors, []);
  });
});

// ---------------------------------------------------------------- utf8-gate
describe("utf8Gate", () => {
  const u = newDir("enc");
  fs.writeFileSync(path.join(u, "cp1252.txt"), Buffer.concat([utf8("copyright "), Buffer.from([0xa9]), utf8(" 2026\n")]));
  fs.writeFileSync(path.join(u, "utf16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi\n", "utf16le")]));
  fs.writeFileSync(path.join(u, "utf8.txt"), utf8("caf\u00e9\n"));
  fs.writeFileSync(path.join(u, "ascii.txt"), utf8("plain\n"));
  fs.writeFileSync(path.join(u, "bom.txt"), Buffer.concat([BOM, utf8("ok\n")]));

  function gate(file) {
    return g.utf8Gate(
      { sessionId: "s", timestamp: new Date(), workingDirectory: u, toolName: "edit", toolArgs: JSON.stringify({ path: file, old_str: "a", new_str: "b" }) },
      opts,
    );
  }
  it("deny: Windows-1252 file", () => {
    const d = gate("cp1252.txt");
    assert.equal(d?.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /Windows-1252/);
  });
  it("deny: UTF-16 file", () => {
    const d = gate("utf16.txt");
    assert.equal(d?.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /UTF-16/);
  });
  it("allow: UTF-8 with non-ASCII", () => assert.equal(gate("utf8.txt"), null));
  it("allow: ASCII", () => assert.equal(gate("ascii.txt"), null));
  it("allow: UTF-8 with BOM", () => assert.equal(gate("bom.txt"), null));
  it("allow: file does not exist", () => assert.equal(gate("does-not-exist.txt"), null));
});

// ---------------------------------------------------------------- recovery-coach
describe("coach (postToolUseFailure)", () => {
  function coach(tool, toolArgs, err, expectAdvice, hint = "") {
    const out = g.coachFailure(tool, toolArgs, err, opts);
    if (expectAdvice) {
      assert.ok(out, `expected advice for: ${err}`);
      if (hint) assert.ok(out.toLowerCase().includes(hint.toLowerCase()), `hint '${hint}' missing in: ${out}`);
    } else {
      assert.equal(out, null, `expected no advice for: ${err}\n${out}`);
    }
  }
  it("head not recognized -> Select-Object", () =>
    coach("powershell", { command: "head -5 x" }, "head: The term 'head' is not recognized as a name of a cmdlet, function, script file, or executable program.", true, "Select-Object"));
  it("missing terminator -> quoting", () => coach("powershell", { command: 'echo "a' }, 'The string is missing the terminator: ".', true, "quoting"));
  it("&& under 5.1 -> PowerShell 5.1 advice", () => coach("powershell", { command: "a && b" }, "The token '&&' is not a valid statement separator in this version.", true, "PowerShell 5.1"));
  it("npm missing script -> silent", () => coach("powershell", { command: "npm run x" }, "npm ERR! missing script: x", false));
  it("unknown executable -> PATH advice", () => coach("powershell", { command: "frob" }, "frob: The term 'frob' is not recognized as a name of a cmdlet", true, "Get-Command frob"));
  it("edit No match found -> view again", () => coach("edit", { path: "a.txt", old_str: "x", new_str: "y" }, "No match found for old_str in a.txt", true, "view"));
  it("edit unrelated error -> silent", () => coach("edit", { path: "a.txt" }, "Something unrelated happened", false));
  it("view File not found -> silent", () => coach("view", { path: "a.txt" }, "File not found", false));
  it("denied by preToolUse -> silent", () =>
    coach("powershell", { command: 'echo "a' }, "Denied by preToolUse hook: PowerShell cannot parse this command: The string is missing the terminator. PowerShell quoting: ...", false));
});

describe("coach (postToolUse shell result)", () => {
  function coach(tool, toolArgs, text, expectAdvice, hint = "") {
    const out = g.coachResult(tool, toolArgs, text, opts);
    if (expectAdvice) {
      assert.ok(out, `expected advice for: ${text}`);
      if (hint) assert.ok(out.toLowerCase().includes(hint.toLowerCase()), `hint '${hint}' missing in: ${out}`);
    } else {
      assert.equal(out, null, `expected no advice for: ${text}\n${out}`);
    }
  }
  it("exit code 1 + head not recognized -> Select-Object", () =>
    coach("powershell", { command: "head -3 x.txt" }, "head: The term 'head' is not recognized as a name of a cmdlet, function, script file, or executable program.\n<shellId: 0 completed with exit code 1>", true, "Select-Object"));
  it("exit code 0 -> silent", () => coach("powershell", { command: "Get-Content x.txt" }, "alpha\nbeta\n<shellId: 0 completed with exit code 0>", false));
  it("ParserError -> quoting", () =>
    coach("powershell", { command: 'echo "a' }, 'ParserError: \nLine |\n   1 |  echo "a\n     | The string is missing the terminator: ".\n<shellId: 0 completed with exit code 1>', true, "quoting"));
  it("Cannot find path (exit 1, unrecognized cause) -> silent", () =>
    coach("powershell", { command: "Get-Item .\\does-not-exist.txt" }, "Get-Item: Cannot find path 'C:\\x\\does-not-exist.txt' because it does not exist.\n<shellId: 0 completed with exit code 1>", false));
  it("edit tool results are not coached here", () => coach("edit", { path: "a.txt" }, "No match found", false));
});

// ---------------------------------------------------------------- inject-rules
describe("loadRules", () => {
  it("returns the rules file text", () => {
    const text = g.loadRules(rulesDir);
    assert.ok(text?.includes("Windows environment rules"));
    assert.ok(text?.includes("edit and create tools"));
  });
  it("missing directory -> null", () => assert.equal(g.loadRules(path.join(work, "no-rules")), null));
});

// ---------------------------------------------------------------- liveness marker
describe("active marker (what the hooks.json launchers check in extension mode)", () => {
  const home = newDir("home");
  const env = { ...process.env, LOCALAPPDATA: home };

  it("writes <LOCALAPPDATA>/copilot-windows-guard/active/<sessionId> holding the PID", () => {
    const p = g.writeActiveMarker("abc-123", { env, pid: 4242, log });
    assert.equal(p, path.join(home, "copilot-windows-guard", "active", "abc-123"));
    assert.equal(fs.readFileSync(p, "utf8"), "4242\n");
  });
  it("sanitizes the session id used as a file name", () => {
    const p = g.writeActiveMarker("../x/y", { env, pid: 1, log });
    assert.equal(path.basename(p), ".._x_y");
    assert.equal(path.dirname(p), path.join(home, "copilot-windows-guard", "active"));
  });
  it("removes the marker and tolerates a missing one", () => {
    assert.equal(g.removeActiveMarker("abc-123", { env }), true);
    assert.equal(fs.existsSync(path.join(home, "copilot-windows-guard", "active", "abc-123")), false);
    assert.equal(g.removeActiveMarker("abc-123", { env }), false);
    assert.equal(g.removeActiveMarker(undefined, { env }), false);
  });
  it("no session id -> no marker", () => assert.equal(g.writeActiveMarker("", { env, log }), null));
});

// ---------------------------------------------------------------- session hook wiring
describe("buildHooks (what extension.mjs registers)", () => {
  const hooks = g.buildHooks({ rulesDir, env: guardEnv, log });
  const d = newDir("hooks");

  it("onSessionStart injects the rules as additionalContext", async () => {
    const out = await hooks.onSessionStart({ sessionId: "s", timestamp: new Date(), workingDirectory: d, source: "startup" });
    assert.ok(out.additionalContext.includes("Windows environment rules"));
  });
  it("onPreToolUse denies a Unix command on the shell tool", async () => {
    const out = await hooks.onPreToolUse({ sessionId: "s", timestamp: new Date(), workingDirectory: d, toolName: "powershell", toolArgs: { command: "head -5 x" } });
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /Select-Object/);
  });
  it("onPreToolUse returns undefined (no change) for an allowed command", async () => {
    const out = await hooks.onPreToolUse({ sessionId: "s", timestamp: new Date(), workingDirectory: d, toolName: "powershell", toolArgs: { command: "Get-ChildItem" } });
    assert.equal(out, undefined);
  });
  it("onPreToolUse gates an edit of a Windows-1252 file and allows UTF-8", async () => {
    fs.writeFileSync(path.join(d, "legacy.txt"), Buffer.concat([utf8("caf"), Buffer.from([0xe9]), utf8("\n")]));
    fs.writeFileSync(path.join(d, "fine.txt"), utf8("caf\u00e9\n"));
    const denied = await hooks.onPreToolUse({ sessionId: "s", timestamp: new Date(), workingDirectory: d, toolName: "edit", toolArgs: { path: path.join(d, "legacy.txt"), old_str: "a", new_str: "b" } });
    assert.equal(denied.permissionDecision, "deny");
    const allowed = await hooks.onPreToolUse({ sessionId: "s", timestamp: new Date(), workingDirectory: d, toolName: "edit", toolArgs: { path: path.join(d, "fine.txt"), old_str: "a", new_str: "b" } });
    assert.equal(allowed, undefined);
  });
  it("onPostToolUse normalizes a created file (absolute path, file_text as the CLI sends it)", async () => {
    const f = path.join(d, "created.txt");
    fs.writeFileSync(f, Buffer.concat([BOM, utf8("one\r\ntwo\r\nthree\r\n")]));
    const out = await hooks.onPostToolUse({
      sessionId: "s",
      timestamp: new Date(),
      workingDirectory: d,
      toolName: "create",
      toolArgs: { path: f, file_text: "one\ntwo\nthree\n" },
      toolResult: { resultType: "success", textResultForLlm: "Created created.txt (17 characters)" },
    });
    assert.equal(out, undefined);
    assert.deepEqual(eolInfo(f), { bytes: 14, bom: false, crlf: 0, lf: 3 });
  });
  it("onPostToolUse appends coach guidance to a failed shell result", async () => {
    const out = await hooks.onPostToolUse({
      sessionId: "s",
      timestamp: new Date(),
      workingDirectory: d,
      toolName: "powershell",
      toolArgs: { command: "frobnicate --version" },
      toolResult: { resultType: "success", textResultForLlm: "frobnicate: The term 'frobnicate' is not recognized as a name of a cmdlet, function, script file, or executable program.\n<shellId: 0 completed with exit code 1>" },
    });
    assert.match(out.additionalContext, /Get-Command frobnicate/);
  });
  it("onPostToolUse stays silent for a successful shell result", async () => {
    const out = await hooks.onPostToolUse({ sessionId: "s", timestamp: new Date(), workingDirectory: d, toolName: "powershell", toolArgs: { command: "Get-Date" }, toolResult: { resultType: "success", textResultForLlm: "2026\n<shellId: 0 completed with exit code 0>" } });
    assert.equal(out, undefined);
  });
  it("onPostToolUseFailure coaches an edit mismatch", async () => {
    const out = await hooks.onPostToolUseFailure({ sessionId: "s", timestamp: new Date(), workingDirectory: d, toolName: "edit", toolArgs: { path: "a.txt" }, error: "No match found" });
    assert.match(out.additionalContext, /view tool/);
  });
  it("onSessionEnd removes the session's marker", async () => {
    const home = newDir("home2");
    const h = g.buildHooks({ rulesDir, env: { ...guardEnv, LOCALAPPDATA: home }, log });
    const p = g.writeActiveMarker("end-1", { env: { LOCALAPPDATA: home }, pid: 1, log });
    assert.ok(fs.existsSync(p));
    const out = await h.onSessionEnd({ sessionId: "end-1", timestamp: new Date(), workingDirectory: d, reason: "user_exit" });
    assert.equal(out, undefined);
    assert.equal(fs.existsSync(p), false);
  });
  it("hooks fail open on garbage input", async () => {
    assert.equal(await hooks.onPreToolUse(null), undefined);
    assert.equal(await hooks.onPostToolUse({ toolName: "create", toolArgs: 42 }), undefined);
    assert.equal(await hooks.onPostToolUseFailure(undefined), undefined);
  });
});
