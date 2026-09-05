import { describe, expect, test } from "bun:test";
import { clickByDescription } from "../core/vision-click";

/**
 * No live Gemini vision call in this suite (real testing tonight already
 * hit the free tier's 20/day cap twice - see gemini-provider.ts's own
 * history) - covers what's verifiable without one: the honest "can't
 * even try" failure path when no key is configured, matching the same
 * fail-clearly convention gemini-provider.ts/windows-control.ts already
 * use for their own unverified-without-live-access code paths. This
 * does still exercise a REAL screen capture (phase3/screen-capture.ts)
 * since clickByDescription() always captures before checking the key -
 * disclosed real limitation already documented elsewhere in this
 * project: a screenshot taken from this sandbox's own tool-execution
 * context can come back blank, which is fine for this test (it only
 * asserts the no-key failure surfaces cleanly, not what the image
 * contains).
 */
describe("clickByDescription — no live Gemini call", () => {
  test("fails cleanly with no GEMINI_API_KEY, instead of crashing or fabricating a click", async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const result = await clickByDescription("the submit button");
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey;
    }
  });
});
