// windows-guard: guard logic for the Copilot CLI extension.
//
// Plain Node.js (18+), no dependencies and no SDK import, so the same module runs under
// `node --test` (tests/extension.test.mjs) and inside the extension process (extension.mjs).
// The coach, the normalizer and the gate mirror scripts/*.ps1 rule for rule and message for message;
// the shell-guard rules are not duplicated at all: both engines run scripts/analyze-command.ps1.
// Every entry point fails open: an internal error is logged and the tool call proceeds untouched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SHELL_TOOLS = new Set(["bash", "powershell"]);
export const EDIT_TOOLS = new Set(["edit", "str_replace_editor", "apply_patch"]);
export const WRITE_TOOLS = new Set(["edit", "create", "str_replace_editor", "apply_patch"]);

const MAX_BYTES = 20 * 1024 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const PATH_KEYS = ["path", "file_path", "filePath", "filename", "fileName", "file", "target_file"];

// ------------------------------------------------------------------ logging

export function getGuardLogDir(env = process.env) {
  for (const v of ["COPILOT_PLUGIN_DATA", "CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"]) {
    if (env[v]) return env[v];
  }
  const base = env.LOCALAPPDATA || env.TEMP || os.tmpdir();
  return path.join(base, "copilot-windows-guard");
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function writeGuardLog(message, env = process.env) {
  try {
    const dir = getGuardLogDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "windows-guard.log"), `${stamp()} [ext] ${message}\n`, "utf8");
  } catch {
    // logging must never affect the tool call
  }
}

// ------------------------------------------------------------------ liveness marker

// In extension mode the hooks.json launchers must know whether the extension is really running
// for this session; otherwise they run the PowerShell scripts as usual, so protection never
// depends on the extension having loaded. The marker is <LOCALAPPDATA>/copilot-windows-guard/
// active/<sessionId> holding the extension's PID: a location both processes can compute, because
// the extension process does not receive the plugin's COPILOT_PLUGIN_DATA.
export function getActiveMarkerDir(env = process.env) {
  const base = env.LOCALAPPDATA || env.TEMP || os.tmpdir();
  return path.join(base, "copilot-windows-guard", "active");
}

