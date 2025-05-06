import path from "path";
import dotenv from "dotenv";

dotenv.config();

export const BATCH_SIZE = 5;
export const TEMP_DIR = path.resolve(process.cwd(), "temp");
export const BUCKET_NAME = process.env.BUCKET_NAME as string;
export const SIGNED_URL_EXPIRY = "03-09-2491";
export const TTS_TIMEOUT_MS = 1200000; // 5 minutes for TTS requests

export const FFMPEG_DEFAULTS = {
  SAMPLE_RATE: 44100,
  CHANNELS: 2,
  SPEECH_VOLUME: 1.5,
  BG_VOLUME: 1.0,
};

export const AUDIO_PROCESSING = {
  BG_WEIGHT: 1.0,
  SPEECH_WEIGHT: 1.2,
  SCALE_FACTOR: 0.98,
};