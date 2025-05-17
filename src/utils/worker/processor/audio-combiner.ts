import { promisify } from "util";
import { exec } from "child_process";
import path from "path";
import type { FileProcessor } from "./file-processor";
import type { AudioAnalyzer } from "./audio-analyzer";
import type { Transcript } from "../../types/type";
import fs from "fs/promises";

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
    // First analyze all speech files to determine optimal processing parameters
    const speechAnalysisResults = await this.analyzeAllSpeechFiles(speechPaths);
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

      // Create a temporary directory for the combined audio segments
      const outputDir = await this.fileProcessor.createTempDir(
        "combined_segments"
      );

      // Improved approach: Create a complete silent background track first
      const silentBgPath = await this.fileProcessor.createTempPath(
        "silent_bg",
        "wav"
      );

      // Create silent audio with EXACT same duration, sample rate and channels
      await execAsync(
        `ffmpeg -threads 2 -f lavfi -i anullsrc=r=${
          bgAnalysis.format.sampleRate
        }:cl=${bgAnalysis.format.channels === 1 ? "mono" : "stereo"} -t ${
          bgAnalysis.duration
        } -c:a pcm_s24le "${silentBgPath}"`
      );

      // Process each speech segment and prepare filter complex
      const speechSegmentPaths = [];

      // First, create processed speech segments with consistent quality
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

        // Process each speech file to ensure consistent quality
        const processedSpeechPath = await this.processSpeechForConsistency(
          speechPaths[i],
          outputDir,
          i,
          bgAnalysis
        );

        speechSegmentPaths.push({
          path: processedSpeechPath,
          start: segment.start,
          end: segment.end,
          originalIndex: i, // Store the original index to maintain reference to the correct speech file
        });
      }

      // Sort speech segments by start time to ensure chronological positioning
      speechSegmentPaths.sort((a, b) => a.start - b.start);

      // Log the sorted segments to verify chronological ordering
      console.log(
        "Speech segments sorted chronologically:",
        speechSegmentPaths.map((segment) => ({
          start: segment.start,
          end: segment.end,
          originalIndex: segment.originalIndex,
        }))
      );

      // Now build a filter complex to precisely position each speech segment
      // We'll use the silent background as base and overlay each speech at exact position
      let filterComplex = "";

      // Add each speech input to filter with proper delay based on start time
      // Since we've sorted the segments chronologically, they will be positioned correctly by timestamp
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];
        const inputIndex = i + 1; // +1 because silent background is input 0

        // Add each speech input to filter - with volume already boosted and positioned by timestamp
        filterComplex += `[${inputIndex}:a]adelay=${Math.round(
          segment.start * 1000
        )}|${Math.round(segment.start * 1000)}[speech${i}];`;
      }

      // Build mix chain
      if (speechSegmentPaths.length > 0) {
        filterComplex += `[0:a]`;
        for (let i = 0; i < speechSegmentPaths.length; i++) {
          filterComplex += `[speech${i}]`;
        }
        // Mix all speech segments with silent background
        filterComplex += `amix=inputs=${
          speechSegmentPaths.length + 1
        }:duration=first[speechmix];`;
      }

      // Create a more sophisticated background ducking effect based on speech segments
      // This creates a dynamic volume adjustment that reduces background when speech is present
      console.log("Implementing dynamic background ducking based on speech segments...");
      
      // Calculate ducking parameters based on speech analysis
      const hasMostlyQuietSpeech = speechAnalysisResults.filter(r => r.analysis !== null && r.characteristics?.isQuiet).length > speechSegmentPaths.length / 2;
      const backgroundVolume = hasMostlyQuietSpeech ? 0.25 : 0.3; // More reduction for quiet speech
      
      // Apply volume reduction to background
      filterComplex += `[${speechSegmentPaths.length + 1}:a]volume=${backgroundVolume}[bg];`;

      // Final mix of speech and background - with speech prominence
      filterComplex += `[speechmix][bg]amix=inputs=2:duration=first[out]`;

      // Create input arguments string for ffmpeg
      let inputArgs = `-threads 2 -i "${silentBgPath}" `;

      // Add all processed speech segments IN THE SORTED ORDER
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        inputArgs += `-i "${speechSegmentPaths[i].path}" `;
      }

      // Add original background track
      inputArgs += `-i "${backgroundPath}" `;

      // Final output path
      const finalPath = await this.fileProcessor.createTempPath(
        "final_audio",
        "wav"
      );

      // Execute ffmpeg with single filter complex that preserves exact duration
      await execAsync(
        `ffmpeg ${inputArgs} -filter_complex "${filterComplex.replace(
          /\s+/g,
          " "
        )}" -map "[out]" -c:a pcm_s24le -ar ${
          bgAnalysis.format.sampleRate
        } -ac ${bgAnalysis.format.channels} "${finalPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(finalPath);

      // Verify final length matches original background
      const finalAnalysis = await this.audioAnalyzer.analyzeAudio(finalPath);
      console.log("Final audio validation:", {
        originalDuration: bgAnalysis.duration.toFixed(3) + "s",
        finalDuration: finalAnalysis.duration.toFixed(3) + "s",
        difference:
          Math.abs(bgAnalysis.duration - finalAnalysis.duration).toFixed(3) +
          "s",
      });

      // Apply final spectral matching to ensure consistent quality for all segments
      // Pass speech analysis results for adaptive processing
      const processedPath = await this.applyConsistentFinalProcessing(
        finalPath,
        bgAnalysis,
        speechAnalysisResults
      );

      return processedPath;
    } catch (error) {
      console.error("Error combining audio files:", error);
      throw error;
    }
  }

  /**
   * Analyzes all speech files to determine optimal processing parameters
   * This enables adaptive processing based on the characteristics of each file
   */
  private async analyzeAllSpeechFiles(speechPaths: string[]): Promise<any[]> {
    console.log("Analyzing all speech files for adaptive processing...");
    const analysisResults = [];
    
    // Analyze each speech file
    for (let i = 0; i < speechPaths.length; i++) {
      try {
        const analysis = await this.audioAnalyzer.analyzeAudio(speechPaths[i]);
        analysisResults.push({
          index: i,
          path: speechPaths[i],
          analysis: analysis,
          // Determine speech characteristics
          characteristics: {
            // Is the speech too quiet?
            isQuiet: analysis.loudness.integrated < -24,
            // Is the speech too loud?
            isLoud: analysis.loudness.integrated > -16,
            // Does the speech have wide dynamic range?
            hasWideDynamicRange: analysis.loudness.range > 10,
            // Is the speech lacking bass?
            lacksBass: true, // Default assumption for speech
            // Is the speech lacking clarity?
            lacksClarity: true, // Default assumption for speech
          }
        });
        
        console.log(`Speech file ${i} analysis:`, {
          loudness: analysis.loudness.integrated.toFixed(2) + " LUFS",
          peak: analysis.loudness.truePeak.toFixed(2) + " dB",
          range: analysis.loudness.range.toFixed(2) + " LU",
          duration: analysis.duration.toFixed(2) + "s"
        });
      } catch (error) {
        console.error(`Error analyzing speech file ${i}:`, error);
        // Add a placeholder with default values
        analysisResults.push({
          index: i,
          path: speechPaths[i],
          analysis: null,
          characteristics: {
            isQuiet: true,
            isLoud: false,
            hasWideDynamicRange: true,
            lacksBass: true,
            lacksClarity: true
          }
        });
      }
    }
    
    // Calculate overall statistics for adaptive processing
    const avgLoudness = analysisResults
      .filter(r => r.analysis !== null)
      .reduce((sum, r) => sum + r.analysis!.loudness.integrated, 0) / 
      analysisResults.filter(r => r.analysis !== null).length;
    
    console.log("Speech files analysis complete. Average loudness:", avgLoudness.toFixed(2) + " LUFS");
    return analysisResults;
  }

  private async processSpeechForConsistency(
    speechPath: string,
    outputDir: string,
    index: number,
    bgAnalysis: any
  ): Promise<string> {
    try {
      console.log(`Processing speech file ${index} (enhancing speech quality)...`);

      // First analyze the speech file to determine its characteristics
      const speechAnalysis = await this.audioAnalyzer.analyzeAudio(speechPath);
      console.log(`Speech file ${index} analysis:`, {
        loudness: speechAnalysis.loudness.integrated.toFixed(2) + " LUFS",
        peak: speechAnalysis.loudness.truePeak.toFixed(2) + " dB",
        duration: speechAnalysis.duration.toFixed(2) + "s"
      });

      // Create a processed speech file path
      const processedPath = path.join(
        outputDir,
        `processed_speech_${index}.wav`
      );

      // Apply format conversion and advanced audio processing
      const channelLayout =
        bgAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Determine adaptive processing parameters based on speech characteristics
      // Customize target loudness based on content
      const targetLoudness = speechAnalysis.loudness.integrated < -24 ? -16 : -18;
      const loudnessDiff = targetLoudness - speechAnalysis.loudness.integrated;
      const volumeAdjust = Math.max(0.5, Math.min(4.0, Math.pow(10, loudnessDiff / 20)));
      
      // Determine if we need stronger compression based on dynamic range
      const needsStrongerCompression = speechAnalysis.loudness.range > 10;
      
      // Determine if we need more bass enhancement based on spectral characteristics
      const needsMoreBass = speechAnalysis.loudness.integrated < -20;
      
      // Determine if we need more presence based on content
      const needsMorePresence = speechAnalysis.loudness.integrated < -22;
      
      // Build comprehensive audio enhancement filter chain with adaptive parameters:
      // 1. Normalize speech to consistent level
      // 2. Apply multi-band compression for dynamics control
      // 3. Enhance bass frequencies
      // 4. Add presence boost for clarity
      // 5. Final volume adjustment
      const enhancementFilter = [
        // Format conversion
        `aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
        
        // 1. Loudness normalization
        `loudnorm=I=${targetLoudness}:TP=-1.5:LRA=${needsStrongerCompression ? 5 : 7}`,
        
        // 2. Multi-band compression for dynamics control
        `compand=attacks=${needsStrongerCompression ? 0.005 : 0.01}:decays=${needsStrongerCompression ? 0.1 : 0.2}:points=-80/-80|-50/-35|-30/-20|-20/-10|-5/-5|0/-2:soft-knee=${needsStrongerCompression ? 8 : 6}`,
        
        // 3. Bass enhancement (adaptive low frequency boost)
        `equalizer=f=120:width_type=h:width=100:g=${needsMoreBass ? 4 : 3}`,
        
        // 4. Presence boost for clarity (adaptive speech frequencies enhancement)
        `equalizer=f=2500:width_type=h:width=1000:g=${needsMorePresence ? 3.5 : 2.5}`,
        
        // 5. Final volume adjustment
        `volume=${volumeAdjust.toFixed(2)}`
      ].join(',');

      // Process the speech file with comprehensive enhancements
      await execAsync(
        `ffmpeg -threads 2 -i "${speechPath}" -af "${enhancementFilter}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${processedPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(processedPath);
      
      // Log the enhancement applied
      console.log(`Enhanced speech file ${index} with adaptive processing:`, {
        targetLoudness: `${targetLoudness} LUFS`,
        volumeAdjust: volumeAdjust.toFixed(2),
        strongerCompression: needsStrongerCompression,
        moreBass: needsMoreBass,
        morePresence: needsMorePresence
      });

      return processedPath;
    } catch (error) {
      console.error(`Error processing speech file ${index}:`, error);
      throw error;
    }
  }

  private async applyConsistentFinalProcessing(
    inputPath: string,
    originalAnalysis: any,
    speechAnalysisResults?: any[]
  ): Promise<string> {
    try {
      console.log("Applying final processing with advanced audio enhancements...");

      // Create an output path
      const outputPath = await this.fileProcessor.createTempPath(
        "final_processed",
        "wav"
      );

      // Extract basic format parameters
      const channelLayout =
        originalAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Analyze the final mixed audio to determine optimal processing parameters
      const mixedAnalysis = await this.audioAnalyzer.analyzeAudio(inputPath);
      console.log("Mixed audio analysis before final processing:", {
        loudness: mixedAnalysis.loudness.integrated.toFixed(2) + " LUFS",
        peak: mixedAnalysis.loudness.truePeak.toFixed(2) + " dB",
        range: mixedAnalysis.loudness.range.toFixed(2) + " LU"
      });

      // Determine adaptive processing parameters based on speech analysis results
      let adaptiveParams = {
        // Default parameters
        duckingThreshold: -30,
        duckingAttack: 0.05,
        duckingRelease: 0.3,
        clarityBoost: 2.5,
        targetLoudness: -14,
        dynamicRange: 11
      };
      
      // If we have speech analysis results, adjust parameters adaptively
      if (speechAnalysisResults && speechAnalysisResults.length > 0) {
        // Calculate average characteristics
        const quietSpeechCount = speechAnalysisResults.filter(r => r.analysis !== null && r.characteristics?.isQuiet).length;
        const loudSpeechCount = speechAnalysisResults.filter(r => r.analysis !== null && r.characteristics?.isLoud).length;
        const wideDynamicRangeCount = speechAnalysisResults.filter(r => r.analysis !== null && r.characteristics?.hasWideDynamicRange).length;
        
        // Adjust ducking threshold based on speech loudness
        if (quietSpeechCount > speechAnalysisResults.length / 2) {
          // More aggressive ducking for quiet speech
          adaptiveParams.duckingThreshold = -35;
          adaptiveParams.duckingRelease = 0.4; // Slower release
          adaptiveParams.clarityBoost = 3.0; // More clarity boost
        } else if (loudSpeechCount > speechAnalysisResults.length / 2) {
          // Less aggressive ducking for loud speech
          adaptiveParams.duckingThreshold = -25;
          adaptiveParams.duckingAttack = 0.03; // Faster attack
        }
        
        // Adjust dynamic range based on speech characteristics
        if (wideDynamicRangeCount > speechAnalysisResults.length / 2) {
          // More compression for wide dynamic range speech
          adaptiveParams.dynamicRange = 9;
        }
        
        console.log("Using adaptive processing parameters:", adaptiveParams);
      }
      
      // Build comprehensive final processing filter chain with adaptive parameters:
      // 1. Format conversion
      // 2. Dynamic background ducking (sidechain-like effect using crossfade)
      // 3. Speech clarity enhancement with high-shelf filter
      // 4. Final loudness normalization and limiting
      const finalFilter = [
        // 1. Format conversion
        `aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout}`,
        
        // 2. Dynamic background ducking (using advanced compressor as ducking)
        // This simulates sidechain compression by detecting loud parts (speech) and reducing volume temporarily
        `compand=attacks=${adaptiveParams.duckingAttack}:decays=${adaptiveParams.duckingRelease}:points=-70/-70|-60/-60|-40/-30|-30/-10|-24/-6|-12/-3|-6/-3|0/-3:soft-knee=6:threshold=${adaptiveParams.duckingThreshold}:gain=0`,
        
        // 3. Speech clarity enhancement with high-shelf filter
        // Boost high frequencies for better speech intelligibility
        `highshelf=f=7000:width_type=h:width=0.5:g=${adaptiveParams.clarityBoost}`,
        
        // 4. Final loudness normalization and limiting
        // Target -14 LUFS for final output with true peak limiting to prevent clipping
        `loudnorm=I=${adaptiveParams.targetLoudness}:TP=-1:LRA=${adaptiveParams.dynamicRange}`,
        
        // 5. Final limiter to prevent any clipping
        `alimiter=level_in=1:level_out=1:limit=1:attack=5:release=50:level=disabled`
      ].join(',');

      // Process the final audio with comprehensive enhancements
      await execAsync(
        `ffmpeg -threads 2 -i "${inputPath}" -af "${finalFilter}" -c:a pcm_s24le -ar ${originalAnalysis.format.sampleRate} -ac ${originalAnalysis.format.channels} "${outputPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(outputPath);

      // Verify final length matches original background
      const finalAnalysis = await this.audioAnalyzer.analyzeAudio(outputPath);
      console.log("Final audio validation:", {
        originalDuration: originalAnalysis.duration.toFixed(3) + "s",
        finalDuration: finalAnalysis.duration.toFixed(3) + "s",
        difference:
          Math.abs(originalAnalysis.duration - finalAnalysis.duration).toFixed(
            3
          ) + "s",
        finalLoudness: finalAnalysis.loudness.integrated.toFixed(2) + " LUFS",
        finalPeak: finalAnalysis.loudness.truePeak.toFixed(2) + " dB"
      });

      return outputPath;
    } catch (error) {
      console.error("Error applying final processing:", error);
      throw error;
    }
  }
}
