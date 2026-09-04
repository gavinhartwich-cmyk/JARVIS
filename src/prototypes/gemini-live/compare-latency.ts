/**
 * Architecture update step 5: "Compare CURRENT JARVIS vs GEMINI LIVE
 * PROTOTYPE" — time to first response, time to first audio, total response
 * time, CPU/RAM, reliability.
 *
 * This is the harness, not the result. It has never actually run against
 * live services in this sandbox (no GEMINI_API_KEY, no Postgres, no
 * Ollama/Gemini reachable) — every number it would produce here is
 * "unreachable," not a real measurement. Fabricating comparison numbers
 * would be exactly the kind of confidently-wrong result the project's
 * verification-first principle exists to prevent, so this file is built
 * and typechecked, ready to run for real on Gavin's PC (`bun run dev
 * compare-latency`), and nothing more is claimed about it here.
 *
 * Unlike the rest of src/prototypes/gemini-live/, this file necessarily
 * imports the current JARVIS path (VoiceInterface) too — comparing against
 * it is the entire point of this one file.
 */

import { VoiceInterface } from "../../phase2/voice-interface";
import { DEFAULT_VOICE_CONFIG } from "../../phase2/voice-config";
import { createDefaultGateway, GatewayModelProvider } from "../../models/llm-gateway";
import { telemetry } from "../../core/telemetry";
import { GeminiLiveSession } from "./gemini-live-session";
import { OPEN_APP_DECLARATION, createOpenAppToolHandler } from "./live-tools";

export interface LatencyRunResult {
  path: "current-jarvis" | "gemini-live";
  prompt: string;
  success: boolean;
  totalMs?: number;
  firstResponseMs?: number;
  cpuMs?: number;
  rssDeltaBytes?: number;
  error?: string;
}

const LIVE_FIRST_RESPONSE_TIMEOUT_MS = 20_000;

function measureResource<T>(fn: () => Promise<T>): Promise<{ result: T; cpuMs: number; rssDeltaBytes: number }> {
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  return fn().then((result) => {
    const cpuDelta = process.cpuUsage(cpuStart);
    return {
      result,
      cpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
      rssDeltaBytes: process.memoryUsage().rss - rssStart,
    };
  });
}

async function runCurrentJarvis(prompt: string, voice: VoiceInterface): Promise<LatencyRunResult> {
  try {
    const { result, cpuMs, rssDeltaBytes } = await measureResource(() => voice.respondToText(prompt));
    // respondToText's own trace (Stage.FIRST_AUDIO etc.) is the most recent
    // finished trace right after this call — pull it rather than
    // re-implementing timing here, so both paths are measured the same way.
    const trace = telemetry.getRecent(1)[0];
    const firstToken = trace?.marks.find((m) => m.stage === "first_token");
    return {
      path: "current-jarvis",
      prompt,
      success: !!result.response,
      totalMs: trace?.totalMs,
      firstResponseMs: firstToken?.atMs,
      cpuMs,
      rssDeltaBytes,
    };
  } catch (error) {
    return { path: "current-jarvis", prompt, success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runGeminiLive(prompt: string): Promise<LatencyRunResult> {
  const start = performance.now();
  const session = new GeminiLiveSession({
    systemInstruction: "You are JARVIS, a helpful voice assistant. Keep replies short.",
  });
  session.registerTool(OPEN_APP_DECLARATION, createOpenAppToolHandler());

  try {
    const { cpuMs, rssDeltaBytes, result: firstResponseMs } = await measureResource(async () => {
      await session.connect();
      const firstResponse = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`No response within ${LIVE_FIRST_RESPONSE_TIMEOUT_MS}ms`)),
          LIVE_FIRST_RESPONSE_TIMEOUT_MS
        );
        session.on("audio", () => {
          clearTimeout(timer);
          resolve(performance.now() - start);
        });
        session.on("text", () => {
          clearTimeout(timer);
          resolve(performance.now() - start);
        });
      });
      session.sendText(prompt);
      return firstResponse;
    });

    const totalMs = performance.now() - start;
    return {
      path: "gemini-live",
      prompt,
      success: true,
      totalMs,
      firstResponseMs,
      cpuMs,
      rssDeltaBytes,
    };
  } catch (error) {
    return { path: "gemini-live", prompt, success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    session.close();
  }
}

