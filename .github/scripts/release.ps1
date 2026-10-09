param(
    [Parameter(Mandatory)]
    [ValidateSet('Preflight', 'Prepare', 'Publish')]
    [string] $Stage,
    [string] $RepositoryRoot = (Resolve-Path "$PSScriptRoot/../..").Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-GitHub([string[]] $Arguments) {
    $result = & gh @Arguments
    if ($LASTEXITCODE -ne 0) { throw "GitHub command failed: $($Arguments[0]) (exit $LASTEXITCODE)." }
    return $result
}

function Read-Json([string] $Path) {
    return Get-Content -LiteralPath (Join-Path $RepositoryRoot $Path) -Raw | ConvertFrom-Json -AsHashtable
}

$config = Read-Json 'client/src-tauri/tauri.conf.json'
$version = $config.version
if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw 'Public Windows releases require a stable major.minor.patch version.'
}
$tag = "v$version"
$package = Read-Json 'client/package.json'
$npmLock = Read-Json 'client/package-lock.json'
$cargo = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'client/src-tauri/Cargo.toml') -Raw
$cargoLock = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'client/src-tauri/Cargo.lock') -Raw
$cargoVersion = [regex]::Match($cargo, '(?ms)^\[package\]\s*(.*?)(?=^\[|\z)')
$cargoVersion = [regex]::Match($cargoVersion.Groups[1].Value, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
$lockVersion = [regex]::Match($cargoLock, '(?m)^name = "sayforge"\r?\nversion = "([^"]+)"').Groups[1].Value
foreach ($otherVersion in @($package.version, $npmLock.version, $npmLock.packages[''].version, $cargoVersion, $lockVersion)) {
    if ($otherVersion -cne $version) { throw "Version mismatch: Tauri=$version, manifest/lock=$otherVersion." }
}

function Test-NewRelease {
    $refs = @(Invoke-GitHub @('api', "repos/$env:GITHUB_REPOSITORY/git/matching-refs/tags/v", '--jq', '.[].ref'))
    if ($refs -ccontains "refs/tags/$tag") {
        Write-Host "Tag $tag already exists; skipping build and publication without changing assets."
        return $false
    }
    $releaseTags = @(Invoke-GitHub @('api', "repos/$env:GITHUB_REPOSITORY/releases", '--paginate', '--jq', '.[].tag_name'))
    if ($releaseTags -ccontains $tag) { throw "Release $tag already exists without its tag; refusing to overwrite it." }
    foreach ($existingTag in @($refs | ForEach-Object { $_ -replace '^refs/tags/', '' }) + $releaseTags) {
        if ($existingTag -cmatch '^v(\d+\.\d+\.\d+)$' -and [version] $version -le [version] $Matches[1]) {
            throw "Version $version must be greater than existing release tag $existingTag."
        }
    }
    return $true
}

function Get-Installers([string[]] $Paths) {
    $files = @($Paths | ForEach-Object { Get-Item -LiteralPath $_ })
    $exe = @($files | Where-Object { $_.Extension -eq '.exe' })
    $msi = @($files | Where-Object { $_.Extension -eq '.msi' })
    if ($exe.Count -ne 1 -or $msi.Count -ne 1) { throw 'Exactly one NSIS .exe and one MSI .msi are required.' }
    $prefix = '^' + [regex]::Escape("$($config.productName)_${version}_x64")
    if ($exe[0].Name -cnotmatch ($prefix + '-setup\.exe$') -or
        $msi[0].Name -cnotmatch ($prefix + '_[^/\\]+\.msi$')) {
        throw 'Installer names must match the release product, version and x64 architecture.'
    }
    foreach ($file in @($exe[0], $msi[0])) {
        if ($file.Length -le 0) { throw "Empty installer: $($file.Name)." }
    }
    return @($exe[0], $msi[0])
}

if ($Stage -eq 'Preflight') {
    $needed = (Test-NewRelease).ToString().ToLowerInvariant()
    "version=$version", "release_needed=$needed" | Out-File -LiteralPath $env:GITHUB_OUTPUT -Append -Encoding utf8
    return
}

$assetsDirectory = Join-Path $RepositoryRoot 'release-assets'
if ($Stage -eq 'Prepare') {
    if ($env:TAURI_APP_VERSION -cne $version) { throw 'Tauri build version differs from the release version.' }
    $installers = @(Get-Installers @(ConvertFrom-Json -InputObject $env:TAURI_ARTIFACT_PATHS))
    New-Item -ItemType Directory -Path $assetsDirectory -ErrorAction Stop | Out-Null
    foreach ($file in $installers) { Copy-Item -LiteralPath $file.FullName -Destination $assetsDirectory }
    foreach ($notice in @('LICENSE', 'THIRD_PARTY_NOTICES.md')) {
        Copy-Item -LiteralPath (Join-Path $RepositoryRoot $notice) -Destination $assetsDirectory
    }
    $checksums = Get-ChildItem -LiteralPath $assetsDirectory -File | Sort-Object Name | ForEach-Object {
        "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
    }
    $checksums | Set-Content -LiteralPath (Join-Path $assetsDirectory 'SHA256SUMS.txt') -Encoding utf8
    return
}

# Recheck the transferred files and remote state before obtaining a new tag.
$assets = @(Get-ChildItem -LiteralPath $assetsDirectory -File)
$null = Get-Installers @($assets | Where-Object { $_.Extension -in @('.exe', '.msi') } | ForEach-Object FullName)
$expectedNames = @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'SHA256SUMS.txt')
if ($assets.Count -ne 5 -or @($expectedNames | Where-Object { $_ -cnotin $assets.Name }).Count -ne 0) {
    throw 'Release must contain both installers, license, third-party notices and checksums.'
}
$checksumLines = @(Get-Content -LiteralPath (Join-Path $assetsDirectory 'SHA256SUMS.txt'))
$expectedChecksums = @($assets | Where-Object Name -ne 'SHA256SUMS.txt' | Sort-Object Name | ForEach-Object {
    "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
})
if ($checksumLines.Count -ne 4 -or @(Compare-Object $expectedChecksums $checksumLines -CaseSensitive).Count -ne 0) {
    throw 'Release asset checksum verification failed.'
}
if ($env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$') { throw 'A full tested commit SHA is required.' }
$checkedOutCommit = & git -C $RepositoryRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $checkedOutCommit -cne $env:GITHUB_SHA) { throw 'Checkout differs from the tested release commit.' }
if (-not (Test-NewRelease)) { return }

