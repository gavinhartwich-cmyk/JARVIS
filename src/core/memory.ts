import { getDatabase } from "../db/client";
import { memories } from "../db/schema";
import { v4 as uuid } from "uuid";
import type { NewMemory } from "../db/schema";

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
  type?: string,
  limit: number = 10
) {
  try {
    const db = getDatabase();

    let query = db.select().from(memories);

    if (type) {
      query = query.where((m) => m.type === type);
    }

    return query.limit(limit);
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
      .where((m) => m.content.like(`%${query}%`))
      .limit(limit);
  } catch (error) {
    console.error("Failed to search memories:", error);
    return [];
  }
}