export function activeMarkerPath(sessionId, env = process.env) {
  const safe = String(sessionId ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(getActiveMarkerDir(env), safe);
}

export function writeActiveMarker(sessionId, { env = process.env, pid = process.pid, log = writeGuardLog } = {}) {
  if (!sessionId) return null;
  try {
    const dir = getActiveMarkerDir(env);
    fs.mkdirSync(dir, { recursive: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // sessions that ended without cleanup
    for (const n of fs.readdirSync(dir)) {
      try {
        const old = path.join(dir, n);
        if (fs.statSync(old).mtimeMs < cutoff) fs.unlinkSync(old);
      } catch {
        // best effort
      }
    }
    const p = activeMarkerPath(sessionId, env);
    fs.writeFileSync(p, `${pid}
`, "utf8");
    return p;
  } catch (e) {
    log(`ERROR marker: ${e?.message ?? e}`, env);
    return null;
  }
}

export function removeActiveMarker(sessionId, { env = process.env } = {}) {
  if (!sessionId) return false;
  try {
    fs.unlinkSync(activeMarkerPath(sessionId, env));
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ process helpers

function run(file, args, { env = process.env, timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { env, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          const out = String(stdout ?? "");
          const text = `${out}${stderr ?? ""}`.trim();
          if (err && typeof err.code !== "number") return resolve({ code: 999, text, stdout: out, error: err });
          resolve({ code: err ? err.code : 0, text, stdout: out, error: err ?? null });
        },
      );
    } catch (error) {
      resolve({ code: 999, text: "", error });
    }
  });
}

// git with stderr folded in; never throws. Same contract as Invoke-Git in _common.ps1.
export function runGit(dir, args, env = process.env) {
  return run("git", ["-C", dir, ...args], { env });
}

const exeCache = new Map();

// Equivalent of Get-Command <name> -CommandType Application: the first file on PATH named
// <name> plus a PATHEXT extension (or no extension). Returns the full path or null.
export function findExecutable(name, env = process.env) {
  const pathValue = String(env.PATH ?? env.Path ?? "");
  const key = `${name}\0${pathValue}`;
  if (exeCache.has(key)) return exeCache.get(key);
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? ["", ...String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  let found = null;
  outer: for (const d of dirs) {
    for (const e of exts) {
      const candidate = path.join(d, name + e);
      try {
        if (fs.statSync(candidate).isFile()) {
          found = candidate;
          break outer;
        }
      } catch {
        // not there
      }
    }
  }
  exeCache.set(key, found);
  return found;
}

// ------------------------------------------------------------------ payload helpers

export function getToolArgs(input) {
  let ta = input?.toolArgs ?? input?.tool_input ?? null;
  if (typeof ta === "string") {
    try {
      ta = JSON.parse(ta);
    } catch {
      // leave the string; callers treat non-objects as "no arguments"
    }
  }
  return ta;
}

export function getToolName(input) {
  return String(input?.toolName ?? input?.tool_name ?? "");
}

// Absolute paths the tool call targets. Tries the likely path keys, then apply_patch text.
export function getTargetPaths(input, ta = getToolArgs(input)) {
  const paths = [];
  if (ta && typeof ta === "object") {
    for (const k of PATH_KEYS) {
      const v = ta[k];
      if (typeof v === "string" && v) {
        paths.push(v);
        break;
      }
    }
    if (paths.length === 0) {
      for (const k of ["patch", "input"]) {
        const v = ta[k];
        if (typeof v !== "string") continue;
        for (const m of v.matchAll(/^\*\*\* (?:Update|Add) File: (.+)$/gm)) paths.push(m[1].trim());
      }
    }
  }
  const cwd = input?.workingDirectory || input?.cwd || process.cwd();
  return paths.map((p) => (path.isAbsolute(p) ? p : path.join(cwd, p)));
}

// Text of a tool result as the model sees it (postToolUse payloads carry textResultForLlm).
export function resultText(toolResult) {
  if (typeof toolResult === "string") return toolResult;
  if (!toolResult || typeof toolResult !== "object") return "";
  const t = toolResult.textResultForLlm ?? toolResult.text_result_for_llm ?? toolResult.text ?? "";
  return typeof t === "string" ? t : "";
}

function parseFinalNewline(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

// .editorconfig section glob -> RegExp: * (not /), ** (anything), ?, [class], {a,b}.
export function editorConfigGlobToRegExp(glob) {
  let re = "";
  let inBrace = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      re += "(";
      inBrace = true;
    } else if (c === "}") {
      re += ")";
      inBrace = false;
    } else if (c === "," && inBrace) re += "|";
    else if (c === "[") {
      const j = glob.indexOf("]", i);
      if (j > i) {
        re += glob.slice(i, j + 1).replace("[!", "[^");
        i = j;
      } else re += "\\[";
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// A glob without a slash matches the file name anywhere below the .editorconfig; with a slash it
// matches the path relative to that directory (forward slashes).
export function editorConfigGlobMatches(glob, relativePath) {
  let g = glob;
  let target = relativePath;
  if (g.includes("/")) {
    if (g.startsWith("/")) g = g.slice(1);
  } else target = path.posix.basename(relativePath);
  return editorConfigGlobToRegExp(g).test(target);
}

// true or false when a .editorconfig decides insert_final_newline for this file, else null.
// Nearer files override farther ones; a file with root = true ends the search.
export function editorConfigFinalNewline(filePath) {
  const configs = [];
  let d = path.dirname(filePath);
  for (;;) {
    const cfg = path.join(d, ".editorconfig");
    if (fs.existsSync(cfg) && fs.statSync(cfg).isFile()) {
      configs.push(cfg);
      if (/^\s*root\s*=\s*true\s*$/im.test(fs.readFileSync(cfg, "utf8"))) break;
    }
    const parent = path.dirname(d);
    if (!parent || parent === d) break;
    d = parent;
  }
  configs.reverse();
  let result = null;
  for (const cfg of configs) {
    const base = path.dirname(cfg);
    const rel = filePath.slice(base.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
    let inSection = false;
    let applies = false;
    for (const line of fs.readFileSync(cfg, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith(";")) continue;
      if (t.startsWith("[") && t.endsWith("]")) {
        inSection = true;
        applies = editorConfigGlobMatches(t.slice(1, -1), rel);
        continue;
      }
      if (!inSection || !applies) continue;
      const m = t.match(/^insert_final_newline\s*=\s*(\S+)/i);
      if (m) {
        const v = m[1].toLowerCase();
        if (v === "true") result = true;
        else if (v === "false") result = false;
      }
    }
  }
  return result;
}

function splitList(value, fallback) {
  return value ? String(value).split(/[,; ]+/).filter(Boolean) : fallback;
}

function deny(reason) {
  return { permissionDecision: "deny", permissionDecisionReason: reason };
}

// ------------------------------------------------------------------ normalize-eol

// Mirrors normalize-eol.ps1. Target ending, in order:
//   1. .gitattributes eol=lf|crlf (git check-attr); text=unset (-text) skips the file
//   2. core.autocrlf=true -> crlf
//   3. ending already in the git index for a tracked file (i/lf, i/crlf); i/mixed -> keep
//   4. WINDOWS_GUARD_CRLF_EXT list (default .bat .cmd .sln .vcproj .vcxproj) -> crlf
//   5. WINDOWS_GUARD_DEFAULT_EOL (default lf)
// A missing final newline is added when WINDOWS_GUARD_FINAL_NEWLINE=1, or, when that variable is unset,
// when the nearest .editorconfig says insert_final_newline = true for the file (0 never adds one).
// Git is consulted only inside a work tree, so a global core.autocrlf=true cannot leak.
export async function normalizeEol(input, { env = process.env, log = writeGuardLog } = {}) {
  const results = [];
  const ta = getToolArgs(input);
  const files = getTargetPaths(input, ta);
  if (files.length === 0) {
    let argsJson = "";
    try {
      argsJson = JSON.stringify(ta) ?? "";
    } catch {
      // unserializable
    }
    if (argsJson.length > 400) argsJson = `${argsJson.slice(0, 400)}...`;
    log(`NO PATH KEY toolName=${getToolName(input)} toolArgs=${argsJson}`, env);
    return results;
  }
  const policy = {
    env,
    log,
    defaultEol: env.WINDOWS_GUARD_DEFAULT_EOL === "crlf" ? "crlf" : "lf",
    crlfExt: splitList(env.WINDOWS_GUARD_CRLF_EXT, [".bat", ".cmd", ".sln", ".vcproj", ".vcxproj"]),
    keepBomExt: splitList(env.WINDOWS_GUARD_KEEP_BOM_EXT, []),
    finalNewline: parseFinalNewline(env.WINDOWS_GUARD_FINAL_NEWLINE),
  };
  for (const full of files) {
    try {
      const r = await normalizeFile(full, policy);
      if (r) results.push(r);
    } catch (e) {
      log(`ERROR normalize-eol: ${e?.message ?? e}`, env);
    }
  }
  return results;
}

async function normalizeFile(full, policy) {
  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return null;
  const bytes = fs.readFileSync(full);
  if (bytes.includes(0)) return null; // binary
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = bytes.toString("utf8", hasBom ? 3 : 0);

  const dir = path.dirname(full);
  const leaf = path.basename(full);
  const ext = path.extname(full).toLowerCase();
  let eol = null;
  let skip = false;

  const wt = await runGit(dir, ["rev-parse", "--is-inside-work-tree"], policy.env);
  if (wt.code === 0 && wt.text.trim() === "true") {
    const attr = await runGit(dir, ["check-attr", "text", "eol", "--", leaf], policy.env);
    if (attr.code === 0) {
      if (/:\s*text:\s*unset\s*$/m.test(attr.text)) skip = true;
      const m = attr.text.match(/:\s*eol:\s*(lf|crlf)\s*$/m);
      if (m) eol = m[1];
    }
    if (!skip && !eol) {
      const ac = await runGit(dir, ["config", "--get", "core.autocrlf"], policy.env);
      if (ac.code === 0 && ac.text.trim() === "true") eol = "crlf";
    }
    if (!skip && !eol) {
      const ls = await runGit(dir, ["ls-files", "--eol", "--", leaf], policy.env);
      const m = ls.code === 0 ? ls.text.match(/i\/(lf|crlf|mixed)/) : null;
      if (m) eol = m[1] === "mixed" ? "keep" : m[1];
    }
  }
  if (skip) return { file: full, skipped: true, changed: false };
  if (!eol) eol = policy.crlfExt.includes(ext) ? "crlf" : policy.defaultEol;

  const lfText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let out;
  if (eol === "crlf") out = lfText.replace(/\n/g, "\r\n");
  else if (eol === "keep") out = text;
  else out = lfText;

  // Optional final newline: the variable wins, else the nearest .editorconfig; unset leaves the end alone.
  let wantFinal = policy.finalNewline;
  if (wantFinal === null) {
    try {
      wantFinal = editorConfigFinalNewline(full);
    } catch {
      wantFinal = null;
    }
  }
  if (wantFinal === true && out.length > 0 && !out.endsWith("\n")) {
    out += eol === "crlf" || (eol === "keep" && out.includes("\r\n")) ? "\r\n" : "\n";
  }

  const keepBom = hasBom && policy.keepBomExt.includes(ext);
  const removeBom = hasBom && !keepBom;
  if (out !== text || removeBom) {
    const body = Buffer.from(out, "utf8");
    fs.writeFileSync(full, keepBom ? Buffer.concat([UTF8_BOM, body]) : body);
    policy.log(`FIXED ${full} eol=${eol} bomRemoved=${removeBom}`, policy.env);
    return { file: full, eol, bomRemoved: removeBom, changed: true };
  }
  return { file: full, eol, bomRemoved: false, changed: false };
}

// ------------------------------------------------------------------ shell-guard

// The rules live in scripts/analyze-command.ps1, shared with the PowerShell hook, and run on
// PowerShell's own AST. The extension runs that script in one pwsh (or powershell.exe) process per
// distinct command text and caches the decision. Fails open: no host, a crash or a timeout allows.
const here = path.dirname(fileURLToPath(import.meta.url));
export const analyzerScript = path.resolve(here, "..", "..", "..", "scripts", "analyze-command.ps1");
const HOST_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", analyzerScript];
const analysisCache = new Map();

// A decision depends on the command, the working directory, WINDOWS_GUARD_PARSER and PATH (installed
// Unix tools). Denials that depend on the file system (a missing cd target) are never cached.
const cacheKey = (cmd, env, cwd) => `${env.WINDOWS_GUARD_PARSER ?? ""}\0${env.PATH ?? env.Path ?? ""}\0${cwd ?? ""}\0${cmd}`;

function remember(key, decision) {
  if (analysisCache.size >= 4096) analysisCache.clear();
  analysisCache.set(key, decision);
}

function normalizeDecision(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.decision === "deny") {
    const d = { decision: "deny", rule: String(raw.rule ?? ""), reason: String(raw.reason ?? "") };
    if (raw.cacheable === false) d.cacheable = false;
    return d;
  }
  return { decision: "allow" };
}

// The analyzer's decision for one command: { decision: "allow" } or { decision: "deny", rule, reason };
// null when the analyzer could not run.
export async function analyzeCommand(cmd, { env = process.env, log = writeGuardLog, cwd = "" } = {}) {
  const key = cacheKey(cmd, env, cwd);
  if (analysisCache.has(key)) return analysisCache.get(key);
  const host = findExecutable("pwsh", env) ?? findExecutable("powershell", env);
  if (!host) return null;
  const tmp = path.join(os.tmpdir(), `wg-cmd-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  let decision = null;
  try {
    fs.writeFileSync(tmp, cmd, "utf8");
    const r = await run(host, HOST_ARGS, { env: { ...env, WG_COMMAND_FILE: tmp, WG_CWD: cwd ?? "" }, timeout: 10000 });
    if (r.code === 0 && r.stdout.trim()) decision = normalizeDecision(JSON.parse(r.stdout));
    else log(`WARN analyzer exited ${r.code}: ${r.text.slice(0, 200)}`, env);
  } catch (e) {
    log(`ERROR analyzer: ${e?.message ?? e}`, env);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
  if (decision && decision.cacheable !== false) remember(key, decision);
  return decision;
}

// Analyzes many commands in ONE PowerShell process and fills the cache, so a replay of a large
// corpus does not pay one process start per command. Not used on the hook path.
export async function analyzeCommandBatch(commands, { env = process.env, log = writeGuardLog, cwd = "" } = {}) {
  const todo = [...new Set(commands.filter((c) => typeof c === "string" && c && !analysisCache.has(cacheKey(c, env, cwd))))];
  if (todo.length === 0) return 0;
  const host = findExecutable("pwsh", env) ?? findExecutable("powershell", env);
  if (!host) return 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wg-cmd-batch-"));
  try {
    todo.forEach((c, i) => fs.writeFileSync(path.join(dir, `${i}.txt`), c, "utf8"));
    const r = await run(host, HOST_ARGS, { env: { ...env, WG_COMMAND_DIR: dir, WG_CWD: cwd ?? "" }, timeout: 600000 });
    if (r.code !== 0 || !r.stdout.trim()) {
      log(`WARN batch analyzer exited ${r.code}: ${r.text.slice(0, 200)}`, env);
      return 0;
    }
    const map = JSON.parse(r.stdout);
    let n = 0;
    todo.forEach((c, i) => {
      const d = normalizeDecision(map[String(i)]);
      if (d) {
        if (d.cacheable !== false) remember(cacheKey(c, env, cwd), d);
        n++;
      }
    });
    return n;
  } catch (e) {
    log(`ERROR batch analyzer: ${e?.message ?? e}`, env);
    return 0;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// Mirrors shell-guard.ps1. Returns null (allow) or { permissionDecision: "deny", permissionDecisionReason }.
export async function shellGuard(command, { env = process.env, log = writeGuardLog, cwd = "" } = {}) {
  const cmd = typeof command === "string" ? command : "";
  if (!cmd) return null;
  try {
    const d = await analyzeCommand(cmd, { env, log, cwd });
    if (d && d.decision === "deny") return { permissionDecision: "deny", permissionDecisionReason: d.reason };
  } catch (e) {
    log(`ERROR shell-guard: ${e?.message ?? e}`, env);
  }
  return null;
}

// ------------------------------------------------------------------ utf8-gate

// Mirrors utf8-gate.ps1: refuse to edit a UTF-16 or legacy-code-page file, because the edit
// tool would re-encode it and replace unmappable bytes with U+FFFD before anyone sees a diff.
export function utf8Gate(input, { env = process.env, log = writeGuardLog } = {}) {
  try {
    for (const full of getTargetPaths(input)) {
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const b = fs.readFileSync(full);
      if (b.length === 0) continue;
      let enc = null;
      if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) {
        enc = "UTF-16";
      } else {
        if (b.includes(0)) continue; // binary: not our concern
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(b);
        } catch {
          enc = "a legacy code page such as Windows-1252";
        }
      }
      if (enc) {
        log(`DENIED edit of non-UTF-8 file ${full} (${enc})`, env);
        return deny(
          `${full} is encoded as ${enc}, not UTF-8. The edit tool would re-encode it and silently replace non-ASCII bytes with U+FFFD. Stop and ask the user whether to convert the file to UTF-8 first (for example: $t = [IO.File]::ReadAllText($p, [Text.Encoding]::GetEncoding(1252)); [IO.File]::WriteAllText($p, $t, [Text.UTF8Encoding]::new($false))), or make this change by hand.`,
        );
      }
    }
  } catch (e) {
    log(`ERROR utf8-gate: ${e?.message ?? e}`, env);
  }
  return null;
}

// ------------------------------------------------------------------ recovery-coach

const QUOTING = [
  "PowerShell quoting rules:",
  "- Single quotes are literal: 'C:\\Program Files\\x'. Embed a single quote by doubling it: 'it''s'.",
  "- Double quotes expand $var and $(expr). A literal double quote inside them is written as two double quotes or as backtick-quote. Backslash is NOT an escape character.",
  "- Paths with spaces: quote them, or use & 'C:\\path with spaces\\tool.exe' arg. Use -LiteralPath for paths containing [ or ].",
  '- npm, npx, yarn, pnpm and gradlew are .cmd shims with legacy argument passing: arguments containing double quotes get mangled. Pass JSON through a file, run cmd /c "..." with the whole command line, or use the stop-parsing token --%.',
  "- Chain with ; (&& and || need PowerShell 7). Discard errors with 2>$null, not 2>/dev/null.",
  "- Anything multi-line or quote-heavy: create a .ps1 with the create tool, then run pwsh -NoProfile -ExecutionPolicy Bypass -File .\\script.ps1.",
  "Do NOT work around a failed command by writing or rewriting files with Set-Content, >, python -c or node -e. File content goes through the edit/create tool.",
].join("\n");

const EDIT_RECOVERY = [
  "Edit recovery steps (do these instead of rewriting the file):",
  "1. Re-read the exact region with the view tool using a narrow line range. The file may differ from what you remember, including after your own previous edit.",
  "2. Copy old_str verbatim from that output, including indentation and trailing spaces. Keep it short: 2-4 lines that are unique in the file.",
  '3. Check for lookalike characters: curly quotes (U+201C, U+201D, U+2018, U+2019) vs straight quotes, non-breaking spaces (U+00A0), tabs vs spaces, em dashes. The edit tool reports "No match found" when old_str spans curly quotes; choose a nearby span without them.',
  "4. If old_str matches more than once, add one more surrounding line until it is unique.",
  "5. Never replace the whole file with the create tool to work around a mismatch: that converts every line ending and destroys unrelated content.",
].join("\n");

const SHELL_FAILURE_RE =
  /completed with exit code [1-9]|is not recognized|ParserError|missing the terminator|Unexpected token|Missing closing|Access to the path|being used by another process|running scripts is disabled|not a valid statement separator|(Set-Location|Push-Location|cd|sl|chdir|pushd):[\s\S]{0,400}?Cannot find path|Conversion from JSON failed|JSONDecodeError|Expecting value|Extra data/i;
const JSON_FAILURE_RE = /Conversion from JSON failed|JSONDecodeError|Expecting value|Extra data/i;
// PowerShell 7 prints "Set-Location:" and "Cannot find path ..." on different lines around a "Line |" block.
const CD_FAILURE_RE = /(Set-Location|Push-Location|cd|sl|chdir|pushd):[\s\S]{0,400}?Cannot find path .* because it does not exist/i;
// PowerShell's own error layout: 7 prints "Line |" with a ~~~ marker, 5.1 prints "At line:N char:N".
const PS_ERROR_SHAPE_RE = /ParserError:|Line \|[\s\S]{0,300}?~|At line:\d+ char:\d+/i;
const PYTHONUTF8_NOTE =
  "Note: PYTHONUTF8 is not set in this environment. Python fails with UnicodeEncodeError ('charmap') when it prints non-ASCII text; set $env:PYTHONUTF8 = '1' before running Python (or permanently with: setx PYTHONUTF8 1).";

const UNIX_MAP_COACH = {
  sed: "the edit tool for in-place edits, or -replace",
  awk: "ForEach-Object / -split",
  grep: "Select-String",
  head: "Select-Object -First N",
  tail: "Get-Content -Tail N",
  touch: "New-Item -ItemType File",
  which: "Get-Command",
  export: "$env:NAME = 'value'",
  chmod: "icacls (usually unnecessary)",
  ln: "New-Item -ItemType SymbolicLink",
  wc: "Measure-Object",
  xargs: "ForEach-Object",
  find: "Get-ChildItem -Recurse",
  cut: "-split",
  tr: "-replace",
  uniq: "Sort-Object -Unique",
};

// Shared by both coach modes. Returns the guidance text or null when the error is not recognized.
export function advise(tool, err, toolArgs = null, ctx = {}) {
  const out = [];
  if (!err || /^Denied by preToolUse hook/.test(err)) return null; // the denial reason already carries the guidance
  if (SHELL_TOOLS.has(tool)) {
    const isResult = ctx.mode === "result";
    const exitCode = Number.isInteger(ctx.exitCode) ? ctx.exitCode : null;
    const body = typeof ctx.body === "string" ? ctx.body : err;
    const command = toolArgs && typeof toolArgs === "object" && typeof toolArgs.command === "string" ? toolArgs.command : "";
    // In result mode a non-zero exit code is the failure signal; in failure mode the tool itself failed.
    const failed = !isResult || exitCode === null || exitCode !== 0;
    const hasErrorShape = PS_ERROR_SHAPE_RE.test(err);
    // Benign exit codes are the whole answer.
    if (isResult && exitCode === 1 && /(^|[|;&(\s])(git\s+grep|rg|grep|findstr|Select-String)\b/i.test(command) && !body) {
      out.push("Exit code 1 from a search command with no output means no match, not an error.");
    } else if (isResult && exitCode === 8 && /\bgh\s+pr\s+checks\b/i.test(command)) {
      out.push("gh pr checks exits 8 while checks are pending; it is not an error. Re-run it later, or use --watch.");
    } else if (isResult && exitCode === 1 && /-(ErrorAction|ea)\s*[: ]\s*(SilentlyContinue|0)\b/i.test(command) && body && !hasErrorShape) {
      out.push("The command used -ErrorAction SilentlyContinue; the suppressed error still sets the exit code, and the output above is valid.");
    } else {
      const term = err.match(/The term '([^']+)' is not recognized/i);
      if (term) {
        const name = term[1];
        if (Object.hasOwn(UNIX_MAP_COACH, name)) {
          out.push(`'${name}' is a Unix command; this shell is PowerShell on Windows. Use ${UNIX_MAP_COACH[name]}.`);
        } else {
          out.push(
            `'${name}' is not on PATH for the agent's shell (a fresh pwsh -NoProfile per command; your interactive profile does not apply). Check with Get-Command ${name}, or call the executable by full path.`,
          );
        }
      }
      if (/not a valid statement separator|The token .&&.|The token .\|\|./i.test(err)) {
        out.push(
          "The agent's shell is Windows PowerShell 5.1, where && and || are parse errors. Chain with ; instead. Installing PowerShell 7 (winget install Microsoft.PowerShell) and restarting the CLI removes this class of error.",
        );
      }
      const jsonHit = JSON_FAILURE_RE.test(err);
      if (jsonHit) {
        out.push(
          /2>&1/.test(command)
            ? "The JSON parser received stderr text because of 2>&1. Use 2>$null (or 2>$errFile) before the pipe and check $LASTEXITCODE before parsing."
            : "The input was not valid JSON. Check $LASTEXITCODE and the first line of the output before parsing; a tool that failed usually printed a message instead of JSON.",
        );
      }
      // Parse errors after execution: only with a non-zero exit and PowerShell's own error layout, so the
      // words "ParserError" or "Unexpected token" inside a search result at exit 0 stay silent.
      if (
        !jsonHit &&
        failed &&
        (!isResult || hasErrorShape) &&
        /missing the terminator|Missing closing|Unexpected token|Unrecognized token|Missing expression|Missing argument|reserved for future use|ParserError/i.test(err)
      ) {
        out.push("This is a PowerShell parse error, almost always quoting.");
        out.push(QUOTING);
      }
      if (CD_FAILURE_RE.test(err)) {
        out.push(
          "A cd/Set-Location failed but the later statements still ran in the previous folder; re-check their results. Create or correct the folder, or use Set-Location X -ErrorAction Stop so a failed cd stops the line.",
        );
      }
      if (/\/dev\/null|Cannot find path .*\//i.test(err)) {
        out.push(
          "Forward-slash arguments such as /dev/null or /s are treated as paths. Use 2>$null, and PowerShell cmdlet parameters (-Recurse, -Force) instead of cmd.exe switches.",
        );
      }
      if (/running scripts is disabled|UnauthorizedAccess.*\.ps1/i.test(err)) {
        out.push("Execution policy blocked the script. Run it as: pwsh -NoProfile -ExecutionPolicy Bypass -File .\\script.ps1");
      }
      if (/being used by another process/i.test(err)) {
        out.push(
          "The file is locked by another process (often an editor or a build). Do not retry with a different write method; wait or ask the user.",
        );
      }
      if (/UnicodeEncodeError|'charmap' codec can't encode|cp1252/i.test(err)) {
        out.push(
          "Python failed to print a non-ASCII character because the console code page is cp1252. Set $env:PYTHONUTF8 = '1' before the command (or permanently with: setx PYTHONUTF8 1) and rerun.",
        );
      }
      const mod = err.match(/ModuleNotFoundError: No module named '([^']+)'/i);
      if (mod) {
        out.push(`Missing Python package '${mod[1]}'. Run it with uv instead of installing into the system interpreter: uv run --no-project --with ${mod[1]} python <script.py>`);
      }
      const spawn = err.match(/Failed to spawn:?\s*\\?([A-Za-z0-9_.-]+)/i);
      if (spawn) {
        out.push(`'${spawn[1]}' is not installed for this interpreter. Run it through uv: uv run --with ${spawn[1]} ${spawn[1]}`);
      }
      if (/Needed a single revision/i.test(err) && /rev-parse/i.test(command)) {
        out.push("git rev-parse --short and --verify take one ref at a time; run it once per ref.");
      }
      if (/os error 123|volume label syntax is incorrect/i.test(err) && /\*/.test(command)) {
        out.push(
          "Native executables do not expand wildcards on Windows. Expand the pattern with Get-ChildItem first and pass the file names: Get-ChildItem <pattern> | ForEach-Object { <tool> $_.FullName }",
        );
      }
      if (out.length === 0 && failed && /unterminated|quote|unexpected.*string|syntax error/i.test(err)) {
        out.push(QUOTING);
      }
    }
  } else if (WRITE_TOOLS.has(tool)) {
    // The CLI passes short error strings here ("No match found", "Parent directory does not exist").
    if (/parent directory .*does not exist|directory does not exist/i.test(err)) {
      const p = toolArgs && typeof toolArgs === "object" ? toolArgs.path : undefined;
      const dir = typeof p === "string" && p ? path.dirname(p) : "";
      const target = dir ? `'${dir}'` : "<directory>";
      out.push(
        `The target directory does not exist. Create it first with one shell call: New-Item -ItemType Directory -Force ${target} ; then call the create tool again with the same content. Do not run the two calls in parallel, and do not write the file from the shell instead.`,
      );
    } else if (/already exists/i.test(err)) {
      out.push(
        "The file already exists. View it with the view tool, then make the change with the edit tool. Never delete and re-create it with the create tool: that rewrites every line ending and loses unrelated content.",
      );
    } else if (
      /No match|not found|did not match|could not find|does not exist in|Could not apply|failed to apply|does not appear|not unique|multiple|more than one|ambiguous|modified since|changed since/i.test(
        err,
      )
    ) {
      out.push(EDIT_RECOVERY);
    }
  }
  return out.length > 0 ? out.join("\n\n") : null;
}

