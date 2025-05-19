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
      
      // Preprocess the background audio to reduce noise and smooth transitions
      console.log("Preprocessing background audio to reduce noise and smooth transitions...");
      const processedBackgroundPath = await this.preprocessBackgroundAudio(backgroundPath, bgAnalysis);

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

      // Set background volume to be audible but not overpowering the speech
      filterComplex += `[${speechSegmentPaths.length + 1}:a]volume=0.5[bg];`;

      // Final mix of speech and background - with better balance
      filterComplex += `[speechmix][bg]amix=inputs=2:duration=first:weights=1.5 1[out]`;

      // Create input arguments string for ffmpeg
      let inputArgs = `-threads 2 -i "${silentBgPath}" `;

      // Add all processed speech segments IN THE SORTED ORDER
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        inputArgs += `-i "${speechSegmentPaths[i].path}" `;
      }

      // Add processed background track
      inputArgs += `-i "${processedBackgroundPath}" `;

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
      console.log(`Processing speech file ${index} (boosting volume)...`);

      // Create a processed speech file path
      const processedPath = path.join(
        outputDir,
        `processed_speech_${index}.wav`
      );

      // Apply format conversion and volume boost
      const channelLayout =
        bgAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Apply moderate volume boost to make speech clearly audible while allowing background to be heard
      // Using volume=2.0 for double the volume instead of triple
      const boostFilter = `aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout},volume=2.0`;

      // Process the speech file with volume boost
      await execAsync(
        `ffmpeg -threads 2 -i "${speechPath}" -af "${boostFilter}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${processedPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(processedPath);

      return processedPath;
    } catch (error) {
      console.error(`Error processing speech file ${index}:`, error);
      throw error;
    }
  }

  /**
   * Preprocesses the background audio to reduce noise and smooth transitions
   * Applies a series of advanced audio filters to clean up the background track
   * and fix issues like noise, clicks, pops, and sudden cuts
   */
  private async preprocessBackgroundAudio(
    backgroundPath: string,
    bgAnalysis: any
  ): Promise<string> {
    try {
      console.log("Applying advanced noise reduction and smoothing to background audio...");

      // Create an output path for the processed background
      const processedPath = await this.fileProcessor.createTempPath(
        "processed_background",
        "wav"
      );

      // Create an intermediate path for multi-stage processing
      const intermediatePath = await this.fileProcessor.createTempPath(
        "intermediate_background",
        "wav"
      );

      // Extract basic format parameters
      const channelLayout =
        bgAnalysis.format.channels === 1 ? "mono" : "stereo";

      // STAGE 1: Initial noise reduction and click/pop removal
      // This stage focuses on removing technical artifacts and unwanted noise
      const initialFilterChain = [
        // Format conversion to ensure consistent processing
        `aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
        // Remove DC offset which can cause clicks
        "dcshift=shift=0:limitergain=0.05",
        // Remove clicks and pops (common in background tracks)
        "adeclick=threshold=20:window=55:overlap=75",
        // Remove crackles (subtle artifacts)
        "adeclip=window=75",
        // Aggressive noise reduction for very noisy backgrounds
        "afftdn=nf=-25:nt=w:tr=0.2",
        // Remove low rumble (air conditioners, wind noise)
        "highpass=f=60:t=q",
        // Remove high frequency hiss
        "lowpass=f=15000:t=q"
      ].join(",");

      // Apply first stage processing
      await execAsync(
        `ffmpeg -threads 2 -i "${backgroundPath}" -af "${initialFilterChain}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${intermediatePath}"`
      );

      // Verify the intermediate file
      await this.fileProcessor.verifyFile(intermediatePath);

      // STAGE 2: Smoothing and audio enhancement
      // This stage focuses on making the audio pleasant and consistent
      const enhancementFilterChain = [
        // Format conversion to ensure consistent processing
        `aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
        // Smooth out volume inconsistencies with advanced dynamic normalization
        "dynaudnorm=f=125:g=15:p=0.55:m=15:s=10",
        // Multi-band compression to even out frequency response
        "asplit=2[a][b];[a]aformat=channel_layouts=stereo,equalizer=f=250:width_type=h:width=100:g=-5,equalizer=f=1000:width_type=h:width=100:g=2,equalizer=f=4000:width_type=h:width=100:g=3[a1];[b]aformat=channel_layouts=stereo[a2];[a1][a2]amix=inputs=2:weights=4 1",
        // Subtle compression to even out the sound
        "acompressor=threshold=-24dB:ratio=2:attack=150:release=950:makeup=2:knee=2.5",
        // Add subtle reverb to smooth transitions and mask discontinuities
        "areverse,aecho=0.8:0.88:40:0.5,areverse",
        // Crossfade between segments to eliminate abrupt transitions
        "acrossfade=nb=2:d=1.5:c1=tri:c2=tri",
        // Final loudness normalization to broadcast standards
        "loudnorm=I=-18:TP=-1.5:LRA=9"
      ].join(",");

      // Apply second stage processing
      await execAsync(
        `ffmpeg -threads 2 -i "${intermediatePath}" -af "${enhancementFilterChain}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${processedPath}"`
      );

      // Clean up intermediate file
      try {
        await fs.unlink(intermediatePath);
      } catch (err) {
        console.warn("Could not delete intermediate file:", err);
      }

      // Verify the output file
      await this.fileProcessor.verifyFile(processedPath);

      // Verify processed background length matches original
      const processedAnalysis = await this.audioAnalyzer.analyzeAudio(processedPath);
      console.log("Processed background audio validation:", {
        originalDuration: bgAnalysis.duration.toFixed(3) + "s",
        processedDuration: processedAnalysis.duration.toFixed(3) + "s",
        difference:
          Math.abs(bgAnalysis.duration - processedAnalysis.duration).toFixed(3) +
          "s",
      });

      // If the processed audio is significantly different in length, try a simpler approach
      if (Math.abs(bgAnalysis.duration - processedAnalysis.duration) > 1.0) {
        console.warn("Processed audio duration differs significantly from original. Trying simpler processing...");
        
        // Create a fallback path
        const fallbackPath = await this.fileProcessor.createTempPath(
          "fallback_background",
          "wav"
        );
        
        // Use a simpler filter chain that preserves duration better
        const fallbackFilterChain = [
          `aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
          "afftdn=nf=-20",  // Simple noise reduction
          "highpass=f=60",   // Basic rumble removal
          "lowpass=f=15000", // Basic hiss removal
          "dynaudnorm=f=150:g=15", // Simple normalization
          "loudnorm=I=-18:TP=-1.5:LRA=11" // Standard loudness
        ].join(",");
        
        await execAsync(
          `ffmpeg -threads 2 -i "${backgroundPath}" -af "${fallbackFilterChain}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${fallbackPath}"`
        );
        
        await this.fileProcessor.verifyFile(fallbackPath);
        const fallbackAnalysis = await this.audioAnalyzer.analyzeAudio(fallbackPath);
        
        // If fallback is closer to original duration, use it instead
        if (Math.abs(bgAnalysis.duration - fallbackAnalysis.duration) < 
            Math.abs(bgAnalysis.duration - processedAnalysis.duration)) {
          console.log("Using fallback processing with better duration match");
          try {
            await fs.unlink(processedPath);
          } catch (err) {
            console.warn("Could not delete processed file:", err);
          }
          return fallbackPath;
        } else {
          try {
            await fs.unlink(fallbackPath);
          } catch (err) {
            console.warn("Could not delete fallback file:", err);
          }
        }
      }

      return processedPath;
    } catch (error) {
      console.error("Error preprocessing background audio:", error);
      // If preprocessing fails, return the original background path
      console.log("Falling back to original background audio");
      return backgroundPath;
    }
  }

  /**
   * Applies final processing to the combined audio to ensure consistent quality
   * and enhance speech clarity while maintaining smooth background transitions
   */
  private async applyConsistentFinalProcessing(
    inputPath: string,
    originalAnalysis: any
  ): Promise<string> {
    try {
      console.log("Applying advanced final processing with enhanced speech clarity and smooth transitions...");

      // Create an output path
      const outputPath = await this.fileProcessor.createTempPath(
        "final_processed",
        "wav"
      );

      // Create an intermediate path for multi-stage processing
      const intermediatePath = await this.fileProcessor.createTempPath(
        "intermediate_final",
        "wav"
      );

      // Extract basic format parameters
      const channelLayout =
        originalAnalysis.format.channels === 1 ? "mono" : "stereo";

      // STAGE 1: Speech enhancement and clarity
      // This stage focuses on making speech more intelligible while preserving natural sound
      const speechEnhancementFilter = [
        // Format conversion
        `aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
        // Remove any remaining low rumble that might mask speech
        "highpass=f=75:t=q",
        // Advanced de-essing to reduce harsh sibilance in speech
        "highshelf=f=6500:width_type=h:width=0.6:g=-4",
        // Vocal presence enhancement
        "equalizer=f=200:width_type=h:width=1:g=-3,equalizer=f=1000:width_type=h:width=1.5:g=3,equalizer=f=3000:width_type=h:width=1.5:g=4,equalizer=f=5000:width_type=h:width=1:g=2",
        // Multiband compression for better speech clarity
        "compand=attacks=0.01:decays=0.2:points=-80/-80|-50/-25|-30/-15|-5/-5|0/-2:soft-knee=2.5:gain=4",
        // Smooth transitions between speech segments
        "agate=threshold=-35dB:ratio=2:attack=100:release=400:makeup=0"
      ].join(",");

      // Apply first stage processing
      await execAsync(
        `ffmpeg -threads 2 -i "${inputPath}" -af "${speechEnhancementFilter}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} "${intermediatePath}"`
      );

      // Verify the intermediate file
      await this.fileProcessor.verifyFile(intermediatePath);

      // STAGE 2: Final polish and mastering
      // This stage focuses on overall audio quality and broadcast standards
      const masteringFilter = [
        // Format conversion
        `aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
        // Subtle stereo widening for more immersive sound (only if stereo)
        originalAnalysis.format.channels > 1 ? "stereotools=mlev=0.15:mode=ms>lr" : "",
        // Subtle reverb to create cohesion between speech and background
        "areverse,aecho=0.6:0.3:20:0.3,areverse",
        // Gentle limiting to prevent any peaks
        "alimiter=level_in=1:level_out=1:limit=0.7:attack=5:release=50",
        // Final loudness normalization with better preservation of background audio
        "loudnorm=I=-14:TP=-1:LRA=11:print_format=summary"
      ].filter(Boolean).join(",");

      // Apply second stage processing
      await execAsync(
        `ffmpeg -threads 2 -i "${intermediatePath}" -af "${masteringFilter}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} "${outputPath}"`
      );

      // Clean up intermediate file
      try {
        await fs.unlink(intermediatePath);
      } catch (err) {
        console.warn("Could not delete intermediate file:", err);
      }

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

      // If the processed audio is significantly different in length, use a simpler approach
      if (Math.abs(originalAnalysis.duration - finalAnalysis.duration) > 0.5) {
        console.warn("Final processed audio duration differs significantly. Using simpler processing...");
        
        // Create a fallback path
        const fallbackPath = await this.fileProcessor.createTempPath(
          "fallback_final",
          "wav"
        );
        
        // Use a simpler filter chain that preserves duration better
        const fallbackFilterChain = [
          `aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
          "highpass=f=75",  // Basic rumble removal
          "equalizer=f=1000:width_type=h:width=1:g=2,equalizer=f=3000:width_type=h:width=1:g=3", // Basic speech enhancement
          "loudnorm=I=-14:TP=-1:LRA=11" // Improved loudness settings for better background preservation
        ].join(",");
        
        await execAsync(
          `ffmpeg -threads 2 -i "${inputPath}" -af "${fallbackFilterChain}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} "${fallbackPath}"`
        );
        
        await this.fileProcessor.verifyFile(fallbackPath);
        const fallbackAnalysis = await this.audioAnalyzer.analyzeAudio(fallbackPath);
        
        // If fallback is closer to original duration, use it instead
        if (Math.abs(originalAnalysis.duration - fallbackAnalysis.duration) < 
            Math.abs(originalAnalysis.duration - finalAnalysis.duration)) {
          console.log("Using fallback final processing with better duration match");
          try {
            await fs.unlink(outputPath);
          } catch (err) {
            console.warn("Could not delete processed file:", err);
          }
          return fallbackPath;
        } else {
          try {
            await fs.unlink(fallbackPath);
          } catch (err) {
            console.warn("Could not delete fallback file:", err);
          }
        }
      }

      return outputPath;
    } catch (error) {
      console.error("Error applying final processing:", error);
      // If final processing fails, return the input path
      console.log("Falling back to unprocessed final audio");
      return inputPath;
    }
  }
}
