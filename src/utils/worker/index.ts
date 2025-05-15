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

    console.log("Processing job:", job.id, job.data);

    try {
      let ttsConvertedPaths: Array<{path: string; start: number; end: number}> = [];
      let totalSteps = 3;
      let completedSteps = 0;
      const startTime = Date.now();
      let stepTimes: number[] = [];
      let lastStepTime = startTime;

      const recordStepTime = () => {
        const currentTime = Date.now();
        const elapsedTime = currentTime - lastStepTime; // Time for the current step
        stepTimes.push(elapsedTime);
        lastStepTime = currentTime; // Update for the next step

        const averageTimePerStep =
          stepTimes.reduce((a, b) => a + b, 0) / stepTimes.length;
        const remainingSteps = totalSteps - completedSteps;
        const estimatedRemainingTime = averageTimePerStep * remainingSteps;

        job.updateData({
          ...job.data,
          processingDetails: {
            currentStep: completedSteps,
            totalSteps,
            elapsedTime,
            estimatedRemainingTime,
            stepTimes,
            lastStepName: getCurrentStepName(completedSteps),
          },
        });
      };

      if (job.data.ttsRequests?.length) {
        await job.updateProgress(5);
        await job.updateData({
          ...job.data,
          currentOperation: "Generating speech from text",
          startTime,
        });

        ttsConvertedPaths = await audioProcessor.processMultipleTTS(
          job.data.transcript,
          job.data.ttsRequests,
          job.data.originalAudioUrl,
          job.data.language
        );
        totalSteps = job.data.ttsRequests.length + 2;
      } else if (job.data.audioUrls?.length) {
        await job.updateData({
          ...job.data,
          currentOperation: "Processing audio files",
          startTime,
        });
        await job.updateProgress(5);

        ttsConvertedPaths = await audioProcessor.processTTSFiles(
          job.data.audioUrls
        );
        totalSteps = 3;
      } else {
        throw new Error("No audio URLs or TTS requests provided");
      }

      completedSteps++;
      await job.updateProgress(Math.round((completedSteps / totalSteps) * 100));
      recordStepTime();

      // Process background track
      await job.updateData({
        ...job.data,
        currentOperation: "Separating background music",
      });
      const backgroundTrack = await audioProcessor.separateOriginalAudio(
        job.data.originalAudioUrl,
        job.data.transcript
      );

      completedSteps++;
      await job.updateProgress(Math.round((completedSteps / totalSteps) * 100));
      recordStepTime();

      // Combine audio
      await job.updateData({
        ...job.data,
        currentOperation: "Combining speech with background",
      });
      const combinedAudioPath =
        await audioProcessor.combineAllSpeechWithBackground(
          ttsConvertedPaths,
          backgroundTrack
        );

      completedSteps++;
      await job.updateProgress(Math.round((completedSteps / totalSteps) * 100));
      recordStepTime();

      // Upload final result
      await job.updateData({
        ...job.data,
        currentOperation: "Finalizing and uploading",
      });
      const finalAudioUrl = await audioProcessor.uploadToStorage(
        combinedAudioPath
      );

      completedSteps++;
      await job.updateProgress(100);
      recordStepTime();

      await updateAudioProcessStatus(job.data.id, "completed", finalAudioUrl);

      return {
        finalAudioUrl,
        processingTime: Date.now() - startTime,
      };
    } catch (error: any) {
      console.error("Job processing error:", error);

      if (error.code === "ECONNRESET") {
        console.error("Network error occurred. Retrying...");
        // Add retry logic here if applicable
      } else if (
        error.message.includes("No audio URLs or TTS requests provided")
      ) {
        console.error("Invalid job data. Skipping job.");
      }

      throw error; // Rethrow after handling
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
    removeOnComplete: {
      age: 3600,
      count: 1000,
    },
    removeOnFail: {
      age: 24 * 3600,
      count: 100,
    },
  }
);

function getCurrentStepName(step: number): string {
  const stepNames = [
    "Processing audio files",
    "Separating background music",
    "Combining speech with background",
    "Finalizing and uploading",
  ];

  if (step < 0 || step >= stepNames.length) {
    return `Unknown step (${step})`;
  }

  return stepNames[step];
}

worker.on("completed", async (job, result) => {
  console.log(`Job ${job.id} completed with result:`, result);
  try {
    await notifyAPI(job);
  } catch (error) {
    console.error(`Error notifying API for job ${job.id}:`, error);
  }
});

worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed with error:`, error);
});

worker.on("error", (error) => {
  console.error("Worker error:", error);
});

console.log("Worker started");

export default worker;
