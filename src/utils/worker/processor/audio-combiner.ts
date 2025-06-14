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
  start: number; // in milliseconds
  end: number; // in milliseconds
  originalIndex: number;
  adjustedStart?: number; // in milliseconds
  adjustedEnd?: number; // in milliseconds
}

// Assuming these interfaces are defined elsewhere
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
  /**
   * Gets the duration of an audio file in seconds using ffprobe.
   */

  private async getAudioDuration(filePath: string): Promise<number> {
    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
      );
      return parseFloat(stdout.trim());
    } catch (error) {
      console.error(`Error getting audio duration for: ${filePath}`, error);
      throw new Error("Could not determine audio duration.");
    }
  }
  /**
   * Combines multiple speech segments over a background audio track.
   * The final output is truncated to match the background audio's duration.
   */

  async combineAudioFiles(
    backgroundPath: string,
    speechPaths: string[],
    transcript: Transcript[]
  ): Promise<string> {
    try {
      if (!backgroundPath || !speechPaths.length) {
        throw new Error("Missing background or speech audio files.");
      }

      const backgroundDuration = await this.getAudioDuration(backgroundPath);
      console.log(
        `Background audio duration: ${backgroundDuration.toFixed(3)} seconds.`
      );

      const outputDir = await this.fileProcessor.createTempDir(
        "combined_audio"
      ); // 1. Process and prepare all speech segments

      let speechSegments: SpeechSegment[] = [];
      for (let i = 0; i < speechPaths.length; i++) {
        const segment = transcript[i];
        if (
          !segment ||
          segment.start === undefined ||
          segment.end === undefined
        ) {
          console.warn(`Skipping segment ${i} due to missing transcript data.`);
          continue;
        }
        const processedSpeechPath = await this.processSpeechForConsistency(
          speechPaths[i],
          outputDir,
          i
        );
        speechSegments.push({
          path: processedSpeechPath,
          start: segment.start,
          end: segment.end,
          originalIndex: i,
        });
      } // Sort by start time to ensure logical processing

      speechSegments.sort((a, b) => a.start - b.start); // Adjust timing via external script (your existing logic)

      speechSegments = await this.adjustSpeechTiming(speechSegments); // 2. Construct the FFMPEG command

      let inputArgs = `-i "${backgroundPath}" `;
      speechSegments.forEach((segment) => {
        inputArgs += `-i "${segment.path}" `;
      });

      let filterComplexParts: string[] = [];
      let finalMixInputs = "[0:a]"; // Start with the background track

      speechSegments.forEach((segment, index) => {
        const inputIndex = index + 1;
        const startTimeMs = Math.round(segment.adjustedStart ?? segment.start);
        const delay = `${startTimeMs}|${startTimeMs}`;
        filterComplexParts.push(`[${inputIndex}:a]adelay=${delay}[s${index}]`);
        finalMixInputs += `[s${index}]`;
      }); // 3. Create the final 'amix' filter. // - duration=longest: Mixes until the longest input (likely a delayed speech track) ends. // The final duration will be enforced by the top-level '-t' option.

      const totalInputs = speechSegments.length + 1;
      filterComplexParts.push(
        `${finalMixInputs}amix=inputs=${totalInputs}:duration=longest:dropout_transition=0[out]`
      );
      const filterComplex = filterComplexParts.join(";");

      const finalPath = await this.fileProcessor.createTempPath(
        "final_audio",
        "wav"
      ); // Use the top-level '-t' option to explicitly set the output duration. This is the most reliable method.
      const ffmpegCommand = `ffmpeg -y ${inputArgs.trim()} -filter_complex "${filterComplex}" -map "[out]" -t ${backgroundDuration} -c:a pcm_s24le "${finalPath}"`;

      console.log("Executing FFMPEG Command:", ffmpegCommand);
      await execAsync(ffmpegCommand);

      await this.fileProcessor.verifyFile(finalPath);
      const processedPath = await this.applyConsistentFinalProcessing(
        finalPath
      );
      return processedPath;
    } catch (error) {
      console.error("Error combining audio files:", error);
      throw error;
    }
  }
  /**
   * Adjusts speech timing. The logic here depends on your Python script.
   */
  private async adjustSpeechTiming(
    segments: SpeechSegment[]
  ): Promise<SpeechSegment[]> {
    const adjustedSegments: SpeechSegment[] = [];
    for (const segment of segments) {
      try {
        const targetDurationMs = segment.end - segment.start;
        const targetDurationSec = targetDurationMs / 1000.0;

        const adjustedPath = await this.fileProcessor.createTempPath(
          `tempo_adjusted_${segment.originalIndex}`,
          "wav"
        );
        const scriptPath = path.resolve("./src/script/adjust_speech_timing.py");

        const { stdout, stderr } = await execAsync(
          `python "${scriptPath}" "${segment.path}" ${targetDurationSec} "${adjustedPath}"`
        );

        if (stdout)
          console.log(
            `Python script stdout for segment ${segment.originalIndex}:`,
            stdout
          );
        if (stderr)
          console.warn(
            `Python script stderr for segment ${segment.originalIndex}:`,
            stderr
          );
        await this.fileProcessor.verifyFile(adjustedPath);

        adjustedSegments.push({
          ...segment,
          path: adjustedPath,
          adjustedStart: segment.start,
          adjustedEnd: segment.end,
        });
      } catch (error) {
        console.error(
          `Failed to adjust timing for segment ${segment.originalIndex}, using original.`,
          error
        );
        adjustedSegments.push({ ...segment }); // Fallback to original
      }
    }
    return adjustedSegments;
  }

  private async processSpeechForConsistency(
    speechPath: string,
    outputDir: string,
    index: number
  ): Promise<string> {
    try {
      const processedPath = path.join(
        outputDir,
        `processed_speech_${index}.wav`
      );
      await execAsync(
        `ffmpeg -y -i "${speechPath}" -af "volume=2.0" "${processedPath}"`
      );
      await this.fileProcessor.verifyFile(processedPath);
      return processedPath;
    } catch (error) {
      console.error(`Error processing speech file ${index}:`, error);
      throw error;
    }
  }

  private async applyConsistentFinalProcessing(
    inputPath: string
  ): Promise<string> {
    // Placeholder for any final mastering (e.g., loudnorm, compression)
    return inputPath;
  }
}
