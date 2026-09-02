using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Threading;

namespace JarvisHud
{
    public partial class MainWindow : Window
    {
        private readonly string _url;

        // --- Screen-awareness repositioning ---
        // Per Gavin: JARVIS should move out of the way of "whatever's
        // showing" rather than sit statically in one corner. Real
        // mechanism, not a vision/screenshot loop: poll the actual
        // foreground window's on-screen bounds (native Win32/DWM, no LLM
        // calls, no latency) every tick, and if it overlaps the HUD's
        // current corner, slide to a free corner - shrinking first if no
        // corner is fully free - with a smooth eased animation rather than
        // an instant jump. This directly covers both cases Gavin
        // described: "he's showing me something" (JARVIS opened an app -
        // that app becomes the foreground window) and "I need to see
        // something" (any window now occupying the HUD's corner).
        private enum Corner { TopRight, TopLeft, BottomRight, BottomLeft }
        private static readonly Corner[] AllCorners =
        {
            Corner.TopRight, Corner.TopLeft, Corner.BottomRight, Corner.BottomLeft
        };

        private const double BaseWidth = 380;
        private const double BaseHeight = 420;
        private const double CompactScale = 0.6; // shrink factor when nothing is fully free
        private const double CornerMargin = 16;
        private const double AnimDurationMs = 420; // "slick but smooth", not instant/robotic

        private Corner _currentCorner = Corner.TopRight;
        private double _currentScale = 1.0;
        private DispatcherTimer? _positionTimer;
        private DispatcherTimer? _animTimer;
        private Rect _animFrom;
        private Rect _animTo;
        private double _animScaleFrom = 1.0;
        private double _animScaleTo = 1.0;
        private DateTime _animStart;

        public MainWindow(string url)
        {
            _url = url;
            InitializeComponent();

            var workArea = SystemParameters.WorkArea;
            var startRect = CornerRect(_currentCorner, _currentScale, workArea);
            Left = startRect.Left;
            Top = startRect.Top;
            Width = startRect.Width;
            Height = startRect.Height;

            SourceInitialized += MainWindow_SourceInitialized;
            Loaded += MainWindow_Loaded;
        }

        private void MainWindow_SourceInitialized(object? sender, EventArgs e)
        {
            // WS_EX_TOOLWINDOW: hides this window from Alt-Tab at the real
            // Win32 level. ShowInTaskbar="False" (XAML) already handles
            // the taskbar; this is the belt-and-suspenders piece so
            // Alt-Tab cycling doesn't surface it either.
            var hwnd = new WindowInteropHelper(this).Handle;
            int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
            SetWindowLong(hwnd, GWL_EXSTYLE, exStyle | WS_EX_TOOLWINDOW);
        }

        private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
        {
            await Web.EnsureCoreWebView2Async(null);

            // The actual "floats over the desktop, not in a rectangle"
            // effect: a transparent WebView2 background composited inside
            // an AllowsTransparency WPF window. This is WebView2's own
            // documented, supported mechanism for exactly this scenario -
            // unlike this project's earlier real WMPlayer.OCX
            // windowed-ActiveX-vs-transparency problems (see the master
            // doc's 2026-08-31 fifth/sixth-pass entries), WebView2's
            // DefaultBackgroundColor exists specifically so this
            // combination works rather than fighting the control.
            Web.DefaultBackgroundColor = Color.Transparent;

            Web.CoreWebView2.Navigate(_url);

            _positionTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(500) };
            _positionTimer.Tick += PositionTimer_Tick;
            _positionTimer.Start();
        }

        private void Window_KeyDown(object sender, KeyEventArgs e)
        {
            // Esc closes the HUD - a manual escape hatch independent of
            // cli.ts's own PID-based shutdown, for whenever this is run
            // or left open outside a 'listen' session (e.g. a standalone
            // visual check).
            if (e.Key == Key.Escape)
            {
                Close();
            }
        }

        // --- Positioning decision ---

        private void PositionTimer_Tick(object? sender, EventArgs e)
        {
            var workArea = SystemParameters.WorkArea;
            var fgBounds = GetForegroundBounds();

            Corner targetCorner = _currentCorner;
            double targetScale = _currentScale;

            if (fgBounds is Rect fg)
            {
                var currentRect = CornerRect(_currentCorner, _currentScale, workArea);
                bool currentOk = !Overlaps(currentRect, fg);

                if (!currentOk)
                {
                    // Prefer full size first - only shrink if genuinely
                    // nothing is free.
                    if (TryFindFreeCorner(fg, workArea, 1.0, out var freeCorner))
                    {
                        targetCorner = freeCorner;
                        targetScale = 1.0;
                    }
                    else if (TryFindFreeCorner(fg, workArea, CompactScale, out var freeCompactCorner))
                    {
                        targetCorner = freeCompactCorner;
                        targetScale = CompactScale;
                    }
                    else
                    {
                        // Covered everywhere (e.g. a real fullscreen app) -
                        // shrink in place rather than jumping around for
                        // no benefit.
                        targetScale = CompactScale;
                    }
                }
                else if (_currentScale < 1.0 && !Overlaps(CornerRect(_currentCorner, 1.0, workArea), fg))
                {
                    // Room opened back up in the same corner - grow back
                    // to full size rather than staying small forever.
                    targetScale = 1.0;
                }
            }
            else
            {
                // No meaningful foreground window (desktop, minimized, or
                // our own window) - default back to full size, top-right.
                targetCorner = Corner.TopRight;
                targetScale = 1.0;
            }

            if (targetCorner != _currentCorner || Math.Abs(targetScale - _currentScale) > 0.001)
            {
                _currentCorner = targetCorner;
                _currentScale = targetScale;
                AnimateTo(CornerRect(targetCorner, targetScale, workArea), targetScale);
            }
        }

