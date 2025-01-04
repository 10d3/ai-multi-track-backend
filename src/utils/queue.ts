import { Queue, QueueEvents } from "bullmq";
import path from "path";
import { Storage } from "@google-cloud/storage";
import dotenv from "dotenv";
// import IORedis from "ioredis";
import { Redis } from 'ioredis';

dotenv.config();

const credentials = {
  type: process.env.GOOGLE_CREDENTIALS_TYPE,
  project_id: process.env.GOOGLE_CREDENTIALS_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
  auth_uri: process.env.GOOGLE_AUTH_URI,
  token_uri: process.env.GOOGLE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.GOOGLE_UNIVERSE_DOMAIN,
};

const redisConfig = {
  host: '10.0.1.8',  // Try with IP first
  // host: 'redis-stack',  // Uncomment to try with hostname
  port: 6379,
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    console.log(`Retry attempt ${times}, waiting ${delay}ms`);
    return delay;
  },
  maxRetriesPerRequest: 3
};

const redis = new Redis(redisConfig);

redis.on('connect', () => {
  console.log('Successfully connected to Redis');
});

redis.on('error', (err:any) => {
  console.error('Redis connection error:', {
    message: err.message,
    code: err.code,
    address: err.address,
    port: err.port
  });
});


// const connection = new IORedis({
//   host: process.env.REDIS_HOST || "your-cloud-redis-host", // Your cloud Redis host
//   port: Number(process.env.REDIS_PORT) || 6379, // Your cloud Redis port
//   username: "default",
//   password: process.env.REDIS_PASSWORD || "your-password", // Your Redis password if required
// });
// function getRedisURl() {
//   if (process.env.REDIS_URL) {
//     return process.env.REDIS_URL;
//   } else {
//     throw new Error("redis url is missing");
//   }
// }

// connection.on("error", (error: any) => {
//   console.error("Redis connection error:", error);
//   if (error.code === "ECONNREFUSED") {
//     console.error(
//       "Please check if Redis is running and the connection details are correct"
//     );
//   }
// });

console.log('Redis Host:', process.env.WORKER_URL);
console.log('Redis Port:', process.env.REDIS_PORT);

const audioProcessingQueue = new Queue("audio-processing", {
  // connection: {
  //   // host: process.env.WORKER_URL,
  //   host:"redis-stack",
  //   port: Number(process.env.REDIS_PORT),
  //   // username: process.env.REDIS_USERNAME,
  //   // password: process.env.REDIS_PASSWORD,
  // },
  connection: redis
});

export const eventAudioProcessing = new QueueEvents("audio-processing");

// Google Cloud Storage setup
// const storageGoogle = new Storage({
//   // credentials
//   keyFilename: path.join(__dirname, '..', 'config', 'endless-bolt-430416-h3-e0a89a12879b.json')
// });

const storageGoogle = new Storage({ credentials });

export { audioProcessingQueue, storageGoogle };