// postToolUseFailure: the CLI passes the tool's error string.
export function coachFailure(tool, toolArgs, error, { env = process.env, log = writeGuardLog } = {}) {
  try {
    return advise(String(tool ?? ""), String(error ?? ""), toolArgs, { mode: "failure", exitCode: null, body: String(error ?? "") });
  } catch (e) {
    log(`ERROR recovery-coach: ${e?.message ?? e}`, env);
    return null;
  }
}

// postToolUse on the shell tool: a non-zero exit arrives as a SUCCESSFUL result whose text ends
// with "<shellId: N completed with exit code M>", so this is where ordinary errors are visible.
// The structured exit code of a shell result ({ type: "shell_exit", exitCode } in toolResult.contents), or null.
export function resultExitCode(toolResult) {
  const contents = toolResult && typeof toolResult === "object" ? toolResult.contents : null;
  if (!Array.isArray(contents)) return null;
  for (const entry of contents) {
    if (entry && entry.type === "shell_exit" && Number.isInteger(entry.exitCode)) return entry.exitCode;
  }
  return null;
}

export function coachResult(tool, toolArgs, text, { env = process.env, log = writeGuardLog, exitCode = null } = {}) {
  try {
    const t = String(tool ?? "");
    if (!SHELL_TOOLS.has(t)) return null;
    const err = String(text ?? "");
    if (!SHELL_FAILURE_RE.test(err)) return null;
    // The exit code comes from the structured result when the CLI provides it, else from the marker text.
    let code = Number.isInteger(exitCode) ? exitCode : null;
    let body = err;
    const marker = err.match(/<shellId: \d+ completed with exit code (\d+)>/);
    if (marker) {
      if (code === null) code = Number(marker[1]);
      body = err.slice(0, err.indexOf("<shellId:")).trim();
    }
    return advise(t, err, toolArgs, { mode: "result", exitCode: code, body });
  } catch (e) {
    log(`ERROR recovery-coach: ${e?.message ?? e}`, env);
    return null;
  }
}

