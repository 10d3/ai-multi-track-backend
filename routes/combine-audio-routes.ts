import express from 'express';
import path from 'path';
import { v4 as uuidv4 } from "uuid";
import fs from 'fs';
import { exec } from 'child_process';
import { Storage } from "@google-cloud/storage";
import { downloadAudioFile } from '../utils/utils';

const router = express.Router();

const storageGoogle = new Storage({
  keyFilename: path.join(
    __dirname,
    "..",
    "config",
    "endless-bolt-430416-h3-e0a89a12879b.json"
  ),
});

router.post("/", async (req, res) => {
  const { audioUrls } = req.body;
  console.log(audioUrls);

  if (!audioUrls || !Array.isArray(audioUrls) || audioUrls.length === 0) {
    return res
      .status(400)
      .json({ error: "Aucune URL d'audio n'a été fournie." });
  }

  try {
    const tempFilePaths: string[] = [];

    for (let url of audioUrls) {
      const tempFilePath = path.join(__dirname, "..", `temp_${uuidv4()}.mp3`);
      await downloadAudioFile(url, tempFilePath);
      tempFilePaths.push(tempFilePath);
    }

    const outputFilename = `audio_${uuidv4()}.mp3`;
    let ffmpegCommand = `ffmpeg`;

    tempFilePaths.forEach((filePath) => {
      ffmpegCommand += ` -i ${filePath}`;
    });
    ffmpegCommand += ` -filter_complex "concat=n=${tempFilePaths.length}:v=0:a=1[out]" -map "[out]" ${outputFilename}`;

    console.log(ffmpegCommand);

    exec(ffmpegCommand, async (error) => {
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
          resumable: false,
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
        res.status(200).json({ audioUrl: publicUrl });
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
});

export const combineAudioRoutes = router;
