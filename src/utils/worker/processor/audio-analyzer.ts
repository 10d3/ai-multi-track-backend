import { promisify } from "util";
import { exec } from "child_process";
import type { FileProcessor } from "./file-processor";
import type { AudioAnalysisResult } from "../../types/type";
import { AUDIO_PROCESSING } from "./constants";

const execAsync = promisify(exec);

export class AudioAnalyzer {
  private fileProcessor: FileProcessor;

  constructor(fileProcessor: FileProcessor) {
    this.fileProcessor = fileProcessor;
  }

  async getAudioDuration(filePath: string): Promise<number> {
    try {
      await this.fileProcessor.verifyFile(filePath);

      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
      );

      const duration = parseFloat(stdout.trim());

      if (isNaN(duration) || duration <= 0) {
        throw new Error(`Invalid duration value: ${stdout}`);
      }

      return duration;
    } catch (error) {
      console.error(`Error getting audio duration for ${filePath}:`, error);
      throw new Error(`Failed to get audio duration: ${error}`);
    }
  }

  async analyzeAudio(filePath: string): Promise<AudioAnalysisResult> {
    if (!filePath) {
      throw new Error("File path is required for analysis");
    }

    try {
      await this.fileProcessor.verifyFile(filePath);

      // Run loudnorm analysis to get loudness information
      const loudnessInfo = await execAsync(
        `ffmpeg -i "${filePath}" -af "loudnorm=print_format=json:linear=true:dual_mono=true" -f null - 2>&1`
      );

      // Extract the JSON part from the ffmpeg output
      const jsonMatch = loudnessInfo.stdout.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Could not find JSON data in FFmpeg output");
      }

      const loudnessData = JSON.parse(jsonMatch[0]);

      // Get format information using ffprobe
      const formatInfo = await execAsync(
        `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath}"`
      );

      const audioInfo = JSON.parse(formatInfo.stdout);
      const audioStream = audioInfo.streams?.find(
        (s: any) => s.codec_type === "audio"
      );

      if (!audioStream) {
        throw new Error("No audio stream found in file");
      }

      // Build the analysis result object
      const result: AudioAnalysisResult = {
        loudness: {
          integrated: parseFloat(loudnessData.input_i || "0"),
          truePeak: parseFloat(loudnessData.input_tp || "0"),
          range: Math.max(
            1,
            Math.min(20, parseFloat(loudnessData.input_lra || "1"))
          ),
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

      // Validate the result to ensure we have valid values
      this.validateAnalysisResult(result);

      // Log analysis results for debugging
      console.log(`Audio analysis completed for ${filePath}:`, {
        duration: result.duration.toFixed(2) + "s",
        loudness: result.loudness.integrated.toFixed(2) + " LUFS",
        peak: result.loudness.truePeak.toFixed(2) + " dB",
        range: result.loudness.range.toFixed(2) + " LU",
        sampleRate: result.format.sampleRate + " Hz",
        channels: result.format.channels,
      });

      return result;
    } catch (error: any) {
      console.error(`Error analyzing audio file ${filePath}:`, error);
      throw new Error(`Audio analysis failed: ${error.message || error}`);
    }
  }

  /**
   * Validates that all necessary fields in the analysis result contain valid numbers
   */
  private validateAnalysisResult(result: AudioAnalysisResult): void {
    const { loudness, format, duration } = result;

    if (isNaN(loudness.integrated)) {
      throw new Error("Invalid integrated loudness value");
    }

    if (isNaN(loudness.truePeak)) {
      throw new Error("Invalid true peak value");
    }

    if (isNaN(loudness.range)) {
      throw new Error("Invalid loudness range value");
    }

    if (isNaN(format.sampleRate) || format.sampleRate <= 0) {
      throw new Error(`Invalid sample rate: ${format.sampleRate}`);
    }

    if (isNaN(format.channels) || format.channels <= 0) {
      throw new Error(`Invalid channel count: ${format.channels}`);
    }

    if (isNaN(duration) || duration <= 0) {
      throw new Error(`Invalid duration: ${duration}`);
    }
  }

  /**
   * Analyzes specific spectral characteristics of an audio file
   * Can be used for more detailed audio matching
   */
  async analyzeSpectralCharacteristics(filePath: string): Promise<any> {
    try {
      await this.fileProcessor.verifyFile(filePath);

      // Get spectral information using ffmpeg's ebur128 filter
      const { stdout } = await execAsync(
        `ffmpeg -i "${filePath}" -af "ebur128=metadata=1" -f null - 2>&1`
      );

      // Parse the output to extract spectral information
      const momentaryMatch = stdout.match(/Momentary:\s+([-\d.]+)/);
      const shortTermMatch = stdout.match(/Short term:\s+([-\d.]+)/);

      return {
        momentaryLoudness: momentaryMatch
          ? parseFloat(momentaryMatch[1])
          : null,
        shortTermLoudness: shortTermMatch
          ? parseFloat(shortTermMatch[1])
          : null,
      };
    } catch (error: any) {
      console.error("Error analyzing spectral characteristics:", error);
      throw new Error(`Spectral analysis failed: ${error.message || error}`);
    }
  }

  /**
   * Compares two audio files to determine how well they match in terms of
   * duration, loudness, and spectral characteristics
   */
  async compareAudioFiles(file1: string, file2: string): Promise<any> {
    try {
      const analysis1 = await this.analyzeAudio(file1);
      const analysis2 = await this.analyzeAudio(file2);

      const durationDiff = Math.abs(analysis1.duration - analysis2.duration);
      const loudnessDiff = Math.abs(
        analysis1.loudness.integrated - analysis2.loudness.integrated
      );
      const peakDiff = Math.abs(
        analysis1.loudness.truePeak - analysis2.loudness.truePeak
      );

      return {
        durationMatch:
          durationDiff < 0.1
            ? "excellent"
            : durationDiff < 0.5
            ? "good"
            : "poor",
        loudnessMatch:
          loudnessDiff < AUDIO_PROCESSING.LOUDNESS_MATCH_THRESHOLD 
            ? "excellent" 
            : loudnessDiff < AUDIO_PROCESSING.LOUDNESS_MATCH_THRESHOLD * 2 
            ? "good" 
            : "poor",
        peakMatch: 
          peakDiff < AUDIO_PROCESSING.PEAK_MATCH_THRESHOLD 
            ? "excellent" 
            : peakDiff < AUDIO_PROCESSING.PEAK_MATCH_THRESHOLD * 2 
            ? "good" 
            : "poor",
        differences: {
          duration: durationDiff.toFixed(2) + "s",
          loudness: loudnessDiff.toFixed(2) + " LUFS",
          peak: peakDiff.toFixed(2) + " dB",
        },
        isWithinThresholds: 
          loudnessDiff < AUDIO_PROCESSING.LOUDNESS_MATCH_THRESHOLD &&
          peakDiff < AUDIO_PROCESSING.PEAK_MATCH_THRESHOLD &&
          (durationDiff / Math.max(analysis1.duration, analysis2.duration)) < 
            AUDIO_PROCESSING.DURATION_MATCH_THRESHOLD
      };
    } catch (error: any) {
      console.error("Error comparing audio files:", error);
      throw new Error(`Audio comparison failed: ${error.message || error}`);
    }
  }

  /**
   * Validates that a speech segment is correctly positioned within the expected time range
   * @param segmentPath Path to the audio segment
   * @param expectedDuration Expected duration of the segment
   * @param tolerance Tolerance in seconds for duration mismatch
   * @returns Object with validation results
   */
  async validateSegmentTiming(
    segmentPath: string, 
    expectedDuration: number,
    tolerance: number = 0.1
  ): Promise<{isValid: boolean; actualDuration: number; difference: number}> {
    try {
      const actualDuration = await this.getAudioDuration(segmentPath);
      const difference = Math.abs(actualDuration - expectedDuration);
      const isValid = difference <= tolerance;
      
      if (!isValid) {
        console.warn(`Segment timing validation failed: expected ${expectedDuration}s, got ${actualDuration}s (diff: ${difference}s)`);
      }
      
      return {
        isValid,
        actualDuration,
        difference
      };
    } catch (error) {
      console.error("Error validating segment timing:", error);
      throw new Error(`Segment timing validation failed: ${error}`);
    }
  }

  /**
   * Validates that the final audio characteristics match the original within acceptable thresholds
   */
  async validateFinalAudio(
    finalPath: string, 
    originalAnalysis: AudioAnalysisResult
  ): Promise<{isValid: boolean; details: any}> {
    try {
      const finalAnalysis = await this.analyzeAudio(finalPath);
      
      const loudnessDiff = Math.abs(
        finalAnalysis.loudness.integrated - originalAnalysis.loudness.integrated
      );
      
      const peakDiff = Math.abs(
        finalAnalysis.loudness.truePeak - originalAnalysis.loudness.truePeak
      );
      
      const durationRatio = Math.abs(
        1 - (finalAnalysis.duration / originalAnalysis.duration)
      );
      
      const isLoudnessValid = loudnessDiff <= AUDIO_PROCESSING.LOUDNESS_MATCH_THRESHOLD;
      const isPeakValid = peakDiff <= AUDIO_PROCESSING.PEAK_MATCH_THRESHOLD;
      const isDurationValid = durationRatio <= AUDIO_PROCESSING.DURATION_MATCH_THRESHOLD;
      
      const isValid = isLoudnessValid && isPeakValid && isDurationValid;
      
      return {
        isValid,
        details: {
          loudness: {
            original: originalAnalysis.loudness.integrated,
            final: finalAnalysis.loudness.integrated,
            difference: loudnessDiff,
            isValid: isLoudnessValid
          },
          peak: {
            original: originalAnalysis.loudness.truePeak,
            final: finalAnalysis.loudness.truePeak,
            difference: peakDiff,
            isValid: isPeakValid
          },
          duration: {
            original: originalAnalysis.duration,
            final: finalAnalysis.duration,
            ratio: durationRatio,
            isValid: isDurationValid
          }
        }
      };
    } catch (error) {
      console.error("Error validating final audio:", error);
      throw new Error(`Final audio validation failed: ${error}`);
    }
  }
}
