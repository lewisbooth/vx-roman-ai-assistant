$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The script runs against in-memory Docker state. Unknown operations fail closed.
$startScript = Join-Path $PSScriptRoot 'start.ps1'
$latestTag = 'roman-ai-admin:latest'
$rollbackTag = 'roman-ai-admin:rollback'
$previousTag = 'roman-ai-admin:previous'
$runningImage = 'sha256:' + ('a' * 64)
$oldLatest = 'sha256:' + ('b' * 64)
$oldRollback = 'sha256:' + ('c' * 64)
$interruptedImage = 'sha256:' + ('d' * 64)
$nextImage = 'sha256:' + ('e' * 64)
$unrelatedImage = 'sha256:' + ('f' * 64)
$oldContainer = '1' * 64
$newContainer = '2' * 64

function Reset-Fixture {
  $script:fixture = @{
    Tags = @{}
    Images = @($runningImage, $oldLatest, $oldRollback, $interruptedImage, $nextImage, $unrelatedImage)
    Digests = @{}
    OtherContainers = @{}
    Events = [Collections.Generic.List[string]]::new()
    Violations = [Collections.Generic.List[string]]::new()
    Container = $null
    Image = $null
    ReadyImages = @($runningImage, $nextImage, $oldRollback)
    BuildImage = $nextImage
    StartFails = $false
    StartImage = $null
    BuildFails = $false
    ConcurrentTagImage = $null
  }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
  if ($Expected -cne $Actual) {
    throw "$Message Expected [$Expected], received [$Actual]."
  }
}

function Assert-EventOrder([string]$First, [string]$Second) {
  $firstIndex = $fixture.Events.IndexOf($First)
  $secondIndex = $fixture.Events.IndexOf($Second)
  if ($firstIndex -lt 0 -or $secondIndex -le $firstIndex) {
    throw "Expected '$First' before '$Second'."
  }
}

function Set-ExistingDeployment {
  $fixture.Container = $oldContainer
  $fixture.Image = $runningImage
  $fixture.Tags[$latestTag] = $oldLatest
  $fixture.Tags[$rollbackTag] = $oldRollback
}

function Start-Sleep {}

function Reject-Mock([string]$Message) {
  $fixture.Violations.Add($Message)
  throw $Message
}

