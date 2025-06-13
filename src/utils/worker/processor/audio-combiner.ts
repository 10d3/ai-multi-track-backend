import { promisify } from "util";
import { exec } from "child_process";
import path from "path";
import type { FileProcessor } from "./file-processor";
import type { AudioAnalyzer } from "./audio-analyzer";
import type { Transcript } from "../../types/type";
import fs from "fs/promises";

const execAsync = promisify(exec);

interface SpeechSegment {
  path: string;
  start: number;
  end: number;
  originalIndex: number;
}

interface VoiceActivitySegment {
  start: number;
  end: number;
  confidence: number;
}

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

      // Detect voice activity in background audio
      console.log("Detecting voice activity in background audio...");
      const voiceSegments = await this.detectVoiceActivity(backgroundPath);

      // Create speech-free background audio
      console.log("Creating speech-free background audio...");
      const cleanBackgroundPath = await this.removeSpeechFromBackground(
        backgroundPath,
        voiceSegments,
        bgAnalysis
      );

      // Create a temporary directory for the combined audio segments
      const outputDir = await this.fileProcessor.createTempDir(
        "combined_segments"
      );

      // Create silent audio with EXACT same duration, sample rate and channels
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

      // Process each speech segment and prepare filter complex
      let speechSegmentPaths: SpeechSegment[] = [];

      // First, create processed speech segments with exact duration matching
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

        // Calculate target duration from transcript
        const targetDuration = segment.end - segment.start;
        
        if (targetDuration <= 0) {
          console.warn(`Invalid duration for segment ${i}: ${targetDuration}s, skipping`);
          continue;
        }

        // Process each speech file to match exact transcript duration
        const processedSpeechPath = await this.processSpeechForConsistency(
          speechPaths[i],
          outputDir,
          i,
          bgAnalysis,
          targetDuration // Pass the target duration
        );

        speechSegmentPaths.push({
          path: processedSpeechPath,
          start: segment.start,
          end: segment.end,
          originalIndex: i,
        });
      }

      // Sort speech segments by start time (natural overlapping preserved)
      speechSegmentPaths.sort((a, b) => a.start - b.start);

      // Log the processed segments with matched durations
      console.log(
        "Speech segments with matched durations:",
        speechSegmentPaths.map((segment) => ({
          start: segment.start,
          end: segment.end,
          originalIndex: segment.originalIndex,
          duration: segment.end - segment.start,
        }))
      );

      // Now build a filter complex to precisely position each speech segment
      let filterComplex = "";

      // Add each speech input to filter with proper delay based on original start time
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];
        const inputIndex = i + 1; // +1 because silent background is input 0
        const startTime = segment.start; // Use original start time since duration is now matched

        // Add each speech input to filter - positioned by original timestamp
        filterComplex += `[${inputIndex}:a]adelay=${Math.round(
          startTime * 1000
        )}|${Math.round(startTime * 1000)}[speech${i}];`;
      }

      // Build mix chain with better volume management
      if (speechSegmentPaths.length > 0) {
        filterComplex += `[0:a]`;
        for (let i = 0; i < speechSegmentPaths.length; i++) {
          filterComplex += `[speech${i}]`;
        }
        // Mix all speech segments with silent background - speech should be dominant
        filterComplex += `amix=inputs=${
          speechSegmentPaths.length + 1
        }:duration=first:weights=`;
        
        // Silent background gets minimal weight, speech gets full weight
        filterComplex += `0.1`;
        for (let i = 0; i < speechSegmentPaths.length; i++) {
          filterComplex += ` 1.0`; // Each speech segment gets full weight
        }
        filterComplex += `[speechmix];`;
      }

      // Keep background at reduced volume to not overpower speech
      filterComplex += `[${speechSegmentPaths.length + 1}:a]volume=0.3[bg];`;

      // Final mix - prioritize speech over background
      filterComplex += `[speechmix][bg]amix=inputs=2:duration=first:weights=1.0 0.3[out]`;

      // Create input arguments string for ffmpeg
      let inputArgs = `-threads 2 -i "${silentBgPath}" `;

      // Add all processed speech segments IN THE SORTED ORDER
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        inputArgs += `-i "${speechSegmentPaths[i].path}" `;
      }

      // Add clean background track (without original speech)
      inputArgs += `-i "${cleanBackgroundPath}" `;

      // Final output path
      const finalPath = await this.fileProcessor.createTempPath(
        "final_audio",
        "wav"
      );

      // Log the filter complex for debugging
      console.log("Filter complex:", filterComplex.replace(/\s+/g, " "));
      console.log("Input arguments:", inputArgs);
      
      // Execute ffmpeg with single filter complex that preserves exact duration
      await execAsync(
        `ffmpeg ${inputArgs} -filter_complex "${filterComplex.replace(
          /\s+/g,
          " "
        )}" -map "[out]" -c:a pcm_s24le -ar ${
          bgAnalysis.format.sampleRate
        } -ac ${bgAnalysis.format.channels} "${finalPath}"`
      );
      
      // Check if speech is audible by analyzing the output
      console.log("Analyzing final audio levels...");
      try {
        const { stderr } = await execAsync(
          `ffmpeg -i "${finalPath}" -af "volumedetect" -f null - 2>&1`
        );
        console.log("Final audio volume analysis:", stderr.match(/mean_volume: [-\d.]+/)?.[0] || "No volume data");
      } catch (error) {
        console.log("Could not analyze final audio levels");
      }

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

  /**
   * Detect voice activity in audio using FFmpeg's silencedetect filter
   * Returns segments where voice/speech is detected
   */
  private async detectVoiceActivity(
    audioPath: string
  ): Promise<VoiceActivitySegment[]> {
    try {
      console.log("Running voice activity detection...");

      // Use silencedetect to find non-silent segments (which likely contain speech)
      // Detect silence with threshold -30dB and minimum duration of 0.5s
      const { stderr } = await execAsync(
        `ffmpeg -i "${audioPath}" -af silencedetect=noise=-30dB:duration=0.5 -f null - 2>&1`
      );

      const voiceSegments: VoiceActivitySegment[] = [];
      const silenceRegex = /silence_(?:start|end): ([\d.]+)/g;
      const matches = [...stderr.matchAll(silenceRegex)];

      let currentStart = 0;
      let isInSilence = false;

      for (const match of matches) {
        const timestamp = parseFloat(match[1]);
        const isSilenceStart = match[0].includes("silence_start");

        if (isSilenceStart && !isInSilence) {
          // End of voice segment
          if (timestamp > currentStart) {
            voiceSegments.push({
              start: currentStart,
              end: timestamp,
              confidence: 0.8, // Basic confidence score
            });
          }
          isInSilence = true;
        } else if (!isSilenceStart && isInSilence) {
          // Start of new voice segment
          currentStart = timestamp;
          isInSilence = false;
        }
      }

      // Handle case where audio ends with voice
      if (!isInSilence) {
        // Get audio duration for final segment
        const { stdout } = await execAsync(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`
        );
        const duration = parseFloat(stdout.trim());

        voiceSegments.push({
          start: currentStart,
          end: duration,
          confidence: 0.8,
        });
      }

      console.log(
        `Detected ${voiceSegments.length} voice activity segments:`,
        voiceSegments.map((s) => `${s.start.toFixed(2)}s-${s.end.toFixed(2)}s`)
      );

      return voiceSegments;
    } catch (error) {
      console.error("Error detecting voice activity:", error);
      return []; // Return empty array if detection fails
    }
  }

  private async separateOriginalAudio(
    originalAudioUrl: string,
    // transcript: Transcript[]
  ): Promise<string> {
    const originalPath = await this.fileProcessor.downloadAndConvertAudio(
      originalAudioUrl
    );
    const spleeterOutputDir = await this.fileProcessor.createTempDir(
      "spleeter_output"
    );

    try {
      const scriptPath = path.resolve("./src/script/separate_audio.py");
      await execAsync(
        `python3 "${scriptPath}" "${originalPath}" "${spleeterOutputDir}"`
      );

      const subdirs = await fs.readdir(spleeterOutputDir);
      if (!subdirs.length) {
        throw new Error("No subdirectories found in Spleeter output.");
      }

      // Get vocals for voice cloning
      const vocalsPath = path.join(spleeterOutputDir, subdirs[0], "vocals.wav");
      await this.fileProcessor.verifyFile(vocalsPath);

      // Get accompaniment for background
      const accompanimentPath = path.join(
        spleeterOutputDir,
        subdirs[0],
        "accompaniment.wav"
      );
      await this.fileProcessor.verifyFile(accompanimentPath);

      // Extract speaker references using transcript timestamps
      // await this.speakerReferenceProcessor.extractSpeakerReferences(
      //   vocalsPath,
      //   transcript
      // );

      return accompanimentPath;
    } catch (error) {
      console.error("Spleeter processing failed:", error);
      throw new Error(`Spleeter processing failed: ${error}`);
    }
  }

  /**
   * Remove speech segments from background audio by replacing them with ambient noise or silence
   */
  private async removeSpeechFromBackground(
    backgroundPath: string,
    voiceSegments: VoiceActivitySegment[],
    bgAnalysis: any
  ): Promise<string> {
    try {
      // if (voiceSegments.length === 0) {
      //   console.log("No voice segments detected, using original background");
      //   return backgroundPath;
      // }

      // console.log(
      //   `Removing ${voiceSegments.length} voice segments from background...`
      // );

      // const cleanBackgroundPath = await this.fileProcessor.createTempPath(
      //   "clean_background",
      //   "wav"
      // );

      // // Create filter complex to remove voice segments
      // let filterComplex = "";

      // // Generate ambient noise to replace speech segments
      // // Use anoisesrc to create subtle background noise
      // filterComplex += `anoisesrc=duration=${bgAnalysis.duration}:color=brown:seed=42:sample_rate=${bgAnalysis.format.sampleRate}[noise];`;
      // filterComplex += `[noise]volume=0.05[quietnoise];`; // Very quiet ambient noise

      // // Start with the original background
      // filterComplex += `[0:a]`;

      // // For each voice segment, replace with quiet noise
      // for (let i = 0; i < voiceSegments.length; i++) {
      //   const segment = voiceSegments[i];
      //   const start = segment.start;
      //   const end = segment.end;

      //   // Create a segment of quiet noise for this time range
      //   filterComplex += `[quietnoise]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[replace${i}];`;

      //   // Mix the replacement into the background at the correct time
      //   filterComplex += `areplace=start=${start}:end=${end}[temp${i}];`;

      //   // Chain the replacements
      //   if (i < voiceSegments.length - 1) {
      //     filterComplex += `[temp${i}]`;
      //   }
      // }

      // // Simplified approach: use volume ducking during voice segments
      // let duckingFilter = "[0:a]";

      // for (const segment of voiceSegments) {
      //   // Significantly reduce volume during detected speech segments
      //   duckingFilter += `volume=enable='between(t,${segment.start},${segment.end})':volume=0.1,`;
      // }

      // // Remove trailing comma and add output label
      // duckingFilter = duckingFilter.replace(/,$/, "") + "[out]";

      // // Execute ffmpeg to create clean background
      // await execAsync(
      //   `ffmpeg -threads 2 -i "${backgroundPath}" -filter_complex "${duckingFilter}" -map "[out]" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${cleanBackgroundPath}"`
      // );

      // // Verify the output file
      // await this.fileProcessor.verifyFile(cleanBackgroundPath);

      // console.log("Successfully created speech-free background audio");
      return backgroundPath;
    } catch (error) {
      console.error("Error removing speech from background:", error);
      console.log("Falling back to original background audio");
      return backgroundPath; // Fallback to original if processing fails
    }
  }



  private async processSpeechForConsistency(
    speechPath: string,
    outputDir: string,
    index: number,
    bgAnalysis: any,
    targetDuration: number // Add target duration parameter
  ): Promise<string> {
    try {
      console.log(`Processing speech file ${index} to match target duration ${targetDuration.toFixed(3)}s...`);

      // First, get the actual TTS duration
      const actualDuration = await this.getTTSFileDuration(speechPath);
      console.log(`TTS file ${index}: actual=${actualDuration.toFixed(3)}s, target=${targetDuration.toFixed(3)}s`);

      // Create a processed speech file path
      const processedPath = path.join(outputDir, `processed_speech_${index}.wav`);

      // Calculate speed needed: how much faster/slower to make the speech
      const speedRatio = actualDuration / targetDuration; // Speed multiplier needed
      
      let filters = [];
      
      // Always adjust speed to match target duration exactly
      console.log(`Adjusting segment ${index}: ${actualDuration.toFixed(3)}s → ${targetDuration.toFixed(3)}s (need ${speedRatio.toFixed(3)}x speed)`);
      
      // Handle atempo filter limits (0.5 - 100.0)
      if (speedRatio >= 0.5 && speedRatio <= 2.0) {
        // Single atempo filter for reasonable speed changes
        filters.push(`atempo=${speedRatio.toFixed(3)}`);
      } else if (speedRatio > 2.0) {
        // Need to speed up a lot: chain multiple atempo filters
        let remainingRatio = speedRatio;
        let tempoFilters = [];
        
        while (remainingRatio > 2.0) {
          tempoFilters.push('atempo=2.0');
          remainingRatio /= 2.0;
        }
        tempoFilters.push(`atempo=${remainingRatio.toFixed(3)}`);
        
        filters.push(tempoFilters.join(','));
        console.log(`Chained speed up: ${tempoFilters.join(',')}`);
      } else {
        // Need to slow down a lot: chain multiple atempo filters  
        let remainingRatio = speedRatio;
        let tempoFilters = [];
        
        while (remainingRatio < 0.5) {
          tempoFilters.push('atempo=0.5');
          remainingRatio /= 0.5;
        }
        tempoFilters.push(`atempo=${remainingRatio.toFixed(3)}`);
        
        filters.push(tempoFilters.join(','));
        console.log(`Chained slow down: ${tempoFilters.join(',')}`);
      }

      // Add volume boost and format conversion - boost speech significantly
      const channelLayout = bgAnalysis.format.channels === 1 ? "mono" : "stereo";
      filters.push(`volume=5.0`); // Increased from 3.0 to 5.0 for better audibility
      filters.push(`aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`);

      // Combine all filters
      const filterString = filters.join(',');

      // Process the speech file with duration matching and volume boost
      await execAsync(
        `ffmpeg -threads 2 -i "${speechPath}" -af "${filterString}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${processedPath}"`
      );

      // Verify the output file and check final duration
      await this.fileProcessor.verifyFile(processedPath);
      
      const finalDuration = await this.getTTSFileDuration(processedPath);
      const durationDiff = Math.abs(finalDuration - targetDuration);
      
      console.log(`Speech ${index} final duration: ${finalDuration.toFixed(3)}s (diff: ${durationDiff.toFixed(3)}s)`);
      
      if (durationDiff > 0.1) {
        console.warn(`Duration mismatch for segment ${index}: expected ${targetDuration.toFixed(3)}s, got ${finalDuration.toFixed(3)}s`);
      }

      return processedPath;
    } catch (error) {
      console.error(`Error processing speech file ${index}:`, error);
      throw error;
    }
  }

  /**
   * Get the duration of a TTS file using ffprobe
   */
  private async getTTSFileDuration(filePath: string): Promise<number> {
    try {
      const { stdout } = await execAsync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`
      );
      return parseFloat(stdout.trim());
    } catch (error) {
      console.error(`Error getting duration for ${filePath}:`, error);
      throw new Error(`Failed to get duration for ${filePath}`);
    }
  }

  private async applyConsistentFinalProcessing(
    inputPath: string,
    originalAnalysis: any
  ): Promise<string> {
    try {
      console.log(
        "Applying final processing with speech clarity enhancement..."
      );

      // Create an output path
      const outputPath = await this.fileProcessor.createTempPath(
        "final_processed",
        "wav"
      );

      // Extract basic format parameters
      const channelLayout =
        originalAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Final processing to ensure speech clarity and consistent volume
      const finalFilter =
        `aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout},` +
        `highpass=f=80,` + // Remove low-frequency rumble
        `lowpass=f=8000,` + // Remove high-frequency noise
        `compand=attacks=0.01:decays=0.2:points=-80/-80|-50/-25|-30/-15|-5/-5|0/-2:soft-knee=2:gain=3,` +
        `loudnorm=I=-18:TP=-2:LRA=7`; // Final loudness normalization

      // Process the final audio with enhanced clarity
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
