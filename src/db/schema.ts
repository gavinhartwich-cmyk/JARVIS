import { pgTable, text, uuid, timestamp, jsonb, integer, varchar, pgEnum, numeric, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Enums
export const memoryTypeEnum = pgEnum("memory_type", ["fact", "episode", "semantic", "preference", "project", "goal", "relationship", "event"]);
export const verificationStatusEnum = pgEnum("verification_status", ["unverified", "partially_verified", "verified", "conflicted", "failed"]);
export const agentStatusEnum = pgEnum("agent_status", ["pending", "running", "completed", "failed", "cancelled"]);
export const taskStatusEnum = pgEnum("task_status", ["created", "decomposed", "in_progress", "completed", "failed"]);

// Memory tables
export const memories = pgTable("memories", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: memoryTypeEnum("type").notNull(),
  content: text("content").notNull(),
  importance: integer("importance").default(5).notNull(), // 1-10
  confidence: numeric("confidence", { precision: 3, scale: 2 }).default("1.00"), // 0.00-1.00
  source: text("source"), // where this memory came from
  tags: text("tags").array().default(sql`ARRAY[]::text[]`),
  relatedMemoriesIds: uuid("related_memories_ids").array().default(sql`ARRAY[]::uuid[]`),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow(),
  lastAccessedAt: timestamp("last_accessed_at").defaultNow(),
  metadata: jsonb("metadata"), // flexible additional data
}, (table) => ({
  typeIdx: index("memories_type_idx").on(table.type),
  importanceIdx: index("memories_importance_idx").on(table.importance),
  expiresIdx: index("memories_expires_idx").on(table.expiresAt),
}));

// Task management
export const tasks = pgTable("tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  status: taskStatusEnum("status").default("created"),
  userInput: text("user_input").notNull(),
  decomposition: jsonb("decomposition"), // structured task breakdown
  result: jsonb("result"), // final structured result
  confidence: numeric("confidence", { precision: 3, scale: 2 }).default("0.00"),
  verificationStatus: verificationStatusEnum("verification_status").default("unverified"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  metadata: jsonb("metadata"),
}, (table) => ({
  statusIdx: index("tasks_status_idx").on(table.status),
  createdIdx: index("tasks_created_idx").on(table.createdAt),
}));

// Agent runs
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").references(() => tasks.id),
  agentName: varchar("agent_name", { length: 255 }).notNull(), // researcher, reasoner, critic, etc
  role: text("role").notNull(), // description of agent's responsibility
  status: agentStatusEnum("status").default("pending"),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  modelProvider: varchar("model_provider", { length: 255 }).notNull(), // claude, local-model, etc
  modelName: varchar("model_name", { length: 255 }).notNull(),
  confidence: numeric("confidence", { precision: 3, scale: 2 }).default("0.00"),
  verificationStatus: verificationStatusEnum("verification_status").default("unverified"),
  tokensUsed: integer("tokens_used"),
  durationMs: integer("duration_ms"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  metadata: jsonb("metadata"),
}, (table) => ({
  taskIdx: index("agent_runs_task_idx").on(table.taskId),
  agentIdx: index("agent_runs_agent_idx").on(table.agentName),
  statusIdx: index("agent_runs_status_idx").on(table.status),
}));

// Verification results
export const verificationRuns = pgTable("verification_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").references(() => tasks.id),
  agentRunId: uuid("agent_run_id").references(() => agentRuns.id),
  verifier: varchar("verifier", { length: 255 }).notNull(), // fact-checker, tester, etc
  claim: text("claim").notNull(),
  evidence: text("evidence").array().default(sql`ARRAY[]::text[]`),
  verdict: verificationStatusEnum("verdict").notNull(),
  confidence: numeric("confidence", { precision: 3, scale: 2 }).default("0.00"),
  contradictions: text("contradictions").array().default(sql`ARRAY[]::text[]`),
  createdAt: timestamp("created_at").defaultNow(),
  metadata: jsonb("metadata"),
}, (table) => ({
  taskIdx: index("verification_runs_task_idx").on(table.taskId),
  agentIdx: index("verification_runs_agent_idx").on(table.agentRunId),
}));

// Audit trail
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  actor: varchar("actor", { length: 255 }).notNull(), // system, user, agent name
  action: varchar("action", { length: 255 }).notNull(), // created, verified, failed, etc
  resource: varchar("resource", { length: 255 }).notNull(), // memory, task, agent_run, etc
  resourceId: uuid("resource_id"),
  input: jsonb("input"),
  result: jsonb("result"),
  statusCode: integer("status_code"), // success/error code
  message: text("message"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  actorIdx: index("audit_events_actor_idx").on(table.actor),
  actionIdx: index("audit_events_action_idx").on(table.action),
  resourceIdx: index("audit_events_resource_idx").on(table.resource),
  createdIdx: index("audit_events_created_idx").on(table.createdAt),
}));

// User context / preferences
export const userContext = pgTable("user_context", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: varchar("key", { length: 255 }).unique().notNull(),
  value: jsonb("value").notNull(),
  importance: integer("importance").default(5),
  updatedAt: timestamp("updated_at").defaultNow(),
  metadata: jsonb("metadata"),
});

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
export type VerificationRun = typeof verificationRuns.$inferSelect;
export type NewVerificationRun = typeof verificationRuns.$inferInsert;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
