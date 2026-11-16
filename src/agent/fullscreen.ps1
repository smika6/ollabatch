# rigpool agent: every 5 s, print one JSON line describing the foreground
# window (is it fullscreen, on which monitor and adapter), per-process GPU
# engine use, and the Ollama processes (to tell the agent's own GPU use apart).
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less files as Windows-1252.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class RpWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)] public struct MONITORINFOEX {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)] public struct DISPLAY_DEVICE {
    public int cb; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString; public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFOEX mi);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool EnumDisplayDevices(string dev, uint i, ref DISPLAY_DEVICE dd, uint flags);
}
"@
[void][RpWin]::SetProcessDPIAware()

function Adapters {
  $map = @{}
  for ($i = 0; $i -lt 16; $i++) {
    $dd = New-Object RpWin+DISPLAY_DEVICE; $dd.cb = [Runtime.InteropServices.Marshal]::SizeOf($dd)
    # [NullString]: PowerShell would pass $null as "", which names no device.
    if (-not [RpWin]::EnumDisplayDevices([NullString]::Value, $i, [ref]$dd, 0)) { break }
    $map[$dd.DeviceName] = $dd.DeviceString
  }
  $map
}

$adapters = Adapters
while ($true) {
  $fg = $null
  $h = [RpWin]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero) {
    $r = New-Object RpWin+RECT; [void][RpWin]::GetWindowRect($h, [ref]$r)
    $procId = [uint32]0; [void][RpWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $m = [RpWin]::MonitorFromWindow($h, 2)
    $mi = New-Object RpWin+MONITORINFOEX; $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    [void][RpWin]::GetMonitorInfo($m, [ref]$mi)
    $sb = New-Object Text.StringBuilder 256; [void][RpWin]::GetClassName($h, $sb, 256)
    # Exactly the monitor: fullscreen and borderless games match it; a maximized
    # window overhangs it by its resize border, so it doesn't count.
    $full = ($r.L -eq $mi.rcMonitor.L) -and ($r.T -eq $mi.rcMonitor.T) -and ($r.R -eq $mi.rcMonitor.R) -and ($r.B -eq $mi.rcMonitor.B)
    $exe = (Get-Process -Id $procId).ProcessName
    if (-not $adapters.ContainsKey($mi.szDevice)) { $adapters = Adapters }
    $fg = @{ pid = [int]$procId; exe = $exe; cls = $sb.ToString(); fullscreen = [bool]$full; monitor = $mi.szDevice; adapter = $adapters[$mi.szDevice] }
  }
  $engines = @(foreach ($s in (Get-Counter '\GPU Engine(*)\Utilization Percentage').CounterSamples) {
    if ($s.CookedValue -gt 0 -and $s.InstanceName -match '^pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_.*engtype_(.+)$') {
      @{ pid = [int]$Matches[1]; luid = $Matches[2]; engtype = $Matches[3]; util = [math]::Round($s.CookedValue, 1) }
    }
  })
  $procs = @(Get-CimInstance Win32_Process -Filter "Name like 'ollama%' or Name like 'llama-server%'" | ForEach-Object { @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name } })
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject @{ fg = $fg; engines = $engines; procs = $procs }))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 5
}
