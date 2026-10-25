# windows-guard: postToolUse hook for edit/create/str_replace_editor/apply_patch.
# Copilot CLI's file tools on Windows write CRLF regardless of the file's original ending and
# prepend a UTF-8 BOM (github/copilot-cli#1148, #3389). This hook restores the intended ending
# and removes the BOM within milliseconds of each write.
#
# Target ending, in order:
#   1. .gitattributes eol=lf|crlf for the file (git check-attr); text=unset (-text) skips the file
#   2. core.autocrlf=true  -> crlf (what checkout would produce)
#   3. ending already in the git index for a tracked file (i/lf, i/crlf); i/mixed -> leave as is
#   4. WINDOWS_GUARD_CRLF_EXT list (default: .bat .cmd .sln .vcproj .vcxproj) -> crlf
#   5. WINDOWS_GUARD_DEFAULT_EOL (default: lf)
# A missing final newline is added when WINDOWS_GUARD_FINAL_NEWLINE=1, or, when that variable is unset,
# when the nearest .editorconfig says insert_final_newline = true for the file (0 never adds one).
#
# Fails open: any error exits 0 silently so the tool result is untouched.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$DefaultEol = $env:WINDOWS_GUARD_DEFAULT_EOL
if ($DefaultEol -ne 'crlf') { $DefaultEol = 'lf' }
$CrlfExt = @('.bat', '.cmd', '.sln', '.vcproj', '.vcxproj')
if ($env:WINDOWS_GUARD_CRLF_EXT) { $CrlfExt = @($env:WINDOWS_GUARD_CRLF_EXT -split '[,; ]+' | Where-Object { $_ }) }
$KeepBomExt = @()
if ($env:WINDOWS_GUARD_KEEP_BOM_EXT) { $KeepBomExt = @($env:WINDOWS_GUARD_KEEP_BOM_EXT -split '[,; ]+' | Where-Object { $_ }) }
$MaxBytes = 20MB
$FinalNewline = $null
if ($env:WINDOWS_GUARD_FINAL_NEWLINE -match '^(1|true|yes|on)$') { $FinalNewline = $true }
elseif ($env:WINDOWS_GUARD_FINAL_NEWLINE -match '^(0|false|no|off)$') { $FinalNewline = $false }

function Convert-EditorConfigGlob([string]$Glob) {
    # .editorconfig section glob -> regex: * (not /), ** (anything), ?, [class], {a,b}.
    $sb = New-Object System.Text.StringBuilder
    $i = 0
    $inBrace = $false
    while ($i -lt $Glob.Length) {
        $c = $Glob[$i]
        if ($c -eq '*') {
            if (($i + 1) -lt $Glob.Length -and $Glob[$i + 1] -eq '*') { [void]$sb.Append('.*'); $i += 2; continue }
            [void]$sb.Append('[^/]*')
        }
        elseif ($c -eq '?') { [void]$sb.Append('[^/]') }
        elseif ($c -eq '{') { [void]$sb.Append('('); $inBrace = $true }
        elseif ($c -eq '}') { [void]$sb.Append(')'); $inBrace = $false }
        elseif ($c -eq ',' -and $inBrace) { [void]$sb.Append('|') }
        elseif ($c -eq '[') {
            $j = $Glob.IndexOf(']', $i)
            if ($j -gt $i) { [void]$sb.Append($Glob.Substring($i, $j - $i + 1).Replace('[!', '[^')); $i = $j + 1; continue }
            [void]$sb.Append('\[')
        }
        else { [void]$sb.Append([regex]::Escape([string]$c)) }
        $i++
    }
    return $sb.ToString()
}

function Test-EditorConfigGlob([string]$Glob, [string]$RelativePath) {
    # A glob without a slash matches the file name anywhere below the .editorconfig; with a slash it
    # matches the path relative to that directory (forward slashes).
    $g = $Glob
    $target = $RelativePath
    if ($g.Contains('/')) { if ($g.StartsWith('/')) { $g = $g.Substring(1) } }
    else { $target = Split-Path -Leaf $RelativePath }
    return [regex]::IsMatch($target, '^' + (Convert-EditorConfigGlob $g) + '$')
}

