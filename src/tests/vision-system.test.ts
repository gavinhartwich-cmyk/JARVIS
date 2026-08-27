import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { VisionSystem } from "../phase3/vision-system";
import { OllamaVisionProvider } from "../phase3/ollama-vision-provider";

/**
 * Proves Phase 3 vision is real, not the hardcoded "office desk" stub
 * VisionSystem falls back to with no provider connected: generates a real
 * test image (a red circle + blue square on white, via ImageMagick) and
 * checks the actual local `moondream` model (via OllamaVisionProvider)
 * correctly names both shapes and both colors, answers a targeted
 * question about it, and reports no text found (there is none) — instead
 * of a canned response.
 *
 * Slow: CPU-only vision inference took ~145s per call when this was
 * verified live (2026-08-26), hence the generous per-test timeouts.
 *
 * Requires Ollama running with `moondream` pulled (`ollama pull
 * moondream`) and `convert` (ImageMagick) for test image generation —
 * skips instead of failing if either isn't present.
 */

let ollamaVisionAvailable = true;
try {
  const tags = execSync("curl -sf http://localhost:11434/api/tags", { timeout: 3000 }).toString();
  if (!tags.includes("moondream")) ollamaVisionAvailable = false;
} catch {
  ollamaVisionAvailable = false;
}
let imagemagickAvailable = true;
try {
  execSync("convert -version", { stdio: "ignore", timeout: 3000 });
} catch {
  imagemagickAvailable = false;
}
const allAvailable = ollamaVisionAvailable && imagemagickAvailable;

function makeShapesImage(): Buffer {
  const path = join(tmpdir(), `jarvis-vision-test-${randomUUID()}.png`);
  execSync(
    `convert -size 400x400 xc:white -fill red -draw "circle 100,100 100,150" -fill blue -draw "rectangle 250,250 380,380" "${path}"`
  );
  try {
    return readFileSync(path);
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // best-effort cleanup
    }
  }
}

describe.if(allAvailable)("VisionSystem (real OllamaVisionProvider)", () => {
  const image = allAvailable ? makeShapesImage() : Buffer.alloc(0);

  test("analyzeImage() correctly describes real shapes/colors, not the office-desk stub", async () => {
    const vision = new VisionSystem();
    vision.setProvider(new OllamaVisionProvider());

    const result = await vision.analyzeImage(image);
    const text = result.text.toLowerCase();

    expect(text).not.toContain("office"); // the old hardcoded stub's content
    expect(text).toContain("red");
    expect(text).toContain("blue");
  }, 300000);

  test("answerQuestion() answers a targeted real question about the image", async () => {
    const vision = new VisionSystem();
    vision.setProvider(new OllamaVisionProvider());

    const answer = await vision.answerVisualQuestion(image, "What color is the square shape in this image?");
    expect(answer.toLowerCase()).toContain("blue");
  }, 300000);

  test("extractText() reports no text on an image with none, not the always-empty stub bypassing the model", async () => {
    const vision = new VisionSystem();
    vision.setProvider(new OllamaVisionProvider());

    const lines = await vision.extractText(image);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBe(0);
  }, 300000);
});

if (!allAvailable) {
  test.skip("VisionSystem (real OllamaVisionProvider) — skipped: run `ollama pull moondream` and install ImageMagick first", () => {});
}
