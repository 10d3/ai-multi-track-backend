export interface Transcript {
  start: number;
  end: number;
  text: string;
}

export interface JobData {
  audioUrls: string[];
  transcript: Transcript[];
  originalAudioUrl: string;
  email: string;
  language: string;
}
