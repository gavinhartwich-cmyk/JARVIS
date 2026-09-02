import { Agent, AgentInput, AgentOutput } from "../agents/types";
import { getDatabase } from "../db/client";
import { tasks, agentRuns } from "../db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { logAuditEvent } from "./audit";
import { storeMemory } from "./memory";
import { TaskDecomposer } from "./task-decomposer";
import { toolManager } from "../tools/manager";
import { ConversationEngine } from "../phase2/conversation-engine";
import { ConversationalIntelligence, type ActionOutcome } from "./conversation-intelligence";
import { IntelligentModelRouter } from "./model-router";
import { identityEngine, type IdentityResult } from "./identity";
import { createDefaultGateway, GatewayModelProvider } from "../models/llm-gateway";
import { ScreenControl } from "../phase3/screen-control";
import { ScreenCapture } from "../phase3/screen-capture";
import { VisionSystem } from "../phase3/vision-system";
import { OllamaVisionProvider } from "../phase3/ollama-vision-provider";
import type { ModelProvider } from "../models/types";

/**
 * Orchestrator with Conversational Intelligence
 *
 * Central coordinator that integrates:
 * - Multi-agent reasoning
 * - Conversational state management
 * - Intelligent model routing
 * - Memory systems (short + long-term)
 * - Proactive monitoring
 * - Natural interaction
 */

export interface TaskDecomposition {
  mainGoal: string;
  subgoals: string[];
  agentSequence: string[];
  metadata?: Record<string, unknown>;
}

export interface OrchestrationResult {
  taskId: string;
  finalResult: string;
  confidence: number;
  verificationStatus: string;
  agentOutputs: Record<string, AgentOutput>;
  conflicts?: string[];
  evidence: string[];
}

export class Orchestrator {
  private agents: Map<string, Agent> = new Map();
  private decomposer = new TaskDecomposer();

  // [ADDED 2026-09-01] Real-action activity hooks, purely for the HUD.
  // processConversation() below runs a genuinely slow real-world step -
  // executeAppControlIntent() shells out to Windows (opening/closing an
  // app, and eventually real mouse/keyboard control) - that can take
  // seconds, distinct from ordinary "the LLM is generating a reply"
  // latency. Orchestrator has no idea a HUD exists (correctly - it stays
  // a plain library class), so it just calls these optional callbacks if
  // a caller (voice-interface.ts) sets them. No-ops by default.
  onActionStart?: () => void;
  onActionEnd?: () => void;

  // Conversational intelligence integration
  private conversationEngine: ConversationEngine;
  private conversationalIntelligence: ConversationalIntelligence;
  private modelRouter: IntelligentModelRouter;
  // Same gateway ConversationalIntelligence uses, kept here too so
  // classifyAppControlIntent() (below) can make its own direct call — a
  // classification task, not a conversational reply, so it deliberately
  // doesn't go through IntelligentModelRouter's reply-tiering.
  private modelProvider: ModelProvider;

  // Real screen capture + vision, lazily constructed on first use (both
  // are cheap to construct — the cost is in the actual capture/analyze
  // calls, which only happen when a screen-vision intent is genuinely
  // detected below). Shared VisionSystem instance so the OllamaVisionProvider
  // connection only happens once per process, same pattern as
  // cachedIdentity below.
  private screenCapture?: ScreenCapture;
  private visionSystem?: VisionSystem;

  private getVisionSystem(): VisionSystem {
    if (!this.visionSystem) {
      this.visionSystem = new VisionSystem();
      this.visionSystem.setProvider(new OllamaVisionProvider());
    }
    return this.visionSystem;
  }

  private getScreenCapture(): ScreenCapture {
    if (!this.screenCapture) {
      this.screenCapture = new ScreenCapture();
    }
    return this.screenCapture;
  }

  // Resolved once per process, not per tool call — a real PIN-elevation
  // flow would refresh this; for now every tool call in a run shares the
  // same device-session identity (see IdentityEngine).
  private cachedIdentity: IdentityResult | null = null;

  private async getIdentity(): Promise<IdentityResult> {
    if (!this.cachedIdentity) {
      this.cachedIdentity = await identityEngine.resolveFromDeviceSession();
    }
    return this.cachedIdentity;
  }

