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
    if ($files.Count -ne 1 -or $files[0].Extension -cne '.exe') { throw 'Exactly one NSIS .exe installer is required; additional installers are not allowed.' }
    $prefix = '^' + [regex]::Escape("$($config.productName)_${version}_x64")
    if ($files[0].Name -cnotmatch ($prefix + '-setup\.exe$')) {
        throw 'Installer name must match the release product, version and x64 architecture.'
    }
    if ($files[0].Length -le 0) { throw "Empty installer: $($files[0].Name)." }
    return @($files[0])
}

function Assert-UpdaterSignature([System.IO.FileInfo] $Installer, [string] $SignaturePath) {
    $verifier = $env:SAYFORGE_UPDATER_VERIFIER
    if ([string]::IsNullOrWhiteSpace($verifier) -or -not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
        throw 'Updater signature verifier executable is missing.'
    }
    # The verifier uses the same Minisign algorithm as tauri-plugin-updater and
    # reads the trusted key directly from the checked-out Tauri configuration.
    & $verifier $Installer.FullName $SignaturePath (Join-Path $RepositoryRoot 'client/src-tauri/tauri.conf.json')
    if ($LASTEXITCODE -ne 0) { throw 'Updater cryptographic signature verification failed.' }
}

function Assert-UpdaterAssets([System.IO.FileInfo] $Installer, [string] $Directory) {
    $signaturePath = Join-Path $Directory "$($Installer.Name).sig"
    if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) { throw 'Updater signature missing.' }
    $signature = (Get-Content -LiteralPath $signaturePath -Raw -Encoding utf8).Trim()
    if ($signature.Length -lt 200) { throw 'Updater signature is incomplete.' }
    try { $null = [Convert]::FromBase64String($signature) }
    catch { throw 'Updater signature is not valid Base64.' }

    $manifestPath = Join-Path $Directory 'latest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Updater latest.json missing.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
    $platform = $manifest.platforms['windows-x86_64']
    $expectedUrl = "https://github.com/$env:GITHUB_REPOSITORY/releases/download/$tag/$($Installer.Name)"
    if ($manifest.version -cne $version -or $manifest.platforms.Count -ne 1 -or
        $platform.url -cne $expectedUrl -or $platform.signature -cne $signature) {
        throw 'Updater manifest does not match the signed installer, version, platform and release URL.'
    }
    $date = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($manifest.pub_date, [ref] $date)) {
        throw 'Updater manifest publication date is invalid.'
    }
    Assert-UpdaterSignature $Installer $signaturePath
}

if ($Stage -eq 'Preflight') {
    $needed = (Test-NewRelease).ToString().ToLowerInvariant()
    "version=$version", "release_needed=$needed" | Out-File -LiteralPath $env:GITHUB_OUTPUT -Append -Encoding utf8
    return
}

$assetsDirectory = Join-Path $RepositoryRoot 'release-assets'
if ($Stage -eq 'Prepare') {
    if ($env:TAURI_APP_VERSION -cne $version) { throw 'Tauri build version differs from the release version.' }
    $artifactPaths = @(ConvertFrom-Json -InputObject $env:TAURI_ARTIFACT_PATHS)
    $installers = @(Get-Installers @($artifactPaths | Where-Object { $_ -notlike '*.sig' }))
    $signatureSource = "$($installers[0].FullName).sig"
    if (-not (Test-Path -LiteralPath $signatureSource -PathType Leaf)) { throw 'Updater signature missing.' }
    $unexpected = @($artifactPaths | Where-Object {
        $fullPath = (Get-Item -LiteralPath $_).FullName
        $fullPath -cne $installers[0].FullName -and $fullPath -cne (Get-Item -LiteralPath $signatureSource).FullName
    })
    if ($unexpected.Count -ne 0) { throw 'Unexpected Tauri build artifact paths.' }
    # Reject a valid signature made by the wrong key before staging any assets.
    Assert-UpdaterSignature $installers[0] $signatureSource
    New-Item -ItemType Directory -Path $assetsDirectory -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $installers[0].FullName, $signatureSource -Destination $assetsDirectory
    foreach ($notice in @('LICENSE', 'THIRD_PARTY_NOTICES.md')) {
        Copy-Item -LiteralPath (Join-Path $RepositoryRoot $notice) -Destination $assetsDirectory
    }
    $manifest = @{
        version = $version
        notes = "See the GitHub release changelog for SayForge $tag."
        pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        platforms = @{
            'windows-x86_64' = @{
                url = "https://github.com/$env:GITHUB_REPOSITORY/releases/download/$tag/$($installers[0].Name)"
                signature = (Get-Content -LiteralPath $signatureSource -Raw -Encoding utf8).Trim()
            }
        }
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $assetsDirectory 'latest.json') -Encoding utf8
    Assert-UpdaterAssets (Get-Item -LiteralPath (Join-Path $assetsDirectory $installers[0].Name)) $assetsDirectory
    $checksums = Get-ChildItem -LiteralPath $assetsDirectory -File | Sort-Object Name | ForEach-Object {
        "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
    }
    $checksums | Set-Content -LiteralPath (Join-Path $assetsDirectory 'SHA256SUMS.txt') -Encoding utf8
    return
}

