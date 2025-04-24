import { promisify } from "util";
import { exec } from "child_process";
import { FileProcessor } from "./file-processor";
import { AudioAnalyzer } from "./audio-analyzer";
import { FFMPEG_DEFAULTS, AUDIO_PROCESSING } from "./constants";
import type { Transcript } from "../../types/type";

const execAsync = promisify(exec);

export class AudioCombiner {
  private fileProcessor: FileProcessor;
  private audioAnalyzer: AudioAnalyzer;

  constructor(fileProcessor: FileProcessor, audioAnalyzer: AudioAnalyzer) {
    this.fileProcessor = fileProcessor;
    this.audioAnalyzer = audioAnalyzer;
  }

  async combineAllSpeechWithBackground(
    speechFiles: string[],
    backgroundTrack: string,
    transcript: Transcript[]
  ): Promise<string> {
    if (!speechFiles?.length) {
      throw new Error("Speech files array is required and must not be empty");
    }
    if (!backgroundTrack) {
      throw new Error("Background track is required");
    }
    if (!transcript?.length || transcript.length !== speechFiles.length) {
      throw new Error("Transcript array must match speech files length");
    }

    try {
      await this.fileProcessor.verifyFile(backgroundTrack);
      await Promise.all(
        speechFiles.map((file) => this.fileProcessor.verifyFile(file))
      );

      const bgAnalysis = await this.audioAnalyzer.analyzeAudio(backgroundTrack);
      const bgDuration = bgAnalysis.duration;

      if (bgDuration <= 0) {
        throw new Error("Invalid background track duration");
      }

      // Process background track
      const processedBgPath = await this.fileProcessor.createTempPath(
        "processed_bg",
        "wav"
      );
      await execAsync(
        `ffmpeg -i "${backgroundTrack}" -af "volume=${AUDIO_PROCESSING.BG_WEIGHT}" -ar ${FFMPEG_DEFAULTS.SAMPLE_RATE} -ac ${FFMPEG_DEFAULTS.CHANNELS} -y "${processedBgPath}"`
      );

      // Process speech files
      const processedSpeechFiles = await Promise.all(
        speechFiles.map(async (file, index) => {
          const outputPath = await this.fileProcessor.createTempPath(
            `processed_speech_${index}`,
            "wav"
          );
          await execAsync(
            `ffmpeg -i "${file}" -af "volume=${AUDIO_PROCESSING.SPEECH_WEIGHT}" -ar ${FFMPEG_DEFAULTS.SAMPLE_RATE} -ac ${FFMPEG_DEFAULTS.CHANNELS} -y "${outputPath}"`
          );
          return outputPath;
        })
      );

      // Prepare FFmpeg filter complex command
      let filterComplex = "";
      let inputs = `-i "${processedBgPath}" `;
      let overlays = "";

      const firstStart = transcript[0].start;
      const lastEnd = transcript[transcript.length - 1].end;
      const speechDuration = lastEnd - firstStart;
      const scaleFactor =
        (bgDuration * AUDIO_PROCESSING.SCALE_FACTOR) / speechDuration;

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

      // Mix with weights
      const weights = [
        AUDIO_PROCESSING.BG_WEIGHT,
        ...Array(transcript.length).fill(AUDIO_PROCESSING.SPEECH_WEIGHT),
      ].join(" ");

      filterComplex += `${overlays}amix=inputs=${
        transcript.length + 1
      }:weights=${weights}[mixed];`;
      filterComplex += `[mixed]acompressor=threshold=-12dB:ratio=2:attack=200:release=1000[out]`;

      const finalOutputPath = await this.fileProcessor.createTempPath(
        "final_output",
        "wav"
      );
      const ffmpegCmd = `ffmpeg ${inputs} -filter_complex "${filterComplex}" -map "[out]" -c:a pcm_s16le -t ${bgDuration} -y "${finalOutputPath}"`;

      await execAsync(ffmpegCmd);
      await this.fileProcessor.verifyFile(finalOutputPath);

      return finalOutputPath;
    } catch (error) {
      console.error("Error combining audio:", error);
      throw error;
    }
  }
}
