import { Queue, QueueEvents } from 'bullmq';
import path from 'path';
import { Storage } from '@google-cloud/storage';
import dotenv from 'dotenv';
import IORedis from 'ioredis';

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

// const connection = new IORedis({
//   host: process.env.REDIS_HOST || 'your-cloud-redis-host', // Your cloud Redis host
//   port: Number(process.env.REDIS_PORT) || 6379,           // Your cloud Redis port
//   password: process.env.REDIS_PASSWORD || 'your-password', // Your Redis password if required
// });
function getRedisURl(){
  if(process.env.REDIS_URL){
    return process.env.REDIS_URL
  }else{
    throw new Error("redis url is missing")
  }
}
const connection = new IORedis("redis://default:bDUE3KQhcCwemyKWutHAT5jxmrUlVAbIoOcRP9a25LvfRA8493X8KNgfW9bA7NpJ@jcg08kw004wsog8c88wcoo8g:6379/0");

connection.on('error', (error:any) => {
  console.error('Redis connection error:', error);
  if (error.code === 'ECONNREFUSED') {
    console.error('Please check if Redis is running and the connection details are correct');
  }
});

const audioProcessingQueue = new Queue('audio-processing', {
  // connection: {
  //   host: "https://coolify.sayitai.com", // Your Redis host
  //   port: 6380     // Your Redis port
  // }
  connection
});

export const eventAudioProcessing = new QueueEvents("audio-processing")

// Google Cloud Storage setup
// const storageGoogle = new Storage({
//   // credentials
//   keyFilename: path.join(__dirname, '..', 'config', 'endless-bolt-430416-h3-e0a89a12879b.json')
// });

const storageGoogle = new Storage({ credentials });

export { audioProcessingQueue, storageGoogle };
