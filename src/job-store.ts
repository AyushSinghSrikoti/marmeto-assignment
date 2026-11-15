import { database } from "#/database";

export interface ClaimedJob {
  id: number;
  orderId: string;
  attempt: number;
  addressJson: string;
  itemsJson: string;
  shipmentStatus: "pending" | "unknown" | "confirmed" | "failed";
  shipmentId: string | null;
}

interface JobRow {
  id: number;
  order_id: string;
  attempts: number;
  address_json: string;
  items_json: string;
  shipment_status: "pending" | "unknown" | "confirmed" | "failed";
  shipment_id: string | null;
}

export function recoverStaleJobs(leaseTimeoutSeconds: number): number {
  const result = database
    .prepare(`
      UPDATE jobs
      SET
        status = 'queued',
        locked_at = NULL,
        locked_by = NULL,
        next_attempt_at = CURRENT_TIMESTAMP,
        last_error = 'Recovered expired worker lease',
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'processing'
        AND locked_at <= datetime('now', ?)
    `)
    .run(`-${leaseTimeoutSeconds} seconds`);

  return Number(result.changes);
}

export function claimNextJob(workerId: string): ClaimedJob | undefined {
  database.exec("BEGIN IMMEDIATE");

  try {
    const job = database
      .prepare(`
        SELECT
          jobs.id,
          jobs.order_id,
          jobs.attempts,
          orders.address_json,
          orders.items_json,
          orders.shipment_status,
          orders.shipment_id
        FROM jobs
        INNER JOIN orders ON orders.order_id = jobs.order_id
        WHERE jobs.status IN ('queued', 'retry_wait')
          AND (
            jobs.next_attempt_at IS NULL
            OR jobs.next_attempt_at <= CURRENT_TIMESTAMP
          )
        ORDER BY COALESCE(jobs.next_attempt_at, jobs.created_at), jobs.id
        LIMIT 1
      `)
      .get() as JobRow | undefined;

    if (!job) {
      database.exec("COMMIT");
      return undefined;
    }

    const claimResult = database
      .prepare(`
        UPDATE jobs
        SET
          status = 'processing',
          attempts = attempts + 1,
          locked_at = CURRENT_TIMESTAMP,
          locked_by = ?,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status IN ('queued', 'retry_wait')
      `)
      .run(workerId, job.id);

    if (Number(claimResult.changes) !== 1) {
      database.exec("ROLLBACK");
      return undefined;
    }

    database.exec("COMMIT");

    return {
      id: job.id,
      orderId: job.order_id,
      attempt: job.attempts + 1,
      addressJson: job.address_json,
      itemsJson: job.items_json,
      shipmentStatus: job.shipment_status,
      shipmentId: job.shipment_id,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function markShipmentAttemptUnknown(
  jobId: number,
  workerId: string,
  orderId: string,
): void {
  const result = database
    .prepare(`
      UPDATE orders
      SET
        shipment_status = 'unknown',
        updated_at = CURRENT_TIMESTAMP
      WHERE order_id = ?
        AND EXISTS (
          SELECT 1
          FROM jobs
          WHERE jobs.id = ?
            AND jobs.order_id = orders.order_id
            AND jobs.status = 'processing'
            AND jobs.locked_by = ?
        )
    `)
    .run(orderId, jobId, workerId);

  if (Number(result.changes) !== 1) {
    throw new Error(`Worker ${workerId} no longer owns job ${jobId}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function confirmShipment(
  jobId: number,
  workerId: string,
  orderId: string,
  shipmentId: string,
): void {
  database.exec("BEGIN IMMEDIATE");

  try {
    const jobResult = database
      .prepare(`
        UPDATE jobs
        SET
          status = 'completed',
          locked_at = NULL,
          locked_by = NULL,
          next_attempt_at = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND order_id = ?
          AND status = 'processing'
          AND locked_by = ?
      `)
      .run(jobId, orderId, workerId);

    if (Number(jobResult.changes) !== 1) {
      throw new Error(`Worker ${workerId} no longer owns job ${jobId}`);
    }

    database
      .prepare(`
        UPDATE orders
        SET
          shipment_status = 'confirmed',
          shipment_id = ?,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE order_id = ?
      `)
      .run(shipmentId, orderId);

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function retryJob(
  jobId: number,
  workerId: string,
  orderId: string,
  error: unknown,
  delaySeconds: number,
  shipmentStatus: "pending" | "unknown",
): void {
  const message = errorMessage(error);

  database.exec("BEGIN IMMEDIATE");

  try {
    const jobResult = database
      .prepare(`
        UPDATE jobs
        SET
          status = 'retry_wait',
          locked_at = NULL,
          locked_by = NULL,
          next_attempt_at = datetime('now', ?),
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status = 'processing'
          AND locked_by = ?
      `)
      .run(`+${delaySeconds} seconds`, message, jobId, workerId);

    if (Number(jobResult.changes) !== 1) {
      throw new Error(`Worker ${workerId} no longer owns job ${jobId}`);
    }

    database
      .prepare(`
        UPDATE orders
        SET
          shipment_status = ?,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE order_id = ?
      `)
      .run(shipmentStatus, message, orderId);

    database.exec("COMMIT");
  } catch (retryError) {
    database.exec("ROLLBACK");
    throw retryError;
  }
}

export function failJob(
  jobId: number,
  workerId: string,
  orderId: string,
  error: unknown,
  shipmentStatus: "unknown" | "failed",
): void {
  const message = errorMessage(error);

  database.exec("BEGIN IMMEDIATE");

  try {
    const jobResult = database
      .prepare(`
        UPDATE jobs
        SET
          status = 'failed',
          locked_at = NULL,
          locked_by = NULL,
          next_attempt_at = NULL,
          reconciliation_attempts = 0,
          next_reconciliation_at = CASE
            WHEN ? = 'unknown' THEN datetime('now', '+5 seconds')
            ELSE NULL
          END,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status = 'processing'
          AND locked_by = ?
      `)
      .run(shipmentStatus, message, jobId, workerId);

    if (Number(jobResult.changes) !== 1) {
      throw new Error(`Worker ${workerId} no longer owns job ${jobId}`);
    }

    database
      .prepare(`
        UPDATE orders
        SET
          shipment_status = ?,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE order_id = ?
      `)
      .run(shipmentStatus, message, orderId);

    database.exec("COMMIT");
  } catch (failureError) {
    database.exec("ROLLBACK");
    throw failureError;
  }
}
