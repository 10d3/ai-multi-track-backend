import { promisify } from "util";
import { exec } from "child_process";
import path from "path";
import type { FileProcessor } from "./file-processor";
import type { AudioAnalyzer } from "./audio-analyzer";
import type { Transcript } from "../../types/type";

const execAsync = promisify(exec);

interface SpeechSegment {
  path: string;
  start: number; // in milliseconds
  end: number; // in milliseconds
  originalIndex: number;
  adjustedPath?: string;
}

export class AudioCombiner {
  private fileProcessor: FileProcessor;
  private audioAnalyzer: AudioAnalyzer;

  constructor(fileProcessor: FileProcessor, audioAnalyzer: AudioAnalyzer) {
    this.fileProcessor = fileProcessor;
    this.audioAnalyzer = audioAnalyzer;
  }

  /**
   * Get audio duration in seconds
   */
  private async getAudioDuration(filePath: string): Promise<number> {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`
    );
    return parseFloat(stdout.trim());
  }

  /**
   * Combines speech segments with background audio at precise timing
   */
  async combineAudioFiles(
    backgroundPath: string,
    speechPaths: string[],
    transcript: Transcript[]
  ): Promise<string> {
    if (!backgroundPath || !speechPaths.length) {
      throw new Error("Missing background or speech audio files");
    }

    const backgroundDuration = await this.getAudioDuration(backgroundPath);
    console.log(`Background duration: ${backgroundDuration.toFixed(2)}s`);

    // Prepare speech segments
    const speechSegments: SpeechSegment[] = [];
    for (let i = 0; i < speechPaths.length; i++) {
      const segment = transcript[i];
      if (!segment?.start || !segment?.end) {
        console.warn(`Skipping segment ${i} - missing timing data`);
        continue;
      }

      speechSegments.push({
        path: speechPaths[i],
        start: segment.start,
        end: segment.end,
        originalIndex: i,
      });
    }

    // Sort by start time
    speechSegments.sort((a, b) => a.start - b.start);

    // CRUCIAL: Adjust speech timing to match transcript slots exactly
    const adjustedSegments = await this.adjustSpeechTiming(speechSegments);

    // Build FFmpeg command
    let inputArgs = `-i "${backgroundPath}" `;
    adjustedSegments.forEach((segment) => {
      inputArgs += `-i "${segment.adjustedPath || segment.path}" `;
    });

    const filterParts: string[] = [];
    let mixInputs = "[0:a]"; // Background audio

    // Create delayed speech streams
    adjustedSegments.forEach((segment, index) => {
      const inputIndex = index + 1;
      const startTimeMs = Math.round(segment.start);
      const delay = `${startTimeMs}|${startTimeMs}`;

      filterParts.push(`[${inputIndex}:a]adelay=${delay}[s${index}]`);
      mixInputs += `[s${index}]`;
    });

    // Combine all audio streams
    const totalInputs = adjustedSegments.length + 1;
    filterParts.push(
      `${mixInputs}amix=inputs=${totalInputs}:duration=first:dropout_transition=0[out]`
    );

    const filterComplex = filterParts.join(";");
    const outputPath = await this.fileProcessor.createTempPath(
      "final_audio",
      "wav"
    );

    const ffmpegCommand = `ffmpeg -y ${inputArgs.trim()} -filter_complex "${filterComplex}" -map "[out]" -c:a pcm_s24le "${outputPath}"`;

    console.log("Combining audio with precise timing...");
    await execAsync(ffmpegCommand);
    await this.fileProcessor.verifyFile(outputPath);

    return outputPath;
  }

  /**
   * CRUCIAL: Adjusts speech timing to match transcript slots exactly
   * This ensures perfect synchronization with the original timing
   */
  private async adjustSpeechTiming(
    segments: SpeechSegment[]
  ): Promise<SpeechSegment[]> {
    console.log(`Adjusting timing for ${segments.length} speech segments...`);

    const adjustedSegments: SpeechSegment[] = [];

    for (const segment of segments) {
      try {
        // Get actual duration of the generated speech
        const actualDuration = await this.getAudioDuration(segment.path);
        const targetDurationMs = segment.end - segment.start;
        const targetDurationSec = targetDurationMs / 1000;

        console.log(
          `Segment ${segment.originalIndex}: ${actualDuration.toFixed(
            2
          )}s → ${targetDurationSec.toFixed(2)}s`
        );

        // Calculate speed adjustment needed
        const speedRatio = actualDuration / targetDurationSec;

        // Only adjust if significant difference (>5%)
        if (Math.abs(speedRatio - 1.0) > 0.05) {
          const adjustedPath = await this.fileProcessor.createTempPath(
            `tempo_adjusted_${segment.originalIndex}`,
            "wav"
          );

          const scriptPath = path.resolve(
            "./src/script/adjust_speech_timing.py"
          );

          // Call Python script to adjust timing
          const { stdout, stderr } = await execAsync(
            `python "${scriptPath}" "${segment.path}" ${targetDurationSec} "${adjustedPath}"`
          );

          if (stderr && !stderr.includes("Defaulting")) {
            console.warn(
              `Timing adjustment warning for segment ${segment.originalIndex}:`,
              stderr
            );
          }

          await this.fileProcessor.verifyFile(adjustedPath);

          // Verify the adjustment worked
          const finalDuration = await this.getAudioDuration(adjustedPath);
          const accuracy = Math.abs(finalDuration - targetDurationSec);

          if (accuracy > 0.1) {
            console.warn(
              `Segment ${
                segment.originalIndex
              }: Timing accuracy ${accuracy.toFixed(3)}s off target`
            );
          }

          adjustedSegments.push({
            ...segment,
            adjustedPath,
          });
        } else {
          // No significant adjustment needed
          adjustedSegments.push(segment);
        }
      } catch (error) {
        console.error(
          `Failed to adjust timing for segment ${segment.originalIndex}:`,
          error
        );
        // Use original segment if adjustment fails
        adjustedSegments.push(segment);
      }
    }

    console.log(
      `Timing adjustment complete: ${adjustedSegments.length} segments ready`
    );
    return adjustedSegments;
  }
}
