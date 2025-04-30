import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { promisify } from "util";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { TEMP_DIR } from "./constants";
import { downloadAudioFile } from "../../utils";

const execAsync = promisify(exec);

export class FileProcessor {
  private tempFilePaths: Set<string>;
  private tempDirs: Set<string>;

  constructor() {
    this.tempFilePaths = new Set();
    this.tempDirs = new Set();
  }

  async init(): Promise<void> {
    await fs.mkdir(TEMP_DIR, { recursive: true });
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
    this.tempFilePaths.clear();
    this.tempDirs.clear();
    console.log("Cleanup completed");
  }

  async createTempPath(prefix: string, extension?: string): Promise<string> {
    const filename = `${prefix}_${uuidv4()}${extension ? `.${extension}` : ""}`;
    const filePath = path.join(TEMP_DIR, filename);
    this.tempFilePaths.add(filePath);
    return filePath;
  }

  async createTempDir(prefix: string): Promise<string> {
    const dirPath = await this.createTempPath(prefix);
    await fs.mkdir(dirPath, { recursive: true });
    this.tempDirs.add(dirPath);
    this.tempFilePaths.delete(dirPath);
    return dirPath;
  }

  async getTempDir(): Promise<string> {
    return TEMP_DIR;
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

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      return false;
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

  async downloadAndConvertAudio(url: string): Promise<string> {
    const tempPath = await this.createTempPath("temp", "mp3");
    await downloadAudioFile(url, tempPath);
    await this.verifyFile(tempPath);

    const wavPath = await this.convertAudioToWav(tempPath);
    await fs.unlink(tempPath);

    return wavPath;
  }

  async getAudioDuration(filePath: string): Promise<number> {
    try {
      await this.verifyFile(filePath);

      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
      );

      const duration = parseFloat(stdout);
      if (isNaN(duration)) {
        throw new Error("Failed to parse audio duration");
      }

      return duration;
    } catch (error) {
      console.error(`Failed to get audio duration for ${filePath}:`, error);
      throw new Error(`Failed to get audio duration: ${error}`);
    }
  }
}
