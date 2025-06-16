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
import { mkdtemp, rm } from "fs/promises";
import os from "os";

const execAsync = promisify(exec);

// A helper type for parsed loudnorm statistics
type LoudnormStats = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  output_i: string;
  output_tp: string;
  output_lra: string;
  output_thresh: string;
  target_offset: string;
};

/**
 * Parses the JSON output from ffmpeg's loudnorm filter stderr.
 * @param ffmpegStderr The raw stderr string from the ffmpeg command.
 * @returns The parsed loudnorm statistics object.
 */
function parseLoudnormStats(ffmpegStderr: string): LoudnormStats {
    // Ffmpeg prints the JSON stats within its verbose output. We need to find
    // the JSON block, which starts with '{' and ends with '}'.
    const jsonStart = ffmpegStderr.indexOf('{');
    const jsonEnd = ffmpegStderr.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
        throw new Error("Could not find loudnorm JSON stats in ffmpeg output.");
    }
    const jsonString = ffmpegStderr.substring(jsonStart, jsonEnd + 1);
    return JSON.parse(jsonString) as LoudnormStats;
}

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
        enhanceSpeech: true,
        removeSilence: false, // Don't remove silence from final audio (might cut speech)
        useAINoise: true,
        sampleRate: 44100, // Higher quality for final output
        targetLoudness: -16, // Broadcast standard for final audio
      });

      console.log(`Final audio enhanced with ${quality} quality`);
      return enhancedPath;
    } catch (error) {
      console.warn("Final audio enhancement failed, using original:", error);
      return inputPath; // Fallback to original if enhancement fails
    }
  }

  /**
   * FFmpeg Advanced Multi-Pass Audio Processing for speech enhancement
   */
  private async processAudioFFmpeg6(
    inputPath: string,
    outputPath: string,
    options: {
      sampleRate?: number;
      targetLoudness?: number;
      useAINoise?: boolean;
      removeSilence?: boolean;
      enhanceSpeech?: boolean;
      quality?: "standard" | "high" | "ultra";
    } = {}
  ): Promise<void> {
    const {
      sampleRate = 48000,
      targetLoudness = -16.0,
      useAINoise = true,
      removeSilence = true,
      enhanceSpeech = true,
      quality = "high",
    } = options;

    // --- Temporary Directory Setup ---
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "audio-enhancer-"));
    const tempDenoised = path.join(tempDir, "denoised.wav");
    const tempDynamics = path.join(tempDir, "dynamics.wav");
    const tempSilence = path.join(tempDir, "silence.wav");

    console.log(`Created temporary directory: ${tempDir}`);

    try {
      // =========================================================================
      // PASS 1: Denoising & Speech Normalization
      // =========================================================================
      console.log("\nPASS 1: Applying Denoising and Speech Normalization...");
      
      let pass1Filters = "";
      if (enhanceSpeech) {
        pass1Filters += "speechnorm=e=12.5:r=0.0005,";
      }
      if (useAINoise) {
        pass1Filters += "afftdn=nf=-25:nr=33,";
      }
      pass1Filters += "highpass=f=80";

      await execAsync(
        `ffmpeg -y -i "${inputPath}" -af "${pass1Filters}" -ar ${sampleRate} -c:a pcm_s24le "${tempDenoised}"`
      );

      // =========================================================================
      // PASS 2: Dynamics Compression & Equalization
      // =========================================================================
      console.log("\nPASS 2: Applying Dynamics Compression and Equalization...");
      let compressor: string, eq: string;

      switch (quality) {
        case "standard":
          compressor = "acompressor=threshold=0.09:ratio=2:attack=20:release=250";
          eq = "superequalizer=1b=10:2b=8:3b=10:4b=12:5b=10:6b=8:7b=10:8b=12:9b=14:10b=12:11b=10";
          break;
        case "ultra":
          compressor = "acompressor=threshold=0.15:ratio=4:attack=5:release=150";
          eq = "superequalizer=1b=10:2b=8:3b=10:4b=13:5b=10:6b=8:7b=12:8b=14:9b=16:10b=14:11b=12";
          break;
        case "high":
        default:
          compressor = "acompressor=threshold=0.12:ratio=3:attack=10:release=200";
          eq = "superequalizer=1b=10:2b=8:3b=10:4b=12:5b=10:6b=8:7b=11:8b=13:9b=15:10b=13:11b=11";
          break;
      }

      const pass2Filters = `${compressor},${eq},lowpass=f=20000`;
      await execAsync(
        `ffmpeg -y -i "${tempDenoised}" -af "${pass2Filters}" -ar ${sampleRate} -c:a pcm_s24le "${tempDynamics}"`
      );

      // =========================================================================
      // OPTIONAL PASS: Silence Removal
      // =========================================================================
      let currentInputForLoudnorm = tempDynamics;
      if (removeSilence) {
          console.log("\nOPTIONAL PASS: Removing silence...");
          const silenceFilter = "silenceremove=start_periods=1:start_duration=0.7:start_threshold=-55dB:stop_periods=-1:stop_duration=0.7:stop_threshold=-55dB";
          await execAsync(
              `ffmpeg -y -i "${tempDynamics}" -af "${silenceFilter}" -ar ${sampleRate} -c:a pcm_s24le "${tempSilence}"`
          );
          currentInputForLoudnorm = tempSilence;
      }

      // =========================================================================
      // FINAL PASS (A & B): Two-Pass Loudness Normalization
      // =========================================================================

      // --- 3A: Analysis Run ---
      console.log("\nFINAL PASS (A): Analyzing for Loudness Normalization...");
      const loudnormAnalysisCommand = `ffmpeg -i "${currentInputForLoudnorm}" -af loudnorm=I=${targetLoudness}:TP=-1.5:LRA=11:print_format=json -f null -`;
      
      let analysisOutput = '';
      try {
          // exec throws an error on non-zero exit codes, but ffmpeg with -f null
          // intentionally exits with an error code, so we catch it to get stderr.
          await execAsync(loudnormAnalysisCommand);
      } catch (error: any) {
          analysisOutput = error.stderr;
      }

      const stats = parseLoudnormStats(analysisOutput);
      console.log("Loudnorm Analysis Complete:");
      console.log(`  - Measured I: ${stats.input_i}`);
      console.log(`  - Target Offset: ${stats.target_offset}`);

      // --- 3B: Application Run ---
      console.log("\nFINAL PASS (B): Applying Loudness Normalization...");
      const finalLoudnormFilter = `loudnorm=I=${targetLoudness}:TP=-1.5:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`;
      
      await execAsync(
        `ffmpeg -y -i "${currentInputForLoudnorm}" -af "${finalLoudnormFilter}" -ar ${sampleRate} -c:a pcm_s16le "${outputPath}"`
      );

      console.log(`\n✅ Audio processing complete!`);
      console.log(`Final file saved to: ${outputPath}`);

    } catch (error) {
      console.error("An error occurred during audio processing:", error);
      // Include stderr in the error output if it's an exec error
      if ((error as any).stderr) {
        console.error("FFmpeg stderr:", (error as any).stderr);
      }
      throw error; // Re-throw the error to be handled by the caller
    } finally {
      // --- Cleanup ---
      console.log("\nCleaning up temporary files...");
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
