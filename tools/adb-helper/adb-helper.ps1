<#
  adb-helper.ps1 - get an Android device online over adb, then do things with it.
  Part of Pixel Agents (tools/adb-helper); made for the Galaxy Tab 2 that shows the office.

  Setup: put this file and adb-helper.cmd in a folder of their own (C:\Mix\Programs\adb) and
  double-click adb-helper.cmd, which runs this with no execution-policy prompt. The first run
  downloads adb (Google's platform-tools) into the folder if it is not there.

  It opens on a list of connected devices with a menu below it: arrow keys and Enter, or the
  key shown on each line. If a device is missing or offline, "Scan and reconnect" works through
  the fixes one at a time and stops at the first that brings it online:
    1. just ask            4. restart the adb server
    2. wait and ask again  5. stop EVERY adb.exe (other programs bring their own, and two
    3. reconnect offline      versions sharing the adb server is the classic "offline")
                           6. walk you through replugging, and show the USB drivers
#>

$ErrorActionPreference = 'Continue'
$Package = 'dk.mix.pixelagents.viewer'
$Activity = "$Package/.MainActivity"
$Here = $PSScriptRoot
$ApkDir = Join-Path $Here 'apks'
$PlatformToolsUrl = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

# Arrow keys need a real console; anywhere else (the ISE, redirected input) the menus fall back
# to typing the key shown on each line
$script:CanReadKey = $true
try { $null = [Console]::KeyAvailable } catch { $script:CanReadKey = $false }

function Wait-Key($message = 'Press any key to go back to the menu') {
    if ($script:CanReadKey) { Say "`n$message" 'DarkGray'; $null = [Console]::ReadKey($true) }
    else { $null = Read-Host "`n$message (Enter)" }
}

function Clean-Path($p) { return $p.Trim().Trim('"').Trim("'") }

# --- adb itself ---------------------------------------------------------------------------------

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

# The copy beside this script wins: two adb versions sharing the adb server is what makes a
# device go offline, so the helper does not borrow whichever one happens to be on the PATH
$Adb = Join-Path $Here 'adb.exe'
if (-not (Test-Path $Adb)) {
    Say "adb is not in $Here yet." 'Yellow'
    $other = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($other) { Say "(There is another adb at $($other.Source) - this helper keeps its own copy.)" 'DarkGray' }
    $a = Read-Host 'Download it from Google now? (Y/n)'
    if ($a -eq 'n' -or -not (Install-PlatformTools)) {
        if ($other) { $Adb = $other.Source; Say "Using $Adb" 'DarkGray' }
        else {
            Say 'No adb to use. Put adb.exe, AdbWinApi.dll and AdbWinUsbApi.dll in this folder, or run again.' 'Red'
            Wait-Key 'Press any key to close'
            exit 1
        }
    }
}
if (-not (Test-Path $ApkDir)) { New-Item -ItemType Directory -Force $ApkDir | Out-Null }

# --- PATH ---------------------------------------------------------------------------------------

function Test-OnUserPath($dir) {
    $p = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $p) { return $false }
    foreach ($e in $p.Split(';')) { if ($e.TrimEnd('\') -ieq $dir.TrimEnd('\')) { return $true } }
    return $false
}

function Switch-UserPath {
    $p = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (Test-OnUserPath $Here) {
        $kept = @($p.Split(';') | Where-Object { $_ -and $_.TrimEnd('\') -ine $Here.TrimEnd('\') })
        [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
        Say "Removed $Here from your PATH." 'Green'
        Say "New terminals will no longer find 'adb' or 'adb-helper' outside this folder." 'DarkGray'
    } else {
        if ($p) { $p = $p.TrimEnd(';') + ';' + $Here } else { $p = $Here }
        [Environment]::SetEnvironmentVariable('Path', $p, 'User')
        Say "Added $Here to your PATH." 'Green'
        Say "Open a new terminal and 'adb' and 'adb-helper' work from anywhere." 'DarkGray'
    }
}

# --- devices ------------------------------------------------------------------------------------

# Devices as objects: Serial, State ('device', 'offline', 'unauthorized', ...)
function Get-Devices {
    $lines = & $Adb devices 2>$null
    $list = @()
    foreach ($l in $lines) {
        if ($l -match '^\s*$' -or $l -match '^List of devices' -or $l -match '^\*') { continue }
        if ($l -match '^\(no serial number\)\s+(\S+)') {
            $list += [pscustomobject]@{ Serial = '(no serial number)'; State = $Matches[1] }
            continue
        }
        $parts = $l -split '\s+', 2
        if ($parts.Count -eq 2) { $list += [pscustomobject]@{ Serial = $parts[0]; State = $parts[1].Trim() } }
    }
    return $list # callers wrap it in @(), so one device or none still reads as a list
}

$script:Devices = @()
function Update-Devices { $script:Devices = @(Get-Devices) }
function Get-Online { return @($script:Devices | Where-Object { $_.State -eq 'device' }) }

function Show-Devices($devs) {
    if (@($devs).Count -eq 0) { Say '  (none found)' 'DarkYellow'; return }
    foreach ($d in $devs) {
        $c = 'DarkYellow'; if ($d.State -eq 'device') { $c = 'Green' }
        $state = $d.State; if ($state -eq 'device') { $state = 'online' }
        Say ("  {0,-24} {1}" -f $d.Serial, $state) $c
    }
}

function Show-Header {
    Say 'adb helper' 'Cyan'
    Say "Devices:" 'Gray'
    Show-Devices $script:Devices
    Say ''
}

function Wait-Online($seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        Update-Devices
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
        if (-not $pnp) { Say '  none - the cable, the port, or the device is not presenting USB at all' 'DarkYellow' }
        foreach ($p in $pnp) {
            $c = 'Gray'; if ($p.Status -ne 'OK') { $c = 'DarkYellow' }
            Say ("  [{0}] {1}  ({2})" -f $p.Status, $p.FriendlyName, $p.Class) $c
        }
        Say '  An "ADB Interface" with status OK is what you want. If it is missing or not OK,' 'DarkGray'
        Say '  install the Samsung Android USB Driver for Windows and replug.' 'DarkGray'
    } catch { Say '  (could not query drivers)' 'DarkGray' }
}

# A quick look at start-up: give a device that is mid-handshake a moment, nothing more
function Find-Devices {
    Say 'Looking for devices...' 'Cyan'
    & $Adb start-server *> $null
    for ($i = 0; $i -lt 3; $i++) {
        Update-Devices
        $settling = @($script:Devices | Where-Object { $_.State -ne 'device' })
        if ($script:Devices.Count -gt 0 -and $settling.Count -eq 0) { return }
        Start-Sleep -Seconds 1
    }
}

# The full treatment: one fix at a time, stopping at the first that brings a device online
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
                    Say ("    stopping adb.exe pid {0}  {1}" -f $_.Id, $_.Path) 'DarkGray'
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
        Show-Devices $script:Devices
        if ($on.Count -gt 0) { Say "`nOnline." 'Green'; return }
    }

    # Needs hands
    for ($round = 1; $round -le 3; $round++) {
        Show-UsbDrivers
        Say "`nStill not online. On the device:" 'Yellow'
        Say '  - unlock the screen' 'Yellow'
        Say '  - Settings > Developer options: turn USB debugging OFF and ON again' 'Yellow'
        Say '  - unplug the cable and plug it back in (a port directly on the PC, not a hub)' 'Yellow'
        Say '  - close any other program that uses adb (TabScreen Host, Android Studio, phone suites)' 'Yellow'
        $a = Read-Host 'Press Enter when done, or q to stop trying'
        if ($a -eq 'q') { return }
        & $Adb kill-server *> $null
        & $Adb start-server *> $null
        $on = @(Wait-Online 12)
        if ($on.Count -eq 0) { & $Adb reconnect offline *> $null; $on = @(Wait-Online 8) }
        Show-Devices $script:Devices
        if ($on.Count -gt 0) { Say "`nOnline." 'Green'; return }
    }
    Say "`nNo luck. Try another cable or port, or the Samsung USB driver." 'Yellow'
}

# --- menus --------------------------------------------------------------------------------------

<#
  Draw a menu under the header and return the index chosen, or -1 for Esc. Items are hashtables:
  Label, Hot (the key that picks it at once), Note (grey text after it), Dim (drawn grey).
#>
function Show-Menu($title, $items, [int]$selected = 0) {
    if ($selected -lt 0 -or $selected -ge $items.Count) { $selected = 0 }
    $width = 0
    foreach ($it in $items) { if ($it.Label.Length -gt $width) { $width = $it.Label.Length } }
    while ($true) {
        Clear-Host
        Show-Header
        Say $title 'Cyan'
        for ($i = 0; $i -lt $items.Count; $i++) {
            $it = $items[$i]
            $hot = '  '; if ($it.Hot) { $hot = "$($it.Hot))" }
            $text = "{0,-4}{1}" -f $hot, $it.Label.PadRight($width)
            if ($i -eq $selected -and $script:CanReadKey) {
                Write-Host (' > ' + $text + ' ') -NoNewline -ForegroundColor Black -BackgroundColor Cyan
            } else {
                $c = 'Gray'; if ($it.Dim) { $c = 'DarkGray' }
                Write-Host ('   ' + $text + ' ') -NoNewline -ForegroundColor $c
            }
            if ($it.Note) { Write-Host ('  ' + $it.Note) -ForegroundColor DarkGray } else { Write-Host '' }
        }

        if (-not $script:CanReadKey) {
            $a = (Read-Host "`nType the key shown (Enter = $($items[$selected].Label))").Trim()
            if ($a -eq '') { return $selected }
            for ($i = 0; $i -lt $items.Count; $i++) { if ($items[$i].Hot -and $items[$i].Hot -ieq $a) { return $i } }
            continue
        }

        Say "`n  Up/Down and Enter, or press the key shown. Esc goes back." 'DarkGray'
        $k = [Console]::ReadKey($true)
        if ($k.Key -eq 'UpArrow') { $selected = ($selected - 1 + $items.Count) % $items.Count }
        elseif ($k.Key -eq 'DownArrow') { $selected = ($selected + 1) % $items.Count }
        elseif ($k.Key -eq 'Home' -or $k.Key -eq 'PageUp') { $selected = 0 }
        elseif ($k.Key -eq 'End' -or $k.Key -eq 'PageDown') { $selected = $items.Count - 1 }
        elseif ($k.Key -eq 'Enter') { return $selected }
        elseif ($k.Key -eq 'Escape') { return -1 }
        else {
            $ch = [string]$k.KeyChar
            for ($i = 0; $i -lt $items.Count; $i++) { if ($items[$i].Hot -and $items[$i].Hot -ieq $ch) { return $i } }
        }
    }
}

function Pick-Device {
    Update-Devices
    $on = @(Get-Online)
    if ($on.Count -eq 0) {
        Say 'No device online. Choose "Scan and reconnect to devices" first.' 'Yellow'
        return $null
    }
    if ($on.Count -eq 1) { return $on[0].Serial }
    $items = @()
    for ($i = 0; $i -lt $on.Count; $i++) { $items += @{ Label = $on[$i].Serial; Hot = [string]($i + 1) } }
    $n = Show-Menu 'Which device?' $items 0
    Clear-Host
    if ($n -lt 0) { return $null }
    return $on[$n].Serial
}

function Select-Apk {
    while ($true) {
        $files = @(Get-ChildItem -Path $ApkDir -Filter *.apk -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
        $items = @()
        for ($i = 0; $i -lt $files.Count; $i++) {
            $hot = ''; if ($i -lt 9) { $hot = [string]($i + 1) }
            $items += @{ Label = $files[$i].Name; Hot = $hot; File = $files[$i].FullName
                         Note = ("{0:yyyy-MM-dd HH:mm}  {1:N0} KB" -f $files[$i].LastWriteTime, ($files[$i].Length / 1KB)) }
        }
        if ($files.Count -eq 0) { $items += @{ Label = '(no APKs in the folder yet)'; Dim = $true; Act = 'none' } }
        $items += @{ Label = 'Drag in or type a path instead'; Hot = 'p'; Act = 'path' }
        $items += @{ Label = 'Open the apks folder in Explorer'; Hot = 'o'; Act = 'open' }
        $items += @{ Label = 'Back'; Hot = 'b'; Act = 'back' }

        $n = Show-Menu "Install which APK? Newest first, from $ApkDir" $items 0
        Clear-Host
        if ($n -lt 0) { return $null }
        $it = $items[$n]
        if ($it.File) { return $it.File }
        if ($it.Act -eq 'path') { return (Clean-Path (Read-Host 'Path to the .apk (drag the file into this window)')) }
        if ($it.Act -eq 'open') { Invoke-Item $ApkDir }
        if ($it.Act -eq 'back') { return $null }
    }
}

function Invoke-Adb($serial, [string[]]$argList) {
    if ($serial) { & $Adb -s $serial @argList } else { & $Adb @argList }
}

# --- actions ------------------------------------------------------------------------------------

function Do-Install {
    $serial = Pick-Device; if (-not $serial) { return }
    $apk = Select-Apk
    if (-not $apk) { return 'back' }
    if (-not (Test-Path $apk)) { Say "Not found: $apk" 'Red'; return }
    Say "Installing $(Split-Path $apk -Leaf) on $serial..." 'Cyan'
    # Out-Host throughout: this function's result is assigned, and anything left in the pipeline
    # would be swallowed into it instead of shown
    Invoke-Adb $serial @('install', '-r', $apk) | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Say 'Install failed. If it says INSTALL_FAILED_VERSION_DOWNGRADE or a signature mismatch,' 'Yellow'
        Say 'uninstall the app first - that also clears its settings.' 'Yellow'
        return
    }
    if ((Split-Path $apk -Leaf) -match 'pixel-agents-viewer') {
        $go = Read-Host 'Start the Pixel Agents viewer now? (Y/n)'
        if ($go -ne 'n') { Invoke-Adb $serial @('shell', 'am', 'start', '-n', $Activity) | Out-Host }
    }
}

function Do-Start {
    $serial = Pick-Device; if (-not $serial) { return }
    Invoke-Adb $serial @('shell', 'am', 'start', '-n', $Activity)
}

function Do-Log {
    $serial = Pick-Device; if (-not $serial) { return }
    $file = Join-Path $Here ("pixelagents-log-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Invoke-Adb $serial @('logcat', '-d', '-v', 'time', '-s', 'PixelAgents:*', 'TabScreen:*', 'AndroidRuntime:*') | Out-File -Encoding utf8 $file
    Say "Saved $file" 'Green'
    Get-Content $file -Tail 25
}

function Do-Screenshot {
    $serial = Pick-Device; if (-not $serial) { return }
    $file = Join-Path $Here ("screenshot-{0}.png" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Invoke-Adb $serial @('shell', 'screencap', '-p', '/sdcard/adb-helper-shot.png')
    Invoke-Adb $serial @('pull', '/sdcard/adb-helper-shot.png', $file)
    Invoke-Adb $serial @('shell', 'rm', '/sdcard/adb-helper-shot.png')
    if (Test-Path $file) { Say "Saved $file" 'Green'; Invoke-Item $file }
}

function Do-Shell {
    $serial = Pick-Device; if (-not $serial) { return }
    Say 'Type exit to come back.' 'DarkGray'
    Invoke-Adb $serial @('shell')
}

function Do-WifiSwitch {
    $serial = Pick-Device; if (-not $serial) { return }
    $ip = $null
    $ipLine = Invoke-Adb $serial @('shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0') | Select-String 'inet (\d+\.\d+\.\d+\.\d+)'
    if ($ipLine) { $ip = $ipLine.Matches[0].Groups[1].Value }
    if (-not $ip) {
        $prop = Invoke-Adb $serial @('shell', 'getprop', 'dhcp.wlan0.ipaddress')
        if ($prop -match '\d+\.\d+\.\d+\.\d+') { $ip = $Matches[0] }
    }
    Invoke-Adb $serial @('tcpip', '5555')
    Start-Sleep 3
    if ($ip) {
        & $Adb connect "${ip}:5555"
        Say "The cable can go now. Next time: 'Connect over Wi-Fi by IP' with $ip (until the device reboots)." 'Green'
    } else { Say 'Could not read the Wi-Fi address - use "Connect over Wi-Fi by IP" with the one in its Wi-Fi settings.' 'Yellow' }
}

function Do-WifiConnect {
    $ip = (Read-Host 'IP address (port 5555 is assumed)').Trim()
    if (-not $ip) { return 'back' }
    if ($ip -notmatch ':') { $ip = "${ip}:5555" }
    & $Adb connect $ip | Out-Host
}

function Do-Uninstall {
    $serial = Pick-Device; if (-not $serial) { return }
    $pkg = (Read-Host "Package name (Enter for $Package)").Trim()
    if (-not $pkg) { $pkg = $Package }
    Invoke-Adb $serial @('uninstall', $pkg)
}

function New-Shortcuts {
    $shell = New-Object -ComObject WScript.Shell
    $cmd = Join-Path $Here 'adb-helper.cmd'
    $ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    $places = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
    foreach ($dir in $places) {
        $path = Join-Path $dir 'adb helper.lnk'
        $lnk = $shell.CreateShortcut($path)
        if (Test-Path $cmd) { $lnk.TargetPath = $cmd }
        else { $lnk.TargetPath = $ps; $lnk.Arguments = "-NoExit -ExecutionPolicy Bypass -File `"$PSCommandPath`"" }
        $lnk.WorkingDirectory = $Here
        $lnk.IconLocation = "$ps,0"
        $lnk.Description = 'Connect an Android device and install APKs'
        $lnk.Save()
        Say "Shortcut: $path" 'Green'
    }
}

# --- main ---------------------------------------------------------------------------------------

Find-Devices
$last = -1
while ($true) {
    $has = (@(Get-Online)).Count -gt 0
    $needs = ''; if (-not $has) { $needs = 'needs a device online' }
    $scanNote = ''; if (-not $has) { $scanNote = 'no device online - start here' }
    $onPath = Test-OnUserPath $Here
    $pathLabel = 'Add adb to PATH'; $pathNote = "currently not on PATH - 'adb' only works in this folder"
    if ($onPath) { $pathLabel = 'Remove adb from PATH'; $pathNote = "currently on PATH - 'adb' and 'adb-helper' work anywhere" }

    $items = @(
        @{ Label = 'Install an APK';                      Hot = '1'; Act = 'install';    Dim = -not $has; Note = $needs },
        @{ Label = 'Start the Pixel Agents viewer';       Hot = '2'; Act = 'start';      Dim = -not $has },
        @{ Label = 'Save the viewer''s log to a file';    Hot = '3'; Act = 'log';        Dim = -not $has },
        @{ Label = 'Take a screenshot';                   Hot = '4'; Act = 'screenshot'; Dim = -not $has },
        @{ Label = 'Open a shell on the device';          Hot = '5'; Act = 'shell';      Dim = -not $has },
        @{ Label = 'Switch to adb over Wi-Fi';            Hot = '6'; Act = 'wifi';       Dim = -not $has; Note = 'then the cable can go' },
        @{ Label = 'Connect over Wi-Fi by IP';            Hot = '7'; Act = 'connect' },
        @{ Label = 'Uninstall an app';                    Hot = '8'; Act = 'uninstall';  Dim = -not $has },
        @{ Label = 'Scan and reconnect to devices';       Hot = 'r'; Act = 'scan';       Note = $scanNote },
        @{ Label = $pathLabel;                            Hot = 'p'; Act = 'path';       Note = $pathNote },
        @{ Label = 'Make desktop and Start menu shortcuts'; Hot = 's'; Act = 'shortcuts' },
        @{ Label = 'Quit';                                Hot = 'q'; Act = 'quit' }
    )
    # Start on the install when a device is online, on the scan when none is
    $sel = $last
    if ($sel -lt 0) { $sel = 0; if (-not $has) { $sel = 8 } }

    $n = Show-Menu 'What next?' $items $sel
    if ($n -lt 0) { $n = $items.Count - 1 } # Esc on the main menu = quit
    $last = $n
    $act = $items[$n].Act
    Clear-Host
    if ($act -eq 'quit') { exit 0 }

    $result = $null
    if ($act -eq 'install') { $result = Do-Install }
    elseif ($act -eq 'start') { Do-Start }
    elseif ($act -eq 'log') { Do-Log }
    elseif ($act -eq 'screenshot') { Do-Screenshot }
    elseif ($act -eq 'shell') { Do-Shell }
    elseif ($act -eq 'wifi') { Do-WifiSwitch }
    elseif ($act -eq 'connect') { $result = Do-WifiConnect }
    elseif ($act -eq 'uninstall') { Do-Uninstall }
    elseif ($act -eq 'scan') { Connect-Device }
    elseif ($act -eq 'path') { Switch-UserPath }
    elseif ($act -eq 'shortcuts') { New-Shortcuts }

    Update-Devices
    if ($result -ne 'back') { Wait-Key }
}
