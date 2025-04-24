import { promisify } from "util";
import { exec } from "child_process";
import type { FileProcessor } from "./file-processor";
import type { AudioAnalysisResult } from "../../types/type";


const execAsync = promisify(exec);

export class AudioAnalyzer {
  private fileProcessor: FileProcessor;

  constructor(fileProcessor: FileProcessor) {
    this.fileProcessor = fileProcessor;
  }

  async getAudioDuration(filePath: string): Promise<number> {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    return parseFloat(stdout);
  }

  async analyzeAudio(filePath: string): Promise<AudioAnalysisResult> {
    if (!filePath) {
      throw new Error("File path is required");
    }

    try {
      await this.fileProcessor.verifyFile(filePath);

      const loudnessInfo = await execAsync(
        `ffmpeg -i "${filePath}" -af "loudnorm=print_format=json:linear=true:dual_mono=true" -f null - 2>&1`
      );

      const jsonMatch = loudnessInfo.stdout.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Could not find JSON data in FFmpeg output");
      }

      const loudnessData = JSON.parse(jsonMatch[0]);

      const formatInfo = await execAsync(
        `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath}"`
      );

      const audioInfo = JSON.parse(formatInfo.stdout);
      const audioStream = audioInfo.streams?.find((s: any) => s.codec_type === "audio");

      if (!audioStream) {
        throw new Error("No audio stream found in file");
      }

      const result: AudioAnalysisResult = {
        loudness: {
          integrated: parseFloat(loudnessData.input_i || "0"),
          truePeak: parseFloat(loudnessData.input_tp || "0"),
          range: Math.max(1, Math.min(20, parseFloat(loudnessData.input_lra || "1"))),
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

      this.validateAnalysisResult(result);
      return result;
    } catch (error) {
      console.error("Error analyzing audio:", error);
      throw error;
    }
  }

  private validateAnalysisResult(result: AudioAnalysisResult): void {
    const { loudness, format, duration } = result;
    if (
      isNaN(loudness.integrated) ||
      isNaN(loudness.truePeak) ||
      isNaN(loudness.range) ||
      isNaN(format.sampleRate) ||
      isNaN(format.channels) ||
      isNaN(duration)
    ) {
      throw new Error("Invalid audio analysis values detected");
    }
  }
}