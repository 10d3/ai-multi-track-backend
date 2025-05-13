import { promisify } from "util";
import { exec } from "child_process";
import path from "path";
import type { FileProcessor } from "./file-processor";
import type { AudioAnalyzer } from "./audio-analyzer";
import type { Transcript } from "../../types/type";
import fs from "fs/promises";
import { AUDIO_PROCESSING, FFMPEG_FILTERS } from "./constants";

const execAsync = promisify(exec);

export class AudioCombiner {
  private fileProcessor: FileProcessor;
  private audioAnalyzer: AudioAnalyzer;

  constructor(fileProcessor: FileProcessor, audioAnalyzer: AudioAnalyzer) {
    this.fileProcessor = fileProcessor;
    this.audioAnalyzer = audioAnalyzer;
  }

  async combineAudioFiles(
    backgroundPath: string,
    speechPaths: string[],
    transcript: Transcript[]
  ): Promise<string> {
    try {
      if (!backgroundPath || !speechPaths.length) {
        throw new Error("Missing required audio files for combination");
      }

      // First analyze the background audio to get its characteristics
      console.log("Analyzing background audio characteristics...");
      const bgAnalysis = await this.audioAnalyzer.analyzeAudio(backgroundPath);

      console.log("Background audio analysis:", {
        duration: bgAnalysis.duration,
        sampleRate: bgAnalysis.format.sampleRate,
        channels: bgAnalysis.format.channels,
        loudness: bgAnalysis.loudness.integrated,
        truePeak: bgAnalysis.loudness.truePeak,
      });

      // Skip background cleaning and use original background track directly
      console.log("Using original background track without cleaning...");
      const originalBgPath = backgroundPath;

      // Create a temporary directory for the combined audio segments
      const outputDir = await this.fileProcessor.createTempDir(
        "combined_segments"
      );

      // Process each speech segment and position it correctly
      const segmentPaths: string[] = [];
      const segmentValidations: any[] = [];

      for (let i = 0; i < speechPaths.length; i++) {
        const segment = transcript[i];
        if (
          !segment ||
          segment.start === undefined ||
          segment.end === undefined
        ) {
          console.warn(`Missing transcript data for segment ${i}, skipping`);
          continue;
        }

        // Create segment with precise timing
        const segmentPath = await this.createSegmentWithBackground(
          originalBgPath,
          speechPaths[i],
          segment.start,
          segment.end,
          outputDir,
          i,
          bgAnalysis
        );

        if (segmentPath) {
          // Validate segment timing
          const expectedDuration = segment.end - segment.start;
          const validation = await this.audioAnalyzer.validateSegmentTiming(
            segmentPath,
            expectedDuration,
            0.1 // 100ms tolerance
          );

          segmentValidations.push({
            index: i,
            start: segment.start,
            end: segment.end,
            expectedDuration,
            actualDuration: validation.actualDuration,
            difference: validation.difference,
            isValid: validation.isValid,
          });

          segmentPaths.push(segmentPath);
        }
      }

      if (!segmentPaths.length) {
        throw new Error("No valid segments were created");
      }

      // Log segment validation results
      console.log("Segment timing validation results:", segmentValidations);

      // Check if any segments have timing issues
      const invalidSegments = segmentValidations.filter((v) => !v.isValid);
      if (invalidSegments.length > 0) {
        console.warn(
          `${invalidSegments.length} segments have timing issues:`,
          invalidSegments
        );
      }

      // Combine all segments into the final audio
      const finalPath = await this.fileProcessor.createTempPath(
        "final_audio",
        "wav"
      );

      // Prepare for combining segments with crossfades
      console.log("Preparing to combine segments with crossfades...");

      // Get the original background duration to ensure final output matches exactly
      const originalBgDuration = bgAnalysis.duration;
      console.log(
        `Original background duration: ${originalBgDuration.toFixed(2)}s`
      );

      // Create intermediate path for the combined segments
      const combinedSegmentsPath = await this.fileProcessor.createTempPath(
        "combined_segments",
        "wav"
      );

      // Create a complex filter for combining segments with crossfades
      let filterComplex = "";
      let inputsString = "";

      // Add all segment inputs
      for (let i = 0; i < segmentPaths.length; i++) {
        inputsString += ` -i "${segmentPaths[i]}"`;
      }

      // Create crossfade filter chain
      if (segmentPaths.length === 1) {
        // If only one segment, just use it directly
        filterComplex = "[0:a]acopy[out]";
      } else {
        // For multiple segments, create crossfades between them
        const crossfadeDuration = AUDIO_PROCESSING.CROSSFADE_DURATION_MS / 1000;

        // Start with the first segment
        filterComplex += `[0:a]atrim=end=${
          transcript[0].end -
          transcript[0].start +
          AUDIO_PROCESSING.SEGMENT_PADDING_MS / 1000
        }[first];`;

        // Add middle segments with crossfades
        for (let i = 1; i < segmentPaths.length; i++) {
          // Calculate segment duration
          const segDuration =
            transcript[i].end -
            transcript[i].start +
            (AUDIO_PROCESSING.SEGMENT_PADDING_MS / 1000) * 2;

          // Prepare current segment
          filterComplex += `[${i}:a]atrim=end=${segDuration}[seg${i}];`;

          // Create crossfade between previous and current segment
          if (i === 1) {
            filterComplex += `[first][seg${i}]acrossfade=d=${crossfadeDuration}:c1=tri:c2=tri[crossed${i}];`;
          } else {
            filterComplex += `[crossed${
              i - 1
            }][seg${i}]acrossfade=d=${crossfadeDuration}:c1=tri:c2=tri[crossed${i}];`;
          }
        }

        // The final output is the last crossed segment
        filterComplex += `[crossed${
          segmentPaths.length - 1
        }]asetpts=PTS-STARTPTS[out]`;
      }

      // Combine segments with crossfades
      console.log("Combining segments with crossfades...");
      await execAsync(
        `ffmpeg -threads 2${inputsString} -filter_complex "${filterComplex}" -map "[out]" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${combinedSegmentsPath}"`
      );

      // Ensure the final output has exactly the same duration as the original background
      console.log(
        "Adjusting final audio to match original background duration exactly..."
      );
      await execAsync(
        `ffmpeg -threads 2 -i "${combinedSegmentsPath}" -af "apad=whole_dur=${originalBgDuration},atrim=0:${originalBgDuration}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${finalPath}"`
      );

      // Create a file list for ffmpeg concat
      // This code is no longer needed as we're using the crossfade approach above

      // Apply final audio processing to match original characteristics
      const processedPath = await this.applyFinalProcessing(
        finalPath,
        bgAnalysis
      );

      // Validate final audio against original characteristics
      const finalValidation = await this.audioAnalyzer.validateFinalAudio(
        processedPath,
        bgAnalysis
      );

      console.log("Final audio validation results:", finalValidation);

      // If validation fails but audio is still usable, log warning but continue
      if (!finalValidation.isValid) {
        console.warn(
          "Final audio does not perfectly match original characteristics:",
          finalValidation.details
        );
      }

      return processedPath;
    } catch (error) {
      console.error("Error combining audio files:", error);
      throw error;
    }
  }

