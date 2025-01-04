import express from "express";
import bodyParser from "body-parser";
import path from "path";
import { configureApp } from "./config/app-config";
import { ytRoutes } from "./routes/yt-routes";
import { isolateSpeakersRoutes } from "./routes/isolate-speakers-routes";
import { audioRoutes } from "./routes/audio-routes";
import { combineAudioRoutes } from "./routes/combine-audio-routes";
import { signUpRoutes } from "./routes/sign-up-routes";
import { loginRoutes } from "./routes/login-routes";
import { refreshTokenRoutes } from "./routes/refresh-token";
import { convertToAudioRoutes } from "./routes/convert-to-audio-routes";
import { jobStatusRoutes } from "./routes/job-status-route";
import { combineAudioBullRoutes } from "./routes/test-bullmq-routes";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = Number(process.env.SERVER_PORT) || 8090;
const auth = require("./middleware/auth");

configureApp(app);

app.use(bodyParser.json());
// app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/yt", ytRoutes);
app.use("/api/isolate-speakers", isolateSpeakersRoutes);
app.use("/api/audio", audioRoutes);
app.use("/api/combine-audio", combineAudioRoutes);
app.use("/api/sign-up", signUpRoutes);
app.use("/api/login", loginRoutes);
app.use("/api/refresh-token", refreshTokenRoutes);
app.use("/api/convert-to-audio", auth, convertToAudioRoutes);
app.use("/api/job-status", jobStatusRoutes);
app.use("/api/test-bull", combineAudioBullRoutes);

app.use((req, res) => {
  console.log("Headers received:", req.headers);
  res.sendFile(path.join(__dirname, "../public", "api-documentation.html"));
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
