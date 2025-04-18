// server-sent-events.ts (renamed from websocket-server.ts)

import http from "http";
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { audioProcessingQueue, eventAudioProcessing } from "./queue";

dotenv.config();

const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const server = http.createServer(app);

// Store active SSE connections
const connections = new Map<string, express.Response>();

// SSE endpoint for job updates
app.get("/events/:jobId", (req, res) => {
  const jobId = req.params.jobId;

  // Set headers for SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send initial connection confirmation
  res.write(
    `data: ${JSON.stringify({
      type: "subscription_confirmed",
      jobId: jobId,
    })}\n\n`
  );

  // Store the connection
  connections.set(jobId, res);

  // Send initial job status
  sendJobUpdate(jobId);

  // Handle client disconnect
  req.on("close", () => {
    connections.delete(jobId);
    console.log(`Client unsubscribed from job ${jobId}`);
  });
});

async function sendJobUpdate(jobId: string) {
  try {
    const job = await audioProcessingQueue.getJob(jobId);

    if (!job) {
      console.log(`No job found for id ${jobId}`);
      return;
    }

    const state = await job.getState();
    const progress = job.progress || 0;
    const remainingTime =
      job.opts.delay && job.timestamp
        ? Math.max(0, job.timestamp + job.opts.delay - Date.now())
        : 0;

    const { transcript, ...jobData } = job.data;

    let result = null;
    let error = null;

    // Enhanced processing stage information
    let processingStage = "Initializing";
    if (progress > 0 && progress <= 20) {
      processingStage = "Generating speech from text";
    } else if (progress > 20 && progress <= 50) {
      processingStage = "Separating background music";
    } else if (progress > 50 && progress <= 80) {
      processingStage = "Combining speech with background";
    } else if (progress > 80 && progress < 100) {
      processingStage = "Finalizing and uploading";
    } else if (progress === 100) {
      processingStage = "Complete";
    }

    // Estimated time calculation based on progress
    const estimatedTimeRemaining =
      progress > 0 && progress < 100
        ? Math.round((100 - progress) * 1.5) // rough estimate: 1.5 seconds per percentage point
        : 0;

    if (state === "completed") {
      result = job.returnvalue;
      processingStage = "Complete";
    } else if (state === "failed") {
      error = job.failedReason;
      processingStage = "Failed";
    }

    const title =
      typeof transcript === "string"
        ? transcript.split(" ").slice(0, 5).join(" ")
        : "";

    const res = connections.get(jobId);
    if (res) {
      // Send the update as an SSE event with enhanced information
      res.write(
        `data: ${JSON.stringify({
          jobId,
          state,
          progress,
          processingStage,
          estimatedTimeRemaining,
          remainingTime,
          result,
          error,
          jobData,
          title,
          // Add timestamps for frontend to calculate elapsed time
          timestamp: Date.now(),
          startedAt: job.timestamp,
        })}\n\n`
      );

      // If job is completed or failed, close the connection
      if (state === "completed" || state === "failed") {
        setTimeout(() => {
          if (connections.has(jobId)) {
            connections.delete(jobId);
            res.end();
          }
        }, 1000); // Give client time to process the final update
      }
    } else {
      console.log(`No open connection found for job ${jobId}`);
    }
  } catch (error) {
    console.error("Error sending job update:", error);
  }
}

// Listen for job events
eventAudioProcessing.on("completed", (jobId) => {
  console.log(`Job completed event received for job ID: ${jobId.jobId}`);
  sendJobUpdate(jobId.jobId);
});

eventAudioProcessing.on("failed", (jobId) => {
  console.log(`Job failed event received for job ID: ${jobId.jobId}`);
  sendJobUpdate(jobId.jobId);
});

eventAudioProcessing.on("progress", (jobId) => {
  console.log(`Job progress event received for job ID: ${jobId.jobId}`);
  sendJobUpdate(jobId.jobId);
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

const PORT = process.env.WEBSOCKET_PORT || 3001;
server.listen(PORT, () => {
  console.log(`SSE server running on port ${PORT}`);
});
