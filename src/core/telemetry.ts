/**
 * Latency telemetry (architecture update, section 7: "Do not assume the
 * bottleneck. Measure it.")
 *
 * A request is traced by starting it, marking named stages as they happen,
 * and finishing it. Finishing computes per-stage deltas (time since the
 * previous mark, or since start for the first mark) and total elapsed time,
 * logs a one-line summary, and keeps the trace in a bounded in-memory
 * history so `getStats()` can answer "where does the time actually go"
 * across recent requests — not just the last one.
 *
 * This module is intentionally dependency-free (no DB) so it can wrap the
 * fast conversational path without adding its own latency or failure mode;
 * if a durable/queryable history is needed later, traces can be persisted
 * through the existing audit system without changing this API.
 */

/** Well-known stage names from the architecture update's latency breakdown. Custom stage strings (e.g. "agent:researcher") are also fine — this is a start, not an enum. */
export const Stage = {
  INPUT_RECEIVED: "input_received",
  STT: "stt",
  INTENT_ROUTING: "intent_routing",
  PROVIDER_CONNECTION: "provider_connection",
  FIRST_TOKEN: "first_token",
  FIRST_AUDIO: "first_audio",
  TOOL_EXECUTION: "tool_execution",
  AGENT_EXECUTION: "agent_execution",
  VERIFICATION: "verification",
  TOTAL_COMPLETION: "total_completion",
} as const;

export interface LatencyMark {
  stage: string;
  atMs: number; // elapsed ms since trace start
  deltaMs: number; // ms since the previous mark (or since start, for the first mark)
  note?: string;
}

export interface LatencyTrace {
  id: string;
  label: string;
  startedAt: Date;
  marks: LatencyMark[];
  totalMs: number;
}

interface OpenTrace {
  id: string;
  label: string;
  startedAt: Date;
  startPerf: number;
  marks: LatencyMark[];
  lastPerf: number;
}

const HISTORY_LIMIT = 200;

let counter = 0;

export class RequestTracer {
  private open = new Map<string, OpenTrace>();
  private history: LatencyTrace[] = [];

  /** Begin tracing one request/turn. Returns a trace id to pass to mark()/finish(). */
  start(label: string): string {
    const id = `${label}-${Date.now()}-${++counter}`;
    const now = performance.now();
    this.open.set(id, { id, label, startedAt: new Date(), startPerf: now, marks: [], lastPerf: now });
    return id;
  }

  /** Record that `stage` just happened for this trace. Safe to call multiple times per stage (e.g. once per agent). Silently ignored for an unknown/already-finished trace id, so callers never need to guard every call site. */
  mark(traceId: string, stage: string, note?: string): void {
    const trace = this.open.get(traceId);
    if (!trace) return;
    const now = performance.now();
    trace.marks.push({
      stage,
      atMs: now - trace.startPerf,
      deltaMs: now - trace.lastPerf,
      note,
    });
    trace.lastPerf = now;
  }

  /** End tracing, log a one-line summary, and retain it in the bounded history. Returns null for an unknown trace id (e.g. finish() called twice). */
  finish(traceId: string): LatencyTrace | null {
    const trace = this.open.get(traceId);
    if (!trace) return null;
    this.open.delete(traceId);

    const totalMs = performance.now() - trace.startPerf;
    const finished: LatencyTrace = {
      id: trace.id,
      label: trace.label,
      startedAt: trace.startedAt,
      marks: trace.marks,
      totalMs,
    };

    this.history.push(finished);
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }

    const stageSummary = finished.marks
      .map((m) => `${m.stage}${m.note ? `(${m.note})` : ""}=${m.deltaMs.toFixed(0)}ms`)
      .join(" → ");
    console.log(`⏱  [${finished.label}] total=${totalMs.toFixed(0)}ms${stageSummary ? " | " + stageSummary : ""}`);

    return finished;
  }

  /** Most recent finished traces, newest last. */
  getRecent(limit: number = 20): LatencyTrace[] {
    return this.history.slice(-limit);
  }

  /** Aggregate stats across recent history — mean/max total, and mean per-stage delta (by stage name, across whatever traces recorded that stage). */
  getStats(limit: number = HISTORY_LIMIT): {
    count: number;
    avgTotalMs: number;
    maxTotalMs: number;
    byStageAvgMs: Record<string, number>;
  } {
    const traces = this.getRecent(limit);
    if (traces.length === 0) {
      return { count: 0, avgTotalMs: 0, maxTotalMs: 0, byStageAvgMs: {} };
    }

    const totals = traces.map((t) => t.totalMs);
    const avgTotalMs = totals.reduce((a, b) => a + b, 0) / totals.length;
    const maxTotalMs = Math.max(...totals);

    const stageSums = new Map<string, { sum: number; count: number }>();
    for (const trace of traces) {
      for (const mark of trace.marks) {
        const entry = stageSums.get(mark.stage) ?? { sum: 0, count: 0 };
        entry.sum += mark.deltaMs;
        entry.count += 1;
        stageSums.set(mark.stage, entry);
      }
    }

    const byStageAvgMs: Record<string, number> = {};
    for (const [stage, { sum, count }] of stageSums) {
      byStageAvgMs[stage] = sum / count;
    }

    return { count: traces.length, avgTotalMs, maxTotalMs, byStageAvgMs };
  }
}

/** Process-wide tracer. A singleton is fine here — this is diagnostic instrumentation, not application state. */
export const telemetry = new RequestTracer();
