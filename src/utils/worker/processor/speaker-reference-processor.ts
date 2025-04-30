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
   * Creates reference audio files for all speakers in the transcript
   * @param originalAudio Path to the original audio file
   * @param transcript Array of transcript segments with speaker labels and timestamps
   * @returns Map of speaker IDs to reference audio paths
   */
  public async createReferenceAudio(
    originalAudio: string,
    transcript: Transcript[]
  ): Promise<Map<string, string>> {
    try {
      console.log(`Creating reference audio from ${originalAudio}`);

      // Verify the input file exists
      await this.fileProcessor.verifyFile(originalAudio);

      // Group transcript segments by speaker
      const speakerSegments: { [speaker: string]: Transcript[] } = {};

      // Group segments by speaker
      for (const segment of transcript) {
        if (!segment.speaker) continue;

        if (!speakerSegments[segment.speaker]) {
          speakerSegments[segment.speaker] = [];
        }
        speakerSegments[segment.speaker].push(segment);
      }

      // Process each speaker
      for (const speaker in speakerSegments) {
        const segments = speakerSegments[speaker];

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
          if (segment.start === undefined || segment.end === undefined)
            continue;

          const duration = segment.end - segment.start;
          if (duration < 1.0) continue; // Skip very short segments

          const segmentPath = path.join(speakerDir, `segment_${i}.wav`);
          await execAsync(
            `ffmpeg -i "${originalAudio}" -ss ${segment.start} -t ${duration} -c:a pcm_s16le "${segmentPath}"`
          );

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
          continue;
        }

        // Combine all segments into a single reference file
        const outputPath = await this.fileProcessor.createTempPath(
          `reference_${speaker}`,
          "wav"
        );

        if (segmentFiles.length === 1) {
          // If only one segment, just copy it
          await fs.copyFile(segmentFiles[0], outputPath);
        } else {
          // Create a file list for ffmpeg concat
          const fileListPath = await this.fileProcessor.createTempPath(
            "file_list",
            "txt"
          );
          const fileListContent = segmentFiles
            .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
            .join("\n");

          await fs.writeFile(fileListPath, fileListContent);

          // Combine all segments with audio enhancement
          await execAsync(
            `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c:a pcm_s16le -af "highpass=f=50,lowpass=f=15000,afftdn=nf=-25" "${outputPath}"`
          );
        }

        await this.fileProcessor.verifyFile(outputPath);
        this.speakerReferenceAudios.set(speaker, outputPath);
        console.log(
          `Created reference audio for speaker ${speaker}: ${outputPath}`
        );
      }

      // If no speakers were processed, create a default reference
      if (this.speakerReferenceAudios.size === 0) {
        const defaultPath = await this.createDefaultReference(originalAudio);
        this.speakerReferenceAudios.set("default", defaultPath);
      }

      return this.speakerReferenceAudios;
    } catch (error) {
      console.error(`Failed to create reference audio:`, error);
      throw new Error(`Failed to create reference audio: ${error}`);
    }
  }

  /**
   * Creates a default reference audio from the original audio
   * @param audioPath Path to the audio file
   * @returns Path to the created reference audio file
   */
  private async createDefaultReference(audioPath: string): Promise<string> {
    try {
      // Get audio duration
      const duration = await this.fileProcessor.getAudioDuration(audioPath);

      // Create a reference audio file with optimal duration (10-30 seconds)
      const targetDuration = Math.min(30, Math.max(10, duration));
      const startTime =
        duration > targetDuration ? (duration - targetDuration) / 2 : 0;

      const outputPath = await this.fileProcessor.createTempPath(
        "default_reference",
        "wav"
      );

      // Extract the middle segment with audio enhancement
      await execAsync(
        `ffmpeg -i "${audioPath}" -ss ${startTime} -t ${targetDuration} -af "highpass=f=50,lowpass=f=15000,afftdn=nf=-25" -c:a pcm_s16le "${outputPath}"`
      );

      await this.fileProcessor.verifyFile(outputPath);
      console.log(`Created default reference audio: ${outputPath}`);
      return outputPath;
    } catch (error) {
      console.error(`Failed to create default reference:`, error);
      throw new Error(`Failed to create default reference: ${error}`);
    }
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
    // Simply call createReferenceAudio with the vocals path
    await this.createReferenceAudio(vocalsPath, transcript);
  }
}
