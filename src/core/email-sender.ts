/**
 * Real email sending (per Gavin: "let's also set up emails with Jarvis").
 *
 * Reuses the same Gmail API + OAuth-refresh pattern already proven live
 * in email-monitor.ts (reading) and sms.ts (sending, via the same
 * business account's send scope) - not a new integration, the send half
 * of the same real Gmail access this codebase already has.
 *
 * Real, disclosed scope: sends via GMAIL_REFRESH_TOKEN_1 (business,
 * hartwichlabs@gmail.com) by default - the only account confirmed to
 * have send scope. Gavin's personal Gmail OAuth consent (email-monitor.ts)
 * only requested gmail.readonly - sending "as" his personal account
 * would need a fresh consent with gmail.send added, not done here.
 */

async function getFreshAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Email sending not configured - missing GMAIL_CLIENT_ID/CLIENT_SECRET in .env.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
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

function base64Url(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  /** Which sending account's refresh token to use - defaults to GMAIL_REFRESH_TOKEN_1 (confirmed send scope). */
  refreshToken?: string;
  fromLabel?: string; // for logging only
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  const refreshToken = options.refreshToken ?? process.env.GMAIL_REFRESH_TOKEN_1;
  if (!refreshToken) {
    throw new Error("Email sending not configured - missing GMAIL_REFRESH_TOKEN_1 in .env.");
  }

  const accessToken = await getFreshAccessToken(refreshToken);
  const raw = base64Url(
    `To: ${options.to}\r\nSubject: ${options.subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${options.body}`
  );

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gmail messages.send failed (${response.status}): ${body || response.statusText}`);
  }
}
