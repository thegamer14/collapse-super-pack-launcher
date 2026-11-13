param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Arguments = '',
  [ValidateSet('window', 'fullscreen', 'borderless')][string]$Mode = 'fullscreen',
  [int]$Width = 0,
  [int]$Height = 0,
  [int]$WindowWidth = 0,
  [int]$WindowHeight = 0,
  [string]$WorkingDirectory = ''
)

# Starts a game for modern displays.
#
# These games draw at a fixed 640x480 / 800x600 and ignore their window size.
# The only lever that scales them is the display mode: switch the desktop to the
# game's own resolution, let the GPU scale that to the panel, run the game
# borderless on top of it, and put the desktop back when the game exits.
#
# A DPI-unaware game is bitmap-virtualised by Windows (800x600 becomes 1000x750
# at 125% scaling, so it no longer fits the mode), so the exe is marked DPI-aware
# through the per-app compatibility layer before it starts.

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class GameDisplay
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion;
        public short dmDriverVersion;
        public short dmSize;
        public short dmDriverExtra;
        public int dmFields;
        public int dmPositionX;
        public int dmPositionY;
        public int dmDisplayOrientation;
        public int dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel;
        public int dmPelsWidth;
        public int dmPelsHeight;
        public int dmDisplayFlags;
        public int dmDisplayFrequency;
        public int dmICMMethod;
        public int dmICMIntent;
        public int dmMediaType;
        public int dmDitherType;
        public int dmReserved1;
        public int dmReserved2;
        public int dmPanningWidth;
        public int dmPanningHeight;
    }

    public const int WM_SYSCOMMAND = 0x0112;
    public const int SC_RESTORE = 0xF120;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int ChangeDisplaySettings(ref DEVMODE devMode, int flags);

    [DllImport("user32.dll")]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);

    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    public static extern bool AdjustWindowRect(ref RECT rect, uint style, bool menu);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr FindWindowFor(int pid, out int width, out int height)
    {
        IntPtr found = IntPtr.Zero;
        int best = 0;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == (uint)pid && IsWindowVisible(hWnd))
            {
                RECT r;
                GetWindowRect(hWnd, out r);
                int area = (r.Right - r.Left) * (r.Bottom - r.Top);
                if (area > best) { best = area; found = hWnd; }
            }
            return true;
        }, IntPtr.Zero);
        width = 0; height = 0;
        if (found != IntPtr.Zero)
        {
            RECT r;
            GetWindowRect(found, out r);
            width = r.Right - r.Left;
            height = r.Bottom - r.Top;
        }
        return found;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    public static DEVMODE Current()
    {
        DEVMODE dm = new DEVMODE();
        dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        EnumDisplaySettings(null, -1, ref dm);
        return dm;
    }

    public static int SetMode(int width, int height, short bpp, int frequency)
    {
        DEVMODE dm = new DEVMODE();
        dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        dm.dmPelsWidth = width;
        dm.dmPelsHeight = height;
        dm.dmBitsPerPel = bpp;
        dm.dmDisplayFrequency = frequency;
        dm.dmFields = 0x00080000 | 0x00100000 | 0x00040000 | 0x00400000;
        return ChangeDisplaySettings(ref dm, 0x01);
    }
}
'@

$WS_CAPTION = 0x00C00000
$WS_THICKFRAME = 0x00040000
$GWL_STYLE = -16

$script:original = $null
$script:taskbar = [IntPtr]::Zero

function Save-Display {
  $script:original = [GameDisplay]::Current()
}

function Restore-Display {
  if ($null -ne $script:original) {
    [void][GameDisplay]::SetMode($script:original.dmPelsWidth, $script:original.dmPelsHeight, $script:original.dmBitsPerPel, $script:original.dmDisplayFrequency)
  }
  if ($script:taskbar -ne [IntPtr]::Zero) {
    [void][GameDisplay]::ShowWindow($script:taskbar, 5)
    $script:taskbar = [IntPtr]::Zero
  }
}

function Wait-GameWindow {
  param([System.Diagnostics.Process]$Process, [int]$TimeoutSeconds = 25)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($Process.HasExited) { return [IntPtr]::Zero }
    $Process.Refresh()
    $handle = $Process.MainWindowHandle
    if ($handle -ne [IntPtr]::Zero) { return $handle }
    Start-Sleep -Milliseconds 250
  }
  return [IntPtr]::Zero
}

