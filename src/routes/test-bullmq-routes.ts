import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { audioProcessingQueue } from '../utils/queue';
// import { audioProcessingQueue } from './queue'; // Import the BullMQ queue

const router = express.Router();
const auth = require('../middleware/auth');

router.post('/', async (req, res) => {
  const { audioUrls, transcript, originalAudioUrl } = req.body;

  if (!audioUrls || !Array.isArray(audioUrls) || audioUrls.length === 0) {
    return res.status(400).json({ error: "Aucune URL d'audio n'a été fournie." });
  }

  try {
    // Enqueue the job for audio processing
    const job = await audioProcessingQueue.add('processAudio', {
      audioUrls,
      transcript,
      originalAudioUrl
    });

    console.log(job.id);

    res.status(200).json({ message: 'Job enqueued', jobId: job.id });
  } catch (error) {
    console.error('Error enqueueing job:', error);
    res.status(500).json({ error: 'Failed to enqueue job' });
  }
});

export const combineAudioBullRoutes = router;
