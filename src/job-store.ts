import { database } from "#/database";

export interface ClaimedJob {
  id: number;
  orderId: string;
  attempt: number;
  addressJson: string;
  itemsJson: string;
}

interface JobRow {
  id: number;
  order_id: string;
  attempts: number;
  address_json: string;
  items_json: string;
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
          orders.items_json
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
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function completeJob(jobId: number, workerId: string): void {
  const result = database
    .prepare(`
      UPDATE jobs
      SET
        status = 'completed',
        locked_at = NULL,
        locked_by = NULL,
        next_attempt_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'processing'
        AND locked_by = ?
    `)
    .run(jobId, workerId);

  if (Number(result.changes) !== 1) {
    throw new Error(`Worker ${workerId} no longer owns job ${jobId}`);
  }
}

export function failJob(
  jobId: number,
  workerId: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);

  database
    .prepare(`
      UPDATE jobs
      SET
        status = 'failed',
        locked_at = NULL,
        locked_by = NULL,
        next_attempt_at = NULL,
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'processing'
        AND locked_by = ?
    `)
    .run(message, jobId, workerId);
}
