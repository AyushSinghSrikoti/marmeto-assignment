import { database } from "#/database";

export interface FailedJob {
  id: number;
  orderId: string;
  orderStatus: "unknown" | "failed";
  attempts: number;
  reconciliationAttempts: number;
  lastError: string | null;
  updatedAt: string;
}

interface FailedJobRow {
  id: number;
  order_id: string;
  shipment_status: "unknown" | "failed";
  attempts: number;
  reconciliation_attempts: number;
  last_error: string | null;
  updated_at: string;
}

export function listFailedJobs(): FailedJob[] {
  const rows = database
    .prepare(`
      SELECT
        jobs.id,
        jobs.order_id,
        orders.shipment_status,
        jobs.attempts,
        jobs.reconciliation_attempts,
        jobs.last_error,
        jobs.updated_at
      FROM jobs
      INNER JOIN orders ON orders.order_id = jobs.order_id
      WHERE jobs.status = 'failed'
      ORDER BY jobs.updated_at DESC, jobs.id DESC
    `)
    .all() as unknown as FailedJobRow[];

  return rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    orderStatus: row.shipment_status,
    attempts: row.attempts,
    reconciliationAttempts: row.reconciliation_attempts,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  }));
}

export function replayFailedJob(jobId: number): string {
  database.exec("BEGIN IMMEDIATE");

  try {
    const job = database
      .prepare(`
        SELECT order_id
        FROM jobs
        WHERE id = ?
          AND status = 'failed'
          AND locked_by IS NULL
      `)
      .get(jobId) as { order_id: string } | undefined;

    if (!job) {
      throw new Error(`Failed job ${jobId} was not found or is currently locked`);
    }

    const result = database
      .prepare(`
        UPDATE jobs
        SET
          status = 'queued',
          attempts = 0,
          next_attempt_at = CURRENT_TIMESTAMP,
          locked_at = NULL,
          locked_by = NULL,
          reconciliation_attempts = 0,
          next_reconciliation_at = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status = 'failed'
          AND locked_by IS NULL
      `)
      .run(jobId);

    if (Number(result.changes) !== 1) {
      throw new Error(`Failed job ${jobId} could not be replayed`);
    }

    database
      .prepare(`
        UPDATE orders
        SET
          shipment_status = 'unknown',
          shipment_id = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE order_id = ?
      `)
      .run(job.order_id);

    database.exec("COMMIT");
    return job.order_id;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
