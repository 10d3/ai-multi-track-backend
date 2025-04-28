// export interface Transcript {
//   start: number;
//   end: number;
//   text: string;
// }

// export interface JobData {
//   audioUrls: string[];
//   transcript: Transcript[];
//   originalAudioUrl: string;
//   email: string;
//   language: string;
// }

export interface JobData {
  originalAudioUrl: string;
  ttsRequests?: Array<{
    textToSpeech: string;
    voice_id: string;
    output_format?: string;
    voice_name: string;
  }>;
  audioUrls?: string[];
  transcript: Transcript[];
  userEmail?: string;  // From transcreation controller
  email?: string;      // For backward compatibility
  language?: string;   // Language information
  currentOperation?: string;
  startTime?: number;
  processingDetails?: {
    currentStep: number;
    totalSteps: number;
    elapsedTime: number;
    estimatedRemainingTime: number;
    stepTimes: number[];
    lastStepName: string;
  };
}

import type { EmotionWeights } from "@zyphra/client";
// import { Job } from "bullmq";

export interface TTSRequest {
  textToSpeech: string;
  voice_id: string;
  output_format?: string;
  voice_name: string;
}

export interface Emotion{
  happiness: number,
  neutral: number,
  sadness: number,
  disgust: number,
  fear: number,
  suprise: number,
  anger: number,
  other: number,
}

export interface Transcript {
  start: number;
  end: number;
  text: string;
  speaker: string
  emotion: any
  voice?: string
  // voiceId: string
}

export interface JobData {
  ttsRequests?: TTSRequest[];
  audioUrls?: string[];
  originalAudioUrl: string;
  transcript: Transcript[];
  currentOperation?: string;
  startTime?: number;
  processingDetails?: {
    currentStep: number;
    totalSteps: number;
    elapsedTime: number;
    estimatedRemainingTime: number;
    stepTimes: number[];
    lastStepName: string;
  };
}

export interface AudioAnalysisResult {
  loudness: {
    integrated: number;
    truePeak: number;
    range: number;
    threshold: number;
    offset: number;
  };
  format: {
    sampleRate: number;
    channels: number;
    codec: string;
  };
  duration: number;
}

export type ZyphraModel = "zonos-v0.1-transformer" | "zonos-v0.1-hybrid";

export interface ZyphraTTSRequest extends TTSRequest {
  language_iso_code?: string;
  emotion?: EmotionWeights;
  referenceAudioPath?: string;
}
