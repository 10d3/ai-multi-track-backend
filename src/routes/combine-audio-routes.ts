import express from "express";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import { execSync, exec } from "child_process";
import { Storage } from "@google-cloud/storage";
import { downloadAudioFile } from "../utils/utils";

const router = express.Router();
const auth = require("../middleware/auth");

const storageGoogle = new Storage({
  keyFilename: path.join(
    __dirname,
    "..",
    "config",
    "endless-bolt-430416-h3-e0a89a12879b.json"
  ),
});

router.post("/", auth, async (req, res) => {
  const { audioUrls, transcript, originalAudioUrl } = req.body;

  if (!audioUrls || !Array.isArray(audioUrls) || audioUrls.length === 0) {
    return res
      .status(400)
      .json({ error: "Aucune URL d'audio n'a été fournie." });
  }

  try {
    // Download and convert all speech files to WAV format
    const tempFilePaths: string[] = [];
    for (let url of audioUrls) {
      const tempFilePath = path.join(__dirname, "..", `temp_${uuidv4()}.mp3`);
      await downloadAudioFile(url, tempFilePath);

      // Convert to WAV format
      const convertedFilePath = path.join(
        __dirname,
        "..",
        `converted_${uuidv4()}.wav`
      );
      execSync(`ffmpeg -i "${tempFilePath}" "${convertedFilePath}"`);
      tempFilePaths.push(convertedFilePath);

      // Clean up the original downloaded file
      fs.unlinkSync(tempFilePath);
    }

    // Download and convert the original audio to WAV format
    const originalAudioPath = path.join(
      __dirname,
      "..",
      `original_${uuidv4()}.mp3`
    );
    await downloadAudioFile(originalAudioUrl, originalAudioPath);
    const convertedOriginalAudioPath = path.join(
      __dirname,
      "..",
      `converted_original_${uuidv4()}.wav`
    );
    execSync(
      `ffmpeg -i "${originalAudioPath}" "${convertedOriginalAudioPath}"`
    );

    const spleeterOutputDir = path.join(
      __dirname,
      "..",
      `spleeter_output_${uuidv4()}`
    );
    fs.mkdirSync(spleeterOutputDir, { recursive: true });

    // Call the Python script with arguments
    const spleeterCommand = `python3 ./src/script/separate_audio.py "${convertedOriginalAudioPath}" "${spleeterOutputDir}"`;
    console.log("Spleeter Python Command:", spleeterCommand);

    try {
      execSync(spleeterCommand);
    } catch (error) {
      console.error("Error executing Spleeter Python script:", error);
      res.status(500).json({ error: error });
    }

    // Debugging: List the contents of the spleeter output directory
    const files = fs.readdirSync(spleeterOutputDir);
    console.log("Files in Spleeter output directory:", files);

    // Move the accompaniment file to a desired location
    const backgroundAudioPath = path.join(
      __dirname,
      `background_${uuidv4()}.wav`
    );

    fs.renameSync(
      path.join(spleeterOutputDir, "accompaniment.wav"), // Updated to match actual Spleeter output structure
      backgroundAudioPath
    );

    // Clean up the Spleeter output directory
    fs.rmdirSync(spleeterOutputDir, { recursive: true });

    // Combine the separated background audio with TTS speech
    const outputFilename = `audio_${uuidv4()}.wav`;
    const filterComplexParts = [];
    let inputIndex = 0;

    // Add background audio as the first input
    filterComplexParts.push(`[0:a]volume=1[bg];`);

    // Iterate over the transcript to position each speech segment
    for (let i = 0; i < transcript.length; i++) {
      const { start, end } = transcript[i];
      const startTime = start / 1000;
      const endTime = end / 1000;

      // Add corresponding TTS speech with delay
      filterComplexParts.push(
        `[${i + 1}:a]adelay=${Math.round(startTime * 1000)}|${Math.round(
          startTime * 1000
        )}[delayed${i}];`
      );
      filterComplexParts.push(
        `[bg][delayed${i}]amix=inputs=2:duration=longest:dropout_transition=2,volume=0.9[bg${i}];`
      );
    }

    // Final output
    filterComplexParts.push(`[bg${transcript.length - 1}]`);

    // Construct the FFmpeg command
    let ffmpegCombineCmd = `ffmpeg -i "${backgroundAudioPath}" ${tempFilePaths
      .map((file) => `-i "${file}"`)
      .join(" ")} -filter_complex "${filterComplexParts.join(" ")}" -map "[bg${
      transcript.length - 1
    }]" "${outputFilename}"`;

    exec(ffmpegCombineCmd, async (error) => {
      tempFilePaths.forEach(fs.unlinkSync);

      if (error) {
        console.error(`Erreur lors de la combinaison audio : ${error.message}`);
        return res.status(500).json({ error: error.message });
      }

      try {
        const bucketName = "ai-multi-track";
        await storageGoogle
          .bucket(bucketName)
          .upload(outputFilename, { resumable: false });
        const [publicUrl] = await storageGoogle
          .bucket(bucketName)
          .file(outputFilename)
          .getSignedUrl({
            action: "read",
            expires: "03-09-2491",
          });

        res.status(200).json({ audioUrl: publicUrl });
        fs.unlinkSync(outputFilename);
        fs.unlinkSync(originalAudioPath);
        fs.unlinkSync(convertedOriginalAudioPath);
        fs.unlinkSync(backgroundAudioPath);
      } catch (uploadError) {
        console.error(
          "Erreur lors du téléchargement du fichier audio :",
          uploadError
        );
        res
          .status(500)
          .json({ error: "Erreur lors du téléchargement du fichier audio" });
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error });
  }
});

export const combineAudioRoutes = router;
