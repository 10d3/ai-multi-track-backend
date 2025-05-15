import { promisify } from "util";
import type { Transcript, TTSRequest, ZyphraTTSRequest } from "../types/type";
import { AudioAnalyzer } from "./processor/audio-analyzer";
import { AudioCombiner } from "./processor/audio-combiner";
import { FileProcessor } from "./processor/file-processor";
import { StorageProcessor } from "./processor/storage-processor";
import { ZyphraTTS } from "./processor/zyphra-tts-processor";
import { SpeakerReferenceProcessor } from "./processor/speaker-reference-processor";
import path from "path";
import { exec } from "child_process";
import fs from "fs/promises";

const execAsync = promisify(exec);

export class AudioProcessor {
  private fileProcessor: FileProcessor;
  private zyphraTTS: ZyphraTTS;
  private audioAnalyzer: AudioAnalyzer;
  private audioCombiner: AudioCombiner;
  private storageProcessor: StorageProcessor;
  private speakerReferenceProcessor: SpeakerReferenceProcessor;

  constructor() {
    this.fileProcessor = new FileProcessor();
    this.zyphraTTS = new ZyphraTTS(this.fileProcessor);
    this.audioAnalyzer = new AudioAnalyzer(this.fileProcessor);
    this.audioCombiner = new AudioCombiner(
      this.fileProcessor,
      this.audioAnalyzer
    );
    this.storageProcessor = new StorageProcessor(this.fileProcessor);
    this.speakerReferenceProcessor = new SpeakerReferenceProcessor(
      this.fileProcessor
    );
  }

  async init(): Promise<void> {
    await this.fileProcessor.init();
  }

  async cleanup(): Promise<void> {
    await this.fileProcessor.cleanup();
  }

  async processTTSFiles(audioUrls: string[]): Promise<Array<{path: string, start: number, end: number}>> {
    const convertedPaths: Array<{path: string, start: number, end: number}> = [];
    for (const url of audioUrls) {
      const wavPath = await this.fileProcessor.downloadAndConvertAudio(url);
      // Since we don't have timing information, use default values
      convertedPaths.push({
        path: wavPath,
        start: 0, // Default start time
        end: 0 // Will be calculated based on audio duration if needed
      });
    }
    return convertedPaths;
  }

