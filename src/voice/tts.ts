/**
 * Text-to-Speech Module
 * Converts text responses to natural speech using Piper TTS
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { v4 as uuid } from "uuid";

export interface TTSConfig {
  voice: string;
  speed?: number;
  pitch?: number;
  language?: string;
  outputDir?: string;
}

export interface TTSResult {
  audioPath: string;
  duration: number; // seconds
  format: string;
}

export class TextToSpeech {
  private config: TTSConfig;
  private outputDir: string;

  constructor(config: Partial<TTSConfig> = {}) {
    this.config = {
      voice: "en-us-libritts-high",
      speed: 1.0,
      pitch: 1.0,
      language: "en",
      outputDir: "/tmp/jarvis-audio",
      ...config,
    };

    this.outputDir = this.config.outputDir || "/tmp/jarvis-audio";
  }

  /**
   * Synthesize text to speech
   * Returns path to generated audio file
   */
  async synthesize(text: string): Promise<TTSResult> {
    const audioId = uuid();
    const audioPath = join(this.outputDir, `${audioId}.wav`);

    try {
      console.log(`[TTS] Synthesizing: "${text.substring(0, 50)}..."`);

      // Check if Piper is installed
      try {
        execSync("which piper", { stdio: "ignore" });
      } catch {
        console.warn(
          "[TTS] Piper TTS not found. Install with: pip install piper-tts"
        );
        // Return placeholder for now
        return {
          audioPath: audioPath,
          duration: text.split(" ").length * 0.5, // rough estimate
          format: "wav",
        };
      }

      // Synthesize with Piper
      // piper-tts outputs to stdout by default
      const espeak_options = `--voice en-us-libritts-high --speed ${this.config.speed || 1.0}`;

      try {
        // Write to file using Piper
        execSync(`echo "${text}" | piper ${espeak_options} > ${audioPath}`, {
          stdio: "pipe",
        });

        console.log(`[TTS] Generated: ${audioPath}`);

        // Estimate duration (very rough)
        const duration = text.split(" ").length * 0.5;

        return {
          audioPath,
          duration,
          format: "wav",
        };
      } catch (error) {
        console.warn(`[TTS] Piper synthesis failed, returning placeholder`);
        return {
          audioPath,
          duration: text.split(" ").length * 0.5,
          format: "wav",
        };
      }
    } catch (error) {
      throw new Error(
        `TTS failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Play audio file (if speakers available)
   */
  async play(audioPath: string): Promise<void> {
    try {
      console.log(`[TTS] Playing: ${audioPath}`);

      // Try to play with common audio players
      const commands = [
        `ffplay -nodisp -autoexit "${audioPath}" 2>/dev/null`,
        `play "${audioPath}" 2>/dev/null`, // sox
        `paplay "${audioPath}" 2>/dev/null`, // pulseaudio
        `aplay "${audioPath}" 2>/dev/null`, // alsa
      ];

      let played = false;
      for (const cmd of commands) {
        try {
          execSync(cmd, { stdio: "ignore" });
          played = true;
          break;
        } catch {
          // Try next player
        }
      }

      if (!played) {
        console.warn(
          "[TTS] No audio player found. Install ffmpeg or sox to hear output."
        );
      }
    } catch (error) {
      console.error(
        `[TTS] Play failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get available voices
   */
  getAvailableVoices(): string[] {
    return [
      "en-us-libritts-high",
      "en-us-hfc-female",
      "en-us-hfc-male",
      "en-gb-jenny_dioco-medium",
    ];
  }

  /**
   * Set voice
   */
  setVoice(voice: string): void {
    if (!this.getAvailableVoices().includes(voice)) {
      throw new Error(`Unknown voice: ${voice}`);
    }
    this.config.voice = voice;
  }

  /**
   * Clean up audio file
   */
  cleanup(audioPath: string): void {
    try {
      unlinkSync(audioPath);
      console.log(`[TTS] Cleaned up: ${audioPath}`);
    } catch (error) {
      console.warn(`[TTS] Failed to clean up ${audioPath}`);
    }
  }
}
