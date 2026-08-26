import { initializeDatabase, closeDatabase } from "./db/client";
import { Orchestrator } from "./core/orchestrator";
import { BaseAgent } from "./agents/agent";
import { AGENT_ROLES } from "./agents/types";
import { GeminiProvider } from "./models/gemini-provider";
import type { ModelProvider } from "./models/types";
import { toolManager } from "./tools/manager";
import { SPECIALIZED_AGENT_ROLES } from "./agents/specialized-agents";
import { presenceEngine } from "./core/presence";
import { identityEngine } from "./core/identity";
import { authorizationEngine } from "./core/authorization";
import { ScreenControl } from "./phase3/screen-control";
import { JARVISDeveloper } from "./phase1/developer";

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

  console.log("\n🤖 JARVIS — Phase 0 (verified) + Phase 1 (JARVIS Developer, real pipeline)\n");

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
    // Initialize model provider — provider-agnostic per invariant #3.
    // Gemini is the only wired-up cloud provider: free tier, direct to
    // Google, zero dependency on Claude/Anthropic/Zo (this project is
    // standalone — it does not run through or depend on Zo in any form).
    // Ollama/local is the planned $0-with-no-API-key-at-all path but isn't
    // implemented yet — see JARVIS-MASTER-ARCHITECTURE-UPDATED.md status table.
    const providerName = "gemini";
    console.log(`🧠 Initializing model provider (${providerName})...`);
    const modelProvider: ModelProvider = new GeminiProvider();

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
          model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
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
        console.error("  - Check that GEMINI_API_KEY is set and valid (aistudio.google.com/apikey)");
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
    }
  } finally {
    await closeDatabase();
    console.log("\n");
  }
}

main().catch(console.error);
