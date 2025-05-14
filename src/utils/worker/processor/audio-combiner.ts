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

      // Create a silent background track with same characteristics
      const silentBgPath = await this.fileProcessor.createTempPath(
        "silent_bg",
        "wav"
      );

      // Create silent audio with exact same duration, sample rate and channels
      await execAsync(
        `ffmpeg -threads 2 -f lavfi -i anullsrc=r=${
          bgAnalysis.format.sampleRate
        }:cl=${bgAnalysis.format.channels === 1 ? "mono" : "stereo"} -t ${
          bgAnalysis.duration
        } -c:a pcm_s24le "${silentBgPath}"`
      );

      // Process each speech segment
      const speechSegmentPaths = [];
      let filterComplex = "";

      // Process speech segments with improved volume handling
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

        // Process each speech file with enhanced volume and smoother transitions
        const processedSpeechPath = await this.processSpeechWithEnhancedVolume(
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

      // Build filter complex with improved overlays
      filterComplex = "";
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];

        // Add each speech input with precise timing and fade edges to avoid abrupt cuts
        filterComplex += `[${i + 1}:a]afade=t=in:st=${segment.start}:d=0.05,afade=t=out:st=${
          segment.end - 0.05
        }:d=0.05,adelay=${Math.round(segment.start * 1000)}|${Math.round(
          segment.start * 1000
        )}[speech${i}];`;
      }

      // Build mix chain with appropriate volume levels
      if (speechSegmentPaths.length > 0) {
        filterComplex += `[0:a]`;
        for (let i = 0; i < speechSegmentPaths.length; i++) {
          filterComplex += `[speech${i}]`;
        }
        // Mix all speech segments with silent background
        filterComplex += `amix=inputs=${
          speechSegmentPaths.length + 1
        }:duration=first:normalize=0[speechmix];`;
      }

      // Add original background with controlled volume
      filterComplex += `[${
        speechSegmentPaths.length + 1
      }:a]volume=0.7[bg];`;

      // Final mix of speech and background with volume balancing
      filterComplex += `[speechmix][bg]amix=inputs=2:duration=first:weights=3 1[premix];`;

      // Final processing without changing duration - with smoother loudness control
      filterComplex += `[premix]highpass=f=80,lowpass=f=12000,dynaudnorm=p=0.95:m=20:s=15:g=5[out]`;

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

      // Execute ffmpeg with filter complex
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

      // Apply final spectral matching with improved speech clarity
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

  private async processSpeechWithEnhancedVolume(
    speechPath: string,
    outputDir: string,
    index: number,
    bgAnalysis: any
  ): Promise<string> {
    try {
      console.log(`Processing speech file ${index} with enhanced volume...`);

      // Create a processed speech file path
      const processedPath = path.join(
        outputDir,
        `processed_speech_${index}.wav`
      );

      // Analyze the speech file
      const speechAnalysis = await this.audioAnalyzer.analyzeAudio(speechPath);

      // Calculate target loudness for speech (louder than original)
      const targetSpeechLUFS = -16; // Boosted speech loudness
      const channelLayout =
        bgAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Create a speech processing filter with enhanced volume and clarity
      // This ensures speech is more prominent but still natural
      const speechFilter = `
        aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout},
        highpass=f=80,lowpass=f=12000,
        equalizer=f=125:width_type=o:width=1:gain=1,
        equalizer=f=250:width_type=o:width=1:gain=3,    
        equalizer=f=1000:width_type=o:width=1:gain=4,   
        equalizer=f=3000:width_type=o:width=1:gain=3.5, 
        equalizer=f=6000:width_type=o:width=1:gain=2,
        compand=attacks=0.02:decays=0.3:points=-40/-40|-30/-30|-20/-20|-10/-8|0/-5:soft-knee=6:gain=2,
        loudnorm=I=${targetSpeechLUFS}:TP=-1:LRA=7:print_format=summary,
        volume=2.0
      `.replace(/\s+/g, " ");

      // Process the speech file with enhanced volume
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
      console.log("Applying final consistent processing with speech emphasis...");

      // Create an output path
      const outputPath = await this.fileProcessor.createTempPath(
        "final_processed",
        "wav"
      );

      // Set target parameters that emphasize speech while maintaining background
      const targetLufs = -14; // Slightly louder overall for better speech clarity
      const targetPeak = -1.0; // Safe peak level
      const channelLayout =
        originalAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Final processing with speech emphasis and smooth transitions
      const finalFilter = `
        aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout},
        equalizer=f=125:width_type=o:width=1:gain=0.5,
        equalizer=f=1000:width_type=o:width=1:gain=2,   
        equalizer=f=3000:width_type=o:width=1:gain=2,   
        equalizer=f=5000:width_type=o:width=1:gain=1,
        dynaudnorm=p=0.95:m=20:s=12:g=5,               
        loudnorm=I=${targetLufs}:TP=${targetPeak}:LRA=10:print_format=summary:linear=true
      `.replace(/\s+/g, " ");

      // Process the final audio with consistent enhancement
      await execAsync(
        `ffmpeg -threads 2 -i "${inputPath}" -af "${finalFilter}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} "${outputPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(outputPath);

      // Verify final audio
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