/**
 * Real Gmail monitoring (master plan Part 7.1: "Email - important
 * messages, required follow-ups, overdue responses").
 *
 * Per Gavin: "He should watch both for business and personal." Business
 * accounts (3, reused from Hartwich-OS - a separate project of Gavin's,
 * same credential-reuse pattern and permission story as
 * calendar-monitor.ts) are wired in below and real. Personal Gmail needs
 * its own, separate OAuth consent - a different Google account than the
 * one the shared Hartwich-OS client already has a refresh token for, so
 * there's no existing token to reuse the way Calendar/business-Gmail
 * had. `personalAccount()` below reads GMAIL_PERSONAL_REFRESH_TOKEN/
 * GMAIL_PERSONAL_FROM_ADDRESS if they exist and simply contributes
 * nothing if they don't yet - real, disclosed gap, not a silent failure.
 *
 * Real, disclosed scope limitation: "relevant" here means "has unread
 * mail in the inbox," not true importance/follow-up classification -
 * that would need real NLP reading each message's actual content, out
 * of scope for a first real pass. Matches this project's established
 * pattern of not fabricating a smarter signal than what's actually
 * implemented (see ollama-vision-provider.ts's own honest confidence-
 * score disclaimer for the same principle applied elsewhere).
 */

import type { MonitoredEvent } from "./proactivity";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

interface GmailAccount {
  label: string;
  refreshToken: string;
}

function businessAccounts(): GmailAccount[] {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];

  const accounts: GmailAccount[] = [];
  for (let i = 1; i <= 3; i++) {
    const refreshToken = process.env[`GMAIL_REFRESH_TOKEN_${i}`];
    const fromAddress = process.env[`GMAIL_FROM_ADDRESS_${i}`];
    if (refreshToken && fromAddress) {
      accounts.push({ label: `business:${fromAddress}`, refreshToken });
    }
  }
  return accounts;
}

function personalAccount(): GmailAccount | null {
  const refreshToken = process.env.GMAIL_PERSONAL_REFRESH_TOKEN;
  const fromAddress = process.env.GMAIL_PERSONAL_FROM_ADDRESS;
  if (!refreshToken || !fromAddress) return null;
  return { label: `personal:${fromAddress}`, refreshToken };
}

async function getFreshAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Gmail not configured - missing GMAIL_CLIENT_ID/CLIENT_SECRET in .env.");
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gmail token refresh failed (${response.status}): ${body || response.statusText}`);
  }

  const data = (await response.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    throw new Error(`Gmail token refresh returned no access_token: ${data.error ?? "unknown error"}`);
  }
  return data.access_token;
}

interface GmailMessageMeta {
  id: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}

function headerValue(msg: GmailMessageMeta, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

async function fetchUnread(account: GmailAccount): Promise<{ count: number; subjects: string[] }> {
  const accessToken = await getFreshAccessToken(account.refreshToken);

  const listUrl = new URL(MESSAGES_URL);
  listUrl.searchParams.set("q", "is:unread in:inbox");
  listUrl.searchParams.set("maxResults", "5");

  const listRes = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!listRes.ok) {
    const body = await listRes.text().catch(() => "");
    throw new Error(`Gmail messages.list failed for ${account.label} (${listRes.status}): ${body || listRes.statusText}`);
  }
  const listData = (await listRes.json()) as { messages?: Array<{ id: string }>; resultSizeEstimate?: number };
  const ids = listData.messages ?? [];

  const subjects: string[] = [];
  for (const { id } of ids.slice(0, 3)) {
    const msgRes = await fetch(`${MESSAGES_URL}/${id}?format=metadata&metadataHeaders=Subject`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (msgRes.ok) {
      const msg = (await msgRes.json()) as GmailMessageMeta;
      const subject = headerValue(msg, "Subject");
      if (subject) subjects.push(subject);
    }
  }

  return { count: listData.resultSizeEstimate ?? ids.length, subjects };
}

export async function checkUnreadEmail(): Promise<MonitoredEvent[]> {
  const events: MonitoredEvent[] = [];
  const accounts = [...businessAccounts()];
  const personal = personalAccount();
  if (personal) accounts.push(personal);

  for (const account of accounts) {
    try {
      const { count, subjects } = await fetchUnread(account);
      if (count === 0) continue;

      events.push({
        source: "email",
        summary: `${count} unread email${count === 1 ? "" : "s"} in ${account.label}${subjects.length > 0 ? ` — most recent: "${subjects[0]}"` : ""}.`,
        // Count baked into the dedupeKey deliberately: a still-unchanged
        // unread count doesn't re-notify (real dedup), but a NEW unread
        // message bumping the total is a genuinely new condition and
        // should notify again, not be silently suppressed by the old
        // count's dedup record.
        dedupeKey: `email:${account.label}:${count}`,
        relevance: 50,
        urgency: 25,
        metadata: { account: account.label, unreadCount: count, subjects },
      });
    } catch (err) {
      console.error(`   ⚠️  Email monitor failed for ${account.label} (non-fatal, skipping): ${err instanceof Error ? err.message : err}`);
    }
  }
  return events;
}
