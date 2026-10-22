# copilot-windows-guard

A plugin marketplace for [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli) with one plugin, **windows-guard**, that stops the agent from mangling files on Windows 11 and teaches it to write PowerShell that works the first time.

```powershell
copilot plugin marketplace add jj1985/copilot-windows-guard
copilot plugin install windows-guard@copilot-windows-guard
```

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

Plus two instruction components:

- `com.github.copilot/rules/windows-guard.md`: short always-on rules (PowerShell equivalents, quoting, "file content goes through the edit tool", what to do on "No match found"). Delivered by the `sessionStart` hook; if a future CLI loads `rules/` natively, the text would appear twice, which is harmless, and the hook can then be dropped.
- `skills/windows-powershell-quoting/SKILL.md`: a quoting and file-writing reference the agent loads when a command involves quotes, JSON, paths with spaces, `npm`/`.cmd` shims, or after a quoting error.

### Design notes

- **Fail-open everywhere it matters.** `preToolUse` hooks are fail-closed in Copilot CLI (a crash denies the tool call), so every guard swallows its own errors and exits 0. A bug in this plugin can never block your shell.
- **Rules you can bypass.** Heuristic rules (file redirection, `echo -n`, the Unix-command check) accept `# wg:allow` anywhere in the command. The denial reason tells the agent so.
- **Works under PowerShell 5.1 too.** The launcher prefers `pwsh` and falls back to `powershell.exe`; the scripts use no 7-only syntax.
- **Payload read as raw bytes.** Hook input is decoded as UTF-8 directly from the stdin stream, so a host console code page cannot mangle it.

## Installation

### Requirements

- Windows 10/11. On macOS and Linux the hooks are no-ops and only the rules and skill load.
- GitHub Copilot CLI 1.0.63 or later (matchers on `postToolUse` and `PLUGIN_ROOT` for plugin hooks).
- PowerShell 7 on the **machine or user PATH**, not just in your terminal. Verify from a non-PowerShell parent, which is what the CLI's background process is:

```powershell
cmd /c pwsh --version
```

If that fails, install it and open a new terminal:

```powershell
winget install --id Microsoft.PowerShell --source winget
```

### From the marketplace

```powershell
copilot plugin marketplace add jj1985/copilot-windows-guard
copilot plugin install windows-guard@copilot-windows-guard
```

### Directly from the repository

```powershell
copilot plugin install jj1985/copilot-windows-guard:plugins/windows-guard
```

### For one session, from a local clone

```powershell
copilot --plugin-dir .\plugins\windows-guard
```

### For a team repository

Commit this to `.github/copilot/settings.json` so every clone gets the plugin:

```json
{
  "extraKnownMarketplaces": {
    "copilot-windows-guard": { "source": { "source": "github", "repo": "jj1985/copilot-windows-guard" } }
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

Environment variables, read by the hooks at run time:

| Variable | Default | Meaning |
|---|---|---|
| `WINDOWS_GUARD_DEFAULT_EOL` | `lf` | Ending for files with no `.gitattributes` rule, no index entry and no extension match. Set `crlf` for a CRLF-convention codebase without `.gitattributes`. |
| `WINDOWS_GUARD_CRLF_EXT` | `.bat .cmd .sln .vcproj .vcxproj` | Extensions that always get CRLF when nothing else decides. Comma, semicolon or space separated. |
| `WINDOWS_GUARD_KEEP_BOM_EXT` | (empty) | Extensions whose existing BOM is preserved, for example `.ps1` if non-ASCII scripts must run under Windows PowerShell 5.1. |
| `WINDOWS_GUARD_DEBUG` | (unset) | Log every raw hook payload. |

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

- **Extensions** (`--experimental`): in-process JavaScript that can register tools and session hook callbacks (`onPreToolUse`, `onPostToolUse`, `onSessionStart`). A future version of this plugin could ship the guard and normalizer as an extension and avoid spawning PowerShell on every tool call. The earlier blockers are reported fixed: plugin-shipped extensions load since v1.0.88 ([copilot-cli#3023](https://github.com/github/copilot-cli/issues/3023)) and `additionalContext` from extension hooks is honored ([copilot-cli#2652](https://github.com/github/copilot-cli/issues/2652)). Remaining costs: every user must keep experimental mode on, extension hooks cannot see tool failures yet ([copilot-sdk#1220](https://github.com/github/copilot-sdk/issues/1220)), each extension asks for approval, and prompt-mode sessions need `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true`. Built-in tools cannot be overridden, so an extension cannot replace `edit` either.
- **`/rewind` file restore**: restores only the files Copilot changed, without git. A useful undo when a whole-file rewrite slips through.
- **Dynamic retrieval of skills** (`dynamicRetrieval.skills`): embedding-based per-turn retrieval that makes the quoting skill more likely to load when a prompt involves quoting or shell commands.

The **assisted approval** mode, the **critic** and **rubber-duck** agents and **autopilot** are about approvals, review and autonomy, not bytes on disk; they neither help nor hurt here. Hooks remain the only deterministic layer.

## Development

```powershell
pwsh -NoProfile -File tests/Invoke-HookTests.ps1                      # hooks under PowerShell 7
pwsh -NoProfile -File tests/Invoke-HookTests.ps1 -Shell powershell    # hooks under Windows PowerShell 5.1
copilot --plugin-dir .\plugins\windows-guard                          # try it live without installing
```

The tests feed synthetic Copilot CLI hook payloads to each script and check bytes on disk, deny decisions, exit codes and the inline launcher in `hooks.json`. CI runs them on `windows-latest`.

The hook payload shape is not documented, so it was verified against a live Copilot CLI 1.0.101 session: `toolArgs` arrives as an object; `create` carries `path` (absolute) and `file_text`; the shell tool carries `command`. The scripts still try `file_path`, `filePath`, `filename`, `fileName`, `file`, `target_file`, and parse `apply_patch` text, in case this changes. If the log shows `NO PATH KEY` lines, open an issue with the logged `toolArgs` shape.

Verified live on 2026-10-22 with CLI 1.0.101: a file the `create` tool reported as 17 characters (CRLF) was 14 bytes of LF on disk after the hook; `echo hello > file` was denied with the reason shown above and the agent switched to the `create` tool on its own.

## License

MIT
