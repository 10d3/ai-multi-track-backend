import { promisify } from "util";
import { exec } from "child_process";
import path from "path";
import fs from "fs/promises";
import type { Transcript } from "../../types/type";
import { FileProcessor } from "./file-processor";

const execAsync = promisify(exec);

export class SpeakerReferenceProcessor {
  private fileProcessor: FileProcessor;
  private speakerReferenceAudios: Map<string, string> = new Map();

  constructor(fileProcessor: FileProcessor) {
    this.fileProcessor = fileProcessor;
  }

  /**
   * Get the reference audio path for a specific speaker
   * @param speaker Speaker identifier
   * @returns Path to the reference audio file or undefined if not found
   */
  public getReferenceAudio(speaker: string): string | undefined {
    return this.speakerReferenceAudios.get(speaker);
  }

  /**
   * Get all speaker reference audio paths
   * @returns Map of speaker identifiers to reference audio paths
   */
  public getAllReferenceAudios(): Map<string, string> {
    return this.speakerReferenceAudios;
  }

  /**
   * Extracts speaker reference audio segments from the separated vocals using transcript timestamps
   * @param vocalsPath Path to the separated vocals audio file
   * @param transcript Array of transcript segments with speaker labels and timestamps
   */
  public async extractSpeakerReferences(
    vocalsPath: string,
    transcript: Transcript[]
  ): Promise<void> {
    try {
      // Group transcript segments by speaker
      const speakerSegments: { [speaker: string]: Transcript[] } = {};

      // Check if we have speaker labels in the transcript
      const hasMultipleSpeakers =
        new Set(transcript.map((t) => t.speaker)).size > 1;

      if (hasMultipleSpeakers) {
        // Group segments by speaker
        for (const segment of transcript) {
          if (!segment.speaker) continue;

          if (!speakerSegments[segment.speaker]) {
            speakerSegments[segment.speaker] = [];
          }
          speakerSegments[segment.speaker].push(segment);
        }

        // For each speaker, extract and combine their segments
        for (const speaker in speakerSegments) {
          const segments = speakerSegments[speaker];
          const speakerReferencePath = await this.createSpeakerReference(
            vocalsPath,
            segments,
            speaker
          );

          if (speakerReferencePath) {
            this.speakerReferenceAudios.set(speaker, speakerReferencePath);
            console.log(
              `Created reference audio for speaker ${speaker}: ${speakerReferencePath}`
            );
          }
        }
      } else {
        // If only one speaker or no speaker labels, take a longer segment
        const singleSpeakerPath = await this.extractSingleSpeakerReference(
          vocalsPath
        );
        const speaker = transcript[0]?.speaker || "default";
        this.speakerReferenceAudios.set(speaker, singleSpeakerPath);
        console.log(`Created single speaker reference: ${singleSpeakerPath}`);
      }
    } catch (error) {
      console.error("Failed to extract speaker references:", error);
    }
  }

