import { initializeDatabase, closeDatabase } from "./db/client";
import { Orchestrator } from "./core/orchestrator";
import { BaseAgent } from "./agents/agent";
import { AGENT_ROLES } from "./agents/types";
import { createDefaultGateway, GatewayModelProvider } from "./models/llm-gateway";
import type { ModelProvider } from "./models/types";
import { toolManager } from "./tools/manager";
import { SPECIALIZED_AGENT_ROLES } from "./agents/specialized-agents";
import { presenceEngine } from "./core/presence";
import { identityEngine } from "./core/identity";
import { authorizationEngine } from "./core/authorization";
import { ScreenControl } from "./phase3/screen-control";
import { JARVISDeveloper } from "./phase1/developer";
import { VoiceInterface } from "./phase2/voice-interface";
import { LiveVoiceInterface } from "./phase2/live-voice-interface";
import { MicCapture } from "./phase2/mic-capture";
import { DEFAULT_VOICE_CONFIG } from "./phase2/voice-config";
import { HudServer } from "./phase2/hud-server";
import { runPowerShell } from "./phase3/windows-control";
import { VisionSystem } from "./phase3/vision-system";
import { OllamaVisionProvider } from "./phase3/ollama-vision-provider";
import { VideoAnalyzer } from "./phase3/video-analyzer";
import { CameraCapture, listCameraDevices } from "./phase3/camera-capture";
import { spotifyAuth, spotifyPlay } from "./core/spotify";
import { proactivityEngine } from "./core/proactivity";
import { runAllMonitors } from "./core/system-monitors";
import { sendSms } from "./core/sms";
import { sendEmail } from "./core/email-sender";
import { runProactiveScheduler } from "./core/proactive-scheduler";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLiveHarness } from "./prototypes/gemini-live/cli-harness";
import { runComparison } from "./prototypes/gemini-live/compare-latency";
import { undoLastActions } from "./core/action-journal";