// ------------------------------------------------------------------ inject-rules

// Mirrors inject-rules.ps1: the text of com.github.copilot/rules/*.md, sorted by name.
export function loadRules(rulesDir) {
  let names;
  try {
    names = fs.readdirSync(rulesDir).filter((n) => n.toLowerCase().endsWith(".md")).sort();
  } catch {
    return null;
  }
  const parts = [];
  for (const n of names) {
    try {
      const t = fs.readFileSync(path.join(rulesDir, n), "utf8").trim();
      if (t) parts.push(t);
    } catch {
      // unreadable rule file: skip it
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

// ------------------------------------------------------------------ session hook callbacks

function safeJson(value, limit = 4000) {
  try {
    const s = JSON.stringify(value) ?? "";
    return s.length > limit ? `${s.slice(0, limit)}...` : s;
  } catch {
    return "[unserializable]";
  }
}

// The SDK session hooks (onSessionStart, onSessionEnd, onPreToolUse, onPostToolUse, onPostToolUseFailure)
// that extension.mjs registers with joinSession. Returning undefined means "no change", which
// for onPreToolUse leaves the CLI's normal permission flow untouched.
export function buildHooks({ rulesDir, env = process.env, log = writeGuardLog } = {}) {
  const opts = { env, log };
  const debug = Boolean(env.WINDOWS_GUARD_DEBUG);
  const protect = async (name, input, fn) => {
    if (debug) log(`RAW ${name} ${safeJson(input)}`, env);
    try {
      return await fn();
    } catch (e) {
      log(`ERROR ${name}: ${e?.stack ?? e}`, env);
      return undefined;
    }
  };
  return {
    onSessionStart: (input) =>
      protect("sessionStart", input, () => {
        let text = loadRules(rulesDir);
        if (!text) return undefined;
        if (!env.PYTHONUTF8) text = `${text}\n\n${PYTHONUTF8_NOTE}`;
        if (debug) log(`INJECTED rules (${text.length} chars)`, env);
        return { additionalContext: text };
      }),
    onSessionEnd: (input) =>
      protect("sessionEnd", input, () => {
        removeActiveMarker(input?.sessionId, { env });
        return undefined;
      }),
    onPreToolUse: (input) =>
      protect("preToolUse", input, async () => {
        const tool = getToolName(input);
        if (SHELL_TOOLS.has(tool)) {
          const ta = getToolArgs(input);
          const cmd = ta && typeof ta === "object" ? ta.command : undefined;
          const decision = await shellGuard(cmd, { ...opts, cwd: input?.workingDirectory || input?.cwd || "" });
          if (decision) log(`DENIED ${tool}: ${String(cmd).slice(0, 200).replace(/\r?\n/g, " \\n ")}`, env);
          return decision ?? undefined;
        }
        if (EDIT_TOOLS.has(tool)) return utf8Gate(input, opts) ?? undefined;
        return undefined;
      }),
    onPostToolUse: (input) =>
      protect("postToolUse", input, async () => {
        const tool = getToolName(input);
        if (WRITE_TOOLS.has(tool)) {
          await normalizeEol(input, opts);
          return undefined;
        }
        if (SHELL_TOOLS.has(tool)) {
          const advice = coachResult(tool, getToolArgs(input), resultText(input?.toolResult), { ...opts, exitCode: resultExitCode(input?.toolResult) });
          if (advice) log(`COACHED ${tool} (result, ${advice.length} chars)`, env);
          return advice ? { additionalContext: advice } : undefined;
        }
        return undefined;
      }),
    onPostToolUseFailure: (input) =>
      protect("postToolUseFailure", input, () => {
        const tool = getToolName(input);
        const advice = coachFailure(tool, getToolArgs(input), input?.error, opts);
        if (advice) log(`COACHED ${tool} (failure, ${advice.length} chars)`, env);
        return advice ? { additionalContext: advice } : undefined;
      }),
  };
}
