import { Worker, Job } from "bullmq";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { promisify } from "util";
import { exec } from "child_process";
import { storageGoogle } from "./queue";
import { v4 as uuidv4 } from "uuid";
import { downloadAudioFile } from "./utils";
import dotenv from 'dotenv';

dotenv.config();
// Promisify exec for async/await usage
const execAsync = promisify(exec);

// Define constants
const BATCH_SIZE = 5;
const TEMP_DIR = path.resolve(process.cwd(), "temp"); // Using absolute path resolution
const BUCKET_NAME = "ai-multi-track";
const SIGNED_URL_EXPIRY = "03-09-2491";

// Define interfaces for job data
interface Transcript {
  start: number; // Assuming start is a number representing milliseconds
  end?: number; // Optional end time
}

interface JobData {
  audioUrls: string[];
  transcript: Transcript[];
  originalAudioUrl: string;
}

class AudioProcessor {
  private tempFilePaths: Set<string>;
  private tempDirs: Set<string>;

  constructor() {
    this.tempFilePaths = new Set();
    this.tempDirs = new Set();
  }

  async init(): Promise<void> {
    // Ensure temp directory exists at startup
    await fs.mkdir(TEMP_DIR, { recursive: true });
    console.log("Temporary directory created/verified at:", TEMP_DIR);
  }

