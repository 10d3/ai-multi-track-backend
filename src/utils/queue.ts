import { Queue } from 'bullmq';
import path from 'path';
import { Storage } from '@google-cloud/storage';

const audioProcessingQueue = new Queue('audio-processing', {
  connection: {
    host: 'localhost', // Your Redis host
    port: 6379        // Your Redis port
  }
});

// Google Cloud Storage setup
const storageGoogle = new Storage({
  keyFilename: path.join(__dirname, '..', 'config', 'endless-bolt-430416-h3-e0a89a12879b.json')
});

export { audioProcessingQueue, storageGoogle };
