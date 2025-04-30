import { promisify } from "util";
import { exec } from "child_process";
import path from "path";
import type { FileProcessor } from "./file-processor";
import type { AudioAnalyzer } from "./audio-analyzer";
import type { Transcript } from "../../types/type";
import fs from "fs/promises";

const execAsync = promisify(exec);

// Define audio processing constants
const AUDIO_PROCESSING = {
  SPEECH_WEIGHT: 1.0,
  BG_WEIGHT: 0.3,
  TARGET_LUFS: -16,
  MAX_PEAK_DB: -1.5,
};

export class AudioCombiner {
  private fileProcessor: FileProcessor;
  private audioAnalyzer: AudioAnalyzer;

  constructor(fileProcessor: FileProcessor, audioAnalyzer: AudioAnalyzer) {
    this.fileProcessor = fileProcessor;
    this.audioAnalyzer = audioAnalyzer;
  }

  async combineAudioFiles(
    backgroundPath: string,
    speechPaths: string[],
    transcript: Transcript[]
  ): Promise<string> {
    try {
      if (!backgroundPath || !speechPaths.length) {
        throw new Error("Missing required audio files for combination");
      }

      // First analyze the background audio to get its characteristics
      console.log("Analyzing background audio characteristics...");
      const bgAnalysis = await this.audioAnalyzer.analyzeAudio(backgroundPath);

      console.log("Background audio analysis:", {
        duration: bgAnalysis.duration,
        sampleRate: bgAnalysis.format.sampleRate,
        channels: bgAnalysis.format.channels,
        loudness: bgAnalysis.loudness.integrated,
        truePeak: bgAnalysis.loudness.truePeak,
      });

      // Clean the background track to improve quality
      console.log("Cleaning background audio track...");
      const cleanedBgPath = await this.cleanBackgroundTrack(backgroundPath);

      // Create a temporary directory for the combined audio segments
      const outputDir = await this.fileProcessor.createTempDir(
        "combined_segments"
      );

      // Process each speech segment and position it correctly
      const segmentPaths: string[] = [];

      for (let i = 0; i < speechPaths.length; i++) {
        const segment = transcript[i];
        if (
          !segment ||
          segment.start === undefined ||
          segment.end === undefined
        ) {
          console.warn(`Missing transcript data for segment ${i}, skipping`);
          continue;
        }

        const segmentPath = await this.createSegmentWithBackground(
          cleanedBgPath,
          speechPaths[i],
          segment.start,
          segment.end,
          outputDir,
          i,
          bgAnalysis
        );

        if (segmentPath) {
          segmentPaths.push(segmentPath);
        }
      }

      if (!segmentPaths.length) {
        throw new Error("No valid segments were created");
      }

      // Combine all segments into the final audio
      const finalPath = await this.fileProcessor.createTempPath(
        "final_audio",
        "wav"
      );

      // Create a file list for ffmpeg concat
      const fileListPath = await this.fileProcessor.createTempPath(
        "file_list",
        "txt"
      );
      const fileListContent = segmentPaths
        .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
        .join("\n");

      await fs.writeFile(fileListPath, fileListContent);

      // Combine all segments
      await execAsync(
        `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c:a pcm_s16le "${finalPath}"`
      );

      // Apply final audio processing to match original characteristics
      const processedPath = await this.applyFinalProcessing(
        finalPath,
        bgAnalysis
      );

      return processedPath;
    } catch (error) {
      console.error("Error combining audio files:", error);
      throw error;
    }
  }

  private async cleanBackgroundTrack(inputPath: string): Promise<string> {
    const outputPath = await this.fileProcessor.createTempPath(
      "cleaned_bg",
      "wav"
    );

    try {
      // Remove extra spaces and use correct filter syntax
      const ffmpegCmd = `ffmpeg -i "${inputPath}" -af highpass=f=50,lowpass=f=15000,afftdn=nf=-25,equalizer=f=200:t=q:w=1:g=-2,equalizer=f=1000:t=q:w=1:g=-1,compand=attacks=0.3:points=-70/-90|-24/-12|0/-6|20/-3:gain=3 -y "${outputPath}"`;

      console.log("Executing FFmpeg command:", ffmpegCmd);

      await execAsync(ffmpegCmd);
      await this.fileProcessor.verifyFile(outputPath);

      return outputPath;
    } catch (error) {
      console.error("Background cleaning failed:", error);
      throw new Error(`Background cleaning failed: ${error}`);
    }
  }

