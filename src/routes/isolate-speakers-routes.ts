import express from 'express';
import { isolateSpeakers } from '../services/isolate-speaker';

const router = express.Router();
const auth = require('../middleware/auth');

router.post("/", auth, async (req, res) => {
  // console.log(req.body);
  const { transcription, audioFilePath } = req.body;

  if (!transcription || !audioFilePath) {
    return res
      .status(400)
      .json({ error: "Transcription and audioFilePath are required." });
  }

  try {
    const speakers = await isolateSpeakers({ transcription, audioFilePath });
    res.json(speakers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export const isolateSpeakersRoutes = router;
