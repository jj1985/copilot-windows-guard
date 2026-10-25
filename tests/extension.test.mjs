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

  describe("final newline", () => {
    const e = newDir("finalnl");
    fs.writeFileSync(path.join(e, ".editorconfig"), "root = true\n[*]\ninsert_final_newline = true\n[*.md]\ninsert_final_newline = false\n[*.{bat,cmd}]\nend_of_line = crlf\n");
    const nested = path.join(e, "sub");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, ".editorconfig"), "root = true\n");
    const offEnv = { ...process.env, WINDOWS_GUARD_FINAL_NEWLINE: "0" };
    const onEnv = { ...process.env, WINDOWS_GUARD_FINAL_NEWLINE: "1" };

    it(".editorconfig insert_final_newline = true adds the missing newline", async () => {
      fs.writeFileSync(path.join(e, "t.txt"), utf8("a\r\nb"));
      await g.normalizeEol(editPayload(e, { path: "t.txt" }), opts);
      assert.deepEqual(eolInfo(path.join(e, "t.txt")), { bytes: 4, bom: false, crlf: 0, lf: 2 });
    });
    it("a later section turns it off for .md", async () => {
      fs.writeFileSync(path.join(e, "t.md"), utf8("a\r\nb"));
      await g.normalizeEol(editPayload(e, { path: "t.md" }), opts);
      assert.deepEqual(eolInfo(path.join(e, "t.md")), { bytes: 3, bom: false, crlf: 0, lf: 1 });
    });
    it("a CRLF file gets a CRLF final newline", async () => {
      fs.writeFileSync(path.join(e, "run.bat"), utf8("@echo off\necho hi"));
      await g.normalizeEol(editPayload(e, { path: "run.bat" }), opts);
      const s = fs.readFileSync(path.join(e, "run.bat"), "utf8");
      assert.equal(s, "@echo off\r\necho hi\r\n");
    });
    it("WINDOWS_GUARD_FINAL_NEWLINE=0 overrides .editorconfig", async () => {
      fs.writeFileSync(path.join(e, "u.txt"), utf8("a\r\nb"));
      await g.normalizeEol(editPayload(e, { path: "u.txt" }), { ...opts, env: offEnv });
      assert.deepEqual(eolInfo(path.join(e, "u.txt")), { bytes: 3, bom: false, crlf: 0, lf: 1 });
    });
    it("WINDOWS_GUARD_FINAL_NEWLINE=1 works without any .editorconfig", async () => {
      const plain2 = newDir("finalnl-plain");
      fs.writeFileSync(path.join(plain2, "v.txt"), utf8("a\r\nb"));
      await g.normalizeEol(editPayload(plain2, { path: "v.txt" }), { ...opts, env: onEnv });
      assert.deepEqual(eolInfo(path.join(plain2, "v.txt")), { bytes: 4, bom: false, crlf: 0, lf: 2 });
    });
    it("a nested root = true stops the search before the parent's setting", async () => {
      fs.writeFileSync(path.join(nested, "w.txt"), utf8("a\r\nb"));
      await g.normalizeEol(editPayload(nested, { path: "w.txt" }), opts);
      assert.deepEqual(eolInfo(path.join(nested, "w.txt")), { bytes: 3, bom: false, crlf: 0, lf: 1 });
    });
    it("a file that already ends with a newline is left alone", async () => {
      fs.writeFileSync(path.join(e, "x.txt"), utf8("a\nb\n"));
      const r = await g.normalizeEol(editPayload(e, { path: "x.txt" }), opts);
      assert.equal(r[0].changed, false);
    });
    it("glob matching: **, ?, [class], {a,b}, and a slash anchors to the config directory", () => {
      assert.equal(g.editorConfigGlobMatches("*", "docs/a.md"), true);
      assert.equal(g.editorConfigGlobMatches("*.md", "docs/a.md"), true);
      assert.equal(g.editorConfigGlobMatches("docs/*.md", "docs/a.md"), true);
      assert.equal(g.editorConfigGlobMatches("docs/*.md", "src/a.md"), false);
      assert.equal(g.editorConfigGlobMatches("**.py", "a/b/c.py"), true);
      assert.equal(g.editorConfigGlobMatches("?.txt", "a.txt"), true);
      assert.equal(g.editorConfigGlobMatches("[ab].txt", "b.txt"), true);
      assert.equal(g.editorConfigGlobMatches("{Makefile,*.mk}", "Makefile"), true);
      assert.equal(g.editorConfigGlobMatches("*.{bat,cmd}", "run.cmd"), true);
      assert.equal(g.editorConfigGlobMatches("*.{bat,cmd}", "run.ps1"), false);
    });
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
describe("shellGuard", { skip: !pwsh && "no PowerShell host for the analyzer" }, () => {
  async function expectGuard(cmd, expectDeny, hint = "") {
    const d = await g.shellGuard(cmd, { ...opts, env: guardEnv, cwd: work });
    const denied = Boolean(d && d.permissionDecision === "deny");
    assert.equal(denied, expectDeny, `decision for: ${cmd}\n${JSON.stringify(d)}`);
    if (hint) {
      const reason = d?.permissionDecisionReason ?? "";
      assert.ok(reason.toLowerCase().includes(hint.toLowerCase()), `hint '${hint}' missing in: ${reason}`);
    }
  }

  it("deny: heredoc", () => expectGuard("cat <<EOF > x.txt\nhello\nEOF", true));
  it("deny: head -5 file.txt", () => expectGuard("head -5 file.txt", true, "Select-Object"));
  it("deny: | grep | head", () => expectGuard("dotnet build 2>&1 | grep error | head -20", true, "Select-String"));
  it("deny: 2>/dev/null", () => expectGuard("ls 2>/dev/null", true, "2>$null"));
  it("deny: echo > file", () => expectGuard('echo "hello" > out.txt', true, "edit/create tool"));
  it("allow: echo > file # wg:allow", () => expectGuard('echo "hello" > out.txt # wg:allow', false));
  it("deny: Set-Content without encoding", () => expectGuard('"text" | Set-Content out.txt', true, "utf8NoBOM"));
  it("allow: Out-File -Encoding utf8NoBOM", () => expectGuard("Get-Content x.txt | Out-File -Encoding utf8NoBOM -FilePath y.txt", false));
  it("deny: $home assignment", () => expectGuard("$home = 'C:\\x'; Remove-Item -Recurse -Force $home", true, "HOME"));
  it("deny: unterminated string (parser)", () => expectGuard('echo "unterminated', true, "cannot parse"));
  it("deny: bash escaped quotes", () => expectGuard('echo "{\\"a\\":1}"', true));
  it("deny: VAR=value cmd", () => expectGuard("FOO=bar npm run build", true, "$env:"));
  it("deny: export VAR=value", () => expectGuard("export FOO=bar", true, "$env:"));
  it("deny: dir /s", () => expectGuard("dir /s *.cs", true, "Get-ChildItem"));
  it("deny: python -c file write", () => expectGuard("python -c \"open('x','w').write('hi')\"", true, "create tool"));
  it("deny: find . -name", () => expectGuard('find . -name "*.cs"', true, "Get-ChildItem"));
  it("deny: bash for loop (parser)", () => expectGuard("for f in *.txt; do echo $f; done", true, "cannot parse"));
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
  it("allow: > inside a quoted pattern (AST, not text)", () => expectGuard('Get-Content x | Select-String -Pattern "a>b"', false));
  it("allow: > inside a quoted pattern # wg:allow", () => expectGuard('Get-Content x | Select-String -Pattern "a>b" # wg:allow', false));
  it("allow: empty or missing command", async () => {
    assert.equal(await g.shellGuard("", opts), null);
    assert.equal(await g.shellGuard(undefined, opts), null);
  });
  it("WINDOWS_GUARD_PARSER=off skips the parser", async () => {
    const d = await g.shellGuard('echo "unterminated', { ...opts, env: { ...guardEnv, WINDOWS_GUARD_PARSER: "off" } });
    assert.equal(d, null);
  });
  it("analyzeCommand returns allow for a clean command", async () => {
    const d = await g.analyzeCommand("Get-ChildItem | Select-Object -First 1", { ...opts, env: guardEnv });
    assert.deepEqual(d, { decision: "allow" });
  });
  it("allow: > inside a single-quoted regex", () => expectGuard("Select-String -Path log.txt -Pattern '<[^>]+>'", false));
  it("allow: => inside a double-quoted string", () => expectGuard('Write-Output "key => value"', false));
  it("allow: comparison inside a here-string piped to python", () => expectGuard("@'\nif i >= 0:\n    print(i)\n'@ | python -", false));
  it("allow: read-only open() in python -c", () => expectGuard("python -c \"import json; print(json.load(open('cfg.json'))['name'])\"", false));
  it("allow: the word head inside a quoted argument", () => expectGuard('gh pr comment 12 --body "Rebased onto main (head ecba1d7)"', false));
  it("allow: a Unix pipeline inside a wsl argument", () => expectGuard("wsl bash -lc 'ls -la | head -3'", false));
  it("allow: conflict marker inside a string", () => expectGuard("Select-String -Path a.txt -Pattern '<<<<<<< HEAD'", false));
  it("allow: a path ending in a backslash", () => expectGuard('cd "C:\\Windows\\"; Get-ChildItem', false));
  it("deny: bash escape with a single quote elsewhere", () => expectGuard("python -c \"d = {'a': 1}; print(\\\"ok\\\")\"", true));
  it("deny: multi-line python -c", () => expectGuard("python -c \"import os\nfor f in os.listdir('.'):\n    print(f)\"", true, "here-string"));
  it("allow: multi-line python -c with # wg:allow", () => expectGuard("python -c \"import os\nprint(os.getcwd())\" # wg:allow", false));
  it("deny: input redirection <", () => expectGuard("sort < names.txt", true, "Get-Content"));
  it("deny: head inside a script block", () => expectGuard("Get-ChildItem | ForEach-Object { head $_ }", true, "Select-Object"));
  it("deny: 2> to a file", () => expectGuard("dotnet build 2> errors.txt", true, "edit/create tool"));
  it("allow: Set-Content with -Encoding:utf8", () => expectGuard("'x' | Set-Content -Encoding:utf8 out.txt", false));
  // Phase 3: silent wrong-directory and wrong-data failures.
  it("deny: relative .NET path after cd", () => expectGuard("cd C:\\Windows; [IO.File]::Exists('probe.txt')", true, "Resolve-Path"));
  it("allow: relative .NET path without cd", () => expectGuard("[IO.File]::Exists('probe.txt')", false));
  it("allow: absolute .NET path after cd", () => expectGuard("cd C:\\Windows; [IO.File]::Exists('C:\\Windows\\notepad.exe')", false));
  it("allow: $PWD-based .NET path after cd", () => expectGuard('cd C:\\Windows; [IO.File]::Exists("$PWD\\notepad.exe")', false));
  it("deny: .NET path from a variable assigned a relative literal", () => expectGuard("cd C:\\Windows; $p = 'out.txt'; [IO.File]::WriteAllText($p, 'x')", true, "Resolve-Path"));
  it("deny: cd to a missing folder followed by more statements", () => expectGuard("cd C:\\nonexistent-wg; Get-Location", true, "ErrorAction Stop"));
  it("deny: cd to a missing relative folder followed by more statements", () => expectGuard("cd nope-sub; Get-ChildItem", true, "ErrorAction Stop"));
  it("allow: cd to an existing folder followed by more statements", () => expectGuard("cd C:\\Windows; Get-Location", false));
  it("allow: cd to a missing folder as the only statement", () => expectGuard("cd C:\\nonexistent-wg", false));
  it("allow: mkdir then cd into it", () => expectGuard("New-Item -ItemType Directory -Force C:\\nonexistent-wg | Out-Null; cd C:\\nonexistent-wg; Get-ChildItem", false));
  it("deny: 2>&1 into ConvertFrom-Json", () => expectGuard("gh api repos/o/r 2>&1 | ConvertFrom-Json", true, "2>$null"));
  it("deny: 2>&1 into python json.load(sys.stdin)", () => expectGuard("gh api repos/o/r 2>&1 | python -c \"import sys, json; print(json.load(sys.stdin)['name'])\"", true, "2>$null"));
  it("deny: 2>&1 into jq", () => expectGuard("gh api repos/o/r 2>&1 | jq .name", true, "2>$null"));
  it("allow: 2>$null into ConvertFrom-Json", () => expectGuard("gh api repos/o/r 2>$null | ConvertFrom-Json", false));
  it("allow: 2>&1 into Select-String", () => expectGuard("dotnet build 2>&1 | Select-String error", false));
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
  it("create into a missing directory -> New-Item for that directory, then create again", () => {
    const f = path.join(work, "newdir", "sub", "f.txt");
    coach("create", { path: f, file_text: "x" }, "Parent directory does not exist", true, `New-Item -ItemType Directory -Force '${path.dirname(f)}'`);
  });
  it("create into a missing directory without a path -> generic placeholder", () =>
    coach("create", {}, "Parent directory does not exist", true, "-Force <directory>"));
  it("create over an existing file -> view and edit, never delete", () =>
    coach("create", { path: "a.txt", file_text: "x" }, "File already exists", true, "never delete"));
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
  // Phase 3 branches.
  it("failed cd at exit 0 -> previous-folder warning", () =>
    coach("powershell", { command: "cd C:\\nonexistent; Get-Location" }, "Set-Location: Cannot find path 'C:\\nonexistent' because it does not exist.\nC:\\old\n<shellId: 0 completed with exit code 0>", true, "previous folder"));
  it("failed cd in the PowerShell 7 multi-line error layout -> previous-folder warning", () =>
    coach("powershell", { command: "Get-Location; cd nonexistent-sub; Get-Location" }, "Path\n----\nC:\\w\nSet-Location: \nLine |\n   2 |  Get-Location; cd nonexistent-sub; Get-Location\n     |                ~~~~~~~~~~~~~~~~~~\n     | Cannot find path 'C:\\w\\nonexistent-sub' because it does not exist.\nC:\\w\n<shellId: 0 completed with exit code 0>", true, "previous folder"));
  it("Get-Item cannot find path at exit 1 -> still silent", () =>
    coach("powershell", { command: "Get-Item .\\x.txt" }, "Get-Item: Cannot find path 'C:\\x\\x.txt' because it does not exist.\n<shellId: 0 completed with exit code 1>", false));
  it("ConvertFrom-Json failure after 2>&1 -> stderr diagnosis, not quoting", () => {
    const out = g.coachResult("powershell", { command: "gh api repos/o/r 2>&1 | ConvertFrom-Json" }, "ConvertFrom-Json: Conversion from JSON failed with error: Unexpected character encountered while parsing value: g. Path '', line 0, position 0.\n<shellId: 0 completed with exit code 1>", opts);
    assert.match(out, /2>\$null/);
    assert.match(out, /LASTEXITCODE/);
    assert.doesNotMatch(out, /quoting rules/);
  });
  it("JSONDecodeError without 2>&1 -> check the exit code and the first line", () =>
    coach("powershell", { command: "python parse.py" }, "json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)\n<shellId: 0 completed with exit code 1>", true, "first line"));
  // Phase 4: exit-code and error-shape gating, benign exits, new branches.
  it("ParserError words in search output at exit 0 -> silent", () =>
    coach("powershell", { command: "Select-String -Path src\\a.js -Pattern Unexpected" }, "src\\a.js:12:  // Unexpected token in parser\n<shellId: 0 completed with exit code 0>", false));
  it("parse error in the 5.1 error layout at exit 1 -> quoting", () =>
    coach("powershell", { command: 'echo "a' }, 'At line:1 char:6\n+ echo "a\n+      ~~\nThe string is missing the terminator: ".\n<shellId: 0 completed with exit code 1>', true, "quoting"));
  it("git grep exit 1 with no output -> no match, not an error", () => coach("powershell", { command: 'git grep -n "TODO"' }, "<shellId: 0 completed with exit code 1>", true, "no match"));
  it("gh pr checks exit 8 -> pending", () => coach("powershell", { command: "gh pr checks 12" }, "build  pending  0  https://example.com/checks/1\n<shellId: 0 completed with exit code 8>", true, "pending"));
  it("-ErrorAction SilentlyContinue at exit 1 with output -> the output is valid", () =>
    coach("powershell", { command: "Get-Item a.txt, missing.txt -ErrorAction SilentlyContinue" }, "a.txt\n<shellId: 0 completed with exit code 1>", true, "output above is valid"));
  it("UnicodeEncodeError charmap -> PYTHONUTF8", () =>
    coach("powershell", { command: "python report.py" }, "UnicodeEncodeError: 'charmap' codec can't encode character '\\u2713' in position 0: character maps to <undefined>\n<shellId: 0 completed with exit code 1>", true, "PYTHONUTF8"));
  it("ModuleNotFoundError -> uv run --with", () =>
    coach("powershell", { command: "python tool.py" }, "ModuleNotFoundError: No module named 'requests'\n<shellId: 0 completed with exit code 1>", true, "uv run --no-project --with requests"));
  it("Failed to spawn pytest -> uv run --with pytest", () => coach("powershell", { command: "pytest" }, "Failed to spawn: \\pytest\n<shellId: 0 completed with exit code 1>", true, "uv run --with pytest pytest"));
  it("rev-parse needed a single revision -> one ref per call", () =>
    coach("powershell", { command: "git rev-parse --short a1b2c3 d4e5f6" }, "fatal: Needed a single revision\n<shellId: 0 completed with exit code 128>", true, "one ref"));
  it("os error 123 with a wildcard -> Get-ChildItem first", () =>
    coach("powershell", { command: "rg -n TODO src\\*.py" }, "rg: src\\*.py: The filename, directory name, or volume label syntax is incorrect. (os error 123)\n<shellId: 0 completed with exit code 2>", true, "Get-ChildItem"));
  it("a structured exit code 0 silences parse-error words when the marker is absent", () => {
    const out = g.coachResult("powershell", { command: "rg TODO src" }, "src/a.py:1: // ParserError in a comment", { ...opts, exitCode: 0 });
    assert.equal(out, null);
  });
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
  it("onPostToolUseFailure coaches a create into a missing directory with the exact directory", async () => {
    const f = path.join(d, "missing", "f.txt");
    const out = await hooks.onPostToolUseFailure({ sessionId: "s", timestamp: new Date(), workingDirectory: d, toolName: "create", toolArgs: { path: f, file_text: "x" }, error: "Parent directory does not exist" });
    assert.match(out.additionalContext, /New-Item -ItemType Directory -Force/);
    assert.ok(out.additionalContext.includes(path.dirname(f)));
  });
  it("onPostToolUse reads the structured exit code of a shell result", async () => {
    const out = await hooks.onPostToolUse({
      sessionId: "s",
      timestamp: new Date(),
      workingDirectory: d,
      toolName: "powershell",
      toolArgs: { command: "rg TODO src" },
      toolResult: { resultType: "success", textResultForLlm: "src/a.py:3: // ParserError example", contents: [{ type: "shell_exit", shellId: "0", exitCode: 0, cwd: d, outputPreview: "" }] },
    });
    assert.equal(out, undefined);
  });
  it("onSessionStart adds the PYTHONUTF8 note only when the variable is unset", async () => {
    const without = g.buildHooks({ rulesDir, env: { ...guardEnv, PYTHONUTF8: "" }, log });
    const w = await without.onSessionStart({ sessionId: "s", timestamp: new Date(), workingDirectory: d, source: "startup" });
    assert.ok(w.additionalContext.includes("PYTHONUTF8 is not set"));
    const withVar = g.buildHooks({ rulesDir, env: { ...guardEnv, PYTHONUTF8: "1" }, log });
    const v = await withVar.onSessionStart({ sessionId: "s", timestamp: new Date(), workingDirectory: d, source: "startup" });
    assert.ok(!v.additionalContext.includes("PYTHONUTF8 is not set"));
  });
  it("hooks fail open on garbage input", async () => {
    assert.equal(await hooks.onPreToolUse(null), undefined);
    assert.equal(await hooks.onPostToolUse({ toolName: "create", toolArgs: 42 }), undefined);
    assert.equal(await hooks.onPostToolUseFailure(undefined), undefined);
  });
});
