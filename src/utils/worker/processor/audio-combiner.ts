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

      // Create a temporary directory for the combined audio segments
      const outputDir = await this.fileProcessor.createTempDir(
        "combined_segments"
      );

      // Create silent audio with EXACT same duration, sample rate and channels as background
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

      // Process each speech segment and prepare for timing
      let speechSegmentPaths: SpeechSegment[] = [];

      // Create speech segments with original audio quality (no processing)
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

        speechSegmentPaths.push({
          path: speechPaths[i], // Use original speech files without processing
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

      // Build filter complex to position each speech segment at correct time
      let filterComplex = "";

      // Add each speech input with proper delay and volume boost
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];
        const inputIndex = i + 1; // +1 because silent background is input 0
        const startTime = segment.adjustedStart || segment.start;

        // Position speech segment at correct timestamp with volume boost
        filterComplex += `[${inputIndex}:a]volume=3.0,adelay=${Math.round(
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

      // Final mix of speech and background - simple mixing without volume changes
      filterComplex += `[speechmix][${speechSegmentPaths.length + 1}:a]amix=inputs=2:duration=first[out]`;

      // Create input arguments string for ffmpeg
      let inputArgs = `-threads 2 -i "${silentBgPath}" `;

      // Add all speech segments
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        inputArgs += `-i "${speechSegmentPaths[i].path}" `;
      }

      // Add background track
      inputArgs += `-i "${backgroundPath}" `;

      // Final output path
      const finalPath = await this.fileProcessor.createTempPath(
        "final_audio",
        "wav"
      );

      // Execute ffmpeg with filter complex that preserves original audio quality
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

      return finalPath;
    } catch (error) {
      console.error("Error combining audio files:", error);
      throw error;
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
}