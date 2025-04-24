import { promisify } from "util";
import type { Transcript, TTSRequest } from "../types/type";
import { AudioAnalyzer } from "./processor/audio-analyzer";
import { AudioCombiner } from "./processor/audio-combiner";
import { FileProcessor } from "./processor/file-processor";
import { StorageProcessor } from "./processor/storage-processor";
import { TTSProcessor } from "./processor/tts-processor";
import path from "path";
import { exec } from "child_process";
import fs from "fs/promises"

const execAsync = promisify(exec);

export class AudioProcessor {
  private fileProcessor: FileProcessor;
  private ttsProcessor: TTSProcessor;
  private audioAnalyzer: AudioAnalyzer;
  private audioCombiner: AudioCombiner;
  private storageProcessor: StorageProcessor;

  constructor() {
    this.fileProcessor = new FileProcessor();
    this.ttsProcessor = new TTSProcessor(this.fileProcessor);
    this.audioAnalyzer = new AudioAnalyzer(this.fileProcessor);
    this.audioCombiner = new AudioCombiner(
      this.fileProcessor,
      this.audioAnalyzer
    );
    this.storageProcessor = new StorageProcessor(this.fileProcessor);
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

  async processMultipleTTS(ttsRequests: TTSRequest[]): Promise<string[]> {
    return this.ttsProcessor.processMultipleTTS(ttsRequests);
  }

  async separateOriginalAudio(originalAudioUrl: string): Promise<string> {
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

      const accompanimentPath = path.join(
        spleeterOutputDir,
        subdirs[0],
        "accompaniment.wav"
      );
      await this.fileProcessor.verifyFile(accompanimentPath);

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
    return this.audioCombiner.combineAllSpeechWithBackground(
      speechFiles,
      backgroundTrack,
      transcript
    );
  }

  async uploadToStorage(filePath: string): Promise<string> {
    return this.storageProcessor.uploadToStorage(filePath);
  }
}
