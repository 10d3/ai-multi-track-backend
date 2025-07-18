import express from "express";
import { audioProcessingQueue } from "../utils/queue";

const router = express.Router();

router.get("/:jobId", async (req, res) => {
  const { jobId } = req.params;

  // console.log(jobId)

  try {
    const job = await audioProcessingQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Get the job's state ('completed', 'failed', 'waiting', etc.)
    const state = await job.getState();

    // Progress (either manually tracked or automatically)
    const progress = job.progress || 0;

    // Calculate remaining time (if job is delayed)
    const remainingTime =
      job.opts && job.opts.delay && job.timestamp
        ? Math.max(0, job.timestamp + job.opts.delay - Date.now())
        : 0;

    // Get detailed job data, excluding the transcript
    const { transcript, ...jobData } = job.data; // Exclude transcript

    // Get the job's result or error
    let result = null;
    let error = null;

    if (state === "completed") {
      result = job.returnvalue;
    } else if (state === "failed") {
      error = job.failedReason;
    }

    // Create a title from the first five words of the transcript
    // console.log("Transcript value:", transcript);
    // console.log("Transcript type:", typeof transcript);
    const title =
      typeof transcript === "string"
        ? transcript.split(" ").slice(0, 5).join(" ")
        : transcript[0].text.split(" ").slice(0, 5).join(" ");

    // Respond with detailed job information, including the title
    res.status(200).json({
      state,
      progress,
      remainingTime,
      result,
      error,
      jobData,
      title, // Include the title in the response
    });
  } catch (error) {
    console.error("Error fetching job status:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch job status", details: error });
  }
});

export const jobStatusRoutes = router;
