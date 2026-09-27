param(
  [string]$BaseUrl = "http://127.0.0.1:20128",
  [string]$Model = "llamacpp/local-model"
)

$ErrorActionPreference = "Stop"

$settingsUrl = "$BaseUrl/api/settings/compression"
$analyticsUrl = "$BaseUrl/api/context/grev-caching/analytics?since=all"
$chatUrl = "$BaseUrl/v1/chat/completions"
$originalSettings = Invoke-RestMethod -Uri $settingsUrl -Method Get -TimeoutSec 30
$originalGrev = $originalSettings.grevCaching
if (-not $originalGrev.enabled) {
  throw "GrevCaching must already be enabled for this test."
}

$answer = "ORCHID-58391-VAULT"
$reportRows = 140..1 | ForEach-Object {
  $value = if ($_ -eq 73) { $answer } else { "DECOY-$('{0:D3}' -f $_)-AMBER" }
  "Registry record $($_): The archive key is $value. This line belongs to the historical test report."
}
$prefix = 1..60 | ForEach-Object {
  "Reference note $($_): The service keeps its existing conversation prefix stable between archival rollovers."
}
$currentBlock = @"
Read the field report and return only the archive key associated with registry record 73. Do not explain.
$($reportRows -join "`n")
"@
$messages = @(
  @{ role = "system"; content = "Do not provide reasoning. Return only the exact requested key." },
  @{ role = "user"; content = "Load these stable reference notes:`n$($prefix -join "`n")" },
  @{ role = "assistant"; content = "Reference notes loaded." },
  @{ role = "user"; content = $currentBlock }
)

$cases = @(
  @{ Name = "No selected pass"; Pipeline = @() },
  @{ Name = "Lite"; Pipeline = @("lite") },
  @{ Name = "Caveman"; Pipeline = @("caveman") },
  @{ Name = "Relevance"; Pipeline = @("relevance") },
  @{ Name = "Relevance repeat"; Pipeline = @("relevance") },
  @{ Name = "Aggressive"; Pipeline = @("aggressive") }
)
$results = [System.Collections.Generic.List[object]]::new()

try {
  foreach ($case in $cases) {
    $testGrev = $originalGrev | ConvertTo-Json -Depth 40 | ConvertFrom-Json
    $testGrev.newBlockPipeline = @($case.Pipeline)
    $settingsBody = @{ grevCaching = $testGrev } | ConvertTo-Json -Depth 40
    Invoke-RestMethod -Uri $settingsUrl -Method Put -ContentType "application/json" -Body $settingsBody -TimeoutSec 30 | Out-Null

    $payload = @{
      model = $Model
      messages = @(
        $messages[0..2]
        @{
          role = "user"
          content = "$currentBlock`nTest variation: $($case.Name). Unique marker: $([guid]::NewGuid().ToString('N'))"
        }
      )
      temperature = 0
      max_tokens = 32
      stream = $false
      chat_template_kwargs = @{ enable_thinking = $false }
    } | ConvertTo-Json -Depth 12
    $headers = @{ "x-omniroute-session-id" = "grevcache-pass-comparison" }
    $response = Invoke-RestMethod -Uri $chatUrl -Method Post -ContentType "application/json" -Headers $headers -Body $payload -TimeoutSec 600
    $content = [string]$response.choices[0].message.content
    $analytics = Invoke-RestMethod -Uri $analyticsUrl -Method Get -TimeoutSec 30
    $results.Add([pscustomobject]@{
      Test = $case.Name
      Passes = if ($case.Pipeline.Count) { $case.Pipeline -join "," } else { "none" }
      Answer = $content.Trim()
      RecallPassed = ($content.Trim() -eq $answer)
      PromptTokens = $response.usage.prompt_tokens
      CacheReadTokens = if ($response.usage.prompt_tokens_details) {
        $response.usage.prompt_tokens_details.cached_tokens
      } else {
        $null
      }
      GrevAnalyticsRuns = $analytics.totalRuns
      GrevTokensSaved = $analytics.tokensSaved
    })
  }
} finally {
  $restoreBody = @{ grevCaching = $originalGrev } | ConvertTo-Json -Depth 40
  Invoke-RestMethod -Uri $settingsUrl -Method Put -ContentType "application/json" -Body $restoreBody -TimeoutSec 30 | Out-Null
}

$results | Format-Table -AutoSize | Out-String -Width 220 | Write-Output
if (($results | Where-Object { -not $_.RecallPassed }).Count -gt 0) {
  Write-Warning "One or more current-message passes did not preserve the requested key."
}
