/**
 * Persistent episode cache
 *
 * Replaces the old in-process, session-only cache that used to live inside
 * ConversationalIntelligence (a plain array, wiped every restart, matched by
 * "does the past answer's summary contain the first 10 characters of the
 * new question" — enough to conflate "What's the capital of France?" with
 * "What's the capital of Germany?"). This version:
 *
 *   1. Persists cache entries to the `memories` table, so a repeated
 *      question hits even across process restarts, not just within one
 *      `listen` session.
 *   2. Ranks candidates by real token-overlap similarity, not a string
 *      prefix.
 *   3. Never even considers caching anything that looks time/context
 *      dependent (weather, calendar, "what time is it") or that is an
 *      action request (play/open/turn on/...) rather than a question —
 *      those must always run for real.
 *   4. Requires a real LLM judgment — "is this genuinely the same question,
 *      and is the old answer still likely true" — before serving a cached
 *      reply. A wrong cache hit (confidently repeating something that's
 *      since gone stale) is worse than a slower correct answer, so the bar
 *      to serve from cache is deliberately high.
 *
 * A cache hit skips the full reply-generation call entirely; the only cost
 * is a handful of cheap, short "is this the same and still true" checks.
 */

import { listMemoriesByTag, storeMemory } from "./memory";
import type { ModelProvider } from "../models/types";

export const EPISODE_CACHE_TAG = "episode-cache";

/** Minimum token-overlap before a cached entry is even worth an LLM check. */
const SIMILARITY_FLOOR = 0.45;
/** How many previously-cached entries to consider per lookup. */
const CANDIDATE_POOL_LIMIT = 200;
/** Cap on (cheap) LLM verification calls per lookup — closest matches only. */
const CANDIDATES_TO_VERIFY = 3;
/** Cache entries older than this are never served, even if verified. */
const CACHE_TTL_DAYS = 90;

interface CachedEntry {
  question: string;
  answer: string;
}

// Utterances about anything that can change between "now" and "whenever
// this cache entry was written" must never be served from cache, no matter
// how similar the wording looks. This errs toward excluding too much: a
// genuinely stable question that happens to use one of these words just
// falls back to a real LLM call, which is the safe failure mode.
const UNSTABLE_PATTERN =
  /\b(today|tonight|tomorrow|yesterday|right now|currently|this (morning|afternoon|evening|week|month|weekend)|weather|forecast|temperature outside|traffic|the news|headlines?|score|stock|price|calendar|my schedule|meeting|appointment|remind(er)?|battery|where('?s| is| are| am)|what time|what day|what('?s| is) the date)\b/i;

// Action / command requests must always run for real — caching "turn on
// the lights" would silently no-op the action on a cache hit instead of
// doing it.
const ACTION_PATTERN =
  /^\s*(play|open|close|click|type|send|save|delete|create|turn (on|off)|set|call|text|order|buy|launch|run|stop|pause|resume|mute|unmute|increase|decrease|file|remind|schedule|add|remove|move|cancel)\b/i;

/**
 * Whether an utterance is even the *kind* of thing that's safe to cache.
 * This is the stability + intent gate; it says nothing about whether a
 * matching cached answer actually exists.
 */
export function isCacheableUtterance(utterance: string): boolean {
  const trimmed = utterance.trim();
  if (!trimmed) return false;
  if (ACTION_PATTERN.test(trimmed)) return false;
  if (UNSTABLE_PATTERN.test(trimmed)) return false;
  return true;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1)
  );
}

/** Jaccard similarity over word sets — cheap, deterministic, no embedding call. */
export function tokenSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isCachedEntry(metadata: unknown): metadata is CachedEntry {
  return (
    !!metadata &&
    typeof metadata === "object" &&
    typeof (metadata as Record<string, unknown>).question === "string" &&
    typeof (metadata as Record<string, unknown>).answer === "string"
  );
}

async function loadCandidates(): Promise<CachedEntry[]> {
  const rows = await listMemoriesByTag("episode", EPISODE_CACHE_TAG, CANDIDATE_POOL_LIMIT);
  const entries: CachedEntry[] = [];
  for (const row of rows) {
    if (isCachedEntry(row.metadata)) {
      entries.push({ question: row.metadata.question, answer: row.metadata.answer });
    }
  }
  return entries;
}

/**
 * Ask the model whether a cached answer genuinely still applies. Kept
 * deliberately strict and cheap (a handful of output tokens) — this is the
 * only LLM call a cache hit costs, versus a full reply generation for a
 * miss.
 */
async function verifyStillValid(
  newQuestion: string,
  cached: CachedEntry,
  modelProvider: ModelProvider
): Promise<boolean> {
  try {
    const result = await modelProvider.complete(
      [
        {
          role: "user",
          content:
            `New question: "${newQuestion}"\n` +
            `Previously answered question: "${cached.question}"\n` +
            `Previous answer: "${cached.answer}"\n\n` +
            `Are these two questions asking exactly the same thing, and is the previous ` +
            `answer still accurate and current right now? Reply with exactly one word: YES or NO.`,
        },
      ],
      {
        systemPrompt:
          "You are a strict cache-validity checker. Only answer YES if the questions are " +
          "equivalent and the answer cannot have changed over time. When unsure, answer NO.",
        maxTokens: 5,
        temperature: 0,
      }
    );
    return /^\s*yes\b/i.test(result.content);
  } catch (error) {
    console.error("Episode cache: verification call failed, treating as a miss:", error);
    return false;
  }
}

/**
 * Look up a persistent, verified cached answer for `utterance`. Returns
 * null on anything short of a confident hit — no cache entries, nothing
 * similar enough, or the LLM judge declined to confirm it's still valid.
 */
export async function findCachedAnswer(
  utterance: string,
  modelProvider: ModelProvider
): Promise<string | null> {
  if (!isCacheableUtterance(utterance)) return null;

  const candidates = await loadCandidates();
  if (candidates.length === 0) return null;

  const ranked = candidates
    .map((entry) => ({ entry, similarity: tokenSimilarity(utterance, entry.question) }))
    .filter((c) => c.similarity >= SIMILARITY_FLOOR)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, CANDIDATES_TO_VERIFY);

  for (const { entry } of ranked) {
    if (await verifyStillValid(utterance, entry, modelProvider)) {
      return entry.answer;
    }
  }

  return null;
}

/**
 * Persist a question/answer pair for future cache lookups. No-ops for
 * anything `isCacheableUtterance` rejects (action requests, time/context
 * dependent questions) or an empty answer, so callers can call this
 * unconditionally after every real reply.
 */
export async function recordCacheableEpisode(question: string, answer: string): Promise<void> {
  if (!isCacheableUtterance(question)) return;
  if (!answer || !answer.trim()) return;

  const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

  await storeMemory({
    type: "episode",
    content: `Q: ${question}\nA: ${answer}`,
    importance: 3,
    confidence: "0.75",
    source: "episode-cache",
    tags: [EPISODE_CACHE_TAG],
    metadata: { question, answer },
    expiresAt,
  });
}
