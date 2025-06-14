import fs from "fs";
import path from "path";
import { exec } from "child_process";

interface SegmentProps {
  text: string;
  start: number;
  end: number;
  speaker: string;
}

interface IsolateSpeakersProps {
  transcription: SegmentProps[];
  audioFilePath: string;
}

interface ExtractedSegment {
  start: number;
  end: number;
  filePath: string;
}

interface SpeakerSegments {
  [speaker: string]: ExtractedSegment[];
}

export async function isolateSpeakers({
  transcription,
  audioFilePath,
}: IsolateSpeakersProps): Promise<SpeakerSegments> {
  const speakers: SpeakerSegments = {};

  transcription.forEach((segment: SegmentProps) => {
    const { speaker, start, end } = segment;
    if (!speakers[speaker]) {
      speakers[speaker] = [];
    }
    speakers[speaker].push({ start, end, filePath: "" });
  });

  const extractionPromises = Object.keys(speakers).map((speaker) => {
    const speakerSegments = speakers[speaker];
    return Promise.all(
      speakerSegments.map((segment, index) => {
        return new Promise<void>((resolve, reject) => {
          const outputFilePath = path.join(
            process.cwd(),
            `speaker_${speaker}_segment_${index}.mp3`
          );
          const command = `ffmpeg -i ${audioFilePath} -ss ${
            segment.start / 1000
          } -to ${segment.end / 1000} -c copy ${outputFilePath}`;

          exec(command, (error, stdout, stderr) => {
            if (error) {
              reject(`Error extracting segment: ${error.message}`);
            } else {
              // console.log(`Extracted segment to: ${outputFilePath}`);
              segment.filePath = outputFilePath;
              resolve();
            }
          });
        });
      })
    );
  });

  return Promise.all(extractionPromises).then(() => speakers);
}
