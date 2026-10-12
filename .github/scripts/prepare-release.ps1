param(
    [string] $RepositoryRoot = (Resolve-Path "$PSScriptRoot/../..").Path,
    [string] $SourceCommit = $env:GITHUB_SHA,
    [switch] $FunctionsOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$versionFiles = @('client/src-tauri/tauri.conf.json', 'client/package.json',
    'client/package-lock.json', 'client/src-tauri/Cargo.toml', 'client/src-tauri/Cargo.lock')

function Get-ManifestVersion([string] $Root) {
    $config = Get-Content -LiteralPath (Join-Path $Root $versionFiles[0]) -Raw | ConvertFrom-Json
    $package = Get-Content -LiteralPath (Join-Path $Root $versionFiles[1]) -Raw | ConvertFrom-Json
    $lock = Get-Content -LiteralPath (Join-Path $Root $versionFiles[2]) -Raw | ConvertFrom-Json -AsHashtable
    $cargo = Get-Content -LiteralPath (Join-Path $Root $versionFiles[3]) -Raw
    $cargoLock = Get-Content -LiteralPath (Join-Path $Root $versionFiles[4]) -Raw
    $cargoVersion = [regex]::Match($cargo, '(?ms)^\[package\]\s*(.*?)(?=^\[|\z)')
    $cargoVersion = [regex]::Match($cargoVersion.Groups[1].Value, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
    $lockVersion = [regex]::Match($cargoLock, '(?m)^name = "sayforge"\r?\nversion = "([^"]+)"').Groups[1].Value
    if ($config.version -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'Invalid stable manifest version.' }
    foreach ($other in @($package.version, $lock.version, $lock.packages[''].version, $cargoVersion, $lockVersion)) {
        if ($other -cne $config.version) { throw 'Version mismatch before release preparation.' }
    }
    return $config.version
}

function Get-NextReleaseVersion([string] $Current, [string[]] $ReservedTags) {
    $highest = [version] '0.0.0'
    foreach ($tag in $ReservedTags) {
        if ($tag -cmatch '^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$') {
            $candidate = [version] $Matches[1]
            if ($candidate -gt $highest) { $highest = $candidate }
        }
    }
    # An explicitly prepared higher major/minor/patch version remains authoritative.
    if ([version] $Current -gt $highest) { return $Current }
    return "$($highest.Major).$($highest.Minor).$($highest.Build + 1)"
}

function Set-ManifestVersion([string] $Root, [string] $Version) {
    $patterns = @(
        '(?m)(^  "version":\s*")[^"]+(")',
        '(?ms)(^\[package\]\r?\n(?:(?!^\[).)*?^version\s*=\s*")[^"]+(")',
        '(?m)(^name = "sayforge"\r?\nversion = ")[^"]+(")'
    )
    foreach ($file in $versionFiles) {
        $path = Join-Path $Root $file
        $text = [System.IO.File]::ReadAllText($path)
        $pattern = if ($file.EndsWith('.toml')) { $patterns[1] } elseif ($file.EndsWith('Cargo.lock')) { $patterns[2] } else { $patterns[0] }
        $regex = [regex]::new($pattern)
        if ($regex.Matches($text).Count -ne 1) { throw "Cannot locate a unique version in $file." }
        $text = $regex.Replace($text, [System.Text.RegularExpressions.MatchEvaluator] {
            param($match) $match.Groups[1].Value + $Version + $match.Groups[2].Value
        })
        if ($file.EndsWith('package-lock.json')) {
            $rootPackage = [regex]::new('(?ms)("packages"\s*:\s*\{\s*""\s*:\s*\{.*?"version"\s*:\s*")[^"]+(")')
            if ($rootPackage.Matches($text).Count -ne 1) { throw 'Cannot locate npm root package version.' }
            $text = $rootPackage.Replace($text, [System.Text.RegularExpressions.MatchEvaluator] {
                param($match) $match.Groups[1].Value + $Version + $match.Groups[2].Value
            })
        }
        [System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
    }
    if ((Get-ManifestVersion $Root) -cne $Version) { throw 'Prepared version verification failed.' }
}

function Invoke-ReleaseGit([string[]] $Arguments) {
    $result = & git -C $RepositoryRoot @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Release git command failed: $($Arguments[0])." }
    return $result
}

function Prepare-ReleaseCommit {
    if ($env:GITHUB_REF -cne 'refs/heads/release' -or $SourceCommit -cnotmatch '^[a-f0-9]{40}$') {
        throw 'Release preparation requires the release branch and a full source SHA.'
    }
    if (@(Invoke-ReleaseGit @('status', '--porcelain')).Count) { throw 'Release preparation requires a clean checkout.' }
    $null = Invoke-ReleaseGit @('fetch', 'origin', 'release')
    $remote = Invoke-ReleaseGit @('rev-parse', 'origin/release')
    $prepared = @(Invoke-ReleaseGit @('log', 'origin/release', '--format=%H', '--fixed-strings', "--grep=SayForge-Release-Source: $SourceCommit"))
    if ($prepared.Count -gt 1) { throw 'Multiple prepared commits for the same source.' }
    if ($prepared.Count -eq 1) {
        if ($remote -cne $prepared[0]) { throw 'Release branch advanced beyond the prepared commit.' }
        $parents = Invoke-ReleaseGit @('show', '-s', '--format=%P', $prepared[0])
        if ($parents -cne $SourceCommit) { throw 'Prepared commit has an unexpected parent.' }
        $changed = @(Invoke-ReleaseGit @('diff', '--name-only', $SourceCommit, $prepared[0]))
        if (@($changed | Where-Object { $_ -cnotin $versionFiles }).Count) {
            throw 'Prepared commit contains changes beyond version files.'
        }
        $null = Invoke-ReleaseGit @('checkout', '--detach', $prepared[0])
        $version = Get-ManifestVersion $RepositoryRoot
        Write-Host "Reusing prepared release $version at $($prepared[0])."
        return $prepared[0]
    }

    $head = Invoke-ReleaseGit @('rev-parse', 'HEAD')
    if ($remote -cne $SourceCommit -or $head -cne $SourceCommit) { throw 'Release branch advanced; run the workflow for its current commit.' }
    $current = Get-ManifestVersion $RepositoryRoot
    $tags = & gh api "repos/$env:GITHUB_REPOSITORY/git/matching-refs/tags/v" --paginate --jq '.[].ref'
    if ($LASTEXITCODE -ne 0) { throw 'Could not read reserved release tags.' }
    $releases = & gh api "repos/$env:GITHUB_REPOSITORY/releases" --paginate --jq '.[].tag_name'
    if ($LASTEXITCODE -ne 0) { throw 'Could not read existing releases.' }
    $reserved = @($tags | ForEach-Object { $_ -replace '^refs/tags/', '' }) + @($releases)
    $version = Get-NextReleaseVersion $current $reserved
    Set-ManifestVersion $RepositoryRoot $version
    # Also mark an explicitly prepared version, so retries reuse this commit.
    $null = Invoke-ReleaseGit @('config', 'user.name', 'github-actions[bot]')
    $null = Invoke-ReleaseGit @('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    $null = Invoke-ReleaseGit (@('add', '--') + $versionFiles)
    $null = Invoke-ReleaseGit @('commit', '--allow-empty', '-m', "chore: prepare release $version", '-m', "SayForge-Release-Source: $SourceCommit")
    $commit = Invoke-ReleaseGit @('rev-parse', 'HEAD')
    # Never force-push: a concurrent promotion must fail rather than lose commits.
    $null = Invoke-ReleaseGit @('push', 'origin', 'HEAD:refs/heads/release')
    Write-Host "Prepared release $version at $commit from $SourceCommit."
    return $commit
}

if (-not $FunctionsOnly) {
    $commit = Prepare-ReleaseCommit
    "release_commit=$commit" | Out-File -LiteralPath $env:GITHUB_OUTPUT -Append -Encoding utf8
}
