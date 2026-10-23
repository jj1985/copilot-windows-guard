# windows-guard: the shell-guard analyzer, shared by both engines.
#
# Decides whether a shell command may run, from PowerShell's own AST and tokens rather than from
# regexes over the raw text, so a > inside a string or a here-string, the word head inside a quoted
# argument, or a << in a regex no longer trips a rule, while real redirects, real Unix commands and
# real bash escapes still do.
#
# Used two ways:
#   - dot-sourced by shell-guard.ps1 (in-process), which calls Get-ShellGuardDecision;
#   - run by the extension:  pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File analyze-command.ps1
#     with the command text in the UTF-8 file named by WG_COMMAND_FILE (or many <n>.txt files in the
#     directory named by WG_COMMAND_DIR). Prints one JSON object per command:
#       {"decision":"allow"}  or  {"decision":"deny","rule":"<tag>","reason":"<text>"}
#
# Rules marked bypassable are skipped when the command contains the comment  # wg:allow .
# WINDOWS_GUARD_PARSER=off keeps a command that does not parse from being denied for that reason
# alone (the AST rules still run on whatever did parse).
# Compatible with Windows PowerShell 5.1 and PowerShell 7+ (no ternary, no ??, no ::new()).

$script:CheatSheet = 'PowerShell quoting: single quotes are literal (double a single quote to embed it: ''it''''s''); inside double quotes $x expands and a literal double quote is written as two double quotes or backtick-quote; backslash is NOT an escape character. Multi-line or heavily quoted content: create a .ps1 (or a data file) with the create tool and run pwsh -NoProfile -ExecutionPolicy Bypass -File .\script.ps1. File content always goes through the edit/create tool, never through the shell.'

$script:UnixMap = @{
    sed = 'the edit tool (for in-place edits) or -replace'; awk = 'ForEach-Object / -split'; grep = 'Select-String'
    head = 'Select-Object -First N'; tail = 'Get-Content -Tail N'; touch = 'New-Item -ItemType File'
    which = 'Get-Command'; export = '$env:NAME = ''value'''; chmod = 'icacls (usually unnecessary on Windows)'
    ln = 'New-Item -ItemType SymbolicLink'; wc = 'Measure-Object -Line/-Word/-Character'
    xargs = 'ForEach-Object'; find = 'Get-ChildItem -Recurse -Filter'; cut = '-split / Select-Object'
    tr = '-replace'; uniq = 'Sort-Object -Unique'
}
$script:WriteCmdlets = @('Set-Content', 'Add-Content', 'Out-File', 'Tee-Object')
$script:CmdShellNames = @('dir', 'del', 'erase', 'rd', 'rmdir', 'md', 'copy', 'move', 'type', 'ren')
$script:InlineWriteRe = 'open\s*\([^)]*[''"][wax]b?\+?[''"]|\.write_text\s*\(|\.write_bytes\s*\(|writeFileSync\s*\(|writeFile\s*\(|appendFileSync\s*\('
# Token kinds that continue an argument when glued to a string; separators (; | newline, parentheses) do not.
$script:GluedKinds = @('Generic', 'StringExpandable', 'StringLiteral', 'Identifier', 'Number', 'Variable', 'SplattedVariable')

function New-GuardDeny([string]$Rule, [string]$Reason) {
    return @{ decision = 'deny'; rule = $Rule; reason = $Reason }
}

function Get-GuardElementText($Element) {
    # The literal text of a command argument: the string value for constants, the source for anything else.
    if ($null -eq $Element) { return '' }
    if ($Element -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return [string]$Element.Value }
    if ($Element -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) { return [string]$Element.Value }
    return [string]$Element.Extent.Text
}

