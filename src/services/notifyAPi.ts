import axios from "axios";

export async function notifyAPI(job:any) {
  const MAX_RETRIES = 3;
  let retries = 0;

  while (retries < MAX_RETRIES) {
    try {
      const response = await axios.post(
        "https://sayitai.com/api/finish-job-emailing",
        {
          isCompleded: true,
          email: job.data.email,
          jobId: job.id,
          title:
            job.data.transcript.length > 0
              ? job.data.transcript[0].text.split(" ").slice(0, 5).join(" ")
              : "",
          language: job.data.language,
        }
      );
      if (response.status !== 200) {
        console.error(`Unexpected status code from API: ${response.status}`);
      } else {
        console.log("API notified successfully:", response.data);
      }
    //   console.log("API notified successfully:", response.data);
      break; // Exit loop on success
    } catch (error:any) {
      retries++;
      console.error(
        `Error notifying API for job ${job.id} (Attempt ${retries}):`,
        error.message
      );
      if (retries === MAX_RETRIES) {
        console.error("Max retries reached. Failed to notify API.");
      } else {
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}
