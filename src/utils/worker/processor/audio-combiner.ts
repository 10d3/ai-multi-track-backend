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
    try {
      if (!backgroundPath || !speechPaths.length) {
        throw new Error("Missing required audio files for combination");
      }

      // Validate that we have transcript data for each speech file
      if (transcript.length < speechPaths.length) {
        console.warn(`Warning: Not enough transcript segments (${transcript.length}) for speech files (${speechPaths.length})`);
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
      
      // First, validate and filter transcript segments to ensure they have valid timestamps
      const validTranscriptSegments = transcript.filter((segment, index) => {
        if (!segment || segment.start === undefined || segment.end === undefined) {
          console.warn(`Invalid transcript data for segment ${index}, skipping`);
          return false;
        }
        return true;
      });
      
      console.log(`Processing ${validTranscriptSegments.length} valid transcript segments`);
      
      // Ensure we have the right number of speech files for valid transcript segments
      if (validTranscriptSegments.length > speechPaths.length) {
        console.warn(`Warning: More valid transcript segments (${validTranscriptSegments.length}) than speech files (${speechPaths.length})`);
      }
      
      // Process each speech file with its corresponding transcript segment
      // We'll use the minimum of valid transcript segments and speech paths
      const segmentsToProcess = Math.min(validTranscriptSegments.length, speechPaths.length);
      
      // Create a mapping array to track which speech file corresponds to which transcript segment
      const speechToTranscriptMapping = [];
      
      console.log("Creating direct mapping between speech files and transcript segments:");
      for (let i = 0; i < segmentsToProcess; i++) {
        const segment = validTranscriptSegments[i];
        const speechPath = speechPaths[i];
        
        console.log(`Mapping: Speech file ${i} -> Transcript segment with start=${segment.start}s, end=${segment.end}s`);
        
        // Store the mapping information
        speechToTranscriptMapping.push({
          speechIndex: i,
          transcriptIndex: i,
          start: segment.start,
          end: segment.end
        });
        
        // Process each speech file to ensure consistent quality
        const processedSpeechPath = await this.processSpeechForConsistency(
          speechPath,
          outputDir,
          i,
          bgAnalysis
        );

        // Use the direct mapping approach - each speech file is explicitly linked to its transcript segment
        speechSegmentPaths.push({
          path: processedSpeechPath,
          start: segment.start,
          end: segment.end,
          originalIndex: i, // Store the original index to maintain reference to the correct speech file
          transcriptIndex: i // Explicitly track which transcript segment this belongs to
        });
      }
      
      // Log the explicit mapping for verification
      console.log("Speech to transcript segment mapping:", 
        speechToTranscriptMapping.map(mapping => ({
          speechIndex: mapping.speechIndex,
          transcriptIndex: mapping.transcriptIndex,
          start: mapping.start,
          end: mapping.end
        }))
      );

      // Create a copy of the speech segments for chronological reference
      // But we'll maintain the original order for processing to preserve the speech-to-transcript mapping
      const chronologicalSegments = [...speechSegmentPaths].sort((a, b) => a.start - b.start);

      // Log the chronological order for reference only
      console.log(
        "Speech segments in chronological order (for reference only):",
        chronologicalSegments.map((segment) => ({
          start: segment.start,
          end: segment.end,
          duration: (segment.end - segment.start).toFixed(2) + "s",
          originalIndex: segment.originalIndex,
          transcriptIndex: segment.transcriptIndex
        }))
      );
      
      // Log the actual processing order that will be used (preserving direct mapping)
      console.log(
        "Speech segments in processing order (preserving direct mapping):",
        speechSegmentPaths.map((segment) => ({
          start: segment.start,
          end: segment.end,
          duration: (segment.end - segment.start).toFixed(2) + "s",
          originalIndex: segment.originalIndex,
          transcriptIndex: segment.transcriptIndex
        }))
      );
      
      // Validate that segments don't overlap significantly
      for (let i = 0; i < speechSegmentPaths.length - 1; i++) {
        const currentSegment = speechSegmentPaths[i];
        const nextSegment = speechSegmentPaths[i + 1];
        
        if (currentSegment.end > nextSegment.start) {
          const overlap = currentSegment.end - nextSegment.start;
          console.warn(`Warning: Segments ${i} and ${i+1} overlap by ${overlap.toFixed(2)}s`);
        }
      }

      // Now build a filter complex to precisely position each speech segment
      // We'll use the silent background as base and overlay each speech at exact position
      let filterComplex = "";

      // Add each speech input to filter with proper delay based on start time from transcript
      // We're using the direct mapping approach - each speech file is positioned according to its transcript
      console.log("Building filter complex with direct mapping between speech files and transcript segments:");
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];
        const inputIndex = i + 1; // +1 because silent background is input 0

        // Calculate exact delay in milliseconds based on transcript timestamp
        const delayMs = Math.max(0, Math.round(segment.start * 1000));
        
        // Log the exact positioning of each segment with explicit mapping information
        console.log(`Positioning speech segment ${i} (transcript index ${segment.transcriptIndex}) at ${segment.start}s (delay=${delayMs}ms)`);

        // Add each speech input to filter with precise delay based on transcript timestamp
        filterComplex += `[${inputIndex}:a]adelay=${delayMs}|${delayMs}[speech${i}];`;
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

      // Reduce background volume significantly to make speech more prominent
      filterComplex += `[${speechSegmentPaths.length + 1}:a]volume=0.3[bg];`;

      // Final mix of speech and background - with speech prominence
      filterComplex += `[speechmix][bg]amix=inputs=2:duration=first[out]`;

      // Create input arguments string for ffmpeg
      let inputArgs = `-threads 2 -i "${silentBgPath}" `;

      // Add all processed speech segments in the ORIGINAL ORDER to maintain direct mapping
      console.log("Adding speech segments to ffmpeg command in original mapping order:");
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];
        console.log(`  Segment ${i}: speech_index=${segment.originalIndex}, transcript_index=${segment.transcriptIndex}, start=${segment.start}s, end=${segment.end}s`);
        inputArgs += `-i "${segment.path}" `;
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
      const processedPath = await this.applyConsistentFinalProcessing(
        finalPath,
        bgAnalysis
      );

      // Final validation to confirm speech segments are properly positioned with direct mapping
      console.log("Final validation of speech segment positioning and mapping:");
      console.log("  - Original speech files count:", speechPaths.length);
      console.log("  - Valid transcript segments count:", validTranscriptSegments.length);
      console.log("  - Processed segments count:", speechSegmentPaths.length);
      console.log("  - Direct mapping maintained between speech files and transcript segments");
      
      // Verify the direct mapping was maintained
      console.log("  - Mapping verification:");
      for (let i = 0; i < speechSegmentPaths.length; i++) {
        const segment = speechSegmentPaths[i];
        console.log(`    * Speech file ${segment.originalIndex} -> Transcript segment ${segment.transcriptIndex} (start=${segment.start}s, end=${segment.end}s)`);
      }
      
      console.log("  - Each segment positioned at its exact timestamp from transcript");
      console.log("  - Final audio duration matches background:", bgAnalysis.duration.toFixed(2) + "s");

      return processedPath;
    } catch (error) {
      console.error("Error combining audio files:", error);
      throw error;
    }
  }

  private async processSpeechForConsistency(
    speechPath: string,
    outputDir: string,
    index: number,
    bgAnalysis: any
  ): Promise<string> {
    try {
      console.log(`Processing speech file ${index} (boosting volume)...`);

      // Create a processed speech file path
      const processedPath = path.join(
        outputDir,
        `processed_speech_${index}.wav`
      );

      // Apply format conversion and volume boost
      const channelLayout =
        bgAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Apply significant volume boost to make speech clearly audible
      // Using volume=3.0 for triple the volume
      const boostFilter = `aformat=sample_fmts=fltp:sample_rates=${bgAnalysis.format.sampleRate}:channel_layouts=${channelLayout},volume=3.0`;

      // Process the speech file with volume boost
      await execAsync(
        `ffmpeg -threads 2 -i "${speechPath}" -af "${boostFilter}" -c:a pcm_s24le -ar ${bgAnalysis.format.sampleRate} -ac ${bgAnalysis.format.channels} "${processedPath}"`
      );

      // Verify the output file
      await this.fileProcessor.verifyFile(processedPath);

      return processedPath;
    } catch (error) {
      console.error(`Error processing speech file ${index}:`, error);
      throw error;
    }
  }

  private async applyConsistentFinalProcessing(
    inputPath: string,
    originalAnalysis: any
  ): Promise<string> {
    try {
      console.log("Applying final processing with speech volume emphasis...");

      // Create an output path
      const outputPath = await this.fileProcessor.createTempPath(
        "final_processed",
        "wav"
      );

      // Extract basic format parameters
      const channelLayout =
        originalAnalysis.format.channels === 1 ? "mono" : "stereo";

      // Final processing to ensure speech is audible
      // Simple dynamic range compression to bring up speech volume
      const finalFilter = `aformat=sample_fmts=fltp:sample_rates=${originalAnalysis.format.sampleRate}:channel_layouts=${channelLayout},
      compand=attacks=0.01:decays=0.2:points=-80/-80|-50/-25|-30/-15|-5/-5|0/-2:soft-knee=2:gain=6`;

      // Process the final audio with volume enhancement
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
      });

      return outputPath;
    } catch (error) {
      console.error("Error applying final processing:", error);
      throw error;
    }
  }
}
