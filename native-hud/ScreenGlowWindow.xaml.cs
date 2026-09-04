using System;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;

namespace JarvisHud
{
    /// <summary>
    /// [ADDED 2026-09-03] Real feature, per Gavin: "when taking over my
    /// screen i would like that orange glow for when hes 'acting' to
    /// also be around the whole edge of my screen so i know hes the one
    /// in control." The small corner HUD widget's own "acting" ring
    /// animation isn't visible enough when JARVIS is actually driving
    /// the mouse/keyboard somewhere else on screen - this is a real,
    /// separate full-screen overlay that only appears while the real
    /// backend state is genuinely "acting" (see orchestrator.ts's
    /// onActionStart/onActionEnd - not decoration, tied to the same real
    /// state MainWindow's own HUD already reflects).
    ///
    /// Real, click-through: WS_EX_TRANSPARENT + WS_EX_LAYERED means this
    /// window never intercepts a real mouse click or keystroke - both
    /// JARVIS's own real UI Automation clicks (ui-automation.ts) and
    /// Gavin's own normal use of the PC pass straight through it. It's
    /// purely visual, covering the real work-area bounds with a thin
    /// glowing border along all four edges, nothing in the middle.
    /// </summary>
    public partial class ScreenGlowWindow : Window
    {
        private readonly string _url;
        private static readonly HttpClient _stateHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        private DispatcherTimer? _stateTimer;
        private bool _visible = false;

        public ScreenGlowWindow(string url)
        {
            _url = url;
            InitializeComponent();

            var workArea = SystemParameters.WorkArea;
            Left = workArea.Left;
            Top = workArea.Top;
            Width = workArea.Width;
            Height = workArea.Height;

            SourceInitialized += ScreenGlowWindow_SourceInitialized;
            Loaded += ScreenGlowWindow_Loaded;
        }

        private void ScreenGlowWindow_SourceInitialized(object? sender, EventArgs e)
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            int exStyle = GetWindowLong(hwnd, GWL_EXSTYLE);
            // WS_EX_TRANSPARENT (click-through) + WS_EX_LAYERED (required
            // for WS_EX_TRANSPARENT to actually work correctly with a
            // real AllowsTransparency WPF window) + WS_EX_TOOLWINDOW
            // (same Alt-Tab/taskbar exclusion as MainWindow).
            SetWindowLong(hwnd, GWL_EXSTYLE, exStyle | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW);
        }

        private void ScreenGlowWindow_Loaded(object sender, RoutedEventArgs e)
        {
            _stateTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
            _stateTimer.Tick += StateTimer_Tick;
            _stateTimer.Start();
            Console.WriteLine("[screen-glow] Active - polling every 400ms, shows only while state is genuinely \"acting\".");
        }

        private async void StateTimer_Tick(object? sender, EventArgs e)
        {
            string state;
            try
            {
                var json = await _stateHttp.GetStringAsync($"{_url.TrimEnd('/')}/state");
                using var doc = JsonDocument.Parse(json);
                state = doc.RootElement.GetProperty("state").GetString() ?? "idle";
            }
            catch
            {
                return;
            }

            bool shouldShow = state == "acting";
            if (shouldShow && !_visible)
            {
                Console.WriteLine("[screen-glow] showing (real IsVisible={0})", IsVisible);
                Opacity = 1.0;
                _visible = true;
            }
            else if (!shouldShow && _visible)
            {
                Console.WriteLine("[screen-glow] hiding");
                Opacity = 0.0;
                _visible = false;
            }
        }

        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TRANSPARENT = 0x00000020;
        private const int WS_EX_LAYERED = 0x00080000;
        private const int WS_EX_TOOLWINDOW = 0x00000080;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    }
}
