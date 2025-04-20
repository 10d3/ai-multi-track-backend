import { Queue, QueueEvents } from "bullmq";
import path from "path";
import { Storage } from "@google-cloud/storage";
import dotenv from "dotenv";
import { Redis } from "ioredis";
import { password } from "bun";

dotenv.config();

// Enhanced logging for BullMQ
// setLoggingOptions({
//   level: 'debug',
//   logger: {
//     log: console.log,
//     warn: console.warn,
//     error: console.error
//   }
// });
function cleanPrivateKey(key: string | undefined) {
  if (!key) return "";
  return key
    .replace(/\\n/g, "\n") // Replace literal \n with newlines
    .replace(/["']/g, "") // Remove any quotes
    .replace(/\\/g, ""); // Remove any remaining backslashes
}

const privateKey = cleanPrivateKey(process.env.GOOGLE_PRIVATE_KEY);

const credentials = {
  type: process.env.GOOGLE_CREDENTIALS_TYPE,
  project_id: process.env.GOOGLE_CREDENTIALS_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  // private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  private_key: privateKey,
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
  auth_uri: process.env.GOOGLE_AUTH_URI,
  token_uri: process.env.GOOGLE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.GOOGLE_UNIVERSE_DOMAIN,
};

// Redis Configuration
export const redisHost = process.env.REDIS_HOST || "localhost";
export const redisPort = parseInt(process.env.REDIS_PORT || "6379");

// Create Queue with Simple Configuration
const audioProcessingQueue = new Queue("audio-processing", {
  connection: {
    host: redisHost,
    port: redisPort,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  },
});

// Queue Events with Simple Configuration
export const eventAudioProcessing = new QueueEvents("audio-processing", {
  connection: {
    host: redisHost,
    port: redisPort,
    maxRetriesPerRequest: null,
  },
});

// Google Cloud Storage setup
const storageGoogle = new Storage({ credentials });

// try {
//   await storageGoogle.bucket(process.env.BUCKET_NAME as string).getFiles();
//   console.log("private_key:", process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),)
// } catch (error:any) {
//   console.error('Google Cloud Storage Connection Error:', error);
//   throw new Error(`Storage connection failed: ${error.message}`);
// }

// Async initialization
// async function initializeServices() {
//   try {
//     // Test Redis Connection
//     await testRedisConnection();

//     // Optional: Additional startup checks
//     console.log("Checking Queue Connection...");
//     await audioProcessingQueue.add("startup-check", { check: true });
//     console.log("Startup queue job added successfully");
//   } catch (error) {
//     console.error("Service Initialization Failed:", error);
//     // Optionally exit or implement retry logic
//     // process.exit(1);
//   }
// }

// // Initialize on module import
// initializeServices().catch(console.error);

// // Error Handler for Unhandled Rejections
// process.on("unhandledRejection", (reason, promise) => {
//   console.error("Unhandled Rejection at:", promise, "reason:", reason);
// });

// Export key services
export { audioProcessingQueue, storageGoogle, credentials };
