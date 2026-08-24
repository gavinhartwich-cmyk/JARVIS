import { getDatabase } from "../db/client";
import { auditEvents } from "../db/schema";
import { v4 as uuid } from "uuid";

export interface AuditEventInput {
  actor: string;
  action: string;
  resource: string;
  resourceId?: string;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
  statusCode?: number;
  message?: string;
}

export async function logAuditEvent(event: AuditEventInput) {
  try {
    const db = getDatabase();
    await db.insert(auditEvents).values({
      id: uuid(),
      actor: event.actor,
      action: event.action,
      resource: event.resource,
      resourceId: event.resourceId,
      input: event.input,
      result: event.result,
      statusCode: event.statusCode,
      message: event.message,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error("Failed to log audit event:", error);
    // Don't throw - audit failures should not block operations
  }
}
