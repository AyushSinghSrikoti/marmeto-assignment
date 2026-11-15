import { database, initializeDatabase } from "#/database";
import { listFailedJobs, replayFailedJob } from "#/failed-job-store";

function run(): void {
  initializeDatabase();

  const [command, value] = process.argv.slice(2);

  if (command === "list") {
    const jobs = listFailedJobs();

    if (jobs.length === 0) {
      console.log("No failed jobs");
      return;
    }

    console.table(jobs);
    return;
  }

  if (command === "replay") {
    const jobId = Number(value);

    if (!Number.isSafeInteger(jobId) || jobId < 1) {
      throw new Error("A positive numeric job ID is required");
    }

    const orderId = replayFailedJob(jobId);
    console.log(`Requeued job ${jobId} for order ${orderId}`);
    return;
  }

  throw new Error("Use either list or replay <jobId>");
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  database.close();
}
