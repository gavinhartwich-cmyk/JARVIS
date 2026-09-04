import { getDatabase } from "../db/client";
import { memories } from "../db/schema";
import { v4 as uuid } from "uuid";
import type { NewMemory } from "../db/schema";
import { eq, like, or, desc } from "drizzle-orm";

export interface MemoryInput {
  type: "fact" | "episode" | "semantic" | "preference" | "project" | "goal" | "relationship" | "event";
  content: string;
  importance?: number;
  confidence?: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export async function storeMemory(memory: MemoryInput) {
  try {
    const db = getDatabase();
    await db.insert(memories).values({
      id: uuid(),
      type: memory.type,
      content: memory.content,
      importance: memory.importance || 5,
      confidence: memory.confidence || "0.75",
      source: memory.source,
      tags: memory.tags,
      metadata: memory.metadata,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
    });
  } catch (error) {
    console.error("Failed to store memory:", error);
    // Don't throw - memory failures should not block operations
  }
}

export async function retrieveMemories(
  type?: MemoryInput["type"],
  limit: number = 10
) {
  try {
    const db = getDatabase();

    // Drizzle's query builder doesn't accept a JS predicate function in
    // .where() (that was the old, incorrect version of this code — it
    // type-checked as an error and would have thrown at runtime the first
    // time this function was actually called). Real Drizzle conditions are
    // built with its own operators (eq, like, etc.) against the schema's
    // column objects.
    if (type) {
      return db.select().from(memories).where(eq(memories.type, type)).limit(limit);
    }
    return db.select().from(memories).limit(limit);
  } catch (error) {
    console.error("Failed to retrieve memories:", error);
    return [];
  }
}

export async function searchMemories(query: string, limit: number = 10) {
  try {
    const db = getDatabase();

    // Simple substring search for Phase 0
    // Later: can use full-text search
    return db
      .select()
      .from(memories)
      .where(like(memories.content, `%${query}%`))
      .orderBy(desc(memories.importance))
      .limit(limit);
  } catch (error) {
    console.error("Failed to search memories:", error);
    return [];
  }
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "for", "with",
  "and", "or", "but", "what", "when", "where", "how", "why", "who", "my", "your", "his", "her", "its",
  "our", "their", "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they", "me",
  "him", "us", "them", "do", "does", "did", "can", "could", "will", "would", "should", "please", "jarvis",
  "just", "really", "very", "some", "any", "about", "there", "here", "then", "than", "like", "want",
  "wants", "know", "think", "have", "has", "had", "get", "gets", "got", "make", "made", "need", "needs",
  "lately", "kind", "sort", "much", "many", "more", "most", "into", "from", "over", "also", "even",
]);

/**
 * [ADDED 2026-09-04] Real fix for a real, found gap (full master-doc
 * alignment audit): searchMemories() above only matches when the WHOLE
 * query string appears verbatim inside a stored memory's content, which
 * almost never happens for a natural spoken utterance against a
 * differently-worded stored memory ("what's my favorite band" vs. a
 * memory stored as "Gavin's favorite band is X"). Real, honest fix - not
 * full-text/semantic search (no embeddings infra in this project), but a
 * genuine improvement: split the utterance into real keywords (strip a
 * small real stopword list, keep words >3 chars, cap at 6 so a long
 * rambling utterance doesn't become a dozen-clause query) and match ANY
 * of them, ranked by the same real importance column. See
 * conversation-intelligence.ts's assemblePrompt() for where this actually
 * gets used - Part 4.3's "Retrieve (query by keyword/context)" memory
 * operation, wired into the live conversational path for the first time.
 */
export async function searchMemoriesByUtterance(utterance: string, limit: number = 3) {
  try {
    const keywords = Array.from(
      new Set(
        utterance
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 3 && !STOPWORDS.has(w))
      )
    ).slice(0, 6);

    if (keywords.length === 0) return [];

    const db = getDatabase();
    return db
      .select()
      .from(memories)
      .where(or(...keywords.map((k) => like(memories.content, `%${k}%`))))
      .orderBy(desc(memories.importance))
      .limit(limit);
  } catch (error) {
    console.error("Failed to search memories by utterance:", error);
    return [];
  }
}
