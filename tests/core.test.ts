import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

const testDirectory = mkdtempSync(join(tmpdir(), "marmeto-tests-"));
process.env.DB_PATH = join(testDirectory, "app.db");

const { database, initializeDatabase } = await import("#/database");
const { listFailedJobs, replayFailedJob } = await import("#/failed-job-store");
const { claimNextJob } = await import("#/job-store");
const { acceptOrder } = await import("#/order-store");
const { verifyWebhookSignature } = await import("#/webhook-signature");

function clearDatabase(): void {
  database.exec(`
    DELETE FROM webhook_events;
    DELETE FROM jobs;
    DELETE FROM orders;
    DELETE FROM sqlite_sequence WHERE name = 'jobs';
  `);
}

before(() => {
  initializeDatabase();
});

beforeEach(() => {
  clearDatabase();
});

after(() => {
  database.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

test("verifies the exact webhook body and rejects a different body", () => {
  const secret = "test-secret";
  const body = Buffer.from('{"id":"order-1"}');
  const signature = createHmac("sha256", secret).update(body).digest("base64");

  assert.equal(verifyWebhookSignature(body, signature, secret), true);
  assert.equal(
    verifyWebhookSignature(Buffer.from('{"id":"order-2"}'), signature, secret),
    false,
  );
});

test("deduplicates repeated webhook IDs and repeated order IDs", () => {
  const order = {
    orderId: "order-1",
    address: { city: "Ghaziabad" },
    items: [{ sku: "shoe-1", quantity: 1 }],
  };

  assert.deepEqual(acceptOrder("webhook-1", order), { duplicate: false });
  assert.deepEqual(acceptOrder("webhook-1", order), { duplicate: true });
  assert.deepEqual(acceptOrder("webhook-2", order), { duplicate: true });

  const orderCount = database.prepare("SELECT COUNT(*) AS count FROM orders").get() as {
    count: number;
  };
  const jobCount = database.prepare("SELECT COUNT(*) AS count FROM jobs").get() as {
    count: number;
  };
  const deliveries = database
    .prepare(`
      SELECT webhook_id, delivery_count
      FROM webhook_events
      ORDER BY webhook_id
    `)
    .all() as Array<{ webhook_id: string; delivery_count: number }>;

  assert.equal(orderCount.count, 1);
  assert.equal(jobCount.count, 1);
  assert.deepEqual(deliveries.map((delivery) => ({ ...delivery })), [
    { webhook_id: "webhook-1", delivery_count: 2 },
    { webhook_id: "webhook-2", delivery_count: 1 },
  ]);
});

test("allows only one worker to claim a queued job", () => {
  acceptOrder("webhook-1", {
    orderId: "order-1",
    address: { city: "Ghaziabad" },
    items: [],
  });

  const firstClaim = claimNextJob("worker-1");
  const secondClaim = claimNextJob("worker-2");

  assert.equal(firstClaim?.orderId, "order-1");
  assert.equal(firstClaim?.attempt, 1);
  assert.equal(secondClaim, undefined);
});

test("lists and safely requeues a failed job for reconciliation first", () => {
  acceptOrder("webhook-1", {
    orderId: "order-1",
    address: { city: "Ghaziabad" },
    items: [],
  });

  database.exec(`
    UPDATE orders
    SET shipment_status = 'failed', last_error = 'Courier unavailable';

    UPDATE jobs
    SET
      status = 'failed',
      attempts = 5,
      reconciliation_attempts = 2,
      last_error = 'Courier unavailable';
  `);

  const failedJobs = listFailedJobs();

  assert.equal(failedJobs.length, 1);
  assert.equal(failedJobs[0]?.orderId, "order-1");
  assert.equal(failedJobs[0]?.attempts, 5);

  const orderId = replayFailedJob(failedJobs[0]?.id ?? 0);
  assert.equal(orderId, "order-1");

  const replayedJob = database
    .prepare(`
      SELECT status, attempts, reconciliation_attempts, last_error
      FROM jobs
    `)
    .get() as {
    status: string;
    attempts: number;
    reconciliation_attempts: number;
    last_error: string | null;
  };
  const replayedOrder = database
    .prepare("SELECT shipment_status, last_error FROM orders")
    .get() as { shipment_status: string; last_error: string | null };

  assert.deepEqual({ ...replayedJob }, {
    status: "queued",
    attempts: 0,
    reconciliation_attempts: 0,
    last_error: null,
  });
  assert.deepEqual({ ...replayedOrder }, {
    shipment_status: "unknown",
    last_error: null,
  });

  const claimedReplay = claimNextJob("worker-1");
  assert.equal(claimedReplay?.shipmentStatus, "unknown");
});

test("refuses to replay a job that is not failed", () => {
  acceptOrder("webhook-1", {
    orderId: "order-1",
    address: { city: "Ghaziabad" },
    items: [],
  });

  assert.throws(() => replayFailedJob(1), /not found or is currently locked/);
});
