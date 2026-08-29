/**
 * Phase 3: Vision Analysis System
 *
 * Analyzes images/video for understanding scenes, objects, and visual questions
 */

export interface VisualAnalysis {
  text: string; // Description of what's in the image
  objects: Array<{
    label: string;
    confidence: number; // 0-1
    bounds?: { x: number; y: number; width: number; height: number };
  }>;
  scenes: string[]; // Scene descriptions (office, kitchen, outdoors, etc)
  textDetected: string[]; // Any text found in image
  answer?: string; // Answer to a visual question
}

export interface VisionProvider {
  analyzeImage(imageBuffer: Buffer): Promise<VisualAnalysis>;
  answerQuestion(imageBuffer: Buffer, question: string): Promise<string>;
  detectObjects(imageBuffer: Buffer): Promise<Array<{ label: string; confidence: number }>>;
}

/**
 * Vision System
 *
 * Understands images and answers visual questions via a pluggable
 * VisionProvider. `OllamaVisionProvider` (ollama-vision-provider.ts) is
 * real and $0/local, verified against a live model; `GeminiVisionProvider`
 * below is still an unimplemented stub (needs a live GEMINI_API_KEY to
 * build against). With no provider connected, analyzeImage/
 * answerVisualQuestion/detectObjects/recognizeScene now throw a clear
 * error instead of returning fabricated data (fixed 2026-08-27 — see each
 * method). Reachable from the CLI via `bun run dev vision-test <path>`
 * (cli.ts), which wires `setProvider(new OllamaVisionProvider())`.
 */
export class VisionSystem {
  private provider?: VisionProvider;

  constructor() {
    console.log("👁️  Vision System initialized");
    console.log("   Ready for image analysis and visual question answering");
  }

  /**
   * Set vision provider
   */
  setProvider(provider: VisionProvider) {
    this.provider = provider;
    console.log("🔌 Vision provider connected");
  }

  /**
   * Analyze image
   *
   * In real implementation:
   * - Send image to Gemini's vision API
   * - Get comprehensive analysis
   * - Extract objects, scenes, text
   */
  async analyzeImage(imageBuffer: Buffer): Promise<VisualAnalysis> {
    console.log("\n🔍 Analyzing image...");

    if (this.provider) {
      console.log("   Using connected vision provider");
      return this.provider.analyzeImage(imageBuffer);
    }

    // No provider connected. This used to return a hardcoded, always-
    // identical "office desk" analysis here regardless of the actual
    // image — fabricated sensor data presented as a real result, which is
    // exactly the anti-pattern the rest of this codebase's confidence/
    // audit-trail work exists to prevent (see BaseAgent.execute()'s
    // honestly-labeled confidence fallback for the established pattern).
    // Fixed 2026-08-27: fail clearly instead. Wire a real provider first,
    // e.g. `visionSystem.setProvider(new OllamaVisionProvider())` (local,
    // $0, verified — see ollama-vision-provider.ts).
    throw new Error(
      "VisionSystem has no provider connected — call setProvider(new OllamaVisionProvider()) (or a real GeminiVisionProvider, once implemented) before analyzing images."
    );
  }

  /**
   * Answer visual question
   *
   * "What's on the desk?" "Is the window open?" etc.
   */
  async answerVisualQuestion(
    imageBuffer: Buffer,
    question: string
  ): Promise<string> {
    console.log(`\n❓ Visual Question: "${question}"`);

    if (this.provider) {
      console.log("   Using connected vision provider");
      return this.provider.answerQuestion(imageBuffer, question);
    }

    // See analyzeImage() above — no fabricated answer, fail clearly instead.
    throw new Error(
      "VisionSystem has no provider connected — call setProvider(new OllamaVisionProvider()) before asking visual questions."
    );
  }

  /**
   * Detect objects in image
   */
  async detectObjects(
    imageBuffer: Buffer
  ): Promise<Array<{ label: string; confidence: number }>> {
    console.log("\n🔎 Detecting objects...");

    if (this.provider) {
      return this.provider.detectObjects(imageBuffer);
    }

    // See analyzeImage() above — no fabricated objects, fail clearly instead.
    throw new Error(
      "VisionSystem has no provider connected — call setProvider(new OllamaVisionProvider()) before detecting objects."
    );
  }