        private bool TryFindFreeCorner(Rect fg, Rect workArea, double scale, out Corner found)
        {
            foreach (var c in AllCorners)
            {
                if (!Overlaps(CornerRect(c, scale, workArea), fg))
                {
                    found = c;
                    return true;
                }
            }
            found = _currentCorner;
            return false;
        }

        private static Rect CornerRect(Corner corner, double scale, Rect workArea)
        {
            double w = BaseWidth * scale;
            double h = BaseHeight * scale;
            double x = (corner == Corner.TopLeft || corner == Corner.BottomLeft)
                ? workArea.Left + CornerMargin
                : workArea.Right - w - CornerMargin;
            double y = (corner == Corner.TopLeft || corner == Corner.TopRight)
                ? workArea.Top + CornerMargin
                : workArea.Bottom - h - CornerMargin;
            return new Rect(x, y, w, h);
        }

        private static bool Overlaps(Rect a, Rect b)
        {
            // Small inflate so a window edge that just grazes the HUD
            // still counts as "in the way" rather than requiring literal
            // pixel-perfect overlap.
            var inflated = a;
            inflated.Inflate(6, 6);
            return inflated.IntersectsWith(b);
        }

        /// <summary>
        /// Real bounds of whatever window is actually in front right now -
        /// null when there's nothing meaningful to react to (desktop,
        /// minimized, or this HUD window itself).
        /// </summary>
        private Rect? GetForegroundBounds()
        {
            var fg = GetForegroundWindow();
            if (fg == IntPtr.Zero) return null;

            var self = new WindowInteropHelper(this).Handle;
            if (fg == self) return null;

            if (IsIconic(fg)) return null; // minimized

            // Ignore the desktop/shell itself and the taskbar - these
            // technically "cover" a huge area but aren't something Gavin
            // is being shown or needs to see; reacting to them would just
            // make the HUD shrink permanently whenever nothing else has
            // focus.
            var classBuilder = new StringBuilder(256);
            GetClassName(fg, classBuilder, classBuilder.Capacity);
            var className = classBuilder.ToString();
            if (className is "Progman" or "WorkerW" or "Shell_TrayWnd" or "Shell_SecondaryTrayWnd")
                return null;

            // DWM's extended frame bounds is the real visible window edge
            // (excludes the invisible resize-border padding many apps
            // carry) - plain GetWindowRect over-reports a window's bounds
            // by several pixels per side on Windows 10/11, which would
            // make this think a window is overlapping the HUD when
            // there's actually a real gap. Falls back to GetWindowRect
            // only if DWM's call fails.
            if (DwmGetWindowAttribute(fg, DWMWA_EXTENDED_FRAME_BOUNDS, out RECT rect, Marshal.SizeOf<RECT>()) != 0)
            {
                if (!GetWindowRect(fg, out rect)) return null;
            }

            if (rect.Right <= rect.Left || rect.Bottom <= rect.Top) return null;
            return new Rect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
        }

        // --- Smooth animation (manual, not a WPF Storyboard) ---
        // WebView2's ZoomFactor is a plain CLR double property, not a
        // WPF DependencyProperty, so it can't be a Storyboard animation
        // target - driving Left/Top/Width/Height/ZoomFactor together from
        // one manual eased timer keeps all five in lockstep rather than
        // juggling a Storyboard for four of them plus a separate
        // completion-synced update for the fifth.
        private void AnimateTo(Rect toRect, double toScale)
        {
            _animFrom = new Rect(Left, Top, Width, Height);
            _animTo = toRect;
            _animScaleFrom = Web.CoreWebView2 != null ? Web.ZoomFactor : 1.0;
            _animScaleTo = toScale;
            _animStart = DateTime.UtcNow;

            if (_animTimer == null)
            {
                _animTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(16) };
                _animTimer.Tick += AnimTimer_Tick;
            }
            _animTimer.Start();
        }

        private void AnimTimer_Tick(object? sender, EventArgs e)
        {
            double elapsed = (DateTime.UtcNow - _animStart).TotalMilliseconds;
            double t = Math.Min(1.0, elapsed / AnimDurationMs);
            double eased = 1 - Math.Pow(1 - t, 3); // ease-out cubic - slick, not linear/robotic

            Left = _animFrom.Left + (_animTo.Left - _animFrom.Left) * eased;
            Top = _animFrom.Top + (_animTo.Top - _animFrom.Top) * eased;
            Width = _animFrom.Width + (_animTo.Width - _animFrom.Width) * eased;
            Height = _animFrom.Height + (_animTo.Height - _animFrom.Height) * eased;
            if (Web.CoreWebView2 != null)
            {
                Web.ZoomFactor = _animScaleFrom + (_animScaleTo - _animScaleFrom) * eased;
            }

            if (t >= 1.0)
            {
                _animTimer!.Stop();
            }
        }

        // --- Win32 interop ---

        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
    }
}
