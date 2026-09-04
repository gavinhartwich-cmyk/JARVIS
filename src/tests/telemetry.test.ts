import { describe, expect, test } from "bun:test";
import { RequestTracer, Stage } from "../core/telemetry";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("RequestTracer", () => {
  test("records marks with per-stage deltas and a total", async () => {
    const tracer = new RequestTracer();
    const id = tracer.start("test.trace");

    await sleep(5);
    tracer.mark(id, Stage.INPUT_RECEIVED);
    await sleep(5);
    tracer.mark(id, Stage.FIRST_TOKEN);

    const trace = tracer.finish(id);
    expect(trace).not.toBeNull();
    expect(trace!.marks.map((m) => m.stage)).toEqual([Stage.INPUT_RECEIVED, Stage.FIRST_TOKEN]);
    // Real elapsed time, not exact — just confirm ordering/positivity, not
    // a specific ms value (would make this test flaky on a loaded CI box).
    expect(trace!.marks[0].deltaMs).toBeGreaterThan(0);
    expect(trace!.marks[1].deltaMs).toBeGreaterThan(0);
    expect(trace!.totalMs).toBeGreaterThanOrEqual(trace!.marks[1].atMs);
  });

  test("finish() on an unknown trace id returns null instead of throwing", () => {
    const tracer = new RequestTracer();
    expect(tracer.finish("never-started")).toBeNull();
  });

  test("mark() on an unknown/finished trace id is a silent no-op", () => {
    const tracer = new RequestTracer();
    const id = tracer.start("test.trace");
    tracer.finish(id);
    expect(() => tracer.mark(id, Stage.FIRST_TOKEN)).not.toThrow();
  });

  test("getRecent()/getStats() reflect finished traces, most recent last", () => {
    const tracer = new RequestTracer();

    const a = tracer.start("test.a");
    tracer.mark(a, Stage.AGENT_EXECUTION, "researcher");
    tracer.finish(a);

    const b = tracer.start("test.b");
    tracer.mark(b, Stage.AGENT_EXECUTION, "reasoner");
    tracer.finish(b);

    const recent = tracer.getRecent();
    expect(recent.length).toBe(2);
    expect(recent[recent.length - 1].label).toBe("test.b");

    const stats = tracer.getStats();
    expect(stats.count).toBe(2);
    expect(stats.byStageAvgMs[Stage.AGENT_EXECUTION]).toBeGreaterThanOrEqual(0);
  });

  test("history is bounded so it can't grow unboundedly across a long-running process", () => {
    const tracer = new RequestTracer();
    for (let i = 0; i < 250; i++) {
      const id = tracer.start(`test.bulk.${i}`);
      tracer.finish(id);
    }
    expect(tracer.getRecent(1000).length).toBeLessThanOrEqual(200);
  });
});