function Get-EditorConfigFinalNewline([string]$FilePath) {
    # $true or $false when a .editorconfig decides insert_final_newline for this file, else $null.
    # Nearer files override farther ones; a file with root = true ends the search.
    $configs = @()
    $d = Split-Path -Parent $FilePath
    while ($d) {
        $cfg = Join-Path $d '.editorconfig'
        if (Test-Path -LiteralPath $cfg -PathType Leaf) {
            $configs += , $cfg
            if ([IO.File]::ReadAllText($cfg) -match '(?im)^\s*root\s*=\s*true\s*$') { break }
        }
        $parent = Split-Path -Parent $d
        if (-not $parent -or $parent -eq $d) { break }
        $d = $parent
    }
    [array]::Reverse($configs)
    $result = $null
    foreach ($cfg in $configs) {
        $base = Split-Path -Parent $cfg
        $rel = ($FilePath.Substring($base.Length).TrimStart('\', '/')) -replace '\\', '/'
        $applies = $false
        $inSection = $false
        foreach ($line in [IO.File]::ReadAllLines($cfg)) {
            $t = $line.Trim()
            if (-not $t -or $t.StartsWith('#') -or $t.StartsWith(';')) { continue }
            if ($t.StartsWith('[') -and $t.EndsWith(']')) { $inSection = $true; $applies = (Test-EditorConfigGlob $t.Substring(1, $t.Length - 2) $rel); continue }
            if (-not $inSection -or -not $applies) { continue }
            if ($t -match '^(?i)insert_final_newline\s*=\s*(\S+)') {
                $v = $Matches[1].ToLowerInvariant()
                if ($v -eq 'true') { $result = $true } elseif ($v -eq 'false') { $result = $false }
            }
        }
    }
    return $result
}

try {
    $hook = Read-HookPayload
    if ($null -eq $hook) { exit 0 }
    $ta = Get-ToolArgs $hook
    if (Test-GuardDebug) { Write-GuardLog ("RAW " + ($hook | ConvertTo-Json -Compress -Depth 6)) }

    $files = @(Get-TargetPaths $hook $ta)
    if ($files.Count -eq 0) {
        $argsJson = ''
        try { $argsJson = [string]($ta | ConvertTo-Json -Compress -Depth 3) } catch { }
        if ($argsJson.Length -gt 400) { $argsJson = $argsJson.Substring(0, 400) + '...' }
        Write-GuardLog "NO PATH KEY toolName=$(Get-ToolName $hook) toolArgs=$argsJson"
        exit 0
    }

    foreach ($full in $files) {
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        $info = Get-Item -LiteralPath $full
        if ($info.Length -eq 0 -or $info.Length -gt $MaxBytes) { continue }
        $bytes = [System.IO.File]::ReadAllBytes($full)
        if ([Array]::IndexOf($bytes, [byte]0) -ge 0) { continue }                       # binary
        $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
        $off = 0
        if ($hasBom) { $off = 3 }
        $text = (New-Object System.Text.UTF8Encoding($false)).GetString($bytes, $off, $bytes.Length - $off)

        # Decide the target ending.
        $dir = Split-Path -Parent $full
        $leaf = Split-Path -Leaf $full
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $eol = $null
        $skip = $false

        # Git is consulted only when the file lives inside a work tree; otherwise a global
        # core.autocrlf=true (the Git for Windows installer default) would leak into every file.
        $wt = Invoke-Git $dir @('rev-parse', '--is-inside-work-tree')
        $inRepo = ($wt.Code -eq 0 -and $wt.Text.Trim() -eq 'true')
        if ($inRepo) {
            $attr = Invoke-Git $dir @('check-attr', 'text', 'eol', '--', $leaf)
            if ($attr.Code -eq 0) {
                if ($attr.Text -match '(?m):\s*text:\s*unset\s*$') { $skip = $true }
                if ($attr.Text -match '(?m):\s*eol:\s*(lf|crlf)\s*$') { $eol = $Matches[1] }
            }
            if (-not $skip -and -not $eol) {
                $ac = Invoke-Git $dir @('config', '--get', 'core.autocrlf')
                if ($ac.Code -eq 0 -and $ac.Text.Trim() -eq 'true') { $eol = 'crlf' }
            }
            if (-not $skip -and -not $eol) {
                $ls = Invoke-Git $dir @('ls-files', '--eol', '--', $leaf)
                if ($ls.Code -eq 0 -and $ls.Text -match 'i/(lf|crlf|mixed)') {
                    if ($Matches[1] -eq 'mixed') { $eol = 'keep' } else { $eol = $Matches[1] }
                }
            }
        }
        if ($skip) { continue }
        if (-not $eol) {
            if ($CrlfExt -contains $ext) { $eol = 'crlf' } else { $eol = $DefaultEol }
        }

        $lfText = ($text -replace "`r`n", "`n") -replace "`r", "`n"
        if ($eol -eq 'crlf') { $out = $lfText -replace "`n", "`r`n" }
        elseif ($eol -eq 'keep') { $out = $text }
        else { $out = $lfText }

        # Optional final newline: the variable wins, else the nearest .editorconfig; unset leaves the end alone.
        $wantFinal = $FinalNewline
        if ($null -eq $wantFinal) { try { $wantFinal = Get-EditorConfigFinalNewline $full } catch { $wantFinal = $null } }
        if ($wantFinal -eq $true -and $out.Length -gt 0 -and -not $out.EndsWith("`n")) {
            if ($eol -eq 'crlf' -or ($eol -eq 'keep' -and $out.Contains("`r`n"))) { $out += "`r`n" } else { $out += "`n" }
        }

        $keepBom = ($hasBom -and ($KeepBomExt -contains $ext))
        $removeBom = ($hasBom -and -not $keepBom)
        if ($out -ne $text -or $removeBom) {
            [System.IO.File]::WriteAllText($full, $out, (New-Object System.Text.UTF8Encoding($keepBom)))
            Write-GuardLog "FIXED $full eol=$eol bomRemoved=$removeBom"
        }
    }
} catch {
    Write-GuardLog "ERROR normalize-eol: $($_.Exception.Message)"
}
exit 0
