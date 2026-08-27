import { VisionProvider, VisualAnalysis } from "./vision-system";

/**
 * Ollama vision provider — talks to a real local vision model (default:
 * `moondream`, ~1.7GB, CPU-friendly) via Ollama's `/api/generate`, no API
 * key, genuinely $0. Same "$0-first, local-capable" pattern as
 * `models/ollama-provider.ts`.
 *
 * Verified live (2026-08-26) against a real generated test image (a red
 * circle + blue square on white): asked to describe it, the model
 * correctly named both shapes and both colors — not a hardcoded response.
 * Inference is slow on CPU (~145s for that single call) — fine for a
 * request/response tool call, not for anything real-time.
 *
 * Honest limitation: `moondream` is a small captioning/VQA model, not a
 * calibrated object detector — it has no notion of a real confidence
 * score or bounding box. `detectObjects()` below returns `confidence: 1.0`
 * for every parsed object as an explicit placeholder (NOT a real
 * calibrated score, unlike e.g. the wake-word detector's actual model
 * probabilities) so downstream code doesn't mistake this for the real
 * thing. Real per-object confidence/bounding boxes would need a
 * dedicated detection model or a real multimodal API (e.g. Gemini
 * Vision, once a live GEMINI_API_KEY exists) — not built here.
 */
export class OllamaVisionProvider implements VisionProvider {
  private host: string;
  private model: string;

  constructor(host?: string, model?: string) {
    this.host = (host || process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
    this.model = model || process.env.OLLAMA_VISION_MODEL || "moondream";
  }

  private async generate(imageBuffer: Buffer, prompt: string, timeoutMs = 240_000): Promise<string> {
    const response = await fetch(`${this.host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        images: [imageBuffer.toString("base64")],
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama vision request failed (${response.status}): ${body || response.statusText}. Is "${this.model}" pulled? Run: ollama pull ${this.model}`);
    }

    const data = (await response.json()) as { response?: string; error?: string };
    if (data.error) {
      throw new Error(`Ollama vision error: ${data.error}`);
    }
    return (data.response || "").trim();
  }

  async analyzeImage(imageBuffer: Buffer): Promise<VisualAnalysis> {
    const text = await this.generate(
      imageBuffer,
      "Describe this image in detail: what objects, colors, shapes, and scene/setting do you see?"
    );

    return {
      text,
      // Not populated: this model doesn't reliably produce structured,
      // bounded object lists — see class header comment. Left empty
      // rather than fabricated, unlike the description text above which
      // is a real model output.
      objects: [],
      scenes: [],
      textDetected: [],
    };
  }

  async answerQuestion(imageBuffer: Buffer, question: string): Promise<string> {
    return this.generate(imageBuffer, question);
  }

  async detectObjects(imageBuffer: Buffer): Promise<Array<{ label: string; confidence: number }>> {
    const text = await this.generate(
      imageBuffer,
      "List only the distinct physical objects visible in this image, one per line, no descriptions or punctuation."
    );

    const labels = text
      .split("\n")
      .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
      .filter((line) => line.length > 0 && line.length < 40);

    // confidence: 1.0 is an explicit placeholder, not a real score — see
    // class header comment.
    return labels.map((label) => ({ label, confidence: 1.0 }));
  }
}
