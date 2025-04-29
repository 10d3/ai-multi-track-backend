import { promisify } from "util";
import type { Transcript, TTSRequest, ZyphraTTSRequest } from "../types/type";
import { AudioAnalyzer } from "./processor/audio-analyzer";
import { AudioCombiner } from "./processor/audio-combiner";
import { FileProcessor } from "./processor/file-processor";
import { StorageProcessor } from "./processor/storage-processor";
import { ZyphraTTS } from "./processor/zyphra-tts-processor";
import { SpeakerReferenceProcessor } from "./processor/speaker-reference-processor";
import path from "path";
import { exec } from "child_process";
import fs from "fs/promises";

const execAsync = promisify(exec);

export class AudioProcessor {
  private fileProcessor: FileProcessor;
  private zyphraTTS: ZyphraTTS;
  private audioAnalyzer: AudioAnalyzer;
  private audioCombiner: AudioCombiner;
  private storageProcessor: StorageProcessor;
  private speakerReferenceProcessor: SpeakerReferenceProcessor;

  constructor() {
    this.fileProcessor = new FileProcessor();
    this.zyphraTTS = new ZyphraTTS(this.fileProcessor);
    this.audioAnalyzer = new AudioAnalyzer(this.fileProcessor);
    this.audioCombiner = new AudioCombiner(
      this.fileProcessor,
      this.audioAnalyzer
    );
    this.storageProcessor = new StorageProcessor(this.fileProcessor);
    this.speakerReferenceProcessor = new SpeakerReferenceProcessor(
      this.fileProcessor
    );
  }

  async init(): Promise<void> {
    await this.fileProcessor.init();
  }

  async cleanup(): Promise<void> {
    await this.fileProcessor.cleanup();
  }

  async processTTSFiles(audioUrls: string[]): Promise<string[]> {
    const convertedPaths: string[] = [];
    for (const url of audioUrls) {
      const wavPath = await this.fileProcessor.downloadAndConvertAudio(url);
      convertedPaths.push(wavPath);
    }
    return convertedPaths;
  }

  async processMultipleTTS(
    transcript: Transcript[],
    ttsRequests: TTSRequest[]
  ): Promise<string[]> {
    // Group requests by speaker to ensure we use the correct reference audio for each speaker
    const mergedData = transcript.map((transcriptItem, index) => {
      const ttsRequest = ttsRequests[index];
      return { ...transcriptItem, ...ttsRequest };
    });

    const requestsBySpeaker: { [speaker: string]: ZyphraTTSRequest[] } = {};

    for (const request of mergedData) {
      const speaker = request.speaker || "default";
      if (!requestsBySpeaker[speaker]) {
        requestsBySpeaker[speaker] = [];
      }

      // Convert TTSRequest to ZyphraTTSRequest
      const zyphraRequest: ZyphraTTSRequest = {
        ...request,
        emotion: request.emotion || undefined,
      };

      requestsBySpeaker[speaker].push(zyphraRequest);
    }

    // Process each speaker's requests with their reference audio
    const allResults: string[] = [];
    for (const speaker in requestsBySpeaker) {
      const speakerRequests = requestsBySpeaker[speaker];

      // Get reference audio for this speaker if available
      const referenceAudio =
        this.speakerReferenceProcessor.getReferenceAudio(speaker);
      if (referenceAudio) {
        // Set reference audio path for all requests from this speaker
        speakerRequests.forEach((req) => {
          req.referenceAudioPath = referenceAudio;
        });
      }

      const results = await this.zyphraTTS.processZypMultipleTTS(
        speakerRequests
      );
      allResults.push(...(results as string[]));
    }

    return allResults;
  }

  async separateOriginalAudio(
    originalAudioUrl: string,
    transcript: Transcript[]
  ): Promise<string> {
    const originalPath = await this.fileProcessor.downloadAndConvertAudio(
      originalAudioUrl
    );
    const spleeterOutputDir = await this.fileProcessor.createTempDir(
      "spleeter_output"
    );

    try {
      const scriptPath = path.resolve("./src/script/separate_audio.py");
      await execAsync(
        `python3 "${scriptPath}" "${originalPath}" "${spleeterOutputDir}"`
      );

      const subdirs = await fs.readdir(spleeterOutputDir);
      if (!subdirs.length) {
        throw new Error("No subdirectories found in Spleeter output.");
      }

      // Get vocals for voice cloning
      const vocalsPath = path.join(spleeterOutputDir, subdirs[0], "vocals.wav");
      await this.fileProcessor.verifyFile(vocalsPath);

      // Get accompaniment for background
      const accompanimentPath = path.join(
        spleeterOutputDir,
        subdirs[0],
        "accompaniment.wav"
      );
      await this.fileProcessor.verifyFile(accompanimentPath);

      // Extract speaker references using transcript timestamps
      await this.speakerReferenceProcessor.extractSpeakerReferences(
        vocalsPath,
        transcript
      );

      return accompanimentPath;
    } catch (error) {
      console.error("Spleeter processing failed:", error);
      throw new Error(`Spleeter processing failed: ${error}`);
    }
  }

  async combineAllSpeechWithBackground(
    speechFiles: string[],
    backgroundTrack: string,
    transcript: Transcript[]
  ): Promise<string> {
    return this.audioCombiner.combineAudioFiles(
      backgroundTrack,
      speechFiles,
      transcript
    );
  }

  async uploadToStorage(filePath: string): Promise<string> {
    return this.storageProcessor.uploadToStorage(filePath);
  }
}
