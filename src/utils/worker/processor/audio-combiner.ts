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
      let filterComplex = "";
      let mixInputs = "[0:a]"; // Silent background is input 0
      let inputCount = 1;

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
        });
      }

      // Now build a filter complex to precisely position each speech segment
      // We'll use the silent background as base and overlay each speech at exact position
      filterComplex = "";
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];

        // Add each speech input to filter
        filterComplex += `[${i + 1}:a]adelay=${Math.round(
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

      // Add original background with volume control
      filterComplex += `[${speechSegmentPaths.length + 1}:a]volume=0.7[bg];`;

      // Final mix of speech and background
      filterComplex += `[speechmix][bg]amix=inputs=2:duration=first[premix];`;

      // Final processing without changing duration
      filterComplex += `[premix]highpass=f=80,lowpass=f=12000,compand=attacks=0.05:decays=0.5:points=-40/-40|-30/-30|-20/-20|-10/-10|0/-8|20/-8:soft-knee=6:gain=2[out]`;

      // Create input arguments string for ffmpeg
      let inputArgs = `-threads 2 -i "${silentBgPath}" `;

      // Add all processed speech segments
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
      console.log(`Processing speech file ${index} for consistent quality...`);

      // Create a processed speech file path
      const processedPath = path.join(
        outputDir,
        `processed_speech_${index}.wav`
      );

      // Analyze the speech file
      const speechAnalysis = await this.audioAnalyzer.analyzeAudio(speechPath);

      // Calculate optimal speech enhancement parameters
      // Use same parameters for all segments to ensure consistency
      const channelLayout =
        bgAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Create a consistent processing filter chain for all speech files
      // This ensures all speeches have same spectral characteristics
      const speechFilter = `
        aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout},
        highpass=f=70,lowpass=f=12000,
        equalizer=f=125:width_type=o:width=1:gain=1,
        equalizer=f=250:width_type=o:width=1:gain=2,
        equalizer=f=1000:width_type=o:width=1:gain=3,
        equalizer=f=4000:width_type=o:width=1:gain=1.5,
        equalizer=f=8000:width_type=o:width=1:gain=-1,
        compand=attacks=0.01:decays=0.2:points=-40/-40|-30/-30|-20/-20|-10/-10|0/-8|10/-8:soft-knee=6:gain=2,
        volume=1.5
      `.replace(/\s+/g, " ");

      // Process the speech file with consistent enhancement parameters
      await execAsync(
        `ffmpeg -threads 2 -i "${speechPath}" -af "${speechFilter}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${processedPath}"`
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
      console.log("Applying final consistent processing...");

      // Create an output path
      const outputPath = await this.fileProcessor.createTempPath(
        "final_processed",
        "wav"
      );

      // Extract target parameters from original analysis
      const targetLufs = originalAnalysis.loudness.integrated;
      const targetPeak = Math.max(
        -9,
        Math.min(-0.5, originalAnalysis.loudness.truePeak)
      );
      const channelLayout =
        originalAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Create a final processing filter that maintains duration exactly
      const finalFilter = `
        aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout},
        equalizer=f=125:width_type=o:width=1:gain=0.5,
        equalizer=f=250:width_type=o:width=1:gain=1,
        equalizer=f=1000:width_type=o:width=1:gain=1,
        equalizer=f=4000:width_type=o:width=1:gain=0.5,
        asoftclip=type=tanh:threshold=0.6,
        loudnorm=I=${targetLufs}:TP=${targetPeak}:LRA=15:print_format=summary:linear=true:dual_mono=true
      `.replace(/\s+/g, " ");

      // Process the final audio with consistent enhancement parameters
      await execAsync(
        `ffmpeg -threads 2 -i "${inputPath}" -af "${finalFilter}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} "${outputPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(outputPath);

      // Verify final length matches original background
      const finalAnalysis = await this.audioAnalyzer.analyzeAudio(outputPath);
      console.log("Final processed audio validation:", {
        originalDuration: originalAnalysis.duration.toFixed(3) + "s",
        finalDuration: finalAnalysis.duration.toFixed(3) + "s",
        difference:
          Math.abs(originalAnalysis.duration - finalAnalysis.duration).toFixed(
            3
          ) + "s",
        lufs: finalAnalysis.loudness.integrated.toFixed(2) + " LUFS",
        peak: finalAnalysis.loudness.truePeak.toFixed(2) + " dB",
      });

      return outputPath;
    } catch (error) {
      console.error("Error applying final processing:", error);
      throw error;
    }
  }
}
