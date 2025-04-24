import { createReadStream } from "fs";
import path from "path";
import { FileProcessor } from "./file-processor";
import { storageGoogle } from "../../queue";
import { BUCKET_NAME, SIGNED_URL_EXPIRY } from "./constants";

export class StorageProcessor {
  private fileProcessor: FileProcessor;

  constructor(fileProcessor: FileProcessor) {
    this.fileProcessor = fileProcessor;
  }

  async uploadToStorage(filePath: string): Promise<string> {
    try {
      await this.fileProcessor.verifyFile(filePath);

      const bucket = storageGoogle.bucket(BUCKET_NAME);
      const filename = path.basename(filePath);
      const file = bucket.file(filename);

      const readStream = createReadStream(filePath);
      const writeStream = file.createWriteStream({
        resumable: false,
        validation: "md5",
      });

      await new Promise((resolve, reject) => {
        readStream.on("error", (error) => {
          console.error("Read stream error:", error);
          reject(new Error(`Read stream error: ${error.message}`));
        });

        writeStream.on("error", (error) => {
          console.error("Write stream error:", error);
          reject(new Error(`Write stream error: ${error.message}`));
        });

        writeStream.on("finish", resolve);

        readStream.pipe(writeStream);
      });

      const [url] = await file.getSignedUrl({
        action: "read",
        expires: SIGNED_URL_EXPIRY,
      });

      return url;
    } catch (error) {
      console.error("Upload failed:", error);
      throw new Error(`Upload failed: ${error}`);
    }
  }
}