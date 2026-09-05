/**
 * Real screen-vision-guided clicking - per Gavin, directly: "this is
 * where screen vision and mouse control come in and where he goes form
 * assistant to jarvis," after `click_element`'s real, disclosed limit
 * came up live (it matches by accessible NAME via UI Automation - it
 * cannot click something identified only by visual description, like
 * "the video with the guy in the red shirt").
 *
 * [REAL, DISCLOSED RISK] This project already tried vision-guided
 * clicking once (thirty-second pass, moondream) and rejected it as a
 * real misclick risk - moondream's own coordinate/position answers were
 * confirmed unreliable via direct testing. This is a deliberate,
 * different attempt with a materially stronger model (Gemini, not a
 * small local one), not a retry of the same rejected approach - but the
 * underlying risk (clicking the wrong thing) is real and not eliminated,
 * only reduced. Per Gavin's explicit choice ("build it now with Gemini's
 * vision," not the confirm-before-click option also offered), this
 * clicks directly rather than gating on a spoken confirmation - real
 * coordinate logging on every use is the actual safety net here, so a
 * wrong click is at least immediately diagnosable from the console, not
 * silent.
 *
 * Real mechanism: a real screenshot (phase3/screen-capture.ts) is sent
 * to Gemini's real generateContent API (multimodal - inline image +
 * text, same REST endpoint models/gemini-provider.ts already calls, no
 * SDK) asking for a click point in Gemini's own documented normalized
 * 0-1000 coordinate space (the format Gemini's vision models are
 * actually trained to output for spatial grounding, not a raw pixel
 * guess) - scaled to the real screenshot's actual width/height, then
 * clicked via windowsController's real SendInput-based click(x, y).
 */

import { ScreenCapture } from "../phase3/screen-capture";
import { windowsController } from "../phase3/windows-control";

const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || "gemini-3.6-flash";

export interface VisionClickResult {
  success: boolean;
  x?: number;
  y?: number;
  label?: string;
  error?: string;
}

interface GroundingResponse {
  found: boolean;
  x?: number;
  y?: number;
  label?: string;
  reason?: string;
}

/**
 * Asks Gemini to locate `description` in `screenshotPng` and return a
 * normalized (0-1000) click point. Returns null on any failure - a
 * missing key, a network error, a malformed response, or Gemini itself
 * reporting it couldn't find a confident match (deliberately NOT a
 * fabricated guess - see the JSON schema's own "found" field).
 */
async function locate(description: string, screenshotPng: Buffer): Promise<GroundingResponse | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ Vision-click: GEMINI_API_KEY not set.");
    return null;
  }

  const prompt =
    `Find this on the screen: "${description}"\n\n` +
    "Respond with ONLY a single raw JSON object, no other text, no markdown fences, matching exactly:\n" +
    '{"found": boolean, "x": number, "y": number, "label": string, "reason": string}\n\n' +
    "x and y are the CENTER of the element, in a normalized 0-1000 coordinate space where (0,0) is the " +
    "top-left corner of the image and (1000,1000) is the bottom-right corner - NOT raw pixels. " +
    "\"label\" is a short real description of what you're actually clicking (so a human can sanity-check " +
    "it). Keep \"label\" and \"reason\" each under 10 words - be brief so the whole response fits well " +
    "within the token budget. Set found to false and omit x/y if you are not genuinely confident you've " +
    "found the right thing - a false \"found: true\" risks a real, physical misclick, which is worse than " +
    "honestly saying you couldn't find it.";

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                { inlineData: { mimeType: "image/png", data: screenshotPng.toString("base64") } },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            // [FIXED 2026-09-05] Real bug found live: "Vision-click: request
            // failed: JSON Parse error: Expected '}'" - a truncated response,
            // not a malformed one. 300 tokens (this codebase's own established
            // floor for gemini-3.6-flash, a "thinking" model - see
            // gemini-provider.ts's GEMINI_MIN_OUTPUT_TOKENS) was tight enough
            // here that the model's own JSON output itself got cut off
            // mid-string before the closing brace, on top of whatever
            // invisible reasoning tokens thinkingLevel "low" still consumes.
            // Raised well above that floor - this call's real output is a
            // handful of short fields, not a floor case.
            maxOutputTokens: 600,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(`❌ Vision-click: Gemini API error ${response.status} - ${errText.slice(0, 300)}`);
      return null;
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!rawText) {
      console.error("❌ Vision-click: Gemini returned no text (empty or blocked response).");
      return null;
    }

    // [ADDED 2026-09-05] Real bug found live: a bare JSON.parse(rawText)
    // threw "JSON Parse error: Expected '}'" with no visibility into WHY -
    // turned out to be maxOutputTokens truncating the response mid-string
    // (see the real fix on maxOutputTokens above). Raising the budget is
    // the actual fix, but this stays as a second, honest line of defense:
    // if a response is ever cut short again (a genuinely huge screen
    // description, a future model behaving differently), log the real raw
    // text that failed to parse instead of just the parser's generic
    // complaint, so a future occurrence is diagnosable from one log line
    // instead of needing a repro session like this one did.
    try {
      return JSON.parse(rawText) as GroundingResponse;
    } catch (parseError) {
      console.error(
        `❌ Vision-click: Gemini's response wasn't valid JSON (${parseError instanceof Error ? parseError.message : parseError}). ` +
          `Raw response (${rawText.length} chars): ${rawText.slice(0, 500)}${rawText.length > 500 ? "…" : ""}`
      );
      return null;
    }
  } catch (error) {
    console.error("❌ Vision-click: request failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function clickByDescription(description: string): Promise<VisionClickResult> {
  const capture = new ScreenCapture();
  const screenshot = await capture.captureScreen();

  const grounding = await locate(description, screenshot.data);
  if (!grounding) {
    return { success: false, error: "Vision lookup failed - couldn't reach or parse a response from the vision model." };
  }
  if (!grounding.found || typeof grounding.x !== "number" || typeof grounding.y !== "number") {
    return { success: false, error: `Couldn't confidently locate "${description}" on screen${grounding.reason ? `: ${grounding.reason}` : "."}` };
  }

  // Scale from Gemini's documented 0-1000 normalized space to real pixel
  // coordinates, then clamp to the real screenshot bounds as a last-resort
  // safety net against a malformed/out-of-range response.
  const x = Math.max(0, Math.min(screenshot.width - 1, Math.round((grounding.x / 1000) * screenshot.width)));
  const y = Math.max(0, Math.min(screenshot.height - 1, Math.round((grounding.y / 1000) * screenshot.height)));

  console.log(`   👁️  Vision-click: "${description}" -> "${grounding.label ?? description}" at (${x}, ${y})`);
  await windowsController.click(x, y);

  return { success: true, x, y, label: grounding.label };
}
