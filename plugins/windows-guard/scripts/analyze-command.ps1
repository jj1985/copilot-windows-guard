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
#     directory named by WG_COMMAND_DIR) and the session's working directory in WG_CWD. Prints one
#     JSON object per command:
#       {"decision":"allow"}  or  {"decision":"deny","rule":"<tag>","reason":"<text>"}
#     A denial that depends on the file system (a missing cd target) also carries "cacheable":false.
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
$script:LocationCmds = @('cd', 'chdir', 'sl', 'set-location', 'pushd', 'push-location')
$script:ParserCmds = @('convertfrom-json', 'jq', 'jq.exe', 'convertfrom-csv', 'convertfrom-stringdata')
$script:InlineWriteRe = 'open\s*\([^)]*[''"][wax]b?\+?[''"]|\.write_text\s*\(|\.write_bytes\s*\(|writeFileSync\s*\(|writeFile\s*\(|appendFileSync\s*\('
# .NET types whose path arguments resolve against the process directory, which Set-Location does not change.
$script:DotNetPathTypes = '^(System\.)?IO\.(File|Directory|Path|StreamWriter|StreamReader|FileStream|FileInfo|DirectoryInfo)$'
# Token kinds that continue an argument when glued to a string; separators (; | newline, parentheses) do not.
$script:GluedKinds = @('Generic', 'StringExpandable', 'StringLiteral', 'Identifier', 'Number', 'Variable', 'SplattedVariable')

function New-GuardDeny([string]$Rule, [string]$Reason, [bool]$Cacheable = $true) {
    $d = @{ decision = 'deny'; rule = $Rule; reason = $Reason }
    if (-not $Cacheable) { $d.cacheable = $false }
    return $d
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
        $exact = ($n -ieq $ParameterName)
        if (-not $exact -and ($n.Length -lt 2 -or -not $ParameterName.StartsWith($n, [StringComparison]::OrdinalIgnoreCase))) { continue }
        if ($null -ne $el.Argument) { return (Get-GuardElementText $el.Argument) }
        if (($i + 1) -lt $els.Count -and -not ($els[$i + 1] -is [System.Management.Automation.Language.CommandParameterAst])) { return (Get-GuardElementText $els[$i + 1]) }
        return ''
    }
    return $null
}

function Get-GuardPositionalArgs($Command) {
    # Positional (non-parameter) arguments of a command, in order.
    $out = @()
    $els = @($Command.CommandElements)
    for ($i = 1; $i -lt $els.Count; $i++) {
        $el = $els[$i]
        if ($el -is [System.Management.Automation.Language.CommandParameterAst]) {
            # -Name value consumes the value; -Switch does not. Treat the next element as consumed when the
            # parameter is one of the path parameters of the location cmdlets.
            $n = ([string]$el.ParameterName).ToLowerInvariant()
            if ($null -eq $el.Argument -and ($n -eq 'path' -or $n -eq 'literalpath' -or $n -eq 'p' -or $n -eq 'lp')) { $i++ }
            continue
        }
        $out += , $el
    }
    return $out
}

function Test-GuardRelativePathValue($Ast, $Assignments, [int]$Before) {
    # True when the argument is a relative file-system path: a string constant that is not rooted, an
    # expandable string that is not rooted and does not start from $PWD, or a variable that an earlier
    # statement assigned such a constant.
    if ($null -eq $Ast) { return $false }
    if ($Ast -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        $v = [string]$Ast.Value
        if (-not $v -or $v -match '^[A-Za-z]+:' -or [IO.Path]::IsPathRooted($v)) { return $false }
        return $true
    }
    if ($Ast -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
        $v = [string]$Ast.Value
        if (-not $v -or $v -match '^\$\{?(PWD|pwd|HOME|home|env:)' -or $v -match '^[A-Za-z]+:' -or [IO.Path]::IsPathRooted($v)) { return $false }
        if ($Ast.NestedExpressions.Count -gt 0) { return $false }   # another variable decides the root; stay quiet
        return $true
    }
    if ($Ast -is [System.Management.Automation.Language.VariableExpressionAst]) {
        $name = [string]$Ast.VariablePath.UserPath
        foreach ($a in $Assignments) {
            if ($a.Extent.StartOffset -ge $Before) { continue }
            $left = $a.Left
            if (-not ($left -is [System.Management.Automation.Language.VariableExpressionAst]) -or [string]$left.VariablePath.UserPath -ne $name) { continue }
            $right = $a.Right
            if ($right -is [System.Management.Automation.Language.PipelineAst] -and $right.PipelineElements.Count -eq 1) { $right = $right.PipelineElements[0] }
            if ($right -is [System.Management.Automation.Language.CommandExpressionAst]) { $right = $right.Expression }
            if (Test-GuardRelativePathValue $right $Assignments $a.Extent.StartOffset) { return $true }
        }
        return $false
    }
    return $false
}