export interface ComparisonSummary {
  path: LatencyRunResult["path"];
  runs: number;
  successRate: number;
  avgTotalMs: number | null;
  avgFirstResponseMs: number | null;
  avgCpuMs: number | null;
}

export function summarize(path: LatencyRunResult["path"], results: LatencyRunResult[]): ComparisonSummary {
  const successes = results.filter((r) => r.success);
  const avg = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

  return {
    path,
    runs: results.length,
    successRate: results.length === 0 ? 0 : successes.length / results.length,
    avgTotalMs: avg(successes.map((r) => r.totalMs).filter((v): v is number => v !== undefined)),
    avgFirstResponseMs: avg(successes.map((r) => r.firstResponseMs).filter((v): v is number => v !== undefined)),
    avgCpuMs: avg(successes.map((r) => r.cpuMs).filter((v): v is number => v !== undefined)),
  };
}

/** Runs both paths against the same prompts and prints a comparison table. Returns raw results too, for anything that wants to persist/analyze them further. */
export async function runComparison(
  prompts: string[],
  runsPerPath: number = 3
): Promise<{ results: LatencyRunResult[]; summary: ComparisonSummary[] }> {
  const results: LatencyRunResult[] = [];

  // [FIXED 2026-09-04] Real bug, found live: this used to construct a
  // brand-new VoiceInterface (and therefore a brand-new, cold Chatterbox
  // daemon - a fresh Python process with PyTorch/CUDA to import and a
  // model to load) for EVERY single current-jarvis run. A real, isolated
  // test proved the actual cost: 37.8s wall time on a cold daemon vs.
  // 1.8-2.1s on the same warm one for the next two calls, with model time
  // itself identical (~2s) in both cases - the entire gap was one-time
  // process/import/load overhead, not synthesis actually being slow. A
  // real `bun run dev listen` session pays this exact cost ONCE, at
  // startup, via VoiceInterface.start()'s own fire-and-forget warm-up -
  // this harness was instead re-paying it on every repeated run, making
  // "current JARVIS" look 15-20x slower than real usage ever experiences.
  // Fixed the same way: one VoiceInterface (one daemon) for the whole
  // comparison, explicitly warmed up before any timed run starts.
  const voice = new VoiceInterface(DEFAULT_VOICE_CONFIG, new GatewayModelProvider(createDefaultGateway()));
  console.log("🔥 Warming up current-JARVIS's TTS daemon before timed runs (matches real listen-session startup)...");
  try {
    await voice.respondToText("Warm-up.");
  } catch (error) {
    console.log(`   ⚠️  Warm-up call failed (non-fatal, timed runs will just eat the cold-start cost instead): ${error instanceof Error ? error.message : error}`);
  }

  for (const prompt of prompts) {
    for (let i = 0; i < runsPerPath; i++) {
      results.push(await runCurrentJarvis(prompt, voice));
      results.push(await runGeminiLive(prompt));
    }
  }

  const summary = [
    summarize("current-jarvis", results.filter((r) => r.path === "current-jarvis")),
    summarize("gemini-live", results.filter((r) => r.path === "gemini-live")),
  ];

  console.log("\n" + "=".repeat(70));
  console.log("📊 LATENCY COMPARISON — current JARVIS vs Gemini Live prototype");
  console.log("=".repeat(70));
  for (const s of summary) {
    console.log(`\n${s.path} (${s.runs} runs, ${(s.successRate * 100).toFixed(0)}% succeeded)`);
    console.log(`  avg total:          ${s.avgTotalMs?.toFixed(0) ?? "N/A"} ms`);
    console.log(`  avg first response: ${s.avgFirstResponseMs?.toFixed(0) ?? "N/A"} ms`);
    console.log(`  avg CPU time:       ${s.avgCpuMs?.toFixed(0) ?? "N/A"} ms`);
  }
  const failures = results.filter((r) => !r.success);
  if (failures.length > 0) {
    console.log(`\n⚠️  ${failures.length}/${results.length} runs failed — see errors below:`);
    for (const f of failures) console.log(`   [${f.path}] "${f.prompt}": ${f.error}`);
  }
  console.log("=".repeat(70));

  return { results, summary };
}
