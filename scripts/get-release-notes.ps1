# Extracts one version's section from CHANGELOG.md for use as release notes
# (GitHub release body + the app's update dialog via latest.json "notes").
# Category headers ("### 추가") become "[추가]" lines because the update
# dialog is a native message box that shows markdown as-is.
# Prints nothing when the file or the section is missing — release.yml then
# falls back to listing commit subjects, so a forgotten changelog never
# blocks a release.
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$ChangelogPath = (Join-Path $PSScriptRoot "..\CHANGELOG.md")
)

if (-not (Test-Path $ChangelogPath)) { exit 0 }

$lines = Get-Content $ChangelogPath -Encoding utf8
$escaped = [regex]::Escape($Version)
$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^## \[$escaped\]") { $start = $i + 1; break }
}
if ($start -lt 0) { exit 0 }

$section = New-Object System.Collections.Generic.List[string]
for ($i = $start; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^## ') { break }
    $section.Add(($lines[$i] -replace '^### (.+)$', '[$1]'))
}

($section -join "`n").Trim()
