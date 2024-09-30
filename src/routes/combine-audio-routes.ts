import express from "express";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import { exec, execSync } from "child_process";
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
    return res.status(400).json({ error: "Aucune URL d'audio n'a été fournie." });
  }

  try {
    // Download and convert all speech files to WAV format
    const tempFilePaths: string[] = [];
    for (let url of audioUrls) {
      const tempFilePath = path.join(__dirname, "..", `temp_${uuidv4()}.mp3`);
      await downloadAudioFile(url, tempFilePath);

      // Convert to WAV format
      const convertedFilePath = path.join(__dirname, "..", `converted_${uuidv4()}.wav`);
      execSync(`ffmpeg -i "${tempFilePath}" "${convertedFilePath}"`);
      tempFilePaths.push(convertedFilePath);

      // Clean up the original downloaded file
      fs.unlinkSync(tempFilePath);
    }

    // Download and convert the original audio to WAV format
    const originalAudioPath = path.join(__dirname, "..", `original_${uuidv4()}.mp3`);
    await downloadAudioFile(originalAudioUrl, originalAudioPath);
    const convertedOriginalAudioPath = path.join(__dirname, "..", `converted_original_${uuidv4()}.wav`);
    execSync(`ffmpeg -i "${originalAudioPath}" "${convertedOriginalAudioPath}"`);

    const outputFilename = `audio_${uuidv4()}.wav`;
    let previousEnd = 0;
    const combinedSegments: string[] = [];

    // Iterate over the transcript to extract background and mix TTS
    for (let i = 0; i < transcript.length; i++) {
      const { start, end } = transcript[i];

      // Extract background audio before the speech
      if (start > previousEnd) {
        const backgroundSegment = path.join(__dirname, `background_${i}.wav`);
        const ffmpegExtractCmd = `ffmpeg -i ${convertedOriginalAudioPath} -ss ${previousEnd / 1000} -to ${(start - 150 > previousEnd ? start - 150 : previousEnd + 1) / 1000} -c copy ${backgroundSegment}`;
        execSync(ffmpegExtractCmd);
        combinedSegments.push(backgroundSegment);
      }

      // Add corresponding TTS speech
      combinedSegments.push(tempFilePaths[i]);
      previousEnd = end;
    }

    // Extract any remaining background after the last speech
    const finalBackground = path.join(__dirname, `background_final.wav`);
    const ffmpegFinalExtractCmd = `ffmpeg -i ${convertedOriginalAudioPath} -ss ${previousEnd / 1000} -c copy ${finalBackground}`;
    execSync(ffmpegFinalExtractCmd);
    combinedSegments.push(finalBackground);

    // Combine all parts into one final audio
    let ffmpegCombineCmd = `ffmpeg`;
    combinedSegments.forEach((segment) => {
      ffmpegCombineCmd += ` -i ${segment}`;
    });
    ffmpegCombineCmd += ` -filter_complex "concat=n=${combinedSegments.length}:v=0:a=1[out]" -map "[out]" ${outputFilename}`;

    exec(ffmpegCombineCmd, async (error) => {
      combinedSegments.forEach(fs.unlinkSync);

      if (error) {
        console.error(`Erreur lors de la combinaison audio : ${error.message}`);
        return res.status(500).json({ error: error.message });
      }

      try {
        const bucketName = "ai-multi-track";
        await storageGoogle.bucket(bucketName).upload(outputFilename, { resumable: false });
        const [publicUrl] = await storageGoogle.bucket(bucketName).file(outputFilename).getSignedUrl({
          action: "read",
          expires: "03-09-2491",
        });

        res.status(200).json({ audioUrl: publicUrl });
        fs.unlinkSync(outputFilename);
        fs.unlinkSync(originalAudioPath);
        fs.unlinkSync(convertedOriginalAudioPath);
      } catch (uploadError) {
        console.error("Erreur lors du téléchargement du fichier audio :", uploadError);
        res.status(500).json({ error: "Erreur lors du téléchargement du fichier audio" });
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error });
  }
});

export const combineAudioRoutes = router;
