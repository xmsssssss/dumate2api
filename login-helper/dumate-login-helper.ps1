param(
  [Parameter(Mandatory = $true)]
  [string]$AdminUrl,

  [Parameter(Mandatory = $true)]
  [string]$PairingCode,

  [string]$LoginUrl = 'https://login.bce.baidu.com/?redirect=https%3A%2F%2Fconsole.bce.baidu.com%2F'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:helperWs = $null
$script:browserProcess = $null
$script:profileDir = $null
$script:cdpId = 0

function Write-Step {
  param([string]$Message)
  Write-Host "[dumate] $Message" -ForegroundColor Cyan
}

function Get-BrowserPath {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $candidate
    }
  }
  throw 'Chrome or Edge was not found. Install one of them and retry.'
}

function Get-FreeLoopbackPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Wait-DevToolsTarget {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 30
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($script:browserProcess -and $script:browserProcess.HasExited) {
      throw 'The browser exited before its login page became ready.'
    }
    try {
      $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 1
      $target = @($targets) |
        Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl } |
        Select-Object -First 1
      if ($target) {
        return $target
      }
    } catch {
      # Chrome may still be starting.
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'Timed out while waiting for the browser debugging endpoint.'
}

function Connect-DevTools {
  param([string]$WebSocketUrl)
  $script:helperWs = [Net.WebSockets.ClientWebSocket]::new()
  $token = [Threading.CancellationToken]::None
  $script:helperWs.ConnectAsync([Uri]$WebSocketUrl, $token).Wait()
  $null = Invoke-Cdp -Method 'Page.enable' -Params @{}
  $null = Invoke-Cdp -Method 'Network.enable' -Params @{}
}

function Invoke-Cdp {
  param(
    [string]$Method,
    [hashtable]$Params = @{}
  )
  if (-not $script:helperWs -or $script:helperWs.State -ne [Net.WebSockets.WebSocketState]::Open) {
    throw 'The browser debugging connection is not open.'
  }

  $script:cdpId += 1
  $requestId = $script:cdpId
  $payload = @{
    id = $requestId
    method = $Method
    params = $Params
  } | ConvertTo-Json -Compress -Depth 20
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $segment = [ArraySegment[byte]]::new($bytes)
  $token = [Threading.CancellationToken]::None
  $script:helperWs.SendAsync(
    $segment,
    [Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    $token
  ).Wait()

  while ($true) {
    $stream = [IO.MemoryStream]::new()
    try {
      do {
        $buffer = New-Object byte[] 65536
        $receiveSegment = [ArraySegment[byte]]::new($buffer)
        $receiveTask = $script:helperWs.ReceiveAsync($receiveSegment, $token)
        $receiveTask.Wait()
        $result = $receiveTask.Result
        if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
          throw 'The browser closed the debugging connection.'
        }
        $stream.Write($buffer, 0, $result.Count)
      } while (-not $result.EndOfMessage)
      $text = [Text.Encoding]::UTF8.GetString($stream.ToArray())
    } finally {
      $stream.Dispose()
    }

    $message = $text | ConvertFrom-Json
    if ($message.id -ne $requestId) {
      continue
    }
    if ($message.error) {
      throw "Browser command failed: $($message.error.message)"
    }
    return $message.result
  }
}

function Get-AuthCookie {
  $result = Invoke-Cdp -Method 'Network.getAllCookies'
  $unique = @{}
  foreach ($cookie in @($result.cookies)) {
    if ([string]::IsNullOrEmpty($cookie.name) -or [string]::IsNullOrEmpty($cookie.value)) {
      continue
    }
    $domain = ([string]$cookie.domain).Trim().TrimStart('.').ToLowerInvariant()
    if (-not ($domain -eq 'baidu.com' -or $domain.EndsWith('.baidu.com'))) {
      continue
    }
    $path = [string]$cookie.path
    if ([string]::IsNullOrEmpty($path)) {
      $path = '/'
    }
    $key = "$($cookie.name)`0$domain`0$path"
    $unique[$key] = $cookie
  }

  $byName = @{}
  foreach ($cookie in $unique.Values) {
    $current = $byName[$cookie.name]
    if (-not $current) {
      $byName[$cookie.name] = $cookie
      continue
    }
    $domain = ([string]$cookie.domain).Trim().TrimStart('.').ToLowerInvariant()
    $currentDomain = ([string]$current.domain).Trim().TrimStart('.').ToLowerInvariant()
    $path = [string]$cookie.path
    $currentPath = [string]$current.path
    if (
      $domain.Length -gt $currentDomain.Length -or
      ($domain.Length -eq $currentDomain.Length -and $path.Length -gt $currentPath.Length)
    ) {
      $byName[$cookie.name] = $cookie
    }
  }
  $cookie = @($byName.Values | ForEach-Object {
    "$($_.name)=$($_.value)"
  }) -join '; '
  return @{
    cookie = $cookie
    has_bduss = $byName.ContainsKey('BDUSS')
    has_console = $byName.ContainsKey('bce-long-term-sessionid')
  }
}

