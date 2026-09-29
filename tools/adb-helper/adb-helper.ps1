<#
  adb-helper.ps1 - get an Android device listed and online, then do things with it.
  Part of Pixel Agents (tools/adb-helper); made for the Galaxy Tab 2 that shows the office.

  Setup: put this file and adb-helper.cmd in a folder of their own (C:\Mix\Programs\adb) and
  double-click adb-helper.cmd, which runs this with no execution-policy prompt.
  On first run it downloads adb (Google's platform-tools) into that folder if there is none, and
  puts the folder on your PATH, so "adb" and "adb-helper" work from any terminal after that.
  Menu option s makes desktop and Start menu shortcuts.

  It escalates through the fixes one at a time and stops as soon as a device is online:
    1. just ask            4. restart the adb server
    2. wait and ask again  5. kill EVERY adb.exe (other programs bring their own, and two
    3. reconnect offline      versions fighting over port 5037 is the classic "offline")
                           6. ask you to replug / toggle USB debugging, and show the drivers
  Then a menu: install an APK (picked from the apks folder beside this script, newest first,
  or dragged in), start the Pixel Agents viewer, save its log, screenshot, shell, Wi-Fi adb...
#>

$ErrorActionPreference = 'Continue'
$Package = 'dk.mix.pixelagents.viewer'
$Activity = "$Package/.MainActivity"
$Here = $PSScriptRoot
$PlatformToolsUrl = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

# --- Setup: adb itself, and this folder on the PATH --------------------------------------------

function Install-PlatformTools {
    Say "Downloading adb from Google ($PlatformToolsUrl)..." 'Cyan'
    $zip = Join-Path $env:TEMP 'platform-tools-latest-windows.zip'
    $tmp = Join-Path $env:TEMP ('platform-tools-' + [guid]::NewGuid().ToString('N'))
    try {
        # Windows PowerShell 5.1 still defaults to TLS 1.0, which Google refuses
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue' # the progress bar makes the download many times slower
        Invoke-WebRequest -Uri $PlatformToolsUrl -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        # adb.exe and the DLLs it loads; fastboot and the rest are not needed here
        Get-ChildItem (Join-Path $tmp 'platform-tools') -File |
            Where-Object { $_.Name -eq 'adb.exe' -or $_.Extension -eq '.dll' } |
            ForEach-Object { Copy-Item $_.FullName $Here -Force }
        Say "adb installed in $Here" 'Green'
        return $true
    } catch {
        Say "Download failed: $($_.Exception.Message)" 'Red'
        return $false
    } finally {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-OnUserPath($dir) {
    $p = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $p) { return $false }
    foreach ($e in $p.Split(';')) { if ($e.TrimEnd('\') -ieq $dir.TrimEnd('\')) { return $true } }
    return $false
}

function Add-ToUserPath($dir) {
    $p = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($p) { $p = $p.TrimEnd(';') + ';' + $dir } else { $p = $dir }
    [Environment]::SetEnvironmentVariable('Path', $p, 'User')
    $env:Path = $env:Path.TrimEnd(';') + ';' + $dir # this window too, not only new ones
    Say "Added $dir to your PATH. New terminals can now run: adb, adb-helper" 'Green'
}

# adb: the copy beside this script wins, so every tool on this PC that finds "adb" on the PATH
# gets the same version - two versions sharing the adb server is what makes devices go offline
$Adb = Join-Path $Here 'adb.exe'
if (-not (Test-Path $Adb)) {
    $other = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($other) { Say "Found another adb at $($other.Source); this helper keeps its own copy beside it." 'DarkGray' }
    $a = Read-Host "adb is not in $Here. Download it from Google now? (Y/n)"
    if ($a -ne 'n' -and (Install-PlatformTools)) {
        # fresh copy
    } elseif ($other) {
        $Adb = $other.Source
        Say "Using $Adb" 'DarkGray'
    } else {
        Say 'No adb to use. Put adb.exe, AdbWinApi.dll and AdbWinUsbApi.dll in this folder, or run again.' 'Red'
        exit 1
    }
}

if (-not (Test-OnUserPath $Here)) {
    $a = Read-Host "$Here is not on your PATH, so plain 'adb' and 'adb-helper' will not work in a terminal. Add it? (Y/n)"
    if ($a -ne 'n') { Add-ToUserPath $Here }
}

function New-Shortcuts {
    $shell = New-Object -ComObject WScript.Shell
    $ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $places = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
    foreach ($dir in $places) {
        $lnk = $shell.CreateShortcut((Join-Path $dir 'adb helper.lnk'))
        $lnk.TargetPath = $ps
        $lnk.Arguments = "-NoExit -ExecutionPolicy Bypass -File `"$PSCommandPath`""
        $lnk.WorkingDirectory = $Here
        $lnk.IconLocation = "$ps,0"
        $lnk.Description = 'Connect an Android device and install APKs'
        $lnk.Save()
        Say "Shortcut: $(Join-Path $dir 'adb helper.lnk')" 'Green'
    }
}

# Devices as objects: Serial, State ('device', 'offline', 'unauthorized', ...)
function Get-Devices {
    $lines = & $Adb devices 2>$null
    $list = @()
    foreach ($l in $lines) {
        if ($l -match '^\s*$' -or $l -match '^List of devices' -or $l -match '^\*') { continue }
        $parts = $l -split '\s+', 2
        if ($parts.Count -eq 2) {
            $list += [pscustomobject]@{ Serial = $parts[0]; State = $parts[1].Trim() }
        } elseif ($l -match '^\(no serial number\)\s+(\S+)') {
            $list += [pscustomobject]@{ Serial = '(no serial number)'; State = $Matches[1] }
        }
    }
    return ,$list
}

function Show-Devices($devs) {
    if ($devs.Count -eq 0) { Say '  (no devices listed)' 'DarkYellow'; return }
    foreach ($d in $devs) {
        $c = 'DarkYellow'; if ($d.State -eq 'device') { $c = 'Green' }
        Say ("  {0,-22} {1}" -f $d.Serial, $d.State) $c
    }
}

function Get-Online { return @((Get-Devices) | Where-Object { $_.State -eq 'device' }) }

function Wait-Online($seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        $on = @(Get-Online)
        if ($on.Count -gt 0) { return $on }
        Start-Sleep -Seconds 1
    }
    return @()
}

function Show-UsbDrivers {
    Say "`nUSB devices Windows sees that look like Android/Samsung:" 'Cyan'
    try {
        $pnp = Get-PnpDevice -PresentOnly -ErrorAction Stop |
            Where-Object { $_.FriendlyName -match 'ADB|Android|Samsung|SAMSUNG|Galaxy|MTP|GT-P' }
        if (-not $pnp) { Say '  none - the cable, the port, or the tablet is not presenting USB at all' 'DarkYellow' }
        foreach ($p in $pnp) {
            $c = 'Gray'; if ($p.Status -ne 'OK') { $c = 'DarkYellow' }
            Say ("  [{0}] {1}  ({2})" -f $p.Status, $p.FriendlyName, $p.Class) $c
        }
        Say '  An "ADB Interface" with status OK is what you want. If it is missing or not OK,' 'DarkGray'
        Say '  install the Samsung Android USB Driver for Windows and replug.' 'DarkGray'
    } catch { Say '  (could not query drivers)' 'DarkGray' }
}

function Connect-Device {
    Say "adb: $Adb" 'DarkGray'
    Say ((& $Adb version 2>$null | Select-Object -First 1)) 'DarkGray'

    $steps = @(
        @{ Name = 'Asking for devices'; Do = { & $Adb start-server *> $null }; Wait = 2 },
        @{ Name = 'Waiting for the handshake to finish'; Do = { }; Wait = 6 },
        @{ Name = 'Reconnecting offline devices'; Do = { & $Adb reconnect offline *> $null }; Wait = 8 },
        @{ Name = 'Restarting the adb server'; Do = { & $Adb kill-server *> $null; Start-Sleep 1; & $Adb start-server *> $null }; Wait = 8 },
        @{ Name = 'Stopping every adb.exe on this PC (other tools bring their own)'; Do = {
                & $Adb kill-server *> $null
                Get-Process adb -ErrorAction SilentlyContinue | ForEach-Object {
                    Say ("    killing adb.exe pid {0}  {1}" -f $_.Id, $_.Path) 'DarkGray'
                    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                }
                Start-Sleep 1
                & $Adb start-server *> $null
            }; Wait = 10 }
    )

    foreach ($s in $steps) {
        Say "`n> $($s.Name)..." 'Cyan'
        & $s.Do
        $on = @(Wait-Online $s.Wait)
        Show-Devices (Get-Devices)
        if ($on.Count -gt 0) { return $on }
    }

    # Needs hands
    for ($round = 1; $round -le 3; $round++) {
        Show-UsbDrivers
        Say "`nStill not online. On the tablet:" 'Yellow'
        Say '  - unlock the screen' 'Yellow'
        Say '  - Settings > Developer options: turn USB debugging OFF and ON again' 'Yellow'
        Say '  - unplug the cable and plug it back in (a port directly on the PC, not a hub)' 'Yellow'
        $a = Read-Host 'Press Enter when done (or q to give up and go to the menu anyway)'
        if ($a -eq 'q') { return @() }
        & $Adb kill-server *> $null
        & $Adb start-server *> $null
        $on = @(Wait-Online 12)
        Show-Devices (Get-Devices)
        if ($on.Count -gt 0) { return $on }
        & $Adb reconnect offline *> $null
        $on = @(Wait-Online 8)
        if ($on.Count -gt 0) { Show-Devices (Get-Devices); return $on }
    }
    return @()
}

function Pick-Device {
    $on = @(Get-Online)
    if ($on.Count -eq 0) { return $null }
    if ($on.Count -eq 1) { return $on[0].Serial }
    for ($i = 0; $i -lt $on.Count; $i++) { Say ("  {0}) {1}" -f ($i + 1), $on[$i].Serial) }
    $n = Read-Host 'Which device'
    return $on[[int]$n - 1].Serial
}

function Clean-Path($p) { return $p.Trim().Trim('"').Trim("'") }

# Drop APKs into the apks folder beside this script; the newest is listed first
$ApkDir = Join-Path $Here 'apks'
if (-not (Test-Path $ApkDir)) { New-Item -ItemType Directory -Force $ApkDir | Out-Null }

function Select-Apk {
    $files = @(Get-ChildItem -Path $ApkDir -Filter *.apk -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    Say "`nAPKs in $ApkDir (newest first):" 'Cyan'
    if ($files.Count -eq 0) { Say '  (none yet - put .apk files in that folder)' 'DarkYellow' }
    for ($i = 0; $i -lt $files.Count; $i++) {
        Say ("  {0,2}) {1,-45} {2:yyyy-MM-dd HH:mm}  {3,6:N0} KB" -f ($i + 1), $files[$i].Name, $files[$i].LastWriteTime, ($files[$i].Length / 1KB))
    }
    Say '   p) type or drag in a path instead'
    Say '   o) open the folder in Explorer'
    Say '   b) back'
    $default = ''; if ($files.Count -gt 0) { $default = ' (Enter = 1, the newest)' }
    $a = (Read-Host "Which$default").Trim()
    if ($a -eq '' -and $files.Count -gt 0) { return $files[0].FullName }
    if ($a -eq 'b' -or $a -eq '') { return $null }
    if ($a -eq 'o') { Invoke-Item $ApkDir; return (Select-Apk) }
    if ($a -eq 'p') { return (Clean-Path (Read-Host 'Path to the .apk (you can drag the file into this window)')) }
    $n = 0
    if ([int]::TryParse($a, [ref]$n) -and $n -ge 1 -and $n -le $files.Count) { return $files[$n - 1].FullName }
    Say 'Not one of the choices.' 'DarkYellow'
    return $null
}

function Invoke-Adb($serial, [string[]]$argList) {
    if ($serial) { & $Adb -s $serial @argList } else { & $Adb @argList }
}

# ---------------------------------------------------------------------------------------------

$online = @(Connect-Device)
if ($online.Count -gt 0) { Say "`nOnline." 'Green' } else { Say "`nNo device online. Some menu items will not work until one is." 'DarkYellow' }

while ($true) {
    Say "`n==== adb helper ====" 'Cyan'
    Show-Devices (Get-Devices)
    Say '  1) Install an APK from the apks folder (keeps the app''s data and settings)'
    Say '  2) Start the Pixel Agents viewer'
    Say '  3) Save the Pixel Agents viewer''s log to a file'
    Say '  4) Take a screenshot'
    Say '  5) Open a shell on the device'
    Say '  6) Switch to adb over Wi-Fi (then the cable can go)'
    Say '  7) Connect to a device over Wi-Fi by IP'
    Say '  8) Uninstall an app'
    Say '  9) Try to reconnect again'
    Say '  s) Make desktop and Start menu shortcuts'
    Say '  0) Quit'
    $choice = Read-Host 'Choose'

    switch ($choice) {
        '1' {
            $serial = Pick-Device; if (-not $serial) { Say 'No device online.' 'Red'; break }
            $apk = Select-Apk
            if (-not $apk) { break }
            if (-not (Test-Path $apk)) { Say "Not found: $apk" 'Red'; break }
            Invoke-Adb $serial @('install', '-r', $apk)
            if ($LASTEXITCODE -ne 0) {
                Say 'Install failed. If it says INSTALL_FAILED_VERSION_DOWNGRADE or a signature mismatch,' 'Yellow'
                Say 'uninstall first (option 8) - that also clears the app''s settings.' 'Yellow'
            } else {
                $pkg = $null
                $aapt = Join-Path $Here 'aapt.exe'
                if (Test-Path $aapt) { $m = (& $aapt dump badging $apk | Select-String "package: name='([^']+)'"); if ($m) { $pkg = $m.Matches[0].Groups[1].Value } }
                if (-not $pkg -and $apk -match 'pixel-agents-viewer') { $pkg = $Package }
                if ($pkg -eq $Package) {
                    $go = Read-Host 'Start the Pixel Agents viewer now? (Y/n)'
                    if ($go -ne 'n') { Invoke-Adb $serial @('shell', 'am', 'start', '-n', $Activity) }
                }
            }
        }
        '2' {
            $serial = Pick-Device; if (-not $serial) { Say 'No device online.' 'Red'; break }
            Invoke-Adb $serial @('shell', 'am', 'start', '-n', $Activity)
        }
        '3' {
            $serial = Pick-Device; if (-not $serial) { Say 'No device online.' 'Red'; break }
            $file = Join-Path (Get-Location) ("pixelagents-log-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
            Invoke-Adb $serial @('logcat', '-d', '-v', 'time', '-s', 'PixelAgents:*', 'TabScreen:*', 'AndroidRuntime:*') | Out-File -Encoding utf8 $file
            Say "Saved $file" 'Green'
            Get-Content $file -Tail 25
        }
        '4' {
            $serial = Pick-Device; if (-not $serial) { Say 'No device online.' 'Red'; break }
            $file = Join-Path (Get-Location) ("screenshot-{0}.png" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
            Invoke-Adb $serial @('shell', 'screencap', '-p', '/sdcard/adb-helper-shot.png')
            Invoke-Adb $serial @('pull', '/sdcard/adb-helper-shot.png', $file)
            Invoke-Adb $serial @('shell', 'rm', '/sdcard/adb-helper-shot.png')
            if (Test-Path $file) { Say "Saved $file" 'Green' }
        }
        '5' {
            $serial = Pick-Device; if (-not $serial) { Say 'No device online.' 'Red'; break }
            Say 'Type exit to come back.' 'DarkGray'
            Invoke-Adb $serial @('shell')
        }
        '6' {
            $serial = Pick-Device; if (-not $serial) { Say 'No device online (this needs the cable first).' 'Red'; break }
            $ipLine = Invoke-Adb $serial @('shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0') | Select-String 'inet (\d+\.\d+\.\d+\.\d+)'
            $ip = $null; if ($ipLine) { $ip = $ipLine.Matches[0].Groups[1].Value }
            if (-not $ip) {
                $ipLine = Invoke-Adb $serial @('shell', 'getprop', 'dhcp.wlan0.ipaddress')
                if ($ipLine -match '\d+\.\d+\.\d+\.\d+') { $ip = $Matches[0] }
            }
            Invoke-Adb $serial @('tcpip', '5555')
            Start-Sleep 3
            if ($ip) {
                & $Adb connect "${ip}:5555"
                Say "Next time: adb connect ${ip}:5555 (until the tablet reboots)" 'Green'
            } else { Say 'Could not read the tablet''s Wi-Fi address - use option 7 with the IP from its Wi-Fi settings.' 'Yellow' }
        }
        '7' {
            $ip = (Read-Host 'IP address (port 5555 is assumed)').Trim()
            if ($ip -notmatch ':') { $ip = "${ip}:5555" }
            & $Adb connect $ip
        }
        '8' {
            $serial = Pick-Device; if (-not $serial) { Say 'No device online.' 'Red'; break }
            $pkg = (Read-Host "Package name (Enter for $Package)").Trim()
            if (-not $pkg) { $pkg = $Package }
            Invoke-Adb $serial @('uninstall', $pkg)
        }
        '9' {
            $online = @(Connect-Device)
        }
        's' { New-Shortcuts }
        '0' { exit 0 }
        default { Say 'Pick a number from the list.' 'DarkYellow' }
    }
}
