import { randomUUID } from "node:crypto";

import { database, initializeDatabase } from "#/database";
import {
  claimNextJob,
  completeJob,
  failJob,
  recoverStaleJobs,
  type ClaimedJob,
} from "#/job-store";

const pollIntervalMs = 1_000;
const leaseTimeoutSeconds = 30;
const workerId = `shipment-worker-${process.pid}-${randomUUID()}`;

let running = true;
let lastRecoveryAt = 0;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function processJob(job: ClaimedJob): Promise<void> {
  const address = JSON.parse(job.addressJson) as Record<string, unknown>;
  const items = JSON.parse(job.itemsJson) as unknown[];

  console.log(
    JSON.stringify({
      event: "shipment_job_processed",
      workerId,
      jobId: job.id,
      orderId: job.orderId,
      attempt: job.attempt,
      address,
      items,
    }),
  );
}

async function run(): Promise<void> {
  initializeDatabase();
  console.log(`Shipment worker started: ${workerId}`);

  while (running) {
    const now = Date.now();

    if (now - lastRecoveryAt >= leaseTimeoutSeconds * 1_000) {
      const recoveredJobs = recoverStaleJobs(leaseTimeoutSeconds);

      if (recoveredJobs > 0) {
        console.log(`Recovered ${recoveredJobs} expired job lease(s)`);
      }

      lastRecoveryAt = now;
    }

    const job = claimNextJob(workerId);

    if (!job) {
      await delay(pollIntervalMs);
      continue;
    }

    try {
      await processJob(job);
      completeJob(job.id, workerId);
    } catch (error) {
      failJob(job.id, workerId, error);
      console.error(`Shipment job ${job.id} failed`, error);
    }
  }

  database.close();
}

process.once("SIGINT", () => {
  running = false;
});

process.once("SIGTERM", () => {
  running = false;
});

run().catch((error: unknown) => {
  console.error("Shipment worker stopped unexpectedly", error);
  process.exitCode = 1;
});