function Submit-HelperCookie {
  param([string]$Cookie)

  $body = @{
    pairing_code = $PairingCode
    cookie = $Cookie
  } | ConvertTo-Json -Compress -Depth 5

  try {
    return Invoke-RestMethod `
      -Method Post `
      -Uri "$AdminUrl/api/admin/web-accounts/login/helper/submit" `
      -ContentType 'application/json; charset=utf-8' `
      -Headers @{ 'User-Agent' = 'dumate2api-login-helper/1.0' } `
      -Body $body `
      -TimeoutSec 90
  } catch {
    $detail = $_.ErrorDetails.Message
    if (-not $detail -and $_.Exception.Response) {
      try {
        $reader = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        try {
          $detail = $reader.ReadToEnd()
        } finally {
          $reader.Dispose()
        }
      } catch {
        # Fall through to the transport error below.
      }
    }
    if ($detail) {
      try {
        $parsed = $detail | ConvertFrom-Json
        if ($parsed.error) {
          $detail = $parsed.error
        }
      } catch {
        # Keep the raw response when it is not JSON.
      }
    }
    throw "The admin server rejected the login result: $detail"
  }
}

function Stop-Helper {
  if ($script:helperWs -and $script:helperWs.State -eq [Net.WebSockets.WebSocketState]::Open) {
    try {
      $null = Invoke-Cdp -Method 'Browser.close'
    } catch {
      # The browser may close the socket before replying.
    }
    try {
      $script:helperWs.Abort()
      $script:helperWs.Dispose()
    } catch {
      # Best-effort cleanup only.
    }
  }
  $script:helperWs = $null

  if ($script:browserProcess -and -not $script:browserProcess.HasExited) {
    Start-Sleep -Milliseconds 500
    if (-not $script:browserProcess.HasExited) {
      Stop-Process -Id $script:browserProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
  $script:browserProcess = $null

  if ($script:profileDir) {
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $profile = [IO.Path]::GetFullPath($script:profileDir)
    if ($profile.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
          Remove-Item -LiteralPath $profile -Recurse -Force
          break
        } catch {
          Start-Sleep -Milliseconds 500
        }
      }
    }
  }
  $script:profileDir = $null
}

try {
  if ($AdminUrl -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') {
    $AdminUrl = "http://$AdminUrl"
  }
  $adminUri = [Uri]$AdminUrl
  if ($adminUri.Scheme -notin @('http', 'https')) {
    throw 'Admin URL must start with http:// or https://.'
  }
  $AdminUrl = $AdminUrl.TrimEnd('/')
  $PairingCode = $PairingCode.Trim()
  if (-not $PairingCode) {
    throw 'Pairing code is empty.'
  }

  $browser = Get-BrowserPath
  $port = Get-FreeLoopbackPort
  $script:profileDir = Join-Path $env:TEMP (
    "dumate-login-helper-$PID-" + [Guid]::NewGuid().ToString('N')
  )
  New-Item -ItemType Directory -Path $script:profileDir | Out-Null

  Write-Step "Opening $browser"
  $arguments = @(
    "--remote-debugging-port=$port",
    "--user-data-dir=`"$($script:profileDir)`"",
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    $LoginUrl
  ) -join ' '
  $script:browserProcess = Start-Process `
    -FilePath $browser `
    -ArgumentList $arguments `
    -PassThru

  $target = Wait-DevToolsTarget -Port $port
  Connect-DevTools -WebSocketUrl $target.webSocketDebuggerUrl
  Write-Step 'Complete the Baidu login in the browser window.'

  $deadline = (Get-Date).AddMinutes(15)
  $nextSettle = [DateTime]::MinValue
  while ((Get-Date) -lt $deadline) {
    if ($script:browserProcess.HasExited) {
      throw 'The browser window was closed before login completed.'
    }

    $auth = Get-AuthCookie
    if ($auth.has_bduss -and $auth.has_console) {
      Write-Step 'Login detected. Submitting the credential to the admin server.'
      $response = Submit-HelperCookie -Cookie $auth.cookie
      $accountName = ''
      if ($response.account -and $response.account.name) {
        $accountName = [string]$response.account.name
      }
      if ($accountName) {
        Write-Host "[dumate] Account added: $accountName" -ForegroundColor Green
      } else {
        Write-Host '[dumate] Account added successfully.' -ForegroundColor Green
      }
      exit 0
    }

    if ($auth.has_bduss -and -not $auth.has_console -and (Get-Date) -ge $nextSettle) {
      Write-Step 'Login detected. Establishing the Baidu console session...'
      foreach ($url in @(
        'https://console.bce.baidu.com/',
        'https://console.bce.baidu.com/ai/#/app/dumate/overview'
      )) {
        try {
          $null = Invoke-Cdp -Method 'Page.navigate' -Params @{ url = $url }
          Start-Sleep -Seconds 2
        } catch {
          # Keep polling; the cookie may already be present.
        }
      }
      $nextSettle = (Get-Date).AddSeconds(5)
    }

    Start-Sleep -Milliseconds 1200
  }

  throw 'The pairing code expired after 15 minutes. Generate a new code and retry.'
} catch {
  Write-Host "[dumate] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  Stop-Helper
}
