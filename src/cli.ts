import { initializeDatabase, closeDatabase } from "./db/client";
import { Orchestrator } from "./core/orchestrator";
import { BaseAgent } from "./agents/agent";
import { AGENT_ROLES } from "./agents/types";
import { ClaudeProvider } from "./models/claude-provider";
import { toolManager } from "./tools/manager";
import { SPECIALIZED_AGENT_ROLES } from "./agents/specialized-agents";
import { VoiceInterface } from "./voice/index";
import { LocationTracker } from "./location/index";

/**
 * JARVIS CLI
 * Entry point for the system
 * Supports: orchestration, voice interface, location tracking
 */

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "test";

  console.log("\n🤖 JARVIS Phase 2 - Voice & Location\n");

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
    // Initialize model provider
    console.log("🧠 Initializing model provider...");
    const modelProvider = new ClaudeProvider();

    // Initialize tools
    console.log("🔧 Initializing tools...");
    const availableTools = toolManager.getAvailableTools();
    console.log(`   📋 ${availableTools.length} tools registered`);

    const isAvailable = await modelProvider.available();
    if (!isAvailable) {
      console.warn("⚠️  Claude provider not available. Set ZO_API_KEY environment variable.");
      console.warn("   For now, using the provider anyway - will fail on actual queries.");
    }

    // Initialize orchestrator
    console.log("🎼 Initializing orchestrator...");
    const orchestrator = new Orchestrator();

    // Register agents - Phase 0 core + Phase 1 specialized
    console.log("👥 Registering agents...");
    const agentList = [
      // Phase 0 core agents
      AGENT_ROLES.RESEARCHER,
      AGENT_ROLES.REASONER,
      AGENT_ROLES.CRITIC,
      AGENT_ROLES.FACT_CHECKER,
      AGENT_ROLES.SYNTHESIZER,
      // Phase 1 specialized agents
      SPECIALIZED_AGENT_ROLES.ARCHITECT,
      SPECIALIZED_AGENT_ROLES.CODER,
      SPECIALIZED_AGENT_ROLES.TESTER,
      SPECIALIZED_AGENT_ROLES.DEBUGGER,
      SPECIALIZED_AGENT_ROLES.CODE_REVIEWER,
      SPECIALIZED_AGENT_ROLES.SECURITY_REVIEWER,
      SPECIALIZED_AGENT_ROLES.PERFORMANCE_ANALYZER,
      SPECIALIZED_AGENT_ROLES.ANALYZER,
      SPECIALIZED_AGENT_ROLES.EXPLAINER,
      SPECIALIZED_AGENT_ROLES.SIMPLIFIER,
      SPECIALIZED_AGENT_ROLES.PLANNER,
      SPECIALIZED_AGENT_ROLES.ERROR_ANALYZER,
      SPECIALIZED_AGENT_ROLES.VERIFIER,
    ];

    for (const roleConfig of agentList) {
      const agent = new BaseAgent(
        roleConfig.name,
        roleConfig.role,
        roleConfig.instructions,
        {
          provider: "claude",
          model: "claude-haiku-4-5",
          temperature: 0.7,
          maxTokens: 2000,
        },
        modelProvider
      );
      orchestrator.registerAgent(agent);
      console.log(`   ✓ ${roleConfig.role}`);
    }

    // Handle commands
    switch (command) {
      case "voice": {
        console.log("\n🎤 Starting Voice Interface (Phase 2)\n");
        const zoApiKey = process.env.ZO_API_KEY || "";
        
        const voiceInterface = new VoiceInterface(orchestrator, {
          zoApiKey,
          sttModel: "whisper-1",
          ttsVoice: "en-us-libritts-high",
          wakeWords: ["hey jarvis", "jarvis"],
          locationTracking: true,
          autoPlay: true,
        });

        await voiceInterface.start();
        
        // Run for a bit to allow testing
        console.log("\n📝 Voice interface is running (send 'exit' to stop)");
        console.log("   Say: 'Hey JARVIS' to activate");
        
        // Keep running until interrupted
        await new Promise((resolve) => {
          process.on("SIGINT", resolve);
          setTimeout(resolve, 300000); // 5 minute timeout
        });

        await voiceInterface.stop();
        break;
      }

      case "location": {
        console.log("\n📍 Starting Location Tracking (Phase 3.2)\n");
        const zoApiKey = process.env.ZO_API_KEY || "";
        
        const tracker = new LocationTracker(zoApiKey);
        tracker.startTracking();

        console.log("\n📍 Location tracking enabled");
        console.log("   Current rooms configured:");
        tracker.getRooms().forEach((room) => {
          console.log(`   - ${room.name} (${room.latitude}, ${room.longitude})`);
        });

        // Get current context
        const context = await tracker.getLocationContext();
        console.log(`\n   Current location: ${context.currentRoom?.name || "Unknown"}`);
        console.log(`   Home distance: ${context.homeDistance.toFixed(0)}m`);

        tracker.stopTracking();
        break;
      }

      case "test":
      default: {
        console.log("\n" + "=".repeat(60));
        console.log("🚀 RUNNING VERTICAL SLICE TEST");
        console.log("=".repeat(60));

        const testTask = "What are the key differences between TypeScript and Python for building AI systems?";
        console.log(`\nTask: ${testTask}\n`);

        try {
          const result = await orchestrator.orchestrate(testTask);

          console.log("\n" + "=".repeat(60));
          console.log("📊 RESULT");
          console.log("=".repeat(60));

          console.log(`\nTask ID: ${result.taskId}`);
          console.log(`Status: ${result.verificationStatus}`);
          console.log(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
          console.log(`\nFinal Answer:\n${result.finalResult}`);

          console.log("\n" + "=".repeat(60));
          console.log("✅ VERTICAL SLICE TEST PASSED");
          console.log("=".repeat(60));
          console.log("\nPhase 0-1.5 foundation is working!");
          console.log("\nAvailable commands:");
          console.log("  bun run dev voice    - Start voice interface (Phase 2)");
          console.log("  bun run dev location - Check location tracking (Phase 3.2)");
          console.log("  bun run dev test     - Run this test");
        } catch (error) {
          console.error("\n❌ Vertical slice test failed:");
          console.error(error instanceof Error ? error.message : String(error));
        }
      }
    }
  } finally {
    await closeDatabase();
    console.log("\n");
  }
}

main().catch(console.error);