function Get-GuardParameterValue($Command, [string]$ParameterName) {
    # Value of -<ParameterName> (prefixes of at least two characters accepted, as PowerShell binds them),
    # whether written as -Name value or -Name:value. $null when absent.
    $els = @($Command.CommandElements)
    for ($i = 1; $i -lt $els.Count; $i++) {
        $el = $els[$i]
        if (-not ($el -is [System.Management.Automation.Language.CommandParameterAst])) { continue }
        $n = [string]$el.ParameterName
        if ($n.Length -lt 2 -or -not $ParameterName.StartsWith($n, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($null -ne $el.Argument) { return (Get-GuardElementText $el.Argument) }
        if (($i + 1) -lt $els.Count -and -not ($els[$i + 1] -is [System.Management.Automation.Language.CommandParameterAst])) { return (Get-GuardElementText $els[$i + 1]) }
        return ''
    }
    return $null
}

function Get-ShellGuardDecision([string]$Command) {
    $cmd = $Command
    if (-not $cmd) { return @{ decision = 'allow' } }
    $bypass = ($cmd -match '#\s*wg:allow')
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($cmd, [ref]$tokens, [ref]$errors)
    $errs = @(); if ($errors) { $errs = @($errors) }
    $toks = @(); if ($tokens) { $toks = @($tokens) }

    # 1. Bash input redirection and heredocs. PowerShell reserves the < operator, so a real << or <
    #    outside strings is a parse error; inside strings and here-strings it is content and never gets here.
    foreach ($e in $errs) {
        if ($e.Message -match "operator is reserved for future use") {
            if ($cmd -match '<<') {
                return New-GuardDeny 'heredoc' 'Bash heredocs do not exist in PowerShell. Put file content through the edit/create tool, or create a .ps1 with the create tool and run: pwsh -NoProfile -ExecutionPolicy Bypass -File .\script.ps1'
            }
            return New-GuardDeny 'input-redirect' 'Input redirection with < does not exist in PowerShell. Use Get-Content file | <command>, or pass the file name as an argument.'
        }
    }

    $commands = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true))
    $redirects = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FileRedirectionAst] }, $true))
    $assignments = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true))

    # 2. Redirects to a file. Only real redirection operators count; 2>&1 is a stream merge, not a file.
    foreach ($r in $redirects) {
        $loc = $r.Location
        if ($loc -is [System.Management.Automation.Language.VariableExpressionAst] -and $loc.VariablePath.UserPath -eq 'null') { continue }
        $target = Get-GuardElementText $loc
        if ($target -match '^/dev/null$') {
            return New-GuardDeny 'dev-null' 'Use 2>$null to discard errors; PowerShell treats /dev/null as a file path.'
        }
        if ($bypass) { continue }
        return New-GuardDeny 'redirect' 'Redirecting to a file writes CRLF (and UTF-16LE under Windows PowerShell 5.1). Use the edit/create tool for file content, or <command> | Out-File -Encoding utf8NoBOM -FilePath <path> to capture output. Add  # wg:allow  if this redirect is intentional.'
    }

    foreach ($c in $commands) {
        $name = [string]$c.GetCommandName()
        if (-not $name) { continue }
        $lower = $name.ToLowerInvariant()
        $els = @($c.CommandElements)

        # 3. VAR=value command (bash environment assignment) parses as a command named VAR=value.
        if ($name -match '^[A-Za-z_][A-Za-z0-9_]*=' -and $els.Count -gt 1) {
            return New-GuardDeny 'env-assignment' 'Bash-style environment assignment (VAR=value cmd, export VAR=value) does not work in PowerShell. Use: $env:VAR = ''value''; <command>'
        }

        # 4. echo -e / echo -n (bypassable).
        if ($lower -eq 'echo' -and -not $bypass) {
            foreach ($el in $els) {
                if ($el -is [System.Management.Automation.Language.CommandParameterAst] -and @('e', 'n') -contains $el.ParameterName.ToLowerInvariant()) {
                    return New-GuardDeny 'echo-flags' 'echo is Write-Output in PowerShell and has no -e/-n flags. Use Write-Output ''text'' or Write-Host -NoNewline.'
                }
            }
        }

        # 5. cmd.exe switches on the cmd.exe-style aliases.
        if ($script:CmdShellNames -contains $lower) {
            for ($i = 1; $i -lt $els.Count; $i++) {
                $el = $els[$i]
                if ($el -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $el.StringConstantType -eq 'BareWord' -and $el.Value -match '^/[A-Za-z]([:-]\S*)?$') {
                    return New-GuardDeny 'cmd-switch' 'cmd.exe switches (/s, /q, /f) do not work in PowerShell. Use Get-ChildItem -Recurse, Remove-Item -Recurse -Force, Copy-Item, Move-Item, Get-Content, Rename-Item.'
                }
            }
        }

        # 6. Inline interpreter code: python -c / node -e. Deny file writes (reads pass), multi-line code,
        #    and nothing else; the code itself is a string argument and is never parsed as PowerShell.
        if ($lower -match '^(python3?|py|node)(\.exe)?$' -and -not $bypass) {
            for ($i = 1; $i -lt $els.Count; $i++) {
                $el = $els[$i]
                if (-not ($el -is [System.Management.Automation.Language.CommandParameterAst])) { continue }
                if (@('c', 'e') -notcontains $el.ParameterName.ToLowerInvariant()) { continue }
                $codeAst = $el.Argument
                if ($null -eq $codeAst -and ($i + 1) -lt $els.Count) { $codeAst = $els[$i + 1] }
                if ($null -eq $codeAst) { continue }
                $code = Get-GuardElementText $codeAst
                if ($code -match $script:InlineWriteRe) {
                    return New-GuardDeny 'inline-write' 'Do not write files through an inline python -c / node -e one-liner: quoting fails and the file gets CRLF or the wrong encoding. Use the edit/create tool for the content, or create a script file with the create tool and run it.'
                }
                if ($code -match "`n") {
                    return New-GuardDeny 'multiline-inline-script' 'Multi-line code in python -c / node -e breaks quoting on Windows. Pipe a single-quoted here-string to the interpreter''s stdin instead (@''...''@ | python -  or  | node -), or create a script file with the create tool and run it. Add  # wg:allow  if this one-liner is intentional.'
                }
            }
        }

        # 7. Shell writes without an explicit UTF-8 encoding (bypassable).
        if ($script:WriteCmdlets -contains $name -and -not $bypass) {
            $enc = Get-GuardParameterValue $c 'Encoding'
            if (-not ($enc -and @('utf8NoBOM', 'utf8', 'ascii') -contains $enc)) {
                return New-GuardDeny 'shell-write' 'Shell writes must pass -Encoding utf8NoBOM (and they still write CRLF). File content belongs in the edit/create tool; to capture command output use: <command> | Out-File -Encoding utf8NoBOM -FilePath <path>'
            }
        }
    }

    # 8. Assigning $home points destructive commands at the real profile.
    foreach ($a in $assignments) {
        $left = $a.Left
        if ($left -is [System.Management.Automation.Language.VariableExpressionAst] -and $left.VariablePath.UserPath -eq 'home') {
            return New-GuardDeny 'home-assignment' '$home is PowerShell''s HOME variable; assigning it can point destructive commands at the real profile. Use another variable name.'
        }
    }

    # 9. Unix commands in command position (at any depth), unless the executable is actually installed.
    foreach ($c in $commands) {
        $name = [string]$c.GetCommandName()
        if (-not $name) { continue }
        $lower = $name.ToLowerInvariant()
        if (-not $script:UnixMap.ContainsKey($lower)) { continue }
        $app = $null
        try { $app = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { }
        # Windows ships its own find.exe in System32; it is not GNU find.
        if ($app -and -not ($lower -eq 'find' -and $app.Source -match '[\\/]System32[\\/]')) { continue }
        if ($bypass) { continue }
        return New-GuardDeny 'unix-command' "'$name' is a Unix command and is not installed in this PowerShell session. Use $($script:UnixMap[$lower]). For in-place file edits use the edit tool, not sed. Add  # wg:allow  if you have confirmed the tool exists."
    }

    # 10. Bash-style escaped quotes. A \" inside a double-quoted string ends the string early, so the
    #     real sign is a double-quoted token that ends in \" with another token glued right after it
    #     (or a bare token ending in \ glued before it). A path that merely ends in a backslash,
    #     "C:\dir\", has nothing glued to it and passes. Single-quoted strings are literal and pass.
    if (-not $bypass) {
        for ($i = 0; $i -lt $toks.Count; $i++) {
            $t = $toks[$i]
            if ($t.Kind -ne [System.Management.Automation.Language.TokenKind]::StringExpandable) { continue }
            $glued = $false
            if ($t.Text.EndsWith('\"') -and ($i + 1) -lt $toks.Count -and $toks[$i + 1].Extent.StartOffset -eq $t.Extent.EndOffset -and $script:GluedKinds -contains $toks[$i + 1].Kind.ToString()) { $glued = $true }
            if ($i -gt 0 -and $toks[$i - 1].Kind -eq [System.Management.Automation.Language.TokenKind]::Generic -and $toks[$i - 1].Text.EndsWith('\') -and $toks[$i - 1].Extent.EndOffset -eq $t.Extent.StartOffset) { $glued = $true }
            if ($glued) {
                return New-GuardDeny 'bash-escaped-quote' ('\" is not an escape sequence in PowerShell. ' + $script:CheatSheet + ' For JSON or other quote-heavy arguments to native tools, write the payload to a file with the create tool and pass the file name (for example --body-file or --input).')
            }
        }
    }

    # 11. Anything else the parser rejects: unterminated strings, bash for/[ ] syntax, mismatched braces.
    if ($errs.Count -gt 0 -and $env:WINDOWS_GUARD_PARSER -ne 'off') {
        $msgs = @($errs | Select-Object -First 3 | ForEach-Object { $_.Message.Trim() }) -join ' | '
        return New-GuardDeny 'parser' "PowerShell cannot parse this command: $msgs. $script:CheatSheet"
    }

    return @{ decision = 'allow' }
}

# Script mode (the extension): read the command(s) from files and print JSON.
if ($MyInvocation.InvocationName -ne '.') {
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
    $enc = New-Object System.Text.UTF8Encoding($false)
    try {
        if ($env:WG_COMMAND_DIR) {
            $o = @{}
            foreach ($f in Get-ChildItem -LiteralPath $env:WG_COMMAND_DIR -Filter *.txt) {
                $o[$f.BaseName] = Get-ShellGuardDecision ([IO.File]::ReadAllText($f.FullName, $enc))
            }
            $o | ConvertTo-Json -Compress -Depth 4
        } elseif ($env:WG_COMMAND_FILE) {
            Get-ShellGuardDecision ([IO.File]::ReadAllText($env:WG_COMMAND_FILE, $enc)) | ConvertTo-Json -Compress -Depth 4
        }
    } catch {
        # Fail open: no output means allow. The caller logs the exit code.
        [Console]::Error.WriteLine("analyze-command: $($_.Exception.Message)")
        exit 1
    }
    exit 0
}
