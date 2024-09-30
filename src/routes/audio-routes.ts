import express from 'express';
import multer from 'multer';
import path from 'path';
import { exec } from 'child_process';
import fs from 'fs';

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });
const auth = require('../middleware/auth');

router.post("/", auth, upload.single("videoFile"), async (req, res) => {
  const file = req.file;

  if (!file) {
    console.log("Invalid request: no video file provided");
    return res
      .status(400)
      .json({ error: "Invalid request: no video file provided" });
  }

  try {
    console.log("Processing video file");

    const inputPath = path.join(__dirname, file.path);
    const outputPath = path.join(__dirname, "..", "public", "audio.mp3");
    const absoluteUrl = `http://${req.headers.host}/audio.mp3`;

    const ffmpegCommand = `ffmpeg -i ${inputPath} -q:a 0 -map a ${outputPath}`;

    exec(ffmpegCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error during ffmpeg process: ${error.message}`);
        return res.status(500).json({ error: "Failed to process video" });
      }

      if (stderr) {
        console.error(`ffmpeg stderr: ${stderr}`);
      }

      console.log(`ffmpeg stdout: ${stdout}`);

      res.json({ message: "Video processed successfully", absoluteUrl });

      fs.unlinkSync(inputPath);
    });
  } catch (error) {
    console.error("Error processing video:", error);
    res.status(500).json({ error: "Failed to process video" });
  }
});

export const audioRoutes = router;
