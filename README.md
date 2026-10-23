# copilot-windows-guard

A plugin marketplace for [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli) with one plugin, **windows-guard**, that stops the agent from mangling files on Windows 11 and teaches it to write PowerShell that works the first time.

**Experimental branch:** this is the opt-in extension-engine preview, not the stable [`main` branch](https://github.com/jj1985/copilot-windows-guard/tree/main). Install from `experimental` explicitly; installing the repository without a ref selects the default branch. PowerShell hooks remain the default engine even on this branch.

```powershell
copilot plugin marketplace add jj1985/copilot-windows-guard#experimental
copilot plugin install windows-guard@copilot-windows-guard
```

Already installed the stable plugin? Follow [Switching an existing installation](#switching-an-existing-installation) first. To activate the preview after installation, follow [Extension mode](#extension-mode-experimental).

## The problem

On Windows, Copilot CLI's trouble with files comes from three separate layers, and only one of them responds to prompting:

| Layer | What happens | Status |
|---|---|---|
| **Bug in the CLI's file tools** | `edit` and `create` match your text CRLF-tolerantly, then write the file back with **CRLF regardless of its original ending**, prepend a **UTF-8 BOM**, and **re-encode non-UTF-8 files**, replacing unmappable bytes with U+FFFD. `.gitattributes` is ignored. | Open, no fix as of v1.0.103: [#1148](https://github.com/github/copilot-cli/issues/1148), [#3389](https://github.com/github/copilot-cli/issues/3389), [#3604](https://github.com/github/copilot-cli/issues/3604), [#3732](https://github.com/github/copilot-cli/issues/3732) |
| **Model behavior** | The models emit `grep`, `head`, `&&`, heredocs, `2>/dev/null` and bash quoting into PowerShell even when instructions forbid it; when an edit fails they fall back to `Set-Content`, `>`, `python -c`, or rewriting the whole file. | GitHub's maintainers [could not prompt it away](https://github.com/github/copilot-cli/issues/1680) and required PowerShell 7 instead |
| **Environment** | Every command runs in a fresh `pwsh -NoProfile`, so `$PROFILE` never applies; the CLI silently falls back to Windows PowerShell 5.1 when `pwsh.exe` is not on the PATH it sees; no setting selects another shell. | By design ([#508](https://github.com/github/copilot-cli/issues/508), [#2271](https://github.com/github/copilot-cli/issues/2271) open) |

Hooks are the only user-controlled layer that sits between the model and the file system, so that is where this plugin works. The full write-up with sources is in [docs/research-report.md](docs/research-report.md).

## What the plugin does

| Hook | Event | Effect |
|---|---|---|
| `normalize-eol.ps1` | `postToolUse` on `edit`, `create`, `str_replace_editor`, `apply_patch` | Rewrites the file to the intended line ending and removes the BOM, milliseconds after the tool wrote it. Intended ending: `.gitattributes eol=` → `core.autocrlf=true` → what the git index already holds → `.bat`/`.cmd`/`.sln` list → LF. Respects `-text`. |
| `shell-guard.ps1` | `preToolUse` on the shell tool | Runs the command through PowerShell's own parser and denies anything that does not parse (unterminated strings, bash `for`/`[ ]`, stray `\"`), with the exact error. Also denies heredocs, Unix commands that are not installed (`grep`, `head`, `sed`, ...), `2>/dev/null`, `VAR=x cmd`, cmd.exe switches, file redirection, `Set-Content`/`Out-File` without `-Encoding utf8NoBOM`, inline `python -c`/`node -e` file writes, and `$home =`. Every denial reason contains the PowerShell form to use instead. |
| `utf8-gate.ps1` | `preToolUse` on `edit`, `str_replace_editor`, `apply_patch` | Refuses to edit a file that is Windows-1252, UTF-16 or otherwise not UTF-8, because the edit tool would corrupt it irreversibly, and tells the agent to ask you first. |
| `recovery-coach.ps1` | `postToolUse` on the shell tool, and `postToolUseFailure` on all tools | When a command exits non-zero or an edit fails, recognizes the cause (quoting, bash-ism, 5.1 syntax, "No match found", locked file, execution policy) and appends concrete recovery steps to what the agent sees. The edit guidance explicitly forbids rewriting the whole file as a workaround. (Copilot CLI reports a failed shell command as a successful tool call with the exit code in the text, which is why the shell path uses `postToolUse`.) |

| `inject-rules.ps1` | `sessionStart` | Injects the rules file below as session context. Copilot CLI 1.0.101 does not load a plugin's `com.github.copilot/rules/` as an instruction source (`copilot instruction list` shows nothing and the model reports the rules as absent), so the hook delivers them deterministically. |

The same five behaviors also exist as a Copilot CLI extension (`com.github.copilot/extensions/windows-guard/`) for sessions that run with experimental features on; see [Extension mode](#extension-mode-experimental).

Plus two instruction components:

- `com.github.copilot/rules/windows-guard.md`: short always-on rules (PowerShell equivalents, quoting, "file content goes through the edit tool", what to do on "No match found"). Delivered by the `sessionStart` hook; if a future CLI loads `rules/` natively, the text would appear twice, which is harmless, and the hook can then be dropped.
- `skills/windows-powershell-quoting/SKILL.md`: a quoting and file-writing reference the agent loads when a command involves quotes, JSON, paths with spaces, `npm`/`.cmd` shims, or after a quoting error.

### Design notes

- **Fail-open everywhere it matters.** `preToolUse` hooks are fail-closed in Copilot CLI (a crash denies the tool call), so every guard swallows its own errors and exits 0. A bug in this plugin can never block your shell.
- **Rules you can bypass.** Heuristic rules (file redirection, `echo -n`, the Unix-command check) accept `# wg:allow` anywhere in the command. The denial reason tells the agent so.
- **Works under PowerShell 5.1 too.** The launcher prefers `pwsh` and falls back to `powershell.exe`; the scripts use no 7-only syntax.
- **Payload read as raw bytes.** Hook input is decoded as UTF-8 directly from the stdin stream, so a host console code page cannot mangle it.

## Extension mode (experimental)

Each command hook above costs two PowerShell processes per tool call (the inline launcher in `hooks.json`, then the script it starts): about 0.6 s per hooked event on a current laptop. Copilot CLI's experimental **extensions** receive the same hook events inside one long-lived Node.js process, so the plugin also ships its logic as an extension. `com.github.copilot/extensions/windows-guard/extension.mjs` registers `onSessionStart`, `onPreToolUse`, `onPostToolUse` and `onPostToolUseFailure` callbacks, and the JavaScript behind them (`guard.mjs`) mirrors the PowerShell scripts rule for rule and message for message.

It is **off by default**. One switch selects the engine, so nothing ever runs twice:

| `WINDOWS_GUARD_MODE` | PowerShell hooks | Extension |
|---|---|---|
| unset (default) | do all the work | joins the session idle: registers no hooks, writes one line to the log |
| `extension`, extension running | every launcher exits 0 before starting its script | does all the work |
| `extension`, extension not running (disabled, not approved, failed to load, non-experimental session) | do all the work | n/a |

How the launchers know: when the extension joins a session in extension mode it writes `%LOCALAPPDATA%\copilot-windows-guard\active\<sessionId>` containing its process id, and removes the file when the session ends or the process exits. A launcher in extension mode reads the session id from its payload and exits early only if that file exists and the process is alive; otherwise it runs its script. A stale file from a crashed extension cannot disable the hooks, because its process id is dead.

Verified on 2026-10-23 with CLI 1.0.103: with the variable set but experimental features off (so the extension never loads), a created file still came out as 14 LF bytes, and the plugin's own log shows the PowerShell normalizer doing it; with the extension running, the marker file existed for the session, the PowerShell log stayed silent, and the marker was gone after exit.

### Enable it

Install the plugin from the `experimental` branch using the [installation instructions](#installation) first. Setting the variable is safe even when the extension cannot run: without a liveness marker the launchers run their PowerShell scripts as usual.

```powershell
$env:WINDOWS_GUARD_MODE = 'extension'
copilot --experimental
```

`"experimental": true` in `~/.copilot/settings.json` replaces the flag. Then:

- **Approve the extension.** Interactive sessions ask once per extension and directory (per the CLI docs); `--allow-all-tools`, or `--allow-tool` with the `extension-permission-access(...)` pattern, skips the prompt. The prompt-mode runs below used `--allow-all-tools` and were not asked.
- **Prompt mode needs one more variable.** `copilot -p ...` does not load extensions unless `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true` is set.
- **No separate Node.js or SDK installation.** Once this branch's plugin is installed, the CLI runs the extension with the Node.js runtime inside `copilot.exe` and resolves `@github/copilot-sdk/extension` itself; the log shows `node v24.22.1 at ...\copilot.exe`.
- **Confirm it is active.** The session timeline shows `windows-guard: extension mode active`, `/extensions manage` lists `windows-guard` as running, and `windows-guard.log` gains `[ext]` lines, and `%LOCALAPPDATA%\copilot-windows-guard\active\` holds a file named after the session id. Each extension also writes its own log under `~/.copilot/logs/extensions/`.

### What you gain and what you pay

Median of 5 on the same machine (CLI 1.0.103, PowerShell 7.5):

| Hooked event | PowerShell hooks | Extension mode |
|---|---|---|
| shell command, allowed | 560 ms | 180 ms (one `pwsh` for the parser check; 0 ms when the same command text repeats) |
| shell command, denied by a rule | 566 ms | < 1 ms |
| edit or create outside a repository | 617 ms | 32 ms (one `git rev-parse`) |
| edit of a non-UTF-8 file | ~560 ms | < 1 ms |
| launcher that exits at once | n/a | ~250 ms per hooked event (process start plus the marker check), still paid |

The last row is the catch. `hooks.json` cannot be conditional, so the CLI still starts each PowerShell launcher, which reads the switch and exits. Extension mode removes one of the two processes and all of the work from the hook path; the launcher itself can only go away with a CLI feature (or by removing the hooks, which would leave non-experimental sessions unprotected).

Trade-offs:

- **Experimental mode is required**, and the extension API is explicitly subject to change.
- **An approval prompt for every user.** A plugin-shipped extension is discovered for everyone who runs with `--experimental`, including in the default mode where it stays idle. `/extensions mode` set to Disabled turns extensions off entirely; the PowerShell hooks take over on their own because no liveness marker is written.
- **Parser check still spawns PowerShell**, but only after every cheap rule passed, once per distinct command text. `WINDOWS_GUARD_PARSER=off` removes it; unterminated strings and bash `for` / `[ -f x ]` syntax are then caught only after execution, by the coach.
- **Tool failures.** The SDK documents that extension hooks see only `"failure"` results, not `"rejected"`, `"denied"` or `"timeout"`, and copilot-sdk#1220 tracked failures not reaching extensions at all. Verified on CLI 1.0.103: `onPostToolUseFailure` fires for an edit-tool `No match found` and the model receives the recovery steps. Other failure kinds were not tested.
- **`-p` automation** needs the extra variable, and the extension's one-line startup message appears in prompt-mode output.
- **Windows only.** On macOS and Linux the extension joins the session and does nothing, like the hooks.

To return to the PowerShell engine, unset `WINDOWS_GUARD_MODE` (and any persistent setting of it) and start a new session. Disabling experimental features or declining the extension's approval also falls back to the hooks on its own, at the normal hook latency, because no liveness marker exists then.

### When to prefer the PowerShell hooks

Keep the default unless the per-call latency bothers you. The hooks need no experimental flag, no approval prompt and no extra variable in `-p` mode, they run under Windows PowerShell 5.1 as well as 7, and both engines enforce the same rules with the same messages and are tested against the same cases (`tests/Invoke-HookTests.ps1` and `tests/extension.test.mjs`). Switch to extension mode when you already run with experimental features on and want hooked tool calls to cost tens of milliseconds instead of hundreds.

## Installation

### Requirements

- Windows 10/11. On macOS and Linux the hooks are no-ops and only the rules and skill load.
- GitHub Copilot CLI 1.0.63 or later for PowerShell hooks (matchers on `postToolUse` and `PLUGIN_ROOT` for plugin hooks). The experimental extension was verified on **1.0.103**; use that version or later for extension mode, with experimental features enabled and extension approval granted.
- PowerShell 7 on the **machine or user PATH**, not just in your terminal. Verify from a non-PowerShell parent, which is what the CLI's background process is:

```powershell
cmd /c pwsh --version
```

If that fails, install it and open a new terminal:

```powershell
winget install --id Microsoft.PowerShell --source winget
```

### From the experimental marketplace

```powershell
copilot plugin marketplace add jj1985/copilot-windows-guard#experimental
copilot plugin install windows-guard@copilot-windows-guard
```

The marketplace's relative plugin source (`./plugins/windows-guard`) comes from the same branch checkout (verified on CLI 1.0.103: the installed plugin contains this branch's `com.github.copilot/extensions/`). The names `copilot-windows-guard` and `windows-guard` are unchanged; stable and experimental installs are alternatives, not side-by-side copies.

### Switching an existing installation

Close active Copilot sessions. If the plugin is already installed, uninstall it before changing its source:

```powershell
copilot plugin uninstall windows-guard
```

If the marketplace is already registered, remove it, then add the branch-pinned source and reinstall:

```powershell
copilot plugin marketplace remove copilot-windows-guard
copilot plugin marketplace add jj1985/copilot-windows-guard#experimental
copilot plugin install windows-guard@copilot-windows-guard
```

To reinstall stable instead, unset `WINDOWS_GUARD_MODE`, repeat these steps with `jj1985/copilot-windows-guard` (no `#experimental`), and start a new session. Remove any repository-level `ref` pin below as well.

### Directly from the repository

Not for this branch. `copilot plugin install owner/repo:path` always fetches the default branch and accepts no ref (verified on CLI 1.0.103: `#experimental` and `@experimental` suffixes are rejected), and `copilot plugin install` does not accept a local path. Use the marketplace pin above, the team setting below, or a local clone for one session.

### For one session, from a local clone of experimental

```powershell
git switch experimental
copilot --plugin-dir .\plugins\windows-guard
```

This uses the PowerShell engine. For the extension engine, set `WINDOWS_GUARD_MODE=extension` and add `--experimental` as shown above. If a marketplace copy is installed as well, set `COPILOT_PLUGIN_DIR_ONLY=true` so only the local copy loads.

### For a team repository

Commit this to `.github/copilot/settings.json` so every clone gets the experimental plugin:

```json
{
  "extraKnownMarketplaces": {
    "copilot-windows-guard": { "source": { "source": "github", "repo": "jj1985/copilot-windows-guard", "ref": "experimental" } }
  },
  "enabledPlugins": { "windows-guard@copilot-windows-guard": true }
}
```

Start a new Copilot CLI session after installing. `/env` lists the loaded hooks and their source.

## Verify it in two minutes

1. In a scratch folder, start `copilot` and ask: *Create a file named eol-test.txt containing three lines: one, two, three.*
2. Check the bytes:

   ```powershell
   $b = [IO.File]::ReadAllBytes('.\eol-test.txt'); $s = [Text.Encoding]::UTF8.GetString($b)
   [pscustomobject]@{ Bytes = $b.Length; BOM = ($b[0] -eq 0xEF); CRLF = ([regex]::Matches($s, "`r`n")).Count; LF = ([regex]::Matches($s, "(?<!`r)`n")).Count }
   ```

   Expect `BOM = False`, `CRLF = 0`, `LF = 3` (14 bytes) outside a repo or in an LF repo.
3. Ask: *Show the first 5 lines of eol-test.txt using head.* The command should be denied with a reason naming `Select-Object -First 5`, and the retry should use it.
4. Ask it to run `$PSVersionTable.PSVersion` to confirm the agent's shell is 7.x.

The plugin logs what it changed or denied to `windows-guard.log` in the plugin's data directory (`%USERPROFILE%\.copilot\plugin-data\...` when installed, otherwise `%LOCALAPPDATA%\copilot-windows-guard\`). Set `WINDOWS_GUARD_DEBUG=1` to also log every raw hook payload.

## Configuration

Environment variables shared by both engines. PowerShell hooks read them per event; the extension inherits them when its process starts, so restart the session after changing them:

| Variable | Default | Meaning |
|---|---|---|
| `WINDOWS_GUARD_DEFAULT_EOL` | `lf` | Ending for files with no `.gitattributes` rule, no index entry and no extension match. Set `crlf` for a CRLF-convention codebase without `.gitattributes`. |
| `WINDOWS_GUARD_CRLF_EXT` | `.bat .cmd .sln .vcproj .vcxproj` | Extensions that always get CRLF when nothing else decides. Comma, semicolon or space separated. |
| `WINDOWS_GUARD_KEEP_BOM_EXT` | (empty) | Extensions whose existing BOM is preserved, for example `.ps1` if non-ASCII scripts must run under Windows PowerShell 5.1. |
| `WINDOWS_GUARD_DEBUG` | (unset) | Log every raw hook payload. |
| `WINDOWS_GUARD_MODE` | (unset) | `extension` makes every `hooks.json` launcher exit immediately while the extension is running for the session (liveness marker present and its process alive); otherwise the PowerShell scripts run as usual. Needs the experimental branch's plugin and experimental features on to gain anything. See [Extension mode](#extension-mode-experimental). |
| `WINDOWS_GUARD_PARSER` | (unset) | `off` skips the PowerShell parser check in extension mode (the hooks always run it). |

The most reliable way to express a repository's line-ending policy is `.gitattributes`, which the normalizer treats as the single source of truth:

```gitattributes
* text=auto eol=lf
*.bat text eol=crlf
*.cmd text eol=crlf
*.png binary
```

## What it cannot fix

- **Destruction of legacy-code-page bytes.** The edit tool corrupts Windows-1252 files before any hook can see a diff. The gate blocks those edits instead; convert the file to UTF-8 first.
- **"No match found" on curly quotes.** The edit tool fails when `old_str` spans U+201C/U+201D. The coach tells the agent to pick a nearby span.
- **Shell selection.** Nothing can make the agent use Git Bash or cmd. WSL is the only alternative, with its own trade-offs.
- **Spurious permission prompts on PowerShell syntax.** Fixed in Copilot CLI 1.0.52 to 1.0.68; update the CLI.

## Experimental Copilot CLI features and this problem

Evaluated against CLI 1.0.103 (2026-10-22). None of the experimental features fixes the file tools' CRLF/BOM behavior, but three are worth knowing about:

- **Extensions** (`--experimental`): in-process JavaScript that can register tools and session hook callbacks. Since 0.2.0 this plugin ships one, off by default; see [Extension mode](#extension-mode-experimental). Verified on 1.0.103: a plugin-shipped extension loads from `com.github.copilot/extensions/` (also in `-p` mode with `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true`), `additionalContext` from `onSessionStart` and `onPostToolUse` reaches the model ([copilot-cli#2652](https://github.com/github/copilot-cli/issues/2652) closed), and `onPostToolUseFailure` receives edit-tool failures ([copilot-sdk#1220](https://github.com/github/copilot-sdk/issues/1220) is still open for rejected, denied and timed-out results). Built-in tools cannot be overridden, so `edit` and `create` still write CRLF first and the extension, like the hook, corrects the bytes afterwards.
- **`/rewind` file restore**: restores only the files Copilot changed, without git. A useful undo when a whole-file rewrite slips through.
- **Dynamic retrieval of skills** (`dynamicRetrieval.skills`): embedding-based per-turn retrieval that makes the quoting skill more likely to load when a prompt involves quoting or shell commands.

The **assisted approval** mode, the **critic** and **rubber-duck** agents and **autopilot** are about approvals, review and autonomy, not bytes on disk; they neither help nor hurt here. The plugin's hooks, whether PowerShell scripts or extension callbacks, remain the deterministic layer.

## Development

Run these commands from an `experimental` branch checkout. Avoid loading an installed copy of the plugin alongside `--plugin-dir`.

```powershell
pwsh -NoProfile -File tests/Invoke-HookTests.ps1                      # hooks under PowerShell 7
pwsh -NoProfile -File tests/Invoke-HookTests.ps1 -Shell powershell    # hooks under Windows PowerShell 5.1
copilot --plugin-dir .\plugins\windows-guard                          # try it live without installing
node --test tests/extension.test.mjs                                  # extension logic, plain Node.js
$env:WINDOWS_GUARD_MODE = 'extension'; copilot --experimental --plugin-dir .\plugins\windows-guard   # extension mode live
```

The tests feed synthetic Copilot CLI hook payloads to each script and check bytes on disk, deny decisions, exit codes and the inline launcher in `hooks.json`. `tests/extension.test.mjs` runs the same cases against the extension's `guard.mjs` and its session-hook wiring with `node --test` and no dependencies. CI runs all of it on `windows-latest`.

The hook payload shape is not documented, so it was verified against a live Copilot CLI 1.0.101 session: `toolArgs` arrives as an object; `create` carries `path` (absolute) and `file_text`; the shell tool carries `command`. The scripts still try `file_path`, `filePath`, `filename`, `fileName`, `file`, `target_file`, and parse `apply_patch` text, in case this changes. If the log shows `NO PATH KEY` lines, open an issue with the logged `toolArgs` shape.

Verified live on 2026-10-22 with CLI 1.0.101: a file the `create` tool reported as 17 characters (CRLF) was 14 bytes of LF on disk after the hook; `echo hello > file` was denied with the reason shown above and the agent switched to the `create` tool on its own. Extension mode was verified the same way on 2026-10-23 with CLI 1.0.103 (see [Extension mode](#extension-mode-experimental)).

## License

MIT
