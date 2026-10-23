# windows-guard

A GitHub Copilot CLI plugin that stops the agent from corrupting files on Windows and coaches it through PowerShell quoting and edit failures.

**Experimental branch preview.** Install this branch's plugin, not the default-branch version:

```powershell
copilot plugin marketplace add jj1985/copilot-windows-guard#experimental
copilot plugin install windows-guard@copilot-windows-guard
```

If a stable copy is already installed, follow the [switching instructions](../../README.md#switching-an-existing-installation) first. PowerShell hooks remain the default. To use the extension engine (verified on CLI 1.0.103):

```powershell
$env:WINDOWS_GUARD_MODE = 'extension'
copilot --experimental
```

Approve the extension and confirm `windows-guard: extension mode active` in the timeline. Prompt mode (`-p`) loads the installed plugin's extension too; `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true` is only needed for repository extensions. Unset `WINDOWS_GUARD_MODE` and restart the session to return to the PowerShell hooks. If the extension is disabled, not approved or fails to load, the launchers find no liveness marker and run the PowerShell scripts anyway.

See the [repository README](../../README.md) for the full description, installation, configuration and the research behind it.

## Contents

| Path | Purpose |
|---|---|
| `plugin.json` | Agent Plugins 1.0 manifest |
| `com.github.copilot/hooks/hooks.json` | The Copilot CLI hooks (sessionStart, preToolUse, postToolUse, postToolUseFailure); every launcher exits at once when `WINDOWS_GUARD_MODE=extension` |
| `com.github.copilot/extensions/windows-guard/extension.mjs` | Experimental Copilot CLI extension: the same behaviors as in-process session hooks, active only with `WINDOWS_GUARD_MODE=extension` |
| `com.github.copilot/extensions/windows-guard/guard.mjs` | The extension's logic, mirroring `scripts/*.ps1`; tested by `tests/extension.test.mjs` |
| `scripts/normalize-eol.ps1` | After each edit/create: restore the intended line ending, remove the UTF-8 BOM |
| `scripts/shell-guard.ps1` | Before each shell command: reads the hook payload and relays the analyzer's decision |
| `scripts/analyze-command.ps1` | The shell-guard rules, decided on PowerShell's AST; dot-sourced by the hook and run by the extension, so both engines agree |
| `scripts/utf8-gate.ps1` | Before each edit: refuse to touch files that are not UTF-8 (the edit tool would destroy them) |
| `scripts/recovery-coach.ps1` | After a failed shell command or edit: inject targeted recovery guidance |
| `scripts/_common.ps1` | Shared helpers (stdin reading, path extraction, logging, git) |
| `com.github.copilot/rules/windows-guard.md` | Always-on instructions for Windows and PowerShell |
| `skills/windows-powershell-quoting/SKILL.md` | On-demand quoting and file-writing reference |

All scripts run under PowerShell 7 and Windows PowerShell 5.1. The extension needs no separate Node.js or SDK installation: Copilot CLI runs this branch's installed extension with its bundled Node.js runtime when experimental features are on.
