// server-sent-events.ts (renamed from websocket-server.ts)

import http from "http";
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import rateLimit from "express-rate-limit";
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

// Enhanced connection management
interface ConnectionInfo {
  response: express.Response;
  clientIp: string;
  userId?: string;
  connectedAt: number;
  lastHeartbeat: number;
  isActive: boolean;
}

interface PendingUpdate {
  jobId: string;
  data: any;
  timestamp: number;
}

// Store active SSE connections with enhanced metadata
const connections = new Map<string, ConnectionInfo>();
const connectionsByIp = new Map<string, Set<string>>();
const pendingUpdates = new Map<string, PendingUpdate[]>();

// Configuration constants
const MAX_CONNECTIONS_PER_IP = 10;
const CONNECTION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const HEARTBEAT_INTERVAL = 30 * 1000; // 30 seconds
const BATCH_UPDATE_DELAY = 1000; // 1 second
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Rate limiting for SSE connections
const sseRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 requests per windowMs
  message: "Too many SSE connection requests from this IP",
  standardHeaders: true,
  legacyHeaders: false,
});

// Authentication middleware (basic implementation - enhance as needed)
const authenticateSSE = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Basic authentication check - replace with your actual auth logic
  const authHeader = req.headers.authorization;
  const userId = req.headers['x-user-id'] as string;
  
  // For now, we'll allow connections but you should implement proper auth
  // if (!authHeader || !userId) {
  //   return res.status(401).json({ error: 'Authentication required' });
  // }
  
  // Store userId in request for later use
  (req as any).userId = userId;
  next();
};

// Validate jobId format
const validateJobId = (jobId: string): boolean => {
  // Basic validation - alphanumeric and hyphens only
  return /^[a-zA-Z0-9-_]+$/.test(jobId) && jobId.length >= 10 && jobId.length <= 100;
};

// Check connection limits per IP
const checkConnectionLimits = (clientIp: string): boolean => {
  const ipConnections = connectionsByIp.get(clientIp);
  return !ipConnections || ipConnections.size < MAX_CONNECTIONS_PER_IP;
};

// SSE endpoint for job updates with enhanced security and management
app.get("/events/:jobId", sseRateLimit, authenticateSSE, (req, res) => {
  const jobId = req.params.jobId;
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const userId = (req as any).userId;

  // console.log(`[SSE] New connection request received:`, {
  //   jobId,
  //   clientIp,
  //   userId,
  //   timestamp: new Date().toISOString(),
  //   userAgent: req.headers['user-agent'],
  // });

  // Validate jobId
  if (!validateJobId(jobId)) {
    console.warn(`[SSE] Invalid jobId format: ${jobId}`);
    return res.status(400).json({ error: 'Invalid job ID format' });
  }

  // Check connection limits
  if (!checkConnectionLimits(clientIp)) {
    console.warn(`[SSE] Connection limit exceeded for IP: ${clientIp}`);
    return res.status(429).json({ error: 'Too many connections from this IP' });
  }

  // Set headers for SSE with compression
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control",
    "Content-Encoding": "identity", // Disable compression for SSE
  });

  const now = Date.now();
  
  // Create connection info
  const connectionInfo: ConnectionInfo = {
    response: res,
    clientIp,
    userId,
    connectedAt: now,
    lastHeartbeat: now,
    isActive: true,
  };

  // Store the connection
  connections.set(jobId, connectionInfo);
  
  // Track connections by IP
  let ipConnections = connectionsByIp.get(clientIp);
  if (!ipConnections) {
    ipConnections = new Set();
    connectionsByIp.set(clientIp, ipConnections);
  }
  ipConnections.add(jobId);

  // console.log(`[SSE] Connection established for job ${jobId}. Active connections: ${connections.size}`);

  // Send initial connection confirmation
  const confirmationMessage = {
    type: "subscription_confirmed",
    jobId: jobId,
    timestamp: new Date().toISOString(),
    serverId: process.env.SERVER_ID || 'server-1',
  };

  try {
    res.write(`data: ${JSON.stringify(confirmationMessage)}\n\n`);
  } catch (error) {
    console.error(`[SSE] Error sending confirmation for job ${jobId}:`, error);
    cleanupConnection(jobId);
    return;
  }

  // Send initial job status
  sendJobUpdate(jobId);

  // Handle client disconnect
  req.on("close", () => {
    // console.log(`[SSE] Client disconnected from job ${jobId}`);
    cleanupConnection(jobId);
  });

  // Handle client errors
  req.on("error", (error) => {
    console.error(`[SSE] Connection error for job ${jobId}:`, error);
    cleanupConnection(jobId);
  });

  // Handle response errors
  res.on("error", (error) => {
    console.error(`[SSE] Response error for job ${jobId}:`, error);
    cleanupConnection(jobId);
  });
});

