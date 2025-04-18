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
  userEmail: string;
  audioUrls?: string[];
  ttsRequests?: Array<{
    textToSpeech: string;
    voice_id: string;
    output_format?: string;
    voice_name: string;
  }>;
  originalAudioUrl: string;
  transcript: Transcript[];
}
