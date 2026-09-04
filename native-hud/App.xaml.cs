using System;
using System.Windows;

namespace JarvisHud
{
    public partial class App : Application
    {
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

            // Real, minimal contract with src/cli.ts (see
            // JARVIS-MASTER-ARCHITECTURE-UPDATED.md's Phase 5 / native HUD
            // notes): argv[0] is the hud-server URL to display, e.g.
            // http://127.0.0.1:PORT/ - cli.ts already owns picking a free
            // port (HudServer.start(0)) and this process just displays
            // whatever URL it's told, the same division of responsibility
            // the Edge --app launch it replaces had.
            string? url = e.Args.Length > 0 ? e.Args[0] : null;
            if (string.IsNullOrWhiteSpace(url))
            {
                MessageBox.Show(
                    "JarvisHud.exe requires the HUD server URL as its first argument, e.g.:\n  JarvisHud.exe http://127.0.0.1:5173/",
                    "JARVIS HUD - missing URL",
                    MessageBoxButton.OK,
                    MessageBoxImage.Error);
                Shutdown(1);
                return;
            }

            var window = new MainWindow(url);
            // [UPDATE 2026-09-02] Real regression found live: Gavin's own
            // direct report ("i can tell you right now it the hud didnt
            // open") contradicted this file's own log lines, which
            // faithfully recorded every Show()/Hide() call as if it
            // worked - a real, meaningful gap between "the C# code called
            // the method" and "WPF actually painted a visible window."
            // The Show()-then-immediately-Hide() sequence this replaces
            // was exactly the kind of pattern flagged as unverified when
            // it was written (no real display session to confirm it
            // against) - a WPF window that's Hidden before it was ever
            // truly painted once can be a real, known source of later
            // Show() calls silently failing to render, especially
            // combined with AllowsTransparency+WebView2. Real, more
            // robust fix instead: this window stays genuinely
            // Visible/painting from the moment Show() is called here -
            // MainWindow starts at Opacity 0 (see its own XAML/field
            // default), so it's still invisible, but there's no
            // Hide()-then-Show() cycle for WPF to potentially mishandle;
            // MainWindow.xaml.cs's pop-up-on-activity now toggles Opacity
            // (0/1) instead, a simpler, better-supported WPF operation on
            // an already-live window.
            window.Show();

            // [ADDED 2026-09-03] Real, separate full-screen overlay - see
            // ScreenGlowWindow.xaml.cs's own doc comment for why this is a
            // distinct window from MainWindow rather than just a bigger
            // version of the corner HUD: it needs real click-through
            // (WS_EX_TRANSPARENT) so it never blocks Gavin's own mouse or
            // JARVIS's own UI Automation clicks while "acting" is true, and
            // it polls the same real /state endpoint independently.
            var glowWindow = new ScreenGlowWindow(url);
            glowWindow.Show();
        }
    }
}
