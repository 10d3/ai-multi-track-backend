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

      // Combine all segments with concat demuxer preserving audio fidelity
      await execAsync(
        `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c:a pcm_s16le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} -y "${finalPath}"`
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
      // Subtle background cleaning that preserves original character while reducing noise
      const ffmpegCmd = `ffmpeg -i "${inputPath}" -af "
        lowpass=f=16000,
        highpass=f=40,
        anlmdn=s=5:p=0.001:r=0.001:m=15:b=5,
        asplit=2[a][b];
        [a]aformat=channel_layouts=stereo,highshelf=f=8000:g=-3,lowshelf=f=250:g=-1[a1];
        [b]aformat=channel_layouts=stereo,highshelf=f=8000:g=-6,lowshelf=f=250:g=-3,volume=0.2[b1];
        [a1][b1]amix=inputs=2:weights=0.85 0.15
      " -af aresample=resampler=soxr:precision=24 -c:a pcm_s16le -y "${outputPath}"`;

      await execAsync(ffmpegCmd.replace(/\s+/g, " "));
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

      // Extract the background segment for this time range with exact copy settings
      const bgSegmentPath = path.join(outputDir, `bg_segment_${index}.wav`);

      // Extract segment while preserving original audio quality
      await execAsync(
        `ffmpeg -ss ${startTime} -t ${duration} -i "${backgroundPath}" -c:a pcm_s16le -ar 48000 -y "${bgSegmentPath}"`
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

      // Audio mixing that preserves original character while balancing speech and background
      const ffmpegCmd = `ffmpeg -i "${speechPath}" -i "${bgSegmentPath}" -filter_complex "
        [0:a]volume=${speechVolumeAdjust},
          afftdn=nr=0.5:nf=-40[speech];
        [1:a]volume=${bgVolumeAdjust}[bg];
        [speech][bg]amix=inputs=2:weights=${speechWeight} ${bgWeight}:normalize=0,
          afftdn=nr=0.15:nf=-60:tn=0
      " -map 0:a -c:a pcm_s16le -y "${outputPath}"`;

      await execAsync(ffmpegCmd.replace(/\s+/g, " "));
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
    // Add a safety cap to prevent extreme volume changes
    return Math.min(Math.max(Math.pow(10, dbAdjustment / 20), 0.1), 5.0);
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
      // Extract exact loudness parameters from original audio
      const originalLoudness =
        originalAnalysis.loudness.integrated || AUDIO_PROCESSING.TARGET_LUFS;
      const originalPeak =
        originalAnalysis.loudness.truePeak || AUDIO_PROCESSING.MAX_PEAK_DB;
      const originalLRA = originalAnalysis.loudness.range || 7.0;
      const originalThreshold = originalAnalysis.loudness.threshold || -25.0;

      // Copy-conform final processing that matches the original audio's character exactly
      const ffmpegCmd = `ffmpeg -i "${inputPath}" -af "
        loudnorm=I=${originalLoudness}:TP=${originalPeak}:
          LRA=${originalLRA}:measured_I=${originalLoudness - 0.2}:
          measured_TP=${originalPeak - 0.2}:
          measured_LRA=${originalLRA - 0.5}:
          measured_thresh=${originalThreshold}:linear=true:print_format=summary,
        aresample=${
          originalAnalysis.format.sampleRate
        }:resampler=soxr:dither_method=rectangular,
        aformat=channel_layouts=${
          originalAnalysis.format.channels == 1 ? "mono" : "stereo"
        }
      " -ar ${originalAnalysis.format.sampleRate} -ac ${
        originalAnalysis.format.channels
      } 
         -c:a pcm_s16le -y "${outputPath}"`;

      await execAsync(ffmpegCmd.replace(/\s+/g, " "));
      await this.fileProcessor.verifyFile(outputPath);

      return outputPath;
    } catch (error) {
      console.error("Final audio processing failed:", error);
      throw new Error(`Final audio processing failed: ${error}`);
    }
  }
}