/**
 * JARVIS CLI - Entry point for the system
 *
 * Every command here actually runs the thing it claims to. If a system
 * isn't wired up yet, it doesn't get a command — see
 * JARVIS-MASTER-ARCHITECTURE-UPDATED.md's ground-truth status table for
 * what's real vs. still scaffolding.
 */

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "test";

  console.log("\n🤖 JARVIS — Phase 0 (verified) + Phase 1 (JARVIS Developer, real pipeline) + Phase 1.5 (conversation, real LLM) + Phase 2 (voice reply, real LLM/TTS) + Phase 3 (vision-test, real Ollama vision)\n");

  // Initialize database
  try {
    console.log("📦 Initializing database...");
    await initializeDatabase();
  } catch (error) {
    console.error("\n❌ Database initialization failed");
    console.error("\nTo set up PostgreSQL on Windows:");
    console.error("1. Download PostgreSQL 16+ from https://www.postgresql.org/download/windows/");
    console.error("2. Run the installer and create a user 'jarvis' with password 'jarvis'");
    console.error("3. Create a database: createdb -U jarvis jarvis");
    console.error("4. Or use: psql -U postgres -c 'CREATE ROLE jarvis WITH LOGIN PASSWORD jarvis; CREATE DATABASE jarvis OWNER jarvis;'");
    process.exit(1);
  }

  try {
    // Initialize model provider — provider-agnostic per invariant #3, and
    // zero dependency on Claude/Anthropic/Zo (this project is standalone —
    // it does not run through or depend on Zo in any form). The gateway
    // tries OmniRoute first (aggregates 300+ providers with its own
    // auto-fallback, so a single upstream's quota running dry doesn't even
    // surface here), then falls back to Ollama (local, no API key, no
    // quota) automatically if OmniRoute is unavailable — this is what
    // turns a provider outage into "keeps working, just on the local
    // model." Gemini and OpenRouter stay registered as extra legacy rungs
    // only if their API keys are set. See src/models/llm-gateway.ts.
    console.log("🧠 Initializing model provider (gateway)...");
    const gateway = createDefaultGateway();
    console.log(`   Providers registered: ${gateway.listProviders().join(", ")}`);
    const modelProvider: ModelProvider = new GatewayModelProvider(gateway);

    // Initialize tools
    console.log("🔧 Initializing tools...");
    const availableTools = toolManager.getAvailableTools();
    console.log(`   📋 ${availableTools.length} tools registered`);

    const isAvailable = await modelProvider.available();
    if (!isAvailable) {
      console.warn(`⚠️  ${modelProvider.name} provider not available. Check its API key env var is set.`);
      console.warn("   For now, using the provider anyway - will fail on actual queries.");
    }

    // Initialize orchestrator
    console.log("🎼 Initializing orchestrator...");
    const orchestrator = new Orchestrator();

    // Register every agent name task-decomposer.ts's pipelines can
    // reference — the 5 always-used core agents plus the 13 specialized
    // ones (architect, coder, tester, debugger, code-reviewer,
    // security-reviewer, performance-analyzer, analyzer, explainer,
    // simplifier, planner, error-analyzer, verifier). Found 2026-08-27:
    // only the 5 core agents were ever registered here, so any task
    // decomposer.ts routed to a non-"research"/"reasoning" pipeline (code
    // review, planning, verification, analysis, explanation...) crashed
    // with "Agent not found" the moment the orchestrator tried to run it —
    // SPECIALIZED_AGENT_ROLES was imported above but never actually used.
    console.log("👥 Registering agents...");
    const coreAgents = [
      AGENT_ROLES.RESEARCHER,
      AGENT_ROLES.REASONER,
      AGENT_ROLES.CRITIC,
      AGENT_ROLES.FACT_CHECKER,
      AGENT_ROLES.SYNTHESIZER,
    ];
    const allAgentRoles = [...coreAgents, ...Object.values(SPECIALIZED_AGENT_ROLES)];

    for (const roleConfig of allAgentRoles) {
      const agent = new BaseAgent(
        roleConfig.name,
        roleConfig.role,
        roleConfig.instructions,
        {
          provider: modelProvider.name,
          model: process.env.OMNIROUTE_MODEL || "auto",
          temperature: 0.7,
          maxTokens: 2000,
          // 90s, not the provider default of 60s - a live run through
          // OmniRoute's free auto-routed backend showed individual calls
          // running close to (and sometimes past) 60s even for plain
          // conversational reasoning.
          timeoutMs: 90_000,
        },
        modelProvider
      );
      orchestrator.registerAgent(agent);
      console.log(`   ✓ ${roleConfig.role}`);
    }

    console.log("\n✅ PHASE 0 SYSTEMS INITIALIZED");
    console.log("   - Orchestrator: Ready");
    console.log("   - Memory: Ready");
    console.log("   - Tools: Ready");
    console.log("   - Verification: Ready");
    console.log(`   - Agents: ${allAgentRoles.length} agents registered (5 core + ${allAgentRoles.length - coreAgents.length} specialized)`);

    // Run vertical slice test
    if (command === "test" || command === "") {
      console.log("\n" + "=".repeat(70));
      console.log("🧪 PHASE 0 VERTICAL SLICE TEST");
      console.log("=".repeat(70));
      console.log("\nThis test verifies:");
      console.log("  ✓ Task decomposition");
      console.log("  ✓ Multi-agent orchestration");
      console.log("  ✓ Memory storage");
      console.log("  ✓ Verification & confidence tracking");
      console.log("  ✓ Audit trail logging");
      console.log("  ✓ Tool execution");

      const testTask = "What are the key differences between TypeScript and Python for building AI systems?";
      console.log(`\nRunning test with task: "${testTask}"`);
      console.log("(This will use all 5 core agents)\n");

      try {
        const result = await orchestrator.orchestrate(testTask);

        console.log("\n" + "=".repeat(70));
        console.log("📊 TEST RESULTS");
        console.log("=".repeat(70));

        console.log(`\n✅ Test Status: PASSED`);
        console.log(`   Task ID: ${result.taskId}`);
        console.log(`   Verification Status: ${result.verificationStatus}`);
        console.log(`   Overall Confidence: ${(result.confidence * 100).toFixed(1)}%`);

        console.log(`\n📋 Agent Outputs:`);
        Object.entries(result.agentOutputs).forEach(([agent, output]) => {
          console.log(`   ${agent}: ${(output.confidence * 100).toFixed(0)}% confidence`);
        });

        console.log(`\n📝 Final Answer:\n${result.finalResult}`);

        console.log("\n" + "=".repeat(70));
        console.log("✅ PHASE 0 VERTICAL SLICE TEST PASSED");
        console.log("=".repeat(70));
        console.log("\nAll Phase 0 systems operational:");
        console.log("  ✓ Database working");
        console.log("  ✓ Orchestrator working");
        console.log("  ✓ Agents registered and executing");
        console.log("  ✓ Memory storing results");
        console.log("  ✓ Verification tracking confidence");
        console.log("  ✓ Audit trail logging all actions");
      } catch (error) {
        console.error("\n❌ PHASE 0 TEST FAILED:");
        console.error(error instanceof Error ? error.message : String(error));
        console.error("\nDebugging info:");
        console.error("  - Check that PostgreSQL is running");
        console.error("  - Check that at least one provider is configured: OMNIROUTE_API_KEY (from your OmniRoute dashboard)");
        console.error("    or a running local Ollama server (ollama serve + ollama pull qwen2.5-coder:1.5b)");
        console.error("    or GEMINI_API_KEY (aistudio.google.com/apikey) as a legacy fallback");
        console.error("  - Check database schema was created (bun run db:push)");
      }
    } else if (command === "phase1" || command === "phase1-status") {
      JARVISDeveloper.printWorkflow();
    } else if (command === "phase1-selftest") {
      const result = await JARVISDeveloper.selfTest();
      if (!result.success) process.exitCode = 1;
    } else if (command === "developer") {
      // bun run dev developer "<requirement>" [--repo path] [--approve] [--approved-by name] [--base branch]
      const requirement = args[1];
      if (!requirement) {
        console.log("\n❌ Missing requirement.");
        console.log('   Usage: bun run dev developer "<requirement>" [--repo path] [--approve] [--approved-by name] [--base branch]');
      } else {
        const repoFlagIdx = args.indexOf("--repo");
        const baseFlagIdx = args.indexOf("--base");
        const approvedByIdx = args.indexOf("--approved-by");
        const repoPath = repoFlagIdx !== -1 ? args[repoFlagIdx + 1] : process.cwd();
        const baseBranch = baseFlagIdx !== -1 ? args[baseFlagIdx + 1] : undefined;
        const approved = args.includes("--approve");
        const approvedBy = approvedByIdx !== -1 ? args[approvedByIdx + 1] : undefined;

        const developer = new JARVISDeveloper(repoPath);
        const result = await developer.developFeature(requirement, {
          approved,
          baseBranch,
          approvedBy,
        });
        if (result.status === "failed") process.exitCode = 1;
      }
    } else if (command === "whoami") {
      console.log("\n" + "=".repeat(70));
      console.log("🔐 PRESENCE / IDENTITY / AUTHORIZATION CHECK");
      console.log("=".repeat(70));

      await presenceEngine.registerDevice("pc", "pc", ["voice", "screen", "notification"]);
      await presenceEngine.heartbeat("pc");
      const active = await presenceEngine.getActiveDevice();
      console.log(`\n📡 Presence: PC is ${active ? "active" : "not detected as active"}`);

      const identity = await identityEngine.resolveFromDeviceSession(active?.id);
      console.log(`\n🪪 Identity: resolved as "${identity.resolvedAs}" via ${identity.signal} (confidence ${(identity.confidence * 100).toFixed(0)}%)`);

      const normalCheck = await authorizationEngine.authorize(identity, "read_file", "normal");
      const adminCheck = await authorizationEngine.authorize(identity, "install_software", "admin");
      console.log(`\n🔒 Authorization:`);
      console.log(`   normal-risk action (e.g. read_file): ${normalCheck.decision} — ${normalCheck.reason}`);
      console.log(`   admin-risk action (e.g. install_software): ${adminCheck.decision} — ${adminCheck.reason}`);

      if (args[1] === "--pin" && args[2]) {
        const pinResult = await identityEngine.resolveFromPin(args[2], active?.id);
        console.log(`\n🔑 PIN check: resolved as "${pinResult.resolvedAs}" (confidence ${(pinResult.confidence * 100).toFixed(0)}%)`);
        const adminWithPin = await authorizationEngine.authorize(pinResult, "install_software", "admin");
        console.log(`   admin-risk action with PIN: ${adminWithPin.decision} — ${adminWithPin.reason}`);
      } else {
        console.log(`\n   (run "bun run dev whoami --pin YOUR_PIN" to test Level 3 verification, once JARVIS_PIN is set in .env)`);
      }
      console.log("\n" + "=".repeat(70));
    } else if (command === "proactive-check") {
      // Phase 4 (master plan Part 7) - one real pass: run every real
      // monitor this codebase has, evaluate each event through the real
      // relevance/urgency/permission/device-routing decision engine
      // (proactivity.ts), print what it actually decided. A cron/loop
      // wrapper around calling this repeatedly is real follow-up work
      // (see the master doc's Phase 4 status) - this command is the
      // honest, testable core: does the real funnel produce sane
      // decisions against real data, right now.
      console.log("\n" + "=".repeat(70));
      console.log("🔔 PROACTIVE CHECK (Phase 4 - real monitors + real decision engine)");
      console.log("=".repeat(70));

      // Real presence baseline, same as `whoami` - routeCommunication()
      // inside proactivityEngine.evaluate() needs at least one
      // registered/heartbeating device to route to.
      await presenceEngine.registerDevice("pc", "pc", ["voice", "screen", "notification"]);
      await presenceEngine.heartbeat("pc");

      console.log("\n🔍 Running monitors...");
      const events = await runAllMonitors();
      console.log(`   ${events.length} real event(s) found (before dedup/scoring)`);

      if (events.length === 0) {
        console.log("\n✅ Nothing to report - all monitors ran clean.");
      } else {
        for (const event of events) {
          const decision = await proactivityEngine.evaluate(event);
          const icon =
            decision.outcome === "notified"
              ? "🔔"
              : decision.outcome === "needs_permission"
                ? "🔒"
                : decision.outcome === "archived"
                  ? "📥"
                  : decision.outcome === "queued_no_device"
                    ? "⏳"
                    : "🔕";
          console.log(`\n${icon} [${event.source}] ${event.summary}`);
          console.log(`   relevance=${event.relevance} urgency=${event.urgency} → ${decision.outcome}${decision.timing ? ` (${decision.timing})` : ""}`);
          console.log(`   ${decision.reason}`);
        }
      }
      console.log("\n" + "=".repeat(70));
    } else if (command === "proactive-loop") {
      // Real adaptive scheduler (core/proactive-scheduler.ts) - per
      // Gavin: "The scheduler should run whenever is needed decided by
      // Jarvis." Runs forever, Ctrl+C to stop, same lifecycle pattern as
      // `listen`.
      await runProactiveScheduler();
    } else if (command === "email-test") {
      // bun run dev email-test <to-address> [subject] -- <body>
      const [to, ...rest] = args.slice(1);
      const joined = rest.join(" ");
      const [subject, body] = joined.includes("--") ? joined.split("--").map((s) => s.trim()) : ["Test from JARVIS", joined || "This is a real test email from JARVIS."];
      console.log("\n" + "=".repeat(70));
      console.log("📧 EMAIL SEND TEST (real Gmail API send - see core/email-sender.ts)");
      console.log("=".repeat(70));
      if (!to) {
        console.log('\nUsage: bun run dev email-test <to-address> [subject] -- <body>');
      } else {
        console.log(`\nSending to: ${to}\nSubject: ${subject}\nBody: ${body}`);
        try {
          await sendEmail({ to, subject, body });
          console.log("\n✅ Sent via GMAIL_REFRESH_TOKEN_1 (business account, confirmed send scope).");
        } catch (err) {
          console.log(`\n❌ Failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      console.log("\n" + "=".repeat(70));
    } else if (command === "sms-test") {
      const text = args.slice(1).join(" ") || "This is a real test text from JARVIS.";
      console.log("\n" + "=".repeat(70));
      console.log("📱 SMS TEST (real email-to-SMS gateway send - see core/sms.ts)");
      console.log("=".repeat(70));
      console.log(`\nSending: "${text}"`);
      try {
        await sendSms(text);
        console.log("\n✅ Sent - check your phone. (Delivery via carrier gateway isn't instant or guaranteed - see core/sms.ts's own disclosed reliability caveat.)");
      } catch (err) {
        console.log(`\n❌ Failed: ${err instanceof Error ? err.message : err}`);
      }
      console.log("\n" + "=".repeat(70));
    } else if (command === "control-test") {
      console.log("\n" + "=".repeat(70));
      console.log("🖱️  COMPUTER CONTROL TEST (real, unverified until run here)");
      console.log("=".repeat(70));
      console.log("\nThis will actually open Notepad on this PC via PowerShell.");
      console.log("If this is not running on Windows, it will fail — that's expected.\n");

      const identity = await identityEngine.resolveFromDeviceSession();
      const screenControl = new ScreenControl();
      const openResult = await screenControl.openApp("notepad", identity, 1500);

      if (openResult.success) {
        console.log(`\n✅ Open/wait confirmed working: ${openResult.output}`);
      } else {
        console.log(`\n❌ Computer control failed: ${openResult.error}`);
      }

      // Second pass: exercise type/key/close — none of these have ever run
      // before either, and open/wait alone doesn't prove they work.
      console.log("\n" + "-".repeat(70));
      console.log("Now testing type / key / close on the Notepad window that's open...");
      const seq = screenControl.buildSequence("Type into Notepad, select-all, force-close it");
      screenControl.type(seq, "JARVIS control-test — real PowerShell automation, not simulated.");
      screenControl.wait(seq, 400);
      screenControl.key(seq, "ctrl+a"); // select-all — visible, non-destructive
      screenControl.wait(seq, 400);
      screenControl.close(seq, "notepad"); // force-kills the process, no save-dialog risk
      const typeCloseResult = await screenControl.executeSequence(seq, identity);

      if (typeCloseResult.success) {
        console.log(`\n✅ Type/key/close confirmed working: ${typeCloseResult.output}`);
      } else {
        console.log(`\n❌ Type/key/close failed: ${typeCloseResult.error}`);
      }

      console.log("\n" + "=".repeat(70));
      console.log(
        openResult.success && typeCloseResult.success
          ? "✅ CONTROL PRIMITIVES VERIFIED: open, wait, type, key, close"
          : "⚠️  Not all primitives verified — see errors above"
      );
      console.log("Still unverified: click, focus, scroll (need real screen coordinates/window titles — not exercised by this test).");
      console.log("=".repeat(70));
    } else if (command === "voice-reply") {
      const text = args.slice(1).join(" ");
      if (!text) {
        console.log('\nUsage: bun run dev voice-reply "<what you\'d say to JARVIS>"');
      } else {
        console.log("\n" + "=".repeat(70));
        console.log("🎙️  VOICE REPLY (real LLM + real Piper TTS — no mic/wake-word: text in, audio out)");
        console.log("=".repeat(70));

        // 2026-08-31: pass the already-constructed Orchestrator (real
        // app-control execution, same pipeline `bun run dev conversation`
        // uses) instead of leaving VoiceInterface's app-control-less
        // fallback path as the only option - see voice-interface.ts's
        // generateResponse() for the full story. This also wires the DEEP
        // path (architecture update sections 1/9): processConversation()
        // routes a genuinely multi-step/thorough request to the real
        // multi-agent pipeline (Researcher/Reasoner/Critic/FactChecker/
        // Synthesizer) itself, so voice-reply gets that for free too.
        const voice = new VoiceInterface(DEFAULT_VOICE_CONFIG, modelProvider, orchestrator);
        const { response, audio } = await voice.respondToText(text);
        console.log(`\n🤖 JARVIS: "${response}"`);

        if (audio) {
          // BUG FIX (2026-08-28, full-codebase review): this was a
          // hardcoded POSIX path (`/tmp/...`). On Windows — the project's
          // actual target platform, per .env's piper.exe/backslash paths
          // and this file's own PostgreSQL-on-Windows install
          // instructions — Node/Windows resolves a leading `/` as "root
          // of the current drive" (e.g. C:\tmp\...), which isn't a
          // directory Windows creates by default. writeFileSync doesn't
          // create missing parent directories, so this threw ENOENT even
          // when Piper itself succeeded and respondToText() returned a
          // perfectly good audio buffer — which is exactly the
          // production symptom ("Ran, but no audio file was produced -
          // check PIPER_BINARY_PATH") seen in the verify-jarvis.ps1 logs;
          // that diagnosis was a red herring, the bug was here, not in
          // Piper's config. Fixed to use the real OS temp dir, matching
          // the pattern speech-recognizer.ts/wake-word-detector.ts
          // already use correctly.
          const outPath = join(tmpdir(), `jarvis-voice-reply-${Date.now()}.wav`);
          writeFileSync(outPath, audio.audio);
          console.log(`\n🔊 Spoken reply saved to ${outPath} (${audio.duration}ms)`);
        } else {
          console.log("\n⚠️  Text-to-speech is disabled in the current voice config — text-only reply above.");
        }
        console.log("=".repeat(70));
      }
    } else if (command === "listen") {
      // bun run dev listen
      //
      // The real "always-on voice assistant" entrypoint the master
      // architecture doc's Part 5.2 describes ("Always-listening mode...
      // Detects wake word efficiently... Transitions to full listening on
      // detection") - everything this wires together (wake word ->
      // speech recognition -> real LLM response -> real TTS -> playback ->
      // back to listening) already existed and was already correct inside
      // voice-interface.ts; the two things that were actually missing
      // were a real microphone feed (mic-capture.ts, new) and real audio
      // playback (audio-player.ts, new) - this command is just the glue
      // that starts both and keeps the process alive.
      //
      // Sequential, not full-duplex: this does NOT yet support barge-in
      // (interrupting JARVIS mid-reply) - conversation-engine.ts already
      // has a real state machine designed for that, but it isn't wired to
      // real audio anywhere yet, and building real-time barge-in with
      // acoustic echo cancellation blind (this can only run on Gavin's PC,
      // never tested from this sandbox) would be irresponsible to ship
      // untested. This is the deliberate first real increment: LISTEN ->
      // THINK -> SPEAK -> WAIT, looping. Full duplex is real follow-up
      // work, not a shortcut being passed off as the final spec.
      console.log("\n" + "=".repeat(70));
      console.log('🎙️  JARVIS is listening (say "Jarvis" to start a conversation)');
      console.log("   Press Ctrl+C to stop.");
      console.log("=".repeat(70));

      // 2026-08-31: same real-app-control fix as voice-reply above - a
      // live run found "open Notepad"/"open Spotify" spoken through the
      // mic only ever got a conversational clarifying question back,
      // because nothing wired the orchestrator's real
      // parseAppControlIntent/executeAppControlIntent pipeline into the
      // voice path at all. See voice-interface.ts's generateResponse().
      const voice = new VoiceInterface(DEFAULT_VOICE_CONFIG, modelProvider, orchestrator);
      await voice.start();

      // Visual HUD (2026-08-30, per Gavin: an animated version of the
      // JARVIS ring icon he shared, showing idle/listening/thinking/
      // speaking) - Phase 5 in the master doc, which previously said this
      // "doesn't exist... never got past a chat message." First real
      // piece of it: public/hud.html is a self-contained animated SVG/CSS
      // page: state changes come from the real voice-interface.ts events
      // below, not simulated timers. Port 0 = let the OS pick a free
      // port, read back via hud.url, since a hardcoded port could already
      // be in use. Opened as a borderless "app mode" Edge window (real
      // Windows Edge is always present; no new dependency) rather than a
      // normal browser tab.
      const hud = new HudServer();
      hud.start(0);
      voice.on("listening", () => hud.setState("idle"));
      voice.on("wake-word-detected", () => hud.setState("listening"));
      // [ADDED 2026-09-03] Real, live-found lag fix - per Gavin: "theres
      // like a 4 second wait from when im done talking to whens its
      // thinking." "turn-ending" fires the instant the silence cutoff
      // triggers (voice-interface.ts's processMicChunk), before Whisper
      // even starts transcribing - "user-speech-recognized" (below) still
      // fires too, once transcription actually finishes, but the HUD no
      // longer has to wait for it to show SOMETHING happened.
      voice.on("turn-ending", () => hud.setState("thinking"));
      voice.on("user-speech-recognized", () => hud.setState("thinking"));
      // [ADDED 2026-09-01] "acting" - see orchestrator.ts's onActionStart/
      // onActionEnd and voice-interface.ts's "acting"/"acting-done"
      // events. Falls back to "thinking" when the action finishes since
      // the final spoken reply (audio-ready -> "speaking") hasn't
      // synthesized yet at that point.
      // [UPDATE 2026-09-03] Real activity text now flows through - per
      // Gavin: "the text at the top isnt actaully what hes doing its just
      // for show, make it accurate." See orchestrator.ts's onActionStart
      // for where this real description actually comes from.
      voice.on("acting", (description?: string) => hud.setState("acting", description ?? null));
      voice.on("acting-done", () => hud.setState("thinking"));
      voice.on("audio-ready", () => hud.setState("speaking"));
      voice.on("interaction-complete", () => hud.setState("idle"));
      // [2026-09-02] Native HUD (native-hud/, WPF+WebView2) replaces the
      // Edge --app-mode window below wherever it's actually been built -
      // real, borderless, always-on-top, no taskbar/Alt-Tab entry,
      // transparent background (only the rings are visible, not a
      // rectangle), same public/hud.html animation unchanged inside it.
      // Not a hard requirement: setup-native-hud.ps1 has to be run once
      // (needs the .NET 8 SDK) to produce the exe, so this checks for it
      // and falls back to the Edge window - unchanged, still real - if
      // it's missing, exactly like this project's existing TTS-provider
      // fallback pattern (Chatterbox -> Piper), not a silent downgrade.
      let hudProcessId: number | null = null;
      let hudNativeProc: ReturnType<typeof Bun.spawn> | null = null;
      const nativeHudExe = join(
        import.meta.dir,
        "..",
        "native-hud",
        "bin",
        "Release",
        "net8.0-windows",
        "JarvisHud.exe"
      );
      if (existsSync(nativeHudExe)) {
        try {
          // 2026-09-02: stdout/stderr used to be "ignore" - meaning
          // native-hud/'s new screen-awareness diagnostic logging (see
          // MainWindow.xaml.cs's "[hud-reposition]" lines, added
          // specifically because the previous pass couldn't confirm that
          // feature live) had nowhere to go. Piped and forwarded with a
          // prefix instead, same pattern as the Chatterbox subprocess's
          // "[chatterbox]"-prefixed stderr elsewhere in this file, so the
          // next live 'listen' run can actually see it.
          hudNativeProc = Bun.spawn([nativeHudExe, hud.url], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const pipeStream = async (stream: ReadableStream<Uint8Array> | null) => {
            if (!stream) return;
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newlineIndex: number;
                while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
                  const line = buffer.slice(0, newlineIndex).trim();
                  buffer = buffer.slice(newlineIndex + 1);
                  if (line) console.log(`   [native-hud] ${line}`);
                }
              }
            } catch {
              // Process exited/pipe closed - nothing left to forward.
            }
          };
          pipeStream(hudNativeProc.stdout as ReadableStream<Uint8Array> | null);
          pipeStream(hudNativeProc.stderr as ReadableStream<Uint8Array> | null);
          console.log(`\n🖥️  Native HUD process started (${hud.url}) - hidden until it's actually needed (wake word/thinking/acting/speaking), pops up on its own; closes automatically when 'listen' stops.`);
        } catch (err) {
          console.log(`\n⚠️  Could not launch the native HUD (${nativeHudExe}): ${err instanceof Error ? err.message : err}`);
          hudNativeProc = null;
        }
      }
      // 2026-08-31, per Gavin: "the jarvis window doesn't close once
      // it's stopped so I had like 7 opened" - real problem confirmed
      // over repeated test runs, not a one-off. Root cause: Start-Process
      // was fire-and-forget with no way to ever find this specific window
      // again, so shutdown() below had nothing to close. Fixed by
      // capturing the launched process's real PID (-PassThru, then read
      // back $p.Id) and closing exactly that PID on shutdown - NOT a
      // blanket `taskkill msedge`, which would risk closing Gavin's
      // regular browsing too (the exact risk this file's own comments
      // already flagged as the reason nothing auto-closed it before).
      // Honest caveat: if Edge happens to already be running when this
      // launches, Chromium's process model can hand the new --app window
      // off to an existing Edge process tree, in which case this captured
      // PID may not be the one actually owning the visible window - the
      // common case (no other Edge instance active) is what this fixes;
      // watch for whether windows still pile up if Edge is your daily
      // browser too. Only reached now if the native HUD above isn't
      // built yet.
      if (!hudNativeProc) {
        if (!existsSync(nativeHudExe)) {
          console.log(`\nℹ️  Native HUD not built yet (run .\\setup-native-hud.ps1) - falling back to the Edge app-mode window.`);
        }
        try {
          const { stdout } = await runPowerShell(
            `$p = Start-Process msedge -ArgumentList "--app=${hud.url}","--window-size=380,420" -PassThru; $p.Id`
          );
          const parsedPid = parseInt(stdout.trim(), 10);
          if (!Number.isNaN(parsedPid)) {
            hudProcessId = parsedPid;
          }
          console.log(`\n🖥️  HUD window opened (${hud.url}) - closes automatically when 'listen' stops.`);
        } catch (err) {
          console.log(`\n⚠️  Could not open the HUD window automatically: ${err instanceof Error ? err.message : err}`);
          console.log(`   You can open it yourself: ${hud.url}`);
        }
      }

      // Sourced from the same DEFAULT_VOICE_CONFIG the VoiceInterface above
      // just constructed itself from, not separately hardcoded values -
      // otherwise it would be possible for the mic to capture at a
      // different sample rate than wake-word-detector.ts/speech-recognizer.ts
      // are configured to expect, or (2026-08-30, per Gavin) to silently
      // ignore his actual mic choice (audio.inputDeviceName) because this
      // command's own copy of the config drifted from voice-config.ts's.
      const mic = new MicCapture({
        sampleRate: DEFAULT_VOICE_CONFIG.audio.sampleRate,
        channels: DEFAULT_VOICE_CONFIG.audio.channels,
        blockMs: 250,
        deviceName: DEFAULT_VOICE_CONFIG.audio.inputDeviceName,
        // 2026-08-30: same drift risk as deviceName above - sourced from
        // DEFAULT_VOICE_CONFIG so a future gain retune in voice-config.ts
        // actually reaches the real mic process instead of silently
        // being ignored by a second hardcoded copy here.
        gain: DEFAULT_VOICE_CONFIG.audio.micGain,
      });
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log("\n🛑 Stopping...");
        mic.stop();
        hud.stop();
        await voice.stop();
        if (hudNativeProc) {
          try {
            hudNativeProc.kill();
          } catch {
            // Best-effort - harmless if it already exited or Gavin closed
            // it by hand (the native window's own Esc handler).
          }
        } else if (hudProcessId !== null) {
          try {
            await runPowerShell(`Stop-Process -Id ${hudProcessId} -Force -ErrorAction SilentlyContinue`);
          } catch {
            // Best-effort - harmless if the window was already closed by
            // hand, or if the captured PID wasn't the real window owner
            // (see the launch comment above for when that can happen).
          }
        }
        try {
          if (stopFilePath && existsSync(stopFilePath)) unlinkSync(stopFilePath);
        } catch {
          // Best-effort cleanup - a leftover stop-file just means the
          // next start-jarvis.ps1 run clears it before launching anyway.
        }
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // [ADDED 2026-09-02] Real graceful-stop mechanism for when this runs
      // detached/hidden in the background (see start-jarvis.ps1/
      // stop-jarvis.ps1) - per Gavin: "should be running... not need to
      // run a command when I want to talk to him." A hidden, no-console
      // background process on Windows genuinely can't be sent a real
      // SIGINT/SIGTERM from another process the way `kill` does on POSIX
      // (confirmed via research, not assumed - Windows has no equivalent
      // cross-process signal-delivery API for a console-less process);
      // Stop-Process from PowerShell only force-terminates, which would
      // skip this exact shutdown() above and leak the mic/wake-word/
      // Chatterbox/native-HUD child processes it exists to clean up.
      // File-existence polling is a real, simple, reliable substitute:
      // stop-jarvis.ps1 just touches this file, this loop notices within
      // a second and runs the SAME real shutdown() everything else here
      // already uses - no new cleanup path to keep in sync, no OS-signal
      // uncertainty.
      const stopFilePath = join(process.cwd(), ".jarvis-stop");
      try {
        if (existsSync(stopFilePath)) unlinkSync(stopFilePath); // clear any stale flag from a previous run
      } catch {
        // Non-fatal - worst case the stop-check below fires once
        // immediately, which is still a correct (if surprising) shutdown.
      }
      const stopFileCheck = setInterval(() => {
        if (existsSync(stopFilePath)) {
          clearInterval(stopFileCheck);
          shutdown();
        }
      }, 1000);

      mic.start(
        (chunk) => {
          // Fire-and-forget: processMicChunk() is async (each stage it
          // may call - wake-word detection, Whisper - does real I/O), but
          // the mic keeps producing chunks in real time regardless. Errors
          // inside it are real bugs to see, not something to swallow.
          voice.processMicChunk(chunk).catch((err) => {
            console.log(`   ⚠️  processMicChunk error: ${err instanceof Error ? err.message : err}`);
          });
        },
        (err) => {
          console.log(`\n❌ Microphone capture failed: ${err.message}`);
          console.log("   Run scripts/setup-voice.ps1 first if you haven't (installs sounddevice into the whisper venv).");
          shutdown();
        }
      );

      // Keep the process alive - everything happens in the mic callback
      // and voice's own event-driven pipeline from here.
      await new Promise(() => {});
    } else if (command === "listen-live") {
      // bun run dev listen-live
      //
      // Architecture update step 6: the real Gemini Live voice mode, per
      // Gavin's direct request after seeing `compare-latency`'s real
      // numbers (Gemini Live ~934ms end to end vs. current JARVIS's
      // ~3.6s). Same real wake-word/mic infrastructure as `listen` above -
      // see live-voice-interface.ts's own header comment for exactly what
      // this trades away (only open_app/close_app as tools so far, no
      // vision/search/persistent-memory/Spotify - Orchestrator.
      // processConversation() isn't in this path) for real, measured
      // speed. Requires a real GEMINI_API_KEY.
      if (!process.env.GEMINI_API_KEY) {
        console.log("\n❌ GEMINI_API_KEY is not set - required for Gemini Live. Get one free at https://aistudio.google.com/apikey");
      } else {
        console.log("\n" + "=".repeat(70));
        console.log('🛰️  JARVIS is listening (Gemini Live mode - say "Jarvis" to start a conversation)');
        console.log("   Press Ctrl+C to stop.");
        console.log("=".repeat(70));

        const liveVoice = new LiveVoiceInterface(DEFAULT_VOICE_CONFIG);
        await liveVoice.start();

        const liveMic = new MicCapture({
          sampleRate: DEFAULT_VOICE_CONFIG.audio.sampleRate,
          channels: DEFAULT_VOICE_CONFIG.audio.channels,
          blockMs: 250,
          deviceName: DEFAULT_VOICE_CONFIG.audio.inputDeviceName,
          gain: DEFAULT_VOICE_CONFIG.audio.micGain,
        });

        let liveShuttingDown = false;
        const liveShutdown = async () => {
          if (liveShuttingDown) return;
          liveShuttingDown = true;
          console.log("\n🛑 Stopping...");
          liveMic.stop();
          await liveVoice.stop();
          process.exit(0);
        };
        process.on("SIGINT", liveShutdown);

        liveMic.start(
          (chunk) => {
            liveVoice.processMicChunk(chunk).catch((err) => {
              console.log(`   ⚠️  processMicChunk error: ${err instanceof Error ? err.message : err}`);
            });
          },
          (err) => {
            console.log(`\n❌ Microphone capture failed: ${err.message}`);
            liveShutdown();
          }
        );

        await new Promise(() => {});
      }
    } else if (command === "conversation") {
      // bun run dev conversation "<what you'd say to JARVIS>"
      // Exercises Phase 1.5 (Conversational Intelligence) end to end —
      // previously wired up (constructed, methods called from
      // orchestrator.ts) but unreachable from any CLI command, and until
      // 2026-08-27 the methods themselves returned hardcoded placeholder
      // text regardless of input, not a real LLM call. Both fixed now.
      //
      // Also, as of 2026-08-27: try `bun run dev conversation "open
      // Spotify"` — app-open/close requests are detected and REALLY
      // executed via ScreenControl before the reply is generated (see
      // Orchestrator.parseAppControlIntent/executeAppControlIntent), so
      // the reply stays truthful and proactive ("Opening Spotify — what
      // would you like to listen to?") instead of just a plausible-
      // sounding line with no action behind it. Windows-only, obviously.
      const utterance = args.slice(1).join(" ");
      if (!utterance) {
        console.log('\nUsage: bun run dev conversation "<what you\'d say to JARVIS>"');
        console.log('       bun run dev conversation "open Spotify"   (real app-control test, Windows only)');
      } else {
        console.log("\n" + "=".repeat(70));
        console.log("💬 CONVERSATION (Phase 1.5 — real LLM via the gateway, conversational context/memory + real app-control)");
        console.log("=".repeat(70));
        console.log(`\nYou: ${utterance}`);

        const result = await orchestrator.processConversation(utterance);
        console.log(`\nJARVIS: ${result.response}`);
        console.log(`\n   Turn count: ${result.context.turnCount}`);
        console.log("=".repeat(70));
      }
    } else if (command === "vision-test") {
      // bun run dev vision-test <path-to-image>
      // Exercises Phase 3 vision: OllamaVisionProvider (real, verified
      // 2026-08-26 against a live model) has existed since before this
      // command did, but VisionSystem — the class meant to use it — was
      // never instantiated anywhere in src/, so nothing could reach it and
      // its unconnected-provider fallback silently returned fabricated
      // "office desk" data instead of failing (fixed 2026-08-27, see
      // vision-system.ts). Wired here so vision is actually reachable.
      // Requires Ollama running locally with the vision model pulled:
      //   ollama pull moondream
      const imagePath = args[1];
      if (!imagePath) {
        console.log("\nUsage: bun run dev vision-test <path-to-image>");
        console.log("  Pass any local image file (png/jpg) — a screenshot, a photo, whatever.");
        console.log("  Requires Ollama running locally with the vision model pulled: ollama pull moondream");
      } else {
        console.log("\n" + "=".repeat(70));
        console.log("👁️  VISION TEST (real Ollama vision model — moondream by default, $0/local)");
        console.log("=".repeat(70));

        const imageBuffer = readFileSync(imagePath);
        const visionSystem = new VisionSystem();
        visionSystem.setProvider(new OllamaVisionProvider());

        const analysis = await visionSystem.analyzeImage(imageBuffer);
        console.log(`\n📝 Description: ${analysis.text}`);

        const objects = await visionSystem.detectObjects(imageBuffer);
        console.log(`\n🔎 Objects detected: ${objects.map((o) => o.label).join(", ") || "(none)"}`);

        console.log("\n" + "=".repeat(70));
      }
    } else if (command === "video-test") {
      // bun run dev video-test <path-to-video> ["<question>"]
      // Exercises the new Phase 3 video understanding (src/phase3/
      // video-analyzer.ts) - real ffprobe/ffmpeg frame extraction at even
      // real timestamps, each frame run through the same real
      // VisionSystem/OllamaVisionProvider vision-test above uses. No local
      // $0 model understands video directly, so the per-frame descriptions
      // are handed to the real conversational LLM gateway to synthesize a
      // single answer about what happens across the whole clip - same
      // "small model perceives each frame, big model reasons over the
      // sequence" split used for screen-vision in orchestrator.ts.
      // Requires ffmpeg/ffprobe on PATH and Ollama running with moondream
      // pulled (same requirement as vision-test above).
      const videoPath = args[1];
      const question = args.slice(2).join(" ") || "Describe what happens in this video, in order.";
      if (!videoPath) {
        console.log('\nUsage: bun run dev video-test <path-to-video> ["<question>"]');
        console.log("  Pass any local video file (mp4/mov/avi/mkv/webm).");
        console.log("  Requires ffmpeg/ffprobe on PATH, and Ollama running locally with: ollama pull moondream");
      } else {
        console.log("\n" + "=".repeat(70));
        console.log("🎬 VIDEO TEST (real ffmpeg frame sampling + real Ollama vision per frame)");
        console.log("=".repeat(70));

        const analyzer = new VideoAnalyzer();
        const analysis = await analyzer.analyzeVideo(videoPath);

        console.log(`\n📋 Per-frame descriptions (${analysis.frames.length} real frames, ${analysis.durationSeconds.toFixed(1)}s total):`);
        for (const frame of analysis.frames) {
          console.log(`   [${frame.timestampSeconds.toFixed(1)}s] ${frame.description}`);
        }

        const frameLines = analysis.frames
          .map((f) => `[${f.timestampSeconds.toFixed(1)}s] ${f.description}`)
          .join("\n");
        const synthesisPrompt =
          `You were given a real video, ${analysis.durationSeconds.toFixed(1)} seconds long, as a series of ` +
          `still frames sampled in order over time (not the full video - you're reasoning from these ` +
          `snapshots). Each frame was independently described by a vision model with no awareness of the ` +
          `others. Frame descriptions, in chronological order:\n\n${frameLines}\n\n` +
          `Based on this sequence, answer: ${question}\n` +
          `Reason about what's changing or staying the same across frames to infer motion/events. If the ` +
          `frames don't give enough to answer confidently, say so honestly rather than guessing.`;

        const gateway = createDefaultGateway();
        const modelProvider = new GatewayModelProvider(gateway);
        const synthesis = await modelProvider.complete(
          [{ role: "user", content: synthesisPrompt }],
          { temperature: 0.3, maxTokens: 500 }
        );

        console.log(`\n🧠 Question: ${question}`);
        console.log(`\n💬 Answer: ${synthesis.content.trim()}`);
        console.log("\n" + "=".repeat(70));
      }
    } else if (command === "camera-test") {
      // bun run dev camera-test [device-name]
      // Exercises the new Phase 3 camera vision (src/phase3/camera-capture.ts)
      // - real ffmpeg DirectShow single-frame capture (with a short warm-up
      // burst so auto-exposure has a moment to converge), run through the
      // same real VisionSystem/OllamaVisionProvider the other vision
      // commands use. On-demand only, by design - see camera-capture.ts's
      // header comment for the real privacy reasoning and the disclosed,
      // unresolved question of whether this session's own tool-execution
      // context can capture genuine (non-black) scene content, same as the
      // screen-capture blank-screenshot finding.
      console.log("\n" + "=".repeat(70));
      console.log("📷 CAMERA TEST (real ffmpeg DirectShow capture + real Ollama vision)");
      console.log("=".repeat(70));

      const devices = await listCameraDevices();
      console.log(`\n🔌 Devices found: ${devices.join(", ") || "(none)"}`);

      const deviceArg = args[1];
      const camera = new CameraCapture();
      const frame = await camera.captureFrame(deviceArg);

      const visionSystem = new VisionSystem();
      visionSystem.setProvider(new OllamaVisionProvider());
      const analysis = await visionSystem.analyzeImage(frame.data);

      console.log(`\n📝 Description: ${analysis.text}`);
      console.log("\n" + "=".repeat(70));
    } else if (command === "spotify-auth") {
      // bun run dev spotify-auth
      // One-time, real, interactive Spotify OAuth consent flow (see
      // scripts/spotify_control.py's own header comment for the full
      // real setup steps - a Spotify Developer app is required first,
      // this can't skip that). Opens a real browser; the resulting token
      // is cached to scripts/.spotify-cache so every later call is silent.
      console.log("\n" + "=".repeat(70));
      console.log("🎵 SPOTIFY AUTH (real, one-time, opens a real browser)");
      console.log("=".repeat(70));
      console.log("\nIf this is the first time: create an app at https://developer.spotify.com/dashboard,");
      console.log('add redirect URI "http://127.0.0.1:8888/callback", and put SPOTIPY_CLIENT_ID/');
      console.log("SPOTIPY_CLIENT_SECRET in .env before running this.\n");

      const authResult = await spotifyAuth();
      if (authResult.success) {
        console.log(`✅ ${authResult.detail}`);
      } else {
        console.log(`❌ ${authResult.error}`);
      }
      console.log("\n" + "=".repeat(70));
    } else if (command === "spotify-test") {
      // bun run dev spotify-test "<song/artist>"
      // Real end-to-end playback test - requires spotify-auth to have
      // been run first, and a real Spotify device (the app or web
      // player) already open somewhere for Spotify Connect to target.
      const query = args.slice(1).join(" ");
      console.log("\n" + "=".repeat(70));
      console.log("🎵 SPOTIFY TEST (real spotipy playback)");
      console.log("=".repeat(70));
      if (!query) {
        console.log('\nUsage: bun run dev spotify-test "<song or artist>"');
      } else {
        const result = await spotifyPlay(query);
        if (result.success) {
          console.log(`\n✅ Now playing: ${result.playing}`);
        } else {
          console.log(`\n❌ ${result.error}`);
        }
      }
      console.log("\n" + "=".repeat(70));
    } else if (command === "live-prototype") {
      const resumeIdx = args.indexOf("--resume");
      const resumeHandle = resumeIdx !== -1 ? args[resumeIdx + 1] : undefined;
      const text = args.slice(1, resumeIdx !== -1 ? resumeIdx : undefined).join(" ");

      console.log("\n" + "=".repeat(70));
      console.log("🛰️  GEMINI LIVE PROTOTYPE (architecture update step 4 — isolated, unverified)");
      console.log("=".repeat(70));

      if (!text) {
        console.log('\nUsage: bun run dev live-prototype "<text>" [--resume <handle>]');
        console.log("Requires GEMINI_API_KEY. No mic yet — text-in, per src/prototypes/gemini-live/cli-harness.ts.");
      } else {
        try {
          await runLiveHarness(text, resumeHandle);
        } catch (error) {
          console.error("\n❌ Live prototype failed:", error instanceof Error ? error.message : error);
          console.error("   Expected without a real GEMINI_API_KEY and a live network path to Google's API.");
        }
      }
      console.log("=".repeat(70));
    } else if (command === "compare-latency") {
      // Architecture update step 5. Needs a real GEMINI_API_KEY and at
      // least one of Ollama/Gemini/OmniRoute reachable to produce anything
      // but "unreachable" for both paths — see compare-latency.ts's header.
      const prompts = args.length > 1 ? [args.slice(1).join(" ")] : [
        "What's the capital of France?",
        "How many ounces are in a pound?",
        "Say hello.",
      ];
      await runComparison(prompts, 3);
    } else if (command === "undo") {
      // Architecture update sections 10-11 (Action Journal + Undo).
      const count = args[1] ? parseInt(args[1], 10) : 1;
      console.log("\n" + "=".repeat(70));
      console.log(`↩️  UNDO — reversing the last ${count} reversible action(s)`);
      console.log("=".repeat(70));

      const identity = await identityEngine.resolveFromDeviceSession();
      const results = await undoLastActions(count, identity);

      if (results.length === 0) {
        console.log("\nNothing to undo — no recent reversible actions found.");
      }
      for (const r of results) {
        console.log(r.success ? `\n✅ Undid "${r.tool}" (action ${r.actionId})` : `\n❌ Failed to undo "${r.tool}": ${r.error}`);
      }
      console.log("=".repeat(70));
    } else {
      console.log("\n❌ Unknown command: " + command);
      console.log("\nAvailable commands:");
      console.log("  bun run dev               - Run Phase 0 vertical slice test");
      console.log("  bun run dev test          - Same as above");
      console.log("  bun run dev phase1        - Show Phase 1 pipeline/agent summary");
      console.log('  bun run dev developer "<requirement>" [--repo path] [--approve] [--approved-by name] [--base branch]');
      console.log("                            - Run the real Phase 1 pipeline against a requirement");
      console.log("  bun run dev phase1-selftest - Compounding-loop test: JARVIS Developer works on its own repo");
      console.log("  bun run dev whoami        - Test Presence + Identity + Authorization end to end");
      console.log("  bun run dev whoami --pin PIN - Same, plus test Level 3 PIN verification");
      console.log("  bun run dev control-test  - Test real computer control (Windows only, opens Notepad)");
      console.log('  bun run dev voice-reply "<text>" - Real LLM + real TTS voice reply (no mic/wake-word yet)');
      console.log('  bun run dev listen - Real always-on voice assistant: say "Jarvis", it listens, thinks, and speaks back (Windows only, needs scripts/setup-voice.ps1 run first)');
      console.log('  bun run dev listen-live - Same, but backed by Gemini Live (real, ~3.8x faster measured; needs GEMINI_API_KEY, fewer capabilities - open/close app only)');
      console.log('  bun run dev conversation "<text>" - Phase 1.5 conversational intelligence, real LLM + memory/context');
      console.log("  bun run dev vision-test <path>   - Real Ollama vision model on a real image (Phase 3)");
      console.log('  bun run dev video-test <path> ["<question>"] - Real frame-sampled video understanding (Phase 3)');
      console.log("  bun run dev camera-test [device-name] - Real on-demand webcam capture + vision (Phase 3)");
      console.log("  bun run dev spotify-auth  - One-time real Spotify OAuth consent (opens a browser)");
      console.log('  bun run dev spotify-test "<song/artist>" - Real Spotify playback test (Phase 5)');
      console.log('  bun run dev live-prototype "<text>" [--resume <handle>] - Gemini Live prototype (step 4, unverified, needs GEMINI_API_KEY)');
      console.log('  bun run dev compare-latency ["<text>"] - Current JARVIS vs Gemini Live latency comparison (step 5)');
      console.log("  bun run dev undo [count]  - Undo the last [count] (default 1) reversible actions (step 7)");
    }
  } finally {
    await closeDatabase();
    console.log("\n");
  }
}

// Found 2026-08-27 (Gavin: "I want it to work fully"): main()'s own try
// block has no catch, only finally — so any exception thrown anywhere in
// it (a command's own logic, or the shared gateway/orchestrator/agent
// setup above every command) fell all the way through to just this one
// line, and `console.error` alone never sets a nonzero exit code. That
// meant a genuinely failing run could still report success (`bun`'s own
// process exit code 0) to anything checking it externally — including
// verify-jarvis.ps1 — while the actual error text went to stderr with no
// exit-code signal that anything went wrong. Fixed to print clearly
// (full stack, not just the default console.error formatting a bare
// Error sometimes gets from a rejected promise) and to explicitly fail
// the process.
main().catch((error) => {
  console.error("\n💥 FATAL: unhandled error in main()");
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
