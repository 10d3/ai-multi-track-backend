import { isolateSpeakers } from "./isolate-speaker";

const express = require("express");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const app = express();
const port = 8080;

app.use(bodyParser.json());

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

app.post("/api/combine-audio", (req: any, res: any) => {
  const { newAudioFilePath, backgroundMusicFilePath, outputFilePath } =
    req.body;

  console.log("Received file paths:");
  console.log("newAudioFilePath:", newAudioFilePath);
  console.log("backgroundMusicFilePath:", backgroundMusicFilePath);
  console.log("outputFilePath:", outputFilePath);

  if (!newAudioFilePath || !backgroundMusicFilePath || !outputFilePath) {
    return res
      .status(400)
      .json({ error: "Missing required file paths in the request body" });
  }

  const ffmpegCommand = `ffmpeg -i "${newAudioFilePath}" -i "${backgroundMusicFilePath}" -filter_complex "[0:a][1:a]amerge=inputs=2[a]" -map "[a]" -ac 2 "${outputFilePath}"`;

  exec(ffmpegCommand, (error: any, stdout: any, stderr: any) => {
    if (error) {
      console.error("Error executing ffmpeg:", error.message);
      console.error("stderr:", stderr);
      return res
        .status(500)
        .json({ error: `Error combining audio: ${stderr}` });
    }
    console.log("stdout:", stdout);
    res.json({ message: "Audio files combined successfully", outputFilePath });
  });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
