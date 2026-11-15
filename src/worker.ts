import { randomUUID } from "node:crypto";

import {
  CourierRequestError,
  createShipment,
  findShipments,
} from "#/courier-client";
import { database, initializeDatabase } from "#/database";
import {
  claimNextJob,
  confirmShipment,
  failJob,
  markShipmentAttemptUnknown,
  recoverStaleJobs,
  retryJob,
  type ClaimedJob,
} from "#/job-store";

const pollIntervalMs = 1_000;
const leaseTimeoutSeconds = 30;
const maximumAttempts = 5;
const maximumRetryDelaySeconds = 30;
const workerId = `shipment-worker-${process.pid}-${randomUUID()}`;

let running = true;
let lastRecoveryAt = 0;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function processJob(job: ClaimedJob): Promise<void> {
  const address = JSON.parse(job.addressJson) as Record<string, unknown>;
  const items = JSON.parse(job.itemsJson) as unknown[];
  let shipment =
    job.shipmentStatus === "confirmed" && job.shipmentId
      ? { shipmentId: job.shipmentId, reference: job.orderId }
      : undefined;
  let reconciled = false;

  if (!shipment && job.shipmentStatus === "unknown") {
    const existingShipments = await findShipments(job.orderId);

    if (existingShipments.length > 1) {
      console.warn(
        `Courier returned ${existingShipments.length} shipments for order ${job.orderId}`,
      );
    }

    shipment = existingShipments[0];
    reconciled = shipment !== undefined;
  }

  if (!shipment) {
    markShipmentAttemptUnknown(job.id, workerId, job.orderId);
    shipment = await createShipment({
      reference: job.orderId,
      address,
      items,
    });
  }

  confirmShipment(
    job.id,
    workerId,
    job.orderId,
    shipment.shipmentId,
  );

  console.log(
    JSON.stringify({
      event: "shipment_confirmed",
      workerId,
      jobId: job.id,
      orderId: job.orderId,
      attempt: job.attempt,
      shipmentId: shipment.shipmentId,
      reconciled,
    }),
  );
}

function retryDelaySeconds(job: ClaimedJob, error: unknown): number {
  if (
    error instanceof CourierRequestError &&
    error.retryAfterSeconds !== undefined
  ) {
    return Math.min(error.retryAfterSeconds, maximumRetryDelaySeconds);
  }

  return Math.min(2 ** (job.attempt - 1), maximumRetryDelaySeconds);
}

function shipmentStatusAfterError(
  error: unknown,
): "pending" | "unknown" {
  if (error instanceof CourierRequestError && !error.outcomeUncertain) {
    return "pending";
  }

  return "unknown";
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
    } catch (error) {
      if (job.attempt >= maximumAttempts) {
        failJob(job.id, workerId, job.orderId, error);
        console.error(
          `Shipment job ${job.id} parked after ${job.attempt} attempts`,
          error,
        );
        continue;
      }

      const delaySeconds = retryDelaySeconds(job, error);
      retryJob(
        job.id,
        workerId,
        job.orderId,
        error,
        delaySeconds,
        shipmentStatusAfterError(error),
      );
      console.error(
        `Shipment job ${job.id} will retry in ${delaySeconds} second(s)`,
        error,
      );
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
