import axios from 'axios';
import { promisify } from 'util';
import fs from 'fs';

const writeFile = promisify(fs.writeFile);

export async function downloadAudioFile(url: string, outputPath: string) {
  const response = await axios({
    method: "get",
    url: url,
    responseType: "arraybuffer",
  });
  await writeFile(outputPath, response.data);
}
