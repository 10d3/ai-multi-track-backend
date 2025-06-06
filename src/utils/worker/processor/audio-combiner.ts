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
  adjustedStart?: number;
  adjustedEnd?: number;
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
          originalIndex: i,
        });
      }

      // Sort speech segments by start time and resolve overlaps
      speechSegmentPaths.sort((a, b) => a.start - b.start);

      // Resolve overlapping segments
      console.log("Resolving overlapping speech segments...");
      speechSegmentPaths = await this.resolveOverlappingSegments(
        speechSegmentPaths
      );

      // Log the processed segments
      console.log(
        "Speech segments after overlap resolution:",
        speechSegmentPaths.map((segment) => ({
          start: segment.adjustedStart || segment.start,
          end: segment.adjustedEnd || segment.end,
          originalIndex: segment.originalIndex,
          duration:
            (segment.adjustedEnd || segment.end) -
            (segment.adjustedStart || segment.start),
        }))
      );

      // Now build a filter complex to precisely position each speech segment
      let filterComplex = "";

      // Add each speech input to filter with proper delay based on adjusted start time
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];
        const inputIndex = i + 1; // +1 because silent background is input 0
        const startTime = segment.adjustedStart || segment.start;

        // Add each speech input to filter - with volume already boosted and positioned by timestamp
        filterComplex += `[${inputIndex}:a]adelay=${Math.round(
          startTime * 1000
        )}|${Math.round(startTime * 1000)}[speech${i}];`;
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

      // Keep background at original volume
      filterComplex += `[${speechSegmentPaths.length + 1}:a]volume=1.0[bg];`;

      // Final mix of speech and background - with original background volume
      filterComplex += `[speechmix][bg]amix=inputs=2:duration=first:weights=0.8 0.2[out]`;

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

  /**
   * Remove speech segments from background audio by replacing them with ambient noise or silence
   */
  private async removeSpeechFromBackground(
    backgroundPath: string,
    voiceSegments: VoiceActivitySegment[],
    bgAnalysis: any
  ): Promise<string> {
    try {
      if (voiceSegments.length === 0) {
        console.log("No voice segments detected, using original background");
        return backgroundPath;
      }

      console.log(
        `Removing ${voiceSegments.length} voice segments from background...`
      );

      const cleanBackgroundPath = await this.fileProcessor.createTempPath(
        "clean_background",
        "wav"
      );

      // Enhanced background processing
      const backgroundFilter = [
        // Gentle high-pass to remove rumble
        "highpass=f=60",
        // Subtle low-pass to reduce harshness
        "lowpass=f=12000",
        // Gentle compression to maintain consistent level
        "acompressor=threshold=-30dB:ratio=1.5:attack=100:release=300",
        // Subtle stereo enhancement
        "stereotools=m=1.2:s=0.8",
      ].join(",");

      // Process background with enhanced filters
      await execAsync(
        `ffmpeg -threads 2 -i "${backgroundPath}" -af "${backgroundFilter}" -c:a pcm_s24le "${cleanBackgroundPath}"`
      );

      await this.fileProcessor.verifyFile(cleanBackgroundPath);
      return cleanBackgroundPath;
    } catch (error) {
      console.error("Error processing background:", error);
      return backgroundPath;
    }
  }

  /**
   * Resolve overlapping speech segments by adjusting their timing
   */
  private async resolveOverlappingSegments(
    segments: SpeechSegment[]
  ): Promise<SpeechSegment[]> {
    const resolvedSegments = [...segments];
    const minGapBetweenSegments = 0.1; // 100ms minimum gap between segments

    for (let i = 0; i < resolvedSegments.length - 1; i++) {
      const current = resolvedSegments[i];
      const next = resolvedSegments[i + 1];

      const currentEnd = current.adjustedEnd || current.end;
      const nextStart = next.adjustedStart || next.start;

      // Check if segments overlap or are too close
      if (currentEnd + minGapBetweenSegments > nextStart) {
        console.log(
          `Resolving overlap between segments ${current.originalIndex} and ${next.originalIndex}`
        );

        const overlapDuration = currentEnd - nextStart + minGapBetweenSegments;
        const currentDuration =
          currentEnd - (current.adjustedStart || current.start);
        const nextDuration = (next.adjustedEnd || next.end) - nextStart;

        // Decide how to resolve based on segment durations
        if (currentDuration > nextDuration) {
          // Shorten the current segment
          current.adjustedEnd = nextStart - minGapBetweenSegments;
          console.log(
            `Shortened segment ${
              current.originalIndex
            } to end at ${current.adjustedEnd.toFixed(2)}s`
          );
        } else {
          // Delay the next segment
          const delay = currentEnd + minGapBetweenSegments - nextStart;
          next.adjustedStart = nextStart + delay;
          next.adjustedEnd = (next.adjustedEnd || next.end) + delay;
          console.log(
            `Delayed segment ${
              next.originalIndex
            } to start at ${next.adjustedStart.toFixed(2)}s`
          );
        }

        // Validate the adjusted segment doesn't have negative duration
        if (
          current.adjustedEnd &&
          current.adjustedEnd <= (current.adjustedStart || current.start)
        ) {
          console.warn(
            `Segment ${current.originalIndex} would have negative duration, skipping`
          );
          // Mark for removal by setting a flag
          (current as any).skip = true;
        }
      }
    }

    // Filter out segments marked for skipping and segments that are too short
    return resolvedSegments.filter((segment) => {
      const duration =
        (segment.adjustedEnd || segment.end) -
        (segment.adjustedStart || segment.start);
      return !(segment as any).skip && duration > 0.1; // Keep segments longer than 100ms
    });
  }

  private async processSpeechForConsistency(
    speechPath: string,
    outputDir: string,
    index: number,
    bgAnalysis: any
  ): Promise<string> {
    try {
      console.log(`Processing speech file ${index} with enhanced quality...`);

      const processedPath = path.join(
        outputDir,
        `processed_speech_${index}.wav`
      );
      const channelLayout =
        bgAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Enhanced speech processing with natural sound preservation
      const enhancedFilter = [
        // Gentle noise reduction
        "anlmdn=s=7:p=0.002:r=0.002:m=15:b=1",
        // Subtle compression for consistent levels
        "acompressor=threshold=-24dB:ratio=2:attack=50:release=200",
        // Gentle EQ to enhance speech clarity
        "equalizer=f=1000:width_type=h:width=200:g=3",
        "equalizer=f=3000:width_type=h:width=200:g=2",
        // Subtle de-essing to reduce harsh sibilants
        "highshelf=f=8000:g=-3",
        // Natural volume boost
        "volume=2.5",
        // Format conversion
        `aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
        // Smooth fades
        "afade=t=in:st=0:d=0.05,afade=t=out:st=-0.05:d=0.05",
      ].join(",");

      await execAsync(
        `ffmpeg -threads 2 -i "${speechPath}" -af "${enhancedFilter}" -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} -c:a pcm_s24le "${processedPath}"`
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
    originalAnalysis: any
  ): Promise<string> {
    try {
      console.log("Applying final processing with enhanced audio quality...");

      const outputPath = await this.fileProcessor.createTempPath(
        "final_processed",
        "wav"
      );

      const channelLayout =
        originalAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Enhanced final processing chain
      const finalFilter = [
        // Format conversion
        `aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
        // Subtle room reverb for natural sound
        "aecho=0.8:0.9:60:0.3",
        // Multiband compression for better control
        "acompressor=threshold=-20dB:ratio=1.5:attack=50:release=200",
        // Subtle stereo enhancement
        "stereotools=m=1.1:s=0.9",
        // Final loudness normalization
        "loudnorm=I=-16:LRA=11:TP=-1.5",
      ].join(",");

      await execAsync(
        `ffmpeg -threads 2 -i "${inputPath}" -af "${finalFilter}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} "${outputPath}"`
      );

      await this.fileProcessor.verifyFile(outputPath);

      const finalAnalysis = await this.audioAnalyzer.analyzeAudio(outputPath);
      console.log("Final audio quality metrics:", {
        duration: finalAnalysis.duration.toFixed(2) + "s",
        loudness: finalAnalysis.loudness.integrated.toFixed(2) + " LUFS",
        peak: finalAnalysis.loudness.truePeak.toFixed(2) + " dB",
        range: finalAnalysis.loudness.range.toFixed(2) + " LU",
      });

      return outputPath;
    } catch (error) {
      console.error("Error in final audio processing:", error);
      throw error;
    }
  }
}
