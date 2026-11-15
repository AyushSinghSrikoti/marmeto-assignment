import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { config } from "#/config";

mkdirSync(dirname(config.databasePath), { recursive: true });

export const database = new DatabaseSync(config.databasePath);

export function initializeDatabase(): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      address_json TEXT NOT NULL,
      items_json TEXT NOT NULL,
      shipment_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (shipment_status IN ('pending', 'unknown', 'confirmed', 'failed')),
      shipment_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      webhook_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      delivery_count INTEGER NOT NULL DEFAULT 1 CHECK (delivery_count >= 1),
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'retry_wait', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TEXT,
      locked_at TEXT,
      locked_by TEXT,
      reconciliation_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (reconciliation_attempts >= 0),
      next_reconciliation_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS jobs_due_idx
      ON jobs(status, next_attempt_at);
  `);

  database.exec("BEGIN IMMEDIATE");

  try {
    const webhookColumns = database
      .prepare("PRAGMA table_info(webhook_events)")
      .all() as Array<{ name: string }>;
    const webhookColumnNames = new Set(
      webhookColumns.map((column) => column.name),
    );

    if (!webhookColumnNames.has("delivery_count")) {
      database.exec(`
        ALTER TABLE webhook_events
        ADD COLUMN delivery_count INTEGER NOT NULL DEFAULT 1;
      `);
    }

    if (!webhookColumnNames.has("last_received_at")) {
      database.exec(`
        ALTER TABLE webhook_events
        ADD COLUMN last_received_at TEXT;

        UPDATE webhook_events
        SET last_received_at = received_at
        WHERE last_received_at IS NULL;
      `);
    }

    const jobColumns = database
      .prepare("PRAGMA table_info(jobs)")
      .all() as Array<{ name: string }>;
    const jobColumnNames = new Set(jobColumns.map((column) => column.name));

    if (!jobColumnNames.has("reconciliation_attempts")) {
      database.exec(`
        ALTER TABLE jobs
        ADD COLUMN reconciliation_attempts INTEGER NOT NULL DEFAULT 0
          CHECK (reconciliation_attempts >= 0);
      `);
    }

    if (!jobColumnNames.has("next_reconciliation_at")) {
      database.exec(`
        ALTER TABLE jobs
        ADD COLUMN next_reconciliation_at TEXT;
      `);
    }

    database.exec(`
      CREATE INDEX IF NOT EXISTS jobs_reconciliation_idx
        ON jobs(status, reconciliation_attempts, next_reconciliation_at);
    `);

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
