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
    start: number;
    end: number;
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
  start: number;
  end: number;
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
  ttsFile?: string
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
  id: string
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
  originalPath?: string;
  spectralAnalysis?: {
    momentaryLoudness?: number;
    shortTermLoudness?: number;
    frequencyResponse?: {
      dynamicRange?: number;
      peakLevel?: number;
      bands?: {
        bass?: { meanVolume?: number; maxVolume?: number; centerFrequency?: number };
        mid?: { meanVolume?: number; maxVolume?: number; centerFrequency?: number };
        high?: { meanVolume?: number; maxVolume?: number; centerFrequency?: number };
      };
    };
  };
}

export type ZyphraModel = "zonos-v0.1-transformer" | "zonos-v0.1-hybrid";

export interface ZyphraTTSRequest extends TTSRequest {
  language_iso_code?: string;
  emotion?: EmotionWeights;
  referenceAudioPath?: string;
}