  async cleanup(): Promise<void> {
    console.log("Starting cleanup...");
    // Cleanup all temporary files and directories
    const fileCleanup = Array.from(this.tempFilePaths).map(async (file) => {
      try {
        const exists = await fs
          .access(file)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          await fs.unlink(file);
          console.log("Cleaned up file:", file);
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
          console.log("Cleaned up directory:", dir);
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
    console.log("Created temp path:", filePath);
    return filePath;
  }

  async verifyFile(filePath: string): Promise<boolean> {
    try {
      console.log("Verifying file:", filePath);
      await fs.access(filePath);
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        throw new Error(`Not a file: ${filePath}`);
      }
      if (stats.size === 0) {
        throw new Error(`Empty file: ${filePath}`);
      }
      console.log("File verified successfully:", filePath, "Size:", stats.size);
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
      console.log("Converting audio:", inputPath, "to:", outputPath);
      await execAsync(`ffmpeg -i "${inputPath}" -y "${outputPath}"`);
      await this.verifyFile(outputPath);
      return outputPath;
    } catch (error) {
      console.error("Audio conversion failed:", error);
      throw new Error(`Audio conversion failed: ${error}`);
    }
  }

  async processTTSFiles(audioUrls: string[]): Promise<string[]> {
    console.log("Processing TTS files...", audioUrls);
    const convertedPaths: string[] = [];

    for (const [index, url] of audioUrls.entries()) {
      console.log(`Processing TTS file ${index + 1}/${audioUrls.length}`);
      const tempPath = await this.createTempPath("temp", "mp3");
      await downloadAudioFile(url, tempPath);
      await this.verifyFile(tempPath);

      const wavPath = await this.convertAudioToWav(tempPath);
      convertedPaths.push(wavPath);

      // Remove the temporary MP3
      await fs.unlink(tempPath);
    }

    return convertedPaths;
  }

  async separateOriginalAudio(originalAudioUrl: string): Promise<string> {
    console.log("Separating original audio:", originalAudioUrl);
    const originalPath = await this.createTempPath("original", "mp3");
    await downloadAudioFile(originalAudioUrl, originalPath);
    await this.verifyFile(originalPath);

    const convertedOriginalPath = await this.convertAudioToWav(originalPath);

    const spleeterOutputDir = await this.createTempPath("spleeter_output", "");
    await fs.mkdir(spleeterOutputDir, { recursive: true });
    this.tempDirs.add(spleeterOutputDir);

    try {
      console.log("Running Spleeter on:", convertedOriginalPath);
      const scriptPath = path.resolve("./src/script/separate_audio.py");
      await execAsync(
        `python "${scriptPath}" "${convertedOriginalPath}" "${spleeterOutputDir}"`
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

  async combineBatchWithBackground(
    batchFiles: string[],
    currentBgTrack: string,
    transcriptSlice: Transcript[],
    startIndex: number
  ): Promise<string> {
    console.log("Combining batch with background:", {
      batchFiles,
      currentBgTrack,
      startIndex,
    });

    await this.verifyFile(currentBgTrack);
    await Promise.all(batchFiles.map((file) => this.verifyFile(file)));

    const filterComplexParts: string[] = [];
    const inputFiles = [`-i "${currentBgTrack}"`];

    inputFiles.push(...batchFiles.map((file) => `-i "${file}"`));

    batchFiles.forEach((file, index) => {
      const startTime = transcriptSlice[index]?.start / 1000 || 0;

      // Apply delay to each speech track
      filterComplexParts.push(
        `[${index + 1}:a]adelay=${Math.round(startTime * 1000)}|${Math.round(
          startTime * 1000
        )}[delayed${index}];`
      );

      // Compress the audio track to manage dynamic range
      filterComplexParts.push(
        `[delayed${index}]acompressor=threshold=-20dB:ratio=4:attack=5:release=50[compressed${index}];`
      );

      const previousBg = index === 0 ? "0:a" : `bg${index - 1}`;

      // Mix the compressed speech with the background track
      filterComplexParts.push(
        `[${previousBg}][compressed${index}]amix=inputs=2:duration=longest:dropout_transition=2,volume=1.2[bg${index}];`
      );
    });

    const finalStreamLabel = `bg${batchFiles.length - 1}`;
    filterComplexParts.push(
      `[${finalStreamLabel}]loudnorm=I=-16:TP=-1.5:LRA=11[out]`
    );

    const filterComplex = filterComplexParts.join(" ");
    const outputPath = await this.createTempPath("batch", "wav");
    const ffmpegCmd = `ffmpeg ${inputFiles.join(
      " "
    )} -filter_complex "${filterComplex}" -map "[out]" -y "${outputPath}"`;

    try {
      console.log("Executing FFmpeg command for batch");
      console.log("Filter Complex:", filterComplex);
      await execAsync(ffmpegCmd);
      await this.verifyFile(outputPath);
      return outputPath;
    } catch (error) {
      console.error("FFmpeg command failed:", error);
      throw new Error(`FFmpeg command failed: ${error}`);
    }
  }

  async uploadToStorage(filePath: string): Promise<string> {
    try {
      console.log("Starting upload to storage:", filePath);
      await this.verifyFile(filePath);

      const bucket = storageGoogle.bucket(BUCKET_NAME);
      const filename = path.basename(filePath);
      const file = bucket.file(filename);

      // Upload using streams with explicit error handling
      await new Promise<void>((resolve, reject) => {
        const readStream = createReadStream(filePath);
        const writeStream = file.createWriteStream({
          resumable: false,
          validation: "md5",
        });

        readStream.on("error", (error) => {
          console.error("Read stream error:", error);
          reject(new Error(`Read stream error: ${error.message}`));
        });

        writeStream.on("error", (error) => {
          console.error("Write stream error:", error);
          reject(new Error(`Write stream error: ${error.message}`));
        });

        writeStream.on("finish", () => {
          console.log("Upload completed successfully");
          resolve();
        });

        readStream.pipe(writeStream);
      });

      // Return the public URL
      const [url] = await file.getSignedUrl({
        action: "read",
        expires: SIGNED_URL_EXPIRY,
      });
      console.log("File uploaded successfully:", url);
      return url;
    } catch (error) {
      console.error("Upload failed:", error);
      throw new Error(`Upload failed: ${error}`);
    }
  }
}

// Worker implementation
const worker = new Worker<JobData>(
  "audio-processing",
  async (job) => {
    const audioProcessor = new AudioProcessor();
    await audioProcessor.init();

    try {
      const ttsConvertedPaths = await audioProcessor.processTTSFiles(
        job.data.audioUrls
      );
      const separatedPath = await audioProcessor.separateOriginalAudio(
        job.data.originalAudioUrl
      );

      const results = [];
      for (let i = 0; i < ttsConvertedPaths.length; i += BATCH_SIZE) {
        const batchFiles = ttsConvertedPaths.slice(i, i + BATCH_SIZE);
        const transcriptSlice = job.data.transcript.slice(i, i + BATCH_SIZE);
        const combinedPath = await audioProcessor.combineBatchWithBackground(
          batchFiles,
          separatedPath,
          transcriptSlice,
          i
        );

        const uploadedUrl = await audioProcessor.uploadToStorage(combinedPath);
        results.push(uploadedUrl);
      }

      console.log("All audio processed successfully", results);
      return results;
    } catch (error) {
      console.error("Error processing audio:", error);
      throw new Error(`Error processing audio: ${error}`);
    } finally {
      await audioProcessor.cleanup();
    }
  },
  {
    connection: {
      host: process.env.WORKER_URL, // Replace with your Redis host
      port: Number(process.env.WORKER_PORT),
    },
    concurrency: 5,
  }
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed successfully!`);
});

worker.on("failed", (job, err) => {
  console.log(`Job ${job?.id} failed with error: ${err.message}`);
});
