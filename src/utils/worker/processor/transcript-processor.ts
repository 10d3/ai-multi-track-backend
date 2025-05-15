import type { Transcript } from "../../types/type";

export class TranscriptProcessor {
  /**
   * Process and sort transcript segments chronologically regardless of speaker
   *
   * @param transcripts - Array of transcript segments that may be grouped by speaker
   * @returns Sorted array of transcript segments in chronological order
   */
  sortTranscriptChronologically(transcripts: Transcript[]): Transcript[] {
    // Validate input
    if (!transcripts || transcripts.length === 0) {
      return [];
    }

    // Create a deep copy to avoid modifying the original
    const transcriptsCopy = JSON.parse(JSON.stringify(transcripts));

    // Sort all segments by start time, regardless of speaker
    return transcriptsCopy.sort((a: Transcript, b: Transcript) => {
      // Handle cases where start might be undefined
      if (a.start === undefined && b.start === undefined) return 0;
      if (a.start === undefined) return 1;
      if (b.start === undefined) return -1;

      return a.start - b.start;
    });
  }

  /**
   * Merge transcript segments from multiple speakers into a single chronological array
   *
   * @param speakerTranscripts - Object with speaker IDs as keys and arrays of their transcript segments as values
   * @returns Combined and chronologically sorted array of all transcript segments
   */
  mergeAndSortMultiSpeakerTranscripts(
    speakerTranscripts: Record<string, Transcript[]>
  ): Transcript[] {
    // First, flatten all speaker transcripts into a single array
    const allSegments: Transcript[] = [];

    for (const speakerId in speakerTranscripts) {
      if (Object.prototype.hasOwnProperty.call(speakerTranscripts, speakerId)) {
        const speakerSegments = speakerTranscripts[speakerId];

        // Ensure speaker ID is attached to each segment
        const segmentsWithSpeaker = speakerSegments.map((segment) => ({
          ...segment,
          speakerId, // Ensure the speaker ID is preserved
        }));

        allSegments.push(...segmentsWithSpeaker);
      }
    }

    // Then sort by start time
    return this.sortTranscriptChronologically(allSegments);
  }

  /**
   * Format a chronological transcript for display or export
   *
   * @param sortedTranscript - Chronologically sorted transcript segments
   * @param speakerNames - Optional mapping of speaker IDs to display names
   * @returns Formatted string representation of the conversation
   */
  formatChronologicalTranscript(
    sortedTranscript: Transcript[],
    speakerNames?: Record<string, string>
  ): string {
    if (!sortedTranscript || sortedTranscript.length === 0) {
      return "No transcript available.";
    }

    return sortedTranscript
      .map((segment) => {
        const speakerName =
          segment.speaker && speakerNames
            ? speakerNames[segment.speaker] || `Speaker ${segment.speaker}`
            : segment.speaker || "Unknown Speaker";

        const timeStr =
          segment.start !== undefined
            ? `[${this.formatTime(segment.start)} - ${this.formatTime(
                segment.end || segment.start
              )}]`
            : "";

        return `${speakerName} ${timeStr}: ${segment.text}`;
      })
      .join("\n");
  }

  /**
   * Format time in seconds to MM:SS format
   *
   * @param timeInSeconds - Time in seconds
   * @returns Formatted time string
   */
  private formatTime(timeInSeconds: number): string {
    const minutes = Math.floor(timeInSeconds / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    return `${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  }

  /**
   * Group transcript segments by speaker
   *
   * @param transcripts - Array of transcript segments
   * @returns Object with speaker IDs as keys and arrays of their transcript segments as values
   */
  groupTranscriptsBySpeaker(
    transcripts: Transcript[]
  ): Record<string, Transcript[]> {
    const speakerGroups: Record<string, Transcript[]> = {};

    transcripts.forEach((segment) => {
      const speakerId = segment.speaker || "unknown";

      if (!speakerGroups[speakerId]) {
        speakerGroups[speakerId] = [];
      }

      speakerGroups[speakerId].push(segment);
    });

    return speakerGroups;
  }
}
