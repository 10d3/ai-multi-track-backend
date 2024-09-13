// import type { NextFunction } from "express";
import type { Request, Response, NextFunction } from "express";
import { isolateSpeakers } from "./isolate-speaker";
const ffmpeg = require("fluent-ffmpeg");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const port = 8080;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

app.get("/api", (req: any, res: any) => {
  res.send({
    intro: "Welcome to the combine backend",
    routes: ["/api/isolate-speakers", "/api/combine-audio"],
    parameters: [
      {
        route: "/api/isolate-speakers",
        params: [
          { name: "transcription", type: "string" },
          { name: "audioFilePath", type: "string | audioFile" },
        ],
      },
      {
        route: "/api/combine-audio",
        params: [
          { name: "newAudioFilePath", type: "string | audioFile" },
          { name: "backgroundMusicFilePath", type: "string | audioFile" },
          { name: "outputFilePath", type: "string" },
        ],
      },
    ],
    // documentation: 'https://docs.consumet.org/#tag/zoro',
  });
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

app.post("/api/audio", async (req:Request, res:Response) => {
  const { videoFile } = req.body;

  if (!videoFile) {
    console.log("Invalid request: no video file provided");
    return res.status(400).json({ error: "Invalid request: no video file provided" });
  }

  try {
    console.log("Processing video file");

    const outputPath = path.join(process.cwd(), "audio.mp3").replace(/\\/g, "/");
    const absoluteUrl = `http://${req.headers.host}/audio.mp3`;
    console.log(req.headers.host);

    // Construct the ffmpeg command
    const ffmpegCommand = `ffmpeg -i ${videoFile} -q:a 0 -map a ${outputPath}`;

    exec(ffmpegCommand, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        console.error(`Error during ffmpeg process: ${error.message}`);
        return res.status(500).json({ error: "Failed to process video" });
      }

      if (stderr) {
        console.error(`ffmpeg stderr: ${stderr}`);
      }

      console.log(`ffmpeg stdout: ${outputPath}`);

      // Send the extracted audio file as response
      // res.setHeader("Content-Type", "audio/mpeg");
      // fs.createReadStream(outputPath).pipe(res);
      res.json({ message: "Video processed successfully",absoluteUrl });

      // Optionally delete the file after sending
      // res.on("finish", () => {
      //   fs.unlinkSync(outputPath);
      // });
    });
  } catch (error) {
    console.error("Error processing video:", error);
    res.status(500).json({ error: "Failed to process video" });
  }
});


app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