function Get-ShellGuardDecision([string]$Command, [string]$Cwd = '') {
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
    $pipelines = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.PipelineAst] }, $true))

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

    # 9. .NET path calls after a location change. Set-Location moves PowerShell's location only; .NET
    #    resolves a relative path against [Environment]::CurrentDirectory, the folder the session started
    #    in, so [IO.File]::Exists('x') after cd reads the wrong place and reports success (bypassable).
    $firstLocationChange = -1
    foreach ($c in $commands) {
        $n = [string]$c.GetCommandName()
        if ($n -and $script:LocationCmds -contains $n.ToLowerInvariant()) {
            if ($firstLocationChange -lt 0 -or $c.Extent.StartOffset -lt $firstLocationChange) { $firstLocationChange = $c.Extent.StartOffset }
        }
    }
    if ($firstLocationChange -ge 0 -and -not $bypass) {
        $invokes = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true))
        foreach ($m in $invokes) {
            if ($m.Extent.StartOffset -lt $firstLocationChange) { continue }
            $typeExpr = $m.Expression
            if (-not ($typeExpr -is [System.Management.Automation.Language.TypeExpressionAst])) { continue }
            $typeName = [string]$typeExpr.TypeName.FullName
            if ($typeName -notmatch $script:DotNetPathTypes) { continue }
            $first = $null
            if ($m.Arguments -and $m.Arguments.Count -gt 0) { $first = $m.Arguments[0] }
            if (Test-GuardRelativePathValue $first $assignments $m.Extent.StartOffset) {
                return New-GuardDeny 'dotnet-relative-path' ".NET calls ignore cd: [$typeName] resolves a relative path against the folder the session started in ([Environment]::CurrentDirectory), not the folder you changed to, so this reads or writes the wrong file and reports success. Use (Resolve-Path 'x').Path, `"`$PWD\x`" or an absolute path. Add  # wg:allow  if this is intentional."
            }
        }
    }

    # 10. A missing cd target as the first statement: the cd fails, the rest of the line runs in the
    #     old folder, and the exit code is 0 (bypassable; not cacheable, the folder may appear later).
    if (-not $bypass -and $ast.EndBlock -and $ast.EndBlock.Statements.Count -gt 1) {
        $firstStmt = $ast.EndBlock.Statements[0]
        $firstCmd = $null
        if ($firstStmt -is [System.Management.Automation.Language.PipelineAst] -and $firstStmt.PipelineElements.Count -eq 1 -and $firstStmt.PipelineElements[0] -is [System.Management.Automation.Language.CommandAst]) {
            $firstCmd = $firstStmt.PipelineElements[0]
        }
        if ($null -ne $firstCmd) {
            $n = [string]$firstCmd.GetCommandName()
            if ($n -and $script:LocationCmds -contains $n.ToLowerInvariant()) {
                $targetAst = $null
                $byParam = Get-GuardParameterValue $firstCmd 'LiteralPath'
                if ($null -eq $byParam) { $byParam = Get-GuardParameterValue $firstCmd 'Path' }
                $target = $null
                if ($null -ne $byParam) { $target = [string]$byParam }
                else {
                    $pos = @(Get-GuardPositionalArgs $firstCmd)
                    if ($pos.Count -gt 0) { $targetAst = $pos[0] }
                    if ($targetAst -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $target = [string]$targetAst.Value }
                }
                if ($target -and $target -notmatch '^[~-]' -and $target -notmatch '^[A-Za-z]+::' -and $target -notmatch '[*?\[]') {
                    $full = $target
                    if (-not [IO.Path]::IsPathRooted($full) -and $Cwd) { $full = Join-Path $Cwd $full }
                    $exists = $true
                    try { $exists = Test-Path -LiteralPath $full -PathType Container } catch { $exists = $true }
                    if (-not $exists) {
                        $where = $Cwd; if (-not $where) { $where = 'the current folder' }
                        return (New-GuardDeny 'missing-cd-target' "The first statement changes directory to '$target', which does not exist under $where, so the cd fails and the rest of the line runs in the old folder with exit code 0. Create or correct the folder first, or use Set-Location '$target' -ErrorAction Stop so a failed cd stops the line. Add  # wg:allow  if this is intentional." $false)
                    }
                }
            }
        }
    }

    # 11. stderr merged into a parser: 2>&1 in a pipeline element that feeds ConvertFrom-Json, jq or
    #     an interpreter reading JSON from stdin, so error text corrupts the input (bypassable).
    if (-not $bypass) {
        foreach ($p in $pipelines) {
            $els = @($p.PipelineElements)
            $mergedAt = -1
            for ($i = 0; $i -lt $els.Count; $i++) {
                $el = $els[$i]
                if ($mergedAt -lt 0 -and $el.Redirections) {
                    foreach ($r in $el.Redirections) {
                        if ($r -is [System.Management.Automation.Language.MergingRedirectionAst]) { $mergedAt = $i; break }
                    }
                    continue
                }
                if ($mergedAt -lt 0) { continue }
                if (-not ($el -is [System.Management.Automation.Language.CommandAst])) { continue }
                $n = ([string]$el.GetCommandName()).ToLowerInvariant()
                $isParser = $script:ParserCmds -contains $n
                if (-not $isParser -and $n -match '^(python3?|py|node)(\.exe)?$') {
                    $code = Get-GuardParameterValue $el 'c'
                    if ($null -eq $code) { $code = Get-GuardParameterValue $el 'e' }
                    if ($code -and $code -match 'json\.loads?\s*\(|JSON\.parse\s*\(') { $isParser = $true }
                }
                if ($isParser) {
                    return New-GuardDeny 'stderr-into-parser' 'This pipes stderr into a parser (2>&1 before ConvertFrom-Json, jq or json.load): error text corrupts the JSON and the parse fails or lies. Use 2>$null (or 2>$errFile) before the pipe and check $LASTEXITCODE before parsing. Add  # wg:allow  if the merge is intentional.'
                }
            }
        }
    }

    # 12. Unix commands in command position (at any depth), unless the executable is actually installed.
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

    # 13. Bash-style escaped quotes. A \" inside a double-quoted string ends the string early, so the
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

    # 14. Anything else the parser rejects: unterminated strings, bash for/[ ] syntax, mismatched braces.
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
    $cwd = [string]$env:WG_CWD
    try {
        if ($env:WG_COMMAND_DIR) {
            $o = @{}
            foreach ($f in Get-ChildItem -LiteralPath $env:WG_COMMAND_DIR -Filter *.txt) {
                $o[$f.BaseName] = Get-ShellGuardDecision ([IO.File]::ReadAllText($f.FullName, $enc)) $cwd
            }
            $o | ConvertTo-Json -Compress -Depth 4
        } elseif ($env:WG_COMMAND_FILE) {
            Get-ShellGuardDecision ([IO.File]::ReadAllText($env:WG_COMMAND_FILE, $enc)) $cwd | ConvertTo-Json -Compress -Depth 4
        }
    } catch {
        # Fail open: no output means allow. The caller logs the exit code.
        [Console]::Error.WriteLine("analyze-command: $($_.Exception.Message)")
        exit 1
    }
    exit 0
}
