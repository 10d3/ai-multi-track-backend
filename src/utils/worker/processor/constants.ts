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

// Audio processing constants
// export const AUDIO_PROCESSING = {
//   // Weights for mixing audio
//   SPEECH_WEIGHT: 1.0,
//   BG_WEIGHT: 0.3,
  
//   // Target loudness levels (in LUFS)
//   TARGET_LUFS: -16,
//   MAX_PEAK_DB: -1.5,
  
//   // Timing precision constants
//   TIMING_PRECISION_MS: 10, // Precision for segment timing in milliseconds
//   MIN_SEGMENT_DURATION_MS: 100, // Minimum duration for a valid segment
  
//   // Validation thresholds
//   LOUDNESS_MATCH_THRESHOLD: 2.0, // Maximum allowed difference in LUFS
//   PEAK_MATCH_THRESHOLD: 1.5, // Maximum allowed difference in peak dB
//   DURATION_MATCH_THRESHOLD: 0.1, // Maximum allowed proportional difference in duration
  
//   // Processing parameters
//   SAMPLE_RATE: 44100,
//   CHANNELS: 2,
  
//   // Segment positioning
//   SEGMENT_PADDING_MS: 50, // Padding around segments to avoid abrupt cuts
//   CROSSFADE_DURATION_MS: 15, // Duration of crossfade between segments
// };

// FFmpeg filter presets
export const FFMPEG_FILTERS = {
  // Less aggressive noise reduction, preserve more speech frequencies
  SPEECH_ENHANCEMENT: "highpass=f=70,lowpass=f=14000,afftdn=nf=-15,dynaudnorm=p=0.95:m=10",
  
  // Gentler background cleaning to preserve more natural sound
  BACKGROUND_CLEANING: "highpass=f=40,lowpass=f=16000,afftdn=nf=-20,equalizer=f=200:t=q:w=1:g=-1",
  
  // More natural loudness normalization
  FINAL_PROCESSING: "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=summary,acompressor=threshold=-14dB:ratio=1.5:attack=200:release=1000",
};

// Adjust audio processing constants for better balance
export const AUDIO_PROCESSING = {
  // Balance speech and background for better audibility
  SPEECH_WEIGHT: 1.0,
  BG_WEIGHT: 0.6,
  
  // Target loudness levels (in LUFS)
  TARGET_LUFS: -14,  // Less compression for more dynamic range
  MAX_PEAK_DB: -1.0, // Allow slightly higher peaks
  
  // Timing precision constants
  TIMING_PRECISION_MS: 10,
  MIN_SEGMENT_DURATION_MS: 100,
  
  // Validation thresholds
  LOUDNESS_MATCH_THRESHOLD: 2.5, // More tolerance
  PEAK_MATCH_THRESHOLD: 2.0,     // More tolerance
  DURATION_MATCH_THRESHOLD: 0.15, // More tolerance
  
  // Processing parameters
  SAMPLE_RATE: 44100,
  CHANNELS: 2,
  
  // Segment positioning
  SEGMENT_PADDING_MS: 75, // Increased padding to avoid abrupt cuts
  CROSSFADE_DURATION_MS: 25, // Longer crossfade for smoother transitions
};
export const SCALE_FACTOR= 0.98