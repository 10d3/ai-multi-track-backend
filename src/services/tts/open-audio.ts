const baseUrl = "https://api.fish.audio/v1"

const fs = require("fs");
const axios = require("axios");
const msgpack = require("msgpack5")();

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

// Helper to create request body
function createTTSRequest({
  text,
  referenceId = null,
  references = [],
  format = "mp3",
  mp3Bitrate = 128,
  model = "speech-1.6",
  normalize = true,
  latency = "normal",
  chunkLength = 200
}: {
  text: string;
  referenceId?: string | null;
  references?: Array<{ audio: Buffer; text: string }>;
  format?: string;
  mp3Bitrate?: number;
  model?: string;
  normalize?: boolean;
  latency?: string;
  chunkLength?: number;
}) {
  const packed = msgpack.encode({
    text,
    reference_id: referenceId,
    references: references.map((ref) => ({
      audio: ref.audio,
      text: ref.text,
    })),
    format,
    mp3_bitrate: mp3Bitrate,
    model,
    normalize,
    latency,
    chunk_length: chunkLength
  });
  return packed;
}

// Helper to fetch audio from URL
async function fetchAudioFromUrl(url: string): Promise<Buffer> {
  const response = await axios({
    method: 'get',
    url,
    responseType: 'arraybuffer'
  });
  return Buffer.from(response.data);
}

// Main function
export async function generateTTS({
  // apiKey,
  text,
  outputPath,
  referenceId = null,
  references = [], // [{ audio: Buffer, text: "..." }]
  referenceUrls = [], // [{ url: string, text: "..." }]
  model = "speech-1.6"
}: {
  // apiKey: string;
  text: string;
  outputPath: string;
  referenceId?: string | null;
  references?: Array<{ audio: Buffer; text: string }>;
  referenceUrls?: Array<{ url: string; text: string }>;
  model?: string;
}) {
  // Convert any URL references to Buffer references
  if (referenceUrls.length > 0) {
    const urlBuffers = await Promise.all(
      referenceUrls.map(async (ref) => ({
        audio: await fetchAudioFromUrl(ref.url),
        text: ref.text
      }))
    );
    references = [...references, ...urlBuffers];
  }
  const body = createTTSRequest({
    text,
    referenceId,
    references,
    model
  });

  const apiKey = process.env.FISH_API_KEY

  return requestQueue.add(async () => {
    const response = await axios({
      method: "post",
      url: `${baseUrl}/tts`,
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/msgpack",
        "model": model
      },
      data: body,
      responseType: "stream"
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", () => resolve(outputPath));
      writer.on("error", reject);
    });
  });
}
