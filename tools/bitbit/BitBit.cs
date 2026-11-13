using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace BitBit
{
    /// <summary>
    /// BitBit presents a fixed-resolution GDI game (these titles all draw 640x480
    /// or 800x600 and ignore their window size) at a modern resolution, at the
    /// monitor's own refresh rate.
    ///
    /// It is a tiny, purpose-built dgVoodoo: instead of wrapping DirectDraw it
    /// captures the game's window and re-presents it, because these engines never
    /// touch Direct3D at all. Presentation is paced by DwmFlush, so one frame goes
    /// up per composed frame of the display instead of on a timer.
    ///
    /// Input is the interesting part. The window belongs to another process and
    /// the game reads the real cursor (GetCursorPos), so synthetic messages are
    /// ignored. Rather than hiding the cursor and drawing a copy, BitBit slides the
    /// game's window underneath the player's real cursor: the game pixel under the
    /// pointer is the pixel being pointed at. So the cursor the system draws is the
    /// game's own cursor at the right place, and clicks are ordinary mouse messages
    /// that reach the game through the click-through overlay. One pointer, no
    /// drift, no duplicated arrows. The slide happens on the mouse event itself,
    /// so a fast flick cannot outrun the window.
    /// </summary>
    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }

        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TRANSPARENT = 0x00000020;
        public const int WS_EX_LAYERED = 0x00080000;
        public const int WS_EX_NOACTIVATE = 0x08000000;
        public const int WS_EX_TOOLWINDOW = 0x00000080;

        // the chase hook only needs to know that the pointer moved or was pressed
        public const int WH_MOUSE_LL = 14;
        public const int WM_MOUSEMOVE = 0x0200;
        public const int WM_LBUTTONDOWN = 0x0201;
        public const int WM_LBUTTONUP = 0x0202;
        public const int WM_RBUTTONDOWN = 0x0204;
        public const int WM_HOTKEY = 0x0312;

        public const int SRCCOPY = 0x00CC0020;
        public const int HALFTONE = 4;
        public const int COLORONCOLOR = 3;
        public const uint LWA_ALPHA = 0x00000002;
        public const int MOD_ALT = 1;
        public const int MOD_CONTROL = 2;

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public static readonly IntPtr HWND_TOP = new IntPtr(0);
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;

        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
        [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr none);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint colorKey, byte alpha, uint flags);
        [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, int modifiers, int key);
        [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr window, bool altTab);
        [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, IntPtr extra);
        [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, IntPtr data, uint flags);
        public const uint SPI_SETCURSORS = 0x0057;
        public const uint SPIF_SENDCHANGE = 0x0002;

        /// <summary>
        /// Reloads the cursor scheme. BitBit does not touch cursors (the real one
        /// is the pointer), but older builds blanked it, so the launcher still
        /// calls this on exit to put a user's cursors back.
        /// </summary>
        public static void ForceRestoreSystemCursors()
        {
            SystemParametersInfo(SPI_SETCURSORS, 0, IntPtr.Zero, SPIF_SENDCHANGE);
        }

        [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int width, int height, IntPtr src, int srcX, int srcY, int rop);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);
        [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr objectHandle);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr objectHandle);
        [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] public static extern bool StretchBlt(IntPtr dst, int x, int y, int width, int height, IntPtr src, int srcX, int srcY, int srcWidth, int srcHeight, int rop);
        [DllImport("gdi32.dll")] public static extern int SetStretchBltMode(IntPtr dc, int mode);
        [DllImport("gdi32.dll")] public static extern bool SetBrushOrgEx(IntPtr dc, int x, int y, IntPtr previous);

        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFOHEADER
        {
            public int Size, Width, Height;
            public short Planes, BitCount;
            public int Compression, SizeImage, XPelsPerMeter, YPelsPerMeter, ClrUsed, ClrImportant;
        }

        [DllImport("gdi32.dll")] public static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint start, uint lines, byte[] bits, ref BITMAPINFOHEADER info, uint usage);
        [DllImport("msvcrt.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int memcmp(byte[] a, byte[] b, IntPtr count);
        [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr dc, int index);
        public const int VREFRESH = 116;

        [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int hook, ChaseProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string name);
        public delegate IntPtr ChaseProc(int code, IntPtr wParam, IntPtr lParam);

        // dwmapi paces us to the display; winmm lets Sleep wake on time
        [DllImport("dwmapi.dll")] public static extern int DwmFlush();
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint period);
        [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint period);

        /// <summary>The monitor's current refresh rate in Hz.</summary>
        public static int RefreshRate()
        {
            int hz = 0;
            IntPtr dc = GetDC(IntPtr.Zero);
            try { hz = GetDeviceCaps(dc, VREFRESH); }
            finally { ReleaseDC(IntPtr.Zero, dc); }
            // 0 and 1 mean "the hardware default"; 60 is the safe reading
            return hz <= 1 ? 60 : hz;
        }

    }

    /// <summary>Command-line options, all optional except the game itself.</summary>
    class Options
    {
        public string Exe;
        public string Arguments = "";
        public string WorkingDirectory;
        public int Width;
        public int Height;
        public bool Stretch;
        public bool Debug;
        public bool Nearest;

        public static Options Parse(string[] args)
        {
            Options options = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--exe": options.Exe = Next(args, ref i); break;
                    case "--args": options.Arguments = Next(args, ref i); break;
                    case "--cwd": options.WorkingDirectory = Next(args, ref i); break;
                    case "--width": options.Width = Int(Next(args, ref i)); break;
                    case "--height": options.Height = Int(Next(args, ref i)); break;
                    case "--stretch": options.Stretch = true; break;
                    case "--nearest": options.Nearest = true; break;
                    case "--debug": options.Debug = true; break;
                }
            }
            return options;
        }

        static string Next(string[] args, ref int i)
        {
            return i + 1 < args.Length ? args[++i] : "";
        }

        static int Int(string text)
        {
            int value;
            return int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ? value : 0;
        }
    }

    class Overlay : Form
    {
        readonly IntPtr gameWindow;
        readonly bool stretch;
        readonly bool halftone;
        readonly int requestedWidth;
        readonly int requestedHeight;

        readonly Font labelFont = new Font("Segoe UI", 10f);
        readonly Brush labelBrush = new SolidBrush(Color.FromArgb(210, 255, 255, 255));

        Bitmap frame;
        IntPtr memoryDc;
        IntPtr memoryBitmap;

        // the scaled picture, kept between refreshes: the HALFTONE stretch costs
        // about 10 ms at 1080p, so it runs only when the game's frame changed and
        // every refresh just copies it 1:1 (about 1.5 ms)
        IntPtr scaledDc;
        IntPtr scaledBitmap;
        int scaledWidth;
        int scaledHeight;
        byte[] previousPixels;
        byte[] currentPixels;
        bool havePixels;
        DateTime lastStretch = DateTime.MinValue;
        int stretchCount;
        int gameWidth;
        int gameHeight;
        Point gameOrigin;        // where the game's client area is on screen
        Point clientOffset;      // window origin -> client origin
        int placedX = int.MinValue;
        int placedY = int.MinValue;
        Rectangle target;
        double scaleX;
        double scaleY;
        int hotkey;

        bool active = true;
        bool shown;

        volatile bool presenting = true;
        int paintQueued;
        IntPtr chaseHook;
        Native.ChaseProc chaseProc;   // keep alive: the hook calls into this
        DateTime started = DateTime.UtcNow;
        static readonly Stopwatch clock = Stopwatch.StartNew();
        long frames;
        double lastGrabMs;
        double stretchMsLast;
        double stretchMsTotal;
        double frameMsTotal;
        double worstFrameMs;
        DateTime lastReport = DateTime.UtcNow;
        DateTime lastTopmost = DateTime.MinValue;
        static readonly string logFile = Environment.GetEnvironmentVariable("BITBIT_LOG");

        public Overlay(IntPtr window, Options options)
        {
            gameWindow = window;
            stretch = options.Stretch;
            halftone = !options.Nearest;
            requestedWidth = options.Width;
            requestedHeight = options.Height;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = Screen.PrimaryScreen.Bounds;
            TopMost = true;
            ShowInTaskbar = false;
            BackColor = Color.Black;
            DoubleBuffered = true;
            KeyPreview = false;
            Text = "BitBit";

            MeasureGame();
            AllocateFrame();
            ComputeTarget();

            StartPresenting();
            InstallChase();

            Log(string.Format(
                "start game={0}x{1} at ({2},{3}) target={4}x{5} at ({6},{7}) scale={8:0.###}x{9:0.###} stretch={10}",
                gameWidth, gameHeight, gameOrigin.X, gameOrigin.Y,
                target.Width, target.Height, target.Left, target.Top,
                scaleX, scaleY, stretch));
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                // transparent to the mouse so real clicks reach the game below,
                // never activated so the game keeps keyboard focus
                cp.ExStyle |= Native.WS_EX_TRANSPARENT | Native.WS_EX_LAYERED | Native.WS_EX_NOACTIVATE | Native.WS_EX_TOOLWINDOW;
                return cp;
            }
        }

        static void Log(string message)
        {
            if (logFile == null) return;
            try
            {
                File.AppendAllText(logFile, string.Format("[{0}] {1}\r\n", clock.ElapsedMilliseconds, message));
            }
            catch { }
        }

        /// <summary>A memory surface sized to the game, used to capture and scale.</summary>
        void AllocateFrame()
        {
            if (frame != null) frame.Dispose();
            if (memoryBitmap != IntPtr.Zero) Native.DeleteObject(memoryBitmap);
            if (memoryDc != IntPtr.Zero) Native.DeleteDC(memoryDc);

            frame = new Bitmap(Math.Max(1, gameWidth), Math.Max(1, gameHeight), PixelFormat.Format32bppPArgb);
            IntPtr windowDc = Native.GetDC(Handle);
            memoryDc = Native.CreateCompatibleDC(windowDc);
            memoryBitmap = Native.CreateCompatibleBitmap(windowDc, Math.Max(1, gameWidth), Math.Max(1, gameHeight));
            Native.SelectObject(memoryDc, memoryBitmap);
            Native.ReleaseDC(Handle, windowDc);

            currentPixels = new byte[gameWidth * gameHeight * 4];
            previousPixels = new byte[currentPixels.Length];
            havePixels = false;
            scaledWidth = 0;
            scaledHeight = 0;
        }

        /// <summary>The cached scaled picture, resized when the target size changes.</summary>
        void EnsureScaledSurface(Rectangle picture)
        {
            if (scaledDc != IntPtr.Zero && scaledWidth == picture.Width && scaledHeight == picture.Height) return;

            if (scaledBitmap != IntPtr.Zero) Native.DeleteObject(scaledBitmap);
            if (scaledDc != IntPtr.Zero) Native.DeleteDC(scaledDc);

            IntPtr windowDc = Native.GetDC(Handle);
            scaledDc = Native.CreateCompatibleDC(windowDc);
            scaledBitmap = Native.CreateCompatibleBitmap(windowDc, Math.Max(1, picture.Width), Math.Max(1, picture.Height));
            Native.SelectObject(scaledDc, scaledBitmap);
            Native.ReleaseDC(Handle, windowDc);
            scaledWidth = picture.Width;
            scaledHeight = picture.Height;
            lastStretch = DateTime.MinValue;
        }

        /// <summary>
        /// True when the game's frame differs from the one already scaled. Reading
        /// the 800x600 frame back and comparing it costs about 0.8 ms, against the
        /// 10 ms the stretch costs, which is what lets the picture go up at the
        /// display's refresh rate while the game itself repaints at its own pace.
        /// </summary>
        bool FrameChanged()
        {
            Native.BITMAPINFOHEADER info = new Native.BITMAPINFOHEADER();
            info.Size = Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
            info.Width = gameWidth;
            info.Height = -gameHeight;   // top-down
            info.Planes = 1;
            info.BitCount = 32;
            if (Native.GetDIBits(memoryDc, memoryBitmap, 0, (uint)gameHeight, currentPixels, ref info, 0)
                != gameHeight)
            {
                return true;
            }

            bool changed = !havePixels
                || Native.memcmp(previousPixels, currentPixels, new IntPtr(currentPixels.Length)) != 0;

            byte[] swap = previousPixels;
            previousPixels = currentPixels;
            currentPixels = swap;
            havePixels = true;
            return changed;
        }

        /// <summary>Scales the captured frame into the cached picture surface.</summary>
        void ScaleInto(Rectangle picture)
        {
            Native.SetStretchBltMode(scaledDc, halftone ? Native.HALFTONE : Native.COLORONCOLOR);
            if (halftone) Native.SetBrushOrgEx(scaledDc, 0, 0, IntPtr.Zero);
            Native.StretchBlt(scaledDc, 0, 0, scaledWidth, scaledHeight,
                memoryDc, 0, 0, gameWidth, gameHeight, Native.SRCCOPY);
            lastStretch = DateTime.UtcNow;
            stretchCount++;
        }

        void MeasureGame()
        {
            Native.RECT client;
            if (!Native.GetClientRect(gameWindow, out client) || client.Right <= 0 || client.Bottom <= 0)
            {
                throw new InvalidOperationException("The game window has no client area yet.");
            }
            gameWidth = client.Right;
            gameHeight = client.Bottom;

            Native.POINT origin = new Native.POINT();
            Native.ClientToScreen(gameWindow, ref origin);
            gameOrigin = new Point(origin.X, origin.Y);

            Native.RECT window;
            if (Native.GetWindowRect(gameWindow, out window))
            {
                clientOffset = new Point(origin.X - window.Left, origin.Y - window.Top);
            }
        }

        void ComputeTarget()
        {
            Rectangle screen = Screen.PrimaryScreen.Bounds;
            int width = requestedWidth > 0 ? requestedWidth : screen.Width;
            int height = requestedHeight > 0 ? requestedHeight : screen.Height;
            width = Math.Min(width, screen.Width);
            height = Math.Min(height, screen.Height);
            target = new Rectangle((screen.Width - width) / 2, (screen.Height - height) / 2, width, height);

            // Fill stretches the game to the whole box (widescreen); Fit keeps
            // the game's own shape with bars at the sides.
            if (stretch)
            {
                scaleX = (double)target.Width / gameWidth;
                scaleY = (double)target.Height / gameHeight;
            }
            else
            {
                scaleX = scaleY = Math.Min((double)target.Width / gameWidth, (double)target.Height / gameHeight);
            }
        }

        Rectangle Picture()
        {
            int width = (int)Math.Round(gameWidth * scaleX);
            int height = (int)Math.Round(gameHeight * scaleY);
            return new Rectangle(target.Left + (target.Width - width) / 2, target.Top + (target.Height - height) / 2, width, height);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Native.SetLayeredWindowAttributes(Handle, 0, 255, Native.LWA_ALPHA);
            Log("shown");
            shown = true;
            active = true;

            if (Native.IsIconic(gameWindow)) Native.ShowWindow(gameWindow, 9); // SW_RESTORE
            Native.SetWindowPos(gameWindow, Native.HWND_TOP, 0, 0, 0, 0,
                Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            ForceGameForeground();

            if (hotkey == 0)
            {
                hotkey = 0xB001;
                Native.RegisterHotKey(Handle, hotkey, Native.MOD_CONTROL | Native.MOD_ALT, 0x7B); // Ctrl+Alt+F12
            }

            TrackPointer();
        }

        /// <summary>
        /// Presents once per composed frame, so the picture runs at the monitor's
        /// refresh rate rather than on a fixed 16 ms timer. DwmFlush blocks until
        /// the next frame is composed; when composition is unavailable (remote
        /// sessions, some VMs) the loop falls back to sleeping one refresh.
        /// </summary>
        void StartPresenting()
        {
            int refresh = Native.RefreshRate();
            Native.timeBeginPeriod(1);
            Log(string.Format("presenting at {0} Hz", refresh));

            Thread thread = new Thread(delegate()
            {
                while (presenting)
                {
                    // clock first, then wait: the paint then has the whole vblank
                    // interval to finish, instead of being queued after the wait
                    bool composited = Native.DwmFlush() == 0;
                    if (!shown)
                    {
                        if (!composited) Thread.Sleep(8);
                        else Thread.Sleep(2);
                        continue;
                    }
                    // one frame in flight at a time: painting is slower than the
                    // display on the big resolutions, and a backlog would grow
                    if (Interlocked.Exchange(ref paintQueued, 1) != 0) continue;
                    try
                    {
                        BeginInvoke(new MethodInvoker(delegate()
                        {
                            Interlocked.Exchange(ref paintQueued, 0);
                            FollowForeground();
                            TrackPointer();
                            if (active) Invalidate();
                        }));
                    }
                    catch
                    {
                        Interlocked.Exchange(ref paintQueued, 0);
                        Thread.Sleep(8);
                    }
                    if (!composited) Thread.Sleep(Math.Max(1, 1000 / Math.Max(30, refresh)));
                }
                Native.timeEndPeriod(1);
            });
            thread.IsBackground = true;
            thread.Start();
        }

        /// <summary>
        /// Slides the window on the mouse event itself instead of waiting for the
        /// next frame. A fast flick crosses 800 pixels in a few milliseconds, so
        /// waiting for a frame lets the cursor leave the game and a click can land
        /// on the overlay instead. Moving a window from inside the hook is safe
        /// (warping the cursor there is not, which is why BitBit never does it).
        /// </summary>
        void InstallChase()
        {
            chaseProc = OnMouseEvent;
            chaseHook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, chaseProc, Native.GetModuleHandle(null), 0);
            Log(chaseHook == IntPtr.Zero ? "chase hook failed" : "chase hook installed");
        }

        IntPtr OnMouseEvent(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && shown && active)
            {
                int message = wParam.ToInt32();
                if (message == Native.WM_MOUSEMOVE || message == Native.WM_LBUTTONDOWN
                    || message == Native.WM_LBUTTONUP || message == Native.WM_RBUTTONDOWN)
                {
                    TrackPointer();
                }
            }
            return Native.CallNextHookEx(chaseHook, code, wParam, lParam);
        }

        /// <summary>
        /// Slides the game's window so the game pixel under the player's real cursor
        /// is the pixel they are pointing at. The cursor therefore never leaves the
        /// game: the system draws the game's own cursor (arrow, hand, whatever it
        /// sets) at the right place, and clicks arrive as ordinary mouse messages
        /// because the overlay is click-through. One cursor, no warping, no drift.
        /// </summary>
        void TrackPointer()
        {
            if (!Native.IsWindow(gameWindow)) return;
            Native.POINT screen;
            if (!Native.GetCursorPos(out screen)) return;

            Rectangle picture = Picture();
            int gameX = (int)Math.Round((screen.X - picture.Left) / scaleX);
            int gameY = (int)Math.Round((screen.Y - picture.Top) / scaleY);
            gameX = Math.Min(Math.Max(gameX, 0), Math.Max(0, gameWidth - 1));
            gameY = Math.Min(Math.Max(gameY, 0), Math.Max(0, gameHeight - 1));

            PlaceGameWindow(screen.X - gameX, screen.Y - gameY);
        }

        /// <summary>Puts the game's client area at a screen position, client pixels.</summary>
        void PlaceGameWindow(int clientX, int clientY)
        {
            int wantedX = clientX - clientOffset.X;
            int wantedY = clientY - clientOffset.Y;
            if (wantedX == placedX && wantedY == placedY) return;

            placedX = wantedX;
            placedY = wantedY;
            Native.SetWindowPos(gameWindow, Native.HWND_TOP, wantedX, wantedY, 0, 0,
                Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            gameOrigin = new Point(clientX, clientY);
        }

        /// <summary>
        /// The game must be the foreground window: that is what gives it the
        /// keyboard, and it is how real clicks reach it through the overlay.
        /// </summary>
        void ForceGameForeground()
        {
            if (IsGameWindow(Native.GetForegroundWindow())) return;
            Native.SetForegroundWindow(gameWindow);
            Native.SwitchToThisWindow(gameWindow, true);
            if (IsGameWindow(Native.GetForegroundWindow())) return;
            // the shell sometimes refuses SetForegroundWindow; a real Alt tap
            // lifts that restriction
            SendAltTap();
            Native.SetForegroundWindow(gameWindow);
            Native.SwitchToThisWindow(gameWindow, true);
            Log(string.Format("forced foreground -> {0}, game={1}", Native.GetForegroundWindow(), gameWindow));
        }

        static void SendAltTap()
        {
            Native.keybd_event(0x12, 0, 0, IntPtr.Zero);      // VK_MENU down
            Native.keybd_event(0x12, 0, 2, IntPtr.Zero);      // VK_MENU up
        }

        /// <summary>Hide while another program is in front; come back with the game.</summary>
        void FollowForeground()
        {
            if (!Native.IsWindow(gameWindow)) { Close(); return; }
            bool front = IsGameWindow(Native.GetForegroundWindow());
            if (front)
            {
                if (!shown)
                {
                    Log("game is in front again");
                    Show();
                    Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
                        Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
                    TrackPointer();
                }
            }
            else if (shown)
            {
                Log("another window is in front: hiding until the game returns");
                shown = false;
                active = false;
                // leave the game where it is normally seen, not half off screen
                PlaceGameWindow((Screen.PrimaryScreen.Bounds.Width - gameWidth) / 2,
                    (Screen.PrimaryScreen.Bounds.Height - gameHeight) / 2);
                Hide();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            presenting = false;
            if (chaseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(chaseHook);
            PlaceGameWindow((Screen.PrimaryScreen.Bounds.Width - gameWidth) / 2,
                (Screen.PrimaryScreen.Bounds.Height - gameHeight) / 2);
            if (hotkey != 0) Native.UnregisterHotKey(Handle, hotkey);
            Log(string.Format("closing after {0} frames, mean {1:0.0}ms, worst {2:0.0}ms",
                InterlockedFrames(), frames == 0 ? 0 : frameMsTotal / frames, worstFrameMs));
            base.OnFormClosing(e);
        }

        long InterlockedFrames() { return frames; }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY && m.WParam.ToInt32() == hotkey)
            {
                Log("hotkey: leaving scaled mode");
                Close();
                return;
            }
            base.WndProc(ref m);
        }

        // ---------------------------------------------------------- presenting

        /// <summary>Copies the game's client area into our memory surface.</summary>
        void GrabFrame()
        {
            IntPtr source = Native.GetDC(gameWindow);
            try
            {
                Native.BitBlt(memoryDc, 0, 0, gameWidth, gameHeight, source, 0, 0, Native.SRCCOPY);
            }
            finally
            {
                Native.ReleaseDC(gameWindow, source);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Native.RECT client;
            if (!Native.IsWindow(gameWindow) || !Native.GetClientRect(gameWindow, out client))
            {
                Close();
                return;
            }

            // the game switched resolution or was resized by something else
            if (client.Right != gameWidth || client.Bottom != gameHeight)
            {
                MeasureGame();
                AllocateFrame();
                ComputeTarget();
                placedX = int.MinValue;   // the window origin is new; place it again
                placedY = int.MinValue;
                TrackPointer();
            }

            Stopwatch paint = Stopwatch.StartNew();

            // stay above the game; re-asserting it every frame is not free
            if ((DateTime.UtcNow - lastTopmost).TotalMilliseconds >= 400)
            {
                lastTopmost = DateTime.UtcNow;
                Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
                    Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            }

            active = IsGameForeground();
            if (!active)
            {
                return;
            }

            Rectangle picture = Picture();
            EnsureScaledSurface(picture);

            Stopwatch grab = Stopwatch.StartNew();
            GrabFrame();
            bool changed = FrameChanged();
            // the safety re-stretch covers anything the comparison misses
            if (changed || (DateTime.UtcNow - lastStretch).TotalMilliseconds > 250)
            {
                Stopwatch stretch = Stopwatch.StartNew();
                ScaleInto(picture);
                stretch.Stop();
                stretchMsTotal += stretch.Elapsed.TotalMilliseconds;
                stretchMsLast = stretch.Elapsed.TotalMilliseconds;
            }
            grab.Stop();

            Graphics surface = e.Graphics;
            IntPtr hdc = surface.GetHdc();
            try
            {
                // 1:1 copy of the cached picture: what goes up every refresh
                Native.BitBlt(hdc, picture.Left, picture.Top, picture.Width, picture.Height,
                    scaledDc, 0, 0, Native.SRCCOPY);
            }
            finally
            {
                surface.ReleaseHdc(hdc);
            }

            if ((DateTime.UtcNow - started).TotalSeconds < 7)
            {
                string hint = "Ctrl+Alt+F12 returns to the unscaled game";
                SizeF size = e.Graphics.MeasureString(hint, labelFont);
                e.Graphics.DrawString(hint, labelFont, labelBrush, (ClientSize.Width - size.Width) / 2f, ClientSize.Height - size.Height - 14);
            }

            paint.Stop();
            lastGrabMs = grab.Elapsed.TotalMilliseconds;
            frames++;
            frameMsTotal += paint.Elapsed.TotalMilliseconds;
            if (paint.Elapsed.TotalMilliseconds > worstFrameMs) worstFrameMs = paint.Elapsed.TotalMilliseconds;

            if ((DateTime.UtcNow - lastReport).TotalSeconds >= 2)
            {
                lastReport = DateTime.UtcNow;
                Log(string.Format("frames={0} mean={1:0.0}ms worst={2:0.0}ms capture={3:0.0}ms stretches={4} last={5:0.0}ms game=({6},{7}) fg={8} active={9}",
                    frames, frameMsTotal / frames, worstFrameMs, lastGrabMs, stretchCount, stretchMsLast,
                    gameOrigin.X, gameOrigin.Y, Native.GetForegroundWindow(), active));
            }
        }

        bool IsGameForeground()
        {
            // a dialog owned by the game still counts as the game
            return IsGameWindow(Native.GetForegroundWindow());
        }

        [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
        static IntPtr GetParentOf(IntPtr window) { return GetParent(window); }

        bool IsGameWindow(IntPtr window)
        {
            if (window == gameWindow || window == Handle) return true;
            IntPtr root = window;
            for (int i = 0; i < 4 && root != IntPtr.Zero; i++)
            {
                if (root == gameWindow) return true;
                root = GetParentOf(root);
            }
            return false;
        }
    }

    static class Program
    {
        static IntPtr WaitForWindow(Process process, int timeoutMs)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                if (process.HasExited) return IntPtr.Zero;
                process.Refresh();
                IntPtr handle = process.MainWindowHandle;
                if (handle != IntPtr.Zero && Native.IsWindowVisible(handle))
                {
                    Native.RECT client;
                    if (Native.GetClientRect(handle, out client) && client.Right > 0) return handle;
                }
                System.Threading.Thread.Sleep(100);
            }
            return IntPtr.Zero;
        }

        [STAThread]
        static int Main(string[] args)
        {
            Native.SetProcessDPIAware();

            // recovery hook: the launcher runs this after the scaler exits, so a
            // crash can never leave the player without a mouse pointer
            foreach (string arg in args)
            {
                if (arg == "--restore-cursors")
                {
                    Native.ForceRestoreSystemCursors();
                    return 0;
                }
            }

            AppDomain.CurrentDomain.ProcessExit += delegate { Native.ForceRestoreSystemCursors(); };
            AppDomain.CurrentDomain.UnhandledException += delegate { Native.ForceRestoreSystemCursors(); };
            Application.ThreadException += delegate { Native.ForceRestoreSystemCursors(); };

            Options options = Options.Parse(args);

            if (string.IsNullOrEmpty(options.Exe) || !File.Exists(options.Exe))
            {
                MessageBox.Show("No game executable was given.", "BitBit");
                return 2;
            }

            if (options.Debug) MessageBox.Show("waiting for " + options.Exe, "BitBit");

            string directory = options.WorkingDirectory;
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory)) directory = Path.GetDirectoryName(options.Exe);

            ProcessStartInfo info = new ProcessStartInfo(options.Exe);
            info.WorkingDirectory = directory;
            if (!string.IsNullOrEmpty(options.Arguments)) info.Arguments = options.Arguments;
            info.UseShellExecute = false;

            // A DPI-unaware game is bitmap-virtualised by Windows (800x600 becomes
            // 1000x750 at 125%), which would break the mapping and the capture.
            // HIGHDPIAWARE is honoured by the loader for this process only.
            string layers = Environment.GetEnvironmentVariable("__COMPAT_LAYER");
            info.EnvironmentVariables["__COMPAT_LAYER"] = string.IsNullOrEmpty(layers) ? "HIGHDPIAWARE" : layers + " HIGHDPIAWARE";

            Process game;
            try
            {
                game = Process.Start(info);
            }
            catch (Exception error)
            {
                MessageBox.Show("Could not start the game: " + error.Message, "BitBit");
                return 3;
            }

            IntPtr window = WaitForWindow(game, 30000);
            if (window == IntPtr.Zero)
            {
                MessageBox.Show("The game did not open a window.", "BitBit");
                return 4;
            }
            Native.SetForegroundWindow(window);
            Native.SwitchToThisWindow(window, true);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Overlay overlay = new Overlay(window, options);

            System.Threading.Thread watcher = new System.Threading.Thread(delegate()
            {
                game.WaitForExit();
                try { overlay.BeginInvoke(new MethodInvoker(overlay.Close)); }
                catch { }
            });
            watcher.IsBackground = true;
            watcher.Start();

            Application.Run(overlay);
            Native.ClipCursor(IntPtr.Zero);

            // leaving scaled mode leaves the game running
            return 0;
        }
    }
}
