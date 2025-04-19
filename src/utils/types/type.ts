export interface Transcript {
  start: number;
  end: number;
  text: string;
}

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
