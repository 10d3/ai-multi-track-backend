interface SpeakingRateInput {
  translatedText: string;
  start: number;
  end: number;
}

export interface SpeakingRateResult {
  wordsPerSecond: number;
  speakingRate: number; // Will be between 5 and 35
}

export function calculateSpeakingRate({
  translatedText,
  start,
  end,
}: SpeakingRateInput): SpeakingRateResult {
  // Calculate duration in seconds
  const duration = end - start;

  // Calculate word count (excluding empty strings)
  const wordCount = translatedText
    .split(/\s+/)
    .filter((word) => word.length > 0).length;

  // Calculate words per second
  const wordsPerSecond = wordCount / duration;

  // Base speaking rate (middle of the range)
  const BASE_RATE = 15;

  // Calculate speaking rate based on words per second
  // More words per second = higher speaking rate needed
  let speakingRate = BASE_RATE * (wordsPerSecond / 2); // 2 is a normalization factor

  // Clamp the speaking rate between 5 and 35
  const MIN_RATE = 5;
  const MAX_RATE = 35;
  speakingRate = Math.min(Math.max(speakingRate, MIN_RATE), MAX_RATE);

  return {
    wordsPerSecond,
    speakingRate,
  };
}
