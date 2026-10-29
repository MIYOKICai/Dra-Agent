# 构建 Dra-Agent 自绘引导安装器（单文件 exe）
# 流程：绘制 logo/ico 资源 → win-unpacked 打 zip → csc 编译引导器 → zip+footer 追加到 exe 尾部
# 产物：release\exe\Dra-Agent-<ver>-Setup.exe（旧 NSIS Setup 备份为 -Setup-NSIS.exe）
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = 'd:\Dra-Agent'
$src = Join-Path $root 'build\installer'
$unpacked = 'C:\Users\MECHREVO\AppData\Local\Temp\dra-release\win-unpacked'
$outDir = Join-Path $root 'release\exe'
if (-not (Test-Path $unpacked)) { throw "win-unpacked 不存在：先运行 npm run electron:build" }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Draw-Logo([System.Drawing.Graphics]$g, [float]$x, [float]$y, [float]$size, [float]$radius, [float]$starR) {
    # 黑色圆角方块 + 白色四角星（mono 风格 logo，亮色安装器）
    $block = New-Object System.Drawing.Drawing2D.GraphicsPath
    $block.AddArc($x, $y, $radius * 2, $radius * 2, 180, 90)
    $block.AddArc(($x + $size - $radius * 2), $y, $radius * 2, $radius * 2, 270, 90)
    $block.AddArc(($x + $size - $radius * 2), ($y + $size - $radius * 2), $radius * 2, $radius * 2, 0, 90)
    $block.AddArc($x, ($y + $size - $radius * 2), $radius * 2, $radius * 2, 90, 90)
    $block.CloseFigure()
    $g.FillPath([System.Drawing.Brushes]::Black, $block)
    $star = New-Object System.Drawing.Drawing2D.GraphicsPath
    $cx = $x + $size / 2; $cy = $y + $size / 2
    $pts = @(
        (New-Object System.Drawing.PointF($cx, ($cy - $starR))),
        (New-Object System.Drawing.PointF(($cx + $starR * 0.34), ($cy - $starR * 0.34))),
        (New-Object System.Drawing.PointF(($cx + $starR), $cy)),
        (New-Object System.Drawing.PointF(($cx + $starR * 0.34), ($cy + $starR * 0.34))),
        (New-Object System.Drawing.PointF($cx, ($cy + $starR))),
        (New-Object System.Drawing.PointF(($cx - $starR * 0.34), ($cy + $starR * 0.34))),
        (New-Object System.Drawing.PointF(($cx - $starR), $cy)),
        (New-Object System.Drawing.PointF(($cx - $starR * 0.34), ($cy - $starR * 0.34)))
    )
    $star.AddPolygon($pts)
    $g.FillPath([System.Drawing.Brushes]::White, $star)
    $block.Dispose(); $star.Dispose()
}

# ---------- 1. logo.png（安装窗 logo，512 透明底） ----------
$logoPath = Join-Path $src 'logo.png'
$bmp = New-Object System.Drawing.Bitmap(512, 512)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
Draw-Logo $g 48 48 416 100 150
$g.Dispose()
$bmp.Save($logoPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# ---------- 2. app.ico（GDI+ 标准格式，避免手写 ICO 头导致 Form.Icon 提取失败） ----------
$icoPath = Join-Path $src 'app.ico'
$bmp = New-Object System.Drawing.Bitmap(64, 64)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
Draw-Logo $g 4 4 56 14 20
$g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = [IO.File]::Create($icoPath)
$icon.Save($fs)
$fs.Close(); $icon.Dispose(); $bmp.Dispose()

# ---------- 3. license.txt ----------
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $src 'license.txt') -Force

# ---------- 4. 应用本体 zip ----------
$zip = Join-Path $env:TEMP 'dra-agent-app.zip'
if (Test-Path $zip) {
    Write-Output '复用已存在的应用 zip …'
}
else {
    Write-Output '正在压缩应用本体（win-unpacked → zip）…'
    [System.IO.Compression.ZipFile]::CreateFromDirectory($unpacked, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
}

# ---------- 5. csc 编译引导器 ----------
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
$body = Join-Path $src 'installer-body.exe'
$manifestPath = Join-Path $src 'app.manifest'
$licensePath = Join-Path $src 'license.txt'
& $csc /nologo /target:winexe /platform:anycpu /optimize+ /out:$body /codepage:65001 /warn:0 `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll /r:Microsoft.CSharp.dll `
    /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
    /win32manifest:"$manifestPath" /win32icon:"$icoPath" `
    "/resource:$logoPath,DraLogo" "/resource:$licensePath,DraLicense" `
    (Join-Path $src 'installer.cs')
if ($LASTEXITCODE -ne 0) { throw "csc 编译失败（exit $LASTEXITCODE）" }

# ---------- 6. 追加 zip + footer → 单文件安装器 ----------
$ver = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$final = Join-Path $outDir ('Dra-Agent-{0}-Setup.exe' -f $ver)
$nsisBackup = Join-Path $outDir ('Dra-Agent-{0}-Setup-NSIS.exe' -f $ver)
if (Test-Path $final) {
    if (-not (Test-Path $nsisBackup)) { Move-Item $final $nsisBackup -Force }
    else { Remove-Item $final -Force }
}
Copy-Item $body $final -Force
$zipBytes = [IO.File]::ReadAllBytes($zip)
$appender = [IO.File]::Open($final, 'Append')
$appender.Write($zipBytes, 0, $zipBytes.Length)
$appender.Write([byte[]](0x44, 0x52, 0x41, 0x5A, 0x49, 0x50, 0x56, 0x31, 0x30, 0x30, 0x30, 0x30), 0, 12)
$appender.Write([BitConverter]::GetBytes([long]$zipBytes.Length), 0, 8)
$appender.Close()
Remove-Item $zip, $body -Force
Write-Output ('OK: {0} ({1:N1} MB)' -f $final, ((Get-Item $final).Length / 1MB))
