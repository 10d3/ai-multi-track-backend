import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { configureApp } from './config/app-config';
import { ytRoutes } from './routes/yt-routes';
import { isolateSpeakersRoutes } from './routes/isolate-speakers-routes';
import { audioRoutes } from './routes/audio-routes';
import { combineAudioRoutes } from './routes/combine-audio-routes';

const app = express();
const port = 8080;

configureApp(app);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

app.use('/api/yt', ytRoutes);
app.use('/api/isolate-speakers', isolateSpeakersRoutes);
app.use('/api/audio', audioRoutes);
app.use('/api/combine-audio', combineAudioRoutes);

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'api-documentation.html'));
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});