$source = "https://github.com/$env:GITHUB_REPOSITORY"
$notes = @"
Windows x64 installers: NSIS (current user) and MSI. Download and install updates manually.

These installers are unsigned; Windows SmartScreen may warn about an unrecognized publisher.

Source and changes: $source/tree/$env:GITHUB_SHA and $source/blob/$env:GITHUB_SHA/CHANGELOG.md
Corresponding source archives: $source/archive/refs/tags/$tag.zip and $source/archive/refs/tags/$tag.tar.gz
AGPL-3.0 and LAME/LGPL-3.0 notices: $source/blob/$env:GITHUB_SHA/THIRD_PARTY_NOTICES.md
See the attached LICENSE, THIRD_PARTY_NOTICES.md and SHA256SUMS.txt.
"@

# POST refuses an existing ref, including a tag created concurrently outside this workflow.
$null = Invoke-GitHub @('api', '--method', 'POST', "repos/$env:GITHUB_REPOSITORY/git/refs",
    '-f', "ref=refs/tags/$tag", '-f', "sha=$env:GITHUB_SHA")
$release = Invoke-GitHub @('api', '--method', 'POST', "repos/$env:GITHUB_REPOSITORY/releases",
    '-f', "tag_name=$tag", '-f', "target_commitish=$env:GITHUB_SHA", '-f', "name=SayForge $tag",
    '-f', "body=$notes", '-F', 'draft=false', '-F', 'prerelease=false') | ConvertFrom-Json

try {
    $null = Invoke-GitHub (@('release', 'upload', $tag, '--repo', $env:GITHUB_REPOSITORY) + @($assets.FullName))
    $published = Invoke-GitHub @('api', "repos/$env:GITHUB_REPOSITORY/releases/$($release.id)") | ConvertFrom-Json
    if ($published.draft -or $published.prerelease -or $published.tag_name -cne $tag -or $published.assets.Count -ne 5) {
        throw 'Published release metadata is incorrect.'
    }
    foreach ($file in $assets) {
        $remote = @($published.assets | Where-Object name -CEQ $file.Name)
        if ($remote.Count -ne 1 -or $remote[0].size -ne $file.Length -or $remote[0].state -ne 'uploaded') {
            throw "Uploaded release asset is missing or incomplete: $($file.Name)."
        }
    }
    $ref = Invoke-GitHub @('api', "repos/$env:GITHUB_REPOSITORY/git/ref/tags/$tag") | ConvertFrom-Json
    if ($ref.object.sha -cne $env:GITHUB_SHA) { throw 'Release tag differs from the tested commit.' }
    Write-Host "Published $($published.html_url) for $env:GITHUB_SHA."
    "Published [$tag]($($published.html_url)) for commit $env:GITHUB_SHA." |
        Out-File -LiteralPath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
} catch {
    # Remove only the release ID this run created. Retain the tag to prevent automatic replay.
    $publicationError = $_
    $null = Invoke-GitHub @('api', '--method', 'DELETE', "repos/$env:GITHUB_REPOSITORY/releases/$($release.id)")
    throw $publicationError
}
