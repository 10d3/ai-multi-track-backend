import { Worker } from "bullmq";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { promisify } from "util";
import { exec } from "child_process";
import {
  credentials,
  redisHost,
  redisPassword,
  redisPort,
  redisUserName,
  storageGoogle,
} from "./queue";
import { v4 as uuidv4 } from "uuid";
import { downloadAudioFile } from "./utils";
import dotenv from "dotenv";
// import axios from "axios";
import type { JobData, Transcript } from "./types/type";
import { notifyAPI } from "../services/notifyAPi";
import { voices } from "./constant/voices";

dotenv.config();

// Promisify exec for async/await usage
const execAsync = promisify(exec);

// Define constants
const BATCH_SIZE = 5;
const TEMP_DIR = path.resolve(process.cwd(), "temp");
const BUCKET_NAME = process.env.BUCKET_NAME as string;
const SIGNED_URL_EXPIRY = "03-09-2491";
const TTS_TIMEOUT_MS = 60000; // 60 seconds timeout for TTS requests

// Define interfaces for job data

class AudioProcessor {
  private tempFilePaths: Set<string>;
  private tempDirs: Set<string>;
  private ttsClient: any = null;
  private ttsClientInitPromise: Promise<any> | null = null;

  constructor() {
    this.tempFilePaths = new Set();
    this.tempDirs = new Set();
  }

  // Method to get or initialize the TTS client
  async getTTSClient(): Promise<any> {
    // If client already exists, return it
    if (this.ttsClient) {
      console.log("Using existing TTS client");
      return this.ttsClient;
    }

    // If initialization is in progress, wait for it
    if (this.ttsClientInitPromise) {
      console.log("Waiting for TTS client initialization to complete");
      return this.ttsClientInitPromise;
    }

    // Initialize the client
    console.log("Initializing new TTS client");
    this.ttsClientInitPromise = (async () => {
      try {
        const { TextToSpeechClient } = await import("@google-cloud/text-to-speech");
        this.ttsClient = new TextToSpeechClient({
          credentials,
        });
        console.log("TTS client initialized successfully");
        return this.ttsClient;
      } catch (initError: any) {
        console.error("Client initialization error:", initError);
        this.ttsClient = null;
        throw new Error(`Failed to initialize TTS client: ${initError.message}`);
      } finally {
        this.ttsClientInitPromise = null;
      }
    })();

    return this.ttsClientInitPromise;
  }

  async getAudioDuration(filePath: string): Promise<number> {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    return parseFloat(stdout);
  }

  async init(): Promise<void> {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    // console.log("Temporary directory created/verified at:", TEMP_DIR);
  }

  async cleanup(): Promise<void> {
    console.log("Starting cleanup...");
    
    // First clean up files
    const fileCleanup = Array.from(this.tempFilePaths).map(async (file) => {
      try {
        const exists = await fs
          .access(file)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          const stats = await fs.stat(file);
          if (stats.isDirectory()) {
            await fs.rm(file, { recursive: true, force: true });
          } else {
            await fs.unlink(file);
          }
        }
      } catch (error) {
        console.warn(`Failed to cleanup path ${file}:`, error);
      }
    });