// Enhanced connection cleanup
const cleanupConnection = (jobId: string) => {
  const connectionInfo = connections.get(jobId);
  if (connectionInfo) {
    connectionInfo.isActive = false;
    
    // Remove from IP tracking
    const ipConnections = connectionsByIp.get(connectionInfo.clientIp);
    if (ipConnections) {
      ipConnections.delete(jobId);
      if (ipConnections.size === 0) {
        connectionsByIp.delete(connectionInfo.clientIp);
      }
    }
    
    // Close response if still open
    try {
      if (!connectionInfo.response.destroyed) {
        connectionInfo.response.end();
      }
    } catch (error) {
      console.error(`[SSE] Error closing response for job ${jobId}:`, error);
    }
    
    connections.delete(jobId);
    // console.log(`[SSE] Connection cleaned up for job ${jobId}. Active connections: ${connections.size}`);
  }
};

// Batch update mechanism for high-frequency changes
const batchJobUpdate = (jobId: string, updateData: any) => {
  let updates = pendingUpdates.get(jobId);
  if (!updates) {
    updates = [];
    pendingUpdates.set(jobId, updates);
    
    // Schedule batch processing
    setTimeout(() => {
      processBatchedUpdates(jobId);
    }, BATCH_UPDATE_DELAY);
  }
  
  // Add or replace the latest update
  const existingIndex = updates.findIndex(u => u.jobId === jobId);
  if (existingIndex >= 0) {
    updates[existingIndex] = { jobId, data: updateData, timestamp: Date.now() };
  } else {
    updates.push({ jobId, data: updateData, timestamp: Date.now() });
  }
};

const processBatchedUpdates = (jobId: string) => {
  const updates = pendingUpdates.get(jobId);
  if (!updates || updates.length === 0) return;
  
  // Send the latest update
  const latestUpdate = updates[updates.length - 1];
  sendJobUpdateImmediate(jobId, latestUpdate.data);
  
  // Clear processed updates
  pendingUpdates.delete(jobId);
};