  /**
   * Creates a reference audio file for a specific speaker by combining their segments
   */
  private async createSpeakerReference(
    vocalsPath: string,
    segments: Transcript[],
    speaker: string
  ): Promise<string | null> {
    try {
      // Sort segments by start time
      segments.sort((a, b) => a.start - b.start);

      // Create a directory for this speaker's segments
      const speakerDir = await this.fileProcessor.createTempDir(
        `speaker_${speaker}`
      );
      const segmentFiles: string[] = [];

      // Extract each segment
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        if (segment.start === undefined || segment.end === undefined) continue;

        const duration = segment.end - segment.start;
        if (duration < 0.5) continue; // Skip very short segments

        const segmentPath = path.join(speakerDir, `segment_${i}.wav`);
        await execAsync(
          `ffmpeg -i "${vocalsPath}" -ss ${segment.start} -t ${duration} -c:a pcm_s16le "${segmentPath}"`
        );

        // Verify the file was created successfully
        try {
          await this.fileProcessor.verifyFile(segmentPath);
          segmentFiles.push(segmentPath);
        } catch (e) {
          console.warn(
            `Failed to extract segment ${i} for speaker ${speaker}:`,
            e
          );
        }
      }

      if (segmentFiles.length === 0) {
        console.warn(`No valid segments extracted for speaker ${speaker}`);
        return null;
      }

      // Calculate total duration of extracted segments
      let totalDuration = 0;
      for (const file of segmentFiles) {
        const { stdout } = await execAsync(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`
        );
        totalDuration += parseFloat(stdout.trim());
      }

      // If we have enough audio already (>10 seconds), combine the segments
      if (totalDuration >= 10) {
        return this.combineAudioSegments(segmentFiles, speaker);
      }
      // If we don't have enough audio, try to extract more by taking longer segments
      else if (segmentFiles.length > 0) {
        // Take the longest segments and extend them slightly
        const extendedSegments: string[] = [];

        for (let i = 0; i < Math.min(3, segments.length); i++) {
          const segment = segments[i];
          if (segment.start === undefined || segment.end === undefined)
            continue;

          // Extend segment by 1 second on each side if possible
          const extendedStart = Math.max(0, segment.start - 1);
          const extendedEnd = segment.end + 1;
          const duration = extendedEnd - extendedStart;

          const extendedPath = path.join(speakerDir, `extended_${i}.wav`);
          await execAsync(
            `ffmpeg -i "${vocalsPath}" -ss ${extendedStart} -t ${duration} -c:a pcm_s16le "${extendedPath}"`
          );

          try {
            await this.fileProcessor.verifyFile(extendedPath);
            extendedSegments.push(extendedPath);
          } catch (e) {
            console.warn(
              `Failed to extract extended segment ${i} for speaker ${speaker}:`,
              e
            );
          }
        }

        if (extendedSegments.length > 0) {
          return this.combineAudioSegments(extendedSegments, speaker);
        }
      }

      // If we still don't have enough audio, use the original vocals as fallback
      console.warn(
        `Not enough audio for speaker ${speaker}, using full vocals as fallback`
      );
      return vocalsPath;
    } catch (error) {
      console.error(
        `Failed to create reference for speaker ${speaker}:`,
        error
      );
      return null;
    }
  }

  /**
   * Combines multiple audio segments into a single file
   */
  private async combineAudioSegments(
    segmentFiles: string[],
    speaker: string
  ): Promise<string> {
    const outputPath = await this.fileProcessor.createTempPath(
      `speaker_${speaker}_reference`,
      "wav"
    );

    if (segmentFiles.length === 1) {
      // If only one segment, just copy it
      await fs.copyFile(segmentFiles[0], outputPath);
      return outputPath;
    }

    // Create a file list for ffmpeg
    const fileListPath = await this.fileProcessor.createTempPath(
      "file_list",
      "txt"
    );
    const fileListContent = segmentFiles
      .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await fs.writeFile(fileListPath, fileListContent);

    // Combine the files
    await execAsync(
      `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c:a pcm_s16le "${outputPath}"`
    );

    await this.fileProcessor.verifyFile(outputPath);
    return outputPath;
  }

  /**
   * Extracts a longer segment from vocals for single speaker reference
   */
  private async extractSingleSpeakerReference(
    vocalsPath: string
  ): Promise<string> {
    try {
      // Get the duration of the vocals file
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${vocalsPath}"`
      );
      const totalDuration = parseFloat(stdout.trim());

      // Take up to 40 seconds from the middle of the file
      const targetDuration = Math.min(40, totalDuration);
      const startTime = (totalDuration - targetDuration) / 2; // Start from the middle

      const outputPath = await this.fileProcessor.createTempPath(
        "single_speaker_reference",
        "wav"
      );
      await execAsync(
        `ffmpeg -i "${vocalsPath}" -ss ${startTime} -t ${targetDuration} -c:a pcm_s16le "${outputPath}"`
      );

      await this.fileProcessor.verifyFile(outputPath);
      return outputPath;
    } catch (error) {
      console.error("Failed to extract single speaker reference:", error);
      return vocalsPath; // Fallback to the original vocals
    }
  }
}
