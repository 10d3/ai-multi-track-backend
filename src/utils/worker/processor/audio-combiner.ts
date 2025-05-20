import { promisify } from "util";
import { exec } from "child_process";
import path from "path";
import type { FileProcessor } from "./file-processor";
import type { AudioAnalyzer } from "./audio-analyzer";
import type { Transcript } from "../../types/type";
import fs from "fs/promises";

const execAsync = promisify(exec);

export class AudioCombiner {
  private fileProcessor: FileProcessor;
  private audioAnalyzer: AudioAnalyzer;

  constructor(fileProcessor: FileProcessor, audioAnalyzer: AudioAnalyzer) {
    this.fileProcessor = fileProcessor;
    this.audioAnalyzer = audioAnalyzer;
  }

  async combineAudioFiles(
    backgroundPath: string | null,
    speechPaths: string[],
    transcript: Transcript[]
  ): Promise<string> {
    try {
      if (!speechPaths.length) {
        throw new Error("Missing required speech files for combination");
      }

      // Create a temporary directory for the combined audio segments
      const outputDir = await this.fileProcessor.createTempDir(
        "combined_segments"
      );

      // Process each speech segment and prepare filter complex
      const speechSegmentPaths = [];

      // First, create processed speech segments with consistent quality
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

        // Process each speech file to ensure consistent quality
        const processedSpeechPath = await this.processSpeechForConsistency(
          speechPaths[i],
          outputDir,
          i,
          backgroundPath ? await this.audioAnalyzer.analyzeAudio(backgroundPath) : null
        );

        speechSegmentPaths.push({
          path: processedSpeechPath,
          start: segment.start,
          end: segment.end,
          originalIndex: i,
        });
      }

      // Sort speech segments by start time
      speechSegmentPaths.sort((a, b) => a.start - b.start);

      let filterComplex = "";
      let inputArgs = "";

      if (backgroundPath) {
        // If we have background, analyze it and create silent background
        const bgAnalysis = await this.audioAnalyzer.analyzeAudio(backgroundPath);
        const silentBgPath = await this.fileProcessor.createTempPath(
          "silent_bg",
          "wav"
        );

        await execAsync(
          `ffmpeg -threads 2 -f lavfi -i anullsrc=r=${
            bgAnalysis.format.sampleRate
          }:cl=${bgAnalysis.format.channels === 1 ? "mono" : "stereo"} -t ${
            bgAnalysis.duration
          } -c:a pcm_s24le "${silentBgPath}"`
        );

        inputArgs = `-threads 2 -i "${silentBgPath}" `;
      }

      // Add each speech input to filter with proper delay based on start time
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];
        const inputIndex = backgroundPath ? i + 1 : i;

        inputArgs += `-i "${segment.path}" `;
        filterComplex += `[${inputIndex}:a]adelay=${Math.round(
          segment.start * 1000
        )}|${Math.round(segment.start * 1000)}[speech${i}];`;
      }

      // Build mix chain
      if (speechSegmentPaths.length > 0) {
        if (backgroundPath) {
          filterComplex += `[0:a]`;
          for (let i = 0; i < speechSegmentPaths.length; i++) {
            filterComplex += `[speech${i}]`;
          }
          filterComplex += `amix=inputs=${
            speechSegmentPaths.length + 1
          }:duration=first[speechmix];`;

          // Reduce background volume significantly
          filterComplex += `[${speechSegmentPaths.length + 1}:a]volume=0.2[bg];`;

          // Final mix of speech and background
          filterComplex += `[speechmix][bg]amix=inputs=2:duration=first[out]`;

          // Add original background track
          inputArgs += `-i "${backgroundPath}" `;
        } else {
          // If no background, just mix the speech segments
          for (let i = 0; i < speechSegmentPaths.length; i++) {
            filterComplex += `[speech${i}]`;
          }
          filterComplex += `amix=inputs=${speechSegmentPaths.length}:duration=first[out]`;
        }
      }

      // Final output path
      const finalPath = await this.fileProcessor.createTempPath(
        "final_audio",
        "wav"
      );

      // Execute ffmpeg with filter complex
      await execAsync(
        `ffmpeg ${inputArgs} -filter_complex "${filterComplex.replace(
          /\s+/g,
          " "
        )}" -map "[out]" -c:a pcm_s24le "${finalPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(finalPath);

      return finalPath;
    } catch (error) {
      console.error("Error combining audio files:", error);
      throw error;
    }
  }

  private async processSpeechForConsistency(
    speechPath: string,
    outputDir: string,
    index: number,
    bgAnalysis: any | null
  ): Promise<string> {
    try {
      console.log(`Processing speech file ${index} (boosting volume)...`);

      // Create a processed speech file path
      const processedPath = path.join(
        outputDir,
        `processed_speech_${index}.wav`
      );

      // Default format parameters if no background analysis
      const sampleRate = bgAnalysis?.format.sampleRate || 44100;
      const channels = bgAnalysis?.format.channels || 2;
      const channelLayout = channels === 1 ? "mono" : "stereo";

      // Apply format conversion and volume boost
      const boostFilter = `aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=${channelLayout},volume=3.0`;

      // Process the speech file with volume boost
      await execAsync(
        `ffmpeg -threads 2 -i "${speechPath}" -af "${boostFilter}" -c:a pcm_s24le -ar ${sampleRate} -ac ${channels} "${processedPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(processedPath);

      return processedPath;
    } catch (error) {
      console.error(`Error processing speech file ${index}:`, error);
      throw error;
    }
  }

  private async applyConsistentFinalProcessing(
    inputPath: string,
    originalAnalysis: any
  ): Promise<string> {
    try {
      console.log("Applying final processing with speech volume emphasis...");

      // Create an output path
      const outputPath = await this.fileProcessor.createTempPath(
        "final_processed",
        "wav"
      );

      // Extract basic format parameters
      const channelLayout =
        originalAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Final processing to ensure speech is audible
      // Simple dynamic range compression to bring up speech volume
      const finalFilter = `aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout},
      compand=attacks=0.01:decays=0.2:points=-80/-80|-50/-25|-30/-15|-5/-5|0/-2:soft-knee=2:gain=6`;

      // Process the final audio with volume enhancement
      await execAsync(
        `ffmpeg -threads 2 -i "${inputPath}" -af "${finalFilter}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} "${outputPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(outputPath);

      // Verify final length matches original background
      const finalAnalysis = await this.audioAnalyzer.analyzeAudio(outputPath);
      console.log("Final audio validation:", {
        originalDuration: originalAnalysis.duration.toFixed(3) + "s",
        finalDuration: finalAnalysis.duration.toFixed(3) + "s",
        difference:
          Math.abs(originalAnalysis.duration - finalAnalysis.duration).toFixed(
            3
          ) + "s",
      });

      return outputPath;
    } catch (error) {
      console.error("Error applying final processing:", error);
      throw error;
    }
  }
}
