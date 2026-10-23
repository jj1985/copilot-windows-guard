# Hooks, not prompts, tame Copilot CLI's Windows edits

> **Historical research, as of 2026-10-22.** The standalone hook examples below predate the packaged extension engine; do not install them alongside the plugin or they will run twice. This `experimental` branch now offers the same protections through opt-in in-process extension hooks, verified on CLI 1.0.103 on 2026-10-23. Use the [current branch-pinned installation instructions](../README.md#installation) and [extension-mode requirements and limitations](../README.md#extension-mode-experimental), rather than these standalone examples, to try it.

GitHub Copilot CLI's trouble with files on Windows 11 is three separate problems wearing one symptom, and only one of them answers to better prompting. The first is a **confirmed, unfixed bug in the CLI's own `edit` and `create` tools**: on Windows they normalize line endings only while *matching* `old_str`, then write the file back with **CRLF regardless of what it had, prepend a UTF-8 BOM, and re-encode non-UTF-8 files to UTF-8**, ignoring `.gitattributes`; the issues (#1148, #3389, #3604/#3732) have been open since January–June 2026 with **no maintainer reply and no fix through v1.0.103 (2026-10-22)** ([copilot-cli#1148](https://github.com/github/copilot-cli/issues/1148); [copilot-cli#3389](https://github.com/github/copilot-cli/issues/3389); [changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)). The second is **model behavior**: the models emit `grep`, `head`, `&&`, heredocs and `2>/dev/null` into a PowerShell session despite explicit instructions, and when the native edit tool fails they fall back to `Set-Content`, `>` or `python -c`, which adds a second, independent CRLF/UTF-16/ANSI source ([copilot-cli#689](https://github.com/github/copilot-cli/issues/689); [copilot-cli#2981](https://github.com/github/copilot-cli/issues/2981)). The third is **environment**: the agent's shell is hard-wired to a fresh `pwsh -NoProfile` per command (nothing in `$PROFILE` reaches it), it silently downgrades to Windows PowerShell 5.1 if `pwsh.exe` is not on the PATH the CLI's background process sees, and no setting anywhere selects Git Bash or cmd ([copilot-cli#1680](https://github.com/github/copilot-cli/issues/1680); [v1.0.45](https://github.com/github/copilot-cli/releases/tag/v1.0.45)). What you can do today: make PowerShell 7 the only shell the CLI can find, let Git normalize commits, and, the lever that actually works, install two Copilot CLI hooks: a `postToolUse` hook that rewrites every edited file to the repo's intended line ending without a BOM, and a `preToolUse` hook that denies the shell idioms that corrupt files and hands the model the PowerShell equivalent. Instruction files help at the margin (the one rule worth having is "put file content through the edit tool, never through the shell"), but documented cases across Copilot, Cursor and Claude Code show prose alone does not stop the behavior. What you cannot fix: destruction of legacy-code-page bytes (they are replaced before the model sees a diff, so block those edits instead), the curly-quote "No match found" failure, the lack of shell selection, and the ConstrainedLanguage and console-window bugs.

## The edit tool normalizes what it matches, then rewrites what it writes

The byte-level evidence is unambiguous and comes from users who measured, not guessed. On **v1.0.44 and v1.0.49 (Windows 11, PowerShell 7)** a file created by the `create` tool from LF-only content came back **48 bytes instead of 44**, CRLF on every line, inside a repo whose `.gitattributes` said `* text=auto eol=lf`; the reporter's conclusion was that the attribute "is ignored by the tool's write path" ([copilot-cli#1148](https://github.com/github/copilot-cli/issues/1148)). A week later the same reporter ran one `edit` on a 35-byte BOM-less file and got **42 bytes with `EF BB BF` prepended, CRLF count unchanged (3 → 3)**, and drew the critical distinction: "The `edit` tool correctly normalizes line endings for `old_str` matching (LF `old_str` matched CRLF file content successfully), but the output file gains a BOM and retains CRLF, so the normalization only applies to matching, not to the written output" ([copilot-cli#3389](https://github.com/github/copilot-cli/issues/3389)). This asymmetry explains the shape of your pain. Because matching tolerates CRLF, you rarely see the "string not found" failures that plague Gemini CLI or Kiro on CRLF files; instead Copilot CLI's signature on Windows is **silent LF→CRLF conversion that shows up as a whole-file diff, plus a BOM**, and since v0.0.423 made the CLI's own `/diff` render CRLF cleanly, you usually only notice in `git status` or when a downstream parser chokes on `\ufeff` ([changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)).

The encoding half is worse because it is lossy. A Windows-1252 file is converted to UTF-8 on any edit, and the agent then "tries to revert the encoding using scripts" ([copilot-cli#3604](https://github.com/github/copilot-cli/issues/3604)). A single CP1252 `0xA9` (©) byte becomes **`EF BF BD` (U+FFFD) on any edit, including edits that do not touch that line**, and "the replacement happens before the diff/patch logic sees the file, so it is invisible to the model" ([copilot-cli#3732](https://github.com/github/copilot-cli/issues/3732)). The oldest report of this class, Finnish "ä" corrupted in C# comments, dates from **2025-10-15** and got a same-day "Definitely something for us to look into" from a maintainer and nothing since ([copilot-cli#308](https://github.com/github/copilot-cli/issues/308)). A separate matching bug rounds out the picture: `edit` returns a bare "No match found" whenever `old_str` spans curly quotes (U+201C/U+201D), 3 of 3 attempts failing where ASCII-only edits in the same session succeeded, with no character-level diagnostic the model could use to self-correct ([copilot-cli#3254](https://github.com/github/copilot-cli/issues/3254)).

Every one of these issues carries the `area:tools` label, so they were triaged, yet none has a maintainer comment, an assignee, or a fix version; a sweep of **512 releases from v0.0.328 to v1.0.103** found no release note about CRLF, BOM or encoding preservation by the file tools, only a generic v1.0.41 line about "better recovering from fuzzy or misaligned edit blocks" ([releases](https://github.com/github/copilot-cli/releases); [v1.0.41](https://github.com/github/copilot-cli/releases/tag/v1.0.41)). The runtime is closed-source, so the mechanism is inferred: the measurements are exactly what a .NET-style "platform defaults" writer produces, because `Encoding.UTF8` emits the `EF BB BF` preamble while `new UTF8Encoding(false)` does not, and `Environment.NewLine` is CRLF on Windows ([UTF8Encoding.GetPreamble](https://learn.microsoft.com/dotnet/api/system.text.utf8encoding.getpreamble?view=net-10.0)). The fix is small and well known: Roo Code's editor detects the file's ending with `originalContent.includes("\r\n") ? "\r\n" : "\n"`, splits on `/\r?\n/` and re-joins with the detected ending ([Roo-Code multi-search-replace.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/diff/strategies/multi-search-replace.ts)); the pi agent's fix normalizes both sides to LF for matching, then restores the original ending before writing ([pi#360](https://github.com/earendil-works/pi/issues/360)). Claude Code shipped the equivalent fixes in v2.1.77 and v2.1.89 and, in v2.1.299, now **refuses** to write Windows-1252 or Shift-JIS files rather than silently converting them ([claude-code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)). Codex took eleven months on the same bug and shipped the fix as an opt-in flag ([openai/codex#4003](https://github.com/openai/codex/issues/4003)). The lesson for you is not to wait: the repair belongs in a hook you control.

## Models write bash into PowerShell, and GitHub chose tolerance over steering

The model-behavior layer is real and documented in GitHub's own tracker. One reporter's custom instructions said "Any shell or terminal commands/syntax should be PowerShell native ... DO NOT use Unix/Linux-style commands"; the agent still ran `dotnet build ... 2>&1 | grep "\.cs(" | head -20` first and only then `Select-String ... | Select-Object -First 20` ([copilot-cli#689](https://github.com/github/copilot-cli/issues/689)). On v1.0.36 the agent generated `python -c "..." 2>&1 | head -900` and got "The term 'head' is not recognized" even though the environment context already said `Windows_NT` ([copilot-cli#2981](https://github.com/github/copilot-cli/issues/2981)). The same pattern appears outside the CLI: VS Code users with explicit `copilot-instructions.md` rules ("Use `;` instead of `&&`") report they are "always ignored" ([community#158885](https://github.com/orgs/community/discussions/158885)), and Cursor users found a rule stating "The user is on Windows with PowerShell as their default shell" did not stop Sonnet 4 or GPT-5 from emitting Linux commands, until Cursor fixed shell detection in the product instead ([Cursor forum](https://forum.cursor.com/t/agents-ignore-rule-to-use-powershell-commands-and-default-to-linux/133205)).

GitHub's maintainers saw the same thing and chose an architectural response. Steve Sanderson explained in February 2026 that "models would very persistently produce scripts that use modern syntax and couldn't be persuaded to use legacy PowerShell syntax ... We eliminated that problem by requiring PowerShell 6+", which accepts `&&` ([copilot-cli#1680](https://github.com/github/copilot-cli/issues/1680)); Evan Boyle had already conceded that "models do not seem to do a great job generating powershell" ([copilot-cli#508](https://github.com/github/copilot-cli/issues/508)). The only prompt-level changes on record are generic: Windows-style paths in v0.0.343 and, in v1.0.49, "avoiding && chaining instructions when using legacy PowerShell 5.x" ([changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)). A great deal of what feels like "quoting bugs" is actually the CLI's pre-execution safety parser misreading PowerShell: the division operator, `/flag` arguments, `$()` sub-expressions, redirect paths and `Select-String`/`Where-Object` all triggered spurious permission prompts or content-exclusion refusals until fixes landed between **v1.0.52 and v1.0.68**, which is a concrete reason to stay current ([changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)). A heredoc body containing the word "kill" is still scanned by the command-interception filter ([copilot-cli#3334](https://github.com/github/copilot-cli/issues/3334)).

The damaging part of model behavior is the fallback cascade. When `edit` fails (curly quotes, stale `old_str`) or the password-masking feature confuses it, the model "falls back to Python for file reads and edits" or to shell writes ([copilot-cli#4241](https://github.com/github/copilot-cli/issues/4241)), and every shell write path on Windows has its own line-ending and encoding defaults. `Set-Content` "always uses the platform line endings" with no `-NewLine` parameter ([PowerShell#2872](https://github.com/powershell/powershell/issues/2872)); under Windows PowerShell 5.1, "`Out-File` and the redirection operators `>` and `>>` create UTF-16LE", `Set-Content`/`Add-Content` on new files use the ANSI code page, and `-Encoding UTF8` means UTF-8 *with* BOM, whereas PowerShell 7 "defaults to `utf8NoBOM` for all output" ([about_Character_Encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-7.6)). Python's universal-newline mode turns `\n` into `\r\n` on write unless `newline=''` is passed, which the Kimi CLI team documented as the same cascade: edit tool fails → Python one-liner → PowerShell quoting, f-string backslash, JSON-escaping and tab-vs-space failures in sequence ([kimi-cli#2191](https://github.com/moonshotai/kimi-cli/issues/2191)). Quoting has a second trap specific to the Windows toolchain: PowerShell 7.3+ fixed embedded-quote passing to native executables, but on Windows the default `$PSNativeCommandArgumentPassing` is `Windows`, which deliberately keeps the broken `Legacy` behavior for `cmd.exe` and anything ending in `.bat` or `.cmd`, and `npm`, `npx`, `yarn`, `pnpm` and `gradlew` are `.cmd` shims, so a JSON argument with embedded quotes is mangled even under pwsh 7.6 ([about_Preference_Variables](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-7.6#psnativecommandargumentpassing); [SO 74440303](https://stackoverflow.com/questions/74440303/powershell-7-3-0-breaking-command-invocation)). The escape hatches are the stop-parsing token `--%` or handing the entire command line to `cmd /c "..."` ([about_Parsing](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_parsing?view=powershell-7.6#the-stop-parsing-token)). One model-generated PowerShell anti-pattern is outright dangerous: `$home = '...'; Remove-Item -Recurse -Force $home` resolves to the real profile because PowerShell variables are case-insensitive and `$HOME` is an automatic variable; a Microsoft engineer hit it again days after it was filed ([copilot-cli#3098](https://github.com/github/copilot-cli/issues/3098)).

## The agent's shell is `pwsh -NoProfile`, picked by PATH, and nothing lets you change it

Understanding the environment layer tells you which fixes can possibly work. The bundled `index.js` hard-codes `pwsh.exe` in six places, including the PTY spawn and the detached-command path ([copilot-cli#1680](https://github.com/github/copilot-cli/issues/1680)); every shell command is a **fresh process** (since v1.0.62 "lightweight process spawning instead of a pseudo-terminal"), so no variable, alias, `cd` or preference survives between commands ([changelog](https://github.com/github/copilot-cli/blob/main/changelog.md); [copilot-cli#4549](https://github.com/github/copilot-cli/issues/4549)). The documented `powershellFlags` setting defaults to `["-NoProfile", "-NoLogo"]`, which means **nothing you put in `$PROFILE`, including `$PSDefaultParameterValues['*:Encoding']`, is seen by the agent's commands** ([CLI config reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference); [v1.0.4](https://github.com/github/copilot-cli/releases/tag/v1.0.4)). The exact wrapper the harness runs was captured in a VS Code issue: `pwsh.exe -NoProfile -NoLogo -NonInteractive -Command "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; ... $PSStyle.OutputRendering = 'PlainText' ... [command] ... finally { ... $host.SetShouldExit($LASTEXITCODE) }"` ([microsoft/vscode#342539](https://github.com/microsoft/vscode/issues/342539)). Two consequences follow: console I/O is already UTF-8, so `chcp 65001` and `PYTHONIOENCODING` are not needed and do not appear as fixes anywhere in the tracker; and the `$host.SetShouldExit()` call is what emits roughly 150 tokens of error noise on every command under AppLocker/WDAC ConstrainedLanguage mode, with no user-side remedy ([copilot-cli#4683](https://github.com/github/copilot-cli/issues/4683)).

Which PowerShell edition the agent gets is decided by PATH, not by the terminal you type in. Users with PowerShell 7 installed and working interactively still saw "PowerShell 6+ (pwsh) is not available" because the install folder was missing from the **system** PATH that the background process inherits ([community#187164](https://github.com/orgs/community/discussions/187164)); others hit `spawn pwsh.exe ENOENT` because the Microsoft Store install exposes only a 0-byte App Execution Alias stub in `%LocalAppData%\Microsoft\WindowsApps`, handled by the CLI only from **v1.0.55** ([copilot-cli#2355](https://github.com/github/copilot-cli/issues/2355); [changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)). Since **v1.0.45 (2026-05-11)** the CLI falls back to `powershell.exe` 5.1 when `pwsh` is absent ([v1.0.45](https://github.com/github/copilot-cli/releases/tag/v1.0.45)), a reversal of the earlier policy that reintroduces exactly the failure Sanderson described: `||` and `&&` are parse errors in 5.1 and have already broken cross-tool hooks ([copilot-cli#4399](https://github.com/github/copilot-cli/issues/4399)), and `>` writes UTF-16LE. The downgrade is silent, which is why step one of the fix stack is to make it impossible.

There is no shell selection. The requests to use Git Bash (#508, open since November 2025; #1034; #2271) remain open, one was closed without comment, and the only `SHELL`-related change (v1.0.35) affects the `!` escape, not the agent's tool; launching `copilot` from Git Bash changes nothing because the CLI "relies on pwsh for certain internal operations on Windows, even when the target shell is bash" ([copilot-cli#508](https://github.com/github/copilot-cli/issues/508); [copilot-cli#2271](https://github.com/github/copilot-cli/issues/2271); [community#189318](https://github.com/orgs/community/discussions/189318)). Claude Code, by contrast, exposes `CLAUDE_CODE_GIT_BASH_PATH` and a PowerShell tool whose prompt carries "version-appropriate syntax guidance (5.1 vs 7+)" ([Claude Code setup](https://code.claude.com/docs/en/setup); [claude-code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)). WSL is the one supported escape: you get the Linux build with a real bash tool and none of the PowerShell defaults, but file I/O through `/mnt/c` measured **7x slower for sequential writes and roughly 60x slower for metadata operations** than ext4 inside the VM ([brainwagon benchmark](https://brainwagon.org/blog/2026_07_11_wsl2_filesystem_speed)), Microsoft itself says to keep files on the side of the boundary where your tools run ([Microsoft Learn: WSL filesystems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)), and the CLI has its own open WSL cluster (CPU spin at idle, 31 GB RSS, sessions anchored to the Windows host) ([copilot-cli#3700](https://github.com/github/copilot-cli/issues/3700); [copilot-cli#4694](https://github.com/github/copilot-cli/issues/4694)). For a .NET, MSBuild or PowerShell-heavy repo, WSL trades your current problems for different ones; for a Linux toolchain it is a reasonable choice. As a local observation (not a web source), the machine used for this research runs CLI 1.0.101 with pwsh 7.6.7 resolved through the Store alias and `$PSNativeCommandArgumentPassing` set to `Windows`, which is the configuration the recommendations below assume.

## What you can fix, what you can only contain, and what you must live with

The honest split is that **two of the three layers are yours to control and the third is only repairable after the fact**. The environment layer is fully fixable: install pwsh 7, put it where the CLI finds it, keep the CLI current, and the 5.1 fallback, the Store-alias spawn failure and the safety-parser false positives all disappear. The model layer is containable but not curable: instructions reduce bash-isms at the margin, while a `preToolUse` hook can deterministically deny the specific idioms that corrupt files, which is the same conclusion Anthropic draws for its own product ("hooks are deterministic and guarantee the action happens", whereas instruction files are "advisory") ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)). The tool layer cannot be prevented, because the write path runs inside a closed-source binary that ignores `.gitattributes`, but its two reversible effects (CRLF and BOM) can be undone by a `postToolUse` hook within milliseconds of each edit, and Git can clean the commit regardless. Its irreversible effect, legacy-code-page byte destruction, can only be blocked.

| Symptom you see | Layer | Fixable today? | Mechanism |
|---|---|---|---|
| LF file comes back CRLF after `edit`/`create`; whole-file diff | Tool bug (#1148) | Repair, not prevent | `postToolUse` normalizer; `.gitattributes` cleans the commit |
| UTF-8 BOM appears after `edit` | Tool bug (#3389) | Repair, not prevent | `postToolUse` normalizer |
| Windows-1252 file re-encoded; `©` becomes U+FFFD | Tool bug (#3604, #3732) | Cannot repair; can block | `preToolUse` UTF-8 gate; convert the repo to UTF-8 first |
| "No match found" on curly quotes | Tool bug (#3254) | Workaround only | Instruction: shorten `old_str`, re-`view`, never guess |
| `grep`/`head`/`&&`/heredoc/`2>/dev/null` in PowerShell | Model behavior | Contain | `preToolUse` shell guard with teaching messages; instructions |
| Shell writes produce CRLF, UTF-16LE or ANSI bytes | Model + environment | Prevent | Guard denies writes without `-Encoding utf8NoBOM`; pwsh 7; instructions |
| Silent fallback to Windows PowerShell 5.1 | Environment | Fix | pwsh 7 on machine PATH; CLI >= 1.0.55 |
| Spurious permission prompts on PowerShell syntax | Tool bug, fixed 1.0.52–1.0.68 | Fix | Update the CLI |
| Cannot switch the agent to Git Bash or cmd | Tool design | No | #508/#2271 open; WSL is the only alternative |
| `$host.SetShouldExit()` noise under ConstrainedLanguage | Tool bug (#4683) | No | None |
| A visible `pwsh` console per command (#4549) | Tool bug | No | None |

## The fix stack, in priority order

Each item below carries a confidence label. **High** means the behavior is documented by GitHub or Microsoft or confirmed by multiple independent reports; **Medium** means the mechanism is documented but this exact application is untested or depends on an undocumented detail that the verification step covers; **Low** means a plausible inference, or evidence that the effect is inconsistent.

### 1. Make PowerShell 7 the only shell the CLI can find (High)

This single change removes the UTF-16LE redirection trap, the ANSI `Set-Content` default, the `&&`/`||` parse errors and the ASCII `$OutputEncoding`, all of which are 5.1-only ([Differences between Windows PowerShell 5.1 and PowerShell 7.x](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/differences-from-windows-powershell?view=powershell-7.5)). The CLI's winget manifest already declares `Microsoft.PowerShell >= 7.0` as a dependency ([copilot-cli#3240](https://github.com/github/copilot-cli/issues/3240)), but a dependency installed does not mean a dependency found by a background process, so verify from a non-PowerShell parent.

```powershell
# Install (MSIX via the Store alias by default since 7.6; add --installer-type wix for the MSI,
# which places pwsh.exe under C:\Program Files\PowerShell\7 and on the machine PATH)
winget install --id Microsoft.PowerShell --source winget

# Prove a NON-PowerShell parent resolves it (this is what the CLI's background process does)
cmd /c pwsh --version
(Get-Command pwsh).Source

# The folder must be on the Machine or User Path; a fresh terminal is required after changes
foreach ($scope in 'Machine','User') {
  [Environment]::GetEnvironmentVariable('Path',$scope) -split ';' | Where-Object { $_ -match 'PowerShell|WindowsApps' } |
    ForEach-Object { "$scope : $_" }
}

# Keep the CLI current: Store-alias detection landed in 1.0.55, shell-start reliability in 1.0.101
winget upgrade GitHub.Copilot          # or: npm install -g @github/copilot@latest
copilot --version
```

Inside a Copilot session, ask the agent to run `$PSVersionTable.PSVersion; $PSNativeCommandArgumentPassing` and expect `7.x` and `Windows`; if you see `5.1`, the fallback is active and nothing else in this report will behave as described. Leave `powershellFlags` at its default: removing `-NoProfile` to smuggle in `$PSDefaultParameterValues` reintroduces the profile-induced hangs that v0.0.335 and v1.0.4 fixed, and the wrapper already forces UTF-8 console output ([copilot-cli#196](https://github.com/github/copilot-cli/issues/196); [copilot-cli#1436](https://github.com/github/copilot-cli/issues/1436)). The Windows "Beta: Use Unicode UTF-8" system toggle is **not** required and is Low-value here: the CLI's wrapper sets console encoding per command, and the toggle is known to deliver hook stdin with a BOM prefix that JSON parsers reject ([clawd-on-desk#641](https://github.com/rullerzhou-afk/clawd-on-desk/issues/641)); the scripts below strip that BOM defensively either way.

### 2. Let Git clean the commit even when the working tree is wrong (High)

`.gitattributes` and `core.autocrlf` govern only Git's index/working-tree conversion; they cannot change what the tool writes, and three users confirmed `* -text`, `* text eol=lf` and `* text=auto eol=lf` all failed to stop CRLF injection ([copilot-cli#1148](https://github.com/github/copilot-cli/issues/1148)). What they do guarantee is that a CRLF file dropped into an LF-normalized repo is normalized to LF on `git add`, so the commit and `git diff` show only the intended change ([gitattributes](https://git-scm.com/docs/gitattributes)). An explicit `eol` attribute overrides `core.autocrlf` and `core.eol` for every contributor, which is why the policy lives in the repo file rather than in each developer's config ([git-config](https://git-scm.com/docs/git-config); [GitHub Docs: line endings](https://docs.github.com/en/get-started/git-basics/configuring-git-to-handle-line-endings)).

```gitattributes
# .gitattributes  (repo root, committed)
# Everything Git detects as text is LF in the index AND in the working tree, on every OS.
* text=auto eol=lf

# Windows batch files break without CRLF.
*.bat text eol=crlf
*.cmd text eol=crlf

# Visual Studio solution/project files are conventionally CRLF.
*.sln     text eol=crlf
*.vcproj  text eol=crlf
*.vcxproj text eol=crlf

# Shell scripts must stay LF even for contributors with core.autocrlf=true.
*.sh text eol=lf

# Uncomment only if Authenticode-signed or 5.1-targeted scripts must keep CRLF (see PowerShell#25246).
# *.ps1 text eol=crlf

# Never touch binaries.
*.png *.jpg *.gif *.ico *.pdf *.zip *.woff *.woff2 *.dll *.exe binary
```

```powershell
# Global defaults: normalize to LF on commit, convert nothing on checkout, warn on irreversible conversions.
git config --global core.autocrlf input
git config --global core.safecrlf warn
# Optional, only for repos that legitimately contain CRLF files: stop 'git diff' flagging every \r as whitespace.
git config --global core.whitespace cr-at-eol

# Per repo, after adding .gitattributes (GitHub's documented refresh procedure):
git add . -u
git commit -m "Saving files before refreshing line endings"
git add --renormalize .
git status
git commit -m "Normalize all the line endings"
```

The GitHub docs page still recommends `core.autocrlf true` on Windows; `input` is the better choice for agent-heavy repos because `true` re-converts LF to CRLF on checkout, which breaks `.sh`, Dockerfiles and `git apply` for every other tool ([GitHub Docs: line endings](https://docs.github.com/en/get-started/git-basics/configuring-git-to-handle-line-endings)). After an agent session, `git ls-files --eol` is the fastest way to see index versus working-tree endings per file; a `w/crlf` next to an `attr/... eol=lf` entry is a file the agent flipped and the hook in step 3 should have caught.

### 3. A `postToolUse` hook that undoes CRLF and BOM after every edit (Medium)

Copilot CLI's hooks are the deterministic layer this problem needs. Hook files live in `%USERPROFILE%\.copilot\hooks\*.json` for you alone or `.github\hooks\*.json` for the team; a `postToolUse` entry whose `matcher` is a regex compiled as `^(?:PATTERN)$` over `toolName` fires after each successful tool call, receives JSON on stdin with `sessionId`, `cwd`, `toolName`, `toolArgs` and `toolResult`, and may emit nothing, `additionalContext`, or `modifiedResult` ([Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference); [CLI hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference)). Matchers on `postToolUse` have been honored since v1.0.63, hooks fire for sub-agent tool calls since v1.0.49, and a timed-out hook fails open, so a slow normalizer never blocks the agent ([changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)). The one undocumented detail is the **name of the key inside `toolArgs` that holds the file path for `edit`/`create`**: only `old_str` and `new_str` are confirmed from a bug report ([copilot-cli#3254](https://github.com/github/copilot-cli/issues/3254)), and GitHub's tutorial notes that `toolArgs` arrives as a JSON string that must be parsed again ([Hooks tutorial](https://docs.github.com/en/copilot/tutorials/copilot-cli-hooks)). The script below tries the likely candidates, handles both string and object forms, logs the raw payload when it cannot find a path, and has a `$LogAll` switch for the one-time verification described in step 8.

Save this as `%USERPROFILE%\.copilot\hooks\scripts\normalize-eol.ps1` (ASCII content, so its own encoding does not matter). Its policy order deliberately makes `.gitattributes` the single source of truth: an explicit `eol=` attribute wins, then the ending already recorded in the Git index for that file (so a CRLF-convention repo stays CRLF), then an extension list, then LF.

```powershell
#Requires -Version 7.0
# Copilot CLI postToolUse hook (Windows): after edit/create writes a file, remove a UTF-8 BOM and restore the
# intended line ending. Target ending, in order: .gitattributes eol= > ending already in the git index >
# $CrlfExt list > $DefaultEol. Fails open: any error exits 0 silently so the tool result is untouched.
$ErrorActionPreference = 'Stop'
$LogPath    = Join-Path $HOME '.copilot\hooks\normalize-eol.log'
$LogAll     = $false                       # set $true ONCE to dump raw hook input and learn the toolArgs key names
$DefaultEol = 'lf'                         # for new/untracked files with no attribute and no index entry
$CrlfExt    = @('.bat', '.cmd', '.sln', '.vcproj', '.vcxproj')
$KeepBomExt = @()                          # e.g. @('.ps1') if non-ASCII scripts must run under Windows PowerShell 5.1
$PathKeys   = @('path', 'file_path', 'filePath', 'filename', 'target_file')   # UNVERIFIED candidates; see $LogAll

function Log([string]$m) { try { Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format s) $m" -Encoding utf8 } catch {} }

try {
    $raw = [Console]::In.ReadToEnd()
    if ($raw.Length -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }     # BOM on stdin (CP65001 consoles)
    if ($LogAll) { Log "RAW $raw" }
    $hook = $raw | ConvertFrom-Json
    $ta = $hook.toolArgs
    if ($ta -is [string]) { $ta = $ta | ConvertFrom-Json }                           # tutorial: toolArgs is a JSON string

    $files = @()
    foreach ($k in $PathKeys) { if ($ta.PSObject.Properties[$k] -and $ta.$k) { $files += [string]$ta.$k; break } }
    foreach ($k in 'patch', 'input') {                                               # apply_patch names files in the patch text
        if (-not $files -and $ta.PSObject.Properties[$k] -and ($ta.$k -is [string])) {
            $files += [regex]::Matches($ta.$k, '^\*\*\* (?:Update|Add) File: (.+)$', 'Multiline') |
                      ForEach-Object { $_.Groups[1].Value.Trim() }
        }
    }
    if (-not $files) { Log "NO PATH KEY toolName=$($hook.toolName) toolArgs=$($ta | ConvertTo-Json -Compress -Depth 3)"; exit 0 }

    foreach ($f in $files) {
        $full = [IO.Path]::IsPathRooted($f) ? $f : (Join-Path $hook.cwd $f)
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        $bytes = [IO.File]::ReadAllBytes($full)
        if ($bytes.Length -eq 0 -or [Array]::IndexOf($bytes, [byte]0) -ge 0) { continue }   # empty or binary
        $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
        $off  = $hasBom ? 3 : 0
        $text = [Text.UTF8Encoding]::new($false).GetString($bytes, $off, $bytes.Length - $off)

        # Decide the target ending.
        $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
        $eol = $null
        try {
            Push-Location -LiteralPath (Split-Path -LiteralPath $full)
            $info = git ls-files --eol -- (Split-Path -Leaf $full) 2>$null
            if     ($info -match 'attr/[^\t]*eol=(lf|crlf)') { $eol = $Matches[1] }   # explicit attribute
            elseif ($info -match 'i/(lf|crlf)')              { $eol = $Matches[1] }   # what the index already holds
        } catch {} finally { try { Pop-Location } catch {} }
        if (-not $eol) { $eol = ($CrlfExt -contains $ext) ? 'crlf' : $DefaultEol }
        $nl = ($eol -eq 'crlf') ? "`r`n" : "`n"

        $out = ($text -replace "`r`n", "`n") -replace "`r", "`n"
        if ($nl -ne "`n") { $out = $out -replace "`n", $nl }
        $keepBom = $hasBom -and ($KeepBomExt -contains $ext)
        if ($out -ne $text -or ($hasBom -and -not $keepBom)) {
            [IO.File]::WriteAllText($full, $out, [Text.UTF8Encoding]::new($keepBom))   # writes the string verbatim
            Log "FIXED $full eol=$eol bomRemoved=$($hasBom -and -not $keepBom)"
        }
    }
} catch { Log "ERROR $($_.Exception.Message)" }
exit 0
```

`[IO.File]::WriteAllText` with an explicit `UTF8Encoding($false)` is the only write primitive that is identical under 5.1 and 7, emits no BOM, and never appends or alters a newline, which is why it is used here and recommended to the model in step 6 ([File.WriteAllText](https://learn.microsoft.com/dotnet/api/system.io.file.writealltext?view=net-10.0)). Because the edit tool normalizes line endings when matching, a file the hook has just converted to LF will still match the model's next LF-based `old_str`; whether the tool keeps a "modified since read" check that a hook rewrite could trip is undocumented, so if edits start failing immediately after this hook is installed, that is the first thing to suspect and to report.

### 4. A `preToolUse` hook that blocks the shell idioms that corrupt files (Medium)

The `preToolUse` event receives the same stdin shape and may return `{"permissionDecision":"deny","permissionDecisionReason":"..."}`; the reason is shown to the model, which turns a denial into a correction, the pattern a Claude Code user described as "Sir, this is a PowerShell. Use the PowerShell() tool" and reported "helps in most cases" ([Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference); [claude-code#45831](https://github.com/anthropics/claude-code/issues/45831)). Two properties of `preToolUse` shape the script: a non-zero exit or script error **denies** the call (fail-closed since v1.0.57), so an internal bug would block every shell command, which is why the script swallows its own exceptions and exits 0; and in autopilot mode an `ask` decision is treated as deny, so the script uses `deny` directly ([changelog](https://github.com/github/copilot-cli/blob/main/changelog.md); [CLI hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference)). On Windows the shell tool is named `powershell`, so the matcher is `bash|powershell` ([Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)). `--deny-tool` cannot do this job because its wildcards are limited to subcommand prefixes ([Programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)).

Save as `%USERPROFILE%\.copilot\hooks\scripts\shell-guard.ps1`. The redirect rule is the aggressive one (it will also fire on a literal `>` inside a quoted string); drop it if it gets in your way, and trim the Unix-command list if you have installed Microsoft Coreutils deliberately.

```powershell
#Requires -Version 7.0
# Copilot CLI preToolUse hook (Windows shell tool): deny command strings that corrupt files or cannot run in
# PowerShell, and hand the model the PowerShell idiom. Internal errors ALLOW the call (exit 0, no output),
# because preToolUse is otherwise fail-closed and a bug here would block every shell command.
$ErrorActionPreference = 'Stop'
function Deny([string]$why) { @{ permissionDecision = 'deny'; permissionDecisionReason = $why } | ConvertTo-Json -Compress; exit 0 }
try {
    $raw = [Console]::In.ReadToEnd()
    if ($raw.Length -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
    $hook = $raw | ConvertFrom-Json
    $ta = $hook.toolArgs
    if ($ta -is [string]) { $ta = $ta | ConvertFrom-Json }
    $cmd = [string]$ta.command
    if (-not $cmd) { exit 0 }

    $rules = @(
        @{ re  = '<<-?\s*[''"]?[A-Za-z_]\w*'
           why = 'Bash heredocs do not exist in PowerShell. Put file content through the edit/create tool, or create a .ps1 with the create tool and run: pwsh -NoProfile -ExecutionPolicy Bypass -File .\script.ps1' }
        @{ re  = '2>\s*/dev/null'
           why = 'Use 2>$null; PowerShell treats /dev/null as a file path.' }
        @{ re  = '(?m)(^|[|;&(]\s*)(sed|awk|grep|head|tail|touch|which|export|chmod|ln)\s'
           why = 'Unix command in a PowerShell session. Use Select-String (grep), Select-Object -First N (head), Get-Content -Tail N (tail), New-Item -ItemType File (touch), Get-Command (which), $env:NAME = ''value'' (export). For in-place edits use the edit tool, not sed.' }
        @{ re  = '\b(Set-Content|Add-Content|Out-File|Tee-Object)\b(?![^|;]*-Encoding\s+utf8NoBOM)'
           why = 'Shell writes must pass -Encoding utf8NoBOM. File content belongs in the edit/create tool; to capture output use: <command> | Out-File -Encoding utf8NoBOM -FilePath <path>' }
        @{ re  = '(?<![-<])(?:\b[1-6*])?>{1,2}\s*(?!\$null\b)(?!&\d)[^\s|;&>]+'
           why = 'Redirecting to a file writes CRLF (and UTF-16LE under Windows PowerShell 5.1). Use the edit/create tool for file content, or <command> | Out-File -Encoding utf8NoBOM -FilePath <path> to capture output.' }
        @{ re  = '(?i)\$home\s*='
           why = '$home is PowerShell''s HOME alias; assigning it can point destructive commands at the real profile. Use another variable name.' }
        # Optional; can misfire on JSON passed to .cmd shims in legacy argument-passing mode:
        # @{ re = '\\"'; why = 'Backslash is not an escape character in PowerShell. Use single quotes for literals, or "" / `" inside double quotes.' }
    )
    foreach ($r in $rules) { if ($cmd -match $r.re) { Deny $r.why } }
} catch {}
exit 0
```

### 5. A `preToolUse` gate for files the edit tool would destroy (Medium)

Because the encoding corruption in #3732 happens before any diff and replaces bytes irreversibly, the only protection is to refuse the edit. This gate denies `edit` on any file that is not valid UTF-8 (UTF-16 with BOM is reported separately) and tells the model to ask you to convert the file first. Save as `%USERPROFILE%\.copilot\hooks\scripts\utf8-gate.ps1`; the path-key caveat from step 3 applies.

```powershell
#Requires -Version 7.0
# Copilot CLI preToolUse hook for edit tools: refuse to edit a file that is not valid UTF-8, because the edit
# tool re-encodes it and replaces unmappable bytes with U+FFFD before the model sees a diff (copilot-cli#3732).
$ErrorActionPreference = 'Stop'
try {
    $raw = [Console]::In.ReadToEnd(); if ($raw.Length -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
    $hook = $raw | ConvertFrom-Json; $ta = $hook.toolArgs; if ($ta -is [string]) { $ta = $ta | ConvertFrom-Json }
    $p = $null; foreach ($k in 'path','file_path','filePath') { if ($ta.PSObject.Properties[$k] -and $ta.$k) { $p = [string]$ta.$k; break } }
    if (-not $p) { exit 0 }
    $full = [IO.Path]::IsPathRooted($p) ? $p : (Join-Path $hook.cwd $p)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { exit 0 }
    $b = [IO.File]::ReadAllBytes($full)
    if ($b.Length -ge 2 -and (($b[0] -eq 0xFF -and $b[1] -eq 0xFE) -or ($b[0] -eq 0xFE -and $b[1] -eq 0xFF))) { $enc = 'UTF-16' }
    else { try { [void][Text.UTF8Encoding]::new($false, $true).GetString($b); exit 0 } catch { $enc = 'a legacy code page such as Windows-1252' } }
    @{ permissionDecision = 'deny'
       permissionDecisionReason = "$p is encoded as $enc, not UTF-8. The edit tool would re-encode it and corrupt non-ASCII bytes. Ask the user to convert the file to UTF-8 first, or make this change by hand." } | ConvertTo-Json -Compress
} catch {}
exit 0
```

Wire all three scripts up with one hook file. For your own machine, the `exec`/`args` form (CLI-only) runs `pwsh` directly without an intermediate shell, which removes any question of whether the `powershell` field is executed by `pwsh` or `powershell.exe` (the docs do not say) and whether stdin is inherited through it ([Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)). The generator below writes the JSON with your real paths; run it once in PowerShell 7 after saving the three scripts.

```powershell
# Writes %USERPROFILE%\.copilot\hooks\windows-guard.json with absolute paths. Run once in PowerShell 7.
$hooks = Join-Path $HOME '.copilot\hooks'
New-Item -ItemType Directory -Force (Join-Path $hooks 'scripts') | Out-Null
$ps = (Get-Command pwsh).Source
$std = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File')
$cfg = [ordered]@{
  version = 1
  hooks = [ordered]@{
    preToolUse = @(
      [ordered]@{ type = 'command'; matcher = 'bash|powershell';     exec = $ps; args = $std + (Join-Path $hooks 'scripts\shell-guard.ps1');  timeoutSec = 10 }
      [ordered]@{ type = 'command'; matcher = 'edit|str_replace_editor'; exec = $ps; args = $std + (Join-Path $hooks 'scripts\utf8-gate.ps1'); timeoutSec = 10 }
    )
    postToolUse = @(
      [ordered]@{ type = 'command'; matcher = 'edit|create|str_replace_editor|apply_patch'; exec = $ps; args = $std + (Join-Path $hooks 'scripts\normalize-eol.ps1'); timeoutSec = 15 }
    )
  }
}
$cfg | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $hooks 'windows-guard.json') -Encoding utf8NoBOM
Get-Content -LiteralPath (Join-Path $hooks 'windows-guard.json')
```

For a team repo, commit `.github\hooks\windows-guard.json` and the scripts under `.github\hooks\scripts\`, and use the `powershell`/`bash` pair instead of `exec`, because `exec` cannot be combined with a no-op for macOS and Linux colleagues and a failing `preToolUse` hook would block their tool calls. Repository hooks load only after you trust the folder, and the CLI also reads hooks from `.claude/settings.json`, where bash-syntax commands are executed by PowerShell on Windows and fail unless wrapped in `bash -c '...'` ([CLI hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference); [copilot-cli#4001](https://github.com/github/copilot-cli/issues/4001)).

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "matcher": "bash|powershell",
        "cwd": ".github/hooks",
        "powershell": "pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/shell-guard.ps1",
        "bash": "true",
        "timeoutSec": 10
      }
    ],
    "postToolUse": [
      {
        "type": "command",
        "matcher": "edit|create|str_replace_editor|apply_patch",
        "cwd": ".github/hooks",
        "powershell": "pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/normalize-eol.ps1",
        "bash": "true",
        "timeoutSec": 15
      }
    ]
  }
}
```

### 6. Instruction files: short, positive, and placed by scope (Low to Medium)

Copilot CLI merges every instruction file it finds (`~/.copilot/copilot-instructions.md`, `~/.copilot/instructions/**/*.instructions.md`, `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) with deduplication of identical content and no precedence order, so machine facts belong in the user-level file and project conventions in the repo file, and the two must not contradict ([Add custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)). GitHub's only length guidance for the CLI is "Keep instructions concise and actionable. Lengthy instructions can dilute effectiveness" ([CLI best practices](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-best-practices)); Anthropic's equivalent guidance targets under 200 lines, asks "Would removing this cause Claude to make mistakes?" of every line, and says to convert anything that must never fail into a hook ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)). The honest expectation: rules about shell syntax are the ones models ignore most (#689, #158885, the Cursor thread), while the rule that routes file content through the edit tool removes the shell from the loop entirely and is the highest-leverage sentence in the file. Edits to these files take effect only in a new or resumed session ([Add custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)).

`%USERPROFILE%\.copilot\copilot-instructions.md` (applies to every repo on this machine):

```markdown
# Windows environment (this machine)

## Shell
- The shell tool is PowerShell 7 (`pwsh`) on Windows 11, started per command with `-NoProfile`. Nothing from `$PROFILE` is loaded, and no state (current directory, variables, aliases) survives between commands.
- Write PowerShell, not bash. Equivalents: `Select-String` (grep), `Select-Object -First N` (head), `Get-Content -Tail N` (tail), `Get-Command` (which), `New-Item -ItemType File` (touch), `$env:NAME = 'value'` (export), `Remove-Item -Recurse -Force` (rm -rf), `Get-ChildItem -Force` (ls -la), `2>$null` (2>/dev/null).
- Chain commands with `;`. `&&` and `||` work in PowerShell 7 only.
- Quote literals with single quotes. Inside double quotes `$x` expands; write a literal quote as `""` or `` `" ``. Backslash is never an escape character.
- Quote every path that contains spaces; use backslashes. Never assign to `$home`.
- `npm`, `npx`, `yarn`, `pnpm` and `gradlew` are `.cmd` shims with legacy argument passing. For arguments containing double quotes, call the underlying `.exe`/`.js` directly or use `cmd /c "..."`.
- Anything longer than one pipeline: create a `.ps1` with the create tool, then run `pwsh -NoProfile -ExecutionPolicy Bypass -File .\script.ps1`. No bash heredocs and no PowerShell here-strings inside shell commands.

## Files
- Create and modify files only with the edit and create tools. Never write file content through `>`, `>>`, `echo`, `Set-Content`, `Out-File`, `Add-Content`, `python -c`, or `sed -i`.
- If a shell write is unavoidable, use `[IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))`.
- Line endings follow the repo's `.gitattributes` (LF unless it says `eol=crlf`). Encoding is UTF-8 without BOM. Keep the file's existing trailing-newline state.
- When an edit fails with "No match found": `view` the exact lines again, shorten `old_str` to a few unique lines, and check for curly quotes or tabs. Do not guess variants and do not fall back to a script.
```

`.github/copilot-instructions.md` or `AGENTS.md` (pick one; identical files are deduplicated, different ones are both loaded):

```markdown
# Project conventions

## Build, test, lint
- Build: `dotnet build`        <!-- replace with this repo's real commands -->
- Test:  `dotnet test`
- Format: `dotnet format`

## Text files
- Line endings and encoding are defined in `.gitattributes` and `.editorconfig`: LF everywhere except `*.bat`/`*.cmd` (CRLF); UTF-8 without BOM.
- Edit files only with the edit/create tools, then run the formatter; do not hand-fix whitespace or line endings with scripts.
```

`.github/instructions/powershell.instructions.md` (loaded only when the agent works on matching files):

```markdown
---
applyTo: "**/*.ps1,**/*.psm1,**/*.psd1"
---
- Target PowerShell 7 unless the script header says it must run under Windows PowerShell 5.1; in that case avoid `&&`, `||`, the ternary operator, `??` and `?.`.
- Every `Out-File`, `Set-Content` and `Add-Content` passes `-Encoding utf8NoBOM`; for 5.1-compatible scripts use `[IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))` instead.
- A script that contains non-ASCII characters and must run under Windows PowerShell 5.1 needs a UTF-8 BOM; every other file is UTF-8 without BOM.
- Start scripts with `Set-StrictMode -Version Latest` and `$ErrorActionPreference = 'Stop'`. Never use `$home` as a variable name.
```

### 7. `settings.json`, `.editorconfig` and pre-commit (mixed confidence)

There is no shell-selection key in `~/.copilot/settings.json`; `powershellFlags` is the only knob that touches the Windows shell tool, and its default is the right value (High that this is the only knob; Low that changing it helps) ([CLI config reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)). Inline `hooks` are an alternative to the hooks file, but inline parsing is strict (one bad entry rejects the whole field), so keep the separate file while iterating ([Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)).

```jsonc
// %USERPROFILE%\.copilot\settings.json   (JSONC; user settings moved here from config.json in 1.0.35)
{
  // Default and recommended. -NoProfile avoids the profile hangs fixed in 0.0.335/1.0.4; the CLI's wrapper
  // already forces UTF-8 console output, so $PROFILE encoding tweaks are unnecessary and would not load anyway.
  "powershellFlags": ["-NoProfile", "-NoLogo"],

  // "debug" while verifying hooks; logs land in %USERPROFILE%\.copilot\logs\
  "logLevel": "default"

  // Alternative to hooks\windows-guard.json. Strict: any malformed entry drops the whole "hooks" field.
  // "hooks": { "preToolUse": [ ... ], "postToolUse": [ ... ] }
}
```

`.editorconfig` does not change a single byte Copilot CLI writes; a search of the tracker for "editorconfig" returns zero results and the tool ignores even `.gitattributes` ([GitHub API search](https://api.github.com/search/issues?q=repo:github/copilot-cli+editorconfig&per_page=30); [copilot-cli#1148](https://github.com/github/copilot-cli/issues/1148)). It is High-value for the editors and formatters that touch the same files (JetBrains, Visual Studio and Vim natively; VS Code via the EditorConfig extension; `dotnet format whitespace`) and Low-value as something the agent reads ([editorconfig.org](https://editorconfig.org/)).

```ini
# .editorconfig
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 4

[*.{bat,cmd}]
end_of_line = crlf

[*.md]
trim_trailing_whitespace = false
```

A pre-commit safety net is High-confidence and was the layer one #1148 reporter relied on ("a pre-commit normalization hook fired every session") ([copilot-cli#1148](https://github.com/github/copilot-cli/issues/1148)). `mixed-line-ending --fix=lf` is incompatible only with the check-in-LF/check-out-CRLF setup (`core.autocrlf=true`), which step 2 avoids ([pre-commit-hooks](https://github.com/pre-commit/pre-commit-hooks)).

```yaml
# .pre-commit-config.yaml   (run `pre-commit autoupdate` to pin the current tag)
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: mixed-line-ending
        args: [--fix=lf]
        exclude: '\.(bat|cmd|sln|vcx?proj)$'
      - id: fix-byte-order-marker
      - id: end-of-file-fixer
      - id: trailing-whitespace
```

### 8. Verify each layer in ten minutes

Verification matters most for the undocumented `toolArgs` path key. Set `$LogAll = $true` in `normalize-eol.ps1`, start `copilot` in a scratch folder, trust it, and ask: "Create a file named eol-test.txt containing three lines: one, two, three." Then read `%USERPROFILE%\.copilot\hooks\normalize-eol.log`. A `RAW {...}` line shows the real payload: find the key that holds `eol-test.txt`, add it to `$PathKeys` (and to the gate script) if it is not already there, confirm whether `toolArgs` arrived as a string or an object (the scripts handle both), and set `$LogAll` back to `$false`. If the log has no line at all, the hook did not fire: run `/env` inside the session, which lists hook counts and source provenance since v1.0.60, and check `%USERPROFILE%\.copilot\logs\` after starting with `copilot --log-level debug`; if the `exec` path never launches, replace it with the full path from `(Get-Command pwsh).Source` ([Command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference); [changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)). Then measure the bytes the same way the #3389 reporter did:

```powershell
function Test-Eol([string]$Path) {
  $b = [IO.File]::ReadAllBytes($Path); $s = [Text.Encoding]::UTF8.GetString($b)
  [pscustomobject]@{
    File = $Path; Bytes = $b.Length
    BOM  = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    CRLF = ([regex]::Matches($s, "`r`n")).Count
    LF   = ([regex]::Matches($s, "(?<!`r)`n")).Count
  }
}
Test-Eol .\eol-test.txt          # expect BOM=False, CRLF=0, LF=3 in an LF repo
git ls-files --eol -- .\eol-test.txt
```

To exercise the guard, ask the agent to "show the first 5 lines of eol-test.txt using head" and confirm the denial reason appears and the retry uses `Select-Object -First 5`; then ask it to run `$PSVersionTable.PSVersion` to confirm the agent's edition is 7.x. For transparency about what is and is not verified: the three scripts were parsed and smoke-tested on 2026-10-22 with synthetic hook payloads on PowerShell 7.6 (a 20-byte BOM+CRLF file became 14 LF-only bytes with the BOM removed, with `toolArgs` supplied both as a JSON string and as an object and with a BOM-prefixed stdin; the guard denied `head`, `> file`, heredocs, `2>/dev/null`, `Set-Content` without encoding and `$home =` while allowing `2>$null`, `2>&1`, `-Encoding utf8NoBOM` writes and `npm run build -- --flag`). What has not been verified against a live Copilot CLI session is the real `toolArgs` key name for the file path and whether the CLI delivers `toolArgs` as a string or an object, which is exactly what the `$LogAll` step above settles. Expect some added latency: each hook spawns a fresh `pwsh` per tool call, and a hook that exceeds its `timeoutSec` is killed and the tool proceeds ([changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)).

## Conclusion

The durable insight from this research is that Copilot CLI on Windows has inverted the usual agent failure mode. Most agents normalize to LF and corrupt CRLF repositories; Copilot CLI's matcher is already CRLF-tolerant, so its damage is done entirely on the write side, in a closed binary that no instruction, attribute or profile setting can reach. That inversion is why the community's usual Windows advice (`.gitattributes`, `.editorconfig`, "tell it to use PowerShell") feels like it does nothing: those controls act on the model or on Git, and the bug lives between them. The hooks system GitHub shipped in 2026 is the first user-controlled layer that sits in exactly that gap, and the `postToolUse` normalizer turns a nine-month-old unfixed bug into a few milliseconds of overhead per edit, while `.gitattributes` and pre-commit remain the backstops that work for every tool and every shell path.

The second insight is about where to spend your prompting budget. GitHub's own engineers concluded models could not be persuaded out of modern-PowerShell and bash habits and chose to change the runtime rather than the prompt; every documented case of a prose rule "fixing" shell behavior across Copilot, Cursor and Claude Code was eventually resolved by a product change or a hook. Write the one instruction that removes the shell from file writes, keep the rest of the file to facts the model cannot guess, and let hooks carry the rules that must hold every time. Watch #1148 and #3389 for a fix, and watch #2271 for a shell-selection setting; until either moves, the configuration above is the complete set of levers a Windows 11 user actually has.
