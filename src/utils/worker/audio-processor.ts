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

  /**
   * Process audio URLs by downloading and converting them
   */
  async processAudioUrls(audioUrls: string[]): Promise<string[]> {
    const convertedPaths: string[] = [];
    for (const url of audioUrls) {
      const wavPath = await this.fileProcessor.downloadAndConvertAudio(url);
      convertedPaths.push(wavPath);
    }
    return convertedPaths;
  }

  /**
   * Process multiple TTS requests with proper reference audio handling
   */
  async processMultipleTTS(
    transcript: Transcript[],
    ttsRequests: TTSRequest[],
    originalAudioUrl?: string,
    language?: string
  ): Promise<string[]> {
    // Merge transcript and TTS requests with proper typing
    const mergedRequests = transcript.map((segment, index) => {
      const ttsRequest = ttsRequests[index];
      return {
        ...ttsRequest,
        speaker: segment.speaker,
        start: segment.start,
        end: segment.end,
        language_iso_code: language,
      } as ZyphraTTSRequest & { speaker?: string };
    });

    // Group by speaker for efficient processing
    const requestsBySpeaker: {
      [speaker: string]: (ZyphraTTSRequest & { speaker?: string })[];
    } = {};

    for (const request of mergedRequests) {
      const speaker = request.speaker || "default";
      if (!requestsBySpeaker[speaker]) {
        requestsBySpeaker[speaker] = [];
      }
      requestsBySpeaker[speaker].push(request);
    }

    const allResults: string[] = [];
    const speakerResults: { [speaker: string]: string[] } = {};

    // Process each speaker
    for (const [speaker, requests] of Object.entries(requestsBySpeaker)) {
      // Get or create reference audio for voice cloning
      let referenceAudio =
        this.speakerReferenceProcessor.getReferenceAudio(speaker);

      const needsCloning = requests.some(
        (req) => req.voice_id === "cloning-voice"
      );

      if (needsCloning && !referenceAudio && originalAudioUrl) {
        // Create reference audio from original
        const originalPath = await this.fileProcessor.downloadAndConvertAudio(
          originalAudioUrl
        );
        const speakerTranscript = transcript.filter(
          (t) => t.speaker === speaker
        );

        const referenceMap =
          await this.speakerReferenceProcessor.createReferenceAudio(
            originalPath,
            speakerTranscript
          );
        referenceAudio = referenceMap.get(speaker);
      }

      // Add reference audio to requests
      for (const request of requests) {
        if (request.voice_id === "cloning-voice") {
          if (referenceAudio) {
            request.referenceAudioPath = referenceAudio;
          } else {
            // Fallback to default voice if no reference audio
            request.voice_id = "american-male";
            console.warn(
              `No reference audio for speaker ${speaker}, using default voice`
            );
          }
        }
      }

      // Generate TTS for this speaker
      const results = await this.zyphraTTS.processMultipleTTS(
        requests,
        language || "en"
      );
      speakerResults[speaker] = results;
    }

    // Reconstruct results in original order
    let speakerIndexes: { [speaker: string]: number } = {};

    for (const segment of transcript) {
      const speaker = segment.speaker || "default";
      const index = speakerIndexes[speaker] || 0;

      if (speakerResults[speaker] && speakerResults[speaker][index]) {
        allResults.push(speakerResults[speaker][index]);
        speakerIndexes[speaker] = index + 1;
      }
    }

    return allResults;
  }

  /**
   * Separate original audio into vocals and accompaniment
   */
  async separateOriginalAudio(
    originalAudioUrl: string,
    transcript: Transcript[]
  ): Promise<string> {
    const originalPath = await this.fileProcessor.downloadAndConvertAudio(
      originalAudioUrl
    );
    const outputDir = await this.fileProcessor.createTempDir("spleeter_output");

    const scriptPath = path.resolve("./src/script/separate_audio.py");
    await execAsync(`python3 "${scriptPath}" "${originalPath}" "${outputDir}"`);

    const subdirs = await fs.readdir(outputDir);
    if (!subdirs.length) {
      throw new Error("Audio separation failed");
    }

    const vocalsPath = path.join(outputDir, subdirs[0], "vocals.wav");
    const accompanimentPath = path.join(
      outputDir,
      subdirs[0],
      "accompaniment.wav"
    );

    await this.fileProcessor.verifyFile(vocalsPath);
    await this.fileProcessor.verifyFile(accompanimentPath);

    // Create speaker reference audio from vocals
    await this.speakerReferenceProcessor.createReferenceAudio(
      vocalsPath,
      transcript
    );

    return accompanimentPath;
  }

  /**
   * Combine all speech files with background music
   */
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

  /**
   * Upload file to storage
   */
  async uploadToStorage(filePath: string): Promise<string> {
    return this.storageProcessor.uploadToStorage(filePath);
  }
}