function docker {
  $global:LASTEXITCODE = 0
  $command = $args -join ' '
  switch -Regex ($command) {
    '^image ls --no-trunc --quiet roman-ai-admin:(latest|rollback|previous)$' {
      if ($fixture.Tags.ContainsKey($args[-1])) { $fixture.Tags[$args[-1]] }
      return
    }
    '^compose ps --all --quiet admin$' {
      if ($fixture.Container) { $fixture.Container }
      return
    }
    '^container inspect --format \{\{\.Image\}\} \{\{\.State\.Status\}\} \{\{\.State\.StartedAt\}\} [0-9]{64}$' {
      if ($args[-1] -ne $fixture.Container) { Reject-Mock "Inspected unknown container: $command" }
      "$($fixture.Image) running 2026-11-20T09:00:00.000Z"
      return
    }
    '^container exec [0-9]{64} node -e ' {
      if ($args[2] -ne $fixture.Container) { Reject-Mock "Probed unknown container: $command" }
      $fixture.Events.Add("probe $($fixture.Image)")
      if ($fixture.Image -in $fixture.ReadyImages) { 'ready' }
      else { $global:LASTEXITCODE = 1 }
      return
    }
    '^image tag sha256:[a-f0-9]{64} (roman-ai-admin:(latest|rollback|previous)|roman-ai-admin-retire:[a-f0-9]{32})$' {
      if ($args[2] -notin $fixture.Images) { Reject-Mock "Tagged unknown image: $command" }
      if ($args[3] -like 'roman-ai-admin-retire:*' -and $args[2] -eq $fixture.ConcurrentTagImage) {
        $fixture.Tags['new-reference:latest'] = $args[2]
      }
      $fixture.Tags[$args[3]] = $args[2]
      $fixture.Events.Add($command)
      return
    }
    '^compose build admin$' {
      $fixture.Events.Add($command)
      if ($fixture.BuildFails) { $global:LASTEXITCODE = 1 }
      else { $fixture.Tags[$latestTag] = $fixture.BuildImage }
      return
    }
    '^compose up -d --no-build --pull never admin$' {
      $fixture.Events.Add($command)
      $image = $fixture.Tags[$latestTag]
      if ($fixture.StartImage) { $image = $fixture.StartImage }
      if ($image -ne $fixture.Image) { $fixture.Container = $newContainer }
      $fixture.Image = $image
      if ($fixture.StartFails) { $global:LASTEXITCODE = 1 }
      return
    }
    '^image inspect --format \{\{len \.RepoTags\}\} \{\{len \.RepoDigests\}\} sha256:[a-f0-9]{64}$' {
      $id = $args[-1]
      if ($id -notin $fixture.Images) {
        $global:LASTEXITCODE = 1
      } else {
        $tagCount = @($fixture.Tags.Values | Where-Object { $_ -eq $id }).Count
        $digestCount = [int]$fixture.Digests[$id]
        "$tagCount $digestCount"
      }
      return
    }
    '^container ls --all --quiet --filter ancestor=sha256:[a-f0-9]{64}$' {
      $id = $args[-1].Substring('ancestor='.Length)
      if ($id -eq $fixture.Image) { $fixture.Container }
      elseif ($fixture.OtherContainers[$id]) { $fixture.OtherContainers[$id] }
      return
    }
    '^image rm --no-prune (roman-ai-admin-retire:[a-f0-9]{32}|roman-ai-admin:(previous|rollback))$' {
      $target = $args[-1]
      $fixture.Events.Add($command)
      if (!$fixture.Tags.ContainsKey($target)) { Reject-Mock "Removed missing tag: $command" }
      $id = $fixture.Tags[$target]
      if ($target -eq $rollbackTag -and $id -ne $fixture.Tags[$latestTag]) {
        Reject-Mock "Removed distinct rollback tag: $command"
      }
      $fixture.Tags.Remove($target)
      if ($id -notin $fixture.Tags.Values -and !$fixture.Digests[$id] -and
          $fixture.Image -ne $id -and !$fixture.OtherContainers[$id]) {
        $fixture.Images = @($fixture.Images | Where-Object { $_ -ne $id })
      }
      return
    }
    default { Reject-Mock "Unexpected mock Docker command: $command" }
  }
}

function Invoke-Start([string]$Option, [switch]$ExpectFailure) {
  $failure = $null
  try {
    if ($Option) {
      $flags = @{$Option = $true}
      & $startScript @flags
    }
    else { & $startScript }
  } catch {
    $failure = $_
  }
  if ($fixture.Violations.Count) { throw ($fixture.Violations -join [Environment]::NewLine) }
  if ($ExpectFailure) {
    if (!$failure) { throw 'Expected startup to fail.' }
  } elseif ($failure) { throw $failure }
}

function Assert-Retired([string]$Image, [bool]$Expected) {
  Assert-Equal $Expected ($Image -notin $fixture.Images) "Unexpected retention for $Image."
}

Reset-Fixture
Set-ExistingDeployment
Invoke-Start
Assert-Equal $nextImage $fixture.Tags[$latestTag] 'The verified replacement must be latest.'
Assert-Equal $nextImage $fixture.Image 'Compose must serve the replacement.'
Assert-Equal $runningImage $fixture.Tags[$rollbackTag] 'Rollback must come from the serving container.'
Assert-Equal $false $fixture.Tags.ContainsKey($previousTag) 'The temporary tag must be cleared after readiness.'
Assert-EventOrder "probe $runningImage" "image tag $runningImage $previousTag"
Assert-EventOrder "image tag $runningImage $previousTag" 'compose build admin'
Assert-EventOrder "probe $nextImage" "image tag $runningImage $rollbackTag"
Assert-Retired $oldLatest $true
Assert-Retired $oldRollback $true
Assert-Retired $unrelatedImage $false

