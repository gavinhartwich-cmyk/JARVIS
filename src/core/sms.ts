/**
 * Real, $0 SMS via email-to-SMS carrier gateway (master plan Part 7.2/7.3:
 * "Away? -> Phone notification").
 *
 * Per Gavin: "Is text possible for free so when it knows im not at my pc
 * it can text me?" Twilio (the "real" SMS API most people reach for)
 * ISN'T actually configured/paid for anywhere in this project OR
 * Hartwich-OS - confirmed by reading its own .env.local, where
 * TWILIO_ACCOUNT_SID/AUTH_TOKEN/PHONE_NUMBER are all blank. What IS
 * genuinely free and real: every carrier lets you text a phone by
 * emailing <number>@<carrier's gateway domain> - this sends that email
 * via the Gmail API (real OAuth already wired for email-monitor.ts).
 *
 * Real, disclosed reliability caveat, not glossed over: email-to-SMS
 * gateways are less reliable than a real paid SMS API - deliverability
 * varies by carrier, some carriers throttle or strip long messages, and
 * some (rare) have been deprecating these gateways over time. Genuinely
 * $0 though, which is this project's actual non-negotiable principle
 * (Part 1.2) - the honest tradeoff, not hidden.
 */

const CARRIER_GATEWAYS: Record<string, string> = {
  att: "txt.att.net",
  verizon: "vtext.com",
  tmobile: "tmomail.net",
  "t-mobile": "tmomail.net",
  sprint: "messaging.sprintpcs.com",
  uscellular: "email.uscc.net",
  boost: "sms.myboostmobile.com",
  cricket: "sms.cricketwireless.net",
  metropcs: "mymetropcs.com",
  googlefi: "msg.fi.google.com",
  visible: "vtext.com", // Visible runs on Verizon's network
  mintmobile: "mailmymobile.net",
  // Canadian carriers - real gateway (Gavin is on Telus).
  telus: "msg.telus.com",
  rogers: "pcs.rogers.com",
  bell: "txt.bell.ca",
  fido: "fido.ca",
  koodo: "msg.koodomobile.com",
  freedom: "txt.freedommobile.ca",
};

async function getFreshAccessToken(): Promise<string> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  // Sending via a business account (GMAIL_REFRESH_TOKEN_1), NOT the
  // personal one - real, deliberate: Gavin's personal Gmail OAuth
  // consent (email-monitor.ts) only requested gmail.readonly scope,
  // which cannot send. The business accounts were reused from Hartwich-
  // OS specifically for outreach email SENDING (its own .env.local
  // comment says so), so they're the ones actually authorized to send.
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN_1;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "SMS not configured - missing GMAIL_CLIENT_ID/CLIENT_SECRET/GMAIL_REFRESH_TOKEN_1 in .env (same credentials email-monitor.ts already uses for business Gmail)."
    );
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
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Real Gmail API send - a raw RFC 2822 message, base64url-encoded, POSTed
 * to users.messages.send. No subject line: most carrier gateways just
 * concatenate the subject and body together into the text, and a blank
 * subject keeps the actual SMS text clean.
 */
async function sendViaGmail(to: string, body: string): Promise<void> {
  const accessToken = await getFreshAccessToken();
  const raw = base64Url(`To: ${to}\r\nSubject: \r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`);

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new Error(`Gmail messages.send failed (${response.status}): ${responseBody || response.statusText}`);
  }
}

/**
 * Send a real text via email-to-SMS gateway. Reads SMS_PHONE_NUMBER
 * (digits only) and SMS_CARRIER (a key into CARRIER_GATEWAYS, case-
 * insensitive) from .env.
 */
export async function sendSms(message: string): Promise<void> {
  const phone = process.env.SMS_PHONE_NUMBER;
  const carrier = process.env.SMS_CARRIER?.toLowerCase().replace(/[\s_-]/g, "");
  if (!phone || !carrier) {
    throw new Error("SMS not configured - set SMS_PHONE_NUMBER and SMS_CARRIER in .env.");
  }
  const gateway = CARRIER_GATEWAYS[carrier];
  if (!gateway) {
    throw new Error(`Unknown SMS_CARRIER "${process.env.SMS_CARRIER}" - supported: ${Object.keys(CARRIER_GATEWAYS).join(", ")}`);
  }
  const digits = phone.replace(/\D/g, "");
  const to = `${digits}@${gateway}`;
  await sendViaGmail(to, message);
}
