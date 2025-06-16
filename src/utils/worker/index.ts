import { Worker } from "bullmq";
import { notifyAPI } from "../../services/notifyAPi";
import { redisHost, redisPort, redisUserName, redisPassword } from "../queue";
import type { JobData } from "../types/type";
import { AudioProcessor } from "./audio-processor";
import { updateAudioProcessStatus } from "../../controllers/transcreation.controller";

const worker = new Worker<JobData>(
  "audio-processing",
  async (job) => {
    const audioProcessor = new AudioProcessor();
    await audioProcessor.init();

    try {
      const startTime = Date.now();

      // Validate input data
      if (!job.data.ttsRequests?.length && !job.data.audioUrls?.length) {
        throw new Error("No audio URLs or TTS requests provided");
      }

      if (!job.data.originalAudioUrl) {
        throw new Error("Original audio URL is required");
      }

      let speechFiles: string[] = [];

      // Step 1: Generate speech from text or process audio URLs
      await job.updateProgress(10);
      await job.updateData({
        ...job.data,
        currentOperation: "Generating speech from text",
      });

      if (job.data.ttsRequests?.length) {
        speechFiles = await audioProcessor.processMultipleTTS(
          job.data.transcript,
          job.data.ttsRequests,
          job.data.originalAudioUrl,
          job.data.language
        );
      } else if (job.data.audioUrls?.length) {
        // Process audio URLs - add this method back to AudioProcessor
        speechFiles = await audioProcessor.processAudioUrls(job.data.audioUrls);
      }

      // Step 2: Separate background music from original audio
      await job.updateProgress(40);
      await job.updateData({
        ...job.data,
        currentOperation: "Separating background music",
      });

      const backgroundTrack = await audioProcessor.separateOriginalAudio(
        job.data.originalAudioUrl,
        job.data.transcript
      );

      // Step 3: Combine speech with background music
      await job.updateProgress(70);
      await job.updateData({
        ...job.data,
        currentOperation: "Combining speech with background",
      });

      const combinedAudioPath =
        await audioProcessor.combineAllSpeechWithBackground(
          speechFiles,
          backgroundTrack,
          job.data.transcript
        );

      // Step 4: Enhance and upload final result
      await job.updateProgress(90);
      await job.updateData({
        ...job.data,
        currentOperation: "Enhancing and uploading final audio",
      });

      const finalAudioUrl = await audioProcessor.uploadToStorage(
        combinedAudioPath,
        true, // Enable enhancement
        "high" // Use high quality enhancement
      );

      // Complete
      await job.updateProgress(100);
      await updateAudioProcessStatus(job.data.id, "completed", finalAudioUrl);

      return {
        finalAudioUrl,
        processingTime: Date.now() - startTime,
      };
    } catch (error: any) {
      console.error("Job processing error:", error);
      await updateAudioProcessStatus(job.data.id, "failed");
      throw error;
    } finally {
      await audioProcessor.cleanup();
    }
  },
  {
    connection: {
      host: redisHost,
      port: redisPort,
      username: redisUserName,
      password: redisPassword,
    },
    concurrency: 2,
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 24 * 3600, count: 50 },
  }
);

worker.on("completed", async (job, result) => {
  try {
    await notifyAPI(job);
  } catch (error) {
    console.error(`Error notifying API for job ${job.id}:`, error);
  }
});

worker.on("failed", async (job, error) => {
  console.error(`Job ${job?.id} failed:`, error.message);
  if (job) {
    await updateAudioProcessStatus(job.data.id, "failed");
  }
});

worker.on("error", (error) => {
  console.error("Worker error:", error);
});

export default worker;
