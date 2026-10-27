# ZFontManager CorelDRAW COM companion host.
# Long-lived PowerShell process: attaches to CorelDRAW once and keeps the
# connection, so the expensive first-touch of the CorelDRAW automation object
# graph (measured ~4s upfront: app 0.9s, selection 1.0s, Story 1.7s, Font 0.9s)
# is paid once at warm-up instead of on every font apply.
#
# Protocol (one command per line on stdin, one reply per line on stdout):
#   in : WARM
#   out: '#ZFM#' + base64utf8('warm:<ok|not-running|launch-timeout>')
#   in : APPLY <base64 utf8 json {"label":..,"fonts":[..]}>
#   out: '#ZFM#' + base64utf8('<result token>')
#   in : RELEASE          (drop the COM reference, keep this process alive)
#   in : QUIT
# Any stdout line without the '#ZFM#' prefix must be ignored by the caller.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$PREFIX = '#ZFM#'

function Send([string]$text) {
  $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
  [Console]::Out.WriteLine($PREFIX + $b)
  [Console]::Out.Flush()
}

$script:app = $null

$script:ids = @(
  'CorelDRAW.Application',
  'CorelDRAW.Application.26',
  'CorelDRAW.Application.25',
  'CorelDRAW.Application.24',
  'CorelDRAW.Application.23',
  'CorelDRAW.Application.22',
  'CorelDRAW.Application.21',
  'CorelDRAW.Application.20',
  'CorelDRAW.Application.19',
  'CorelDRAW.Application.18',
  'CorelDRAW.Application.17'
)

# Read the COM server exe path behind a ProgID (LocalServer32 is
# "C:\...\CorelDRW.exe" /Automation). Null when the ProgID is not registered.
function Get-ProgIDExe([string]$id) {
  try {
    $t = [Type]::GetTypeFromProgID($id)
    if (-not $t) { return $null }
    $key = 'Registry::HKEY_CLASSES_ROOT\CLSID\' + $t.GUID.ToString('B') + '\LocalServer32'
    $v = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).'(default)'
    if (-not $v) { return $null }
    if ($v -match '^"([^"]+)"') { return $Matches[1] }
    return ($v -split '\s+')[0]
  } catch { return $null }
}

# Attach to the running CorelDRAW. Returns 'ok' / 'not-running' / 'launch-timeout'.
# Never launches CorelDRAW on its own.
function Attach() {
  if ($script:app) {
    try { $null = $script:app.Version; return 'ok' } catch { $script:app = $null }
  }

  $procs = @(Get-Process -Name 'CorelDRW' -ErrorAction SilentlyContinue | Where-Object { $_.Path })
  if ($procs.Count -eq 0) { return 'not-running' }

  $app = $null
  # Prefer the ProgID whose registered exe is the exe that is actually running,
  # so multiple installed versions do not cross-talk.
  foreach ($id in $script:ids) {
    if ($app) { break }
    $exe = Get-ProgIDExe $id
    if (-not $exe) { continue }
    foreach ($p in $procs) {
      if ($exe -ieq $p.Path) {
        try { $app = [Activator]::CreateInstance([Type]::GetTypeFromProgID($id)) } catch { $app = $null }
        break
      }
    }
  }
  # Fallback: process path unavailable (permissions) or portable install whose
  # registry entry points elsewhere -> probe ProgIDs in order.
  if (-not $app) {
    foreach ($id in $script:ids) {
      if ($app) { break }
      try { $app = [Activator]::CreateInstance([Type]::GetTypeFromProgID($id)) } catch { $app = $null }
    }
  }
  if (-not $app) { return 'not-running' }

  # A live process does not mean automation is up yet; poll Version until it answers.
  # Always sleep between probes -- probing in a tight loop burns a core for nothing.
  $ready = $false
  $until = [DateTime]::Now.AddSeconds(20)
  while (-not $ready -and [DateTime]::Now -lt $until) {
    try { if ($app.Version) { $ready = $true } } catch { }
    if (-not $ready) { Start-Sleep -Milliseconds 120 }
  }
  if (-not $ready) { return 'launch-timeout' }

  try { $app.Visible = $true } catch {}
  $script:app = $app
  return 'ok'
}

# 预热：Attach 之后再把「首次访问对象图」的开销吃掉。
# 实测同一个进程里 ActiveDocument 首次 0.9s、ActiveSelectionRange 首次 1.0s、
# shape.Text.Story 首次 1.7s、story.Font 首次 0.9s，第二次全部降到几十毫秒。
# 只读不写：不碰文档内容，也不新建对象。
function WarmUp() {
  $status = Attach
  if ($status -ne 'ok') { return $status }

  $app = $script:app
  $doc = $null
  try { $doc = $app.ActiveDocument } catch { $doc = $null }
  if (-not $doc) { return 'ok' }

  $shape = $null
  try {
    $sr = $app.ActiveSelectionRange
    if ($sr -and $sr.Shapes -and $sr.Shapes.Count -gt 0) { $shape = $sr.Shapes.Item(1) }
  } catch { }
  if (-not $shape) { try { $shape = $app.ActiveShape } catch { } }
  if ($shape) {
    try {
      $st = $shape.Text.Story
      if ($st) { $null = [string]$st.Font }
    } catch { }
  }
  return 'ok'
}

