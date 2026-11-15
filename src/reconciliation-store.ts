import { database } from "#/database";

export interface ClaimedReconciliation {
  jobId: number;
  orderId: string;
  attempt: number;
}

interface ReconciliationRow {
  id: number;
  order_id: string;
  reconciliation_attempts: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function claimNextReconciliation(
  reconcilerId: string,
  maximumAttempts: number,
  leaseTimeoutSeconds: number,
): ClaimedReconciliation | undefined {
  database.exec("BEGIN IMMEDIATE");

  try {
    const job = database
      .prepare(`
        SELECT jobs.id, jobs.order_id, jobs.reconciliation_attempts
        FROM jobs
        INNER JOIN orders ON orders.order_id = jobs.order_id
        WHERE jobs.status = 'failed'
          AND orders.shipment_status = 'unknown'
          AND jobs.reconciliation_attempts < ?
          AND (
            jobs.next_reconciliation_at IS NULL
            OR jobs.next_reconciliation_at <= CURRENT_TIMESTAMP
          )
          AND (
            jobs.locked_at IS NULL
            OR jobs.locked_at <= datetime('now', ?)
          )
        ORDER BY COALESCE(jobs.next_reconciliation_at, jobs.updated_at), jobs.id
        LIMIT 1
      `)
      .get(maximumAttempts, `-${leaseTimeoutSeconds} seconds`) as
      | ReconciliationRow
      | undefined;

    if (!job) {
      database.exec("COMMIT");
      return undefined;
    }

    const result = database
      .prepare(`
        UPDATE jobs
        SET
          reconciliation_attempts = reconciliation_attempts + 1,
          next_reconciliation_at = NULL,
          locked_at = CURRENT_TIMESTAMP,
          locked_by = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status = 'failed'
      `)
      .run(reconcilerId, job.id);

    if (Number(result.changes) !== 1) {
      database.exec("ROLLBACK");
      return undefined;
    }

    database.exec("COMMIT");

    return {
      jobId: job.id,
      orderId: job.order_id,
      attempt: job.reconciliation_attempts + 1,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function confirmReconciledShipment(
  job: ClaimedReconciliation,
  reconcilerId: string,
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
          next_reconciliation_at = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND order_id = ?
          AND status = 'failed'
          AND locked_by = ?
      `)
      .run(job.jobId, job.orderId, reconcilerId);

    if (Number(jobResult.changes) !== 1) {
      throw new Error(
        `Reconciler ${reconcilerId} no longer owns job ${job.jobId}`,
      );
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
      .run(shipmentId, job.orderId);

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function finishReconciliationWithoutShipment(
  job: ClaimedReconciliation,
  reconcilerId: string,
): void {
  const message = "No courier shipment found during reconciliation";
  finishReconciliation(job, reconcilerId, message);
}

export function failReconciliation(
  job: ClaimedReconciliation,
  reconcilerId: string,
  error: unknown,
): void {
  finishReconciliation(job, reconcilerId, errorMessage(error));
}

function finishReconciliation(
  job: ClaimedReconciliation,
  reconcilerId: string,
  message: string,
): void {
  database.exec("BEGIN IMMEDIATE");

  try {
    const jobResult = database
      .prepare(`
        UPDATE jobs
        SET
          locked_at = NULL,
          locked_by = NULL,
          next_reconciliation_at = NULL,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status = 'failed'
          AND locked_by = ?
      `)
      .run(message, job.jobId, reconcilerId);

    if (Number(jobResult.changes) !== 1) {
      throw new Error(
        `Reconciler ${reconcilerId} no longer owns job ${job.jobId}`,
      );
    }

    database
      .prepare(`
        UPDATE orders
        SET
          shipment_status = 'failed',
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE order_id = ?
      `)
      .run(message, job.orderId);

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function retryReconciliation(
  job: ClaimedReconciliation,
  reconcilerId: string,
  error: unknown,
  delaySeconds: number,
): void {
  const message = errorMessage(error);
  const result = database
    .prepare(`
      UPDATE jobs
      SET
        locked_at = NULL,
        locked_by = NULL,
        next_reconciliation_at = datetime('now', ?),
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'failed'
        AND locked_by = ?
    `)
    .run(`+${delaySeconds} seconds`, message, job.jobId, reconcilerId);

  if (Number(result.changes) !== 1) {
    throw new Error(
      `Reconciler ${reconcilerId} no longer owns job ${job.jobId}`,
    );
  }
}
