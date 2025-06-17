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
   * Get reference audio for a speaker
   */
  public getReferenceAudio(speaker: string): string | undefined {
    return this.speakerReferenceAudios.get(speaker);
  }

  /**
   * Creates clean reference audio for each speaker from transcript
   */
  public async createReferenceAudio(
    originalAudio: string,
    transcript: Transcript[]
  ): Promise<Map<string, string>> {
    await this.fileProcessor.verifyFile(originalAudio);

    // Group segments by speaker
    const speakerSegments: { [speaker: string]: Transcript[] } = {};
    for (const segment of transcript) {
      if (!segment.speaker || !segment.start || !segment.end) continue;
      if (!speakerSegments[segment.speaker]) {
        speakerSegments[segment.speaker] = [];
      }
      speakerSegments[segment.speaker].push(segment);
    }

    // Create reference audio for each speaker
    for (const [speaker, segments] of Object.entries(speakerSegments)) {
      const referenceAudio = await this.createSpeakerReference(
        originalAudio,
        segments,
        speaker
      );
      this.speakerReferenceAudios.set(speaker, referenceAudio);
    }

    return this.speakerReferenceAudios;
  }

  /**
   * Creates a single clean reference audio file for a speaker
   */
  private async createSpeakerReference(
    originalAudio: string,
    segments: Transcript[],
    speaker: string
  ): Promise<string> {
    // Find the longest segment (usually contains the cleanest speech)
    const longestSegment = segments.reduce((longest, current) => {
      const currentDuration = current.end - current.start;
      const longestDuration = longest.end - longest.start;
      return currentDuration > longestDuration ? current : longest;
    });

    const outputPath = await this.fileProcessor.createTempPath(
      `reference_${speaker}`,
      "wav"
    );

    const startTime = longestSegment.start / 1000; // Convert to seconds
    const duration = (longestSegment.end - longestSegment.start) / 1000;

    // Extract and clean the audio segment for voice cloning
    // Only enhance speech and remove noise - preserve all frequencies
    let referenceFilters = "";
    
    // Speech enhancement for better clarity
    referenceFilters += "speechnorm=e=12.5:r=0.0005,";
    
    // AI noise reduction to remove background noise
    referenceFilters += "afftdn=nf=-25:nr=33,";
    
    // Gentle loudness normalization only
    referenceFilters += "loudnorm=I=-16:TP=-2:LRA=15";

    await execAsync(
      `ffmpeg -y -i "${originalAudio}" -ss ${startTime} -t ${duration} \
       -af "${referenceFilters}" \
       -c:a pcm_s16le -ac 1 -ar 44100 "${outputPath}"`
    );

    await this.fileProcessor.verifyFile(outputPath);
    return outputPath;
  }
}
