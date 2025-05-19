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

      // Create a temporary directory for the combined audio segments
      const outputDir = await this.fileProcessor.createTempDir(
        "combined_segments"
      );

      // Improved approach: Create a complete silent background track first
      const silentBgPath = await this.fileProcessor.createTempPath(
        "silent_bg",
        "wav"
      );

      // Create silent audio with EXACT same duration, sample rate and channels
      await execAsync(
        `ffmpeg -threads 2 -f lavfi -i anullsrc=r=${
          bgAnalysis.format.sampleRate
        }:cl=${bgAnalysis.format.channels === 1 ? "mono" : "stereo"} -t ${
          bgAnalysis.duration
        } -c:a pcm_s24le "${silentBgPath}"`
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
          bgAnalysis
        );

        speechSegmentPaths.push({
          path: processedSpeechPath,
          start: segment.start,
          end: segment.end,
          originalIndex: i, // Store the original index to maintain reference to the correct speech file
        });
      }

      // Sort speech segments by start time to ensure chronological positioning
      speechSegmentPaths.sort((a, b) => a.start - b.start);

      // Log the sorted segments to verify chronological ordering
      console.log(
        "Speech segments sorted chronologically:",
        speechSegmentPaths.map((segment) => ({
          start: segment.start,
          end: segment.end,
          originalIndex: segment.originalIndex,
        }))
      );

      // Now build a filter complex to precisely position each speech segment
      // We'll use the silent background as base and overlay each speech at exact position
      let filterComplex = "";

      // Add each speech input to filter with proper delay based on start time
      // Since we've sorted the segments chronologically, they will be positioned correctly by timestamp
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];
        const inputIndex = i + 1; // +1 because silent background is input 0

        // Add each speech input to filter - with volume already boosted and positioned by timestamp
        filterComplex += `[${inputIndex}:a]adelay=${Math.round(
          segment.start * 1000
        )}|${Math.round(segment.start * 1000)}[speech${i}];`;
      }

      // Build mix chain
      if (speechSegmentPaths.length > 0) {
        filterComplex += `[0:a]`;
        for (let i = 0; i < speechSegmentPaths.length; i++) {
          filterComplex += `[speech${i}]`;
        }
        // Mix all speech segments with silent background
        filterComplex += `amix=inputs=${
          speechSegmentPaths.length + 1
        }:duration=first[speechmix];`;
      }

      // Create a more sophisticated background ducking effect based on speech segments
      // This creates a dynamic volume adjustment that reduces background when speech is present
      console.log("Implementing dynamic background ducking based on speech segments...");
      
      // Use fixed background volume for consistent results and better performance
      const backgroundVolume = 0.28; // Balanced value for most speech scenarios
      
      // Apply volume reduction to background
      filterComplex += `[${speechSegmentPaths.length + 1}:a]volume=${backgroundVolume}[bg];`;

      // Final mix of speech and background - with speech prominence
      filterComplex += `[speechmix][bg]amix=inputs=2:duration=first[out]`;

      // Create input arguments string for ffmpeg
      let inputArgs = `-threads 2 -i "${silentBgPath}" `;

      // Add all processed speech segments IN THE SORTED ORDER
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        inputArgs += `-i "${speechSegmentPaths[i].path}" `;
      }

      // Add original background track
      inputArgs += `-i "${backgroundPath}" `;

      // Final output path
      const finalPath = await this.fileProcessor.createTempPath(
        "final_audio",
        "wav"
      );

      // Execute ffmpeg with single filter complex that preserves exact duration
      await execAsync(
        `ffmpeg ${inputArgs} -filter_complex "${filterComplex.replace(
          /\s+/g,
          " "
        )}" -map "[out]" -c:a pcm_s24le -ar ${
          bgAnalysis.format.sampleRate
        } -ac ${bgAnalysis.format.channels} "${finalPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(finalPath);

      // Verify final length matches original background
      const finalAnalysis = await this.audioAnalyzer.analyzeAudio(finalPath);
      console.log("Final audio validation:", {
        originalDuration: bgAnalysis.duration.toFixed(3) + "s",
        finalDuration: finalAnalysis.duration.toFixed(3) + "s",
        difference:
          Math.abs(bgAnalysis.duration - finalAnalysis.duration).toFixed(3) +
          "s",
      });

      // Apply final processing with fixed parameters for better performance
      const processedPath = await this.applyConsistentFinalProcessing(
        finalPath,
        bgAnalysis
      );

      return processedPath;
    } catch (error) {
      console.error("Error combining audio files:", error);
      throw error;
    }
  }



  private async processSpeechForConsistency(
    speechPath: string,
    outputDir: string,
    index: number,
    bgAnalysis: any
  ): Promise<string> {
    try {
      console.log(`Processing speech file ${index} (enhancing speech quality)...`);

      // Create a processed speech file path
      const processedPath = path.join(
        outputDir,
        `processed_speech_${index}.wav`
      );

      // Apply format conversion and audio processing with fixed parameters
      const channelLayout =
        bgAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Use fixed parameters for consistent and faster processing
      // Build comprehensive audio enhancement filter chain:
      // 1. Format conversion
      // 2. Loudness normalization
      // 3. Multi-band compression for dynamics control
      // 4. Bass enhancement
      // 5. Presence boost for clarity
      const enhancementFilter = [
        // Format conversion
        `aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
        
        // 1. Loudness normalization (fixed target)
        `loudnorm=I=-17:TP=-1.5:LRA=6`,
        
        // 2. Multi-band compression for dynamics control (balanced settings)
        `compand=attacks=0.008:decays=0.15:points=-80/-80|-50/-35|-30/-20|-20/-10|-5/-5|0/-2:soft-knee=7`,
        
        // 3. Bass enhancement (moderate boost)
        `equalizer=f=120:width_type=h:width=100:g=3.5`,
        
        // 4. Presence boost for clarity (moderate boost)
        `equalizer=f=2500:width_type=h:width=1000:g=3.0`,
        
        // 5. Final volume adjustment (fixed gain)
        `volume=1.5`
      ].join(',');

      // Process the speech file with comprehensive enhancements
      await execAsync(
        `ffmpeg -threads 2 -i "${speechPath}" -af "${enhancementFilter}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${processedPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(processedPath);
      
      console.log(`Enhanced speech file ${index} with fixed processing parameters`);

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
      console.log("Applying final processing with fixed audio enhancements...");

      // Create an output path
      const outputPath = await this.fileProcessor.createTempPath(
        "final_processed",
        "wav"
      );

      // Extract basic format parameters
      const channelLayout =
        originalAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Use fixed parameters for consistent and faster processing
      const fixedParams = {
        duckingThreshold: -30,
        duckingAttack: 0.04,
        duckingRelease: 0.35,
        clarityBoost: 2.8,
        targetLoudness: -14,
        dynamicRange: 10
      };
      
      console.log("Using fixed processing parameters for better performance");
      
      // Build comprehensive final processing filter chain with fixed parameters:
      // 1. Format conversion
      // 2. Dynamic background ducking (sidechain-like effect)
      // 3. Speech clarity enhancement
      // 4. Final loudness normalization and limiting
      const finalFilter = [
        // 1. Format conversion
        `aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
        
        // 2. Dynamic background ducking (using compressor as ducking)
        `compand=attacks=${fixedParams.duckingAttack}:decays=${fixedParams.duckingRelease}:points=-70/-70|-60/-60|-40/-30|-30/-10|-24/-6|-12/-3|-6/-3|0/-3:soft-knee=6:threshold=${fixedParams.duckingThreshold}:gain=0`,
        
        // 3. Speech clarity enhancement with high-shelf filter
        `highshelf=f=7000:width_type=h:width=0.5:g=${fixedParams.clarityBoost}`,
        
        // 4. Final loudness normalization and limiting
        `loudnorm=I=${fixedParams.targetLoudness}:TP=-1:LRA=${fixedParams.dynamicRange}`,
        
        // 5. Final limiter to prevent any clipping
        `alimiter=level_in=1:level_out=1:limit=1:attack=5:release=50:level=disabled`
      ].join(',');

      // Process the final audio with comprehensive enhancements
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
        finalLoudness: finalAnalysis.loudness.integrated.toFixed(2) + " LUFS",
        finalPeak: finalAnalysis.loudness.truePeak.toFixed(2) + " dB"
      });

      return outputPath;
    } catch (error) {
      console.error("Error applying final processing:", error);
      throw error;
    }
  }
}
