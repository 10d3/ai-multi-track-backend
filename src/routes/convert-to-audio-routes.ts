import express from "express";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { Storage } from "@google-cloud/storage";
import { downloadAudioFile } from "../utils/utils";
import mime from "mime-types"; // to check file types
import { storageGoogle } from "../utils/queue";

const router = express.Router();
// const auth = require("../middleware/auth");
const execPromise = promisify(exec);

// Initialize Google Cloud Storage
// const storageGoogle = new Storage({
//   keyFilename: path.join(
//     __dirname,
//     "..",
//     "config",
//     "endless-bolt-430416-h3-e0a89a12879b.json"
//   ),
// });

const bucketName = "ai-multi-track"; // Replace with your Google Cloud Storage bucket name

// Supported video formats
const supportedFormats = ["video/mp4", "video/x-matroska"]; // .mp4 and .mkv

router.post("/", async (req, res) => {
  const { videoFilePath } = req.body;

  if (!videoFilePath) {
    return res.status(400).json({ error: "videoFilePath is required" });
  }

  try {
    // Check if the video file has a supported format using mime-types
    const mimeType = mime.lookup(videoFilePath);
    if (mimeType === false) {
      return res
        .status(400)
        .json({ error: "Unable to determine video file format" });
    }
    if (!supportedFormats.includes(mimeType)) {
      return res
        .status(400)
        .json({
          error: "Unsupported video format. Only MP4 and MKV are supported.",
        });
    }

    // Temporary paths for downloaded video and audio files
    const tempVideoPath = path.join(
      __dirname,
      "..",
      `temp_${uuidv4()}.${mime.extension(mimeType)}`
    );
    const tempAudioPath = `audio_${uuidv4()}.mp3`

    // Download the video file to the temp directory
    await downloadAudioFile(videoFilePath, tempVideoPath);

    // Convert the video to audio (44100 Hz) using ffmpeg
    await execPromise(
      `ffmpeg -i "${tempVideoPath}" -ar 44100 "${tempAudioPath}"`
    );

    // Upload the audio file to Google Cloud Storage
    // const bucket = storageGoogle.bucket(bucketName);
    // const audioFileName = `audio_${uuidv4()}.mp3`;
    await storageGoogle
      .bucket(bucketName)
      .upload(tempAudioPath, { resumable: false });
    const [publicUrl] = await storageGoogle
      .bucket(bucketName)
      .file(tempAudioPath)
      .getSignedUrl({
        action: "read",
        expires: "03-09-2491",
      });

    // Get the public URL for the uploaded file
    // const audioFileURL = `https://storage.googleapis.com/${bucketName}/${audioFileName}`;

    // Send the URL of the uploaded audio file as the response
    res.status(200).json({ audioUrl: publicUrl });
    // Clean up the temporary files
    fs.unlinkSync(tempVideoPath);
    fs.unlinkSync(tempAudioPath);
  } catch (error) {
    console.error("Error processing video file:", error);
    res.status(500).json({ error: error });
  }
});

export const convertToAudioRoutes = router;