  constructor() {
    // Initialize conversational layer
    this.conversationEngine = new ConversationEngine();
    this.modelRouter = new IntelligentModelRouter();
    // Same gateway every other real call site uses (OmniRoute → Ollama →
    // Gemini → OpenRouter) — this is what makes processConversation() a
    // real LLM call instead of the hardcoded placeholder text it returned
    // before 2026-08-27.
    this.modelProvider = new GatewayModelProvider(createDefaultGateway());
    this.conversationalIntelligence = new ConversationalIntelligence(
      this.conversationEngine,
      this.modelRouter,
      this.modelProvider
    );

    // Set up proactive monitors
    this.setupProactiveMonitors();
  }

  /**
   * Setup proactive monitoring capabilities
   */
  private setupProactiveMonitors(): void {
    // Monitor for unfinished tasks
    this.conversationalIntelligence.registerProactiveMonitor(
      "pending-tasks",
      async () => {
        const context = this.conversationEngine.getConversationContext();
        if (
          context.workingMemory.currentTask &&
          this.conversationEngine.getStatus().pendingActionsCount > 0
        ) {
          return `You have ${this.conversationEngine.getStatus().pendingActionsCount} pending actions.`;
        }
        return null;
      }
    );

    // Monitor for conversation length
    this.conversationalIntelligence.registerProactiveMonitor(
      "long-conversation",
      async () => {
        const status = this.conversationEngine.getStatus();
        if (status.turnCount > 20) {
          return "We've been talking for a while. Would you like a summary?";
        }
        return null;
      }
    );
  }

  registerAgent(agent: Agent) {
    this.agents.set(agent.name, agent);
  }

