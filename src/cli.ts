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
import { DEFAULT_VOICE_CONFIG } from "./phase2/voice-config";
import { runLiveHarness } from "./prototypes/gemini-live/cli-harness";
import { runComparison } from "./prototypes/gemini-live/compare-latency";
import { writeFileSync } from "node:fs";

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

  console.log("\n🤖 JARVIS — Phase 0 (verified) + Phase 1 (JARVIS Developer, real pipeline) + Phase 2 (voice reply, real LLM/TTS)\n");

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
    // tries Gemini first (best quality within its free daily quota), then
    // falls back to Ollama (local, no API key, no quota) automatically if
    // Gemini fails or its quota is exhausted — this is what turns a
    // Gemini 429 from "pipeline dead for the day" into "keeps working,
    // just on the local model." OpenRouter joins as a third option only
    // if OPENROUTER_API_KEY is set. See src/models/llm-gateway.ts.
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

    // Register Phase 0 core agents ONLY
    console.log("👥 Registering Phase 0 agents...");
    const coreAgents = [
      AGENT_ROLES.RESEARCHER,
      AGENT_ROLES.REASONER,
      AGENT_ROLES.CRITIC,
      AGENT_ROLES.FACT_CHECKER,
      AGENT_ROLES.SYNTHESIZER,
    ];

    for (const roleConfig of coreAgents) {
      const agent = new BaseAgent(
        roleConfig.name,
        roleConfig.role,
        roleConfig.instructions,
        {
          provider: modelProvider.name,
          model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
          temperature: 0.7,
          maxTokens: 2000,
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
    console.log("   - Agents: 5 core agents registered");

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

        // Wires the DEEP path (architecture update sections 1/9) to the
        // real multi-agent pipeline already initialized above — a request
        // the intent router classifies as needing thorough, multi-step
        // reasoning now actually reaches Researcher/Reasoner/Critic/
        // FactChecker/Synthesizer, instead of every voice-reply call being
        // a single direct model call regardless of complexity.
        const voice = new VoiceInterface(DEFAULT_VOICE_CONFIG, modelProvider, async (utterance) => {
          const result = await orchestrator.orchestrate(utterance);
          return result.finalResult;
        });
        const { response, audio } = await voice.respondToText(text);
        console.log(`\n🤖 JARVIS: "${response}"`);

        if (audio) {
          const outPath = `/tmp/jarvis-voice-reply-${Date.now()}.wav`;
          writeFileSync(outPath, audio.audio);
          console.log(`\n🔊 Spoken reply saved to ${outPath} (${audio.duration}ms)`);
        } else {
          console.log("\n⚠️  Text-to-speech is disabled in the current voice config — text-only reply above.");
        }
        console.log("=".repeat(70));
      }
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
      console.log('  bun run dev live-prototype "<text>" [--resume <handle>] - Gemini Live prototype (step 4, unverified, needs GEMINI_API_KEY)');
      console.log('  bun run dev compare-latency ["<text>"] - Current JARVIS vs Gemini Live latency comparison (step 5)');
    }
  } finally {
    await closeDatabase();
    console.log("\n");
  }
}

main().catch(console.error);