    // Then clean up directories
    const dirCleanup = Array.from(this.tempDirs).map(async (dir) => {
      try {
        const exists = await fs
          .access(dir)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          await fs.rm(dir, { recursive: true, force: true });
        }
      } catch (error) {
        console.warn(`Failed to cleanup directory ${dir}:`, error);
      }
    });

    await Promise.all([...fileCleanup, ...dirCleanup]);
    
    // Clean up TTS client if it exists
    if (this.ttsClient) {
      try {
        console.log("Closing TTS client");
        await this.ttsClient.close();
        this.ttsClient = null;
      } catch (error) {
        console.error("Error closing TTS client:", error);
      }
    }
    
    // Clear the sets
    this.tempFilePaths.clear();
    this.tempDirs.clear();
    
    console.log("Cleanup completed");
  }

  async createTempPath(prefix: string, extension?: string): Promise<string> {
    const filename = `${prefix}_${uuidv4()}${extension ? `.${extension}` : ""}`;
    const filePath = path.join(TEMP_DIR, filename);
    this.tempFilePaths.add(filePath);
    // console.log("Created temp path:", filePath);
    return filePath;
  }

  async verifyFile(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        throw new Error(`Not a file: ${filePath}`);
      }
      if (stats.size === 0) {
        throw new Error(`Empty file: ${filePath}`);
      }
      return true;
    } catch (error) {
      console.error(`File verification failed for ${filePath}:`, error);
      throw new Error(`File verification failed: ${error}`);
    }
  }

  async convertAudioToWav(inputPath: string): Promise<string> {
    await this.verifyFile(inputPath);
    const outputPath = await this.createTempPath("converted", "wav");

    try {
      await execAsync(`ffmpeg -i "${inputPath}" -y "${outputPath}"`);
      await this.verifyFile(outputPath);
      return outputPath;
    } catch (error) {
      console.error("Audio conversion failed:", error);
      throw new Error(`Audio conversion failed: ${error}`);
    }
  }

  async processTTSFiles(audioUrls: string[]): Promise<string[]> {
    const convertedPaths: string[] = [];

    for (const url of audioUrls) {
      const tempPath = await this.createTempPath("temp", "mp3");
      await downloadAudioFile(url, tempPath);
      await this.verifyFile(tempPath);

      const wavPath = await this.convertAudioToWav(tempPath);
      convertedPaths.push(wavPath);

      await fs.unlink(tempPath);
    }

    return convertedPaths;
  }

  async processTTS({
    textToSpeech,
    voice_id,
    output_format = "MP3",
    voice_name,
  }: {
    textToSpeech: string;
    voice_id: string;
    output_format?: string;
    voice_name: string;
  }): Promise<string> {
    try {
      console.log(`Processing TTS for voice: ${voice_name}, text length: ${textToSpeech.length}`);
      
      if (!textToSpeech || !voice_name || !voice_id) {
        throw new Error("Missing required parameters for TTS");
      }

      // Get the cached client instead of creating a new one each time
      const client = await this.getTTSClient();

      const ssmlGender = voices.find((v) => v.name === voice_name)?.ssmlGender === "MALE" ? 1 : 2;
      
      const request = {
        input: { ssml: textToSpeech },
        voice: {
          languageCode: voice_id,
          name: voice_name,
          ssmlGender,
        },
        audioConfig: {
          audioEncoding: (output_format as "MP3") || "MP3",
        },
      };

      // Add timeout handling for the TTS request
      console.log(`Starting TTS API call with ${TTS_TIMEOUT_MS}ms timeout`);
      const startTime = Date.now();
      
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`TTS request timed out after ${TTS_TIMEOUT_MS/1000} seconds`)), TTS_TIMEOUT_MS);
      });

      // Race the TTS request against the timeout
      const [response] = await Promise.race([
        client.synthesizeSpeech(request),
        timeoutPromise
      ]) as any;
      
      const apiCallTime = Date.now() - startTime;
      console.log(`TTS API call completed in ${apiCallTime}ms`);

      if (!response.audioContent) {
        throw new Error("No audio content generated");
      }

      // Save audio content to a temporary file
      const tempAudioPath = await this.createTempPath("tts_audio", "mp3");
      await fs.writeFile(tempAudioPath, response.audioContent);
      await this.verifyFile(tempAudioPath);

      // Convert to WAV for processing compatibility
      const wavPath = await this.convertAudioToWav(tempAudioPath);
      console.log(`TTS processing completed successfully: ${wavPath}`);

      return wavPath;
    } catch (error: any) {
      console.error("TTS Error:", {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      throw error;
    }
  }

  async processMultipleTTS(
    ttsRequests: Array<{
      textToSpeech: string;
      voice_id: string;
      output_format?: string;
      voice_name: string;
    }>
  ): Promise<string[]> {
    if (!ttsRequests || ttsRequests.length === 0) {
      throw new Error("No TTS requests provided");
    }

    console.log(`Processing ${ttsRequests.length} TTS requests in batches of ${BATCH_SIZE}`);
    
    // Process in batches to avoid overwhelming the TTS service
    const results: string[] = [];

    for (let i = 0; i < ttsRequests.length; i += BATCH_SIZE) {
      const batch = ttsRequests.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(ttsRequests.length/BATCH_SIZE)}`);
      
      const batchPromises = batch.map((request) => this.processTTS(request));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    console.log(`Successfully processed all ${ttsRequests.length} TTS requests`);
    return results;
  }

  async cleanBackgroundTrack(inputPath: string): Promise<string> {
    const outputPath = await this.createTempPath("cleaned_bg", "wav");

    try {
      const ffmpegCmd = `ffmpeg -i "${inputPath}" -af "
        highpass=f=50,
        lowpass=f=15000,
        anlmdn=s=7:p=0.002:r=0.002:m=15:b=5,
        equalizer=f=200:t=q:w=1:g=-2,
        equalizer=f=1000:t=q:w=1:g=-1,
        compand=attacks=0.3:points=-70/-90|-24/-12|0/-6|20/-3:gain=3
      " -y "${outputPath}"`;

      await execAsync(ffmpegCmd.replace(/\s+/g, " "));
      await this.verifyFile(outputPath);
      return outputPath;
    } catch (error) {
      console.error("Background cleaning failed:", error);
      throw new Error(`Background cleaning failed: ${error}`);
    }
  }

  async separateOriginalAudio(originalAudioUrl: string): Promise<string> {
    const originalPath = await this.createTempPath("original", "mp3");
    await downloadAudioFile(originalAudioUrl, originalPath);
    await this.verifyFile(originalPath);

    const convertedOriginalPath = await this.convertAudioToWav(originalPath);

    const spleeterOutputDir = await this.createTempPath("spleeter_output");
    await fs.mkdir(spleeterOutputDir, { recursive: true });
    // Add to tempDirs instead of tempFilePaths
    this.tempDirs.add(spleeterOutputDir);
    this.tempFilePaths.delete(spleeterOutputDir); // Remove from tempFilePaths if it was added

    try {
      const scriptPath = path.resolve("./src/script/separate_audio.py");
      await execAsync(
        `python3 "${scriptPath}" "${convertedOriginalPath}" "${spleeterOutputDir}"`
      );

      const subdirs = await fs.readdir(spleeterOutputDir);
      if (!subdirs.length) {
        throw new Error("No subdirectories found in Spleeter output.");
      }

      const accompanimentPath = path.join(
        spleeterOutputDir,
        subdirs[0],
        "accompaniment.wav"
      );

      await this.verifyFile(accompanimentPath);
      return accompanimentPath;
    } catch (error) {
      console.error("Spleeter processing failed:", error);
      throw new Error(`Spleeter processing failed: ${error}`);
    }
  }

  async analyzeAudio(filePath: string) {
    if (!filePath) {
      throw new Error("File path is required");
    }

    try {
      // Get loudness information with more detailed metrics
      const loudnessInfo = await execAsync(
        `ffmpeg -i "${filePath}" -af "loudnorm=print_format=json:linear=true:dual_mono=true" -f null - 2>&1`
      );

      // Extract JSON from FFmpeg output
      const jsonMatch = loudnessInfo.stdout.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Could not find JSON data in FFmpeg output");
      }

      let loudnessData;
      try {
        loudnessData = JSON.parse(jsonMatch[0]);
      } catch (e: any) {
        throw new Error("Failed to parse loudness data: " + e.message);
      }

      // Get format information
      const formatInfo = await execAsync(
        `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath}"`
      );

      if (formatInfo.stderr) {
        console.error("FFprobe error:", formatInfo.stderr);
        throw new Error("Error getting format information");
      }

      let audioInfo;
      try {
        audioInfo = JSON.parse(formatInfo.stdout);
      } catch (e: any) {
        throw new Error("Failed to parse audio format data: " + e.message);
      }

      const audioStream = audioInfo.streams?.find(
        (s: any) => s.codec_type === "audio"
      );

      if (!audioStream) {
        throw new Error("No audio stream found in file");
      }

      // Ensure all required values are present with fallbacks
      const result = {
        loudness: {
          integrated: parseFloat(loudnessData.input_i || "0"),
          truePeak: parseFloat(loudnessData.input_tp || "0"),
          range: Math.max(
            1,
            Math.min(20, parseFloat(loudnessData.input_lra || "1"))
          ), // Ensure LRA is between 1-20
          threshold: parseFloat(loudnessData.input_thresh || "-70"),
          offset: parseFloat(loudnessData.target_offset || "0"),
        },
        format: {
          sampleRate: parseInt(audioStream.sample_rate) || 44100,
          channels: parseInt(audioStream.channels) || 2,
          codec: audioStream.codec_name || "pcm_s16le",
        },
        duration: parseFloat(audioInfo.format?.duration || "0"),
      };

      // Validate the parsed values
      if (
        isNaN(result.loudness.integrated) ||
        isNaN(result.loudness.truePeak) ||
        isNaN(result.loudness.range) ||
        isNaN(result.format.sampleRate) ||
        isNaN(result.format.channels) ||
        isNaN(result.duration)
      ) {
        throw new Error("Invalid audio analysis values detected");
      }

      return result;
    } catch (error) {
      console.error("Error analyzing audio:", error);
      throw error;
    }
  }

  async combineAllSpeechWithBackground(
    speechFiles: string[],
    backgroundTrack: string,
    transcript: Transcript[]
  ): Promise<string> {
    // Input validation
    if (!Array.isArray(speechFiles) || speechFiles.length === 0) {
      throw new Error("Speech files array is required and must not be empty");
    }
    if (!backgroundTrack) {
      throw new Error("Background track is required");
    }
    if (
      !Array.isArray(transcript) ||
      transcript.length !== speechFiles.length
    ) {
      throw new Error("Transcript array must match speech files length");
    }

    try {
      await this.verifyFile(backgroundTrack);
      await Promise.all(speechFiles.map((file) => this.verifyFile(file)));

      // Analyze background track
      const bgAnalysis = await this.analyzeAudio(backgroundTrack);

      // Analyze first speech file to use as reference
      const speechAnalysis = await this.analyzeAudio(speechFiles[0]);

      const bgDuration = bgAnalysis.duration;

      if (bgDuration <= 0) {
        throw new Error("Invalid background track duration");
      }

      // Process background track with minimal processing to preserve quality
      const processedBgPath = await this.createTempPath("processed_bg", "wav");
      await execAsync(
        `ffmpeg -i "${backgroundTrack}" -af "volume=1.0" -ar 44100 -ac 2 -y "${processedBgPath}"`
      );

      // Process speech files with minimal processing
      const processedSpeechFiles = await Promise.all(
        speechFiles.map(async (file, index) => {
          const outputPath = await this.createTempPath(
            `processed_speech_${index}`,
            "wav"
          );
          // Simple volume adjustment for speech
          await execAsync(
            `ffmpeg -i "${file}" -af "volume=1.5" -ar 44100 -ac 2 -y "${outputPath}"`
          );
          return outputPath;
        })
      );

      let filterComplex = ``;
      let inputs = `-i "${processedBgPath}" `;
      let overlays = ``;

      const firstStart = transcript[0].start;
      const lastEnd = transcript[transcript.length - 1].end as number;
      const speechDuration = lastEnd - firstStart;
      const scaleFactor = (bgDuration * 0.98) / speechDuration;

      // Add input files and create precise delays
      for (let i = 0; i < transcript.length; i++) {
        inputs += `-i "${processedSpeechFiles[i]}" `;

        const relativeStart = transcript[i].start - firstStart;
        const scaledDelay = Math.round(relativeStart * scaleFactor * 1000);

        filterComplex += `[${i + 1}:a]atrim=0,asetpts=PTS-STARTPTS[adj${i}];`;
        filterComplex += `[adj${i}]adelay=${scaledDelay}|${scaledDelay}[s${i}];`;
      }

      filterComplex += `[0:a]apad[bg];`;
      overlays += `[bg]`;

      for (let i = 0; i < transcript.length; i++) {
        overlays += `[s${i}]`;
      }

      // Mix with slightly adjusted weights to balance speech and background
      const bgWeight = 1.0;
      const speechWeight = 1.2;
      const weights = [
        bgWeight,
        ...Array(transcript.length).fill(speechWeight),
      ].join(" ");

      // Simple mixing without additional processing
      filterComplex += `${overlays}amix=inputs=${
        transcript.length + 1
      }:weights=${weights}[mixed];`;

      // Gentle compression to even out volume without changing character
      filterComplex += `[mixed]acompressor=threshold=-12dB:ratio=2:attack=200:release=1000[out]`;

      const finalOutputPath = await this.createTempPath("final_output", "wav");
      const ffmpegCmd = `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[out]" -c:a pcm_s16le -t ${bgDuration} -y "${finalOutputPath}"`;

      await execAsync(ffmpegCmd);

      return finalOutputPath;
    } catch (error) {
      console.error("Error combining audio:", error);
      throw error;
    }
  }

  async uploadToStorage(filePath: string): Promise<string> {
    try {
      await this.verifyFile(filePath);

      const bucket = storageGoogle.bucket(BUCKET_NAME);
      const filename = path.basename(filePath);
      const file = bucket.file(filename);

      const readStream = createReadStream(filePath);
      const writeStream = file.createWriteStream({
        resumable: false,
        validation: "md5",
      });

      readStream.on("error", (error) => {
        console.error("Read stream error:", error);
        throw new Error(`Read stream error: ${error.message}`);
      });

      writeStream.on("error", (error) => {
        console.error("Write stream error:", error);
        throw new Error(`Write stream error: ${error.message}`);
      });

      writeStream.on("finish", () => {
        console.log("Upload completed successfully");
      });

      readStream.pipe(writeStream);

      const [url] = await file.getSignedUrl({
        action: "read",
        expires: SIGNED_URL_EXPIRY,
      });
      // console.log("File uploaded successfully:", url);
      return url;
    } catch (error) {
      console.error("Upload failed:", error);
      throw new Error(`Upload failed: ${error}`);
    }
  }
}

