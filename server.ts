import type { Request, Response, NextFunction } from "express";
import { isolateSpeakers } from "./isolate-speaker";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { promisify } from "util";
import * as dotenv from "dotenv";
import { Storage } from "@google-cloud/storage";
import axios from "axios";
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const rateLimit = require("express-rate-limit");
const slowDown = require("express-slow-down");
const app = express();
const port = 8080;
const writeFile = promisify(fs.writeFile);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
});

const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 1,
  delayMs: () => 2000,
});

app.use(speedLimiter);
app.use(limiter);
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

dotenv.config();

const storageGoogle = new Storage({
  keyFilename: path.join(
    __dirname,
    "config",
    "endless-bolt-430416-h3-e0a89a12879b.json"
  ),
});

const storage = multer.memoryStorage();
const upload = multer({ storage });

async function downloadAudioFile(url: string, outputPath: string) {
  const response = await axios({
    method: "get",
    url: url,
    responseType: "arraybuffer",
  });
  await writeFile(outputPath, response.data);
}

app.use((req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'public', 'api-documentation.html'));
});

app.post("/api/yt", async (req: any, res: any) => {
  console.log(req.body);
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }
  const filePath = `audio_${uuidv4()}.mp3`;
  const bucketName = "ai-multi-track";

  exec(
    `python download_audio.py ${url} ${filePath}`,
    async (error: any, stdout: any, stderr: any) => {
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
          resumable: false, // optional, set to true for large files
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

app.post("/api/isolate-speakers", async (req: any, res: any) => {
  console.log(req.body);
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

app.post(
  "/api/audio",
  upload.single("videoFile"),
  async (req: Request, res: Response) => {
    const file = req.file;

    if (!file) {
      console.log("Invalid request: no video file provided");
      return res
        .status(400)
        .json({ error: "Invalid request: no video file provided" });
    }

    try {
      console.log("Processing video file");

      const inputPath = path.join(__dirname, file.path); // Path to uploaded file
      const outputPath = path.join(__dirname, "public", "audio.mp3"); // Path to store extracted audio
      const absoluteUrl = `http://${req.headers.host}/audio.mp3`;

      // Construct the ffmpeg command
      const ffmpegCommand = `ffmpeg -i ${inputPath} -q:a 0 -map a ${outputPath}`;

      exec(
        ffmpegCommand,
        (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            console.error(`Error during ffmpeg process: ${error.message}`);
            return res.status(500).json({ error: "Failed to process video" });
          }

          if (stderr) {
            console.error(`ffmpeg stderr: ${stderr}`);
          }

          console.log(`ffmpeg stdout: ${stdout}`);

          // Return the URL to the audio file
          res.json({ message: "Video processed successfully", absoluteUrl });

          // Optionally delete the original uploaded video file
          fs.unlinkSync(inputPath);
        }
      );
    } catch (error) {
      console.error("Error processing video:", error);
      res.status(500).json({ error: "Failed to process video" });
    }
  }
);

app.post(
  "/api/combine-audio",
  // upload.array("audioFilePaths", 10),
  async (req: any, res: any) => {
    const { audioUrls } = req.body;
    console.log(audioUrls);

    if (!audioUrls || !Array.isArray(audioUrls) || audioUrls.length === 0) {
      return res
        .status(400)
        .json({ error: "Aucune URL d'audio n'a été fournie." });
    }

    try {
      const tempFilePaths: string[] = [];

      // Save audio buffers as temporary files
      for (let url of audioUrls) {
        const tempFilePath = path.join(__dirname, `temp_${uuidv4()}.mp3`);
        await downloadAudioFile(url, tempFilePath);
        tempFilePaths.push(tempFilePath);
      }

      const outputFilename = `audio_${uuidv4()}.mp3`;
      let ffmpegCommand = `ffmpeg`;

      // Add input files
      tempFilePaths.forEach((filePath) => {
        ffmpegCommand += ` -i ${filePath}`;
      });

      // Mix audio with volume control
      // ffmpegCommand += ` -filter_complex [0:a][1:a]amix=inputs=2[outaudio]`;
      // tempFilePaths.forEach((filePath, index) => {
      //   if (index > 0) ffmpegCommand += `[${index}:a]volume=0.5[a${index}]`;
      // });

      // ffmpegCommand += `[a0`;
      // for (let i = 1; i < tempFilePaths.length; i++) {
      //   ffmpegCommand += `,a${i}`;
      // }
      // ffmpegCommand += ` -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[out]" -map "[out]" ${outputFilename}`;
      ffmpegCommand += ` -filter_complex "concat=n=${tempFilePaths.length}:v=0:a=1[out]" -map "[out]" ${outputFilename}`;

      console.log(ffmpegCommand);

      exec(ffmpegCommand, async (error: Error) => {
        // Clean up temp files
        tempFilePaths.forEach(fs.unlinkSync);

        if (error) {
          console.error(
            `Erreur lors de la combinaison audio : ${error.message}`
          );
          return res.status(500).json({ error: error.message });
        }

        try {
          const bucketName = "ai-multi-track";
          console.log(outputFilename);
          await storageGoogle.bucket(bucketName).upload(outputFilename, {
            resumable: false, // optional, set to true for large files
          });
          await storageGoogle
            .bucket(bucketName)
            .file(outputFilename)
            .getSignedUrl({
              action: "read",
              expires: "03-09-2491",
            });

          const publicUrl = `https://storage.googleapis.com/${bucketName}/${outputFilename}`;
          console.log(`Public URL: ${publicUrl}`);
          // Return the URL of the uploaded file
          res.status(200).json({ audioUrl: publicUrl });
          // Clean up the final output file after response
          fs.unlinkSync(outputFilename);
        } catch (uploadError) {
          console.error(
            "Erreur lors du téléchargement du fichier audio :",
            uploadError
          );
          return res
            .status(500)
            .json({ error: "Erreur lors du téléchargement du fichier audio" });
        }
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: error });
    }
  }
);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
