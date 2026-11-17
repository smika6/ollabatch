# ollabatch agent: Intel GPU temperature, power and use from Intel's Graphics
# Control Library (ControlLib.dll, installed with Arc drivers). Every 5 s it
# prints one JSON line: {"devices":[{"luid","name","tempC","powerW","util"}]}.
# Its own process, so a fault in the vendor DLL can't stop the agent's other
# sampler. Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less files as
# Windows-1252.
#
# Found on a real A770 (driver library 1.1.240): a library session returns good
# telemetry only on its first read (later reads come back zeroed), so it is
# opened per sample; the energy counter is only consistent within one process,
# so power is the energy difference between this process's own samples.
$ErrorActionPreference = 'SilentlyContinue'
if (-not (Test-Path (Join-Path $env:SystemRoot 'System32\ControlLib.dll'))) { exit 3 }
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class ObIgcl {
  [DllImport("ControlLib.dll")] public static extern int ctlInit(byte[] args, out IntPtr api);
  [DllImport("ControlLib.dll")] public static extern int ctlClose(IntPtr api);
  [DllImport("ControlLib.dll")] public static extern int ctlEnumerateDevices(IntPtr api, ref uint count, IntPtr[] devs);
  [DllImport("ControlLib.dll")] public static extern int ctlGetDeviceProperties(IntPtr dev, byte[] props);
  [DllImport("ControlLib.dll")] public static extern int ctlPowerTelemetryGet(IntPtr dev, byte[] t);
}
"@

# ctl_power_telemetry_t: Size, Version, then 24-byte items { bool supported;
# int units; int type; 8-byte value } from offset 8. The library takes any
# Size from 200 up and fills what it has.
function Item($b, $off) {
  if ($b[$off] -eq 0) { return $null }
  $type = [BitConverter]::ToInt32($b, $off + 8)
  switch ($type) { 9 { [BitConverter]::ToDouble($b, $off + 16) } 8 { [double][BitConverter]::ToSingle($b, $off + 16) } 7 { [double][BitConverter]::ToUInt64($b, $off + 16) } default { $null } }
}

$prev = @{}   # luid -> { t, energy, activity }
while ($true) {
  $out = @()
  $init = New-Object byte[] 36
  [BitConverter]::GetBytes([uint32]36).CopyTo($init, 0)
  [BitConverter]::GetBytes([uint32]((1 -shl 16) -bor 1)).CopyTo($init, 8)   # API version 1.1
  [BitConverter]::GetBytes([uint32]1).CopyTo($init, 12)                     # use Level Zero (telemetry)
  $api = [IntPtr]::Zero
  if ([ObIgcl]::ctlInit($init, [ref]$api) -eq 0) {
    [uint32]$n = 0
    [void][ObIgcl]::ctlEnumerateDevices($api, [ref]$n, $null)
    $devs = New-Object IntPtr[] $n
    [void][ObIgcl]::ctlEnumerateDevices($api, [ref]$n, $devs)
    foreach ($d in $devs) {
      $luidBuf = [Runtime.InteropServices.Marshal]::AllocHGlobal(8)
      $p = New-Object byte[] 4096
      [BitConverter]::GetBytes([uint32]128).CopyTo($p, 0)
      [BitConverter]::GetBytes([int64]$luidBuf).CopyTo($p, 8)
      [BitConverter]::GetBytes([uint32]8).CopyTo($p, 16)
      if ([ObIgcl]::ctlGetDeviceProperties($d, $p) -ne 0) { [Runtime.InteropServices.Marshal]::FreeHGlobal($luidBuf); continue }
      $luid = '0x{0:x8}_0x{1:x8}' -f [Runtime.InteropServices.Marshal]::ReadInt32($luidBuf, 4), [Runtime.InteropServices.Marshal]::ReadInt32($luidBuf, 0)
      [Runtime.InteropServices.Marshal]::FreeHGlobal($luidBuf)
      $name = [Text.Encoding]::ASCII.GetString($p, 88, 100).Split([char]0)[0]
      $b = New-Object byte[] 8192
      [BitConverter]::GetBytes([uint32]200).CopyTo($b, 0)
      if ([ObIgcl]::ctlPowerTelemetryGet($d, $b) -ne 0) { continue }
      $t = Item $b 8; $energy = Item $b 32; $temp = Item $b 104; $act = Item $b 128
      $row = @{ luid = $luid; name = $name; tempC = $null; powerW = $null; util = $null }
      if ($temp -gt 0 -and $temp -lt 150) { $row.tempC = [math]::Round($temp) }
      $last = $prev[$luid]
      if ($last -and $t -gt $last.t) {
        $w = ($energy - $last.energy) / ($t - $last.t)
        if ($w -ge 0 -and $w -lt 1000) { $row.powerW = [math]::Round($w, 1) }
        $u = 100 * ($act - $last.activity) / ($t - $last.t)
        if ($u -ge 0 -and $u -le 101) { $row.util = [math]::Min(100, [math]::Round($u)) }
      }
      if ($t -gt 0) { $prev[$luid] = @{ t = $t; energy = $energy; activity = $act } }
      $out += $row
    }
    [void][ObIgcl]::ctlClose($api)
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject @{ devices = $out }))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 5
}
