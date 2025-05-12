import { promisify } from "util";
import { exec } from "child_process";
import path from "path";
import type { FileProcessor } from "./file-processor";
import type { AudioAnalyzer } from "./audio-analyzer";
import type { Transcript } from "../../types/type";
import fs from "fs/promises";
import { AUDIO_PROCESSING, FFMPEG_FILTERS } from "./constants";

const execAsync = promisify(exec);

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

      // Skip background cleaning and use original background track directly
      console.log("Using original background track without cleaning...");
      const originalBgPath = backgroundPath;

      // Create a temporary directory for the combined audio segments
      const outputDir = await this.fileProcessor.createTempDir(
        "combined_segments"
      );

      // Process each speech segment and position it correctly
      const segmentPaths: string[] = [];
      const segmentValidations: any[] = [];

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

        // Create segment with precise timing
        const segmentPath = await this.createSegmentWithBackground(
          originalBgPath,
          speechPaths[i],
          segment.start,
          segment.end,
          outputDir,
          i,
          bgAnalysis
        );

        if (segmentPath) {
          // Validate segment timing
          const expectedDuration = segment.end - segment.start;
          const validation = await this.audioAnalyzer.validateSegmentTiming(
            segmentPath,
            expectedDuration,
            0.1 // 100ms tolerance
          );

          segmentValidations.push({
            index: i,
            start: segment.start,
            end: segment.end,
            expectedDuration,
            actualDuration: validation.actualDuration,
            difference: validation.difference,
            isValid: validation.isValid,
          });

          segmentPaths.push(segmentPath);
        }
      }

      if (!segmentPaths.length) {
        throw new Error("No valid segments were created");
      }

      // Log segment validation results
      console.log("Segment timing validation results:", segmentValidations);

      // Check if any segments have timing issues
      const invalidSegments = segmentValidations.filter((v) => !v.isValid);
      if (invalidSegments.length > 0) {
        console.warn(
          `${invalidSegments.length} segments have timing issues:`,
          invalidSegments
        );
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

      // Combine all segments with limited thread usage
      await execAsync(
        `ffmpeg -threads 2 -f concat -safe 0 -i "${fileListPath}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${finalPath}"`
      );

      // Apply final audio processing to match original characteristics
      const processedPath = await this.applyFinalProcessing(
        finalPath,
        bgAnalysis
      );

      // Validate final audio against original characteristics
      const finalValidation = await this.audioAnalyzer.validateFinalAudio(
        processedPath,
        bgAnalysis
      );

      console.log("Final audio validation results:", finalValidation);

      // If validation fails but audio is still usable, log warning but continue
      if (!finalValidation.isValid) {
        console.warn(
          "Final audio does not perfectly match original characteristics:",
          finalValidation.details
        );
      }

      return processedPath;
    } catch (error) {
      console.error("Error combining audio files:", error);
      throw error;
    }
  }

  // cleanBackgroundTrack method removed as we're using original background track directly

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

      // Add a small padding to ensure we don't cut off speech
      const paddingMs = AUDIO_PROCESSING.SEGMENT_PADDING_MS;
      const paddingSec = paddingMs / 1000;

      // Calculate precise timing with padding
      const extractStart = Math.max(0, startTime - paddingSec);
      const extractDuration = duration + paddingSec * 2;

      console.log(`Creating segment ${index} with precise timing:`, {
        originalStart: startTime,
        originalEnd: endTime,
        originalDuration: duration,
        extractStart,
        extractDuration,
        paddingMs,
      });

      // Extract the background segment for this time range with higher quality
      const bgSegmentPath = path.join(outputDir, `bg_segment_${index}.wav`);
      await execAsync(
        `ffmpeg -threads 2 -i "${backgroundPath}" -ss ${extractStart} -t ${extractDuration} -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${bgSegmentPath}"`
      );

      // Skip detailed speech analysis and directly mix with background
      // Mix background and speech with simplified approach
      const outputPath = path.join(outputDir, `combined_segment_${index}.wav`);

      // Simplified filter complex for basic mixing without heavy processing
      const filterComplex = `
        [0:a]aformat=sample_fmts=fltp:sample_rates=${
          bgAnalysis.format.sampleRate
        }:channel_layouts=${
        bgAnalysis.format.channels == 1 ? "mono" : "stereo"
      },volume=${AUDIO_PROCESSING.BG_WEIGHT}[bg];
        [1:a]aformat=sample_fmts=fltp:sample_rates=${
          bgAnalysis.format.sampleRate
        }:channel_layouts=${
        bgAnalysis.format.channels == 1 ? "mono" : "stereo"
      },volume=${AUDIO_PROCESSING.SPEECH_WEIGHT}[speech];
        [bg][speech]amix=inputs=2:duration=longest:weights=${
          AUDIO_PROCESSING.BG_WEIGHT
        } ${AUDIO_PROCESSING.SPEECH_WEIGHT}[out]
      `;

      await execAsync(
        `ffmpeg -threads 2 -i "${bgSegmentPath}" -i "${speechPath}" -filter_complex "${filterComplex.replace(
          /\s+/g,
          " "
        )}" -map "[out]" -c:a pcm_s24le "${outputPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(outputPath);

      // Log segment creation without detailed analysis
      console.log(`Segment ${index} created successfully`);

      return outputPath;
    } catch (error) {
      console.error(`Error creating segment ${index}:`, error);
      throw new Error(`Failed to create segment ${index}: ${error}`);
    }
  }

  private async applyFinalProcessing(
    inputPath: string,
    originalAnalysis: any
  ): Promise<string> {
    try {
      const outputPath = await this.fileProcessor.createTempPath(
        "processed_final",
        "wav"
      );

      // Create a filter string that matches the original audio characteristics
      const targetLufs = originalAnalysis.loudness.integrated; // Use original loudness instead of target

      // Ensure TP is within the valid range of -9 to 0 dB
      const targetPeak = Math.max(
        -9,
        Math.min(-0.5, originalAnalysis.loudness.truePeak)
      );

      console.log(
        `Using normalized TP value: ${targetPeak} (original: ${originalAnalysis.loudness.truePeak})`
      );

      // Simplified filter string with minimal processing
      const filterString = `aformat=sample_fmts=fltp:sample_rates=${
        originalAnalysis.format.sampleRate
      }:channel_layouts=${
        originalAnalysis.format.channels == 1 ? "mono" : "stereo"
      },loudnorm=I=${targetLufs}:TP=${targetPeak}:print_format=summary`;

      // Apply the processing with limited thread usage
      const codecParam = "pcm_s24le"; // Default to 24-bit audio for better quality

      await execAsync(
        `ffmpeg -threads 2 -i "${inputPath}" -af "${filterString}" -c:a ${codecParam} -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} -y "${outputPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(outputPath);

      console.log("Final audio processing completed");

      return outputPath;
    } catch (error) {
      console.error("Error applying final processing:", error);
      throw new Error(`Final processing failed: ${error}`);
    }
  }
}