  private async createSegmentWithBackground(
    backgroundPath: string,
    speechPath: string,
    startTime: number,
    endTime: number,
    outputDir: string,
    index: number,
    bgAnalysis: any
  ): Promise<string | null> {
    try {
      const duration = endTime - startTime;
      if (duration <= 0) {
        console.warn(`Invalid duration for segment ${index}: ${duration}s`);
        return null;
      }

      // Extract the background segment for this time range
      const bgSegmentPath = path.join(outputDir, `bg_segment_${index}.wav`);
      await execAsync(
        `ffmpeg -i "${backgroundPath}" -ss ${startTime} -t ${duration} -c:a pcm_s16le "${bgSegmentPath}"`
      );

      // Analyze the speech segment to match levels appropriately
      const speechAnalysis = await this.audioAnalyzer.analyzeAudio(speechPath);

      // Create the mixed segment
      const outputPath = path.join(outputDir, `mixed_segment_${index}.wav`);

      // Use filter_complex to mix the audio with proper volume adjustment based on analysis
      const speechWeight = AUDIO_PROCESSING.SPEECH_WEIGHT;
      const bgWeight = AUDIO_PROCESSING.BG_WEIGHT;

      // Calculate volume adjustments based on analysis
      const speechVolumeAdjust = this.calculateVolumeAdjustment(
        speechAnalysis.loudness.integrated,
        AUDIO_PROCESSING.TARGET_LUFS
      );

      const bgVolumeAdjust = this.calculateVolumeAdjustment(
        bgAnalysis.loudness.integrated,
        AUDIO_PROCESSING.TARGET_LUFS - 10 // Background 10dB quieter than target
      );

      // Mix the audio with proper volume adjustment
      const ffmpegCmd = `ffmpeg -i "${speechPath}" -i "${bgSegmentPath}" -filter_complex "[0:a]volume=${speechVolumeAdjust}[speech];[1:a]volume=${bgVolumeAdjust}[bg];[speech][bg]amix=inputs=2:weights=${speechWeight} ${bgWeight}:normalize=0[out]" -map "[out]" -c:a pcm_s16le "${outputPath}"`;

      await execAsync(ffmpegCmd);
      await this.fileProcessor.verifyFile(outputPath);

      return outputPath;
    } catch (error) {
      console.error(`Error creating segment ${index}:`, error);
      return null;
    }
  }

  private calculateVolumeAdjustment(
    currentLUFS: number,
    targetLUFS: number
  ): number {
    // Calculate volume adjustment factor (in dB)
    const dbAdjustment = targetLUFS - currentLUFS;

    // Convert dB to amplitude ratio (10^(dB/20))
    return Math.pow(10, dbAdjustment / 20);
  }

  private async applyFinalProcessing(
    inputPath: string,
    originalAnalysis: any
  ): Promise<string> {
    const outputPath = await this.fileProcessor.createTempPath(
      "processed_final",
      "wav"
    );

    try {
      // Apply loudness normalization and limiting to match original characteristics
      const ffmpegCmd = `ffmpeg -i "${inputPath}" -af "
        loudnorm=I=${AUDIO_PROCESSING.TARGET_LUFS}:TP=${
        AUDIO_PROCESSING.MAX_PEAK_DB
      }:LRA=${originalAnalysis.loudness.range}:print_format=summary,
        aresample=${originalAnalysis.format.sampleRate}:resampler=soxr,
        aformat=channel_layouts=${
          originalAnalysis.format.channels == 1 ? "mono" : "stereo"
        }
      " -ar ${originalAnalysis.format.sampleRate} -ac ${
        originalAnalysis.format.channels
      } -c:a pcm_s16le -y "${outputPath}"`;

      await execAsync(ffmpegCmd.replace(/\s+/g, " "));
      await this.fileProcessor.verifyFile(outputPath);

      return outputPath;
    } catch (error) {
      console.error("Final audio processing failed:", error);
      throw new Error(`Final audio processing failed: ${error}`);
    }
  }
}
