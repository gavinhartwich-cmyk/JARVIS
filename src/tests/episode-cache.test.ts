import { describe, expect, test } from "bun:test";
import {
  isCacheableUtterance,
  tokenSimilarity,
  findCachedAnswer,
  recordCacheableEpisode,
} from "../core/episode-cache";
import type { ModelProvider, ModelResponse } from "../models/types";

describe("isCacheableUtterance", () => {
  test("allows stable factual questions", () => {
    expect(isCacheableUtterance("What's the capital of France?")).toBe(true);
    expect(isCacheableUtterance("How many ounces are in a pound?")).toBe(true);
  });

  test("rejects action / command requests", () => {
    expect(isCacheableUtterance("Play some music")).toBe(false);
    expect(isCacheableUtterance("Open the garage door")).toBe(false);
    expect(isCacheableUtterance("Turn on the lights")).toBe(false);
    expect(isCacheableUtterance("Set a timer for five minutes")).toBe(false);
  });

  test("rejects time/context-dependent questions", () => {
    expect(isCacheableUtterance("What's the weather today?")).toBe(false);
    expect(isCacheableUtterance("What's on my calendar?")).toBe(false);
    expect(isCacheableUtterance("What time is it?")).toBe(false);
    expect(isCacheableUtterance("Remind me to call mom tomorrow")).toBe(false);
  });

  test("rejects empty input", () => {
    expect(isCacheableUtterance("   ")).toBe(false);
  });
});

describe("tokenSimilarity", () => {
  test("is 1 for identical questions", () => {
    expect(tokenSimilarity("What is the capital of France?", "What is the capital of France?")).toBe(1);
  });

  test("distinguishes similarly-worded but different questions", () => {
    // This is exactly the false-positive the old first-10-characters prefix
    // match let through: same shape, different subject.
    const france = "What's the capital of France?";
    const germany = "What's the capital of Germany?";
    const similarity = tokenSimilarity(france, germany);
    expect(similarity).toBeGreaterThan(0); // shares most words
    expect(similarity).toBeLessThan(1); // but isn't the same question
  });

  test("is low for unrelated questions", () => {
    expect(tokenSimilarity("What's the capital of France?", "How do I reset my router?")).toBeLessThan(0.2);
  });
});

// Fails the test if called — proves the cache short-circuits (on the
// stability gate, or on an empty candidate pool) before ever reaching an
// LLM verification call.
const unreachableProvider: ModelProvider = {
  name: "unreachable",
  async available() {
    return true;
  },
  async complete(): Promise<ModelResponse> {
    throw new Error("modelProvider.complete should not have been called");
  },
  async *stream(): AsyncIterable<never> {
    throw new Error("modelProvider.stream should not have been called");
  },
};

describe("findCachedAnswer", () => {
  test("returns null without calling the model for a non-cacheable utterance", async () => {
    const result = await findCachedAnswer("Turn on the lights", unreachableProvider);
    expect(result).toBeNull();
  });

  test("returns null (not throw) when no database is configured", async () => {
    // No DATABASE_URL / initializeDatabase() in this test environment —
    // storeMemory/listMemoriesByTag catch internally and degrade to a
    // no-op / empty list, so this should resolve cleanly rather than throw.
    const result = await findCachedAnswer("What's the capital of France?", unreachableProvider);
    expect(result).toBeNull();
  });
});

describe("recordCacheableEpisode", () => {
  test("does not throw when no database is configured", async () => {
    await expect(recordCacheableEpisode("What's the capital of France?", "Paris.")).resolves.toBeUndefined();
  });

  test("no-ops for non-cacheable questions without touching storage", async () => {
    await expect(recordCacheableEpisode("Turn on the lights", "Done.")).resolves.toBeUndefined();
  });
});
