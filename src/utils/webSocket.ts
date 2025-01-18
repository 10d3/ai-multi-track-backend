// websocket-server.ts

import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import express from "express";
import dotenv from "dotenv";
import { audioProcessingQueue, eventAudioProcessing } from "./queue";

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss: WebSocketServer = new WebSocket.Server({ server });

interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  jobId?: string;
}

const connections = new Map<string, ExtendedWebSocket>();
// const eventAudioProcessing = new QueueEvents("audio-processing");

function heartbeat(this: any) {
  this.isAlive = true;
}
let jobId
wss.on("connection", (ws: ExtendedWebSocket) => {
  const extWs = ws as ExtendedWebSocket;
  extWs.isAlive = true;

  extWs.on("pong", heartbeat);

  extWs.on("message", (message: string) => {
    try {
      const data = JSON.parse(message);
      if (data.type === "subscribe" && data.jobId) {
        extWs.jobId = data.jobId;
        jobId = data.jobId
        connections.set(data.jobId, extWs);
        // console.log(`Client subscribed to job ${data.jobId}`);

        // Send initial confirmation
        extWs.send(
          JSON.stringify({
            type: "subscription_confirmed",
            jobId: data.jobId,
          })
        );
      }
    } catch (error) {
      console.error("Error processing message:", error);
    }
  });

  extWs.on("close", () => {
    if (extWs.jobId) {
      connections.delete(extWs.jobId);
      // console.log(`Client unsubscribed from job ${extWs.jobId}`);
    }
  });

  extWs.on("error", (error) => {
    console.error("WebSocket connection error:", error);
  });
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const extWs = ws as ExtendedWebSocket;
    if (extWs.isAlive === false) {
      // console.log("Closing inactive WebSocket connection.");
      extWs.close(1000, "Inactivity timeout");
    }

    extWs.isAlive = false;
    extWs.ping();
  });
}, 30000);

wss.on("error", (error) => {
  console.error("WebSocket server error:", error);
});

wss.on("close", () => {
  clearInterval(interval);
  // console.log("WebSocket server closed.");
});

async function sendJobUpdate(jobId: string) {
  // console.log(jobId);
  try {
    const job = await audioProcessingQueue.getJob(jobId);

    // console.log(`Sending update for job ${jobId}`);
    // console.log(job);

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

    if (state === "completed") {
      result = job.returnvalue;
    } else if (state === "failed") {
      error = job.failedReason;
    }

    const title =
      typeof transcript === "string"
        ? transcript.split(" ").slice(0, 5).join(" ")
        : "";

    const ws = connections.get(jobId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          jobId,
          state,
          progress,
          remainingTime,
          result,
          error,
          jobData,
          title,
        })
      );
    } else {
      console.log(`No open connection found for job ${jobId}`);
    }
  } catch (error) {
    console.error("Error sending job update:", error);
  }
}

// Listen for job events using QueueEvents
eventAudioProcessing.on("completed", (jobId) => {
  console.log(`Job completed event received for job ID: ${jobId}`);
  sendJobUpdate(jobId.jobId);
});

eventAudioProcessing.on("failed", (jobId) => {
  console.log(`Job failed event received for job ID: ${ jobId}`);
  sendJobUpdate(jobId.jobId);
});

eventAudioProcessing.on("progress", (jobId) => {
  console.log(`Job progress event received for job ID: ${jobId}`);
  sendJobUpdate(jobId.jobId);
});

const PORT = process.env.WEBSOCKET_PORT || 3001;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});