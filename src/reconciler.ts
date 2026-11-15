import { randomUUID } from "node:crypto";

import { findShipments } from "#/courier-client";
import { database, initializeDatabase } from "#/database";
import {
  claimNextReconciliation,
  confirmReconciledShipment,
  failReconciliation,
  finishReconciliationWithoutShipment,
  retryReconciliation,
  type ClaimedReconciliation,
} from "#/reconciliation-store";

const reconciliationIntervalMs = 60_000;
const pollIntervalMs = 1_000;
const batchSize = 100;
const maximumAttempts = 3;
const leaseTimeoutSeconds = 30;
const reconcilerId = `shipment-reconciler-${process.pid}-${randomUUID()}`;

let running = true;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reconcile(job: ClaimedReconciliation): Promise<void> {
  const shipments = await findShipments(job.orderId);
  const shipment = shipments[0];

  if (!shipment) {
    finishReconciliationWithoutShipment(job, reconcilerId);
    console.log(`No shipment found for uncertain order ${job.orderId}`);
    return;
  }

  if (shipments.length > 1) {
    console.warn(
      `Courier returned ${shipments.length} shipments for order ${job.orderId}`,
    );
  }

  confirmReconciledShipment(job, reconcilerId, shipment.shipmentId);
  console.log(`Reconciled order ${job.orderId} with shipment ${shipment.shipmentId}`);
}

async function reconcileBatch(): Promise<void> {
  for (let processed = 0; processed < batchSize; processed += 1) {
    const job = claimNextReconciliation(
      reconcilerId,
      maximumAttempts,
      leaseTimeoutSeconds,
    );

    if (!job) {
      return;
    }

    try {
      await reconcile(job);
    } catch (error) {
      if (job.attempt >= maximumAttempts) {
        failReconciliation(job, reconcilerId, error);
        console.error(`Reconciliation failed for order ${job.orderId}`, error);
        continue;
      }

      const delaySeconds = 2 ** (job.attempt - 1);
      retryReconciliation(job, reconcilerId, error, delaySeconds);
      console.error(
        `Reconciliation for order ${job.orderId} will retry in ${delaySeconds} second(s)`,
        error,
      );
    }
  }
}

async function run(): Promise<void> {
  initializeDatabase();
  console.log(`Shipment reconciler started: ${reconcilerId}`);

  let nextRunAt = 0;

  while (running) {
    const now = Date.now();

    if (now >= nextRunAt) {
      await reconcileBatch();
      nextRunAt = now + reconciliationIntervalMs;
    }

    await delay(pollIntervalMs);
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
  console.error("Shipment reconciler stopped unexpectedly", error);
  process.exitCode = 1;
});
