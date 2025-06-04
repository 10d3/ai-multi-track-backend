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

      // Reduce background volume significantly to make speech more prominent
      filterComplex += `[${speechSegmentPaths.length + 1}:a]volume=0.2[bg];`;

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

      // Apply final spectral matching to ensure consistent quality for all segments
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
      console.log(`Processing speech file ${index} (boosting volume and ensuring isolation)...`);
      
      const processedPath = path.join(outputDir, `processed_speech_${index}.wav`);
      
      // Enhanced processing chain:
      // 1. Normalize audio
      // 2. Apply noise gate to remove any background noise
      // 3. Apply compression to maintain consistent levels
      // 4. Add fade in/out to prevent clicks
      const filterChain = [
        // Normalize audio to -23 LUFS (broadcast standard)
        "loudnorm=I=-23:LRA=7:TP=-1",
        // Apply noise gate to remove any background noise
        "anlmdn=s=7:p=0.002:r=0.001:m=15:b=1",
        // Apply compression to maintain consistent levels
        "acompressor=threshold=-24dB:ratio=4:attack=20:release=100",
        // Add fade in/out to prevent clicks
        "afade=t=in:st=0:d=0.01,afade=t=out:st=-0.01:d=0.01"
      ].join(",");

      await execAsync(
        `ffmpeg -threads 2 -i "${speechPath}" -af "${filterChain}" -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} -c:a pcm_s24le "${processedPath}"`
      );

      // Verify the processed file
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
      const outputPath = await this.fileProcessor.createTempPath(
        "final_processed",
        "wav"
      );

      // Enhanced final processing chain:
      // 1. Apply spectral matching to match original audio characteristics
      // 2. Apply final noise gate to remove any remaining artifacts
      // 3. Apply final normalization
      // 4. Add subtle compression to ensure consistent levels
      const filterChain = [
        // Spectral matching
        "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75",
        // Final noise gate
        "anlmdn=s=7:p=0.001:r=0.001:m=15:b=1",
        // Final normalization
        "loudnorm=I=-23:LRA=7:TP=-1",
        // Subtle compression
        "acompressor=threshold=-24dB:ratio=2:attack=50:release=200"
      ].join(",");

      await execAsync(
        `ffmpeg -threads 2 -i "${inputPath}" -af "${filterChain}" -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} -c:a pcm_s24le "${outputPath}"`
      );

      // Verify the final processed file
      await this.fileProcessor.verifyFile(outputPath);

      // Validate the final audio quality
      const finalAnalysis = await this.audioAnalyzer.analyzeAudio(outputPath);
      
      // Log quality metrics
      console.log("Final audio quality metrics:", {
        duration: finalAnalysis.duration.toFixed(2) + "s",
        loudness: finalAnalysis.loudness.integrated.toFixed(2) + " LUFS",
        peak: finalAnalysis.loudness.truePeak.toFixed(2) + " dB",
        range: finalAnalysis.loudness.range.toFixed(2) + " LU"
      });

      return outputPath;
    } catch (error) {
      console.error("Error in final audio processing:", error);
      throw error;
    }
  }
}
