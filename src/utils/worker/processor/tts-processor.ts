import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { credentials } from "../../queue";
import { TTS_TIMEOUT_MS, BATCH_SIZE } from "./constants";
import { voices } from "../../constant/voices";
import type { FileProcessor } from "./file-processor";
import type { TTSRequest } from "../../types/type";
import fs from "fs/promises";

export class TTSProcessor {
  private ttsClient: TextToSpeechClient | null = null;
  private ttsClientInitPromise: Promise<TextToSpeechClient> | null = null;
  private fileProcessor: FileProcessor;

  constructor(fileProcessor: FileProcessor) {
    this.fileProcessor = fileProcessor;
  }

  async getTTSClient(): Promise<TextToSpeechClient> {
    if (this.ttsClient) {
      return this.ttsClient;
    }

    if (this.ttsClientInitPromise) {
      return this.ttsClientInitPromise;
    }

    this.ttsClientInitPromise = (async () => {
      try {
        const { TextToSpeechClient } = await import(
          "@google-cloud/text-to-speech"
        );
        this.ttsClient = new TextToSpeechClient({ credentials });
        return this.ttsClient;
      } catch (initError: any) {
        console.error("Client initialization error:", initError);
        this.ttsClient = null;
        throw new Error(
          `Failed to initialize TTS client: ${initError.message}`
        );
      } finally {
        this.ttsClientInitPromise = null;
      }
    })();

    return this.ttsClientInitPromise;
  }

  async processTTS({
    textToSpeech,
    voice_id,
    output_format = "MP3",
    voice_name,
  }: TTSRequest): Promise<string> {
    try {
      if (!textToSpeech || !voice_name || !voice_id) {
        throw new Error("Missing required parameters for TTS");
      }

      const client = await this.getTTSClient();
      const ssmlGender =
        voices.find((v) => v.name === voice_name)?.ssmlGender === "MALE"
          ? 1
          : 2;

      const request = {
        input: { ssml: textToSpeech },
        voice: {
          languageCode: voice_id,
          name: voice_name,
          ssmlGender,
        },
        audioConfig: {
          audioEncoding: output_format as "MP3",
        },
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

      const [response] = (await Promise.race([
        client.synthesizeSpeech(request),
        timeoutPromise,
      ])) as any;

      if (!response.audioContent) {
        throw new Error("No audio content generated");
      }

      const tempAudioPath = await this.fileProcessor.createTempPath(
        "tts_audio",
        "mp3"
      );
      await fs.writeFile(tempAudioPath, response.audioContent);
      await this.fileProcessor.verifyFile(tempAudioPath);

      const wavPath = await this.fileProcessor.convertAudioToWav(tempAudioPath);
      return wavPath;
    } catch (error: any) {
      console.error("TTS Error:", error);
      throw error;
    }
  }

  async processMultipleTTS(ttsRequests: TTSRequest[]): Promise<string[]> {
    if (!ttsRequests?.length) {
      throw new Error("No TTS requests provided");
    }

    const results: string[] = [];
    for (let i = 0; i < ttsRequests.length; i += BATCH_SIZE) {
      const batch = ttsRequests.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map((request) => this.processTTS(request));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }
}
