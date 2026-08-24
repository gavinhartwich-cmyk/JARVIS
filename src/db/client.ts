import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "./schema";

let client: Client | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export async function initializeDatabase(connectionString?: string) {
  if (db) return db;

  const connStr = connectionString || process.env.DATABASE_URL || "postgresql://jarvis:jarvis@localhost:5432/jarvis";

  client = new Client({
    connectionString: connStr,
  });

  try {
    await client.connect();
    console.log("✓ Connected to PostgreSQL");
  } catch (error) {
    console.error("✗ Failed to connect to PostgreSQL");
    console.error(`  Connection string: ${connStr}`);
    console.error(`  Make sure PostgreSQL is running and the database exists`);
    console.error(`  Error: ${error}`);
    throw error;
  }

  db = drizzle(client, { schema });
  return db;
}

export function getDatabase() {
  if (!db) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }
  return db;
}

export async function closeDatabase() {
  if (client) {
    await client.end();
    console.log("✓ Disconnected from PostgreSQL");
  }
}