// Enhanced job update function with error handling and batching
async function sendJobUpdate(jobId: string, forceSend: boolean = false) {
  try {
    const job = await audioProcessingQueue.getJob(jobId);

    if (!job) {
      console.warn(`[SSE] No job found for id ${jobId}`);
      // Send job not found message to client
      const connectionInfo = connections.get(jobId);
      if (connectionInfo?.isActive) {
        try {
          connectionInfo.response.write(`data: ${JSON.stringify({
            jobId,
            error: 'Job not found',
            timestamp: Date.now(),
          })}\n\n`);
        } catch (error) {
          console.error(`[SSE] Error sending job not found message for ${jobId}:`, error);
          cleanupConnection(jobId);
        }
      }
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

    const estimatedTimeRemaining =
      progress > 0 && progress < 100
        ? Math.round((100 - progress) * 1.5)
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

    const updateData = {
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
      timestamp: Date.now(),
      startedAt: job.timestamp,
    };

    if (forceSend || state === "completed" || state === "failed") {
      sendJobUpdateImmediate(jobId, updateData);
    } else {
      // Use batching for non-terminal states
      batchJobUpdate(jobId, updateData);
    }

  } catch (error) {
    console.error(`[SSE] Error preparing job update for ${jobId}:`, error);
    
    // Send error message to client
    const connectionInfo = connections.get(jobId);
    if (connectionInfo?.isActive) {
      try {
        connectionInfo.response.write(`data: ${JSON.stringify({
          jobId,
          error: 'Failed to fetch job status',
          timestamp: Date.now(),
        })}\n\n`);
      } catch (sendError) {
        console.error(`[SSE] Error sending error message for ${jobId}:`, sendError);
        cleanupConnection(jobId);
      }
    }
  }
}

// Immediate send function (bypasses batching)
const sendJobUpdateImmediate = (jobId: string, updateData: any) => {
  const connectionInfo = connections.get(jobId);
  
  if (!connectionInfo || !connectionInfo.isActive) {
    return;
  }

  try {
    // console.log(`[SSE] Sending update to client for job ${jobId}:`, {
    //   state: updateData.state,
    //   progress: updateData.progress,
    //   processingStage: updateData.processingStage,
    // });

    connectionInfo.response.write(`data: ${JSON.stringify(updateData)}\n\n`);
    connectionInfo.lastHeartbeat = Date.now();

    // Handle terminal states
    if (updateData.state === "completed" || updateData.state === "failed") {
      setTimeout(() => {
        if (connections.has(jobId)) {
          // console.log(`[SSE] Closing connection for ${updateData.state} job ${jobId}`);
          cleanupConnection(jobId);
        }
      }, 5000);
    }

  } catch (error) {
    console.error(`[SSE] Error sending update for job ${jobId}:`, error);
    cleanupConnection(jobId);
  }
};

// Heartbeat mechanism to detect stale connections
const sendHeartbeat = () => {
  const now = Date.now();
  const staleConnections: string[] = [];

  for (const [jobId, connectionInfo] of connections) {
    if (!connectionInfo.isActive) {
      staleConnections.push(jobId);
      continue;
    }

    const timeSinceLastHeartbeat = now - connectionInfo.lastHeartbeat;
    
    if (timeSinceLastHeartbeat > CONNECTION_TIMEOUT) {
      // console.log(`[SSE] Connection timeout for job ${jobId}`);
      staleConnections.push(jobId);
      continue;
    }

    // Send heartbeat
    try {
      connectionInfo.response.write(`data: ${JSON.stringify({
        type: 'heartbeat',
        timestamp: now,
        jobId: jobId,
      })}\n\n`);
      
      connectionInfo.lastHeartbeat = now;
    } catch (error) {
      console.error(`[SSE] Heartbeat failed for job ${jobId}:`, error);
      staleConnections.push(jobId);
    }
  }

  // Cleanup stale connections
  staleConnections.forEach(jobId => cleanupConnection(jobId));
};

// Periodic cleanup of stale connections and data
const performCleanup = () => {
  const now = Date.now();
  
  // console.log(`[SSE] Performing periodic cleanup. Active connections: ${connections.size}`);
  
  // Clean up old pending updates
  for (const [jobId, updates] of pendingUpdates) {
    const oldUpdates = updates.filter(update => now - update.timestamp > BATCH_UPDATE_DELAY * 5);
    if (oldUpdates.length > 0) {
      // console.log(`[SSE] Cleaning up ${oldUpdates.length} old pending updates for job ${jobId}`);
      pendingUpdates.set(jobId, updates.filter(update => now - update.timestamp <= BATCH_UPDATE_DELAY * 5));
    }
  }
  
  // Clean up empty pending updates
  for (const [jobId, updates] of pendingUpdates) {
    if (updates.length === 0) {
      pendingUpdates.delete(jobId);
    }
  }
  
  // Log connection statistics
  const connectionStats = {
    totalConnections: connections.size,
    connectionsByIp: Object.fromEntries(
      Array.from(connectionsByIp.entries()).map(([ip, jobIds]) => [ip, jobIds.size])
    ),
    pendingUpdates: pendingUpdates.size,
  };
  
  // console.log(`[SSE] Connection statistics:`, connectionStats);
};

// Enhanced event listeners with error handling
eventAudioProcessing.on("completed", (jobId) => {
  // console.log(`[SSE Event] Job completed event received for job ID: ${jobId.jobId}`);
  try {
    sendJobUpdate(jobId.jobId, true); // Force send for completed jobs
  } catch (error) {
    console.error(`[SSE Event] Error handling completed event for job ${jobId.jobId}:`, error);
  }
});

eventAudioProcessing.on("failed", (jobId) => {
  // console.log(`[SSE Event] Job failed event received for job ID: ${jobId.jobId}`);
  try {
    sendJobUpdate(jobId.jobId, true); // Force send for failed jobs
  } catch (error) {
    console.error(`[SSE Event] Error handling failed event for job ${jobId.jobId}:`, error);
  }
});

eventAudioProcessing.on("progress", (jobId) => {
  // console.log(`[SSE Event] Job progress event received for job ID: ${jobId.jobId}`);
  try {
    sendJobUpdate(jobId.jobId, false); // Allow batching for progress updates
  } catch (error) {
    console.error(`[SSE Event] Error handling progress event for job ${jobId.jobId}:`, error);
  }
});

// Enhanced health check endpoint with detailed status
app.get("/health", (req, res) => {
  const now = Date.now();
  const healthData = {
    status: "OK",
    timestamp: now,
    connections: {
      total: connections.size,
      active: Array.from(connections.values()).filter(conn => conn.isActive).length,
      byIp: Object.fromEntries(
        Array.from(connectionsByIp.entries()).map(([ip, jobIds]) => [ip, jobIds.size])
      ),
    },
    pendingUpdates: pendingUpdates.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    serverId: process.env.SERVER_ID || 'server-1',
  };
  
  res.status(200).json(healthData);
});

// Additional monitoring endpoint
app.get("/metrics", (req, res) => {
  const metrics = {
    activeConnections: connections.size,
    totalConnectionsByIp: Object.fromEntries(connectionsByIp),
    pendingUpdates: pendingUpdates.size,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime(),
  };
  
  res.json(metrics);
});

// Graceful shutdown handling
const gracefulShutdown = (signal: string) => {
  console.log(`[SSE] Received ${signal}. Starting graceful shutdown...`);
  
  // Stop accepting new connections
  server.close(() => {
    console.log(`[SSE] HTTP server closed`);
  });
  
  // Close all active connections
  const shutdownMessage = {
    type: 'shutdown',
    message: 'Server is shutting down',
    timestamp: Date.now(),
  };
  
  for (const [jobId, connectionInfo] of connections) {
    try {
      if (connectionInfo.isActive) {
        connectionInfo.response.write(`data: ${JSON.stringify(shutdownMessage)}\n\n`);
        connectionInfo.response.end();
      }
    } catch (error) {
      console.error(`[SSE] Error during shutdown for job ${jobId}:`, error);
    }
  }
  
  connections.clear();
  connectionsByIp.clear();
  pendingUpdates.clear();
  
  console.log(`[SSE] Graceful shutdown completed`);
  process.exit(0);
};

// Start periodic tasks
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
setInterval(performCleanup, CLEANUP_INTERVAL);

// Handle process signals for graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = process.env.WEBSOCKET_PORT || 3001;
server.listen(PORT, () => {
  console.log(`SSE server running on port ${PORT}`);
  // console.log(`Configuration:`, {
  //   maxConnectionsPerIp: MAX_CONNECTIONS_PER_IP,
  //   connectionTimeout: CONNECTION_TIMEOUT / 1000 + 's',
  //   heartbeatInterval: HEARTBEAT_INTERVAL / 1000 + 's',
  //   batchUpdateDelay: BATCH_UPDATE_DELAY / 1000 + 's',
  //   cleanupInterval: CLEANUP_INTERVAL / 1000 + 's',
  // });
});