function Make-Borderless {
  param([IntPtr]$Handle, [int]$W, [int]$H)
  $style = [GameDisplay]::GetWindowLongPtr($Handle, $GWL_STYLE).ToInt64()
  $style = $style -band (-bnot ($WS_CAPTION -bor $WS_THICKFRAME))
  [void][GameDisplay]::SetWindowLongPtr($Handle, $GWL_STYLE, [IntPtr]$style)
  [void][GameDisplay]::SetWindowPos($Handle, [IntPtr](-1), 0, 0, $W, $H, 0x0040)
  [void][GameDisplay]::SetForegroundWindow($Handle)
}

# A game's exe is marked DPI-aware so it draws 1:1 at its own resolution instead
# of being bitmap-virtualised by Windows display scaling.
$layers = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
try {
  if (-not (Test-Path $layers)) { New-Item -Path $layers -Force | Out-Null }
  Set-ItemProperty -Path $layers -Name $Exe -Value 'HIGHDPIAWARE' -ErrorAction Stop
} catch {
  Write-Output "compat layer not set: $($_.Exception.Message)"
}

$runDir = Split-Path -Parent $Exe
if ($WorkingDirectory -and (Test-Path $WorkingDirectory)) { $runDir = $WorkingDirectory }

$startArgs = @{
  FilePath = $Exe
  WorkingDirectory = $runDir
  PassThru = $true
}
if ($Arguments) { $startArgs['ArgumentList'] = $Arguments }

if ($Mode -eq 'window') {
  $process = Start-Process @startArgs
  if ($WindowWidth -gt 0 -and $WindowHeight -gt 0) {
    $handle = Wait-GameWindow -Process $process
    if ($handle -ne [IntPtr]::Zero) {
      $rect = New-Object GameDisplay+RECT
      $rect.Right = $WindowWidth
      $rect.Bottom = $WindowHeight
      [void][GameDisplay]::AdjustWindowRect([ref]$rect, 0x00CF0000, $false)
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      $screenW = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
      $screenH = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
      $x = [Math]::Max(0, [int](($screenW - $w) / 2))
      $y = [Math]::Max(0, [int](($screenH - $h) / 2))
      [void][GameDisplay]::SetWindowPos($handle, [IntPtr]::Zero, $x, $y, $w, $h, 0x0040)
      [void][GameDisplay]::SetForegroundWindow($handle)
    }
  }
  exit 0
}

# borderless: the engine already draws at any size, so just fill the screen
if ($Mode -eq 'borderless') {
  try {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $w = if ($Width -gt 0) { $Width } else { $screen.Width }
    $h = if ($Height -gt 0) { $Height } else { $screen.Height }

    $script:taskbar = [GameDisplay]::FindWindow('Shell_TrayWnd', $null)
    if ($script:taskbar -ne [IntPtr]::Zero) { [void][GameDisplay]::ShowWindow($script:taskbar, 0) }

    $process = Start-Process @startArgs
    $handle = Wait-GameWindow -Process $process
    if ($handle -ne [IntPtr]::Zero) {
      [void][GameDisplay]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $w, $h, 0x0040)
      Make-Borderless -Handle $handle -W $w -H $h
    }
    $process.WaitForExit()
  } finally {
    Restore-Display
  }
  exit 0
}

# fullscreen: switch the desktop to the game's own mode, run it borderless, restore
try {
  Save-Display
  if ($Width -gt 0 -and $Height -gt 0) {
    $rc = [GameDisplay]::SetMode($Width, $Height, $script:original.dmBitsPerPel, $script:original.dmDisplayFrequency)
    if ($rc -ne 0) {
      # frequency may not exist in that mode; let Windows choose one
      $rc = [GameDisplay]::SetMode($Width, $Height, $script:original.dmBitsPerPel, 0)
    }
    if ($rc -ne 0) { Write-Output "display mode $Width x $Height not available ($rc)" }
    Start-Sleep -Milliseconds 900
  }

  $script:taskbar = [GameDisplay]::FindWindow('Shell_TrayWnd', $null)
  if ($script:taskbar -ne [IntPtr]::Zero) { [void][GameDisplay]::ShowWindow($script:taskbar, 0) }

  $process = Start-Process @startArgs
  $handle = Wait-GameWindow -Process $process
  if ($handle -ne [IntPtr]::Zero) {
    $w = if ($Width -gt 0) { $Width } else { 800 }
    $h = if ($Height -gt 0) { $Height } else { 600 }
    Make-Borderless -Handle $handle -W $w -H $h
  }

  $process.WaitForExit()
} finally {
  Restore-Display
}
