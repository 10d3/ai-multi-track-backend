import { ZyphraClient } from "@zyphra/client";
import type { FileProcessor } from "./file-processor";
import type { ZyphraTTSRequest } from "../../types/type";
import { BATCH_SIZE, TTS_TIMEOUT_MS } from "./constants";
import fs from "fs/promises";
import { readFileSync } from "fs";
import { promisify } from "util";
import { exec } from "child_process";

const execAsync = promisify(exec);

interface TTSParams {
  text: string;
  speaking_rate: number;
  language_iso_code?: string;
  mime_type: string;
  model: "zonos-v0.1-transformer" | "zonos-v0.1-hybrid";
  speaker_audio?: string;
  default_voice_name?: string;
  vqscore: number;
  emotion?: {
    happiness: number;
    neutral: number;
    sadness: number;
    disgust: number;
    fear: number;
    surprise: number;
    anger: number;
    other: number;
  };
}

export class ZyphraTTS {
  private client: ZyphraClient | null = null;
  private fileProcessor: FileProcessor;

  constructor(fileProcessor: FileProcessor) {
    this.fileProcessor = fileProcessor;
  }

  /**
   * Get or create Zyphra client
   */
  private async getClient(): Promise<ZyphraClient> {
    if (!this.client) {
      if (!process.env.ZYPHRA_API_KEY) {
        throw new Error("ZYPHRA_API_KEY environment variable is required");
      }

      const { ZyphraClient } = await import("@zyphra/client");
      this.client = new ZyphraClient({
        apiKey: process.env.ZYPHRA_API_KEY as string,
      });
    }
    return this.client;
  }

  /**
   * Clean reference audio for better TTS quality
   */
  private async cleanReferenceAudio(inputPath: string): Promise<string> {
    const outputPath = await this.fileProcessor.createTempPath(
      "clean_ref",
      "wav"
    );

    await execAsync(
      `ffmpeg -y -i "${inputPath}" \
       -af "highpass=f=80,lowpass=f=8000,afftdn=nf=-20:nt=w,loudnorm=I=-20:TP=-2" \
       -c:a pcm_s16le -ac 1 -ar 22050 "${outputPath}"`
    );

    return outputPath;
  }

  /**
   * Default neutral emotion weights to prevent AI creativity
   */
  private getDefaultEmotion() {
    return {
      happiness: 0.1,
      neutral: 0.9,
      sadness: 0.0,
      disgust: 0.0,
      fear: 0.0,
      surprise: 0.0,
      anger: 0.0,
      other: 0.0,
    };
  }

  /**
   * Generate TTS audio from text
   */
  async generateTTS({
    textToSpeech,
    voice_id,
    voice_name,
    language_iso_code,
    referenceAudioPath,
    emotion,
  }: ZyphraTTSRequest): Promise<string> {
    if (!textToSpeech?.trim()) {
      throw new Error("Text is required for TTS generation");
    }

    const client = await this.getClient();
    const isCloning = voice_id === "cloning-voice";

    // Prepare parameters
    const params: TTSParams = {
      text: textToSpeech.trim(),
      speaking_rate: 10,
      mime_type: "audio/mp3",
      model: "zonos-v0.1-transformer",
      vqscore: 0.6, // Must be between 0.6 and 0.8 per Zyphra API requirements
      language_iso_code,
      emotion: emotion || this.getDefaultEmotion(), // Use provided emotion or default
    };

    // Handle voice cloning
    if (isCloning && referenceAudioPath) {
      await this.fileProcessor.verifyFile(referenceAudioPath);
      const cleanedAudio = await this.cleanReferenceAudio(referenceAudioPath);
      const audioBuffer = readFileSync(cleanedAudio);
      params.speaker_audio = audioBuffer.toString("base64");
    } else {
      params.default_voice_name = voice_id;
    }

    // Call Zyphra API with timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("TTS timeout")), TTS_TIMEOUT_MS);
    });

    const response = (await Promise.race([
      client.audio.speech.create(params),
      timeoutPromise,
    ])) as any;

    // Process response
    const audioData = response?.audioData || response?.data || response;
    if (!audioData) {
      throw new Error("No audio data received from TTS API");
    }

    // Convert to buffer
    let audioBuffer: Buffer;
    if (audioData instanceof Blob) {
      const arrayBuffer = await audioData.arrayBuffer();
      audioBuffer = Buffer.from(arrayBuffer);
    } else if (Buffer.isBuffer(audioData)) {
      audioBuffer = audioData;
    } else if (typeof audioData === "string") {
      audioBuffer = Buffer.from(audioData, "base64");
    } else {
      audioBuffer = Buffer.from(new Uint8Array(audioData));
    }

    // Save and convert to WAV
    const tempPath = await this.fileProcessor.createTempPath("tts", "mp3");
    await fs.writeFile(tempPath, audioBuffer);

    return await this.fileProcessor.convertAudioToWav(tempPath);
  }

  /**
   * Process multiple TTS requests in batches
   */
  async processMultipleTTS(
    requests: ZyphraTTSRequest[],
    language: string
  ): Promise<string[]> {
    if (!requests?.length) {
      throw new Error("No TTS requests provided");
    }

    const results: string[] = [];

    // Process in batches
    for (let i = 0; i < requests.length; i += BATCH_SIZE) {
      const batch = requests.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map((request) =>
          this.generateTTS({
            ...request,
            language_iso_code: language || request.language_iso_code,
          })
        )
      );

      results.push(...batchResults);
    }

    return results;
  }
}
