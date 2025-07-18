import { PrismaClient } from "@prisma/client";
import { voices } from "../utils/constant/voices";
import type { JobData } from "../utils/types/type";
import { audioProcessingQueue } from "../utils/queue";

const prisma = new PrismaClient();

// We don't need a separate interface as we're using the JobData type directly

export const getTranscreationData = async (id: string) => {
  const transcreationData = await prisma.transcreation.findUnique({
    where: {
      id,
    },
  });
  return transcreationData;
};

/**
 * Formats transcreation data to match the worker's expected JobData format
 * @param transcreationId The ID of the transcreation to process
 * @returns Formatted JobData object ready for the audio processing worker
 */
export const formatTranscreationForWorker = async (
  transcreationId: string
): Promise<JobData> => {
  // Fetch transcreation with all related data
  const transcreation = await prisma.transcreation.findUnique({
    where: { id: transcreationId },
    include: {
      user: true,
      transcript: {
        include: {
          metadataTranscript: {
            // include: {
            //   speakerCharacteristics: true,
            // },
          },
        },
        orderBy: { start: "asc" }, // Ensure transcripts are ordered by start time
      },
    },
  });

  if (!transcreation) {
    throw new Error(`Transcreation with ID ${transcreationId} not found`);
  }

  if (!transcreation.originalAudioURL) {
    throw new Error(
      `Transcreation ${transcreationId} has no original audio URL`
    );
  }

  // Map transcripts to the format expected by the worker
  const transcript = transcreation.transcript.map((t) => ({
    start: t.start, // Convert milliseconds to seconds if needed
    end: t.end, // Convert milliseconds to seconds if needed
    text: t.textTranslated || t.text, // Use translated text if available, otherwise original
    speaker: t.speaker,
    emotion: t.emotion,
    voice: t.voice || '', // Use voice from transcript if available
  }));

  // console.log(transcript[0])

  // Get language code for TTS
  const languageCode = transcreation.toLanguage || "en-US";

  // Find appropriate voices for the target language
  const availableVoices = voices.filter(
    (v) =>
      v.languageCodes &&
      v.languageCodes.some((lc) => lc.startsWith(languageCode))
  );

  // Create TTS requests from transcript data
  const ttsRequests = transcreation.transcript.map((t) => {
    // Format text as SSML for better TTS results
    const ssmlText = `${t.textTranslated || t.text}`;
    const emotion = t.emotion
    const start = t.start
    const end = t.end

    // Get voice information from transcript or use defaults
    let voiceName = t.voice || '';
    let voiceId = t.voice || '';

    // If no voice specified, select based on speaker characteristics if available
    if (!voiceName && t.metadataTranscript) {
      voiceName = t.voice ? t.voice : "";
    }

    // console.log("TTS Request:", {
    //   textToSpeech: ssmlText,
    //   voice_id: voiceId,
    //   voice_name: voiceName,
    //   output_format: "MP3",
    // });

    return {
      textToSpeech: ssmlText,
      voice_id: voiceId,
      voice_name: voiceName,
      output_format: "MP3",
      emotion,
      start,
      end,
      priority : transcreation.priority
    };
  });

  // console.log(ttsRequests[0])

  // Create the job data object
  const jobData: JobData = {
    originalAudioUrl: transcreation.originalAudioURL,
    transcript,
    ttsRequests,
    userEmail: transcreation.user.email as string,
    email: transcreation.user.email as string, // Add this for compatibility with notifyAPI
    language: transcreation.toLanguage || "en-US", // Add language information
    id: transcreationId,
    priority : transcreation.priority
  };

  return jobData;
};

/**
 * Creates or updates an AudioProcess record for a transcreation
 * @param transcreationId The ID of the transcreation
 * @param status The status of the audio process
 * @param finalAudio The URL of the final audio (if completed)
 */
export const updateAudioProcessStatus = async (
  transcreationId: string,
  status: string = "progress",
  finalAudio?: string
) => {
  return prisma.audioProcess.upsert({
    where: {
      transcreationId,
    },
    update: {
      status,
      ...(finalAudio && { finalAudio }),
    },
    create: {
      transcreationId,
      status,
      ...(finalAudio && { finalAudio }),
    },
  });
};

/**
 * Initiates audio processing for a transcreation
 * @param transcreationId The ID of the transcreation to process
 * @returns The job ID for tracking
 */
export const startAudioProcessing = async (transcreationId: string) => {
  try {
    // Format the data for the worker
    const jobData = await formatTranscreationForWorker(transcreationId);

    // Create or update the audio process record
    await updateAudioProcessStatus(transcreationId, "processing");

    // Add the job to the queue
    const job = await audioProcessingQueue.add('audio-processing', jobData, {
      jobId: `audio-job-${transcreationId}`,
      removeOnComplete: false,
      removeOnFail: false,
      priority: jobData.priority
    });

    // Update the transcreation with the job ID
    await prisma.transcreation.update({
      where: { id: transcreationId },
      data: { jobId: job.id },
    });

    return job.id;
  } catch (error) {
    // Update status to failed
    await updateAudioProcessStatus(transcreationId, "failed");
    throw error;
  }
};