const worker = new Worker<JobData>(
  "audio-processing",
  async (job) => {
    const audioProcessor = new AudioProcessor();
    await audioProcessor.init();

    try {
      let ttsConvertedPaths: string[] = [];
      let totalSteps = 3; // Default: separate original + combine + upload
      let completedSteps = 0;
      const startTime = Date.now();
      let stepTimes: number[] = [];

      const recordStepTime = () => {
        const currentTime = Date.now();
        const elapsedTime = currentTime - startTime;
        stepTimes.push(elapsedTime);

        const averageTimePerStep =
          stepTimes.reduce((a, b) => a + b, 0) / stepTimes.length;
        const remainingSteps = totalSteps - completedSteps;
        const estimatedRemainingTime = averageTimePerStep * remainingSteps;

        console.log(
          `Estimated remaining time: ${Math.round(
            estimatedRemainingTime / 1000
          )} seconds`
        );
        
        // Add detailed step information to job data
        job.updateData({
          ...job.data,
          processingDetails: {
            currentStep: completedSteps,
            totalSteps,
            elapsedTime,
            estimatedRemainingTime,
            stepTimes,
            lastStepName: getCurrentStepName(completedSteps)
          }
        });
      };
      
      // Helper function to get descriptive step names
      const getCurrentStepName = (step: number) => {
        if (job.data.ttsRequests && job.data.ttsRequests.length > 0) {
          if (step === 0) return "Generating speech from text";
          if (step === 1) return "Separating background music";
          if (step === 2) return "Combining speech with background";
          if (step === 3) return "Finalizing and uploading";
        } else {
          if (step === 0) return "Processing audio files";
          if (step === 1) return "Separating background music";
          if (step === 2) return "Combining speech with background";
          if (step === 3) return "Finalizing and uploading";
        }
        return "Processing";
      };

      // Check if we have audio URLs or TTS requests
      if (job.data.ttsRequests && job.data.ttsRequests.length > 0) {
        // Process TTS requests
        await job.updateProgress(5); // Starting progress
        
        // Update with more detailed information
        await job.updateData({
          ...job.data,
          currentOperation: "Generating speech from text",
          startTime,
        });

        ttsConvertedPaths = await audioProcessor.processMultipleTTS(
          job.data.ttsRequests
        );
        totalSteps = job.data.ttsRequests.length + 2; // TTS generation + separate original + combine

        completedSteps++;
        await job.updateProgress(
          Math.round((completedSteps / totalSteps) * 100)
        );
        recordStepTime();
      } else if (job.data.audioUrls && job.data.audioUrls.length > 0) {
        // Process existing audio URLs
        await job.updateData({
          ...job.data,
          currentOperation: "Processing audio files",
          startTime,
        });
        await job.updateProgress(5);

        ttsConvertedPaths = await audioProcessor.processTTSFiles(
          job.data.audioUrls
        );
        totalSteps = 3; // Process audio + separate original + combine

        completedSteps++;
        await job.updateProgress(
          Math.round((completedSteps / totalSteps) * 100)
        );
        recordStepTime();
      } else {
        throw new Error("No audio URLs or TTS requests provided");
      }

      // Separate original audio to get background track
      await job.updateData({
        ...job.data,
        currentOperation: "Separating background music",
      });
      const backgroundTrack = await audioProcessor.separateOriginalAudio(
        job.data.originalAudioUrl
      );

      completedSteps++;
      await job.updateProgress(Math.round((completedSteps / totalSteps) * 100));
      recordStepTime();

      // Combine speech with background
      await job.updateData({
        ...job.data,
        currentOperation: "Combining speech with background",
      });
      const combinedAudioPath = await audioProcessor.combineAllSpeechWithBackground(
        ttsConvertedPaths,
        backgroundTrack,
        job.data.transcript
      );

      completedSteps++;
      await job.updateProgress(Math.round((completedSteps / totalSteps) * 100));
      recordStepTime();

      // Upload to storage
      await job.updateData({
        ...job.data,
        currentOperation: "Finalizing and uploading",
      });
      const finalAudioUrl = await audioProcessor.uploadToStorage(
        combinedAudioPath
      );

      completedSteps++;
      await job.updateProgress(100);
      recordStepTime();

      // Return the final audio URL
      return {
        finalAudioUrl,
        processingTime: Date.now() - startTime,
      };
    } catch (error: any) {
      console.error("Job processing error:", error);
      throw error;
    } finally {
      await audioProcessor.cleanup();
    }
  },
  {
    connection: {
      host: redisHost,
      port: redisPort,
      username: redisUserName,
      password: redisPassword,
    },
    concurrency: 2, // Process up to 2 jobs concurrently
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
      count: 1000, // Keep the last 1000 completed jobs
    },
    removeOnFail: {
      age: 24 * 3600, // Keep failed jobs for 24 hours
      count: 100, // Keep the last 100 failed jobs
    },
  }
);

worker.on("completed", async (job, result) => {
  console.log(`Job ${job.id} completed with result:`, result);
  try {
    await notifyAPI(job);
  } catch (error) {
    console.error(`Error notifying API for job ${job.id}:`, error);
  }
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed with error:`, error);
});

worker.on("error", (error) => {
  console.error("Worker error:", error);
});

console.log("Worker started");

export default worker;