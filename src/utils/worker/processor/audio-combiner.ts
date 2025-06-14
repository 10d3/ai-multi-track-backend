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
   * Gets the duration of an audio file in seconds
   */
  private async getAudioDuration(filePath: string): Promise<number> {
    try {
      const { stdout } = await execAsync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`
      );
      return parseFloat(stdout.trim());
    } catch (error) {
      console.error("Error getting audio duration:", error);
      throw error;
    }
  }

  /**
   * Combines multiple speech segments over a background audio track.
   * This revised method uses a single, robust filter_complex command.
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

      // Get the background audio duration first
      const backgroundDuration = await this.getAudioDuration(backgroundPath);
      console.log(`Background audio duration: ${backgroundDuration} seconds`);

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

      speechSegments = await this.adjustSpeechTiming(speechSegments); // 2. Construct the FFMPEG command // The background track will be the first input [0:a]

      console.log(speechSegments.map((t) => {
        console.log(t)
      }))

      let inputArgs = `-i "${backgroundPath}" `; // Add each speech segment as a subsequent input
      speechSegments.forEach((segment) => {
        inputArgs += `-i "${segment.path}" `;
      });

      let filterComplexParts: string[] = [];
      let finalMixInputs = "[0:a]"; // Start with the background track // For each speech input, create a delayed stream

      speechSegments.forEach((segment, index) => {
        // The first speech segment corresponds to input [1:a], second to [2:a], etc.
        const inputIndex = index + 1;
        const startTimeMs = Math.round(segment.adjustedStart ?? segment.start);

        // adelay filter requires delays per-channel in milliseconds.
        const delay = `${startTimeMs}|${startTimeMs}`;

        // Create a delayed audio stream and label it e.g., [s0], [s1]
        filterComplexParts.push(`[${inputIndex}:a]adelay=${delay}[s${index}]`);
        finalMixInputs += `[s${index}]`;
      });

      // 3. Create the final 'amix' filter to combine everything

      // This single amix combines the background ([0:a]) and all delayed speech streams ([s0], [s1]...)
      // - duration=first: The output will match the duration of the first input (background audio).
      // - dropout_transition=0: Prevents volume changes when streams end.
      const totalInputs = speechSegments.length + 1;
      filterComplexParts.push(
        `${finalMixInputs}amix=inputs=${totalInputs}:duration=first:dropout_transition=0[out]`
      );
      const filterComplex = filterComplexParts.join(";");

      const finalPath = await this.fileProcessor.createTempPath(
        "final_audio",
        "wav"
      );

      const ffmpegCommand = `ffmpeg ${inputArgs.trim()} -filter_complex "${filterComplex}" -map "[out]" -c:a pcm_s24le "${finalPath}"`;

      console.log("Executing FFMPEG Command:", ffmpegCommand);
      await execAsync(ffmpegCommand);

      await this.fileProcessor.verifyFile(finalPath); // Your final processing step remains the same
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
   * IMPORTANT: Ensure your start/end times in the transcript are in MILLISECONDS.
   */

  private async adjustSpeechTiming(
    segments: SpeechSegment[]
  ): Promise<SpeechSegment[]> {
    const adjustedSegments: SpeechSegment[] = [];
    for (const segment of segments) {
      try {
        const targetDurationMs = segment.end - segment.start; // The Python script seems to expect duration in seconds
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
      // Using 'volume=2.0' (a 6dB gain) is a safer starting point than 3.0
      await execAsync(
        `ffmpeg -i "${speechPath}" -af "volume=3.0" "${processedPath}"`
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
