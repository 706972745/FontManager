<#
    生成 GitHub Release 正文：CHANGELOG 对应版本段 + 安装说明（未签名说明 / 拦截处理 / SHA-256）。

    用法（CI 与本地通用，PowerShell 5.1 与 pwsh 7 均可）：
      .\.github\scripts\make-release-notes.ps1 -Version 1.1.3 -ReleaseDir release -OutFile release-notes.md

    说明：签名方案为 SignPath Foundation 免费 OV（见 CODE_SIGNING_POLICY.md），
    当前尚未启用；未配置签名密钥时输出未签名说明，传 -Signed 时输出已签名说明。

    注意：正文里大量 markdown 反引号，反引号是 PowerShell 的转义符，
    所以模板一律用**单引号 here-string**（@' ... '@），版本号用 __VER__ 占位后替换。
#>
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$ReleaseDir,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$Changelog = "CHANGELOG.md",
    [switch]$Signed
)

$ErrorActionPreference = "Stop"

# ── 1. 从 CHANGELOG.md 抽出本版本段落 ───────────────────────────────
if (-not (Test-Path $Changelog)) { throw "找不到 $Changelog" }
$lines = Get-Content $Changelog -Encoding UTF8
$section = New-Object System.Collections.Generic.List[string]
$capturing = $false
$found = $false
foreach ($line in $lines) {
    if ($line -match '^##\s+\[?v?([0-9][^\]]*)\]?') {
        if ($capturing) { break }
        if ($matches[1].Trim() -eq $Version) { $capturing = $true; $found = $true; continue }
    }
    if ($capturing) { $section.Add($line) }
}
if (-not $found) {
    Write-Warning "CHANGELOG.md 里没有 [$Version] 段落，正文将只含安装说明"
    $section.Clear()
}
while ($section.Count -gt 0 -and [string]::IsNullOrWhiteSpace($section[0])) { $section.RemoveAt(0) }
while ($section.Count -gt 0 -and [string]::IsNullOrWhiteSpace($section[$section.Count - 1])) { $section.RemoveAt($section.Count - 1) }

# ── 2. 安装包与哈希 ────────────────────────────────────────────────
$exe = Get-ChildItem -Path $ReleaseDir -Filter "*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$msi = Get-ChildItem -Path $ReleaseDir -Filter "*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
$hashLines = New-Object System.Collections.Generic.List[string]
foreach ($f in @($exe, $msi)) {
    if ($null -eq $f) { continue }
    $h = (Get-FileHash -Path $f.FullName -Algorithm SHA256).Hash.ToLower()
    $hashLines.Add("$h  $($f.Name)")
}

# ── 3. 未签名说明（单引号模板，__VER__ 占位） ───────────────────────
$signUnsigned = @'
### ⚠️ 本版本未做代码签名

两个安装包目前**没有数字签名**，Windows 因此无法验证发布者。下载或安装时可能遇到下面两种提示，
都不是病毒告警，按说明处理即可。

**1. 浏览器提示「通常不会下载」**（Edge / Chrome 的下载保护）

点提示条右侧的「…」或「更多」，选择 **保留** / **仍然下载**。

**2. Windows 11 智能应用控制（Smart App Control）提示「已阻止可能不安全的应用」**

这个提示**没有「仍要运行」按钮**，只有两个选择：

- 点「正常」关闭提示，按下面的方式验证文件完整性后自行决定是否继续；
- 或在「设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制 → 智能应用控制」里
  **关闭**该功能。注意：智能应用控制一旦关闭，通常**无法再次开启**（需重置或重装系统），
  请自行权衡，不建议为装一个软件长期关掉系统防护。

**验证文件完整性**（推荐，用来确认下载没被篡改）：

```powershell
Get-FileHash .\FontManager___VER___x64-setup.exe -Algorithm SHA256
```

把输出与下方 SHA-256 对照，一致即说明文件完整。

> 本项目是个人维护的免费开源项目，没有购买代码签名证书，详见仓库根目录的
> [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md)。
'@

# ── 3b. 已签名说明（通过 SignPath Foundation 免费 OV 证书） ──────────
$signSigned = @'
### ✅ 本版本已做代码签名

两个安装包已通过 **SignPath Foundation** 提供的免费 OV 代码签名证书签名
（密钥托管在 SignPath 的 HSM 上，签名在 CI 中自动完成）。Windows 与浏览器可据此
验证发布者，下载时不再出现「未知发布者」提示。

- 安装包的数字签名发布者为 **SignPath Foundation**——它是对「该二进制确实从本项目
  公开仓库构建」的背书，而非个人身份，这是该免费计划的固有形式。
- 仍建议保留下方 SHA-256 用于完整性核对。
- 签名在发布流程中自动完成；若某次发布未配置签名密钥，正文会自动退回上方「未签名」说明。

> 签名策略详见仓库根目录的 [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md)。
'@

# ── 4. 下载表 ──────────────────────────────────────────────────────
$downloadTable = @'
### 下载

| 文件 | 说明 |
|---|---|
| `FontManager___VER___x64-setup.exe` | NSIS 安装包，**推荐**（同版本号可覆盖安装，装到当前用户目录，不需要管理员权限） |
| `FontManager___VER___x64_en-US.msi` | MSI 安装包（同一版本号的 MSI 无法覆盖安装，升级请用 setup.exe） |

- **`setup.exe`**：装到 `%LOCALAPPDATA%\FontManager`，普通用户双击即可，同版本可直接覆盖重装。
- **`.msi`**：装到 `Program Files`，需要管理员权限，适合域内 GPO / Intune / SCCM 静默推送：
  `msiexec /i FontManager___VER___x64_en-US.msi /qn`。

> ⚠️ 两个安装器共用注册表项 `HKCU\Software\IIEOzo\FontManager` 记录安装目录，
> **裸 `.msi` 只在干净机器上用**；已经装过 setup.exe 的机器请继续用 setup.exe。
> `1.5.5` 起发布者署名改为 `IIEOzo`，该键路径随之变化；若你曾**自定义安装目录**，
> 建议先卸载旧版（**不要勾选「删除全部数据」**）再安装本版，用户数据不会丢。
'@

$signBlock = if ($Signed) { $signSigned } else { $signUnsigned }
$signBlock = $signBlock.Replace("__VER__", $Version)
$downloadTable = $downloadTable.Replace("__VER__", $Version)

# ── 5. 拼装并写出（UTF-8 无 BOM） ──────────────────────────────────
$parts = New-Object System.Collections.Generic.List[string]
$parts.Add("## FontManager $Version")
$parts.Add("")
if ($section.Count -gt 0) {
    $parts.AddRange($section)
    $parts.Add("")
    $parts.Add("---")
    $parts.Add("")
}
$parts.Add($signBlock.Trim())
$parts.Add("")
$parts.Add($downloadTable.Trim())
if ($hashLines.Count -gt 0) {
    $parts.Add("")
    $parts.Add("SHA-256：")
    $parts.Add("")
    $parts.Add('```')
    foreach ($h in $hashLines) { $parts.Add($h) }
    $parts.Add('```')
}

$text = ($parts -join "`n") + "`n"
if ([System.IO.Path]::IsPathRooted($OutFile)) { $full = $OutFile } else { $full = Join-Path (Get-Location).Path $OutFile }
$dir = Split-Path -Parent $full
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
[System.IO.File]::WriteAllText($full, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已生成 $full（$($text.Length) 字符，含 $($hashLines.Count) 个哈希）"
