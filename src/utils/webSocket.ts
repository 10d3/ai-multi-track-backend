// enhanced-server-sent-events.ts

import http from "http";
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { audioProcessingQueue, eventAudioProcessing } from "./queue";
import type { JobProgress } from "bullmq";

dotenv.config();

const app = express();
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const server = http.createServer(app);

// Enhanced connection tracking
interface SSEConnection {
  response: express.Response;
  jobId: string;
  clientIp: string;
  connectedAt: number;
  lastHeartbeat: number;
  isAlive: boolean;
}

const connections = new Map<string, SSEConnection>();
const jobSubscribers = new Map<string, Set<string>>(); // jobId -> Set of connectionIds

// Configuration
const CONFIG = {
  HEARTBEAT_INTERVAL: 30000, // 30 seconds
  CONNECTION_TIMEOUT: 300000, // 5 minutes
  MAX_CONNECTIONS_PER_IP: 10,
  CLEANUP_INTERVAL: 60000, // 1 minute
  RETRY_DELAY: 3000, // 3 seconds for client retry
};

// Utility functions
const generateConnectionId = () => `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const getClientIp = (req: express.Request): string => {
  return req.ip || 
         req.socket.remoteAddress || 
         req.headers['x-forwarded-for']?.toString().split(',')[0] ||
         'unknown';
};

const countConnectionsByIp = (clientIp: string): number => {
  return Array.from(connections.values()).filter(conn => conn.clientIp === clientIp).length;
};

const sendSSEMessage = (connection: SSEConnection, data: any, event?: string) => {
  try {
    if (!connection.isAlive) return false;

    let message = '';
    if (event) {
      message += `event: ${event}\n`;
    }
    message += `data: ${JSON.stringify(data)}\n`;
    message += `retry: ${CONFIG.RETRY_DELAY}\n\n`;

    connection.response.write(message);
    connection.lastHeartbeat = Date.now();
    return true;
  } catch (error) {
    console.error(`[SSE] Error sending message to connection:`, error);
    markConnectionDead(connection);
    return false;
  }
};

const markConnectionDead = (connection: SSEConnection) => {
  connection.isAlive = false;
  removeConnection(connection);
};

const removeConnection = (connection: SSEConnection) => {
  const connectionId = Array.from(connections.entries())
    .find(([_, conn]) => conn === connection)?.[0];
  
  if (connectionId) {
    connections.delete(connectionId);
    
    // Remove from job subscribers
    const subscribers = jobSubscribers.get(connection.jobId);
    if (subscribers) {
      subscribers.delete(connectionId);
      if (subscribers.size === 0) {
        jobSubscribers.delete(connection.jobId);
      }
    }
    
    console.log(`[SSE] Connection removed. Active: ${connections.size}, Job ${connection.jobId} subscribers: ${subscribers?.size || 0}`);
  }
};

// Add these type definitions after the imports
interface CompletedJobData {
  jobId: string;
  returnvalue: string;
  prev?: string;
}

interface FailedJobData {
  jobId: string;
  failedReason: string;
  prev?: string;
}

interface ProgressJobData {
  jobId: string;
  data: JobProgress;
}

interface UpdatePayload {
  jobId: string;
  state: any;
  progress: any;
  processingStage: string;
  estimatedTimeRemaining: number;
  timestamp: number;
  metadata: {
    createdAt: any;
    processedAt: any;
    attemptsMade: any;
    maxAttempts: any;
  };
  title: string;
  result?: string;
  error?: string;
}

// Enhanced SSE endpoint
app.get("/events/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const clientIp = getClientIp(req);
  const connectionId = generateConnectionId();
  const now = Date.now();

  console.log(`[SSE] New connection request:`, {
    connectionId,
    jobId,
    clientIp,
    timestamp: new Date().toISOString(),
    userAgent: req.headers['user-agent']
  });

  // Rate limiting check
  if (countConnectionsByIp(clientIp) >= CONFIG.MAX_CONNECTIONS_PER_IP) {
    console.warn(`[SSE] Rate limit exceeded for IP ${clientIp}`);
    res.status(429).json({ error: "Too many connections from this IP" });
    return;
  }

  // Input validation
  if (!jobId || jobId.length > 100) {
    res.status(400).json({ error: "Invalid job ID" });
    return;
  }

  // Set enhanced SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  });

  // Create connection object
  const connection: SSEConnection = {
    response: res,
    jobId,
    clientIp,
    connectedAt: now,
    lastHeartbeat: now,
    isAlive: true,
  };

  // Store connection
  connections.set(connectionId, connection);
  
  // Add to job subscribers
  if (!jobSubscribers.has(jobId)) {
    jobSubscribers.set(jobId, new Set());
  }
  jobSubscribers.get(jobId)!.add(connectionId);

  console.log(`[SSE] Connection established. Total: ${connections.size}, Job ${jobId} subscribers: ${jobSubscribers.get(jobId)!.size}`);

  // Send initial connection confirmation
  sendSSEMessage(connection, {
    type: "connection_established",
    connectionId,
    jobId,
    timestamp: now,
    serverTime: new Date().toISOString(),
  }, "connected");

  // Send initial job status
  sendJobUpdate(jobId);

  // Handle client disconnect
  req.on("close", () => {
    console.log(`[SSE] Client disconnected: ${connectionId}`);
    markConnectionDead(connection);
  });

  // Handle client errors
  req.on("error", (error) => {
    console.error(`[SSE] Connection error for ${connectionId}:`, error.message);
    markConnectionDead(connection);
  });

  // Handle response errors
  res.on("error", (error) => {
    console.error(`[SSE] Response error for ${connectionId}:`, error.message);
    markConnectionDead(connection);
  });
});

// Enhanced job update function
async function sendJobUpdate(jobId: string) {
  const subscribers = jobSubscribers.get(jobId);
  if (!subscribers || subscribers.size === 0) {
    console.log(`[SSE] No active subscribers for job ${jobId}`);
    return;
  }

  console.log(`[SSE] Sending update to ${subscribers.size} subscribers for job ${jobId}`);

  try {
    const job = await audioProcessingQueue.getJob(jobId);

    if (!job) {
      console.log(`[SSE] Job ${jobId} not found in queue`);
      // Notify subscribers that job was not found
      broadcastToJobSubscribers(jobId, {
        jobId,
        state: "error",
        error: "Job not found",
        processingStage: "Job not found",
        timestamp: Date.now(),
      }, "error");
      return;
    }

    const state = await job.getState();
    const progress = typeof job.progress === 'number' ? job.progress : 0;
    const jobData = job.data;
    const { transcript } = jobData;

    // Enhanced processing stages with more granular feedback
    let processingStage = "Initializing";
    let estimatedTimeRemaining = 0;

    switch (true) {
      case progress === 0:
        processingStage = "Queued";
        break;
      case progress > 0 && progress <= 10:
        processingStage = "Starting audio processing";
        estimatedTimeRemaining = Math.round((100 - progress) * 2);
        break;
      case progress > 10 && progress <= 30:
        processingStage = "Generating speech from text";
        estimatedTimeRemaining = Math.round((100 - progress) * 1.8);
        break;
      case progress > 30 && progress <= 60:
        processingStage = "Separating background music";
        estimatedTimeRemaining = Math.round((100 - progress) * 1.5);
        break;
      case progress > 60 && progress <= 85:
        processingStage = "Combining audio tracks";
        estimatedTimeRemaining = Math.round((100 - progress) * 1.2);
        break;
      case progress > 85 && progress < 100:
        processingStage = "Finalizing and uploading";
        estimatedTimeRemaining = Math.round((100 - progress) * 0.8);
        break;
      case progress === 100:
        processingStage = "Complete";
        estimatedTimeRemaining = 0;
        break;
    }

    // Get additional job metadata
    const jobMetadata = {
      createdAt: job.timestamp,
      processedAt: job.processedOn,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts || 1,
    };

    // Prepare update payload
    const updatePayload: UpdatePayload = {
      jobId,
      state,
      progress,
      processingStage,
      estimatedTimeRemaining,
      timestamp: Date.now(),
      metadata: jobMetadata,
      title: typeof transcript === "string" 
        ? transcript.split(" ").slice(0, 6).join(" ") + (transcript.split(" ").length > 6 ? "..." : "")
        : "Processing...",
    };

    // Add result or error based on state
    if (state === "completed") {
      updatePayload.result = job.returnvalue;
      processingStage = "Complete";
    } else if (state === "failed") {
      updatePayload.error = job.failedReason || "Unknown error occurred";
      processingStage = "Failed";
    }

    // Broadcast to all subscribers
    const eventType = state === "completed" ? "completed" : 
                     state === "failed" ? "failed" : "progress";
    
    broadcastToJobSubscribers(jobId, updatePayload, eventType);

    // Clean up connections for terminal states
    if (["completed", "failed"].includes(state)) {
      setTimeout(() => {
        cleanupJobConnections(jobId);
      }, 2000); // Give clients time to receive final update
    }

  } catch (error) {
    console.error(`[SSE] Error sending job update for ${jobId}:`, error);
    broadcastToJobSubscribers(jobId, {
      jobId,
      state: "error",
      error: "Internal server error",
      processingStage: "Error",
      timestamp: Date.now(),
    }, "error");
  }
}

// Broadcast message to all subscribers of a job
function broadcastToJobSubscribers(jobId: string, data: any, event?: string) {
  const subscribers = jobSubscribers.get(jobId);
  if (!subscribers) return;

  let successCount = 0;
  let failedCount = 0;

  for (const connectionId of subscribers) {
    const connection = connections.get(connectionId);
    if (connection && connection.isAlive) {
      if (sendSSEMessage(connection, data, event)) {
        successCount++;
      } else {
        failedCount++;
      }
    } else {
      subscribers.delete(connectionId);
      failedCount++;
    }
  }

  console.log(`[SSE] Broadcast to job ${jobId}: ${successCount} sent, ${failedCount} failed`);
}

// Cleanup connections for a specific job
function cleanupJobConnections(jobId: string) {
  const subscribers = jobSubscribers.get(jobId);
  if (!subscribers) return;

  console.log(`[SSE] Cleaning up ${subscribers.size} connections for job ${jobId}`);
  
  for (const connectionId of subscribers) {
    const connection = connections.get(connectionId);
    if (connection) {
      try {
        connection.response.end();
      } catch (error) {
        // Connection might already be closed
      }
      connections.delete(connectionId);
    }
  }
  
  jobSubscribers.delete(jobId);
}

// Heartbeat system
function sendHeartbeat() {
  const now = Date.now();
  let deadConnections = 0;

  for (const [connectionId, connection] of connections) {
    if (!connection.isAlive || (now - connection.lastHeartbeat > CONFIG.CONNECTION_TIMEOUT)) {
      markConnectionDead(connection);
      deadConnections++;
      continue;
    }

    if (!sendSSEMessage(connection, { 
      type: "heartbeat", 
      timestamp: now 
    }, "heartbeat")) {
      deadConnections++;
    }
  }

  if (deadConnections > 0) {
    console.log(`[SSE] Heartbeat: ${deadConnections} dead connections removed. Active: ${connections.size}`);
  }
}

// Periodic cleanup
function performCleanup() {
  const now = Date.now();
  let cleaned = 0;

  // Clean up stale connections
  for (const [connectionId, connection] of connections) {
    if (!connection.isAlive || (now - connection.connectedAt > CONFIG.CONNECTION_TIMEOUT)) {
      markConnectionDead(connection);
      cleaned++;
    }
  }

  // Clean up empty job subscriber sets
  for (const [jobId, subscribers] of jobSubscribers) {
    if (subscribers.size === 0) {
      jobSubscribers.delete(jobId);
    }
  }

  if (cleaned > 0) {
    console.log(`[SSE] Cleanup: ${cleaned} stale connections removed`);
  }
}

// Update the event handlers with proper types
eventAudioProcessing.on("completed", (jobData: CompletedJobData) => {
  try {
    const jobId = jobData.jobId;
    if (jobId) {
      console.log(`[SSE Event] Job completed: ${jobId}`);
      sendJobUpdate(jobId);
    }
  } catch (error) {
    console.error(`[SSE Event] Error handling completed event:`, error);
  }
});

eventAudioProcessing.on("failed", (jobData: FailedJobData) => {
  try {
    const jobId = jobData.jobId;
    if (jobId) {
      console.log(`[SSE Event] Job failed: ${jobId}`);
      sendJobUpdate(jobId);
    }
  } catch (error) {
    console.error(`[SSE Event] Error handling failed event:`, error);
  }
});

eventAudioProcessing.on("progress", (jobData: ProgressJobData) => {
  try {
    const jobId = jobData.jobId;
    if (jobId) {
      console.log(`[SSE Event] Job progress: ${jobId}`);
      sendJobUpdate(jobId);
    }
  } catch (error) {
    console.error(`[SSE Event] Error handling progress event:`, error);
  }
});

// Additional monitoring endpoints
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    connections: connections.size,
    activeJobs: jobSubscribers.size,
    uptime: process.uptime(),
  });
});

app.get("/stats", (req, res) => {
  const connectionsByJob = new Map();
  for (const [jobId, subscribers] of jobSubscribers) {
    connectionsByJob.set(jobId, subscribers.size);
  }

  res.json({
    totalConnections: connections.size,
    activeJobs: jobSubscribers.size,
    connectionsByJob: Object.fromEntries(connectionsByJob),
    serverUptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
  });
});

// Force update endpoint for debugging
app.post("/force-update/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  sendJobUpdate(jobId);
  res.json({ message: `Force update sent for job ${jobId}` });
});

// Start periodic tasks
setInterval(sendHeartbeat, CONFIG.HEARTBEAT_INTERVAL);
setInterval(performCleanup, CONFIG.CLEANUP_INTERVAL);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SSE] Shutting down gracefully...');
  
  // Close all connections
  for (const connection of connections.values()) {
    try {
      sendSSEMessage(connection, { 
        type: "server_shutdown", 
        message: "Server is shutting down" 
      }, "shutdown");
      connection.response.end();
    } catch (error) {
      // Ignore errors during shutdown
    }
  }
  
  server.close(() => {
    console.log('[SSE] Server closed');
    process.exit(0);
  });
});

const PORT = process.env.WEBSOCKET_PORT || 3001;
server.listen(PORT, () => {
  console.log(`Enhanced SSE server running on port ${PORT}`);
  console.log(`Configuration:`, CONFIG);
});