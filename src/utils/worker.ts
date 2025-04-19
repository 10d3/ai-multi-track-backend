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

// Define interfaces for job data

class AudioProcessor {
  private tempFilePaths: Set<string>;
  private tempDirs: Set<string>;

  constructor() {
    this.tempFilePaths = new Set();
    this.tempDirs = new Set();
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
    const fileCleanup = Array.from(this.tempFilePaths).map(async (file) => {
      try {
        const exists = await fs
          .access(file)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          await fs.unlink(file);
          // console.log("Cleaned up file:", file);
        }
      } catch (error) {
        console.warn(`Failed to cleanup file ${file}:`, error);
      }
    });

    const dirCleanup = Array.from(this.tempDirs).map(async (dir) => {
      try {
        const exists = await fs
          .access(dir)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          await fs.rm(dir, { recursive: true, force: true });
          // console.log("Cleaned up directory:", dir);
        }
      } catch (error) {
        console.warn(`Failed to cleanup directory ${dir}:`, error);
      }
    });

    await Promise.all([...fileCleanup, ...dirCleanup]);
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
    let client;

    try {
      // Import TextToSpeechClient dynamically
      const { TextToSpeechClient } = await import(
        "@google-cloud/text-to-speech"
      );
      // Initialize client with proper error handling
      try {
        client = new TextToSpeechClient({
          credentials,
        });
      } catch (initError: any) {
        console.error("Client initialization error:", initError);
        throw new Error(
          `Failed to initialize TTS client: ${initError.message}`
        );
      }

      if (!textToSpeech || !voice_name || !voice_id) {
        throw new Error("Missing required parameters for TTS");
      }

      const request = {
        input: { ssml: textToSpeech },
        voice: {
          languageCode: voice_id,
          name: voice_name,
          ssmlGender:
            voices.find((v) => v.name === voice_name)?.ssmlGender === "MALE"
              ? 1
              : 2,
        },
        audioConfig: {
          audioEncoding: (output_format as "MP3") || "MP3",
        },
      };

      // Synthesize speech with proper error handling
      const [response] = await client.synthesizeSpeech(request);

      if (!response.audioContent) {
        throw new Error("No audio content generated");
      }

      // Save audio content to a temporary file
      const tempAudioPath = await this.createTempPath("tts_audio", "mp3");
      await fs.writeFile(tempAudioPath, response.audioContent);
      await this.verifyFile(tempAudioPath);

      // Convert to WAV for processing compatibility
      const wavPath = await this.convertAudioToWav(tempAudioPath);

      return wavPath;
    } catch (error: any) {
      console.error("TTS Error:", {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
      throw error;
    } finally {
      if (client) {
        try {
          await client.close();
        } catch (closeError) {
          console.error("Error closing client:", closeError);
        }
      }
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

    // Process in batches to avoid overwhelming the TTS service
    const results: string[] = [];

    for (let i = 0; i < ttsRequests.length; i += BATCH_SIZE) {
      const batch = ttsRequests.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map((request) => this.processTTS(request));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

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

    const spleeterOutputDir = await this.createTempPath("spleeter_output", "");
    await fs.mkdir(spleeterOutputDir, { recursive: true });
    this.tempDirs.add(spleeterOutputDir);

    try {
      // console.log("Running Spleeter on:", convertedOriginalPath);
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
      };

      // Check if we have audio URLs or TTS requests
      if (job.data.ttsRequests && job.data.ttsRequests.length > 0) {
        // Process TTS requests
        await job.updateProgress(5); // Starting progress

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
        ttsConvertedPaths = await audioProcessor.processTTSFiles(
          job.data.audioUrls
        );
        totalSteps = job.data.audioUrls.length + 2; // Process files + separate original + combine

        completedSteps++;
        await job.updateProgress(
          Math.round((completedSteps / totalSteps) * 100)
        );
        recordStepTime();
      } else {
        throw new Error("No audio URLs or TTS requests provided");
      }

      const separatedPath = await audioProcessor.separateOriginalAudio(
        job.data.originalAudioUrl
      );
      completedSteps++;
      await job.updateProgress(Math.round((completedSteps / totalSteps) * 100));
      recordStepTime();

      const finalOutputPath =
        await audioProcessor.combineAllSpeechWithBackground(
          ttsConvertedPaths,
          separatedPath,
          job.data.transcript
        );
      completedSteps++;
      await job.updateProgress(Math.round((completedSteps / totalSteps) * 100));
      recordStepTime();

      const finalUrl = await audioProcessor.uploadToStorage(finalOutputPath);
      console.log("Audio processing completed successfully", finalUrl);
      return finalUrl;
    } catch (error) {
      console.error("Error processing audio:", error);
      throw new Error(`Error processing audio: ${error}`);
    } finally {
      await audioProcessor.cleanup();
    }
  },
  {
    connection: {
      host: redisHost,
      port: redisPort,
      ...(redisUserName ? { username: redisUserName } : {}),
      ...(redisPassword ? { password: redisPassword } : {}),
      maxRetriesPerRequest: null,
      connectTimeout: 5000,
    },
    concurrency: 5,
  }
);

worker.on("progress", (job, progress) => {
  console.log(`Job ${job.id} progress: ${progress}%`);
});

worker.on("completed", async (job) => {
  console.log(`Job ${job.id} completed successfully!`);
  await notifyAPI(job);
});

worker.on("failed", (job, err) => {
  console.log(`Job ${job?.id} failed with error: ${err.message}`);
});

export { worker };
