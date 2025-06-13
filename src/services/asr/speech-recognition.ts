import fs from "fs"
import axios from "axios"
import msgpack5 from "msgpack5"

const baseUrl = "https://api.fish.audio/v1";
const msgpack = msgpack5();

// Queue system for managing concurrent requests
class RequestQueue {
  private queue: Array<() => Promise<any>> = [];
  private running = 0;
  private maxConcurrent = 5;

  async add<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      return new Promise((resolve, reject) => {
        this.queue.push(async () => {
          try {
            const result = await task();
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      });
    }

    this.running++;
    try {
      const result = await task();
      return result;
    } finally {
      this.running--;
      this.processQueue();
    }
  }

  private processQueue() {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const task = this.queue.shift();
      if (task) {
        this.add(task);
      }
    }
  }
}

const requestQueue = new RequestQueue();

/**
 * Transcribe audio using Fish Audio API
 */
async function transcribeAudio({
  apiKey,
  audioPath,
  language = "en",
  ignoreTimestamps = false
}: {
  apiKey: string;
  audioPath: string;
  language?: string;
  ignoreTimestamps?: boolean;
}) {
  // Read the audio file
  const audioData = fs.readFileSync(audioPath);

  // Prepare the request data
  const requestData = {
    audio: audioData,
    language: language,
    ignore_timestamps: ignoreTimestamps
  };

  // Pack the data using msgpack
  const packedData = msgpack.encode(requestData);

  return requestQueue.add(async () => {
    const response = await axios({
      method: "post",
      url: `${baseUrl}/asr`,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/msgpack"
      },
      data: packedData,
      responseType: "json"
    });

    return response.data;
  });
}

/**
 * Transcribe audio from a URL
 */
async function transcribeAudioFromUrl({
  apiKey,
  audioUrl,
  language = "en",
  ignoreTimestamps = false
}: {
  apiKey: string;
  audioUrl: string;
  language?: string;
  ignoreTimestamps?: boolean;
}) {
  // Fetch the audio data from URL
  const audioResponse = await axios({
    method: "get",
    url: audioUrl,
    responseType: "arraybuffer"
  });
  
  const audioData = Buffer.from(audioResponse.data);

  // Prepare the request data
  const requestData = {
    audio: audioData,
    language: language,
    ignore_timestamps: ignoreTimestamps
  };

  // Pack the data using msgpack
  const packedData = msgpack.encode(requestData);

  return requestQueue.add(async () => {
    const response = await axios({
      method: "post",
      url: `${baseUrl}/asr`,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/msgpack"
      },
      data: packedData,
      responseType: "json"
    });

    return response.data;
  });
}

export {
  transcribeAudio,
  transcribeAudioFromUrl
};

// Example usage:
/*
const result = await transcribeAudio({
  apiKey: "YOUR_API_KEY",
  audioPath: "input_audio.mp3",
  language: "en",
  ignoreTimestamps: false
});

console.log(`Transcribed text: ${result.text}`);
console.log(`Audio duration: ${result.duration} seconds`);

for (const segment of result.segments) {
  console.log(`Segment: ${segment.text}`);
  console.log(`Start time: ${segment.start}, End time: ${segment.end}`);
}
*/