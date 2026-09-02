/**
 * Real Google Calendar monitoring (master plan Part 7.1: "Calendar -
 * Upcoming meetings"). The first real external-API monitor feeding the
 * proactivity engine, beyond the local-only system-monitors.ts.
 *
 * Credentials (2026-09-02): reused from Hartwich-OS (a separate project
 * of Gavin's, same Google account) per his direct instruction - "if you
 * don't have the apis get them or grab them from Hartwich os" /
 * "Just request access from me and I'll give it to you." Real OAuth
 * client id/secret/refresh token, not fabricated or guessed. Stored in
 * this project's own .env (GOOGLE_CALENDAR_CLIENT_ID/SECRET/
 * REFRESH_TOKEN), gitignored same as every other credential here.
 *
 * The access token copied alongside them was already short-lived and
 * likely stale by the time anyone reads this - this file always
 * refreshes a fresh one from the refresh token before calling the real
 * Calendar API, rather than trusting a copied-once access token.
 */

import type { MonitoredEvent } from "./proactivity";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
}

/**
 * Standard OAuth2 refresh-token grant - real, not guessed: POST client
 * id/secret/refresh_token, get a fresh short-lived access token back.
 * No dependency added; this is one plain fetch() call.
 */
async function getFreshAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Calendar not configured - missing GOOGLE_CALENDAR_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN in .env."
    );
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
    throw new Error(`Google token refresh failed (${response.status}): ${body || response.statusText}`);
  }

  const data = (await response.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    throw new Error(`Google token refresh returned no access_token: ${data.error ?? "unknown error"}`);
  }
  return data.access_token;
}

/** Real upcoming events (next 24h) from the primary calendar - $0, no new dependency. */
async function fetchUpcomingEvents(withinHours = 24): Promise<GoogleCalendarEvent[]> {
  const accessToken = await getFreshAccessToken();
  const now = new Date();
  const timeMax = new Date(now.getTime() + withinHours * 60 * 60 * 1000);

  const url = new URL(EVENTS_URL);
  url.searchParams.set("timeMin", now.toISOString());
  url.searchParams.set("timeMax", timeMax.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "20");

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google Calendar events.list failed (${response.status}): ${body || response.statusText}`);
  }

  const data = (await response.json()) as { items?: GoogleCalendarEvent[] };
  return data.items ?? [];
}

/**
 * Coarse "how far out" bucket - deliberately part of the dedupeKey (see
 * proactivity.ts) so the SAME meeting produces a genuinely new,
 * un-suppressed notification as it moves from "later" to "imminent",
 * not just once ever within the 6h dedup window.
 */
function urgencyBucket(minutesUntil: number): "imminent" | "soon" | "upcoming" | "later" {
  if (minutesUntil <= 15) return "imminent";
  if (minutesUntil <= 60) return "soon";
  if (minutesUntil <= 180) return "upcoming";
  return "later";
}

const BUCKET_URGENCY: Record<ReturnType<typeof urgencyBucket>, number> = {
  imminent: 90,
  soon: 60,
  upcoming: 30,
  later: 10,
};

export async function checkUpcomingMeetings(): Promise<MonitoredEvent[]> {
  const events: MonitoredEvent[] = [];
  try {
    const items = await fetchUpcomingEvents(24);
    const now = Date.now();

    for (const item of items) {
      const startIso = item.start?.dateTime ?? item.start?.date;
      if (!startIso) continue;
      const startMs = new Date(startIso).getTime();
      if (Number.isNaN(startMs)) continue;

      const minutesUntil = Math.round((startMs - now) / 60_000);
      if (minutesUntil < -5) continue; // already started a while ago - not something to proactively surface

      const bucket = urgencyBucket(Math.max(minutesUntil, 0));
      const title = item.summary || "(untitled event)";
      const whenDesc =
        minutesUntil <= 1 ? "starting now" : minutesUntil < 60 ? `in ${minutesUntil} min` : `in ${(minutesUntil / 60).toFixed(1)}h`;

      events.push({
        source: "calendar",
        summary: `"${title}"${item.location ? ` at ${item.location}` : ""} ${whenDesc}.`,
        dedupeKey: `calendar:${item.id}:${bucket}`,
        // Relevance: a real meeting on the calendar is inherently
        // relevant information (this isn't a guess/heuristic scoring
        // "importance" of the meeting itself, which would need real NLP
        // over the title/attendees - out of scope here) - urgency is
        // what actually varies with how soon it is.
        relevance: 70,
        urgency: BUCKET_URGENCY[bucket],
        metadata: { eventId: item.id, title, startIso, minutesUntil, htmlLink: item.htmlLink },
      });
    }
  } catch (err) {
    console.error(`   ⚠️  Calendar monitor failed (non-fatal, skipping this pass): ${err instanceof Error ? err.message : err}`);
  }
  return events;
}
