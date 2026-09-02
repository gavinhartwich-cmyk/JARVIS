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
            window.Show();
        }
    }
}
