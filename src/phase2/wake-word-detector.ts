/**
 * Phase 2: Wake Word Detection
 *
 * Detects when the user says "Jarvis" — anywhere in speech, not just the
 * literal phrase "hey Jarvis" — using a real local openWakeWord model
 * (via scripts/wakeword_detect_daemon.py — see ensureDaemonStarted()),
 * not a simulation.
 *
 * IMPORTANT CAVEAT: the underlying pretrained model ("hey_jarvis") was
 * only ever trained on the phrase "hey jarvis", not bare "jarvis". Real
 * measurements against Piper-synthesized clips (2026-08-26): unrelated
 * speech scores ~0.0001-0.0003 (noise floor); "hey jarvis" scores ~0.999;
 * bare "jarvis" scores 0.25-0.99 depending on sentence position and
 * cadence (higher near a pause/end-of-utterance, e.g. "jarvis, can you
 * help me" -> 0.997; lower when buried mid-sentence with no pause, e.g.
 * "...if jarvis knows the answer..." -> 0.003).
 *
 * [UPDATE 2026-08-30] That data was all from synthesized Piper clips
 * fed straight into the model, not a real mic. Real live scores from
 * Gavin's actual voice through his actual C920, talking at normal
 * volume, never got above 0.0175 across 12 samples - far below even the
 * old synthesized noise floor. voice-config.ts's default sensitivity is
 * now 0.05 (down from 0.15), paired with a new audio.micGain (4.0) in
 * mic_capture.py that boosts the raw signal before it reaches this
 * model at all, since a gap this large pointed at input level, not just
 * the trigger point. Both numbers are a real first attempt grounded in
 * Gavin's own data, not re-validated against synthesized clips - see
 * voice-config.ts's sensitivity comment for the full reasoning and what
 * to watch (the score log below, and mic_capture.py's new peak-level
 * log) if this still isn't right. This is NOT a 100% guarantee of
 * catching every utterance in every sentence position; the outlier case
 * above would need a dedicated custom-trained "jarvis" model
 * (openWakeWord supports this, but it's substantially more work than a
 * threshold tune — see jarvis-phase-1-developer memory for the full
 * data and the open decision on whether that's worth doing).
 *
 * [UPDATE 2026-08-31] Real, measured fix for "very delayed from the
 * wakeword to the listening mode" (Gavin, after trying to say "jarvis,
 * open notepad" as one sentence): the previous design spawned a brand
 * new Python subprocess per detection cycle, and on this project's own
 * venv that subprocess's own startup (numpy/openwakeword imports plus
 * Model() construction) measured ~1.1-1.5s EVERY cycle - on top of the
 * ~1s of audio it needed to buffer first. That's 2+ real seconds between
 * saying "jarvis" and detection completing, which eats directly into
 * whatever he says right after it, explaining the garbled/truncated
 * transcripts ("Drivers open Spotify", "Open no pad") from that same
 * live run. Fixed by switching to a single persistent daemon
 * (scripts/wakeword_detect_daemon.py) that loads the model exactly ONCE
 * per `listen` session and then scores real 80ms/1280-sample chunks as
 * they stream in over stdin - the one real unavoidable cost (model load)
 * is now paid once at startup, not per detection, and the buffering
 * window drops from ~1s to ~80ms. See ensureDaemonStarted()/
 * processAudioChunk() below.
 */