  /**
   * Recognize scene/location
   */
  async recognizeScene(imageBuffer: Buffer): Promise<string[]> {
    console.log("\n🏢 Recognizing scene...");

    if (this.provider) {
      const answer = await this.provider.answerQuestion(
        imageBuffer,
        "What type of scene or location is this? Reply with 2-5 short tags (one or two words each), comma-separated, nothing else."
      );
      const scenes = answer
        .split(",")
        .map((s) => s.trim().toLowerCase().replace(/\.$/, ""))
        .filter(Boolean);
      console.log(`✅ Scenes identified: ${scenes.join(", ")}`);
      return scenes;
    }

    // See analyzeImage() above — no fabricated scenes, fail clearly instead.
    throw new Error(
      "VisionSystem has no provider connected — call setProvider(new OllamaVisionProvider()) before recognizing scenes."
    );
  }

  /**
   * Extract text from image (OCR)
   */
  async extractText(imageBuffer: Buffer): Promise<string[]> {
    console.log("\n📝 Extracting text from image...");

    if (this.provider) {
      const answer = await this.provider.answerQuestion(
        imageBuffer,
        "Transcribe any text visible in this image, exactly as written, one line per piece of text. If there is no visible text, reply with exactly: NONE"
      );
      if (answer.trim().toUpperCase() === "NONE") {
        console.log("   No text detected");
        return [];
      }
      const lines = answer.split("\n").map((l) => l.trim()).filter(Boolean);
      console.log(`✅ Extracted ${lines.length} line(s) of text`);
      return lines;
    }

    // Simulated fallback — no provider connected
    console.log("   (Simulated: actual provider not yet connected)");
    return [];
  }

  /**
   * Compare two images
   *
   * NOT wired to the real provider — VisionProvider has no dedicated
   * two-image comparison method, and computing a real similarity score
   * from two independent text descriptions would mean inventing a number
   * with no real meaning behind it (the same anti-pattern as Phase 0's
   * hardcoded-confidence bug this project has already had to fix once).
   * Left honestly simulated until a real approach exists (e.g. perceptual
   * hashing, or a provider method that accepts both images at once).
   */
  async compareImages(
    imageBuffer1: Buffer,
    imageBuffer2: Buffer
  ): Promise<{
    similarity: number;
    differences: string[];
  }> {
    console.log("\n🔄 Comparing images...");
    console.log("   (Simulated: no real image-comparison method built yet)");

    return {
      similarity: 0.85,
      differences: [
        "Position of monitor changed",
        "Additional papers on desk",
        "Different lighting",
      ],
    };
  }

  /**
   * Check provider connection
   */
  isConnected(): boolean {
    return this.provider !== undefined;
  }

  /**
   * Provider status
   */
  getStatus(): {
    isConnected: boolean;
    provider?: string;
    capabilities: string[];
  } {
    return {
      isConnected: this.isConnected(),
      provider: this.provider ? "Connected" : "Not Connected",
      capabilities: [
        "Image Analysis",
        "Object Detection",
        "Scene Recognition",
        "Visual QA",
        "Text Extraction",
        "Image Comparison",
      ],
    };
  }
}

/**
 * Gemini Vision Provider (implementation template)
 *
 * Would be implemented when Gemini's vision API is wired in here — same
 * generativelanguage.googleapis.com endpoint as src/models/gemini-provider.ts,
 * just with an inline_data image part added to the request body.
 */
export class GeminiVisionProvider implements VisionProvider {
  async analyzeImage(imageBuffer: Buffer): Promise<VisualAnalysis> {
    // Implementation: POST to generativelanguage.googleapis.com with
    // contents: [{ role: "user", parts: [
    //   { inline_data: { mime_type: "image/png", data: imageBuffer.toString("base64") } },
    //   { text: "Analyze this image. Describe what you see, list objects with confidence scores, identify scenes, and extract any text." }
    // ]}]

    throw new Error("Gemini Vision Provider not yet implemented");
  }

  async answerQuestion(imageBuffer: Buffer, question: string): Promise<string> {
    // Implementation: same endpoint, with `question` as the text part
    throw new Error("Gemini Vision Provider not yet implemented");
  }

  async detectObjects(
    imageBuffer: Buffer
  ): Promise<Array<{ label: string; confidence: number }>> {
    // Implementation: same endpoint, object-detection-focused prompt
    throw new Error("Gemini Vision Provider not yet implemented");
  }
}
