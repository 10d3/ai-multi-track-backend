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
   * Upload file to storage with optional final enhancement
   */
  async uploadToStorage(
    filePath: string,
    enhance: boolean = true,
    quality: "standard" | "high" | "ultra" = "high"
  ): Promise<string> {
    let finalPath = filePath;

    if (enhance) {
      console.log(
        `Enhancing final audio with ${quality} quality before upload...`
      );
      finalPath = await this.enhanceFinalAudio(filePath, quality);
    }

    return this.storageProcessor.uploadToStorage(finalPath);
  }

  /**
   * Enhance final combined audio using FFmpeg 6 advanced processing
   */
  private async enhanceFinalAudio(
    inputPath: string,
    quality: "standard" | "high" | "ultra" = "high"
  ): Promise<string> {
    const enhancedPath = await this.fileProcessor.createTempPath(
      "final_enhanced",
      "wav"
    );

    try {
      await this.processAudioFFmpeg6(inputPath, enhancedPath, {
        quality,
        sampleRate: 44100, // Higher quality for final output
      });

      console.log(`Final audio enhanced with ${quality} quality`);
      return enhancedPath;
    } catch (error) {
      console.warn("Final audio enhancement failed, using original:", error);
      return inputPath; // Fallback to original if enhancement fails
    }
  }

  /**
   * Enhanced final audio processing - optimized for speech+music content
   * Removes bass buildup and noise while enhancing speech clarity
   */
  private async processAudioFFmpeg6(
    inputPath: string,
    outputPath: string,
    options: {
      sampleRate?: number;
      quality?: "standard" | "high" | "ultra";
    } = {}
  ): Promise<void> {
    const { sampleRate = 44100, quality = "high" } = options;

    // Optimized filter chain for clean speech+music enhancement
    let filterChain = "";

    if (quality === "standard") {
      // Basic enhancement - fast processing
      filterChain = [
        "highpass=f=80",
        "afftdn=nr=15:nf=-15:nt=w",
        "equalizer=f=1000:width_type=h:width=1.5:g=2",
        "equalizer=f=3000:width_type=h:width=1:g=3",
        "dynaudnorm=p=0.9:m=10:s=20:g=10",
        "lowpass=f=12000"
      ].join(",");
    } else if (quality === "ultra") {
      // Maximum quality enhancement
      filterChain = [
        "highpass=f=80",
        "anlmdn=s=0.00001:p=0.15:r=0.02:m=15",
        "afftdn=nr=25:nf=-25:nt=w",
        "equalizer=f=200:width_type=h:width=2:g=6",
        "equalizer=f=1000:width_type=h:width=1.5:g=3",
        "equalizer=f=3000:width_type=h:width=1:g=4",
        "equalizer=f=8000:width_type=h:width=2:g=2",
        "compand=attacks=0.1:decays=0.2:points=-80/-80|-20/-15|-10/-10|-5/-7|0/-3|20/0",
        "dynaudnorm=p=0.9:m=15:s=30:g=15",
        "lowpass=f=12000"
      ].join(",");
    } else {
      // High quality (default) - balanced processing
      filterChain = [
        "highpass=f=80",
        "anlmdn=s=0.00001:p=0.15:r=0.02:m=15",
        "afftdn=nr=20:nf=-20:nt=w",
        "equalizer=f=200:width_type=h:width=2:g=6",
        "equalizer=f=1000:width_type=h:width=1.5:g=3",
        "equalizer=f=3000:width_type=h:width=1:g=4",
        "equalizer=f=8000:width_type=h:width=2:g=2",
        "compand=attacks=0.1:decays=0.2:points=-80/-80|-20/-15|-10/-10|-5/-7|0/-3|20/0",
        "dynaudnorm=p=0.9:m=15:s=30:g=15",
        "lowpass=f=12000"
      ].join(",");
    }

    console.log(`[AudioProcessor] Applying ${quality} quality enhancement`);

    // Execute enhanced processing
    await execAsync(
      `ffmpeg -y -threads 0 -i "${inputPath}" -af "${filterChain}" -c:a pcm_s24le -ar ${sampleRate} "${outputPath}"`,
      { maxBuffer: 1024 * 1024 * 20 }
    );
  }
}