# 'no-text' (not a text shape) / 'ok' / 'fail' (text, but no candidate accepted)
function Set-CorelFont($shape, $cands) {
  $story = $null
  try { $story = $shape.Text.Story } catch { $story = $null }
  if (-not $story) { return 'no-text' }
  foreach ($n in $cands) {
    try {
      $story.Font = $n
      Start-Sleep -Milliseconds 10
      if ([string]$story.Font -eq $n) { return 'ok' }
    } catch { }
  }
  return 'fail'
}

# Distinguish "CorelDRAW does not know this font" from "it knows it but silently
# refused it" (most common: a Latin-only font applied to pure CJK text -- CDR
# routes CJK runs to the Asian font slot and ignores anything without CJK glyphs).
function Get-FailCode($app, $names) {
  try {
    $want = @{}
    foreach ($n in $names) { $want[[string]$n] = $true }
    foreach ($f in $app.FontList) {
      if ($want.ContainsKey([string]$f)) { return 'font-rejected' }
    }
  } catch { }
  return 'font-not-found'
}

function Invoke-Apply($payload) {
  $status = Attach
  if ($status -ne 'ok') { return $status }

  $app = $script:app
  $names = @()
  foreach ($n in @($payload.fonts)) { if ($n) { $names += [string]$n } }
  if ($names.Count -eq 0) { return 'ps-error:no-font' }
  $label = [string]$payload.label

  $doc = $null
  try { $doc = $app.ActiveDocument } catch { $doc = $null }
  if (-not $doc) { try { $doc = $app.CreateDocument() } catch { $doc = $null } }
  if (-not $doc) { return 'no-document' }

  $shapes = @()
  try {
    $sr = $app.ActiveSelectionRange
    if ($sr -and $sr.Shapes -and $sr.Shapes.Count -gt 0) {
      foreach ($s in $sr.Shapes) { $shapes += $s }
    }
  } catch { }
  if ($shapes.Count -eq 0) {
    try { $one = $app.ActiveShape; if ($one) { $shapes += $one } } catch { }
  }

  $applied = 0
  $unknown = $false
  foreach ($s in $shapes) {
    $r = Set-CorelFont $s $names
    if ($r -eq 'ok') { $applied = $applied + 1 }
    elseif ($r -eq 'fail') { $unknown = $true }
  }
  if ($applied -gt 0) { return ('applied:' + $applied) }
  if ($unknown) { return (Get-FailCode $app $names) }

  # Nothing selected: drop a fresh artistic text on the page and set the font there.
  # Coordinates are document units (inches, origin bottom-left): left, upper area.
  $layer = $null
  try { $layer = $doc.ActiveLayer } catch { $layer = $null }
  if (-not $layer) { return 'apply-failed' }

  $x = 1; $y = 5
  try { $x = [double]$doc.ActivePage.SizeWidth * 0.1 } catch { $x = 1 }
  try { $y = [double]$doc.ActivePage.SizeHeight * 0.6 } catch { $y = 5 }
  if ($y -le 0) { $y = 5 }

  $made = $null
  try { $made = $layer.CreateArtisticText([double]$x, [double]$y, $label) } catch { $made = $null }
  if ($made -and (Set-CorelFont $made $names) -eq 'ok') {
    try { $made.Text.Story.Size = 48 } catch {}
    try { $made.CreateSelection() } catch {}
    return 'created'
  }
  if ($made) { try { $made.Delete() } catch {} }
  return (Get-FailCode $app $names)
}

Send 'ready'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  if ($line -eq 'QUIT') { Send 'bye'; break }

  if ($line -eq 'WARM') {
    Send ('warm:' + (WarmUp))
    continue
  }

  if ($line -eq 'RELEASE') {
    $script:app = $null
    Send 'released'
    continue
  }

  if ($line -like 'APPLY *') {
    $b64 = $line.Substring(6).Trim()
    $res = 'ps-error:bad-payload'
    try {
      $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
      $payload = $json | ConvertFrom-Json
      $res = [string](Invoke-Apply $payload)
    } catch {
      $res = 'ps-error:' + $_.Exception.Message
      # A broken connection object would poison every later call -- drop it.
      $script:app = $null
    }
    Send $res
    continue
  }

  Send 'ps-error:unknown-command'
}