  async processMultipleTTS(
    transcript: Transcript[],
    ttsRequests: TTSRequest[],
    originalAudioUrl?: string,
    language?: string // Add parameter for original audio URL
  ): Promise<Array<{path: string, start: number, end: number}>> {
    // Group requests by speaker to ensure we use the correct reference audio for each speaker
    const mergedData = transcript.map((transcriptItem, index) => {
      const ttsRequest = ttsRequests[index];
      return { ...transcriptItem, ...ttsRequest, language: language };
    });

    const requestsBySpeaker: { [speaker: string]: ZyphraTTSRequest[] } = {};

    // First, organize requests by speaker
    for (const request of mergedData) {
      const speaker = request.speaker || "default";
      if (!requestsBySpeaker[speaker]) {
        requestsBySpeaker[speaker] = [];
      }
      requestsBySpeaker[speaker].push(request as ZyphraTTSRequest);
    }

    // Process each speaker's requests
    const allResults: Array<{path: string, start: number, end: number}> = [];
    for (const speaker in requestsBySpeaker) {
      const speakerRequests = requestsBySpeaker[speaker];
      console.log(
        `[AudioProcessor] Processing ${speakerRequests.length} requests for speaker ${speaker}`
      );

      // Get reference audio for this speaker
      let referenceAudio =
        await this.speakerReferenceProcessor.getReferenceAudio(speaker);

      // Check if any request requires voice cloning but we don't have reference audio
      const needsCloning = speakerRequests.some(
        (req) => req.voice_id === "cloning-voice"
      );

      if (needsCloning && !referenceAudio) {
        console.log(
          `[AudioProcessor] Voice cloning requested for speaker ${speaker} but no reference audio found. Creating one on demand.`
        );

        try {
          // Filter transcript to only include segments for this speaker
          const speakerTranscript = transcript.filter(
            (item) => item.speaker === speaker
          );

          let audioPath;

          // Download and use the original audio if URL is provided
          if (originalAudioUrl) {
            console.log(
              `[AudioProcessor] Downloading original audio for reference: ${originalAudioUrl}`
            );
            audioPath = await this.fileProcessor.downloadAndConvertAudio(
              originalAudioUrl
            );
            console.log(
              `[AudioProcessor] Downloaded original audio to: ${audioPath}`
            );
          } else {
            // Fallback to the old method if no original audio URL is provided
            console.log(
              `[AudioProcessor] No original audio URL provided, searching for available audio files...`
            );

            // Find a suitable audio file to use as source
            const tempDir = await this.fileProcessor.createTempDir(
              "temp_source"
            );
            const files = await fs.readdir(tempDir);
            const audioFiles = files.filter(
              (f) => f.endsWith(".wav") && !f.includes("reference")
            );

            if (audioFiles.length > 0) {
              // Use the first available audio file as source
              audioPath = path.join(tempDir, audioFiles[0]);
              console.log(
                `[AudioProcessor] Found audio file to use: ${audioPath}`
              );
            }
          }

          if (audioPath) {
            // Create reference audio on demand
            referenceAudio = (
              await this.speakerReferenceProcessor.createReferenceAudio(
                audioPath,
                speakerTranscript
              )
            ).get(speaker);

            console.log(
              `[AudioProcessor] Created reference audio for speaker ${speaker}: ${referenceAudio}`
            );
          } else {
            console.warn(
              `[AudioProcessor] No suitable audio files found to create reference for speaker ${speaker}`
            );

            // FALLBACK: Create a default reference audio if we can't find a suitable source
            // This is critical to prevent the "Reference audio is required" error
            const spleeterOutputDir = await this.fileProcessor.createTempDir(
              "spleeter_output"
            );
            const subdirs = await fs.readdir(spleeterOutputDir);

            if (subdirs.length > 0) {
              const vocalsPath = path.join(
                spleeterOutputDir,
                subdirs[0],
                "vocals.wav"
              );
              if (await this.fileProcessor.fileExists(vocalsPath)) {
                // Filter transcript to only include segments for this speaker
                const speakerTranscript = transcript.filter(
                  (item) => item.speaker === speaker
                );

                referenceAudio = (
                  await this.speakerReferenceProcessor.createReferenceAudio(
                    vocalsPath,
                    speakerTranscript
                  )
                ).get(speaker);

                console.log(
                  `[AudioProcessor] Created fallback reference audio from vocals: ${referenceAudio}`
                );
              }
            }
          }

          // If we still don't have reference audio, we need to skip voice cloning
          if (!referenceAudio && needsCloning) {
            console.warn(
              `[AudioProcessor] Could not create reference audio for speaker ${speaker}. Switching to default voice.`
            );
            // Change voice_id to a default voice instead of cloning
            for (const request of speakerRequests) {
              if (request.voice_id === "cloning-voice") {
                request.voice_id = "en-US-Neural2-F"; // Use a default voice as fallback
                console.log(
                  `[AudioProcessor] Switched to default voice for speaker ${speaker}`
                );
              }
            }
          }
        } catch (error) {
          console.error(
            `[AudioProcessor] Failed to create reference audio for speaker ${speaker}:`,
            error
          );
          // Change voice_id to a default voice instead of cloning
          for (const request of speakerRequests) {
            if (request.voice_id === "cloning-voice") {
              request.voice_id = "american-male"; // Use a default voice as fallback
              console.log(
                `[AudioProcessor] Switched to default voice for speaker ${speaker} due to error`
              );
            }
          }
        }
      }

      // Add reference audio path to each request
      for (const request of speakerRequests) {
        if (request.voice_id === "cloning-voice") {
          if (!referenceAudio) {
            // Final safety check - if we still don't have reference audio, switch to default voice
            request.voice_id = "en-US-Neural2-F";
            console.warn(
              `[AudioProcessor] No reference audio available for cloning. Using default voice.`
            );
          } else {
            request.referenceAudioPath = referenceAudio;
          }
        } else {
          // For non-cloning voices, reference audio is optional
          request.referenceAudioPath = referenceAudio;
        }
      }

      console.log(
        `[AudioProcessor] Prepared requests for speaker ${speaker}:`,
        {
          hasReferenceAudio: !!referenceAudio,
          isCloning: speakerRequests.some(
            (req) => req.voice_id === "cloning-voice"
          ),
          requestCount: speakerRequests.length,
        }
      );

      try {
        const results = await this.zyphraTTS.processZypMultipleTTS(
          speakerRequests,
          language as string
        );
        allResults.push(...results);
      } catch (error) {
        console.error(
          `[AudioProcessor] Error processing requests for speaker ${speaker}:`,
          error
        );
        throw error;
      }
    }

    return allResults;
  }

  async separateOriginalAudio(
    originalAudioUrl: string,
    transcript: Transcript[]
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
      await this.speakerReferenceProcessor.extractSpeakerReferences(
        vocalsPath,
        transcript
      );

      return accompanimentPath;
    } catch (error) {
      console.error("Spleeter processing failed:", error);
      throw new Error(`Spleeter processing failed: ${error}`);
    }
  }

  async combineAllSpeechWithBackground(
    speechFiles: Array<{path: string, start: number, end: number}>,
    backgroundTrack: string,
    transcript?: Transcript[]
  ): Promise<string> {
    // We no longer need to pass transcript since speechFiles already contain timing information
    return this.audioCombiner.combineAudioFiles(
      backgroundTrack,
      speechFiles
    );
  }

  async uploadToStorage(filePath: string): Promise<string> {
    return this.storageProcessor.uploadToStorage(filePath);
  }
}
