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
import { VideoAnalyzer } from "../phase3/video-analyzer";
import { CameraCapture } from "../phase3/camera-capture";
import { searchWeb } from "./web-search";
import { listDirectory, readTextFile, writeTextFile, moveFile } from "./file-manager";
import { spotifyPlay, spotifyPause, spotifyResume, spotifyNext, spotifyPrevious, spotifyStatus } from "./spotify";
import { existsSync } from "node:fs";
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
  // [UPDATE 2026-09-03] onActionStart now optionally carries a real,
  // specific description of what's actually happening ("Opening
  // Notepad", "Searching the web for weather", "Reading your screen") -
  // per Gavin: "the text at the top isnt actaully what hes doing its
  // just for show, make it accurate." Every real call site below passes
  // its own real description (the same one ActionOutcome/visionContext
  // ends up using), not a generic placeholder - see hud-server.ts's
  // setState() for where this ends up.
  onActionStart?: (description?: string) => void;
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
  private videoAnalyzer?: VideoAnalyzer;

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

  private getVideoAnalyzer(): VideoAnalyzer {
    if (!this.videoAnalyzer) {
      // Shares this Orchestrator's one VisionSystem/OllamaVisionProvider
      // connection (getVisionSystem() above) rather than each constructing
      // its own - same reasoning as cachedIdentity: one real connection
      // per process, not one per feature.
      this.videoAnalyzer = new VideoAnalyzer(this.getVisionSystem());
    }
    return this.videoAnalyzer;
  }

  private cameraCapture?: CameraCapture;
  private getCameraCapture(): CameraCapture {
    if (!this.cameraCapture) {
      this.cameraCapture = new CameraCapture();
    }
    return this.cameraCapture;
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
   * [ADDED 2026-09-03] Real, free, instant (no LLM call) guess at whether
   * an utterance will need a real action/lookup beyond a plain
   * conversational reply - per Gavin: "make it proportional to what it's
   * actually doing," about the "one moment" filler acknowledgment.
   * Reuses the exact same free regex tiers processConversation() itself
   * checks first (same methods, not a duplicated/drifting copy) so this
   * guess is always consistent with what actually ends up happening -
   * deliberately only the FREE tier, not the LLM classifiers, since this
   * has to return before the filler plays and running a real classifier
   * call here would reintroduce the exact "dead air before the filler"
   * bug fixed earlier this session. Real, disclosed limitation: file
   * operations have no free regex tier at all (classify-only - see
   * classifyFileIntent()'s own comment), so a file request won't be
   * caught here and gets the "quick" filler even though it may involve
   * real work - a real, accepted gap, not a false claim.
   */
  guessIfRealActionNeeded(utterance: string): boolean {
    return Boolean(
      this.parseAppControlIntent(utterance) ||
        this.parseClickIntent(utterance) ||
        this.parseSpotifyIntent(utterance) ||
        this.parseVideoIntent(utterance) ||
        this.parseCameraVisionIntent(utterance) ||
        this.parseScreenVisionIntent(utterance) ||
        this.parseSearchIntent(utterance)
    );
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
    // [2026-09-02] Real, live-found performance bug, fixed here: every
    // one of the intent tiers below (app-control, click, spotify, file,
    // video, camera, screen-vision, search) got added across this same
    // session, each with its own real justification - but they were all
    // chained SEQUENTIALLY (each `await`ing its own LLM classifier call
    // only after confirming every earlier one came back empty). For any
    // utterance that doesn't match a free regex tier - a completely
    // ordinary question like "what's 320 x 246?" - that meant up to SIX
    // separate real LLM round trips, one after another, before the real
    // reply even started generating. Confirmed live from Gavin's own log,
    // not guessed: a real turn's "response generation" measured 23.2s
    // total, of which only 5.7s was Chatterbox - the other ~17.5s was
    // unaccounted for anywhere else, and lines up almost exactly with six
    // ~2-3s classifier calls run back to back. Gavin: "we still SUPER
    // slow."
    //
    // Real fix: a fast, free, zero-cost regex pass runs FIRST (unchanged
    // logic, just gathered together) - if anything matches there, the
    // slow tier is skipped entirely, same as before. Only if NOTHING
    // matches for free does the slow LLM tier run - and now it fires all
    // six classifiers CONCURRENTLY via Promise.all() instead of one after
    // another, since each is independently checking a different intent
    // and none of them depend on another's result. Wall-clock cost drops
    // from "sum of six calls" to "the single slowest one" - the same real
    // classifiers, same real prompts, same real priority order for
    // picking a winner if more than one somehow matches, just no longer
    // serialized for no reason.
    const fastAppControlIntent = this.parseAppControlIntent(userUtterance);
    const fastClickIntent = fastAppControlIntent ? null : this.parseClickIntent(userUtterance);
    const fastSpotifyIntent =
      fastAppControlIntent || fastClickIntent ? null : this.parseSpotifyIntent(userUtterance);
    // Video/camera never have an LLM classifier tier at all (see each
    // parse method's own comment - video has nothing real to guess at
    // without a path; camera is deliberately regex-only given its higher
    // privacy stakes) - real to check for free here regardless of
    // whether the slow tier below ends up running.
    const fastVideoIntent = this.parseVideoIntent(userUtterance);
    const fastCameraQuestion = fastVideoIntent ? null : this.parseCameraVisionIntent(userUtterance);
    const fastScreenVisionQuestion =
      fastVideoIntent || fastCameraQuestion ? null : this.parseScreenVisionIntent(userUtterance);
    const fastSearchQuery = this.parseSearchIntent(userUtterance);

    let appControlIntent = fastAppControlIntent;
    let clickIntent = fastClickIntent;
    let spotifyIntent = fastSpotifyIntent;
    let fileIntent: Awaited<ReturnType<typeof this.classifyFileIntent>> = null;
    let screenVisionQuestion = fastScreenVisionQuestion;
    let searchQuery = fastSearchQuery;

    const anyFastMatch =
      fastAppControlIntent || fastClickIntent || fastSpotifyIntent || fastVideoIntent || fastCameraQuestion || fastScreenVisionQuestion || fastSearchQuery;

    if (!anyFastMatch) {
      const [appClassify, clickClassify, spotifyClassify, fileClassify, screenClassify, searchClassify] =
        await Promise.all([
          this.classifyAppControlIntent(userUtterance),
          this.classifyClickIntent(userUtterance),
          this.classifySpotifyIntent(userUtterance),
          this.classifyFileIntent(userUtterance),
          this.classifyScreenVisionIntent(userUtterance),
          this.classifySearchIntent(userUtterance),
        ]);
      // Same real priority order the old sequential chain enforced (each
      // earlier tier suppressed every later one once matched) - preserved
      // here as a plain if/else-if now that all six ran concurrently
      // instead of gating each other's execution.
      if (appClassify) appControlIntent = appClassify;
      else if (clickClassify) clickIntent = clickClassify;
      else if (spotifyClassify) spotifyIntent = spotifyClassify;
      else if (fileClassify) fileIntent = fileClassify;
      else if (screenClassify) screenVisionQuestion = screenClassify;
      else if (searchClassify) searchQuery = searchClassify;
    }

    let actionOutcome: ActionOutcome | undefined;
    if (appControlIntent) {
      console.log(`\n🎯 App-control intent detected: ${appControlIntent.action} "${appControlIntent.appName}"`);
      this.onActionStart?.(`${appControlIntent.action === "open" ? "Opening" : "Closing"} ${appControlIntent.appName}`);
      try {
        actionOutcome = await this.executeAppControlIntent(appControlIntent);
      } finally {
        this.onActionEnd?.();
      }
    } else if (clickIntent) {
      console.log(`\n🖱️  Click intent detected: "${clickIntent.elementName}"`);
      this.onActionStart?.(`Clicking "${clickIntent.elementName}"`);
      try {
        actionOutcome = await this.executeClickIntent(clickIntent.elementName);
      } finally {
        this.onActionEnd?.();
      }
    } else if (spotifyIntent) {
      console.log(`\n🎵 Spotify intent detected: ${spotifyIntent.action}${spotifyIntent.query ? ` "${spotifyIntent.query}"` : ""}`);
      this.onActionStart?.(
        spotifyIntent.action === "play" ? `Playing "${spotifyIntent.query}" on Spotify` : `Spotify: ${spotifyIntent.action}`
      );
      try {
        actionOutcome = await this.executeSpotifyIntent(spotifyIntent);
      } finally {
        this.onActionEnd?.();
      }
    } else if (fileIntent) {
      console.log(`\n📁 File intent detected: ${fileIntent.operation} "${fileIntent.path}"`);
      this.onActionStart?.(`${fileIntent.operation === "list" ? "Checking" : fileIntent.operation === "read" ? "Reading" : fileIntent.operation === "write" ? "Writing to" : "Moving"} ${fileIntent.path}`);
      try {
        actionOutcome = await this.executeFileIntent(fileIntent);
      } finally {
        this.onActionEnd?.();
      }
    }

    // Vision (video/camera/screen) and search share their own slots
    // (visionContext/searchContext, not actionOutcome) - only reached
    // when none of the four action intents above matched, same mutual-
    // exclusivity as before.
    let visionContext: string | undefined;
    let searchContext: string | undefined;
    if (!actionOutcome) {
      if (fastVideoIntent) {
        console.log(`\n🎬 Video intent detected: "${fastVideoIntent.path}" — "${fastVideoIntent.question}"`);
        this.onActionStart?.(`Watching ${fastVideoIntent.path}`);
        try {
          visionContext = await this.executeVideoIntent(fastVideoIntent.path, fastVideoIntent.question);
        } finally {
          this.onActionEnd?.();
        }
      } else if (fastCameraQuestion) {
        console.log(`\n📷 Camera intent detected: "${fastCameraQuestion}"`);
        this.onActionStart?.("Looking through the camera");
        try {
          visionContext = await this.executeCameraVisionIntent(fastCameraQuestion);
        } finally {
          this.onActionEnd?.();
        }
      } else if (screenVisionQuestion) {
        console.log(`\n👁️  Screen-vision intent detected: "${screenVisionQuestion}"`);
        this.onActionStart?.("Reading your screen");
        try {
          visionContext = await this.executeScreenVisionIntent(screenVisionQuestion);
        } finally {
          this.onActionEnd?.();
        }
      } else if (searchQuery) {
        console.log(`\n🔎 Web-search intent detected: "${searchQuery}"`);
        this.onActionStart?.(`Searching the web for "${searchQuery}"`);
        try {
          searchContext = await this.executeSearchIntent(searchQuery);
        } finally {
          this.onActionEnd?.();
        }
      }
    }

    // Use conversational intelligence to process utterance, with the real
    // action outcome (if any) so the reply can confirm/deny it truthfully
    // and proactively, the real vision/video/camera result (if any), and
    // the real web search result (if any), so JARVIS answers from what it
    // genuinely just did/saw/found instead of guessing.
    const stream = await this.conversationalIntelligence.processWithStreaming(
      userUtterance,
      actionOutcome,
      visionContext,
      searchContext
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
   * Free, instant, zero-LLM-cost regex tier for explicit click phrasing —
   * same lazy-capture reasoning as parseAppControlIntent()'s openMatch
   * above (prefer the shortest element name, let trailing filler words
   * like "button"/"please" fall through to the filler group instead of
   * being swallowed into the name).
   */
  private parseClickIntent(utterance: string): { elementName: string } | null {
    const text = utterance.trim().replace(/^(?:hey\s+)?jarvis[,:]?\s*/i, "").trim();
    const match = text.match(
      /^(?:can you\s+|could you\s+|would you\s+|please\s+)*(?:click|press|tap|hit)\s+(?:on\s+)?(?:the\s+)?([a-z0-9][\w\-]*(?:\s+[a-z0-9][\w\-]*){0,4}?)(?:\s+(?:button|for me|please|now))*[.!?]*$/i
    );
    return match?.[1] ? { elementName: match[1].trim() } : null;
  }

  /**
   * LLM fallback for indirect click phrasing ("go ahead and save that",
   * "submit the form", "let's cancel this") - same conservative-and-
   * fail-safe shape as classifyAppControlIntent(): only fires for a
   * SPECIFIC UI action, never for merely mentioning a button in passing.
   */
  private async classifyClickIntent(utterance: string): Promise<{ elementName: string } | null> {
    const classifierPrompt =
      "You are an intent classifier for JARVIS, a desktop voice assistant that can click real UI buttons/" +
      "controls in the currently focused window. Given what the user just said, determine whether they're " +
      "asking to click/press/activate a SPECIFIC on-screen UI element - in any phrasing, direct (\"click " +
      "submit\") or indirect (\"go ahead and save that\", \"let's cancel this\"). Respond with ONLY a single " +
      "raw JSON object, no other text, no markdown code fences, matching exactly this shape:\n" +
      '{"isClick": boolean, "elementName": string | null}\n\n' +
      "Rules:\n" +
      "- isClick is true ONLY if a specific UI action is being requested right now - not for opening/closing " +
      'a whole application (that\'s a different system), and not for merely mentioning a button ("the save ' +
      'button is right there" is NOT a request).\n' +
      '- elementName should be the real, likely on-screen label of the control, normalized (e.g. "save", ' +
      '"submit", "cancel", "ok") - no extra words.\n' +
      "- If the utterance isn't about clicking a UI element, isClick is false and elementName is null.\n\n" +
      "Examples:\n" +
      '"click submit" -> {"isClick": true, "elementName": "submit"}\n' +
      '"go ahead and save that" -> {"isClick": true, "elementName": "save"}\n' +
      '"let\'s cancel this" -> {"isClick": true, "elementName": "cancel"}\n' +
      '"open Spotify" -> {"isClick": false, "elementName": null}\n' +
      '"the save button is right there" -> {"isClick": false, "elementName": null}\n' +
      '"how\'s the weather" -> {"isClick": false, "elementName": null}';

    try {
      const response = await this.modelProvider.complete(
        [
          { role: "system", content: classifierPrompt },
          { role: "user", content: utterance },
        ],
        { temperature: 0, maxTokens: 100, responseFormat: { type: "json_object" } }
      );

      const jsonText = this.extractJsonObject(response.content);
      if (!jsonText) return null;

      const parsed = JSON.parse(jsonText) as { isClick?: boolean; elementName?: string | null };
      if (parsed.isClick === true && typeof parsed.elementName === "string" && parsed.elementName.trim().length > 0) {
        return { elementName: parsed.elementName.trim() };
      }
      return null;
    } catch (error) {
      console.error(
        "⚠ Click intent classification failed (falling back to plain conversation):",
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  /**
   * Actually clicks a real UI element via the same real, authorized
   * `ScreenControl` path as executeAppControlIntent() above - real UI
   * Automation lookup (see ui-automation.ts), then a real Win32 click at
   * its exact real bounding-rect center. Never throws: any failure
   * (element not found, authorization denied) comes back as
   * `{ success: false, detail: ... }` so the conversational reply can
   * report it honestly instead of claiming a click that never happened.
   */
  private async executeClickIntent(elementName: string): Promise<ActionOutcome> {
    const description = `Click "${elementName}"`;
    try {
      const identity = await this.getIdentity();
      const screenControl = new ScreenControl();
      const result = await screenControl.findAndClick(description, elementName, identity);
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
   * Free, instant, zero-LLM-cost regex tier for Spotify playback control.
   * Closes a real, previously-disclosed gap: app-control (open/close)
   * could launch Spotify but never play a specific song - per Gavin,
   * "For Spotify use spotipy" (see core/spotify.ts, a real spotipy-backed
   * Python subprocess, not window automation). A bare "play spotify"/
   * "play music" is deliberately excluded from the "play <query>" match
   * below - that's ambiguous with app-control's own "open" intent, and
   * there's no real song/artist to search for anyway.
   */
  private parseSpotifyIntent(
    utterance: string
  ): { action: "play" | "pause" | "resume" | "next" | "previous" | "status"; query?: string } | null {
    const text = utterance.trim().replace(/^(?:hey\s+)?jarvis[,:]?\s*/i, "").trim();
    if (/^(?:can you\s+|please\s+)*(?:pause|stop)(?:\s+the\s+music)?[.!?]*$/i.test(text)) return { action: "pause" };
    if (/^(?:can you\s+|please\s+)*(?:resume|unpause|continue)(?:\s+the\s+music)?[.!?]*$/i.test(text))
      return { action: "resume" };
    if (/^(?:can you\s+|please\s+)*(?:skip|next)(?:\s+(?:song|track))?[.!?]*$/i.test(text)) return { action: "next" };
    if (/^(?:can you\s+|please\s+)*(?:go back|previous|last)(?:\s+(?:song|track))?[.!?]*$/i.test(text))
      return { action: "previous" };
    if (/^(?:can you\s+|please\s+)*what(?:'s| is)\s+(?:playing|this song)[.!?]*$/i.test(text))
      return { action: "status" };

    const playMatch = text.match(/^(?:can you\s+|please\s+)*play\s+(?:some\s+)?(.+?)[.!?]*$/i);
    if (playMatch?.[1]) {
      const query = playMatch[1].trim();
      if (query.toLowerCase() !== "spotify" && query.toLowerCase() !== "music") {
        return { action: "play", query };
      }
    }
    return null;
  }

  /**
   * LLM fallback for indirect Spotify phrasing ("I wanna listen to some
   * jazz", "put on some Taylor Swift", "turn the music off"). Same
   * conservative shape as the other classifiers - only fires for a real,
   * specific playback request.
   */
  private async classifySpotifyIntent(
    utterance: string
  ): Promise<{ action: "play" | "pause" | "resume" | "next" | "previous" | "status"; query?: string } | null> {
    const classifierPrompt =
      "You are an intent classifier for JARVIS, a desktop voice assistant that can control real Spotify " +
      "playback (play a specific song/artist, pause, resume, skip, go back, or report what's playing). Given " +
      "what the user just said, determine whether they're requesting Spotify playback control. Respond with " +
      "ONLY a single raw JSON object, no other text, no markdown code fences, matching exactly this shape:\n" +
      '{"isSpotify": boolean, "action": "play" | "pause" | "resume" | "next" | "previous" | "status" | null, ' +
      '"query": string | null}\n\n' +
      "Rules:\n" +
      '- action "play" needs a real query (song/artist/genre/playlist name) - if they just want music in ' +
      'general with nothing specific, still extract SOMETHING reasonable from what they said.\n' +
      "- Default to false on ambiguity - only fires for a real, specific playback request.\n\n" +
      "Examples:\n" +
      '"I wanna listen to some jazz" -> {"isSpotify": true, "action": "play", "query": "jazz"}\n' +
      '"put on some Taylor Swift" -> {"isSpotify": true, "action": "play", "query": "Taylor Swift"}\n' +
      '"turn the music off" -> {"isSpotify": true, "action": "pause", "query": null}\n' +
      '"open Spotify" -> {"isSpotify": false, "action": null, "query": null}\n' +
      '"how\'s the weather" -> {"isSpotify": false, "action": null, "query": null}';

    try {
      const response = await this.modelProvider.complete(
        [
          { role: "system", content: classifierPrompt },
          { role: "user", content: utterance },
        ],
        { temperature: 0, maxTokens: 100, responseFormat: { type: "json_object" } }
      );

      const jsonText = this.extractJsonObject(response.content);
      if (!jsonText) return null;

      const parsed = JSON.parse(jsonText) as {
        isSpotify?: boolean;
        action?: "play" | "pause" | "resume" | "next" | "previous" | "status" | null;
        query?: string | null;
      };
      if (parsed.isSpotify === true && parsed.action) {
        if (parsed.action === "play" && !parsed.query) return null;
        return { action: parsed.action, query: parsed.query ?? undefined };
      }
      return null;
    } catch (error) {
      console.error(
        "⚠ Spotify intent classification failed (falling back to plain conversation):",
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  /**
   * Actually controls real Spotify playback via core/spotify.ts (real
   * spotipy-backed Python subprocess). Never throws: any failure
   * (credentials not set up, no active device, no real search match)
   * comes back as a real ActionOutcome failure so the reply reports it
   * honestly instead of claiming a song is playing when it isn't.
   */
  private async executeSpotifyIntent(intent: {
    action: "play" | "pause" | "resume" | "next" | "previous" | "status";
    query?: string;
  }): Promise<ActionOutcome> {
    const description =
      intent.action === "play"
        ? `Play "${intent.query}" on Spotify`
        : `Spotify: ${intent.action}`;
    try {
      let result: { success: boolean; error?: string; playing?: string; isPlaying?: boolean; track?: string; artists?: string[]; detail?: string };
      switch (intent.action) {
        case "play":
          result = await spotifyPlay(intent.query!);
          break;
        case "pause":
          result = await spotifyPause();
          break;
        case "resume":
          result = await spotifyResume();
          break;
        case "next":
          result = await spotifyNext();
          break;
        case "previous":
          result = await spotifyPrevious();
          break;
        case "status":
          result = await spotifyStatus();
          break;
      }
      const detail = result.success
        ? result.playing ??
          (result.track ? `${result.isPlaying ? "Playing" : "Paused"}: ${result.track} by ${(result.artists ?? []).join(", ")}` : result.detail) ??
          "done"
        : (result.error ?? "Unknown error");
      return { description, success: result.success, detail: detail ?? "done" };
    } catch (error) {
      return {
        description,
        success: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Free, instant, zero-LLM-cost regex tier for video understanding: only
   * triggers when a real, resolvable video file path is actually named in
   * the utterance (a much more specific, deliberate signal than screen
   * phrasing, so no LLM classifier fallback tier exists for this one — if
   * no real path is present, there's genuinely nothing for an LLM to
   * "find" either; that's a real, honest reason to ask the user for a
   * path in conversation rather than a gap to close with a second tier).
   * Requires a common intent verb nearby, same conservative-false-negative
   * reasoning as parseAppControlIntent()/parseScreenVisionIntent() - a
   * miss here just means no video analysis runs, not a wrong one.
   * existsSync() confirms the path is real BEFORE paying for a real
   * ffprobe/ffmpeg/vision round trip - a typo'd or half-remembered path
   * fails fast and honestly here instead of deep inside video-analyzer.ts.
   */
  private parseVideoIntent(utterance: string): { path: string; question: string } | null {
    const pathMatch = utterance.match(
      /"([^"]+\.(?:mp4|mov|avi|mkv|webm|m4v|wmv))"|'([^']+\.(?:mp4|mov|avi|mkv|webm|m4v|wmv))'|(\S+\.(?:mp4|mov|avi|mkv|webm|m4v|wmv))/i
    );
    if (!pathMatch) return null;

    const path = (pathMatch[1] ?? pathMatch[2] ?? pathMatch[3]).trim();
    if (!existsSync(path)) {
      console.log(`   ⚠️  Video path mentioned but not found on disk, skipping: "${path}"`);
      return null;
    }

    if (!/\b(look|watch|check|see|analyz|describe|explain|happen|tell me|what'?s in|what is in)\b/i.test(utterance)) {
      return null;
    }

    // Whatever's left after removing the path token becomes the question;
    // falls back to a generic "describe it" ask if nothing meaningful
    // remains (e.g. the utterance was just "check out clip.mp4").
    const remainder = utterance
      .replace(pathMatch[0], " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[,.\s]+|[,.\s]+$/g, "");
    const question = remainder.length > 3 ? remainder : "Describe what happens in this video, in order.";

    return { path, question };
  }

  /**
   * Actually runs real video understanding (video-analyzer.ts - real
   * ffprobe/ffmpeg frame sampling + real per-frame vision analysis, see
   * its own header comment) and formats the result as a visionContext
   * string for the conversational reply to reason over. Deliberately does
   * NOT run its own second LLM synthesis call here (unlike the
   * `video-test` CLI command, which does, for a real standalone result) -
   * the conversational reply generated right after this already makes one
   * real LLM call with the user's exact utterance in context, so handing
   * it the raw per-frame descriptions and letting THAT call reason over
   * them avoids paying for a redundant second one.
   */
  private async executeVideoIntent(path: string, question: string): Promise<string> {
    try {
      const analysis = await this.getVideoAnalyzer().analyzeVideo(path);
      const frameLines = analysis.frames
        .map((f) => `  [${f.timestampSeconds.toFixed(1)}s] ${f.description}`)
        .join("\n");
      return (
        `Video analysis (${analysis.frames.length} real frames sampled across ${analysis.durationSeconds.toFixed(1)}s ` +
        `of "${path}", each independently described by a vision model with no awareness of the others - reason ` +
        `about what's changing/staying the same across them to infer motion/events; the user's specific question ` +
        `about it is: "${question}"):\n${frameLines}`
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("⚠ Video analysis failed:", detail);
      return `(Video analysis of "${path}" failed: ${detail} — tell the user honestly that you couldn't analyze the video just now, don't guess at its contents.)`;
    }
  }

  /**
   * Free, instant, zero-LLM-cost regex tier for camera-vision phrasing —
   * and, deliberately, the ONLY tier (no LLM classifier fallback, unlike
   * every other intent in this funnel) — see this being called for the
   * real reasoning why. Requires either an explicit "camera"/"webcam"
   * mention with a verb, or clearly self-referential phrasing that only
   * makes sense pointed at a camera on the user themselves ("look at me",
   * "what do I look like").
   */
  private parseCameraVisionIntent(utterance: string): string | null {
    const text = utterance.trim().replace(/^(?:hey\s+)?jarvis[,:]?\s*/i, "").trim();
    const explicitCameraMention =
      /\b(camera|webcam)\b/i.test(text) &&
      /\b(look|check|see|show|use|turn on|activate|what|is|can)\b/i.test(text);
    const selfReferential =
      /\b(look at me|can you see me|do you see me|what do i look like|how do i look|what am i wearing|can you see my face)\b/i.test(
        text
      );
    return explicitCameraMention || selfReferential ? text : null;
  }

  /**
   * Actually captures a real webcam frame (camera-capture.ts - real
   * ffmpeg DirectShow capture, see its header comment for the real
   * OpenCV-vs-ffmpeg finding and the disclosed black-frame caveat) and
   * runs it through the real, connected vision provider for a neutral
   * description, same "moondream describes, the conversational LLM
   * reasons about the user's specific question" split as
   * executeScreenVisionIntent() - same reason: passing the user's raw
   * question straight to moondream was already found to reliably return
   * an empty response for first-person phrasing (see that method's own
   * comment), and there's no reason to expect camera questions to be any
   * more first-person-phrasing-tolerant than screen ones were. Never
   * throws: any failure comes back as a clear, honest string.
   */
  private async executeCameraVisionIntent(question: string): Promise<string> {
    try {
      const frame = await this.getCameraCapture().captureFrame();
      const analysis = await this.getVisionSystem().analyzeImage(frame.data);
      return (
        `Camera capture (real webcam frame, "${frame.deviceName}", ${frame.width}x${frame.height}) description: ` +
        `${analysis.text}`
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("⚠ Camera capture/analysis failed:", detail);
      return `(Camera capture failed: ${detail} — tell the user honestly that you couldn't use the camera just now, don't guess at what it would show.)`;
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
   * Free, instant, zero-LLM-cost regex tier for explicit search phrasing.
   */
  private parseSearchIntent(utterance: string): string | null {
    const text = utterance.trim().replace(/^(?:hey\s+)?jarvis[,:]?\s*/i, "").trim();
    const match = text.match(
      /^(?:can you\s+|could you\s+|would you\s+|please\s+)*(?:search(?: the web)? for|look up|google|look that up about)\s+(.+?)[.!?]*$/i
    );
    if (match?.[1]) return match[1].trim();
    // "look that up" with no object - use the utterance itself as a weak
    // fallback query only if it's genuinely just that phrase; otherwise
    // let the LLM classifier below handle indirect phrasing instead of
    // guessing a query here.
    if (/^(?:can you\s+|please\s+)?look that up[.!?]*$/i.test(text)) return null;
    return null;
  }

  /**
   * LLM fallback for indirect search phrasing ("what's the weather like",
   * "who won the game last night", "what's bitcoin trading at"). Unlike
   * every other classifier in this funnel, this one is deliberately
   * biased toward FALSE on ambiguity, not true: a missed search just
   * means JARVIS answers from its own knowledge (fine for anything
   * stable - general/historical facts, math, how-to questions), while an
   * unnecessary search adds real latency (a live HTTP round trip) to
   * every ordinary question it's wrongly triggered on. The other
   * classifiers bias toward true because a false negative there means
   * silently ignoring a real request; here a false negative just falls
   * back to a normal conversational answer, a much cheaper miss.
   */
  private async classifySearchIntent(utterance: string): Promise<string | null> {
    const classifierPrompt =
      "You are an intent classifier for JARVIS, a desktop voice assistant that can search the real web when " +
      "needed. Given what the user just said, determine whether answering it CORRECTLY genuinely requires " +
      "current, real-time, or external information a general knowledge model would not reliably know or could " +
      "easily have out of date (weather, live scores/results, current prices, breaking news, \"latest\"/\"right " +
      "now\"/\"today\" facts about a changing situation). Respond with ONLY a single raw JSON object, no other " +
      "text, no markdown code fences, matching exactly this shape:\n" +
      '{"needsSearch": boolean, "query": string | null}\n\n' +
      "Rules:\n" +
      "- Default to false when genuinely ambiguous - stable facts (history, geography, math, general how-to, " +
      "definitions) should be answered directly, not searched.\n" +
      "- needsSearch is true only for something that is genuinely time-sensitive or changes over time.\n" +
      "- query should be a short, real search-engine-style query capturing what to look up - not the full " +
      "sentence verbatim.\n\n" +
      "Examples:\n" +
      '"what\'s the weather like in Chicago" -> {"needsSearch": true, "query": "weather Chicago"}\n' +
      '"who won the game last night" -> {"needsSearch": true, "query": "game score last night"}\n' +
      '"what\'s bitcoin trading at right now" -> {"needsSearch": true, "query": "bitcoin price"}\n' +
      '"what\'s the capital of France" -> {"needsSearch": false, "query": null}\n' +
      '"what\'s 12 times 8" -> {"needsSearch": false, "query": null}\n' +
      '"how do I restart a Windows service" -> {"needsSearch": false, "query": null}';

    try {
      const response = await this.modelProvider.complete(
        [
          { role: "system", content: classifierPrompt },
          { role: "user", content: utterance },
        ],
        { temperature: 0, maxTokens: 100, responseFormat: { type: "json_object" } }
      );

      const jsonText = this.extractJsonObject(response.content);
      if (!jsonText) return null;

      const parsed = JSON.parse(jsonText) as { needsSearch?: boolean; query?: string | null };
      if (parsed.needsSearch === true && typeof parsed.query === "string" && parsed.query.trim().length > 0) {
        return parsed.query.trim();
      }
      return null;
    } catch (error) {
      console.error(
        "⚠ Search intent classification failed (falling back to plain conversation):",
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  /**
   * Actually runs a real web search (web-search.ts - real DuckDuckGo
   * results, not fabricated) and formats the results as searchContext
   * text for the conversational reply to synthesize an answer from.
   * Never throws: any failure (network error, DuckDuckGo markup change)
   * comes back as a clear, honest string so the reply can say it
   * couldn't search instead of guessing at an answer.
   */
  private async executeSearchIntent(query: string): Promise<string> {
    try {
      const results = await searchWeb(query, 5);
      const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   (${r.url})`);
      return `Search: "${query}"\n${lines.join("\n")}`;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("⚠ Web search failed:", detail);
      return `(Web search for "${query}" failed: ${detail} — tell the user honestly that you couldn't search just now, don't guess at an answer.)`;
    }
  }

  /**
   * LLM-based file-operation classifier (list/read/write/move) - unlike
   * app-control/click, there's no cheap regex fast path here worth
   * building: extracting real free-text file CONTENT from natural
   * phrasing ("create a file called todo.txt with buy milk and eggs on
   * it") genuinely needs language understanding, not pattern matching, so
   * this is the primary tier, not a fallback. Deliberately conservative
   * about "read" vs. app-control's "open" (reading a file's real text
   * contents is different from launching an application) and biased
   * toward false on ambiguity, same reasoning as classifySearchIntent()
   * - a missed file operation just falls back to normal conversation.
   */
  private async classifyFileIntent(utterance: string): Promise<{
    operation: "list" | "read" | "write" | "move";
    path: string;
    destinationPath?: string;
    content?: string;
    append?: boolean;
  } | null> {
    const classifierPrompt =
      "You are an intent classifier for JARVIS, a desktop voice assistant that can list/read/write/move real " +
      "files, but ONLY inside the user's own Desktop, Documents, Downloads, and Pictures folders (nowhere else). " +
      "Given what the user just said, determine whether they want a real file operation. Respond with ONLY a " +
      "single raw JSON object, no other text, no markdown code fences, matching exactly this shape:\n" +
      '{"isFileOperation": boolean, "operation": "list" | "read" | "write" | "move" | null, "path": string | ' +
      'null, "destinationPath": string | null, "content": string | null, "append": boolean}\n\n' +
      "Rules:\n" +
      '- "list" = show what\'s in a folder ("what\'s in my downloads folder"). path = the folder.\n' +
      '- "read" = read a real file\'s actual text contents out loud/back ("read my notes.txt", "what does my ' +
      'todo list say") - NOT opening an application (that\'s a different system; "open notepad" is ' +
      "isFileOperation: false).\n" +
      '- "write" = create a new file or save real text content to one. path = the file, content = the exact ' +
      "text to write, append = true only if they said to ADD to an existing file rather than create/overwrite.\n" +
      '- "move" = move/rename a file. path = source, destinationPath = target.\n' +
      "- Default to false on genuine ambiguity - this only fires for a clearly real, specific file operation, " +
      "not general conversation that happens to mention a file or folder in passing.\n\n" +
      "Examples:\n" +
      '"what\'s in my downloads folder" -> {"isFileOperation": true, "operation": "list", "path": "Downloads", ' +
      '"destinationPath": null, "content": null, "append": false}\n' +
      '"read my notes.txt file" -> {"isFileOperation": true, "operation": "read", "path": "Documents/notes.txt", ' +
      '"destinationPath": null, "content": null, "append": false}\n' +
      '"create a file called todo.txt with buy milk and eggs on it" -> {"isFileOperation": true, "operation": ' +
      '"write", "path": "Documents/todo.txt", "destinationPath": null, "content": "buy milk and eggs", "append": false}\n' +
      '"move report.docx to the desktop" -> {"isFileOperation": true, "operation": "move", "path": "report.docx", ' +
      '"destinationPath": "Desktop/report.docx", "content": null, "append": false}\n' +
      '"open notepad" -> {"isFileOperation": false, "operation": null, "path": null, "destinationPath": null, ' +
      '"content": null, "append": false}\n' +
      '"what\'s on my screen" -> {"isFileOperation": false, "operation": null, "path": null, "destinationPath": ' +
      'null, "content": null, "append": false}';

    try {
      const response = await this.modelProvider.complete(
        [
          { role: "system", content: classifierPrompt },
          { role: "user", content: utterance },
        ],
        { temperature: 0, maxTokens: 250, responseFormat: { type: "json_object" } }
      );

      const jsonText = this.extractJsonObject(response.content);
      if (!jsonText) return null;

      const parsed = JSON.parse(jsonText) as {
        isFileOperation?: boolean;
        operation?: "list" | "read" | "write" | "move" | null;
        path?: string | null;
        destinationPath?: string | null;
        content?: string | null;
        append?: boolean;
      };

      if (!parsed.isFileOperation || !parsed.operation || !parsed.path) return null;
      if (parsed.operation === "move" && !parsed.destinationPath) return null;
      if (parsed.operation === "write" && !parsed.content) return null;

      return {
        operation: parsed.operation,
        path: parsed.path,
        destinationPath: parsed.destinationPath ?? undefined,
        content: parsed.content ?? undefined,
        append: parsed.append ?? false,
      };
    } catch (error) {
      console.error(
        "⚠ File intent classification failed (falling back to plain conversation):",
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  /**
   * Actually runs a real file operation (file-manager.ts - real,
   * scoped to Desktop/Documents/Downloads/Pictures, see its own header
   * comment for the real safety reasoning). Never throws: any failure
   * (path outside the allowed roots, file not found) comes back as a
   * real ActionOutcome failure so the reply reports it honestly.
   */
  private async executeFileIntent(intent: {
    operation: "list" | "read" | "write" | "move";
    path: string;
    destinationPath?: string;
    content?: string;
    append?: boolean;
  }): Promise<ActionOutcome> {
    const description =
      intent.operation === "list"
        ? `List files in "${intent.path}"`
        : intent.operation === "read"
          ? `Read "${intent.path}"`
          : intent.operation === "write"
            ? `Write to "${intent.path}"`
            : `Move "${intent.path}" to "${intent.destinationPath}"`;
    try {
      switch (intent.operation) {
        case "list": {
          const entries = listDirectory(intent.path);
          const summary = entries
            .map((e) => `${e.name}${e.isDirectory ? "/" : ` (${e.sizeBytes} bytes)`}`)
            .join(", ");
          return { description, success: true, detail: entries.length > 0 ? summary : "(empty folder)" };
        }
        case "read": {
          const text = readTextFile(intent.path);
          // Real cap, not arbitrary: a large file's full text landing
          // verbatim in the conversational prompt would both waste real
          // tokens and risk the reply trying to read the whole thing back
          // out loud. 4000 chars is generous for anything a spoken
          // "read me my notes" realistically means; a genuinely huge file
          // gets an honest truncation note, not a silently cut-off answer.
          const MAX_READ_CHARS = 4000;
          const truncated = text.length > MAX_READ_CHARS;
          const detail = truncated
            ? `${text.slice(0, MAX_READ_CHARS)}\n\n(truncated - real file is ${text.length} characters total)`
            : text;
          return { description, success: true, detail };
        }
        case "write": {
          writeTextFile(intent.path, intent.content ?? "", { append: intent.append });
          return { description, success: true, detail: `${intent.append ? "Appended to" : "Wrote"} "${intent.path}"` };
        }
        case "move": {
          moveFile(intent.path, intent.destinationPath!);
          return { description, success: true, detail: `Moved to "${intent.destinationPath}"` };
        }
      }
    } catch (error) {
      return {
        description,
        success: false,
        detail: error instanceof Error ? error.message : String(error),
      };
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
