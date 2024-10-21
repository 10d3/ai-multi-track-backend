import { Worker } from "bullmq";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { promisify } from "util";
import { exec } from "child_process";
import { storageGoogle } from "./queue";
import { v4 as uuidv4 } from "uuid";
import { downloadAudioFile } from "./utils";
import dotenv from "dotenv";

dotenv.config();

// Promisify exec for async/await usage
const execAsync = promisify(exec);

// Define constants
const BATCH_SIZE = 5;
const TEMP_DIR = path.resolve(process.cwd(), "temp");
const BUCKET_NAME = process.env.BUCKET_NAME as string;
const SIGNED_URL_EXPIRY = "03-09-2491";

// Define interfaces for job data
interface Transcript {
  start: number;
  end?: number;
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

  async getAudioDuration(filePath: string): Promise<number> {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    return parseFloat(stdout);
  }

  async init(): Promise<void> {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    console.log("Temporary directory created/verified at:", TEMP_DIR);
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

  async combineAllSpeechWithBackground(
    speechFiles: string[],
    backgroundTrack: string,
    transcript: Transcript[]
  ): Promise<string> {
    await this.verifyFile(backgroundTrack);
    await Promise.all(speechFiles.map((file) => this.verifyFile(file)));

    const bgDuration = await this.getAudioDuration(backgroundTrack);

    // Process background track
    const processedBgPath = await this.createTempPath("processed_bg", "wav");
    await execAsync(
      `ffmpeg -i "${backgroundTrack}" -af "volume=0.3,lowpass=f=1000" -ar 44100 -t ${bgDuration} -y "${processedBgPath}"`
    );

    // Process speech files
    const processedSpeechFiles = await Promise.all(
      speechFiles.map(async (file, index) => {
        const outputPath = await this.createTempPath(
          `processed_speech_${index}`,
          "wav"
        );
        await execAsync(
          `ffmpeg -i "${file}" -af "highpass=f=100,lowpass=f=3000,volume=2" -ar 44100 -y "${outputPath}"`
        );
        return outputPath;
      })
    );

    let filterComplex = ``;
    let inputs = `-i "${processedBgPath}" `;
    let overlays = ``;

    // Adjust timings to fit within background duration
    const firstStart = transcript[0].start;
    const lastEnd = transcript[transcript.length - 1].end as number;
    const totalDuration = lastEnd - firstStart;
    const scaleFactor = bgDuration / totalDuration;

    for (let i = 0; i < transcript.length; i++) {
      const originalStart = transcript[i].start;
      const originalEnd = transcript[i].end as number;

      // Adjust start and end times
      const adjustedStart =
        i === 0 ? 0 : (originalStart - firstStart) * scaleFactor;
      const adjustedEnd =
        i === transcript.length - 1
          ? bgDuration
          : (originalEnd - firstStart) * scaleFactor;
      const adjustedDuration = adjustedEnd - adjustedStart;

      inputs += `-i "${processedSpeechFiles[i]}" `;

      const actualDuration = await this.getAudioDuration(
        processedSpeechFiles[i]
      );
      let tempoFactor = actualDuration / adjustedDuration;

      // Ensure tempoFactor is within the valid range (0.5 to 2)
      tempoFactor = Math.max(0.5, Math.min(tempoFactor, 2));

      filterComplex += `[${
        i + 1
      }:a]atempo=${tempoFactor},atrim=0:${adjustedDuration},asetpts=PTS-STARTPTS[adj${i}];`;
      filterComplex += `[adj${i}]adelay=${Math.round(
        adjustedStart * 1000
      )}|${Math.round(adjustedStart * 1000)}[s${i}];`;
    }

    filterComplex += `[0:a]apad[bg];`;
    overlays += `[bg]`;

    for (let i = 0; i < transcript.length; i++) {
      overlays += `[s${i}]`;
    }
    filterComplex += `${overlays}amix=inputs=${
      transcript.length + 1
    }:dropout_transition=0:normalize=0[mixed];`;

    // Apply audio enhancements with boosted bass
    filterComplex +=
      `[mixed]equalizer=f=100:t=q:w=200:g=10,` + // Boost low frequencies (100 Hz)
      `equalizer=f=1000:t=q:w=200:g=0,` + // Keep mid frequencies neutral
      `equalizer=f=3000:t=q:w=200:g=-2,` + // Slightly reduce high frequencies
      `dynaudnorm=p=0.95:m=15,` + // Dynamic normalization
      `compand=attacks=0:points=-80/-80|-50/-50|-40/-30|-30/-20|-20/-10|-10/-5|-5/0|0/0[out]`; // Compression

    const finalOutputPath = await this.createTempPath("final_output", "wav");
    const ffmpegCmd = `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[out]" -t ${bgDuration} -y "${finalOutputPath}"`;

    await execAsync(ffmpegCmd);

    return finalOutputPath;
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
      console.log("File uploaded successfully:", url);
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

    const totalSteps = job.data.audioUrls.length + 2; // TTS files + separate original + combine
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

    try {
      const ttsConvertedPaths = await audioProcessor.processTTSFiles(
        job.data.audioUrls
      );
      completedSteps++;
      await job.updateProgress(Math.round((completedSteps / totalSteps) * 100));
      recordStepTime();

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
      host: process.env.WORKER_URL,
      port: Number(process.env.WORKER_PORT),
    },
    concurrency: 5,
  }
);

worker.on("progress", (job, progress) => {
  console.log(`Job ${job.id} progress: ${progress}%`);
});

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed successfully!`);
});

worker.on("failed", (job, err) => {
  console.log(`Job ${job?.id} failed with error: ${err.message}`);
});