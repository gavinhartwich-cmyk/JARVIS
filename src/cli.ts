import { initializeDatabase, closeDatabase } from "./db/client";
import { Orchestrator } from "./core/orchestrator";
import { BaseAgent } from "./agents/agent";
import { AGENT_ROLES } from "./agents/types";
import { ClaudeProvider } from "./models/claude-provider";
import { SPECIALIZED_AGENT_ROLES } from "./agents/specialized-agents";

/**
 * JARVIS CLI
 * Entry point for the system
 */

async function main() {
  console.log("\n🤖 JARVIS Phase 0 - Initialization\n");

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

    // Test the system with a vertical slice
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
      console.log("\nPhase 0 foundation is working!");
      console.log("Next steps:");
      console.log("  1. Add more specialized agents");
      console.log("  2. Implement task persistence");
      console.log("  3. Build the CLI interface");
      console.log("  4. Add tool execution support");
    } catch (error) {
      console.error("\n❌ Vertical slice test failed:");
      console.error(error instanceof Error ? error.message : String(error));
    }
  } finally {
    await closeDatabase();
    console.log("\n");
  }
}

main().catch(console.error);
