import { pgTable, text, uuid, timestamp, jsonb, integer, varchar, pgEnum, numeric, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Enums
export const memoryTypeEnum = pgEnum("memory_type", ["fact", "episode", "semantic", "preference", "project", "goal", "relationship", "event"]);
export const verificationStatusEnum = pgEnum("verification_status", ["unverified", "partially_verified", "verified", "conflicted", "failed"]);
export const agentStatusEnum = pgEnum("agent_status", ["pending", "running", "completed", "failed", "cancelled"]);
export const taskStatusEnum = pgEnum("task_status", ["created", "decomposed", "in_progress", "completed", "failed"]);
export const deviceTypeEnum = pgEnum("device_type", ["pc", "phone", "wearable", "other"]);
export const presenceStateEnum = pgEnum("presence_state", ["active", "idle", "away", "unknown"]);
export const authLevelEnum = pgEnum("auth_level", ["unknown", "recognized", "gavin", "verified"]);

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
  modelProvider: varchar("model_provider", { length: 255 }).notNull(), // gemini, ollama, etc
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

// Presence & Device Awareness (master plan Part 3.1)
export const devices = pgTable("devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  type: deviceTypeEnum("type").notNull(),
  capabilities: text("capabilities").array().default(sql`ARRAY[]::text[]`), // e.g. "voice", "screen", "notification"
  presenceState: presenceStateEnum("presence_state").default("unknown"),
  lastSeenAt: timestamp("last_seen_at"),
  registeredAt: timestamp("registered_at").defaultNow(),
  metadata: jsonb("metadata"),
}, (table) => ({
  typeIdx: index("devices_type_idx").on(table.type),
  nameIdx: index("devices_name_idx").on(table.name),
}));

export const presenceEvents = pgTable("presence_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").references(() => devices.id).notNull(),
  state: presenceStateEnum("state").notNull(),
  source: varchar("source", { length: 255 }).notNull(), // heartbeat, explicit_command, activity_detected, timeout
  createdAt: timestamp("created_at").defaultNow(),
  metadata: jsonb("metadata"),
}, (table) => ({
  deviceIdx: index("presence_events_device_idx").on(table.deviceId),
  createdIdx: index("presence_events_created_idx").on(table.createdAt),
}));

// Identity Recognition (master plan Part 3.2)
// Confidence is tracked here and is explicitly NOT the same as authorization level.
export const identitySessions = pgTable("identity_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").references(() => devices.id),
  claimedIdentity: varchar("claimed_identity", { length: 255 }).notNull().default("gavin"),
  signal: varchar("signal", { length: 255 }).notNull(), // device_session, pin, face (future), voice (future)
  confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(), // 0.00-1.00
  resolvedAs: varchar("resolved_as", { length: 255 }).notNull(), // unknown, recognized, gavin
  createdAt: timestamp("created_at").defaultNow(),
  metadata: jsonb("metadata"),
}, (table) => ({
  deviceIdx: index("identity_sessions_device_idx").on(table.deviceId),
  createdIdx: index("identity_sessions_created_idx").on(table.createdAt),
}));

// Authorization Engine (master plan Part 3.3) — every permission check is audited here,
// independent of the general audit_events log, so authorization decisions can be
// queried/reviewed on their own.
export const authorizationDecisions = pgTable("authorization_decisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  identitySessionId: uuid("identity_session_id").references(() => identitySessions.id),
  level: authLevelEnum("level").notNull(),
  action: varchar("action", { length: 255 }).notNull(),
  riskTier: varchar("risk_tier", { length: 50 }).notNull(), // low, medium, high, admin
  requiredLevel: authLevelEnum("required_level").notNull(),
  decision: varchar("decision", { length: 50 }).notNull(), // allowed, denied, needs_verification
  verificationMethod: varchar("verification_method", { length: 100 }), // pin, none
  createdAt: timestamp("created_at").defaultNow(),
  metadata: jsonb("metadata"),
}, (table) => ({
  decisionIdx: index("authorization_decisions_decision_idx").on(table.decision),
  createdIdx: index("authorization_decisions_created_idx").on(table.createdAt),
}));

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
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type PresenceEvent = typeof presenceEvents.$inferSelect;
export type NewPresenceEvent = typeof presenceEvents.$inferInsert;
export type IdentitySession = typeof identitySessions.$inferSelect;
export type NewIdentitySession = typeof identitySessions.$inferInsert;
export type AuthorizationDecision = typeof authorizationDecisions.$inferSelect;
export type NewAuthorizationDecision = typeof authorizationDecisions.$inferInsert;
