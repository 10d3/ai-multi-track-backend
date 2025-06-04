import { promisify } from "util";
import { exec } from "child_process";
import path from "path";
import type { FileProcessor } from "./file-processor";
import type { AudioAnalyzer } from "./audio-analyzer";
import type { Transcript } from "../../types/type";
import fs from "fs/promises";

interface AudioSegment {
  path: string;
  start: number;
  end: number;
  duration: number;
  originalIndex: number;
  transcriptDuration: number;
  actualDuration: number;
  wasRepositioned: boolean;
}

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

      // Step 1: Create completely silent background track with exact duration
      const silentBgPath = await this.createSilentBackground(bgAnalysis);

      // Step 2: Process and validate speech segments with overlap detection
      const processedSegments = await this.processAndValidateSpeechSegments(
        speechPaths,
        transcript,
        outputDir,
        bgAnalysis
      );

      // Step 3: Create precise audio timeline with gap filling
      const timelinePath = await this.createPreciseAudioTimeline(
        silentBgPath,
        processedSegments,
        bgAnalysis
      );

      // Step 4: Apply final processing to ensure original audio is completely replaced
      const finalPath = await this.applyFinalReplacementProcessing(
        timelinePath,
        backgroundPath,
        bgAnalysis
      );

      return finalPath;
    } catch (error) {
      console.error("Error combining audio files:", error);
      throw error;
    }
  }

  private async createSilentBackground(bgAnalysis: any): Promise<string> {
    const silentBgPath = await this.fileProcessor.createTempPath(
      "silent_bg",
      "wav"
    );

    const channelLayout = bgAnalysis.format.channels === 1 ? "mono" : "stereo";

    // Create completely silent audio with exact same characteristics
    await execAsync(
      `ffmpeg -threads 2 -f lavfi -i anullsrc=r=${bgAnalysis.format.sampleRate}:cl=${channelLayout} -t ${bgAnalysis.duration} -c:a pcm_s24le "${silentBgPath}"`
    );

    await this.fileProcessor.verifyFile(silentBgPath);
    return silentBgPath;
  }

  private async processAndValidateSpeechSegments(
    speechPaths: string[],
    transcript: Transcript[],
    outputDir: string,
    bgAnalysis: any
  ) {
    const segments: AudioSegment[] = [];

    // First pass: analyze actual speech file durations
    console.log("Analyzing actual speech file durations...");
    const speechAnalyses = [];
    for (let i = 0; i < speechPaths.length; i++) {
      try {
        const analysis = await this.audioAnalyzer.analyzeAudio(speechPaths[i]);
        speechAnalyses.push({
          index: i,
          actualDuration: analysis.duration,
          path: speechPaths[i],
        });
        console.log(
          `Speech ${i}: actual duration = ${analysis.duration.toFixed(3)}s`
        );
      } catch (error) {
        console.error(`Failed to analyze speech file ${i}:`, error);
        speechAnalyses.push({
          index: i,
          actualDuration: 0,
          path: speechPaths[i],
        });
      }
    }

    // Process each segment with actual duration validation
    for (let i = 0; i < speechPaths.length; i++) {
      const segment = transcript[i];
      const speechAnalysis = speechAnalyses[i];

      if (
        !segment ||
        segment.start === undefined ||
        segment.end === undefined
      ) {
        console.warn(`Missing transcript data for segment ${i}, skipping`);
        continue;
      }

      if (speechAnalysis.actualDuration === 0) {
        console.warn(`Invalid speech file ${i}, skipping`);
        continue;
      }

      // Calculate transcript duration vs actual duration
      const transcriptDuration = segment.end - segment.start;
      const actualDuration = speechAnalysis.actualDuration;

      console.log(
        `Segment ${i}: transcript=${transcriptDuration.toFixed(
          3
        )}s, actual=${actualDuration.toFixed(3)}s`
      );

      // Use the longer of the two durations to prevent cutoff
      const safeDuration = Math.max(transcriptDuration, actualDuration);

      // Check for overlaps using actual durations
      let adjustedStart = segment.start;
      let adjustedEnd = segment.start + safeDuration;

      // Check against all existing segments
      const hasOverlap = segments.some(
        (existing) =>
          adjustedStart < existing.end && adjustedEnd > existing.start
      );

      if (hasOverlap) {
        console.warn(`Segment ${i} would overlap. Repositioning...`);
        // Find the latest end time and position after it
        const latestEnd = Math.max(...segments.map((s) => s.end), 0);
        adjustedStart = latestEnd + 0.2; // Add 200ms gap for safety
        adjustedEnd = adjustedStart + safeDuration;

        console.log(
          `Segment ${i} repositioned: ${adjustedStart.toFixed(
            3
          )}s - ${adjustedEnd.toFixed(3)}s`
        );
      }

      // Validate that segment fits within background duration
      if (adjustedEnd > bgAnalysis.duration) {
        console.warn(
          `Segment ${i} extends beyond background duration. Truncating...`
        );
        adjustedEnd = bgAnalysis.duration - 0.1; // Leave 100ms at end
        if (adjustedEnd <= adjustedStart) {
          console.warn(`Segment ${i} cannot fit, skipping`);
          continue;
        }
      }

      // Process speech with enhanced volume and noise reduction
      const processedPath = await this.processSpeechForConsistency(
        speechPaths[i],
        outputDir,
        i,
        bgAnalysis
      );

      segments.push({
        path: processedPath,
        start: adjustedStart,
        end: adjustedEnd,
        duration: adjustedEnd - adjustedStart,
        originalIndex: i,
        transcriptDuration: transcriptDuration,
        actualDuration: actualDuration,
        wasRepositioned: adjustedStart !== segment.start,
      });
    }

    // Sort by start time for chronological processing
    segments.sort((a, b) => a.start - b.start);

    // Final validation pass - check for any remaining overlaps
    for (let i = 1; i < segments.length; i++) {
      const current = segments[i];
      const previous = segments[i - 1];

      if (current.start < previous.end) {
        console.warn(
          `Final overlap detected between segments ${previous.originalIndex} and ${current.originalIndex}`
        );
        // Push current segment after previous
        const gap = 0.3; // 300ms gap
        current.start = previous.end + gap;
        current.end = current.start + current.duration;
        current.wasRepositioned = true;

        // Check if it still fits
        if (current.end > bgAnalysis.duration) {
          console.warn(
            `Segment ${current.originalIndex} truncated to fit background`
          );
          current.end = bgAnalysis.duration - 0.1;
          current.duration = current.end - current.start;
        }
      }
    }

    console.log(
      "Final segments timeline with actual durations:",
      segments.map((s) => ({
        originalIndex: s.originalIndex,
        start: s.start.toFixed(3),
        end: s.end.toFixed(3),
        duration: s.duration.toFixed(3),
        transcriptDur: s.transcriptDuration.toFixed(3),
        actualDur: s.actualDuration.toFixed(3),
        repositioned: s.wasRepositioned,
      }))
    );

    return segments;
  }

  private async createPreciseAudioTimeline(
    silentBgPath: string,
    segments: AudioSegment[],
    bgAnalysis: any
  ): Promise<string> {
    const timelinePath = await this.fileProcessor.createTempPath(
      "precise_timeline",
      "wav"
    );

    if (segments.length === 0) {
      // If no segments, return the silent background
      await execAsync(
        `ffmpeg -threads 2 -i "${silentBgPath}" -c:a pcm_s24le "${timelinePath}"`
      );
      return timelinePath;
    }

    // Build precise filter complex for exact positioning with actual durations
    let filterComplex = "";
    let inputArgs = `-threads 2 -i "${silentBgPath}" `;

    // Add all speech segments as inputs
    segments.forEach((segment, index) => {
      inputArgs += `-i "${segment.path}" `;
    });

    // Create delayed and trimmed segments based on actual durations
    segments.forEach((segment, index) => {
      const inputIndex = index + 1; // +1 because silent bg is input 0
      const delayMs = Math.round(segment.start * 1000);

      // Use the calculated duration (which considers actual audio length)
      // Trim to exact duration to prevent overrun, then add precise delay
      filterComplex += `[${inputIndex}:a]atrim=0:${segment.duration.toFixed(
        6
      )},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[seg${index}];`;
    });

    // Mix all segments with the silent background using precise timing
    filterComplex += `[0:a]`;
    segments.forEach((_, index) => {
      filterComplex += `[seg${index}]`;
    });

    // Use amix with dropout_transition=0 to prevent gaps and ensure clean mixing
    filterComplex += `amix=inputs=${
      segments.length + 1
    }:duration=first:dropout_transition=0:normalize=0[timeline]`;

    console.log("Audio timeline construction:", {
      totalSegments: segments.length,
      backgroundDuration: bgAnalysis.duration.toFixed(3) + "s",
      segmentPositions: segments.map(
        (s) => `${s.start.toFixed(3)}-${s.end.toFixed(3)}s`
      ),
    });

    // Execute timeline creation with precise timing
    await execAsync(
      `ffmpeg ${inputArgs} -filter_complex "${filterComplex}" -map "[timeline]" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} -t ${bgAnalysis.duration} "${timelinePath}"`
    );

    await this.fileProcessor.verifyFile(timelinePath);

    // Verify timeline duration matches background
    const timelineAnalysis = await this.audioAnalyzer.analyzeAudio(
      timelinePath
    );
    console.log("Timeline validation:", {
      expectedDuration: bgAnalysis.duration.toFixed(3) + "s",
      actualDuration: timelineAnalysis.duration.toFixed(3) + "s",
      difference:
        Math.abs(bgAnalysis.duration - timelineAnalysis.duration).toFixed(3) +
        "s",
    });

    return timelinePath;
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

      // Enhanced speech processing with safe parameters
      // Fixed the anlmdn parameter 'r' to be within valid range (0.002-0.3)
      const enhancedFilter = [
        // Normalize loudness first
        "loudnorm=I=-23:LRA=7:TP=-1",
        // Apply noise reduction with SAFE parameters
        "anlmdn=s=7:p=0.002:r=0.002:m=15:b=1", // Fixed: r=0.002 instead of 0.001
        // Apply compression for consistent levels
        "acompressor=threshold=-24dB:ratio=4:attack=20:release=100",
        // Volume boost for prominence
        "volume=4.0",
        // Format conversion
        `aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
        // Fade in/out to prevent clicks
        "afade=t=in:st=0:d=0.01,afade=t=out:st=-0.01:d=0.01",
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

  private async applyFinalReplacementProcessing(
    timelinePath: string,
    originalBackgroundPath: string,
    bgAnalysis: any
  ): Promise<string> {
    try {
      console.log("Applying final replacement processing...");

      const finalPath = await this.fileProcessor.createTempPath(
        "final_replaced",
        "wav"
      );

      // Create a heavily attenuated background for ambiance only
      const attenuatedBgPath = await this.fileProcessor.createTempPath(
        "attenuated_bg",
        "wav"
      );

      // Reduce background to very low volume (5% of original)
      await execAsync(
        `ffmpeg -threads 2 -i "${originalBackgroundPath}" -af "volume=0.05" -c:a pcm_s24le "${attenuatedBgPath}"`
      );

      // Final mix: prioritize speech timeline over background
      const finalFilter = [
        // Mix timeline (speech) with heavily reduced background
        `[0:a][1:a]amix=inputs=2:duration=first:weights=0.95 0.05[mixed]`,
        // Apply final normalization
        `[mixed]loudnorm=I=-16:LRA=11:TP=-1.5[normalized]`,
        // Final format consistency
        `[normalized]aformat=sample_fmts=fltp:sample_rates=${
          bgAnalysis.format.sampleRate
        }:channel_layouts=${
          bgAnalysis.format.channels === 1 ? "mono" : "stereo"
        }[final]`,
      ].join(";");

      await execAsync(
        `ffmpeg -threads 2 -i "${timelinePath}" -i "${attenuatedBgPath}" -filter_complex "${finalFilter}" -map "[final]" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${finalPath}"`
      );

      // Verify final output
      await this.fileProcessor.verifyFile(finalPath);

      const finalAnalysis = await this.audioAnalyzer.analyzeAudio(finalPath);
      console.log("Final audio replacement validation:", {
        originalDuration: bgAnalysis.duration.toFixed(3) + "s",
        finalDuration: finalAnalysis.duration.toFixed(3) + "s",
        difference:
          Math.abs(bgAnalysis.duration - finalAnalysis.duration).toFixed(3) +
          "s",
        speechDominance: "95% speech, 5% background ambiance",
      });

      return finalPath;
    } catch (error) {
      console.error("Error applying final replacement processing:", error);
      throw error;
    }
  }
}
