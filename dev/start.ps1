#Requires -Version 5.1
[CmdletBinding()]
param([switch]$SkipBuild, [switch]$Rollback)

$ErrorActionPreference = 'Stop'
if ($SkipBuild -and $Rollback) { throw 'Choose either -SkipBuild or -Rollback.' }

function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker failed with exit code ${LASTEXITCODE}: docker $($args -join ' ')" }
}

function Get-ImageId([string]$Tag) {
    $ids = @(Invoke-Docker image ls --no-trunc --quiet $Tag)
    if (!$ids.Count) { return }
    if ($ids.Count -ne 1 -or $ids[0] -cnotmatch '^sha256:[0-9a-f]{64}$') {
        throw "Expected one full image ID for $Tag."
    }
    $ids[0]
}

function Get-AdminContainer {
    $containers = @(Invoke-Docker compose ps --all --quiet admin)
    if (!$containers.Count) { return }
    if ($containers.Count -ne 1) { throw 'Expected one Roman admin container.' }

    $state = Invoke-Docker container inspect --format '{{.Image}} {{.State.Status}} {{.State.StartedAt}}' $containers[0]
    if ($state -cnotmatch '^(sha256:[0-9a-f]{64}) (\w+) (\S+)$') {
        throw 'Could not read the Roman admin container state.'
    }
    [pscustomobject]@{
        Id = $containers[0]
        Image = $Matches[1]
        Status = $Matches[2]
        StartedAt = $Matches[3]
    }
}

function Test-AdminReady($Container) {
    if ($null -eq $Container -or $Container.Status -ne 'running') { return $false }

    # The listener starts after the container entry command applies migrations.
    # Probing inside this container cannot pick up another app on the host port.
    $probe = @'
fetch('http://127.0.0.1:3000/', { redirect: 'error', signal: AbortSignal.timeout(2000) })
  .then(async response => {
    if (response.status === 200 && (await response.text()).includes('Roman AI Assistant')) {
      process.stdout.write('ready');
    }
  }).catch(() => { process.exitCode = 1; });
'@
    try {
        $response = Invoke-Docker container exec $Container.Id node -e $probe
    } catch {
        return $false
    }
    if ($response -ne 'ready') { return $false }

    $current = Get-AdminContainer
    return $null -ne $current -and $current.Id -eq $Container.Id -and $current.Image -eq $Container.Image -and
        $current.Status -eq 'running' -and $current.StartedAt -eq $Container.StartedAt
}

function Remove-UnusedDeploymentImage([string]$ImageId) {
    try {
        $references = Invoke-Docker image inspect --format '{{len .RepoTags}} {{len .RepoDigests}}' $ImageId
        if ($references -ne '0 0') { return }
        if (Invoke-Docker container ls --all --quiet --filter "ancestor=$ImageId") { return }

        # Remove by our own tag so an intervening reference is never removed by ID.
        $retirementTag = 'roman-ai-admin-retire:' + [Guid]::NewGuid().ToString('N')
        Invoke-Docker image tag $ImageId $retirementTag | Out-Host
        Invoke-Docker image rm --no-prune $retirementTag | Out-Host
    } catch {
        Write-Warning "Could not retire Roman image $ImageId. $($_.Exception.Message)"
    }
}

$latestTag = 'roman-ai-admin:latest'
$rollbackTag = 'roman-ai-admin:rollback'
$previousTag = 'roman-ai-admin:previous'
$deploymentLock = [Threading.Mutex]::new($false, 'vx-roman-ai-assistant-local-deployment')
$locked = $false
Push-Location (Join-Path $PSScriptRoot '..')
try {
    try { $locked = $deploymentLock.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw 'Another Roman start is in progress.' }

    $oldLatest = Get-ImageId $latestTag
    $oldRollback = Get-ImageId $rollbackTag
    $oldPrevious = Get-ImageId $previousTag
    if ($Rollback -and !$oldRollback) { throw "No verified image is tagged $rollbackTag." }
    if ($SkipBuild -and !$oldLatest) { throw "No image is tagged $latestTag. Run without -SkipBuild first." }

    $oldAdmin = Get-AdminContainer
    $oldAdminImage = if ($oldAdmin) { $oldAdmin.Image }
    $previous = $oldPrevious
    if (Test-AdminReady $oldAdmin) { $previous = $oldAdmin.Image }
    # Pin the serving image until readiness succeeds, including across an interrupted start.
    if ($previous -and $previous -ne $oldPrevious) { Invoke-Docker image tag $previous $previousTag | Out-Host }

    $candidate = $null
    try {
        if ($Rollback) {
            Invoke-Docker image tag $oldRollback $latestTag | Out-Host
        } elseif (!$SkipBuild) {
            Invoke-Docker compose build admin | Out-Host
        }
        $candidate = Get-ImageId $latestTag
        if (!$candidate) { throw "No candidate image is tagged $latestTag." }
        Invoke-Docker compose up -d --no-build --pull never admin | Out-Host

        for ($attempt = 1; $attempt -le 30; $attempt++) {
            $admin = Get-AdminContainer
            if ($admin -and $admin.Image -eq $candidate -and (Test-AdminReady $admin)) { break }
            if ($attempt -eq 30) {
                throw 'Roman admin did not become ready. See docker compose logs --tail 100 admin.'
            }
            Start-Sleep -Seconds 1
        }
    } catch {
        $restore = if ($previous) { $previous } elseif ($oldRollback) { $oldRollback } else { $oldLatest }
        if ($restore) {
            try {
                if ((Get-ImageId $latestTag) -ne $restore) { Invoke-Docker image tag $restore $latestTag | Out-Host }
                if ($candidate -and $candidate -ne $restore) { Remove-UnusedDeploymentImage $candidate }
                Write-Warning "Start failed. $latestTag points to the prior image. Run ./dev/start.ps1 -SkipBuild to start it."
            } catch {
                Write-Warning "Could not restore $latestTag to $restore. $($_.Exception.Message)"
            }
        }
        throw
    }

    if ($previous -and $previous -ne $candidate) {
        Invoke-Docker image tag $previous $rollbackTag | Out-Host
    } elseif ($oldRollback -eq $candidate) {
        Invoke-Docker image rm --no-prune $rollbackTag | Out-Host
    }
    if ($previous) { Invoke-Docker image rm --no-prune $previousTag | Out-Host }

    $superseded = @($oldLatest, $oldRollback, $oldPrevious, $oldAdminImage) | Where-Object {
        $_ -and $_ -ne $candidate -and $_ -ne $previous
    } | Select-Object -Unique
    foreach ($imageId in $superseded) { Remove-UnusedDeploymentImage $imageId }

    Write-Host "Roman admin is ready on $candidate."
} finally {
    if ($locked) { $deploymentLock.ReleaseMutex() }
    $deploymentLock.Dispose()
    Pop-Location
}
