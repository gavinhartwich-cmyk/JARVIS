import { getDatabase } from "../db/client";
import { memories } from "../db/schema";
import { v4 as uuid } from "uuid";
import type { NewMemory } from "../db/schema";
import { and, desc, eq, gt, isNull, like, or } from "drizzle-orm";

export interface MemoryInput {
  type: "fact" | "episode" | "semantic" | "preference" | "project" | "goal" | "relationship" | "event";
  content: string;
  importance?: number;
  confidence?: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
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
      expiresAt: memory.expiresAt,
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
      .limit(limit);
  } catch (error) {
    console.error("Failed to search memories:", error);
    return [];
  }
}

/**
 * List non-expired memories of a given type that carry a specific tag,
 * newest first. Type + expiry filtering happens in SQL; tag containment is
 * checked in JS afterward rather than with a Postgres array-containment
 * operator, to keep this query simple and avoid another moving part.
 *
 * Used by the episode cache (src/core/episode-cache.ts) to pull its
 * candidate pool of previously-answered, cacheable questions.
 */
export async function listMemoriesByTag(
  type: MemoryInput["type"],
  tag: string,
  limit: number = 200
) {
  try {
    const db = getDatabase();
    const now = new Date();
    const rows = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.type, type),
          or(isNull(memories.expiresAt), gt(memories.expiresAt, now))
        )
      )
      .orderBy(desc(memories.createdAt))
      .limit(limit);
    return rows.filter((row) => row.tags?.includes(tag));
  } catch (error) {
    console.error("Failed to list memories by tag:", error);
    return [];
  }
}
