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
  /**
   * Clean and optimize reference audio using FFmpeg 6 advanced processing
   */
  private async cleanReferenceAudio(inputPath: string, quality: 'standard' | 'high' | 'ultra' = 'high'): Promise<string> {
    const outputPath = await this.fileProcessor.createTempPath("clean_ref", "wav");
    
    try {
      await this.processAudioFFmpeg6(inputPath, outputPath, {
        quality,
        enhanceSpeech: true,
        removeSilence: true,
        sampleRate: 22050,
        targetLoudness: -20
      });
      
      console.log(`[ZyphraTTS] Reference audio cleaned with ${quality} quality`);
      return outputPath;
      
    } catch (error) {
      console.warn(`[ZyphraTTS] Advanced cleaning failed, using basic method:`, error);
      // Fallback to basic cleaning
      await execAsync(
        `ffmpeg -y -i "${inputPath}" -af "highpass=f=80,lowpass=f=8000,loudnorm=I=-20:TP=-2" -c:a pcm_s16le -ac 1 -ar 22050 "${outputPath}"`
      );
      return outputPath;
    }
  }

  /**
   * FFmpeg 6 Advanced Speech Processing
   */
  private async processAudioFFmpeg6(inputPath: string, outputPath: string, options: {
    sampleRate?: number;
    targetLoudness?: number;
    useAINoise?: boolean;
    removeSilence?: boolean;
    enhanceSpeech?: boolean;
    quality?: 'standard' | 'high' | 'ultra';
  } = {}): Promise<void> {
    
    const {
      sampleRate = 22050,
      targetLoudness = -20,
      useAINoise = true,
      removeSilence = false,
      enhanceSpeech = true,
      quality = 'standard'
    } = options;

    const filters: string[] = [];
    
    // Core frequency filtering
    filters.push('highpass=f=85');
    filters.push(quality === 'ultra' ? 'lowpass=f=8000' : 'lowpass=f=7500');
    
    // FFmpeg 6 speech enhancement
    if (enhanceSpeech) {
      filters.push('speechnorm=e=25:r=0.00001:l=1');
    }
    
    // Advanced noise reduction (FFmpeg 6 improved)
    if (useAINoise) {
      filters.push('afftdn=nf=-25:nt=w:tn=1:om=o:tn=1');
    }
    
    // Dynamic audio normalization (FFmpeg 6 enhanced)
    filters.push('dynaudnorm=f=500:g=31:n=0:s=0.95:r=0.9:b=1');
    
    // Silence removal with FFmpeg 6 improvements
    if (removeSilence) {
      filters.push('silenceremove=start_periods=1:start_duration=0.3:start_threshold=-50dB:detection=peak:stop_periods=-1:stop_duration=0.3:stop_threshold=-50dB:window=0.02');
    }
    
    // Enhanced loudnorm with FFmpeg 6 linear mode
    const loudnormParams = quality === 'ultra' 
      ? `loudnorm=I=${targetLoudness}:TP=-2:LRA=7:linear=true:tp=${targetLoudness + 3}`
      : `loudnorm=I=${targetLoudness}:TP=-2:LRA=7:linear=true`;
    
    filters.push(loudnormParams);

    const filterString = filters.join(',');
    
    // FFmpeg 6 with improved threading and progress
    await execAsync(
      `ffmpeg -y -threads 0 -i "${inputPath}" \
       -af "${filterString}" \
       -c:a pcm_s16le -ac 1 -ar ${sampleRate} \
       -f wav "${outputPath}"`,
      { maxBuffer: 1024 * 1024 * 10 } // 10MB buffer for large files
    );
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

    // Debug: Log emotion usage
    const finalEmotion = emotion || this.getDefaultEmotion();
    console.log(`[ZyphraTTS] Using emotion for "${textToSpeech.substring(0, 30)}...":`, {
      provided: !!emotion,
      emotion: finalEmotion
    });

    const client = await this.getClient();
    const isCloning = voice_id === "cloning-voice";
    const isJapanese = voice_id?.startsWith("ja") || language_iso_code === "ja";

    // Prepare parameters
    const params: TTSParams = {
      text: textToSpeech.trim(),
      speaking_rate: 15, // Reduced for more natural speech
      mime_type: "audio/wav",
      model: isJapanese ? "zonos-v0.1-hybrid" : "zonos-v0.1-transformer", // Hybrid for Japanese
      vqscore: 0.7, // Minimum to reduce AI creativity
      language_iso_code,
      emotion: finalEmotion, // Use provided emotion from request or default
    };

    // Log model selection for debugging
    console.log(`[ZyphraTTS] Model: ${params.model} (Japanese: ${isJapanese}, Voice: ${voice_id})`);

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

    // Save WAV file directly (no conversion needed)
    const tempPath = await this.fileProcessor.createTempPath("tts", "wav");
    await fs.writeFile(tempPath, audioBuffer);
    await this.fileProcessor.verifyFile(tempPath);

    return tempPath;
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