# Recheck the transferred files and remote state before obtaining a new tag.
$assets = @(Get-ChildItem -LiteralPath $assetsDirectory -File)
$installer = @(Get-Installers @($assets | Where-Object { $_.Extension -in @('.exe', '.msi') } | ForEach-Object FullName))[0]
$expectedNames = @($installer.Name, "$($installer.Name).sig", 'latest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SHA256SUMS.txt')
if ($assets.Count -ne $expectedNames.Count -or @($expectedNames | Where-Object { $_ -cnotin $assets.Name }).Count -ne 0) {
    throw 'Release must contain the signed NSIS installer, updater JSON, license, notices and checksums.'
}
Assert-UpdaterAssets $installer $assetsDirectory
$checksumLines = @(Get-Content -LiteralPath (Join-Path $assetsDirectory 'SHA256SUMS.txt'))
$expectedChecksums = @($assets | Where-Object Name -ne 'SHA256SUMS.txt' | Sort-Object Name | ForEach-Object {
    "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
})
if ($checksumLines.Count -ne 5 -or @(Compare-Object $expectedChecksums $checksumLines -CaseSensitive).Count -ne 0) {
    throw 'Release asset checksum verification failed.'
}
if ($env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$') { throw 'A full tested commit SHA is required.' }
$checkedOutCommit = & git -C $RepositoryRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $checkedOutCommit -cne $env:GITHUB_SHA) { throw 'Checkout differs from the tested release commit.' }
if (-not (Test-NewRelease)) { return }

$source = "https://github.com/$env:GITHUB_REPOSITORY"
$notes = @"
Windows x64 signed-updater-compatible NSIS installer: choose installation for the current user or all users.
The installer requests administrator access, including for current-user installation.
In-app updates are optional and cryptographically verified. Previous manual-only versions must be updated once with the installer. Settings and history remain separate for each user.

This installer is unsigned; Windows SmartScreen may warn about an unrecognized publisher.

Source and changes: $source/tree/$env:GITHUB_SHA and $source/blob/$env:GITHUB_SHA/CHANGELOG.md
Corresponding source archives: $source/archive/refs/tags/$tag.zip and $source/archive/refs/tags/$tag.tar.gz
AGPL-3.0 and LAME/LGPL-3.0 notices: $source/blob/$env:GITHUB_SHA/THIRD_PARTY_NOTICES.md
See the attached LICENSE, THIRD_PARTY_NOTICES.md, latest.json, .sig and SHA256SUMS.txt.
"@

# POST refuses an existing ref, including a tag created concurrently outside this workflow.
$null = Invoke-GitHub @('api', '--method', 'POST', "repos/$env:GITHUB_REPOSITORY/git/refs",
    '-f', "ref=refs/tags/$tag", '-f', "sha=$env:GITHUB_SHA")
$release = Invoke-GitHub @('api', '--method', 'POST', "repos/$env:GITHUB_REPOSITORY/releases",
    '-f', "tag_name=$tag", '-f', "target_commitish=$env:GITHUB_SHA", '-f', "name=SayForge $tag",
    '-f', "body=$notes", '-F', 'draft=false', '-F', 'prerelease=false') | ConvertFrom-Json

try {
    # The manifest is deliberately published last: never advertise an update before its binary and signature.
    $signedAssets = @($assets | Where-Object Name -ne 'latest.json')
    $null = Invoke-GitHub (@('release', 'upload', $tag, '--repo', $env:GITHUB_REPOSITORY) + @($signedAssets.FullName))
    $null = Invoke-GitHub @('release', 'upload', $tag, '--repo', $env:GITHUB_REPOSITORY, (Join-Path $assetsDirectory 'latest.json'))
    $published = Invoke-GitHub @('api', "repos/$env:GITHUB_REPOSITORY/releases/$($release.id)") | ConvertFrom-Json
    if ($published.draft -or $published.prerelease -or $published.tag_name -cne $tag -or $published.assets.Count -ne 6) {
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
