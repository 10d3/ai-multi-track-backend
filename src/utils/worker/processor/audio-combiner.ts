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

      // Sanitize integrated loudness (fallback if NaN)
      const rawBgLoudness = bgAnalysis.loudness.integrated;
      const bgLoudness = Number.isFinite(rawBgLoudness)
        ? rawBgLoudness
        : (() => {
            console.warn(
              `Background loudness was NaN; defaulting to -23 LUFS instead of ${rawBgLoudness}`
            );
            return -23;
          })();

      console.log("Background audio analysis:", {
        duration: bgAnalysis.duration,
        sampleRate: bgAnalysis.format.sampleRate,
        channels: bgAnalysis.format.channels,
        loudness: bgLoudness,
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
      const speechSegmentPaths: { path: string; start: number; end: number }[] = [];
      let filterComplex = "";

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

      // Build filter complex to position each speech segment
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];
        filterComplex += `[${i + 1}:a]adelay=${Math.round(
          segment.start * 1000
        )}|${Math.round(segment.start * 1000)}[speech${i}];`;
      }

      // Mix all inputs
      if (speechSegmentPaths.length > 0) {
        filterComplex += `[0:a]`;
        for (let i = 0; i < speechSegmentPaths.length; i++) {
          filterComplex += `[speech${i}]`;
        }
        filterComplex += `amix=inputs=$${speechSegmentPaths.length + 1}:duration=first[speechmix];`;
      }

      filterComplex += `[${speechSegmentPaths.length + 1}:a]volume=0.4[bg];`;
      filterComplex += `[speechmix][bg]amix=inputs=2:duration=first[premix];`;
      filterComplex += `[premix]highpass=f=80,lowpass=f=12000,compand=attacks=0.03:decays=0.4:points=-40/-40|-30/-30|-20/-18|-10/-8|0/-4|20/-4:soft-knee=6:gain=3[out]`;

      // Inputs
      let inputArgs = `-threads 2 -i "${silentBgPath}" `;
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        inputArgs += `-i "${speechSegmentPaths[i].path}" `;
      }
      inputArgs += `-i "${backgroundPath}" `;

      // Final path
      const finalPath = await this.fileProcessor.createTempPath(
        "final_audio",
        "wav"
      );

      await execAsync(
        `ffmpeg ${inputArgs} -filter_complex "${filterComplex.replace(/\s+/g, " ")}" -map "[out]" -c:a pcm_s24le -ar ${
          bgAnalysis.format.sampleRate
        } -ac ${bgAnalysis.format.channels} "${finalPath}"`
      );

      await this.fileProcessor.verifyFile(finalPath);
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
        bgAnalysis,
        bgLoudness
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

      const processedPath = path.join(
        outputDir,
        `processed_speech_${index}.wav`
      );
      const speechAnalysis = await this.audioAnalyzer.analyzeAudio(speechPath);

      // Sanitize speech loudness
      const rawSpLoudness = speechAnalysis.loudness.integrated;
      const spLoudness = Number.isFinite(rawSpLoudness)
        ? rawSpLoudness
        : (() => {
            console.warn(
              `Speech #${index} loudness was NaN; defaulting to -23 LUFS`
            );
            return -23;
          })();

      const channelLayout =
        bgAnalysis.format.channels === 1 ? "mono" : "stereo";

      const speechFilter = `
        aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout},
        highpass=f=80,lowpass=f=12000,
        afade=t=in:st=0:d=0.015,afade=t=out:st=${speechAnalysis.duration -
        0.015}:d=0.015,
        equalizer=f=125:width_type=o:width=1:gain=2,
        equalizer=f=250:width_type=o:width=1:gain=3,
        equalizer=f=500:width_type=o:width=1:gain=4,
        equalizer=f=1000:width_type=o:width=1:gain=5,
        equalizer=f=2000:width_type=o:width=1:gain=4,
        equalizer=f=4000:width_type=o:width=1:gain=2,
        equalizer=f=8000:width_type=o:width=1:gain=0,
        compand=attacks=0.02:decays=0.3:points=-50/-50|-40/-35|-30/-25|-20/-15|-10/-8|0/-4:soft-knee=6:gain=4,
        volume=3.0
      `.replace(/\s+/g, " ");

      await execAsync(
        `ffmpeg -threads 2 -i "${speechPath}" -af "${speechFilter}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${processedPath}"`
      );

      await this.fileProcessor.verifyFile(processedPath);
      return processedPath;
    } catch (error) {
      console.error(`Error processing speech file ${index}:`, error);
      throw error;
    }
  }

  private async applyConsistentFinalProcessing(
    inputPath: string,
    originalAnalysis: any,
    bgLoudness: number
  ): Promise<string> {
    try {
      console.log("Applying final consistent processing with enhanced speech clarity...");

      const outputPath = await this.fileProcessor.createTempPath(
        "final_processed",
        "wav"
      );

      const targetLufs = Math.max(-18, bgLoudness + 3);
      const targetPeak = Math.max(
        -6,
        Math.min(-0.3, originalAnalysis.loudness.truePeak + 2)
      );
      const channelLayout =
        originalAnalysis.format.channels === 1 ? "mono" : "stereo";

      const finalFilter = `
        aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout},
        equalizer=f=125:width_type=o:width=1:gain=1,
        equalizer=f=250:width_type=o:width=1:gain=2,
        equalizer=f=500:width_type=o:width=1:gain=3,
        equalizer=f=1000:width_type=o:width=1:gain=4,
        equalizer=f=2000:width_type=o:width=1:gain=3,
        equalizer=f=4000:width_type=o:width=1:gain=2,
        dynaudnorm=f=150:g=15:p=0.55:m=5:s=0,
        asoftclip=type=tanh:threshold=0.7,
        loudnorm=I=${targetLufs}:TP=${targetPeak}:LRA=12:print_format=summary:linear=true:dual_mono=true
      `.replace(/\s+/g, " ");

      await execAsync(
        `ffmpeg -threads 2 -i "${inputPath}" -af "${finalFilter}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} "${outputPath}"`
      );

      await this.fileProcessor.verifyFile(outputPath);
      const finalAnalysis = await this.audioAnalyzer.analyzeAudio(outputPath);
      console.log("Final processed audio validation:", {
        originalDuration: originalAnalysis.duration.toFixed(3) + "s",
        finalDuration: finalAnalysis.duration.toFixed(3) + "s",
        difference:
          Math.abs(originalAnalysis.duration - finalAnalysis.duration).toFixed(
            3
          ) +
          "s",
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
