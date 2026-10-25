---
name: windows-powershell-quoting
description: Use when running shell commands on Windows (PowerShell) that involve quotes, JSON or other quote-heavy arguments, paths with spaces, npm/npx/yarn arguments, multi-line content, environment variables, or when a command failed with a "not recognized", "missing terminator", "unexpected token" or quoting error. Also use before writing or rewriting a file from the shell.
---

# Windows PowerShell quoting and file-writing guide

The shell tool on Windows is PowerShell 7 (`pwsh`), spawned fresh per command with `-NoProfile`. These rules make commands work the first time and keep files intact.

## Quoting rules

| Need | Write | Notes |
|---|---|---|
| Literal string | `'C:\Program Files\x'` | Nothing expands inside single quotes. |
| Single quote inside a literal | `'it''s'` | Double it. |
| Variable expansion | `"Hello $name"` or `"$($obj.Prop)"` | Use `$()` for anything beyond a plain variable. |
| Double quote inside double quotes | `"He said ""hi"""` or `` "He said `"hi`"" `` | Backslash is **not** an escape. |
| Dollar sign literally in double quotes | `` "`$5" `` | Backtick escapes `$`. |
| Path with spaces | `& 'C:\path with spaces\tool.exe' arg1` | `&` is the call operator. |
| Path with `[` or `]` | `Get-Content -LiteralPath 'file[1].txt'` | Otherwise treated as wildcards. |
| Discard errors | `2>$null` | Not `2>/dev/null`. |
| Merge stderr into stdout | `2>&1` | Fine in both editions. |
| Chain commands | `a; b` | `&&` / `||` need PowerShell 7. |
| Environment variable | `$env:NAME = 'value'; cmd` | Not `NAME=value cmd` or `export`. |
| Line continuation | end the line with a backtick, or break after `|` or `,` | Prefer a `.ps1` file for anything long. |

## Native executables and `.cmd` shims

PowerShell 7.3+ passes embedded double quotes correctly to `.exe` files. It deliberately does **not** for `cmd.exe`, `.bat` and `.cmd` files, and `npm`, `npx`, `yarn`, `pnpm` and `gradlew` are `.cmd` shims. Options, best first:

1. Put the payload in a file with the create tool and pass the file name (`gh pr create --body-file body.md`, `curl --data @payload.json`).
2. Call the underlying program directly: `node "$(npm root -g)\npm\bin\npm-cli.js" ...` or the `.exe` instead of the shim.
3. Hand the whole line to cmd: `cmd /c "npm run build -- --flag=\"value\""`.
4. Stop-parsing token: `npm --% run build -- --flag="value"` (single line only; `%ENV%` still expands).

## Writing files

Use the edit and create tools for file content. They are the only path that is quoting-proof, and the windows-guard hook normalizes their line endings and strips BOMs afterwards.

If a shell write is truly unavoidable (for example capturing command output):

```powershell
<command> | Out-File -Encoding utf8NoBOM -FilePath .\out.txt      # PowerShell 7
[IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))   # 5.1 and 7; writes $text verbatim, no BOM, no added newline
```

Never: `echo x > file` (CRLF; UTF-16LE in 5.1), `Set-Content` without `-Encoding utf8NoBOM` (ANSI in 5.1, always CRLF), `python -c "open(...).write(...)"` (CRLF via universal newlines plus a quoting minefield), `sed -i` (not installed).

## Multi-line or complex commands

Create `script.ps1` with the create tool, then run:

```powershell
pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\script.ps1
```

Here-strings are safe inside a script, and a single-quoted here-string piped to an interpreter's stdin (`@'` ... `'@ | python -`, closing marker at column 0) is the most reliable way to run quote-heavy or multi-line code without writing a file. Never use a here-string to write a file from the shell.

## When an edit fails with "No match found"

1. `view` the exact lines again with a narrow range; the file may have changed since you last read it.
2. Copy `old_str` verbatim, including indentation and trailing spaces. Use 2-4 lines that are unique.
3. Look for lookalikes: curly quotes (U+201C, U+201D, U+2018, U+2019), non-breaking spaces (U+00A0), tabs vs spaces, em dashes. If the span contains curly quotes, pick a nearby span without them.
4. If it matches more than once, add a surrounding line.
5. Do not rewrite the whole file with the create tool. That flips every line ending and loses unrelated content.

## Diagnosing the agent's shell

```powershell
$PSVersionTable.PSVersion          # expect 7.x; 5.1 means pwsh is not on the PATH the CLI sees
$PSNativeCommandArgumentPassing    # Windows (default): Standard for .exe, Legacy for .cmd/.bat
[Console]::OutputEncoding          # the CLI already forces UTF-8
```