Reset-Fixture
Invoke-Start
Assert-Equal $nextImage $fixture.Tags[$latestTag] 'A first start must create latest.'
Assert-Equal $false $fixture.Tags.ContainsKey($rollbackTag) 'A first start has no prior image.'

Reset-Fixture
Set-ExistingDeployment
$fixture.Tags[$latestTag] = $runningImage
Invoke-Start -Option SkipBuild
Assert-Equal $false $fixture.Events.Contains('compose build admin') 'SkipBuild must reuse latest.'
Assert-Equal $oldRollback $fixture.Tags[$rollbackTag] 'A same-image start must retain the distinct rollback.'

foreach ($failureMode in @('build', 'compose', 'readiness', 'wrongImage')) {
  Reset-Fixture
  Set-ExistingDeployment
  switch ($failureMode) {
    'build' { $fixture.BuildFails = $true }
    'compose' { $fixture.StartFails = $true }
    'readiness' { $fixture.ReadyImages = @($runningImage, $oldRollback) }
    'wrongImage' { $fixture.StartImage = $oldRollback }
  }
  Invoke-Start -ExpectFailure
  Assert-Equal $oldRollback $fixture.Tags[$rollbackTag] "$failureMode must preserve the existing rollback."
  Assert-Equal $runningImage $fixture.Tags[$latestTag] "$failureMode must restore latest to the previously serving image."
  Assert-Equal $false $fixture.Events.Contains("image tag $runningImage $rollbackTag") "$failureMode must not rotate rollback."
  Assert-Retired $runningImage $false
  Assert-Retired $oldRollback $false
  if ($failureMode -in @('compose', 'readiness')) { Assert-Retired $nextImage $false }
}

Reset-Fixture
Set-ExistingDeployment
$fixture.ReadyImages = @($runningImage, $interruptedImage, $oldRollback)
Invoke-Start -ExpectFailure
$fixture.BuildImage = $interruptedImage
Invoke-Start
Assert-Equal $interruptedImage $fixture.Tags[$latestTag] 'A verified retry must become latest.'
Assert-Equal $runningImage $fixture.Tags[$rollbackTag] 'Retry must retain the last verified image across a failed container replacement.'
Assert-Retired $nextImage $true

Reset-Fixture
Set-ExistingDeployment
$fixture.Tags['held-by-another-tool:latest'] = $oldLatest
$fixture.Digests[$oldRollback] = 1
$fixture.Tags[$previousTag] = $interruptedImage
$fixture.OtherContainers[$interruptedImage] = '3' * 64
Invoke-Start
Assert-Retired $oldLatest $false
Assert-Retired $oldRollback $false
Assert-Retired $interruptedImage $false

Reset-Fixture
Set-ExistingDeployment
$fixture.ConcurrentTagImage = $oldLatest
Invoke-Start
Assert-Equal $oldLatest $fixture.Tags['new-reference:latest'] 'A tag added after inspection must survive retirement.'
Assert-Retired $oldLatest $false

Reset-Fixture
Set-ExistingDeployment
$fixture.Tags[$latestTag] = $runningImage
Invoke-Start -Option Rollback
Assert-Equal $oldRollback $fixture.Tags[$latestTag] 'Rollback must start and verify the requested image.'
Assert-Equal $oldRollback $fixture.Image 'Compose must serve the rollback image.'
Assert-Equal $false $fixture.Events.Contains('compose build admin') 'Rollback must reuse the retained image.'
Assert-EventOrder "probe $oldRollback" "image tag $runningImage $rollbackTag"
Assert-Equal $runningImage $fixture.Tags[$rollbackTag] 'A successful rollback must keep the previously serving image.'

Reset-Fixture
$fixture.Tags[$latestTag] = $oldLatest
$fixture.Tags[$rollbackTag] = $oldRollback
Invoke-Start -Option Rollback
Assert-Equal $oldRollback $fixture.Tags[$latestTag] 'Rollback must recover a stopped service from the verified image.'
Assert-Equal $false $fixture.Tags.ContainsKey($rollbackTag) 'The same image must only occupy the active alias.'

Write-Host 'Roman image retention tests passed (12 mocked scenarios).'
