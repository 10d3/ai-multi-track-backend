import express from 'express';
import { Storage } from "@google-cloud/storage";
import { v4 as uuidv4 } from "uuid";
import path from 'path';
import { exec } from 'child_process';
import fs from 'fs';

const router = express.Router();
const auth = require('../middleware/auth');

const storageGoogle = new Storage({
  keyFilename: path.join(
    __dirname,
    "..",
    "config",
    "endless-bolt-430416-h3-e0a89a12879b.json"
  ),
});

router.post("/", auth, async (req, res) => {
  console.log(req.body);
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }
  const filePath = `audio_${uuidv4()}.mp3`;
  const bucketName = "ai-multi-track";

  exec(
    `python download_audio.py ${url} ${filePath}`,
    async (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${error.message}`);
        return res.status(500).json({ error: "Failed to download audio" });
      }
      if (stderr) {
        console.error(`Stderr: ${stderr}`);
        return res
          .status(500)
          .json({ error: "Error occurred during download" });
      }
      try {
        await storageGoogle.bucket(bucketName).upload(filePath, {
          resumable: false,
        });
        await storageGoogle.bucket(bucketName).file(filePath).getSignedUrl({
          action: "read",
          expires: "03-09-2491",
        });

        const publicUrl = `https://storage.googleapis.com/${bucketName}/${filePath}`;
        console.log(`Public URL: ${publicUrl}`);
        res.json({ publicUrl });
        fs.unlinkSync(filePath);
      } catch (error) {
        res.status(500).json({ error: error });
      }
    }
  );
});

export const ytRoutes = router;
