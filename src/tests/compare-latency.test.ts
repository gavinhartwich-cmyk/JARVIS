import { describe, expect, test } from "bun:test";
import { summarize, type LatencyRunResult } from "../prototypes/gemini-live/compare-latency";

describe("compare-latency — summarize()", () => {
  test("averages only successful runs and reports the real success rate", () => {
    const results: LatencyRunResult[] = [
      { path: "current-jarvis", prompt: "a", success: true, totalMs: 100, firstResponseMs: 50, cpuMs: 10 },
      { path: "current-jarvis", prompt: "b", success: true, totalMs: 300, firstResponseMs: 150, cpuMs: 30 },
      { path: "current-jarvis", prompt: "c", success: false, error: "boom" },
    ];

    const summary = summarize("current-jarvis", results);
    expect(summary.runs).toBe(3);
    expect(summary.successRate).toBeCloseTo(2 / 3);
    expect(summary.avgTotalMs).toBe(200); // (100 + 300) / 2 — the failed run must not drag this down
    expect(summary.avgFirstResponseMs).toBe(100);
    expect(summary.avgCpuMs).toBe(20);
  });

  test("an empty result set summarizes to nulls and a 0% success rate, not a crash", () => {
    const summary = summarize("gemini-live", []);
    expect(summary.runs).toBe(0);
    expect(summary.successRate).toBe(0);
    expect(summary.avgTotalMs).toBeNull();
    expect(summary.avgFirstResponseMs).toBeNull();
    expect(summary.avgCpuMs).toBeNull();
  });

  test("all-failed runs summarize to a 0% success rate with null averages", () => {
    const results: LatencyRunResult[] = [
      { path: "gemini-live", prompt: "a", success: false, error: "no api key" },
      { path: "gemini-live", prompt: "b", success: false, error: "no api key" },
    ];
    const summary = summarize("gemini-live", results);
    expect(summary.successRate).toBe(0);
    expect(summary.avgTotalMs).toBeNull();
  });
});