  async orchestrate(userTask: string): Promise<OrchestrationResult> {
    const taskId = uuid();
    const db = getDatabase();

    // Step 1: Create task record
    console.log(`\n📋 Task ${taskId}: ${userTask}`);

    await db.insert(tasks).values({
      id: taskId,
      title: userTask.substring(0, 100),
      description: userTask,
      userInput: userTask,
      status: "created",
    });

    await logAuditEvent({
      actor: "orchestrator",
      action: "created",
      resource: "task",
      resourceId: taskId,
      input: { userInput: userTask },
      statusCode: 200,
    });

    try {
      // Step 2: Decompose task
      console.log(`\n🔍 Decomposing task...`);
      const decomposition = await this.decomposeTask(userTask, taskId);

      await db
        .update(tasks)
        .set({ decomposition: decomposition as any, status: "decomposed" })
        .where(eq(tasks.id, taskId));

      // Step 3: Execute agent pipeline
      console.log(`\n⚙️  Executing agent pipeline: ${decomposition.agentSequence.join(" → ")}`);
      const agentOutputs: Record<string, AgentOutput> = {};
      const context: Record<string, unknown> = {
        originalTask: userTask,
        decomposition,
        toolResults: {} as Record<string, unknown>,
      };

      for (const agentName of decomposition.agentSequence) {
        const agent = this.agents.get(agentName);
        if (!agent) {
          throw new Error(`Agent not found: ${agentName}`);
        }

        console.log(`\n  → Running ${agentName}...`);
        const agentInput: AgentInput = {
          taskId,
          task: userTask,
          context,
          previousResults: agentOutputs,
        };

        const output = await agent.execute(agentInput);
        agentOutputs[agentName] = output;

        // NEW: Execute any tool calls the agent requested
        if (output.toolCalls && output.toolCalls.length > 0) {
          console.log(`\n  🔧 Executing ${output.toolCalls.length} tool call(s)...`);
          const toolResults: Record<string, unknown> = {};

          const identity = await this.getIdentity();
          for (const toolCall of output.toolCalls) {
            console.log(`     → ${toolCall.toolName}`);
            const result = await toolManager.executeTool(toolCall, taskId, identity);
            toolResults[toolCall.toolName] = result;
            
            if (result.success) {
              console.log(`       ✓ Success (${result.executionTime}ms)`);
            } else {
              console.log(`       ✗ Failed: ${result.error}`);
            }
          }

          // Store tool results in context for next agent
          const toolResultsMap = context.toolResults as Record<string, unknown>;
          context.toolResults = { ...toolResultsMap, ...toolResults };
        }

        // Store in database
        await db.insert(agentRuns).values({
          taskId,
          agentName,
          role: agent.role,
          status: "completed",
          input: agentInput as any,
          output: output as any,
          modelProvider: agent.modelConfig.provider,
          modelName: agent.modelConfig.model,
          confidence: String(output.confidence),
          verificationStatus: "unverified",
          tokensUsed: output.tokensUsed,
          completedAt: new Date(),
        });

        // Update context for next agent
        context[agentName] = output;

        console.log(`     Confidence: ${(output.confidence * 100).toFixed(0)}%`);
      }

      // Step 4: Synthesize results
      console.log(`\n✨ Synthesizing results...`);
      const finalResult = await this.synthesizeResults(
        agentOutputs,
        userTask,
        taskId
      );

      // Step 5: Store results and memory
      await db
        .update(tasks)
        .set({
          status: "completed",
          result: finalResult as any,
          confidence: String(finalResult.confidence),
          verificationStatus: finalResult.verificationStatus,
          completedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      // Store key findings in memory
      await storeMemory({
        type: "episode",
        content: `Task: ${userTask}\n\nResult: ${finalResult.result}`,
        importance: Math.round(finalResult.confidence * 10),
        confidence: String(finalResult.confidence),
        source: `task_${taskId}`,
      });

      // Only "created" and "failed" were ever logged here before — a task
      // that succeeded left no audit-trail record of its own completion,
      // even though invariant #12 ("every action is auditable") and the
      // master doc both claim a complete audit trail.
      await logAuditEvent({
        actor: "orchestrator",
        action: "completed",
        resource: "task",
        resourceId: taskId,
        result: {
          verificationStatus: finalResult.verificationStatus,
          confidence: finalResult.confidence,
        },
        statusCode: 200,
      });

      console.log(`\n✅ Task complete!`);
      console.log(`   Status: ${finalResult.verificationStatus}`);
      console.log(`   Confidence: ${(finalResult.confidence * 100).toFixed(0)}%`);

      return {
        taskId,
        finalResult: finalResult.result,
        confidence: finalResult.confidence,
        verificationStatus: finalResult.verificationStatus,
        agentOutputs,
        conflicts: finalResult.conflicts,
        evidence: finalResult.evidence,
      };
    } catch (error) {
      await db
        .update(tasks)
        .set({ status: "failed" })
        .where(eq(tasks.id, taskId));

      await logAuditEvent({
        actor: "orchestrator",
        action: "failed",
        resource: "task",
        resourceId: taskId,
        statusCode: 500,
        message: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  private async decomposeTask(
    userTask: string,
    taskId: string
  ): Promise<TaskDecomposition> {
    // Use dynamic task decomposer instead of fixed pipeline
    return this.decomposer.decompose(userTask);
  }

  private async synthesizeResults(
    outputs: Record<string, AgentOutput>,
    task: string,
    taskId: string
  ): Promise<{
    result: string;
    confidence: number;
    verificationStatus: "unverified" | "partially_verified" | "verified" | "conflicted" | "failed";
    conflicts: string[];
    evidence: string[];
  }> {
    const synthesizer = this.agents.get("synthesizer");
    if (!synthesizer) {
      throw new Error("Synthesizer agent not registered");
    }

    const synthInput: AgentInput = {
      taskId,
      task: `Original task: ${task}\n\nAll agent outputs:\n${Object.entries(outputs)
        .map(([name, output]) => `${name}: ${output.content}`)
        .join("\n\n")}`,
      context: { agentOutputs: outputs },
      previousResults: outputs,
    };

    const synthOutput = await synthesizer.execute(synthInput);

    // Determine overall verification status
    const avgConfidence =
      Object.values(outputs).reduce((sum, o) => sum + o.confidence, 0) /
      Object.keys(outputs).length;

    type VerificationStatus = "unverified" | "partially_verified" | "verified" | "conflicted" | "failed";
    let verificationStatus: VerificationStatus = "unverified";
    if (avgConfidence >= 0.9) {
      verificationStatus = "verified";
    } else if (avgConfidence >= 0.7) {
      verificationStatus = "partially_verified";
    }

    return {
      result: synthOutput.content,
      confidence: synthOutput.confidence,
      verificationStatus,
      conflicts: [],
      evidence: Object.values(outputs).map((o) => o.content),
    };
  }

  /**
   * Process user input with conversational intelligence
   *
   * Replaces simple task strings with context-aware conversation
   */
  async processConversation(userUtterance: string): Promise<{
    response: string;
    taskId?: string;
    context: ReturnType<ConversationEngine["getConversationContext"]>;
  }> {
    // App-control intents ("open Spotify", "close Notepad") are executed
    // FOR REAL before the LLM ever generates a reply — see
    // parseAppControlIntent()/classifyAppControlIntent()/
    // executeAppControlIntent() below. Fixed 2026-08-27 per Gavin: "when
    // something like that is asked it completes the task and stay[s]
    // conversational... it needs to be proactive not reactive." The action
    // runs first specifically so the reply is grounded in what actually
    // happened (including a real failure) rather than the model guessing —
    // see ConversationalIntelligence's ActionOutcome handling.
    //
    // Two-tier detection (added 2026-08-27, same day, per Gavin: "that
    // narrow scope makes it difficult to talk naturally... I don't want it
    // to be like current home systems where it's very blocky and certain
    // words MUST be said like with Alexa or Google Home"):
    //   1. parseAppControlIntent() — free, instant, zero-LLM-cost regex
    //      match for the common explicit phrasing ("open Spotify"). Tried
    //      first so the obvious case never pays for a round-trip.
    //   2. classifyAppControlIntent() — only runs when #1 finds nothing.
    //      Uses the LLM itself to understand indirect/colloquial phrasing
    //      ("yo pull up chrome real quick", "I wanna listen to some music,
    //      get Spotify going", "kill that notepad window") the regex could
    //      never enumerate. This is genuinely NLU, not a bigger keyword
    //      list — the tradeoff is one extra LLM round-trip on every
    //      utterance the regex doesn't already catch, which is real added
    //      latency; worth confirming feels acceptable once this runs live.
    let appControlIntent = this.parseAppControlIntent(userUtterance);
    if (!appControlIntent) {
      appControlIntent = await this.classifyAppControlIntent(userUtterance);
    }
    let actionOutcome: ActionOutcome | undefined;
    if (appControlIntent) {
      console.log(`\n🎯 App-control intent detected: ${appControlIntent.action} "${appControlIntent.appName}"`);
      this.onActionStart?.();
      try {
        actionOutcome = await this.executeAppControlIntent(appControlIntent);
      } finally {
        this.onActionEnd?.();
      }
    }

    // Screen-vision intent ("what's on my screen", "what's wrong with this
    // code") — same two-tier free-regex-then-LLM-classifier pattern as
    // app-control above, and deliberately skipped if an app-control intent
    // already matched (one utterance realistically means one or the
    // other, and app-control already ran a real action this turn). Added
    // 2026-09-02 per Gavin's own Stage 4 example scenario, which was
    // confirmed NOT to work before this — see screen-capture.ts's header
    // comment for the fake-data finding that blocked it.
    let visionContext: string | undefined;
    if (!appControlIntent) {
      let visionQuestion = this.parseScreenVisionIntent(userUtterance);
      if (!visionQuestion) {
        visionQuestion = await this.classifyScreenVisionIntent(userUtterance);
      }
      if (visionQuestion) {
        console.log(`\n👁️  Screen-vision intent detected: "${visionQuestion}"`);
        this.onActionStart?.();
        try {
          visionContext = await this.executeScreenVisionIntent(visionQuestion);
        } finally {
          this.onActionEnd?.();
        }
      }
    }

    // Use conversational intelligence to process utterance, with the real
    // action outcome (if any) so the reply can confirm/deny it truthfully
    // and proactively, instead of a canned template per app — and the real
    // screen-vision result (if any), so JARVIS answers from what it
    // genuinely just saw instead of guessing.
    const stream = await this.conversationalIntelligence.processWithStreaming(
      userUtterance,
      actionOutcome,
      visionContext
    );

    // In production: stream tokens to TTS
    // For now: collect full response
    const response = stream.text;

    // Extract task if implied
    let taskId: string | undefined;
    const conversationContext = this.conversationEngine.getConversationContext();

    if (this.isTaskRequest(userUtterance)) {
      // Separate, still-open gap from the app-control one above: this only
      // detects dev/code-shaped requests spoken conversationally ("write a
      // script that...", "build a...") — it does not decompose or dispatch
      // them to the Phase 1 developer pipeline. `taskId` stays undefined.
      // Left unbuilt deliberately (same "verify before expanding" priority
      // as before) — for later: decompose via TaskDecomposer, run through
      // JARVISDeveloper or toolManager.executeTool() as appropriate.
      console.log(`\n📋 Implied dev-task detected in conversation (not yet executed — see comment above)`);
    }

    // Record in memory
    this.conversationalIntelligence.completeTurn(userUtterance, response);

    return {
      response,
      taskId,
      context: conversationContext,
    };
  }

  /**
   * Detects a conversational "open/launch/start <app>" or "close/quit/exit
   * <app>" request. Anchored to the START of the utterance (after
   * stripping a leading "Jarvis," address) rather than matching the verb
   * anywhere in the sentence — "what's open at the store" or "when does
   * the movie start" should NOT trigger this; "Jarvis, open Spotify"
   * should. A false-positive match (e.g. some other imperative-shaped
   * sentence) still fails safely: `windowsController.openApplication()`
   * shells out to a real, argument-escaped `Start-Process`, so a bogus
   * "app name" just fails to launch with a normal PowerShell error — see
   * windows-control.ts — not a security or stability risk.
   */
  private parseAppControlIntent(
    utterance: string
  ): { action: "open" | "close"; appName: string } | null {
    const text = utterance.trim().replace(/^(?:hey\s+)?jarvis[,:]?\s*/i, "").trim();

    // Note: the repeated-word group in the capture uses a LAZY `{0,3}?`
    // quantifier deliberately — a greedy quantifier would swallow trailing
    // filler words ("please", "for me") into the captured app name before
    // backtracking ever gets a chance to hand them to the trailing filler
    // group instead (e.g. "open Spotify please" would capture "Spotify
    // please" as the app name with a greedy quantifier). Lazy makes the
    // engine prefer the shortest app name first, only extending the
    // capture when what follows doesn't match a known filler word —
    // which is exactly right for real multi-word app names too (e.g.
    // "open Visual Studio Code" still captures the full name, since
    // "Studio"/"Code" aren't filler words).
    const openMatch = text.match(
      /^(?:can you\s+|could you\s+|would you\s+|please\s+)*(?:open|launch|start|fire up|pull up)\s+(?:up\s+)?(?:the\s+)?([a-z0-9][\w\-]*(?:\s+[a-z0-9][\w\-]*){0,3}?)(?:\s+(?:for me|please|app|application|program|now))*[.!?]*$/i
    );
    if (openMatch?.[1]) {
      return { action: "open", appName: openMatch[1].trim() };
    }

    const closeMatch = text.match(
      /^(?:can you\s+|could you\s+|would you\s+|please\s+)*(?:close|quit|exit|kill)\s+(?:the\s+)?([a-z0-9][\w\-]*(?:\s+[a-z0-9][\w\-]*){0,3}?)(?:\s+(?:for me|please|app|application|program|now))*[.!?]*$/i
    );
    if (closeMatch?.[1]) {
      return { action: "close", appName: closeMatch[1].trim() };
    }

    return null;
  }

  /**
   * Natural-language fallback for app-control detection, added 2026-08-27
   * per Gavin's feedback that the regex-only version was "blocky" like
   * Alexa/Google Home — certain exact words required. Only runs when
   * parseAppControlIntent() finds nothing, so the free/instant regex path
   * still handles the common explicit case with zero LLM cost; this one
   * uses the LLM itself to understand indirect or colloquial phrasing the
   * regex could never enumerate ("yo pull up chrome real quick", "I wanna
   * listen to some music, get Spotify going", "kill that notepad window").
   *
   * Deliberately conservative: the prompt instructs the model to only
   * return isAppControl:true when a SPECIFIC named app is actually being
   * requested to open/close, not merely mentioned ("I'm working in
   * Photoshop right now" should not trigger this). Never throws — any
   * failure (provider error, malformed JSON) is treated the same as "no
   * intent detected" and falls through to plain conversation, same
   * fail-safe behavior as a real natural miss.
   */
  private async classifyAppControlIntent(
    utterance: string
  ): Promise<{ action: "open" | "close"; appName: string } | null> {
    const classifierPrompt =
      "You are an intent classifier for JARVIS, a desktop voice assistant. Given what the user just said, " +
      "determine whether they are asking to OPEN/LAUNCH or CLOSE/QUIT a specific application on their " +
      "computer — in ANY phrasing: direct (\"open Spotify\"), casual (\"yo pull up chrome\"), or indirect " +
      "(\"I wanna listen to some music, get Spotify going\"). Respond with ONLY a single raw JSON object, no " +
      "other text, no markdown code fences, matching exactly this shape:\n" +
      '{"isAppControl": boolean, "action": "open" | "close" | null, "appName": string | null}\n\n' +
      "Rules:\n" +
      "- isAppControl is true ONLY if a SPECIFIC, NAMED application is actually being requested to open or " +
      'close right now — not merely mentioned. ("I\'m working in Photoshop right now" is NOT a request.)\n' +
      '- If they mention an activity but no specific app ("play some jazz", "let\'s browse the web"), that is ' +
      "NOT enough on its own — isAppControl is false, since you don't know which app to act on.\n" +
      '- appName should be just the application name, normalized to how it\'s actually launched (e.g. ' +
      '"Spotify", "Google Chrome", "Notepad") — no extra words, no leading articles.\n' +
      "- If the utterance isn't about opening/closing an app at all, isAppControl is false and action/appName " +
      "are null.\n\n" +
      "Examples:\n" +
      '"open Spotify" -> {"isAppControl": true, "action": "open", "appName": "Spotify"}\n' +
      '"yo pull up chrome real quick" -> {"isAppControl": true, "action": "open", "appName": "Google Chrome"}\n' +
      '"I wanna listen to some music, get Spotify going" -> {"isAppControl": true, "action": "open", "appName": "Spotify"}\n' +
      '"kill that notepad window" -> {"isAppControl": true, "action": "close", "appName": "Notepad"}\n' +
      '"can you get rid of discord" -> {"isAppControl": true, "action": "close", "appName": "Discord"}\n' +
      '"I\'m working in Photoshop right now" -> {"isAppControl": false, "action": null, "appName": null}\n' +
      '"what\'s open at the store" -> {"isAppControl": false, "action": null, "appName": null}\n' +
      '"play some jazz" -> {"isAppControl": false, "action": null, "appName": null}\n' +
      '"how\'s the weather" -> {"isAppControl": false, "action": null, "appName": null}';

    try {
      const response = await this.modelProvider.complete(
        [
          { role: "system", content: classifierPrompt },
          { role: "user", content: utterance },
        ],
        {
          temperature: 0,
          maxTokens: 150,
          // Honored as real JSON-mode by OpenAI-compatible backends
          // (OmniRoute/OpenRouter); Ollama/Gemini ignore this option and
          // rely on their own internal structured-output wrapper instead
          // (see ollama-provider.ts/gemini-provider.ts) — either way the
          // prompt above is what actually carries the instruction.
          responseFormat: { type: "json_object" },
        }
      );

      const jsonText = this.extractJsonObject(response.content);
      if (!jsonText) return null;

      const parsed = JSON.parse(jsonText) as {
        isAppControl?: boolean;
        action?: "open" | "close" | null;
        appName?: string | null;
      };

      if (
        parsed.isAppControl === true &&
        (parsed.action === "open" || parsed.action === "close") &&
        typeof parsed.appName === "string" &&
        parsed.appName.trim().length > 0
      ) {
        return { action: parsed.action, appName: parsed.appName.trim() };
      }
      return null;
    } catch (error) {
      console.error(
        "⚠ App-control intent classification failed (falling back to plain conversation):",
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  /**
   * Pulls the first {...} JSON object out of a model response, tolerating
   * the markdown code fences or stray leading/trailing text a model might
   * add despite being told not to (small local models especially).
   */
  private extractJsonObject(text: string): string | null {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    return candidate.slice(start, end + 1);
  }

  /**
   * Actually runs an app-control intent via the same real, authorized
   * `ScreenControl` path `bun run dev control-test` already exercises —
   * not a new execution mechanism, just a new caller of the existing one.
   * Never throws: any failure (authorization denied, app not found,
   * PowerShell error) comes back as `{ success: false, detail: ... }` so
   * the conversational reply can report it honestly.
   */
  private async executeAppControlIntent(intent: {
    action: "open" | "close";
    appName: string;
  }): Promise<ActionOutcome> {
    const description = `${intent.action === "open" ? "Open" : "Close"} "${intent.appName}"`;
    try {
      const identity = await this.getIdentity();
      const screenControl = new ScreenControl();
      const result =
        intent.action === "open"
          ? await screenControl.openApp(intent.appName, identity)
          : await screenControl.closeApp(intent.appName, identity);
      return {
        description,
        success: result.success,
        detail: result.success ? (result.output ?? "done") : (result.error ?? "Unknown error"),
      };
    } catch (error) {
      return {
        description,
        success: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Free, instant, zero-LLM-cost regex tier for explicit screen-vision
   * phrasing — anything that directly names the screen/monitor/display as
   * what should be looked at. Deliberately narrow (same reasoning as
   * parseAppControlIntent() above): a false negative here just falls
   * through to classifyScreenVisionIntent() below, not to silence, so
   * there's no cost to being conservative — a false POSITIVE would trigger
   * a real screenshot + vision call for something unrelated, which is the
   * side to guard against.
   */
  private parseScreenVisionIntent(utterance: string): string | null {
    const text = utterance.trim().replace(/^(?:hey\s+)?jarvis[,:]?\s*/i, "").trim();
    if (/\b(screen|monitor|display)\b/i.test(text) && /\?|^(what|can|is|are|do|does|look|check|read|tell)/i.test(text)) {
      return text;
    }
    return null;
  }

  /**
   * LLM fallback for indirect screen-vision phrasing — things that imply
   * "look at what's visible right now" without ever saying the word
   * "screen" ("what's wrong with this code", "can you check this error",
   * "read this for me", "is this centered right"). Same fail-safe shape as
   * classifyAppControlIntent(): any failure just falls through to plain
   * conversation, never blocks a reply.
   */
  private async classifyScreenVisionIntent(utterance: string): Promise<string | null> {
    const classifierPrompt =
      "You are an intent classifier for JARVIS, a desktop voice assistant that can take a real screenshot and " +
      "look at it when needed. Given what the user just said, determine whether answering requires JARVIS to " +
      "actually look at the user's screen right now — including indirect references to something currently " +
      "visible on screen that was never explicitly called \"the screen\" (e.g. \"what's wrong with this code\", " +
      "\"can you check this error\", \"read this for me\", \"is this centered right\", \"what does this say\"). " +
      "Respond with ONLY a single raw JSON object, no other text, no markdown code fences, matching exactly this " +
      'shape:\n{"needsScreen": boolean}\n\n' +
      "Rules:\n" +
      "- needsScreen is true ONLY if answering genuinely requires seeing what's currently on screen right now — " +
      "not for general knowledge questions, not for app-control requests (\"open Spotify\"), not for anything " +
      "answerable from conversation alone.\n" +
      '- Vague deixis referring to something visible ("this", "that error", "this code") strongly implies ' +
      "needsScreen: true, since there's no other way to know what \"this\" refers to.\n\n" +
      "Examples:\n" +
      '"what\'s wrong with this code" -> {"needsScreen": true}\n' +
      '"what\'s on my screen" -> {"needsScreen": true}\n' +
      '"can you check this error message" -> {"needsScreen": true}\n' +
      '"is this centered right" -> {"needsScreen": true}\n' +
      '"open Spotify" -> {"needsScreen": false}\n' +
      '"how\'s the weather" -> {"needsScreen": false}\n' +
      '"what\'s the capital of France" -> {"needsScreen": false}';

    try {
      const response = await this.modelProvider.complete(
        [
          { role: "system", content: classifierPrompt },
          { role: "user", content: utterance },
        ],
        {
          temperature: 0,
          maxTokens: 50,
          responseFormat: { type: "json_object" },
        }
      );

      const jsonText = this.extractJsonObject(response.content);
      if (!jsonText) return null;

      const parsed = JSON.parse(jsonText) as { needsScreen?: boolean };
      return parsed.needsScreen === true ? utterance : null;
    } catch (error) {
      console.error(
        "⚠ Screen-vision intent classification failed (falling back to plain conversation):",
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  /**
   * Actually captures a real screenshot (screen-capture.ts, real since the
   * 2026-09-02 rewrite — see its header comment) and runs it through the
   * real, connected vision provider to get a real description, plus real
   * active-app/open-window data, for the conversational LLM to reason over.
   *
   * Real bug found and fixed live (2026-09-02): this originally called
   * `visionSystem.answerVisualQuestion(screenshot, question)` — passing the
   * user's raw phrasing straight to moondream. Confirmed directly against
   * Ollama's raw API: moondream reliably returns an EMPTY response
   * (eval_count: 1) for first-person/deictic phrasings like "what's on my
   * screen right now" or "is this centered right", regardless of image
   * content (reproduced against both a blank test image and a real
   * generated shapes image) — the exact same "small model chokes on
   * certain phrasing" failure mode already found and fixed once before in
   * this file, for detectObjects(). A neutral "Describe this image in
   * detail..." prompt (analyzeImage()'s prompt) reliably returns a real,
   * non-empty answer instead.
   *
   * Fix: moondream's real job here is describing what's actually on
   * screen (its confirmed strength) — the conversational LLM (a stronger
   * general model, already receiving the user's exact question via
   * assemblePrompt()) does the actual reasoning about what that means for
   * their specific question. Same separation of concerns already used
   * elsewhere: a small local model supplies real perception, a stronger
   * model does the reasoning on top of it.
   *
   * Never throws: any failure (PowerShell error, vision provider timeout,
   * Ollama not running) comes back as a clear, honest string so the
   * conversational reply can report the real failure instead of silently
   * pretending it can see the screen.
   */
  private async executeScreenVisionIntent(question: string): Promise<string> {
    try {
      const screenshot = await this.getScreenCapture().captureScreen();
      const analysis = await this.getVisionSystem().analyzeImage(screenshot.data);
      const windows = await this.getScreenCapture().getOpenWindows();

      const parts = [`Screen description: ${analysis.text}`];
      parts.push(
        `Active application: ${screenshot.activeApplication ?? "unknown"} — "${screenshot.activeWindow ?? "unknown"}"`
      );
      if (windows.length > 0) {
        parts.push(
          `Other open windows: ${windows.map((w) => `${w.processName} ("${w.title}")`).join(", ")}`
        );
      }
      return parts.join("\n");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("⚠ Screen-vision capture/analysis failed:", detail);
      return `(Screen vision failed: ${detail} — tell the user honestly that you couldn't look at the screen just now, don't guess at what's there.)`;
    }
  }

  /**
   * Check if utterance implies a task to be executed
   */
  private isTaskRequest(utterance: string): boolean {
    const taskKeywords = [
      "do",
      "make",
      "create",
      "build",
      "write",
      "generate",
      "find",
      "fetch",
      "research",
      "analyze",
    ];

    const lower = utterance.toLowerCase();
    return taskKeywords.some((keyword) => lower.includes(keyword));
  }

  /**
   * Get conversational context for integration with voice/text interfaces
   */
  getConversationContext() {
    return this.conversationEngine.getConversationContext();
  }

  /**
   * Get memory status
   */
  getMemoryStatus() {
    return this.conversationalIntelligence.getMemoryStatus();
  }

  /**
   * Get model router status
   */
  getModelRouterStatus() {
    return this.modelRouter.getStatus();
  }

  /**
   * Get full orchestrator status
   */
  getOrchestratorStatus() {
    return {
      agents: this.agents.size,
      conversation: this.conversationEngine.getStatus(),
      memory: this.conversationalIntelligence.getMemoryStatus(),
      modelRouter: this.modelRouter.getStatus(),
    };
  }

  /**
   * Register semantic fact in memory
   */
  recordSemanticFact(key: string, fact: string, confidence?: number): void {
    this.conversationalIntelligence.recordSemanticFact(key, fact, confidence);
  }

  /**
   * Register procedure in memory
   */
  recordProcedure(
    name: string,
    steps: string[],
    variations?: Record<string, string[]>
  ): void {
    this.conversationalIntelligence.recordProcedure(name, steps, variations);
  }
}