  // cleanBackgroundTrack method removed as we're using original background track directly

  private async createSegmentWithBackground(
    backgroundPath: string,
    speechPath: string,
    startTime: number,
    endTime: number,
    outputDir: string,
    index: number,
    bgAnalysis: any
  ): Promise<string | null> {
    try {
      const duration = endTime - startTime;
      if (duration <= 0) {
        console.warn(`Invalid duration for segment ${index}: ${duration}s`);
        return null;
      }

      // Increase padding to ensure we don't cut off speech and allow for crossfades
      const paddingMs = AUDIO_PROCESSING.SEGMENT_PADDING_MS;
      const crossfadeMs = AUDIO_PROCESSING.CROSSFADE_DURATION_MS;
      const paddingSec = paddingMs / 1000;
      const crossfadeSec = crossfadeMs / 1000;

      // Calculate precise timing with padding
      const extractStart = Math.max(0, startTime - paddingSec - crossfadeSec);
      const extractDuration = duration + paddingSec * 2 + crossfadeSec * 2;

      console.log(`Creating segment ${index} with precise timing:`, {
        originalStart: startTime,
        originalEnd: endTime,
        originalDuration: duration,
        extractStart,
        extractDuration,
        paddingMs,
        crossfadeMs,
      });

      // Extract the background segment for this time range with higher quality
      const bgSegmentPath = path.join(outputDir, `bg_segment_${index}.wav`);
      await execAsync(
        `ffmpeg -threads 2 -i "${backgroundPath}" -ss ${extractStart} -t ${extractDuration} -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${bgSegmentPath}"`
      );

      // Analyze the speech file to get its characteristics
      console.log(`Analyzing speech file ${index} for optimal mixing...`);
      const speechAnalysis = await this.audioAnalyzer.analyzeAudio(speechPath);

      // Calculate optimal mixing parameters based on analysis
      const speechLoudness = speechAnalysis.loudness.integrated;
      const bgLoudness = bgAnalysis.loudness.integrated;

      // Dynamically adjust volume weights based on loudness difference
      // This ensures consistent speech clarity across different segments
      const loudnessDiff = Math.abs(speechLoudness - bgLoudness);

      // Calculate optimal speech weight - increase if speech is quieter than background
      let speechWeight = AUDIO_PROCESSING.SPEECH_WEIGHT;
      let bgWeight = AUDIO_PROCESSING.BG_WEIGHT;

      // Apply more aggressive speech enhancement for all segments after the first one
      // to address the "touffe" (muffled) sound issue
      let speechEnhancement = "";
      if (index > 0) {
        // For segments after the first one, apply stronger speech enhancement
        speechEnhancement =
          "highpass=f=70,lowpass=f=12000,equalizer=f=1000:width_type=q:width=1:gain=2,equalizer=f=3000:width_type=q:width=1:gain=3,";
        // Also boost speech weight more for later segments
        speechWeight = Math.min(1.8, speechWeight * 1.3);
      } else {
        // For the first segment, use gentler enhancement
        speechEnhancement = "highpass=f=80,lowpass=f=12000,";
      }

      // Further adjust weights based on loudness difference
      if (speechLoudness < bgLoudness - 5) {
        // Speech is significantly quieter than background, boost it more but preserve background
        speechWeight = Math.min(2.0, speechWeight * 1.3);
        bgWeight = Math.max(0.4, bgWeight * 0.9); // Keep more background
      } else if (speechLoudness > bgLoudness + 5) {
        // Speech is significantly louder than background, reduce it slightly and boost background
        speechWeight = Math.max(0.8, speechWeight * 0.85);
        bgWeight = Math.min(0.8, bgWeight * 1.25); // Boost background more
      } else {
        // Even when loudness is similar, ensure background is clearly audible
        bgWeight = Math.min(0.8, bgWeight * 1.1);
      }

      console.log(`Segment ${index} mixing parameters:`, {
        speechLoudness: speechLoudness.toFixed(2),
        bgLoudness: bgLoudness.toFixed(2),
        loudnessDiff: loudnessDiff.toFixed(2),
        speechWeight: speechWeight.toFixed(2),
        bgWeight: bgWeight.toFixed(2),
        enhancedSpeech: index > 0 ? "yes" : "standard",
      });

      // Prepare the output path
      const outputPath = path.join(outputDir, `combined_segment_${index}.wav`);

      // Enhanced filter complex for better audio quality and mixing
      // 1. Apply enhanced speech enhancement to improve clarity
      // 2. Match sample rates and channel layouts
      // 3. Apply dynamic volume adjustment
      // 4. Mix with precise weights
      // 5. Apply gentle compression to even out levels
      const channelLayout = bgAnalysis.format.channels == 1 ? "mono" : "stereo";
      const filterComplex = `
        [0:a]aformat=sample_fmts=fltp:sample_rates=${
          bgAnalysis.format.sampleRate
        }:channel_layouts=${channelLayout},volume=${bgWeight}[bg];
        [1:a]aformat=sample_fmts=fltp:sample_rates=${
          bgAnalysis.format.sampleRate
        }:channel_layouts=${channelLayout},
        ${speechEnhancement}volume=${speechWeight}[speech];
        [bg][speech]amix=inputs=2:duration=longest:weights=${
          bgWeight * 1.2
        } ${speechWeight}[mixed];
        [mixed]acompressor=threshold=-18dB:ratio=2:attack=50:release=200:makeup=1.2[out]
      `;

      await execAsync(
        `ffmpeg -threads 2 -i "${bgSegmentPath}" -i "${speechPath}" -filter_complex "${filterComplex.replace(
          /\s+/g,
          " "
        )}" -map "[out]" -c:a pcm_s24le "${outputPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(outputPath);

      // Analyze the final segment to ensure quality
      const segmentAnalysis = await this.audioAnalyzer.analyzeAudio(outputPath);
      console.log(
        `Segment ${index} created successfully with characteristics:`,
        {
          duration: segmentAnalysis.duration.toFixed(2) + "s",
          loudness: segmentAnalysis.loudness.integrated.toFixed(2) + " LUFS",
          peak: segmentAnalysis.loudness.truePeak.toFixed(2) + " dB",
        }
      );

      return outputPath;
    } catch (error) {
      console.error(`Error creating segment ${index}:`, error);
      throw new Error(`Failed to create segment ${index}: ${error}`);
    }
  }

  private async applyFinalProcessing(
    inputPath: string,
    originalAnalysis: any
  ): Promise<string> {
    try {
      console.log(
        "Starting enhanced final audio processing with spectral matching..."
      );

      // Create intermediate paths for multi-stage processing
      const speechEnhancedPath = await this.fileProcessor.createTempPath(
        "speech_enhanced",
        "wav"
      );

      const spectrumMatchedPath = await this.fileProcessor.createTempPath(
        "spectrum_matched",
        "wav"
      );

      const dynamicsMatchedPath = await this.fileProcessor.createTempPath(
        "dynamics_matched",
        "wav"
      );

      const outputPath = await this.fileProcessor.createTempPath(
        "processed_final",
        "wav"
      );

      // Extract target parameters from original analysis
      const targetLufs = originalAnalysis.loudness.integrated;
      const targetRange = originalAnalysis.loudness.range;

      // Ensure TP is within the valid range of -9 to 0 dB
      const targetPeak = Math.max(
        -9,
        Math.min(-0.5, originalAnalysis.loudness.truePeak)
      );

      // Get channel layout string
      const channelLayout =
        originalAnalysis.format.channels == 1 ? "mono" : "stereo";

      console.log("Original audio characteristics:", {
        sampleRate: originalAnalysis.format.sampleRate,
        channels: originalAnalysis.format.channels,
        lufs: targetLufs,
        truePeak: targetPeak,
        dynamicRange: targetRange,
      });

      // STAGE 0: Apply speech enhancement to improve clarity of all speech segments
      // This helps address the "touffe" (muffled) sound issue in later segments
      console.log("Applying speech enhancement to improve clarity...");
      const speechEnhancementFilter = `
        highpass=f=70,
        lowpass=f=14000,
        equalizer=f=1000:width_type=q:width=1:gain=2,
        equalizer=f=3000:width_type=q:width=1:gain=3,
        equalizer=f=5000:width_type=q:width=1:gain=1.5,
        afftdn=nf=-15:tn=1
      `;

      await execAsync(
        `ffmpeg -threads 2 -i "${inputPath}" -af "${speechEnhancementFilter.replace(
          /\s+/g,
          " "
        )}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${
          originalAnalysis.format.channels
        } -y "${speechEnhancedPath}"`
      );

      // Default spectral values in case analysis fails
      let originalBassResponse = -20;
      let originalMidResponse = -18;
      let originalHighResponse = -25;
      let inputBassResponse = -20;
      let inputMidResponse = -18;
      let inputHighResponse = -25;

      // Initialize originalSpectralAnalysis with default values
      let originalSpectralAnalysis: any = {
        frequencyResponse: {
          dynamicRange: 20.0,
          bands: {
            bass: { meanVolume: -20 },
            mid: { meanVolume: -18 },
            high: { meanVolume: -25 },
          },
        },
      };

      try {
        // Perform detailed spectral analysis on the original audio
        console.log(
          "Performing detailed spectral analysis on original audio..."
        );
        originalSpectralAnalysis =
          await this.audioAnalyzer.analyzeSpectralCharacteristics(
            originalAnalysis.originalPath || inputPath
          );

        // Extract frequency band information from the original analysis with fallbacks
        originalBassResponse =
          originalSpectralAnalysis?.frequencyResponse?.bands?.bass
            ?.meanVolume || -20;
        originalMidResponse =
          originalSpectralAnalysis?.frequencyResponse?.bands?.mid?.meanVolume ||
          -18;
        originalHighResponse =
          originalSpectralAnalysis?.frequencyResponse?.bands?.high
            ?.meanVolume || -25;
      } catch (spectralError) {
        // Log but continue with default values
        console.warn(
          "Non-critical error in original spectral analysis:",
          spectralError
        );
        // We'll use the default values initialized above
      }

      // Analyze the speech-enhanced file to compare with original
      const inputAnalysis = await this.audioAnalyzer.analyzeAudio(
        speechEnhancedPath
      );

      // Calculate spectral differences to create a custom EQ curve
      console.log("Calculating spectral differences for precise matching...");

      // Initialize inputSpectralAnalysis with default values
      let inputSpectralAnalysis: any = {
        frequencyResponse: {
          dynamicRange: 20.0,
          bands: {
            bass: { meanVolume: -20 },
            mid: { meanVolume: -18 },
            high: { meanVolume: -25 },
          },
        },
      };

      try {
        // Analyze the input file's spectral characteristics
        inputSpectralAnalysis =
          await this.audioAnalyzer.analyzeSpectralCharacteristics(
            speechEnhancedPath
          );

        // Extract frequency band information from the input analysis with fallbacks
        inputBassResponse =
          inputSpectralAnalysis?.frequencyResponse?.bands?.bass?.meanVolume ||
          -20;
        inputMidResponse =
          inputSpectralAnalysis?.frequencyResponse?.bands?.mid?.meanVolume ||
          -18;
        inputHighResponse =
          inputSpectralAnalysis?.frequencyResponse?.bands?.high?.meanVolume ||
          -25;
      } catch (spectralError) {
        // Log but continue with default values
        console.warn(
          "Non-critical error in input spectral analysis:",
          spectralError
        );
        // We'll use the default values initialized above
      }

      // Calculate the differences between original and input
      // Limit adjustments to reasonable values (-6 to +6 dB)
      const bassDiff = Math.max(
        -6,
        Math.min(6, originalBassResponse - inputBassResponse)
      );
      const midDiff = Math.max(
        -6,
        Math.min(6, originalMidResponse - inputMidResponse)
      );
      const highDiff = Math.max(
        -6,
        Math.min(6, originalHighResponse - inputHighResponse)
      );

      console.log("Spectral difference analysis:", {
        bass: {
          original: originalBassResponse,
          input: inputBassResponse,
          adjustment: bassDiff,
        },
        mid: {
          original: originalMidResponse,
          input: inputMidResponse,
          adjustment: midDiff,
        },
        high: {
          original: originalHighResponse,
          input: inputHighResponse,
          adjustment: highDiff,
        },
      });

      // STAGE 1: Match spectral characteristics with adaptive EQ based on analysis
      // This uses a multi-band equalizer with adjustments based on spectral analysis
      // Following FFmpeg documentation for proper filter syntax
      const spectralFilter = `aformat=sample_fmts=fltp:sample_rates=${
        originalAnalysis.format.sampleRate
      }:channel_layouts=${channelLayout},
        equalizer=f=32:width_type=q:width=1:gain=${bassDiff * 0.8},
        equalizer=f=64:width_type=q:width=1:gain=${bassDiff * 0.9},
        equalizer=f=125:width_type=q:width=1:gain=${bassDiff},
        equalizer=f=250:width_type=q:width=1:gain=${
          bassDiff * 0.7 + midDiff * 0.3
        },
        equalizer=f=500:width_type=q:width=1:gain=${
          bassDiff * 0.3 + midDiff * 0.7
        },
        equalizer=f=1000:width_type=q:width=1:gain=${midDiff},
        equalizer=f=2000:width_type=q:width=1:gain=${
          midDiff * 0.7 + highDiff * 0.3
        },
        equalizer=f=4000:width_type=q:width=1:gain=${
          midDiff * 0.3 + highDiff * 0.7
        },
        equalizer=f=8000:width_type=q:width=1:gain=${highDiff},
        equalizer=f=16000:width_type=q:width=1:gain=${highDiff * 0.9}`;

      console.log("Applying adaptive spectral matching...");
      await execAsync(
        `ffmpeg -threads 2 -i "${speechEnhancedPath}" -af "${spectralFilter.replace(
          /\s+/g,
          " "
        )}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${
          originalAnalysis.format.channels
        } -y "${spectrumMatchedPath}"`
      );

      // STAGE 2: Match dynamics and compression characteristics
      // Calculate optimal compression parameters based on dynamic range analysis
      const dynamicRange = Math.max(1, Math.min(20, targetRange));
      const originalDynamicRange =
        originalSpectralAnalysis?.frequencyResponse?.dynamicRange ||
        dynamicRange;
      const inputDynamicRange =
        inputSpectralAnalysis?.frequencyResponse?.dynamicRange || dynamicRange;

      // Adjust compression ratio based on the difference in dynamic range
      const dynamicRangeDiff = originalDynamicRange - inputDynamicRange;
      const compressionRatio =
        dynamicRangeDiff > 2
          ? 2.5
          : dynamicRangeDiff > 0
          ? 2
          : dynamicRangeDiff > -2
          ? 1.5
          : 1.2;

      // Adjust threshold based on original audio characteristics
      const threshold =
        originalAnalysis.loudness.integrated < -20
          ? -24
          : originalAnalysis.loudness.integrated < -16
          ? -20
          : originalAnalysis.loudness.integrated < -12
          ? -18
          : -16;

      console.log("Dynamic range adjustment parameters:", {
        originalDynamicRange,
        inputDynamicRange,
        dynamicRangeDiff,
        compressionRatio,
        threshold,
      });

      // Use gentler compression to preserve more of the background audio characteristics
      // We'll use a more conservative approach with the compressor to maintain background presence
      // Note: FFmpeg acompressor ratio must be in range [1-20]
      const dynamicsFilter = `acompressor=threshold=${threshold}dB:ratio=${Math.max(
        1.0,
        compressionRatio * 0.7
      )}:attack=300:release=1500:makeup=1:knee=3,
        acompressor=threshold=${
          threshold - 10
        }dB:ratio=1:attack=300:release=1500:makeup=1.2:knee=2`;

      console.log("Applying adaptive dynamics matching...");
      await execAsync(
        `ffmpeg -threads 2 -i "${spectrumMatchedPath}" -af "${dynamicsFilter.replace(
          /\s+/g,
          " "
        )}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${
          originalAnalysis.format.channels
        } -y "${dynamicsMatchedPath}"`
      );

      // STAGE 3: Final loudness normalization with adjustments to preserve background
      // Using a slightly modified loudnorm filter to maintain more of the background audio presence
      // Increasing the LRA slightly to preserve more dynamic range where background music lives
      const loudnessFilter = `loudnorm=I=${targetLufs}:TP=${targetPeak}:LRA=${Math.min(
        20,
        dynamicRange * 1.2
      )}:print_format=summary:linear=true:dual_mono=true`;

      console.log("Applying final loudness normalization...");
      console.log(
        `Target parameters: LUFS=${targetLufs}, TP=${targetPeak}, LRA=${Math.min(
          20,
          dynamicRange * 1.2
        )}`
      );

      await execAsync(
        `ffmpeg -threads 2 -i "${dynamicsMatchedPath}" -af "${loudnessFilter}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} -y "${outputPath}"`
      );

      // Verify the final output
      await this.fileProcessor.verifyFile(outputPath);

      // Analyze the final output to confirm processing results
      const finalAnalysis = await this.audioAnalyzer.analyzeAudio(outputPath);
      console.log("Final audio characteristics:", {
        duration: finalAnalysis.duration.toFixed(2) + "s",
        loudness: finalAnalysis.loudness.integrated.toFixed(2) + " LUFS",
        peak: finalAnalysis.loudness.truePeak.toFixed(2) + " dB",
        range: finalAnalysis.loudness.range.toFixed(2) + " LU",
      });

      return outputPath;
    } catch (error) {
      console.error("Error in final audio processing:", error);
      throw new Error(`Final audio processing failed: ${error}`);
    }
  }
}