import { spawn, ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface WakeWordEvent {
  keyword: string;
  confidence: number; // 0-1
  timestamp: Date;
  audioChunk?: Buffer; // Raw audio data - a short rolling window of recent PCM for debugging, not the full utterance (see ROLLING_AUDIO_MAX_BYTES below)
}

export interface WakeWordDetectorConfig {
  keyword: string;
  sensitivity: number; // 0-1
  modelPath?: string;
  sampleRate: number;
  pythonPath?: string; // Path to the venv python with openwakeword installed
  scriptPath?: string; // Path to scripts/wakeword_detect_daemon.py
}

function resolveWakeWordPaths(config: { pythonPath?: string; scriptPath?: string }) {
  const pythonPath =
    config.pythonPath || process.env.WAKEWORD_PYTHON_PATH || "tools/whisper/venv/bin/python";
  // 2026-08-31: default repointed from the one-shot wakeword_detect.py to
  // the new persistent daemon - see this file's header comment. The
  // one-shot script still exists (src/tests/wake-word-detector.test.ts
  // and anyone passing WAKEWORD_SCRIPT_PATH explicitly can still use it),
  // it's just no longer what a caller gets by default.
  const scriptPath =
    config.scriptPath || process.env.WAKEWORD_SCRIPT_PATH || "scripts/wakeword_detect_daemon.py";
  return { pythonPath, scriptPath };
}

// How much recent raw PCM to keep around purely for WakeWordEvent's
// optional audioChunk field (debugging use, not consumed by any real
// code path today - see the interface comment above). 1s at 16kHz
// 16-bit mono.
const ROLLING_AUDIO_MAX_BYTES = 16000 * 2;

interface DaemonScoreLine {
  score?: number;
  ready?: boolean;
  model?: string;
  error?: string;
}

/**
 * Wake Word Detector
 *
 * Listens to audio stream and detects when user says the wake word.
 * Uses local models (openWakeWord) for privacy.
 */
export class WakeWordDetector {
  private keyword: string;
  private sensitivity: number;
  private modelPath: string;
  private sampleRate: number;
  private pythonPath: string;
  private scriptPath: string;
  private isListening: boolean = false;

  // Persistent daemon process state (2026-08-31) - see this file's header
  // comment for why this replaced a per-cycle subprocess spawn.
  private daemonProc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private daemonReady: Promise<void> | null = null;
  private daemonStdoutBuffer: string = "";
  // Total 16-bit samples ever written to the daemon's stdin, and total
  // score lines ever received back - processAudioChunk() computes how
  // many scores it should expect once its chunk is fully accounted for
  // (Math.floor(totalSamplesSent / 1280)) and awaits until
  // scoresReceivedCount catches up, so callers that await one big chunk
  // (the real-openwakeword test) still see a real detection complete
  // before the call resolves, exactly like the old batch design did -
  // while callers feeding small real-time chunks (mic-capture.ts) get
  // scores back within milliseconds of a warm daemon, not after a full
  // ~1s buffer.
  private totalSamplesSent: number = 0;
  private scoresReceivedCount: number = 0;
  private scoreWaiters: Array<{ count: number; resolve: () => void }> = [];
  private rollingAudio: Buffer = Buffer.alloc(0);
  // Real bug found 2026-08-31 on Gavin's live run: streaming real
  // 80ms-chunk scores (instead of one max-of-buffer score per ~1s batch,
  // the old design) means a single spoken "jarvis" naturally spans
  // several consecutive chunks, several of which can independently score
  // above threshold - the log showed TWO (sometimes three) separate
  // "Wake word detected" events fire back-to-back for what was clearly
  // one utterance, each one re-running handleWakeWord() (double-starting
  // speech recognition, resetting turn timers mid-stream) and very
  // likely the direct cause of the "timed out waiting for the daemon to
  // score N chunks" error later in that same log (the isActive handoff
  // happening twice in quick succession left the sample/score accounting
  // in an inconsistent state). Fixed with a one-shot latch: once a
  // detection fires, further scores are still logged (real diagnostic
  // value unchanged) but never re-emitted until startListening() is
  // called again for the next turn.
  private triggered: boolean = false;

  // Event listeners
  private listeners: Map<string, Function[]> = new Map();

  constructor(config: WakeWordDetectorConfig) {
    this.keyword = config.keyword;
    this.sensitivity = config.sensitivity;
    // openWakeWord model names map to a specific keyword; "hey_jarvis" is
    // the only bundled pretrained model that matches this project's
    // keyword, and is the default. A custom-trained model for a different
    // keyword would be passed here as an explicit .onnx/.tflite path.
    this.modelPath = config.modelPath || "hey_jarvis";
    this.sampleRate = config.sampleRate;
    const { pythonPath, scriptPath } = resolveWakeWordPaths(config);
    this.pythonPath = pythonPath;
    this.scriptPath = scriptPath;

    if (this.sampleRate !== 16000) {
      console.warn(
        `⚠️  WakeWordDetector configured with sampleRate=${this.sampleRate}, but openWakeWord's pretrained models require 16000Hz. Detection will be unreliable until audio is resampled to 16kHz.`
      );
    }

    this.initializeListeners();
  }

  /**
   * Initialize event listeners
   */
  private initializeListeners() {
    this.listeners.set("wake-word-detected", []);
    this.listeners.set("audio-chunk", []);
    this.listeners.set("listening-started", []);
    this.listeners.set("listening-stopped", []);
  }

  /**
   * Subscribe to wake word detector events
   */
  on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  /**
   * Emit event
   */
  private emit(event: string, data?: any) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach((callback) => callback(data));
  }

  /**
   * [ADDED 2026-09-02] Real, minimal latch reset - does none of
   * startListening()'s other work (no daemon spawn/warm-up wait, no
   * isListening/listening-started state change), just clears the
   * one-shot `triggered` flag. Needed for a real, live-found case:
   * during isSpeaking, processAudioChunk() is called directly (see
   * voice-interface.ts's processMicChunk()) without an intervening
   * startListening()/stopListening() cycle - if a candidate trigger
   * fires but voice-interface.ts decides it's too low-confidence to
   * treat as a real interruption (see its own
   * interruptionConfidenceThreshold comment), the latch would otherwise
   * stay "used up" for the rest of that reply, silently preventing a
   * real follow-up interruption attempt from ever firing again until
   * the next full turn. This re-arms detection without restarting
   * anything else.
   */
  rearm(): void {
    this.triggered = false;
  }

  /**
   * Start listening for wake word
   */
  async startListening(): Promise<void> {
    if (this.isListening) return;

    console.log(`🎤 Starting wake word detection for "${this.keyword}"`);
    console.log(`   Sensitivity: ${(this.sensitivity * 100).toFixed(0)}%`);

    this.isListening = true;
    this.triggered = false; // reset the one-shot latch for this new listening session - see its own comment above
    this.emit("listening-started");

    // Spawns (or reuses, if already warm from a previous turn) the
    // persistent daemon and waits for it to finish loading the model -
    // the one real unavoidable cost, paid here once, not per detection.
    //
    // 2026-08-31: this now does real process I/O where the old per-cycle
    // design never did (startListening() used to just flip a flag - the
    // subprocess spawn happened lazily, later, inside processAudioChunk(),
    // where a failure was already caught and logged without crashing
    // anything). A daemon spawn failure here (bad python path, missing
    // venv) must not become an uncaught rejection that takes down the
    // whole `listen` session the moment it starts - caught and logged
    // the same way processAudioChunk() below handles a mid-session
    // failure, not rethrown.
    try {
      await this.ensureDaemonStarted();
      console.log("   Listening for wake word...");
    } catch (error) {
      const message = `wake word daemon failed to start: ${error instanceof Error ? error.message : error}`;
      console.error("❌ Wake word detection failed:", message);
      this.emit("error", { message });
    }
  }

  /**
   * Stop listening for wake word
   *
   * Does NOT kill the persistent daemon (2026-08-31) - stopListening()
   * is called between conversation turns (voice-interface.ts resumes
   * listening after every reply), and killing/reloading the model on
   * every single turn would reintroduce the exact per-cycle reload cost
   * this daemon architecture exists to eliminate. The daemon is only
   * ever actually torn down by shutdown() (see below), called once when
   * the whole `listen` session ends.
   */
  async stopListening(): Promise<void> {
    if (!this.isListening) return;

    console.log("🛑 Stopping wake word detection");
    this.isListening = false;

    // Real bug found 2026-08-31: the idle-to-active handoff can leave a
    // processAudioChunk() call still awaiting a few final scores that
    // will now never arrive (no more idle-phase audio is being sent to
    // this daemon once a turn starts) - previously that just hung until
    // waitForScoreCount()'s 5s safety timeout fired, mid-turn, as a
    // confusing "❌ Wake word detection failed: timed out..." error that
    // had nothing to do with an actual failure. Resolving any pending
    // waiters immediately here is the honest fix: we're intentionally
    // done listening, so there's nothing left to wait for.
    if (this.scoreWaiters.length > 0) {
      const waiters = this.scoreWaiters;
      this.scoreWaiters = [];
      waiters.forEach((waiter) => waiter.resolve());
    }

    this.emit("listening-stopped");
  }

  /**
   * Permanently tear down the persistent daemon process - call this once,
   * when the whole `listen` session is shutting down (see
   * voice-interface.ts's stop()), not between turns (see stopListening()
   * above for why those are different).
   */
  shutdown(): void {
    if (this.daemonProc) {
      this.daemonProc.stdin.end();
      this.daemonProc.kill();
      this.daemonProc = null;
    }
    this.daemonReady = null;
  }

  /**
   * Spawn the persistent wakeword_detect_daemon.py process if it isn't
   * already running, and return a promise that resolves once it has
   * finished loading the model and printed its "ready" line. Safe to
   * call repeatedly - reuses the existing process/promise if one is
   * already up or starting.
   */
  private ensureDaemonStarted(): Promise<void> {
    if (this.daemonReady) return this.daemonReady;

    this.daemonReady = new Promise<void>((resolveReady, rejectReady) => {
      const proc = spawn(this.pythonPath, [this.scriptPath, this.modelPath], {
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
      this.daemonProc = proc;

      let readyResolved = false;

      proc.stdout.on("data", (data: Buffer) => {
        this.daemonStdoutBuffer += data.toString("utf-8");
        let newlineIndex: number;
        while ((newlineIndex = this.daemonStdoutBuffer.indexOf("\n")) !== -1) {
          const line = this.daemonStdoutBuffer.slice(0, newlineIndex).trim();
          this.daemonStdoutBuffer = this.daemonStdoutBuffer.slice(newlineIndex + 1);
          if (!line) continue;

          let parsed: DaemonScoreLine;
          try {
            parsed = JSON.parse(line);
          } catch {
            console.error(`❌ Wake word daemon produced non-JSON line: ${line}`);
            continue;
          }

          if (parsed.ready) {
            readyResolved = true;
            resolveReady();
            continue;
          }

          if (parsed.error) {
            console.error("❌ Wake word detection failed:", parsed.error);
            this.emit("error", { message: parsed.error });
            // A single bad chunk doesn't necessarily mean the daemon
            // died - still count it so any pending waiter doesn't hang
            // forever on a chunk that will never produce a real score.
            this.scoresReceivedCount++;
            this.resolveReadyWaiters();
            continue;
          }

          if (typeof parsed.score === "number") {
            this.scoresReceivedCount++;
            this.handleScore(parsed.score);
            this.resolveReadyWaiters();
          }
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        // wakeword_detect_daemon.py logs real startup/self-heal-download
        // progress here (see _wakeword_model_setup.py) - surface it
        // instead of swallowing real diagnostic info.
        console.log(`   [wakeword] ${data.toString().trim()}`);
      });

      proc.on("error", (err) => {
        const message = `Failed to launch wake word daemon at "${this.pythonPath}": ${err.message}. Run scripts/setup-voice.sh first.`;
        console.error("❌ Wake word detection failed:", message);
        this.emit("error", { message });
        this.daemonProc = null;
        this.daemonReady = null;
        if (!readyResolved) rejectReady(new Error(message));
      });

      proc.on("close", (code) => {
        const wasRunning = this.daemonProc !== null;
        this.daemonProc = null;
        this.daemonReady = null;
        if (wasRunning && code !== 0 && code !== null) {
          const message = `wake word daemon exited unexpectedly (code ${code})`;
          console.error("❌ Wake word detection failed:", message);
          this.emit("error", { message });
        }
        if (!readyResolved) rejectReady(new Error(`wake word daemon exited before becoming ready (code ${code})`));
      });
    });

    return this.daemonReady;
  }

  /** Resolves any waitForScoreCount() callers whose target count has now been reached. */
  private resolveReadyWaiters(): void {
    this.scoreWaiters = this.scoreWaiters.filter((waiter) => {
      if (this.scoresReceivedCount >= waiter.count) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  }

  /** Resolves once scoresReceivedCount has reached at least `count`, or after a safety timeout so a lost/miscounted score can never hang a caller forever. */
  private waitForScoreCount(count: number, timeoutMs = 5000): Promise<void> {
    if (this.scoresReceivedCount >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter = { count, resolve };
      this.scoreWaiters.push(waiter);
      setTimeout(() => {
        const idx = this.scoreWaiters.indexOf(waiter);
        if (idx !== -1) {
          this.scoreWaiters.splice(idx, 1);
          console.error(
            `❌ Wake word detection failed: timed out waiting for the daemon to score ${count} chunks (got ${this.scoresReceivedCount}) - it may have crashed or fallen behind.`
          );
          resolve();
        }
      }, timeoutMs);
    });
  }

  /** Real per-chunk score handling - same threshold check/logging/emit the old per-cycle detectWakeWord() did, just invoked once per 80ms sub-chunk instead of once per ~1s buffer. */
  private handleScore(score: number): void {
    // Real diagnostic gap found 2026-08-30: this only ever logged on a
    // hard error, never the actual score - so "the wake word didn't
    // fire" and "detection never ran / crashed silently" looked
    // identical from the console. Logging every real score (not just
    // successful triggers) so a live run shows real numbers to
    // calibrate `sensitivity` (default 0.05 as of 2026-08-30, was 0.15)
    // against instead of guessing blind - especially relevant since the
    // model's own known behavior (see this file's header comment) scores
    // anywhere from ~0.003 to ~0.999 on genuine "jarvis" utterances
    // depending on cadence/position, so seeing the real number matters
    // more here than for a typical fixed threshold.
    console.log(`   🔍 wake-word score: ${score.toFixed(4)} (threshold: ${this.sensitivity})`);
    // One-shot latch (see `triggered`'s own comment above) - a single
    // spoken "jarvis" spans several consecutive 80ms chunks, several of
    // which can independently score above threshold; only the first one
    // per listening session actually fires.
    if (score > this.sensitivity && !this.triggered) {
      this.triggered = true;
      this.emitWakeWordDetected(score);
    }
  }

  /**
   * Process audio chunk (called from microphone stream)
   *
   * Writes the chunk to the persistent daemon's stdin, then awaits until
   * the daemon has actually scored everything derivable from bytes sent
   * so far - see totalSamplesSent/scoresReceivedCount above for why this
   * preserves the old "await this and any detection has already fired by
   * the time it resolves" contract real callers (including
   * src/tests/wake-word-detector.test.ts, which sends one whole
   * synthesized clip in a single call) depend on, while still being real
   * low-latency streaming for the mic pipeline's small chunks.
   */
  async processAudioChunk(audioChunk: Buffer): Promise<void> {
    if (!this.isListening) return;

    try {
      await this.ensureDaemonStarted();
    } catch (error) {
      const message = `wake word daemon failed to (re)start: ${error instanceof Error ? error.message : error}`;
      console.error("❌ Wake word detection failed:", message);
      this.emit("error", { message });
      return;
    }
    if (!this.daemonProc) return; // daemon failed to start - already logged/emitted above

    const sampleCount = Math.floor(audioChunk.length / 2);
    this.emit("audio-chunk", { size: sampleCount, bufferSize: sampleCount });

    this.rollingAudio = Buffer.concat([this.rollingAudio, audioChunk]);
    if (this.rollingAudio.length > ROLLING_AUDIO_MAX_BYTES) {
      this.rollingAudio = this.rollingAudio.subarray(-ROLLING_AUDIO_MAX_BYTES);
    }

    this.totalSamplesSent += sampleCount;
    const expectedScoreCount = Math.floor(this.totalSamplesSent / 1280);

    try {
      this.daemonProc.stdin.write(audioChunk);
    } catch (error) {
      const message = `Failed to write audio to wake word daemon: ${error instanceof Error ? error.message : error}`;
      console.error("❌ Wake word detection failed:", message);
      this.emit("error", { message });
      return;
    }

    await this.waitForScoreCount(expectedScoreCount);
  }

  /**
   * Emit wake word detected event
   */
  private emitWakeWordDetected(confidence: number) {
    const event: WakeWordEvent = {
      keyword: this.keyword,
      confidence: Math.min(confidence, 1.0),
      timestamp: new Date(),
      audioChunk: this.rollingAudio,
    };

    console.log(`🎯 Wake word detected: "${this.keyword}"`);
    console.log(`   Confidence: ${(event.confidence * 100).toFixed(1)}%`);

    this.emit("wake-word-detected", event);
  }

  /**
   * Get detector status
   */
  getStatus(): {
    isListening: boolean;
    keyword: string;
    sensitivity: number;
    bufferSize: number;
  } {
    return {
      isListening: this.isListening,
      keyword: this.keyword,
      sensitivity: this.sensitivity,
      bufferSize: this.rollingAudio.length / 2, // 16-bit samples
    };
  }

  /**
   * Set sensitivity (0-1)
   */
  setSensitivity(sensitivity: number) {
    this.sensitivity = Math.max(0, Math.min(1, sensitivity));
    console.log(`⚙️  Sensitivity adjusted to ${(this.sensitivity * 100).toFixed(0)}%`);
  }

  /**
   * Change wake word
   */
  setKeyword(keyword: string) {
    this.keyword = keyword;
    console.log(`🎯 Wake word changed to "${keyword}"`);
  }
}
