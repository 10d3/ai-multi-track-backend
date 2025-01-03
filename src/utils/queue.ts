import { Queue, QueueEvents } from 'bullmq';
import path from 'path';
import { Storage } from '@google-cloud/storage';
import dotenv from 'dotenv';

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

const audioProcessingQueue = new Queue('audio-processing', {
  connection: {
    host: process.env.WORKER_URL, // Your Redis host
    port: Number(process.env.WORKER_PORT)       // Your Redis port
  }
});

export const eventAudioProcessing = new QueueEvents("audio-processing")

// Google Cloud Storage setup
// const storageGoogle = new Storage({
//   // credentials
//   keyFilename: path.join(__dirname, '..', 'config', 'endless-bolt-430416-h3-e0a89a12879b.json')
// });

const storageGoogle = new Storage({ credentials });

export { audioProcessingQueue, storageGoogle };
