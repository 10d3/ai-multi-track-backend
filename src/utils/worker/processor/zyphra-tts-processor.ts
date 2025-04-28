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
// import { env } from "@env";

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
    console.log("[ZyphraTTS] Initialized ZyphraTTS processor");
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
      console.log(
        `[ZyphraTTS] Concatenating reference audios. Primary: ${primaryAudioPath}, Secondary: ${secondaryAudioPath}`
      );

      const primaryDuration = await this.fileProcessor.getAudioDuration(
        primaryAudioPath
      );
      console.log(`[ZyphraTTS] Primary audio duration: ${primaryDuration}s`);

      if (primaryDuration >= minSeconds) {
        console.log(
          `[ZyphraTTS] Primary audio is long enough (${primaryDuration}s >= ${minSeconds}s). Using it directly.`
        );
        return readFileSync(primaryAudioPath).toString("base64");
      }

      const tempPath = await this.fileProcessor.createTempPath(
        "combined_reference",
        "wav"
      );
      console.log(
        `[ZyphraTTS] Created temp path for combined reference: ${tempPath}`
      );

      // Concatenate two different audio files
      const ffmpegCmd = `ffmpeg -i "${primaryAudioPath}" -i "${secondaryAudioPath}" \
        -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[out]" \
        -map "[out]" "${tempPath}"`;

      console.log(`[ZyphraTTS] Executing FFmpeg command: ${ffmpegCmd}`);
      await execAsync(ffmpegCmd);
      console.log(`[ZyphraTTS] FFmpeg concatenation completed successfully`);

      return readFileSync(tempPath).toString("base64");
    } catch (error) {
      console.error(
        "[ZyphraTTS] Failed to concatenate reference audios:",
        error
      );
      throw error;
    }
  }

  async getZyphraClient(): Promise<ZyphraClient> {
    console.log("[ZyphraTTS] Getting Zyphra client");

    if (this.zyphraClientTTS) {
      console.log("[ZyphraTTS] Returning existing Zyphra client");
      return this.zyphraClientTTS;
    }

    if (this.zyphraClientPromise) {
      console.log("[ZyphraTTS] Returning existing client promise");
      return this.zyphraClientPromise;
    }

    console.log("[ZyphraTTS] Creating new Zyphra client");
    if (!process.env.ZYPHRA_API_KEY) {
      console.error(
        "[ZyphraTTS] ZYPHRA_API_KEY environment variable is not set"
      );
    } else {
      console.log(
        "[ZyphraTTS] ZYPHRA_API_KEY is set (length: " +
          process.env.ZYPHRA_API_KEY.length +
          ")"
      );
    }

    this.zyphraClientPromise = (async () => {
      try {
        console.log("[ZyphraTTS] Importing ZyphraClient");
        const { ZyphraClient } = await import("@zyphra/client");
        console.log("[ZyphraTTS] ZyphraClient imported successfully");

        this.zyphraClientTTS = new ZyphraClient({
          apiKey: process.env.ZYPHRA_API_KEY as string,
        });
        console.log("[ZyphraTTS] ZyphraClient initialized successfully");

        return this.zyphraClientTTS;
      } catch (initError: any) {
        console.error("[ZyphraTTS] Client initialization error:", initError);
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
    referenceAudioPath,
  }: ZyphraTTSRequest): Promise<string> {
    try {
      console.log(
        `[ZyphraTTS] Processing TTS request for voice: ${voice_name} (${voice_id}), text length: ${
          textToSpeech?.length || 0
        }`
      );

      if (!textToSpeech || !voice_name || !voice_id) {
        console.error("[ZyphraTTS] Missing required parameters:", {
          textToSpeech: !!textToSpeech,
          voice_name: !!voice_name,
          voice_id: !!voice_id,
        });
        throw new Error("Missing required parameters for TTS");
      }

      console.log("[ZyphraTTS] Getting Zyphra client");
      const client = await this.getZyphraClient();
      console.log("[ZyphraTTS] Got Zyphra client successfully");

      const isJapanese = voice_id.startsWith("ja");
      console.log(
        `[ZyphraTTS] Voice is ${isJapanese ? "Japanese" : "non-Japanese"}`
      );

      // Process reference audio if provided
      let speaker_audio: string | undefined;
      if (referenceAudioPath) {
        try {
          console.log(
            `[ZyphraTTS] Processing reference audio: ${referenceAudioPath}`
          );
          // Convert the file path to base64 encoded string
          speaker_audio = readFileSync(referenceAudioPath).toString("base64");
          console.log(
            `[ZyphraTTS] Reference audio converted to base64 (length: ${speaker_audio.length})`
          );
        } catch (error) {
          console.warn("[ZyphraTTS] Failed to read reference audio:", error);
        }
      } else {
        console.log("[ZyphraTTS] No reference audio provided");
      }

      const baseParams: TTSParams = {
        text: textToSpeech,
        speaking_rate: 15,
        mime_type: "audio/mp3",
        speaker_audio,
        language_iso_code: language_iso_code || (isJapanese ? "ja" : "en-us"),
      };

      console.log("[ZyphraTTS] Base params:", {
        textLength: baseParams.text.length,
        speaking_rate: baseParams.speaking_rate,
        mime_type: baseParams.mime_type,
        has_speaker_audio: !!baseParams.speaker_audio,
        language_iso_code: baseParams.language_iso_code,
      });

      const params: TTSParams = isJapanese
        ? {
            ...baseParams,
            model: "zonos-v0.1-hybrid",
            vqscore: 0.7,
            speaker_noised: true,
            fmax: 20000,
          }
        : {
            ...baseParams,
            model: "zonos-v0.1-transformer",
            emotion: emotion || this.getDefaultEmotions(),
          };

      console.log("[ZyphraTTS] Final params:", {
        model: params.model,
        vqscore: params.vqscore,
        speaker_noised: params.speaker_noised,
        fmax: params.fmax,
        has_emotion: !!params.emotion,
      });

      console.log(
        `[ZyphraTTS] Setting up timeout promise (${TTS_TIMEOUT_MS}ms)`
      );
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

      console.log("[ZyphraTTS] Calling Zyphra API");
      const response = (await Promise.race([
        client.audio.speech.create(params),
        timeoutPromise,
      ])) as any;
      console.log("[ZyphraTTS] Received response from Zyphra API");

      if (!response) {
        console.error("[ZyphraTTS] No response received from API");
        throw new Error("No audio content generated");
      }

      console.log("[ZyphraTTS] Response type:", typeof response);
      console.log("[ZyphraTTS] Response keys:", Object.keys(response));

      // Extract audio data from response
      const audioData = response.audioData || response.data || response;
      console.log("[ZyphraTTS] Audio data type:", typeof audioData);
      console.log("[ZyphraTTS] Audio data is instance of:", {
        Blob: audioData instanceof Blob,
        Buffer: Buffer.isBuffer(audioData),
        String: typeof audioData === "string",
        ArrayBuffer: audioData instanceof ArrayBuffer,
        ArrayBufferView: ArrayBuffer.isView(audioData),
      });

      if (!audioData) {
        console.error("[ZyphraTTS] Audio data not found in the response");
        throw new Error("Audio data not found in the response");
      }

      // Handle different response types properly
      let audioBuffer: Buffer;
      console.log("[ZyphraTTS] Processing audio data based on type");

      if (audioData instanceof Blob) {
        // Convert Blob to Buffer
        console.log("[ZyphraTTS] Converting Blob to ArrayBuffer");
        const arrayBuffer = await audioData.arrayBuffer();
        console.log("[ZyphraTTS] Converting ArrayBuffer to Buffer");
        audioBuffer = Buffer.from(arrayBuffer);
      } else if (Buffer.isBuffer(audioData)) {
        console.log("[ZyphraTTS] Using existing Buffer");
        audioBuffer = audioData;
      } else if (typeof audioData === "string") {
        console.log("[ZyphraTTS] Converting string to Buffer (base64)");
        audioBuffer = Buffer.from(audioData, "base64");
      } else if (
        audioData instanceof ArrayBuffer ||
        ArrayBuffer.isView(audioData)
      ) {
        console.log(
          "[ZyphraTTS] Converting ArrayBuffer/ArrayBufferView to Buffer"
        );
        audioBuffer = Buffer.from(
          new Uint8Array(
            audioData instanceof ArrayBuffer ? audioData : audioData.buffer
          )
        );
      } else {
        console.error(
          "[ZyphraTTS] Unsupported audio data type:",
          typeof audioData
        );
        throw new Error(`Unsupported audio data type: ${typeof audioData}`);
      }

      console.log(
        `[ZyphraTTS] Audio buffer created successfully (size: ${audioBuffer.length} bytes)`
      );

      // Write the audio data to a temporary file
      const tempAudioPath = await this.fileProcessor.createTempPath(
        "tts_audio",
        "mp3"
      );
      console.log(`[ZyphraTTS] Created temp audio path: ${tempAudioPath}`);

      await fs.writeFile(tempAudioPath, audioBuffer);
      console.log(`[ZyphraTTS] Wrote audio buffer to temp file`);

      await this.fileProcessor.verifyFile(tempAudioPath);
      console.log(`[ZyphraTTS] Verified temp audio file exists`);

      console.log(`[ZyphraTTS] Converting audio to WAV format`);
      const wavPath = await this.fileProcessor.convertAudioToWav(tempAudioPath);
      console.log(`[ZyphraTTS] Converted audio to WAV: ${wavPath}`);

      return wavPath;
    } catch (error: any) {
      console.error("TTS Error:", {
        message: error.message,
        stack: error.stack,
        code: error.code,
        details: error.details || "No additional details",
        params: { voice_id, voice_name, textLength: textToSpeech?.length },
      });
      throw error;
    }
  }

  async processZypMultipleTTS(
    ttsRequests: ZyphraTTSRequest[]
  ): Promise<string[]> {
    console.log(
      `[ZyphraTTS] Processing multiple TTS requests (count: ${
        ttsRequests?.length || 0
      })`
    );

    if (!ttsRequests?.length) {
      console.error("[ZyphraTTS] No TTS requests provided");
      throw new Error("No TTS requests provided");
    }

    const results: string[] = [];
    console.log(`[ZyphraTTS] Processing in batches of ${BATCH_SIZE}`);

    for (let i = 0; i < ttsRequests.length; i += BATCH_SIZE) {
      const batch = ttsRequests.slice(i, i + BATCH_SIZE);
      console.log(
        `[ZyphraTTS] Processing batch ${
          Math.floor(i / BATCH_SIZE) + 1
        }/${Math.ceil(ttsRequests.length / BATCH_SIZE)} (size: ${batch.length})`
      );

      // Process each request in the batch with individual error handling
      const batchResults = await Promise.all(
        batch.map(async (request) => {
          try {
            return await this.processZypTTS(request);
          } catch (error) {
            console.error(`[ZyphraTTS] Error processing request:`, {
              text: request.textToSpeech?.substring(0, 50) + "...",
              voice: request.voice_name,
              error: error instanceof Error ? error.message : String(error)
            });
            // Re-throw to be handled by the caller
            throw error;
          }
        })
      );

      console.log(`[ZyphraTTS] Batch completed successfully`);

      results.push(...batchResults);
      console.log(
        `[ZyphraTTS] Total results so far: ${results.length}/${ttsRequests.length}`
      );
    }

    console.log(
      `[ZyphraTTS] All TTS requests processed successfully (total: ${results.length})`
    );
    return results;
  }
}
