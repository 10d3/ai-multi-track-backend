import { ZyphraClient } from "@zyphra/client";
import type { FileProcessor } from "./file-processor";
import type {
  TTSRequest,
  ZyphraModel,
  ZyphraTTSRequest,
} from "../../types/type";
import { BATCH_SIZE, TTS_TIMEOUT_MS } from "./constants";
import fs from "fs/promises";
import { readFileSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface EmotionWeights {
  happiness: number;
  neutral: number;
  sadness: number;
  disgust: number;
  fear: number;
  surprise: number;
  anger: number;
  other: number;
}

interface TTSParams {
  text: string;
  speaking_rate: number;
  language_iso_code?: string;
  mime_type?: string;
  model?: ZyphraModel;
  speaker_audio?: string;
  emotion?: EmotionWeights;
  pitchStd?: number;
  vqscore?: number;
  speaker_noised?: boolean;
  fmax?: number;
}

export class ZyphraTTS {
  private zyphraClientTTS: ZyphraClient | null = null;
  private zyphraClientPromise: Promise<ZyphraClient> | null = null;
  private fileProcessor: FileProcessor;

  constructor(fileProcessor: FileProcessor) {
    this.fileProcessor = fileProcessor;
  }

  private getDefaultEmotions(): EmotionWeights {
    return {
      happiness: 0.6,
      neutral: 0.6,
      sadness: 0.05,
      disgust: 0.05,
      fear: 0.05,
      surprise: 0.05,
      anger: 0.05,
      other: 0.5,
    };
  }

  private async concatenateReferenceAudios(
    primaryAudioPath: string,
    secondaryAudioPath: string = "fallback_reference.wav",
    minSeconds: number = 10
  ): Promise<string> {
    try {
      const primaryDuration = await this.fileProcessor.getAudioDuration(
        primaryAudioPath
      );

      if (primaryDuration >= minSeconds) {
        return readFileSync(primaryAudioPath).toString("base64");
      }

      const tempPath = await this.fileProcessor.createTempPath(
        "combined_reference",
        "wav"
      );

      // Concatenate two different audio files
      const ffmpegCmd = `ffmpeg -i "${primaryAudioPath}" -i "${secondaryAudioPath}" \
        -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[out]" \
        -map "[out]" "${tempPath}"`;

      await execAsync(ffmpegCmd);
      return readFileSync(tempPath).toString("base64");
    } catch (error) {
      console.error("Failed to concatenate reference audios:", error);
      throw error;
    }
  }

  async getZyphraClient(): Promise<ZyphraClient> {
    if (this.zyphraClientTTS) return this.zyphraClientTTS;
    if (this.zyphraClientPromise) return this.zyphraClientPromise;

    this.zyphraClientPromise = (async () => {
      try {
        const { ZyphraClient } = await import("@zyphra/client");
        this.zyphraClientTTS = new ZyphraClient({
          apiKey: process.env.ZYPHRA_API_KEY || "",
        });
        return this.zyphraClientTTS;
      } catch (initError: any) {
        console.error("Client initialization error:", initError);
        this.zyphraClientTTS = null;
        throw new Error(
          `Failed to initialize TTS client: ${initError.message}`
        );
      } finally {
        this.zyphraClientPromise = null;
      }
    })();

    return this.zyphraClientPromise;
  }

  async processZypTTS({
    textToSpeech,
    voice_id,
    output_format = "MP3",
    voice_name,
    emotion,
    language_iso_code,
  }: ZyphraTTSRequest): Promise<string> {
    try {
      if (!textToSpeech || !voice_name || !voice_id) {
        throw new Error("Missing required parameters for TTS");
      }

      const client = await this.getZyphraClient();
      const isJapanese = voice_id.startsWith("ja");

      // Get reference voice if provided
      let speaker_audio: string | undefined;
      try {
        // speaker_audio = readFileSync("reference_voice.wav").toString("base64");
        speaker_audio = await this.concatenateReferenceAudios("reference_voice.wav", "secondary_reference.wav");
      } catch (error) {
        console.warn("No reference voice found, using default voice");
      }

      const baseParams: TTSParams = {
        text: textToSpeech,
        speaking_rate: 15,
        mime_type: "audio/mp3",
        speaker_audio,
        language_iso_code: language_iso_code || (isJapanese ? "ja" : "en-us"),
      };

      const params: TTSParams = isJapanese
        ? {
            ...baseParams,
            model: "zonos-v0.1-hybrid",
            language_iso_code: "ja",
            vqscore: 0.7,
            speaker_noised: true,
            fmax: 20000,
          }
        : {
            ...baseParams,
            model: "zonos-v0.1-transformer",
            emotion: emotion || this.getDefaultEmotions(),
            pitchStd: 50.0,
          };

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `TTS request timed out after ${TTS_TIMEOUT_MS / 1000} seconds`
              )
            ),
          TTS_TIMEOUT_MS
        );
      });

      const response = (await Promise.race([
        client.audio.speech.create(params),
        timeoutPromise,
      ])) as any;

      if (!response) {
        throw new Error("No audio content generated");
      }

      const tempAudioPath = await this.fileProcessor.createTempPath(
        "tts_audio",
        "mp3"
      );
      await fs.writeFile(tempAudioPath, response);
      await this.fileProcessor.verifyFile(tempAudioPath);

      const wavPath = await this.fileProcessor.convertAudioToWav(tempAudioPath);
      return wavPath;
    } catch (error) {
      console.error("TTS Error:", error);
      throw error;
    }
  }

  async processZypMultipleTTS(ttsRequests: any): Promise<String[]> {
    if (!ttsRequests?.length) {
      throw new Error("No TTS requests provided");
    }
    const results: string[] = [];
    for (let i = 0; i < ttsRequests.length; i += BATCH_SIZE) {
      const batch = ttsRequests.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map((request: any) =>
        this.processZypTTS(request)
      );
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }
}
