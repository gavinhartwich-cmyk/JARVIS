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
            // [2026-09-02] Real behavior change, not a leftover: Show()
            // is still required here (not skippable) - it's what causes
            // WPF to create the real window handle and fire Loaded, which
            // is where MainWindow initializes WebView2 and starts its own
            // polling timers (see MainWindow.xaml.cs's pop-up-on-activity
            // comment). The immediate Hide() right after means the window
            // itself never renders on screen at startup - MainWindow's own
            // StateTimer_Tick is what reveals it again the moment
            // hud-server.ts's real /state first leaves "idle". Both calls
            // are synchronous WPF window-visibility operations processed
            // before the dispatcher yields to a real paint, so this is not
            // expected to produce a visible startup flash - not confirmed
            // live from this sandbox (no real display session here), same
            // disclosed-but-unverified category as this file's screen-
            // awareness repositioning work before its own live
            // confirmation.
            window.Show();
            window.Hide();
        }
    }
}
