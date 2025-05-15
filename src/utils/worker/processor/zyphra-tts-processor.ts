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

// Retry configuration for API calls
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000; // Start with 1 second delay

// Helper function to determine if an error is retryable
function isRetryableError(error: any): boolean {
  // Check for timeout errors
  if (
    error.message?.includes("timeout") ||
    error.message?.includes("timed out")
  ) {
    return true;
  }

  // Check for specific Zyphra error codes
  if (error.statusCode === 524 || error.response?.status === 524) {
    return true;
  }

  // Check for network errors
  if (
    error.message?.includes("network") ||
    error.message?.includes("connection")
  ) {
    return true;
  }

  // Check for server errors (5xx)
  if (error.statusCode >= 500 || error.response?.status >= 500) {
    return true;
  }

  return false;
}

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
  default_voice_name?: string;
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

  /**
   * Creates a reference audio file on demand from an audio file
   * @param audioPath Path to the audio file to use as reference
   * @param speakerId Optional identifier for the speaker
   * @returns Path to the created reference audio file
   */
  public async createReferenceAudio(
    audioPath: string,
    speakerId: string = "default"
  ): Promise<string> {
    try {
      console.log(
        `[ZyphraTTS] Creating reference audio for speaker ${speakerId} from ${audioPath}`
      );

      // Verify the input file exists
      await this.fileProcessor.verifyFile(audioPath);

      // Get audio duration
      const duration = await this.fileProcessor.getAudioDuration(audioPath);

      // Create a reference audio file with optimal duration (minimum 30 seconds)
      // Increased from 10 seconds to 30 seconds for better voice modeling
      const targetDuration = Math.min(60, Math.max(30, duration));
      const startTime =
        duration > targetDuration ? (duration - targetDuration) / 2 : 0;

      const outputPath = await this.fileProcessor.createTempPath(
        `reference_${speakerId}`,
        "wav"
      );

      // Enhanced preprocessing for cleaner reference audio
      // 1. Apply highpass filter to remove low-frequency noise
      // 2. Apply lowpass filter to remove high-frequency noise
      // 3. Apply noise reduction filter (afftdn) with stronger settings
      // 4. Apply compression to normalize volume
      // 5. Apply de-essing to reduce sibilance
      // 6. Apply final normalization for consistent volume
      await execAsync(
        `ffmpeg -i "${audioPath}" -ss ${startTime} -t ${targetDuration} -af "highpass=f=80,lowpass=f=12000,afftdn=nf=-30:nt=w,acompressor=threshold=0.05:ratio=4:attack=200:release=1000,adeclick=t=1:b=5,aresample=44100,loudnorm=I=-16:TP=-1.5:LRA=11" -c:a pcm_s16le "${outputPath}"`
      );

      await this.fileProcessor.verifyFile(outputPath);

      console.log(`[ZyphraTTS] Created reference audio: ${outputPath}`);
      return outputPath;
    } catch (error) {
      console.error(`[ZyphraTTS] Failed to create reference audio:`, error);
      throw new Error(`Failed to create reference audio: ${error}`);
    }
  }

  private async concatenateReferenceAudios(
    primaryAudioPath: string,
    secondaryAudioPath: string = "fallback_reference.wav",
    minSeconds: number = 30  // Updated from 10 to 30 seconds minimum
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

      // Check if we need to loop the primary audio to reach minimum duration
      if (primaryDuration > 0 && primaryDuration < minSeconds) {
        const loopCount = Math.ceil(minSeconds / primaryDuration);
        console.log(`[ZyphraTTS] Looping primary audio ${loopCount} times to reach minimum duration`);
        
        // Create a filter complex to loop the primary audio
        const loopFilter = `[0:a]aloop=loop=${loopCount - 1}:size=2e+09[out]`;
        
        // Apply enhanced audio processing to the looped audio
        const ffmpegCmd = `ffmpeg -i "${primaryAudioPath}" \
          -filter_complex "${loopFilter}" \
          -map "[out]" -af "highpass=f=80,lowpass=f=12000,afftdn=nf=-30:nt=w,acompressor=threshold=0.05:ratio=4:attack=200:release=1000,adeclick=t=1:b=5,aresample=44100,loudnorm=I=-16:TP=-1.5:LRA=11" \
          "${tempPath}"`;
        
        console.log(`[ZyphraTTS] Executing FFmpeg loop command: ${ffmpegCmd}`);
        await execAsync(ffmpegCmd);
      } else {
        // Concatenate two different audio files with enhanced processing
        const ffmpegCmd = `ffmpeg -i "${primaryAudioPath}" -i "${secondaryAudioPath}" \
          -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[concat];[concat]highpass=f=80,lowpass=f=12000,afftdn=nf=-30:nt=w,acompressor=threshold=0.05:ratio=4:attack=200:release=1000,adeclick=t=1:b=5,aresample=44100,loudnorm=I=-16:TP=-1.5:LRA=11[out]" \
          -map "[out]" "${tempPath}"`;

        console.log(`[ZyphraTTS] Executing FFmpeg concatenation command: ${ffmpegCmd}`);
        await execAsync(ffmpegCmd);
      }
      
      console.log(`[ZyphraTTS] FFmpeg processing completed successfully`);
      await this.fileProcessor.verifyFile(tempPath);
      
      // Get the final duration to verify
      const finalDuration = await this.fileProcessor.getAudioDuration(tempPath);
      console.log(`[ZyphraTTS] Final reference audio duration: ${finalDuration}s`);

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
      const isCloning = voice_id === "cloning-voice";
      console.log(
        `[ZyphraTTS] Voice is ${isJapanese ? "Japanese" : "non-Japanese"}`
      );

      // Process reference audio for cloning or if provided
      let speaker_audio: string | undefined;
      if (isCloning) {
        if (!referenceAudioPath) {
          throw new Error("Reference audio is required for voice cloning");
        }
        try {
          console.log(
            `[ZyphraTTS] Processing reference audio for cloning: ${referenceAudioPath}`
          );
          speaker_audio = readFileSync(referenceAudioPath).toString("base64");
          console.log(
            `[ZyphraTTS] Reference audio converted to base64 (length: ${speaker_audio.length})`
          );
        } catch (error) {
          console.error(
            "[ZyphraTTS] Failed to read reference audio for cloning:",
            error
          );
          throw new Error(
            "Failed to process reference audio for voice cloning"
          );
        }
      }

      const baseParams: TTSParams = {
        text: textToSpeech,
        speaking_rate: 15,
        mime_type: "audio/mp3",
        language_iso_code: language_iso_code,
      };

      // Add conditional properties based on voice_id
      if (voice_id !== "cloning-voice") {
        baseParams.default_voice_name = voice_id;
      } else if (speaker_audio) {
        baseParams.speaker_audio = speaker_audio;
      }

      console.log("[ZyphraTTS] Base params:", {
        textLength: baseParams.text.length,
        speaking_rate: baseParams.speaking_rate,
        mime_type: baseParams.mime_type,
        has_speaker_audio: !!baseParams.speaker_audio,
        default_voice_name: !!baseParams.default_voice_name,
        language_iso_code: baseParams.language_iso_code,
      });

      // Set parameters based on voice type
      const params: TTSParams = isCloning
        ? {
            ...baseParams,
            model: "zonos-v0.1-transformer", // Use appropriate model for cloning
            // speaker_noised: true,
            emotion: emotion || this.getDefaultEmotions(),
            vqscore: 0.7,
          }
        : isJapanese
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

      console.log("[ZyphraTTS] Calling Zyphra API with retry mechanism");

      let response: any = null;
      let lastError: any = null;
      let retryCount = 0;

      while (retryCount <= MAX_RETRIES) {
        try {
          response = (await Promise.race([
            client.audio.speech.create(params),
            timeoutPromise,
          ])) as any;

          console.log("[ZyphraTTS] Received response from Zyphra API");
          break; // Success, exit the retry loop
        } catch (error: any) {
          lastError = error;

          // Check if this is a retryable error
          const shouldRetry = isRetryableError(error);

          if (shouldRetry && retryCount < MAX_RETRIES) {
            retryCount++;
            const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount - 1); // Exponential backoff
            console.log(
              `[ZyphraTTS] Request timed out (${error.message}). Retrying ${retryCount}/${MAX_RETRIES} after ${delay}ms`
            );

            // Wait before retrying
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            // Not a timeout or we've exhausted retries
            console.error(
              `[ZyphraTTS] API call failed after ${retryCount} retries:`,
              error
            );
            throw error;
          }
        }
      }

      // If we've exhausted retries and still have an error, throw it
      if (!response && lastError) {
        console.error(
          `[ZyphraTTS] API call failed after ${MAX_RETRIES} retries:`,
          lastError
        );
        throw lastError;
      }

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
    ttsRequests: ZyphraTTSRequest[],
    language: string
  ): Promise<Array<{path: string, start: number, end: number}>> {
    console.log(
      `[ZyphraTTS] Processing multiple TTS requests (count: ${
        ttsRequests?.length || 0
      })`
    );

    if (!ttsRequests?.length) {
      console.error("[ZyphraTTS] No TTS requests provided");
      throw new Error("No TTS requests provided");
    }

    const results: Array<{path: string, start: number, end: number}> = [];
    console.log(`[ZyphraTTS] Processing in batches of ${BATCH_SIZE}`);

    for (let i = 0; i < ttsRequests.length; i += BATCH_SIZE) {
      const batch = ttsRequests.slice(i, i + BATCH_SIZE);
      console.log(
        `[ZyphraTTS] Processing batch ${
          Math.floor(i / BATCH_SIZE) + 1
        }/${Math.ceil(ttsRequests.length / BATCH_SIZE)} (size: ${batch.length})`
      );

      let batchRetryCount = 0;
      let batchSuccess = false;
      let lastBatchError: any = null;

      // Retry the entire batch if needed
      while (!batchSuccess && batchRetryCount <= MAX_RETRIES) {
        try {
          // Process each request in the batch with individual error handling
          const batchResults = await Promise.all(
            batch.map(async (request) => {
              try {
                const filePath = await this.processZypTTS({
                  ...request,
                  language_iso_code: language || request.language_iso_code,
                });
                
                // Return object with file path and timing information
                return {
                  path: filePath,
                  start: request.start,
                  end: request.end
                };
              } catch (error) {
                console.error(`[ZyphraTTS] Error processing request:`, {
                  text: request.textToSpeech?.substring(0, 50) + "...",
                  voice: request.voice_name,
                  error: error instanceof Error ? error.message : String(error),
                });
                // Re-throw to be handled by the batch retry mechanism
                throw error;
              }
            })
          );

          // If we get here, the batch was successful
          console.log(`[ZyphraTTS] Batch completed successfully`);
          results.push(...batchResults);
          batchSuccess = true;
        } catch (error: any) {
          lastBatchError = error;

          // Check if this is an error that we should retry
          const shouldRetry = isRetryableError(error);

          if (shouldRetry && batchRetryCount < MAX_RETRIES) {
            batchRetryCount++;
            const delay =
              INITIAL_RETRY_DELAY_MS * Math.pow(2, batchRetryCount - 1); // Exponential backoff
            console.log(
              `[ZyphraTTS] Batch processing failed with timeout error. Retrying batch ${batchRetryCount}/${MAX_RETRIES} after ${delay}ms`
            );

            // Wait before retrying the batch
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            // Not a timeout or we've exhausted retries
            console.error(
              `[ZyphraTTS] Batch processing failed after ${batchRetryCount} retries:`,
              error
            );
            throw error;
          }
        }
      }

      // If we've exhausted retries and still have an error, throw it
      if (!batchSuccess && lastBatchError) {
        console.error(
          `[ZyphraTTS] Batch processing failed after ${MAX_RETRIES} retries:`,
          lastBatchError
        );
        throw lastBatchError;
      }

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
