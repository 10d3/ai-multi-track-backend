import { promisify } from "util";
import type { Transcript, TTSRequest, ZyphraTTSRequest } from "../types/type";
import { AudioAnalyzer } from "./processor/audio-analyzer";
import { AudioCombiner } from "./processor/audio-combiner";
import { FileProcessor } from "./processor/file-processor";
import { StorageProcessor } from "./processor/storage-processor";
import { ZyphraTTS } from "./processor/zyphra-tts-processor";
import { SpeakerReferenceProcessor } from "./processor/speaker-reference-processor";
import axios from "axios";
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
  private cleanVoiceApiKey: string;
  private cleanVoiceApiUrl: string = "https://api.cleanvoice.ai/v2/edits";

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
    this.cleanVoiceApiKey = process.env.CLEAN_VOICE_API_KEY || "";
    
    if (!this.cleanVoiceApiKey) {
      console.warn("CleanVoice API key not found. Audio enhancement will be skipped.");
    }
  }

  async init(): Promise<void> {
    await this.fileProcessor.init();
  }

  async cleanup(): Promise<void> {
    await this.fileProcessor.cleanup();
  }

  async processTTSFiles(audioUrls: string[]): Promise<string[]> {
    const convertedPaths: string[] = [];
    for (const url of audioUrls) {
      const wavPath = await this.fileProcessor.downloadAndConvertAudio(url);
      convertedPaths.push(wavPath);
    }
    return convertedPaths;
  }

  async processMultipleTTS(
    transcript: Transcript[],
    ttsRequests: TTSRequest[],
    originalAudioUrl?: string,
    language?: string // Add parameter for original audio URL
  ): Promise<string[]> {
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

    // Store results by speaker to maintain original order
    const speakerResults: { [speaker: string]: string[] } = {};
    const speakerResultsIndex: { [speaker: string]: number } = {};
    
    // Process each speaker's requests
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
            request.voice_id = "american-male";
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
        // Store results by speaker instead of appending directly to allResults
        speakerResults[speaker] = results;
        speakerResultsIndex[speaker] = 0; // Initialize index counter for each speaker
      } catch (error) {
        console.error(
          `[AudioProcessor] Error processing requests for speaker ${speaker}:`,
          error
        );
        throw error;
      }
    }

    // Reconstruct the final results array in the original transcript order
    const allResults: string[] = [];
    for (const item of mergedData) {
      const speaker = item.speaker || "default";
      if (speakerResults[speaker] && speakerResultsIndex[speaker] < speakerResults[speaker].length) {
        // Get the next result for this speaker
        const result = speakerResults[speaker][speakerResultsIndex[speaker]];
        allResults.push(result);
        speakerResultsIndex[speaker]++;
      } else {
        console.warn(`[AudioProcessor] Missing result for speaker ${speaker} at index ${speakerResultsIndex[speaker] || 0}`);
      }
    }

    console.log(`[AudioProcessor] Reconstructed ${allResults.length} results in original transcript order`);
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
    speechFiles: string[],
    backgroundTrack: string,
    transcript: Transcript[]
  ): Promise<string> {
    return this.audioCombiner.combineAudioFiles(
      backgroundTrack,
      speechFiles,
      transcript
    );
  }

  /**
   * Enhance audio quality using CleanVoice API before uploading
   */
  async enhanceAudioWithCleanVoice(audioPath: string): Promise<string> {
    if (!this.cleanVoiceApiKey) {
      console.log("CleanVoice API key not provided. Skipping audio enhancement.");
      return audioPath;
    }

    try {
      console.log("Starting CleanVoice audio enhancement process...");
      
      // First, upload the file to get a publicly accessible URL
      // Create a temporary upload for processing
      const fileUrl = await this.storageProcessor.uploadToStorage(audioPath);
      console.log(`Uploaded audio to temporary URL: ${fileUrl}`);
      
      // Request data for CleanVoice API
      const data = {
        "input": {
          "files": [fileUrl],
          "config": {
            "studio_sound": true,
            "autoeq": true,
            "normalize": true,
            "remove_noise": true,
            "breath": "natural",
            "keep_music": true
          }
        }
      };

      const headers = {
        "Content-Type": "application/json",
        "X-API-Key": this.cleanVoiceApiKey
      };

      // Submit the job to CleanVoice
      console.log("Submitting job to CleanVoice API...");
      const response = await axios.post(this.cleanVoiceApiUrl, data, { headers });
      
      if (!response.data || !response.data.id) {
        throw new Error("Invalid response from CleanVoice API");
      }
      
      const jobId = response.data.id;
      console.log(`CleanVoice job created with ID: ${jobId}`);
      
      // Poll for job completion
      let attempts = 0;
      const maxAttempts = 500; // Maximum number of polling attempts
      const pollingInterval = 5000; // 5 seconds between polls
      const statusUrl = `${this.cleanVoiceApiUrl}/${jobId}`;
      
      let processedFileUrl = null;
      
      while (attempts < maxAttempts) {
        try {
          console.log(`Checking job status (attempt ${attempts + 1}/${maxAttempts})...`);
          const statusResponse = await axios.get(statusUrl, { headers });
          
          // Log the full response structure for debugging
          console.log("CleanVoice API response structure:", JSON.stringify(statusResponse.data, null, 2));
          
          // Check for both possible success status values: "completed" and "SUCCESS"
          if (statusResponse.data.status === "completed" || statusResponse.data.status === "SUCCESS") {
            console.log(`CleanVoice processing completed successfully with status: ${statusResponse.data.status}`);
            
            // Based on the actual API response format, check for result.download_url
            if (statusResponse.data.result && statusResponse.data.result.download_url) {
              processedFileUrl = statusResponse.data.result.download_url;
              console.log(`Found file URL in result.download_url: ${processedFileUrl}`);
              break;
            }
            // Fallback to other possible locations for the URL
            else if (statusResponse.data.output && statusResponse.data.output.files && statusResponse.data.output.files.length > 0) {
              processedFileUrl = statusResponse.data.output.files[0];
              console.log(`Found file URL in output.files[0]: ${processedFileUrl}`);
              break;
            } 
            else if (statusResponse.data.files && statusResponse.data.files.length > 0) {
              processedFileUrl = statusResponse.data.files[0];
              console.log(`Found file URL in files[0]: ${processedFileUrl}`);
              break;
            }
            else if (statusResponse.data.url) {
              processedFileUrl = statusResponse.data.url;
              console.log(`Found file URL in url field: ${processedFileUrl}`);
              break;
            }
            else if (statusResponse.data.file) {
              processedFileUrl = statusResponse.data.file;
              console.log(`Found file URL in file field: ${processedFileUrl}`);
              break;
            }
            
            // If we still don't have a URL but the status is success, try once more on the next iteration
            // This handles cases where the file might not be immediately available
            if (attempts < maxAttempts - 1) {
              console.log("Job completed but output URL not found. Waiting for output to be available...");
              await new Promise(resolve => setTimeout(resolve, pollingInterval));
              attempts++;
              continue;
            }
            
            throw new Error("No processed files found in completed job despite success status");
          } else if (statusResponse.data.status === "failed" || statusResponse.data.status === "FAILED") {
            throw new Error(`CleanVoice processing failed: ${statusResponse.data.error || "Unknown error"}`);
          }
          
          // Job still processing, wait and try again
          console.log(`Job status: ${statusResponse.data.status}. Waiting ${pollingInterval/1000} seconds...`);
          
          // Sleep for the polling interval
          await new Promise(resolve => setTimeout(resolve, pollingInterval));
          attempts++;
          
        } catch (error) {
          console.error("Error checking job status:", error);
          attempts++;
          await new Promise(resolve => setTimeout(resolve, pollingInterval));
        }
      }
      
      // After maximum attempts, if we still don't have a URL but no error was thrown,
      // log a clear message and fall back to the original file
      if (!processedFileUrl) {
        console.error("Failed to get processed file URL after maximum polling attempts");
        console.log("Falling back to original audio file due to CleanVoice API issue");
        return audioPath;
      }
      
      // Validate the processed file URL
      if (!processedFileUrl.startsWith('http')) {
        console.error(`Invalid processed file URL received: ${processedFileUrl}`);
        return audioPath;
      }
      
      // Download the processed file
      console.log(`Downloading enhanced audio from ${processedFileUrl}`);
      try {
        const downloadedPath = await this.fileProcessor.downloadAndConvertAudio(
          processedFileUrl
        );
        
        // Verify the downloaded file exists and has content
        await this.fileProcessor.verifyFile(downloadedPath);
        
        console.log(`Successfully enhanced audio with CleanVoice: ${downloadedPath}`);
        return downloadedPath;
      } catch (downloadError) {
        console.error("Error downloading processed file:", downloadError);
        console.log("Falling back to original audio file due to download error");
        return audioPath;
      }
      
    } catch (error) {
      console.error("Error processing audio with CleanVoice:", error);
      console.log("Falling back to original audio file");
      return audioPath; // Return original file if processing fails
    }
  }

  /**
   * Upload audio to storage, with optional CleanVoice enhancement
   */
  async uploadToStorage(filePath: string, applyCleanVoice: boolean = true): Promise<string> {
    if (applyCleanVoice) {
      // Process the audio through CleanVoice before uploading to final storage
      console.log("Enhancing audio quality with CleanVoice before upload...");
      const enhancedFilePath = await this.enhanceAudioWithCleanVoice(filePath);
      
      // Upload the enhanced file to storage
      console.log("Uploading enhanced audio to storage...");
      return this.storageProcessor.uploadToStorage(enhancedFilePath);
    } else {
      // Upload the original file without enhancement
      return this.storageProcessor.uploadToStorage(filePath);
    }
  }
}
