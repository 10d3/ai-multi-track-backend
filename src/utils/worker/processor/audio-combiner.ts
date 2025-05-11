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

      // Clean the background track to improve quality
      console.log("Cleaning background audio track...");
      const cleanedBgPath = await this.cleanBackgroundTrack(backgroundPath);

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
          cleanedBgPath,
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
            isValid: validation.isValid
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
      const invalidSegments = segmentValidations.filter(v => !v.isValid);
      if (invalidSegments.length > 0) {
        console.warn(`${invalidSegments.length} segments have timing issues:`, invalidSegments);
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
      
      // Validate final audio against original characteristics
      const finalValidation = await this.audioAnalyzer.validateFinalAudio(
        processedPath,
        bgAnalysis
      );
      
      console.log("Final audio validation results:", finalValidation);
      
      // If validation fails but audio is still usable, log warning but continue
      if (!finalValidation.isValid) {
        console.warn("Final audio does not perfectly match original characteristics:", 
          finalValidation.details);
      }

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
      const args = [
        "-i",
        inputPath,
        "-af",
        FFMPEG_FILTERS.BACKGROUND_CLEANING,
        "-y",
        outputPath,
      ];

      const { spawn } = require("child_process");

      return new Promise((resolve, reject) => {
        const process = spawn("ffmpeg", args);

        process.on("close", async (code: any) => {
          if (code === 0) {
            await this.fileProcessor.verifyFile(outputPath);
            resolve(outputPath);
          } else {
            reject(new Error(`FFmpeg process exited with code ${code}`));
          }
        });

        process.on("error", (err: any) => {
          reject(new Error(`Failed to start FFmpeg process: ${err.message}`));
        });
      });
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
      
      // Add a small padding to ensure we don't cut off speech
      const paddingMs = AUDIO_PROCESSING.SEGMENT_PADDING_MS;
      const paddingSec = paddingMs / 1000;
      
      // Calculate precise timing with padding
      const extractStart = Math.max(0, startTime - paddingSec);
      const extractDuration = duration + (paddingSec * 2);
      
      console.log(`Creating segment ${index} with precise timing:`, {
        originalStart: startTime,
        originalEnd: endTime,
        originalDuration: duration,
        extractStart,
        extractDuration,
        paddingMs
      });

      // Extract the background segment for this time range
      const bgSegmentPath = path.join(outputDir, `bg_segment_${index}.wav`);
      await execAsync(
        `ffmpeg -i "${backgroundPath}" -ss ${extractStart} -t ${extractDuration} -c:a pcm_s16le "${bgSegmentPath}"`
      );

      // Analyze speech file to get its characteristics
      const speechAnalysis = await this.audioAnalyzer.analyzeAudio(speechPath);
      
      // Verify speech file duration is close to expected duration
      const speechDuration = speechAnalysis.duration;
      const durationDiff = Math.abs(speechDuration - duration);
      
      if (durationDiff > 0.5) { // More than 500ms difference
        console.warn(`Speech segment ${index} duration (${speechDuration}s) differs significantly from transcript timing (${duration}s)`);
      }

      // Process speech to enhance clarity
      const processedSpeechPath = path.join(outputDir, `speech_processed_${index}.wav`);
      await execAsync(
        `ffmpeg -i "${speechPath}" -af "${FFMPEG_FILTERS.SPEECH_ENHANCEMENT}" -c:a pcm_s16le "${processedSpeechPath}"`
      );

      // Mix background and speech with precise volume control
      const outputPath = path.join(outputDir, `combined_segment_${index}.wav`);
      
      // Use filter complex for precise mixing with crossfade
      const filterComplex = `
        [0:a]volume=${AUDIO_PROCESSING.BG_WEIGHT}[bg];
        [1:a]volume=${AUDIO_PROCESSING.SPEECH_WEIGHT}[speech];
        [bg][speech]amix=inputs=2:duration=longest,dynaudnorm[out]
      `;
      
      await execAsync(
        `ffmpeg -i "${bgSegmentPath}" -i "${processedSpeechPath}" -filter_complex "${filterComplex.replace(/\s+/g, ' ')}" -map "[out]" -c:a pcm_s16le "${outputPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(outputPath);
      
      // Validate segment timing
      const segmentAnalysis = await this.audioAnalyzer.analyzeAudio(outputPath);
      console.log(`Segment ${index} created with duration ${segmentAnalysis.duration}s (expected ~${extractDuration}s)`);
      
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
      const targetLufs = AUDIO_PROCESSING.TARGET_LUFS;
      const targetPeak = AUDIO_PROCESSING.MAX_PEAK_DB;
      
      // Use the original audio's characteristics to guide processing
      // Remove soxr resampler since it's not available in the current FFmpeg build
      const filterString = `
        loudnorm=I=${targetLufs}:TP=${targetPeak}:LRA=${originalAnalysis.loudness.range}:
        measured_I=${originalAnalysis.loudness.integrated}:
        measured_TP=${originalAnalysis.loudness.truePeak}:
        measured_LRA=${originalAnalysis.loudness.range}:
        measured_thresh=${originalAnalysis.loudness.threshold}:
        offset=${originalAnalysis.loudness.offset}:
        linear=true:print_format=summary,
        aresample=${originalAnalysis.format.sampleRate},
        aformat=channel_layouts=${originalAnalysis.format.channels == 1 ? 'mono' : 'stereo'}
      `;
      
      // Apply the processing
      await execAsync(
        `ffmpeg -i "${inputPath}" -af "${filterString.replace(/\s+/g, ' ')}" -c:a pcm_s16le -y "${outputPath}"`
      );
      
      // Verify the output file
      await this.fileProcessor.verifyFile(outputPath);
      
      // Analyze the processed file to confirm it matches target characteristics
      const processedAnalysis = await this.audioAnalyzer.analyzeAudio(outputPath);
      
      console.log("Final audio processing results:", {
        original: {
          loudness: originalAnalysis.loudness.integrated,
          peak: originalAnalysis.loudness.truePeak,
          sampleRate: originalAnalysis.format.sampleRate,
          channels: originalAnalysis.format.channels
        },
        processed: {
          loudness: processedAnalysis.loudness.integrated,
          peak: processedAnalysis.loudness.truePeak,
          sampleRate: processedAnalysis.format.sampleRate,
          channels: processedAnalysis.format.channels
        },
        target: {
          loudness: targetLufs,
          peak: targetPeak
        }
      });
      
      return outputPath;
    } catch (error) {
      console.error("Error applying final processing:", error);
      throw new Error(`Final processing failed: ${error}`);
    }
  }
}
