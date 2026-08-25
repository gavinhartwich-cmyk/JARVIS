import { getDatabase } from "../db/client";
import { memories } from "../db/schema";
import { v4 as uuid } from "uuid";
import type { NewMemory } from "../db/schema";
import { eq, like } from "drizzle-orm";

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
      .limit(limit);
  } catch (error) {
    console.error("Failed to search memories:", error);
    return [];
  }
}
