# Windows environment rules (windows-guard plugin)

These rules apply because this machine runs Windows and the shell tool is PowerShell.

## Shell
- The shell tool is PowerShell (`pwsh`), started fresh for every command with `-NoProfile`. Nothing from `$PROFILE` is loaded, and no state (current directory, variables, aliases) survives between commands.
- Write PowerShell, not bash. Equivalents: `Select-String` (grep), `Select-Object -First N` (head), `Get-Content -Tail N` (tail), `Get-Command` (which), `New-Item -ItemType File` (touch), `$env:NAME = 'value'` (export), `Remove-Item -Recurse -Force` (rm -rf), `Get-ChildItem -Force` (ls -la), `2>$null` (2>/dev/null).
- Chain commands with `;`. `&&` and `||` work in PowerShell 7 only.
- Quote literals with single quotes; double a single quote to embed it (`'it''s'`). Inside double quotes `$x` expands; a literal double quote is `""` or `` `" ``. Backslash is never an escape character.
- Quote every path that contains spaces. Use `-LiteralPath` when a path contains `[` or `]`. Never assign to `$home`.
- `npm`, `npx`, `yarn`, `pnpm` and `gradlew` are `.cmd` shims with legacy argument passing: arguments containing double quotes get mangled. Pass JSON through a file, call the underlying `.exe`/`.js` directly, use `cmd /c "..."`, or the stop-parsing token `--%`.
- Anything longer than one pipeline, or anything quote-heavy or multi-line: create a `.ps1` with the create tool, then run `pwsh -NoProfile -ExecutionPolicy Bypass -File .\script.ps1`. No bash heredocs. A single-quoted here-string piped to an interpreter's stdin (`@'...'@ | python -`) is fine; never use a here-string to write a file.

## Files
- Create and modify files only with the edit and create tools. Never write file content through `>`, `>>`, `echo`, `Set-Content`, `Out-File`, `Add-Content`, `python -c`, `node -e` or `sed -i`.
- If capturing command output to a file is unavoidable: `<command> | Out-File -Encoding utf8NoBOM -FilePath <path>`.
- Line endings follow the repository's `.gitattributes` (LF unless it says `eol=crlf`). Encoding is UTF-8 without BOM. A hook fixes the bytes after each edit, so do not run scripts to "fix" line endings or BOMs yourself.
- When an edit fails with "No match found": view the exact lines again, copy `old_str` verbatim, shorten it to a few unique lines, and check for curly quotes, tabs, or non-breaking spaces. Do not guess variants, and never rewrite the whole file with the create tool to work around a mismatch.
- If a hook denies a command, read the reason: it contains the PowerShell form to use. Retry with that form, not with a different workaround.
