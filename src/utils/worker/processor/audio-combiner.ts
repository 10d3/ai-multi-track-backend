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

      // Create a temporary directory for the combined audio segments
      const outputDir = await this.fileProcessor.createTempDir(
        "combined_segments"
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
          i
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

      // Adjust speech timing to fit within allocated time slots
      console.log("Adjusting speech timing to fit duration slots...");
      speechSegmentPaths = await this.adjustSpeechTiming(speechSegmentPaths);

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
        const inputIndex = i; // Start from 0 since no silent background
        const startTime = segment.adjustedStart || segment.start;

        // Add each speech input to filter - with volume already boosted and positioned by timestamp
        filterComplex += `[${inputIndex}:a]adelay=${Math.round(
          startTime
        )}|${Math.round(startTime)}[speech${i}];`;
      }

      // Build mix chain for speech segments
      if (speechSegmentPaths.length > 0) {
        for (let i = 0; i < speechSegmentPaths.length; i++) {
          filterComplex += `[speech${i}]`;
        }
        // Mix all speech segments
        filterComplex += `amix=inputs=${speechSegmentPaths.length}:duration=first[speechmix];`;
      }

      // Keep background at original volume (1.0 = 100%)
      filterComplex += `[${speechSegmentPaths.length}:a]volume=1.0[bg];`;

      // Final mix of speech and background - with equal weights
      filterComplex += `[speechmix][bg]amix=inputs=2:duration=first:weights=0.5 0.5[out]`;

      // Create input arguments string for ffmpeg
      let inputArgs = `-threads 2 `;

      // Add all processed speech segments IN THE SORTED ORDER
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

      // Execute ffmpeg with single filter complex
      await execAsync(
        `ffmpeg ${inputArgs} -filter_complex "${filterComplex.replace(
          /\s+/g,
          " "
        )}" -map "[out]" -c:a pcm_s24le "${finalPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(finalPath);

      // Apply final processing
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
    originalAudioUrl: string
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
    backgroundPath: string
  ): Promise<string> {
    try {
      return backgroundPath;
    } catch (error) {
      console.error("Error removing speech from background:", error);
      console.log("Falling back to original background audio");
      return backgroundPath; // Fallback to original if processing fails
    }
  }

  /**
   * Adjust speech segments to fit within their allocated time slots using Python script
   */
  private async adjustSpeechTiming(
    segments: SpeechSegment[]
  ): Promise<SpeechSegment[]> {
    const adjustedSegments: SpeechSegment[] = [];

    for (const segment of segments) {
      try {
        // If your segment.start and segment.end are in milliseconds
        const targetDurationMs = segment.end - segment.start; // milliseconds
        const targetDurationSec = targetDurationMs; // convert to seconds

        console.log("duration in miliseconde:", targetDurationMs);

        console.log("duration is :", targetDurationSec);

        console.log(
          `Processing segment ${
            segment.originalIndex
          } - target duration: ${targetDurationSec.toFixed(3)}s`
        );

        // Create output path for tempo-adjusted audio
        const adjustedPath = await this.fileProcessor.createTempPath(
          `tempo_adjusted_${segment.originalIndex}`,
          "wav"
        );

        // Use Python script to adjust tempo
        const scriptPath = path.resolve("./src/script/adjust_speech_timing.py");

        const { stdout, stderr } = await execAsync(
          `python "${scriptPath}" "${segment.path}" ${targetDurationSec} "${adjustedPath}"`
        );

        // Log Python script output
        if (stdout) {
          console.log(`Segment ${segment.originalIndex} processing:`, stdout);
        }

        if (stderr) {
          console.warn(`Segment ${segment.originalIndex} warnings:`, stderr);
        }

        // Verify the adjusted file exists
        await this.fileProcessor.verifyFile(adjustedPath);

        adjustedSegments.push({
          ...segment,
          path: adjustedPath,
          adjustedStart: segment.start,
          adjustedEnd: segment.end,
        });
      } catch (error) {
        console.error(
          `Error processing segment ${segment.originalIndex}:`,
          error
        );

        // Keep original segment if processing fails
        adjustedSegments.push({
          ...segment,
          adjustedStart: segment.start,
          adjustedEnd: segment.end,
        });
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
      console.log(`Processing speech file ${index} (boosting volume)...`);

      // Create a processed speech file path
      const processedPath = path.join(
        outputDir,
        `processed_speech_${index}.wav`
      );

      await execAsync(
        `ffmpeg -i "${speechPath}" -af "volume=3.0" "${processedPath}"`
      );

      // Verify the output file
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
    try {
      console.log(
        "Applying final processing with speech clarity enhancement..."
      );

      return inputPath;
    } catch (error) {
      console.error("Error applying final processing:", error);
      throw error;
    }
  }
}
