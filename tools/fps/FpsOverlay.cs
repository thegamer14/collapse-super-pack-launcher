using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace FpsOverlay
{
    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }

        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TRANSPARENT = 0x00000020;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_NOACTIVATE = 0x08000000;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOACTIVATE = 0x0010;
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

        public static IntPtr FindLargestWindow(int pid)
        {
            IntPtr found = IntPtr.Zero;
            int best = 0;
            EnumWindows(delegate(IntPtr hWnd, IntPtr unused)
            {
                uint owner;
                GetWindowThreadProcessId(hWnd, out owner);
                if (owner != (uint)pid || !IsWindowVisible(hWnd) || IsIconic(hWnd)) return true;
                RECT rect;
                if (!GetWindowRect(hWnd, out rect)) return true;
                int area = (rect.Right - rect.Left) * (rect.Bottom - rect.Top);
                if (area > best)
                {
                    best = area;
                    found = hWnd;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        public static bool IsGameForeground(IntPtr gameWindow)
        {
            IntPtr foreground = GetForegroundWindow();
            if (foreground == gameWindow) return true;
            IntPtr root = foreground;
            for (int i = 0; i < 5 && root != IntPtr.Zero; i++)
            {
                if (root == gameWindow) return true;
                root = GetParent(root);
            }
            return false;
        }
    }

    sealed class Overlay : Form
    {
        readonly int processId;
        readonly Process process;
        readonly string logFile;
        IntPtr gameWindow;

        readonly Bitmap bitmap;
        byte[] previous;
        byte[] current;
        bool haveFrame;

        readonly object sync = new object();
        int displayedFps;
        bool active;
        volatile bool stopping;
        Thread sampler;

        public Overlay(int processId, Process process, IntPtr gameWindow, string logFile)
        {
            this.processId = processId;
            this.process = process;
            this.gameWindow = gameWindow;
            this.logFile = logFile;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.Black;
            Opacity = 0.78;
            DoubleBuffered = true;
            Width = 132;
            Height = 42;
            Rectangle screen = Screen.PrimaryScreen.Bounds;
            Location = new Point(screen.Right - Width - 18, screen.Top + 18);
            Text = "FPS";

            Log("overlay constructed");

            bitmap = new Bitmap(256, 256, PixelFormat.Format32bppArgb);
            previous = new byte[256 * 256 * 4];
            current = new byte[256 * 256 * 4];
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= Native.WS_EX_TRANSPARENT | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Log("overlay shown");
            Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
                Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            sampler = new Thread(SampleLoop);
            sampler.IsBackground = true;
            sampler.Start();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            string text;
            lock (sync) text = active ? string.Format(CultureInfo.InvariantCulture, "FPS {0}", displayedFps) : "FPS --";
            using (Font font = new Font("Segoe UI Semibold", 11f))
            using (Brush brush = new SolidBrush(Color.White))
            using (StringFormat format = new StringFormat())
            {
                format.Alignment = StringAlignment.Center;
                format.LineAlignment = StringAlignment.Center;
                e.Graphics.DrawString(text, font, brush, ClientRectangle, format);
            }
        }

        Rectangle SampleRectangle()
        {
            Native.RECT client;
            if (!Native.GetClientRect(gameWindow, out client)) return Rectangle.Empty;
            int width = Math.Min(256, client.Right);
            int height = Math.Min(256, client.Bottom);
            if (width <= 0 || height <= 0) return Rectangle.Empty;
            Native.POINT origin = new Native.POINT();
            if (!Native.ClientToScreen(gameWindow, ref origin)) return Rectangle.Empty;
            return new Rectangle(
                origin.X + (client.Right - width) / 2,
                origin.Y + (client.Bottom - height) / 2,
                width, height);
        }

        bool CaptureFrame()
        {
            Rectangle area = SampleRectangle();
            if (area.Width <= 0 || area.Height <= 0) return false;
            try
            {
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    graphics.CopyFromScreen(area.Left, area.Top, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
                }
            }
            catch
            {
                return false;
            }

            BitmapData data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height),
                ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                Marshal.Copy(data.Scan0, current, 0, current.Length);
            }
            finally
            {
                bitmap.UnlockBits(data);
            }

            bool changed = !haveFrame;
            if (!changed)
            {
                for (int i = 0; i < current.Length; i++)
                {
                    if (current[i] != previous[i])
                    {
                        changed = true;
                        break;
                    }
                }
            }

            byte[] swap = previous;
            previous = current;
            current = swap;
            haveFrame = true;
            return changed;
        }

        void SampleLoop()
        {
            long changes = 0;
            DateTime windowStart = DateTime.UtcNow;
            DateTime lastTopmost = DateTime.MinValue;

            while (!stopping)
            {
                try
                {
                    if (process.HasExited) break;
                    if (!Native.IsWindow(gameWindow))
                    {
                        gameWindow = Native.FindLargestWindow(processId);
                        if (gameWindow == IntPtr.Zero)
                        {
                            Thread.Sleep(300);
                            continue;
                        }
                    }

                    bool foreground = Native.IsGameForeground(gameWindow) && !Native.IsIconic(gameWindow);
                    if (foreground)
                    {
                        if (CaptureFrame()) changes++;
                    }

                    DateTime now = DateTime.UtcNow;
                    if ((now - windowStart).TotalSeconds >= 1.0)
                    {
                        double elapsed = (now - windowStart).TotalSeconds;
                        int next = foreground ? (int)Math.Round(changes / elapsed) : 0;
                        lock (sync)
                        {
                            displayedFps = next;
                            active = foreground;
                        }
                        changes = 0;
                        windowStart = now;
                        BeginInvoke(new MethodInvoker(Invalidate));
                        Log(string.Format(CultureInfo.InvariantCulture, "fps={0} active={1}", next, foreground));
                    }

                    if ((now - lastTopmost).TotalSeconds >= 2.0)
                    {
                        lastTopmost = now;
                        Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
                            Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
                    }
                }
                catch
                {
                    if (process.HasExited) break;
                }
                Thread.Sleep(6);
            }

            try { BeginInvoke(new MethodInvoker(Close)); } catch { }
        }

        void Log(string message)
        {
            string target = string.IsNullOrEmpty(logFile) ? Environment.GetEnvironmentVariable("FPS_DEBUG_LOG") : logFile;
            if (string.IsNullOrEmpty(target)) return;
            try
            {
                System.IO.File.AppendAllText(target,
                    string.Format(CultureInfo.InvariantCulture, "[{0}] {1}\r\n", DateTime.Now.ToString("o"), message));
            }
            catch { }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            stopping = true;
            Log("overlay closing");
            base.OnFormClosing(e);
        }
    }

    static class Program
    {
        static string debugLog;

        static void Debug(string message)
        {
            if (string.IsNullOrEmpty(debugLog)) return;
            try
            {
                System.IO.File.AppendAllText(debugLog,
                    string.Format(CultureInfo.InvariantCulture, "[{0}] {1}\r\n", DateTime.Now.ToString("o"), message));
            }
            catch { }
        }

        [STAThread]
        static int Main(string[] args)
        {
            int processId = 0;
            string logFile = null;
            debugLog = Environment.GetEnvironmentVariable("FPS_DEBUG_LOG");
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                Debug("unhandled: " + e.ExceptionObject);
            };
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
            {
                Debug("thread exception: " + e.Exception.Message + " " + e.Exception.StackTrace);
            };
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--pid" && i + 1 < args.Length)
                    int.TryParse(args[++i], NumberStyles.Integer, CultureInfo.InvariantCulture, out processId);
                else if (args[i] == "--log" && i + 1 < args.Length)
                    logFile = args[++i];
            }

            Debug("start args=" + string.Join(" ", args));

            if (processId <= 0) return 2;
            Native.SetProcessDPIAware();

            Process process;
            try { process = Process.GetProcessById(processId); }
            catch (Exception e) { Debug("process: " + e.Message); return 3; }

            IntPtr window = IntPtr.Zero;
            DateTime deadline = DateTime.UtcNow.AddSeconds(30);
            while (DateTime.UtcNow < deadline && window == IntPtr.Zero)
            {
                if (process.HasExited) return 4;
                window = Native.FindLargestWindow(processId);
                if (window == IntPtr.Zero) Thread.Sleep(200);
            }
            if (window == IntPtr.Zero) return 5;

            Debug("window=" + window);
            Debug("before visual styles");

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Debug("before overlay constructor");
            try
            {
                Overlay overlay = new Overlay(processId, process, window, logFile);
                Debug("before application run");
                Application.Run(overlay);
            }
            catch (Exception e)
            {
                Debug("run: " + e);
                return 6;
            }
            Debug("exit");
            return 0;
        }
    }
}
