# Marmeto Backend Integrations Take-Home

A small TypeScript service that accepts order webhooks and creates courier shipments safely in the background.

The project handles duplicate webhooks, courier rate limits, server errors, request timeouts, worker crashes, and the case where the courier creates a shipment but its response is lost.

## Requirements

- Node.js 22.13 or newer
- npm

No Redis, Docker, or external database is required. SQLite is included with Node.js.

## Start the project

Install the dependencies:

```bash
npm install
```

Start the API, worker, reconciler, and mock courier together:

```bash
npm run dev
```

The processes run on:

| Process | Address | Purpose |
|---|---|---|
| API | `http://localhost:3000` | Accepts webhooks |
| Worker | Background process | Creates shipments |
| Reconciler | Background process | Resolves final uncertain requests |
| Mock courier | `http://localhost:4000` | Simulates an unreliable courier |

The default values work without creating a `.env` file.

## Quick test

Open another terminal while `npm run dev` is running.

### 1. Check the API

Windows PowerShell:

```powershell
curl.exe -i http://localhost:3000/health
```

macOS or Linux:

```bash
curl -i http://localhost:3000/health
```

Expected response:

```json
{"status":"ok"}
```

### 2. Send a correctly signed order webhook

The signature below is already calculated for the exact JSON body and the default `development-secret`. Copy and run the command without changing it.

Windows PowerShell:

```powershell
curl.exe -i -w "\nResponse time: %{time_total}s\n" -X POST http://localhost:3000/webhooks/orders-create -H "Content-Type: application/json" -H "X-Shop-Webhook-Id: webhook-1001" -H "X-Shop-Hmac-Sha256: GpbeqlDakjd5+BxSkWNAjPkuyGMiA5cJx3kn+yCSys0=" --data-raw '{"id":"order-1001","address":{"name":"Ayush Singh","line1":"123 Test Street","city":"Ghaziabad","postalCode":"201010","country":"India"},"items":[{"sku":"shoe-001","quantity":1}]}'
```

macOS or Linux:

```bash
curl -i -w "\nResponse time: %{time_total}s\n" -X POST http://localhost:3000/webhooks/orders-create -H "Content-Type: application/json" -H "X-Shop-Webhook-Id: webhook-1001" -H "X-Shop-Hmac-Sha256: GpbeqlDakjd5+BxSkWNAjPkuyGMiA5cJx3kn+yCSys0=" --data-raw '{"id":"order-1001","address":{"name":"Ayush Singh","line1":"123 Test Street","city":"Ghaziabad","postalCode":"201010","country":"India"},"items":[{"sku":"shoe-001","quantity":1}]}'
```

Expected API response on a fresh database:

```json
{"accepted":true,"orderId":"order-1001","duplicate":false}
```

The API returns immediately. Shipment creation continues in the worker.

### 3. Send the duplicate webhook

Run the same command from step 2 again. Alternatively, copy the matching command below.

Windows PowerShell:

```powershell
curl.exe -i -X POST http://localhost:3000/webhooks/orders-create -H "Content-Type: application/json" -H "X-Shop-Webhook-Id: webhook-1001" -H "X-Shop-Hmac-Sha256: GpbeqlDakjd5+BxSkWNAjPkuyGMiA5cJx3kn+yCSys0=" --data-raw '{"id":"order-1001","address":{"name":"Ayush Singh","line1":"123 Test Street","city":"Ghaziabad","postalCode":"201010","country":"India"},"items":[{"sku":"shoe-001","quantity":1}]}'
```

macOS or Linux:

```bash
curl -i -X POST http://localhost:3000/webhooks/orders-create -H "Content-Type: application/json" -H "X-Shop-Webhook-Id: webhook-1001" -H "X-Shop-Hmac-Sha256: GpbeqlDakjd5+BxSkWNAjPkuyGMiA5cJx3kn+yCSys0=" --data-raw '{"id":"order-1001","address":{"name":"Ayush Singh","line1":"123 Test Street","city":"Ghaziabad","postalCode":"201010","country":"India"},"items":[{"sku":"shoe-001","quantity":1}]}'
```

Expected response:

```json
{"accepted":true,"orderId":"order-1001","duplicate":true}
```

The duplicate increases the webhook delivery count but does not create another order, job, or shipment request.

### 4. Try an invalid signature

Windows PowerShell:

```powershell
curl.exe -i -X POST http://localhost:3000/webhooks/orders-create -H "Content-Type: application/json" -H "X-Shop-Webhook-Id: invalid-webhook" -H "X-Shop-Hmac-Sha256: invalid-signature" --data-raw '{"id":"invalid-order","address":{"city":"Ghaziabad"},"items":[]}'
```

macOS or Linux:

```bash
curl -i -X POST http://localhost:3000/webhooks/orders-create -H "Content-Type: application/json" -H "X-Shop-Webhook-Id: invalid-webhook" -H "X-Shop-Hmac-Sha256: invalid-signature" --data-raw '{"id":"invalid-order","address":{"city":"Ghaziabad"},"items":[]}'
```

Expected status and response:

```text
HTTP/1.1 401 Unauthorized
```

```json
{"error":"Invalid webhook signature"}
```

## Inspect the result

The SQLite database is stored at `storage/app.db`.

### View orders

```bash
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('./storage/app.db', { readOnly: true }); console.table(db.prepare('SELECT order_id, shipment_status, shipment_id, last_error FROM orders ORDER BY created_at DESC').all()); db.close();"
```

A successful order eventually looks like:

```text
order_id     shipment_status  shipment_id  last_error
order-1001   confirmed        <UUID>       null
```

### View jobs

```bash
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('./storage/app.db', { readOnly: true }); console.table(db.prepare('SELECT id, order_id, status, attempts, reconciliation_attempts, last_error FROM jobs ORDER BY id DESC').all()); db.close();"
```

### View webhook delivery counts

```bash
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('./storage/app.db', { readOnly: true }); console.table(db.prepare('SELECT webhook_id, order_id, delivery_count, received_at, last_received_at FROM webhook_events ORDER BY received_at DESC').all()); db.close();"
```

After running the duplicate example, `delivery_count` is `2`.

### Query the mock courier

Windows PowerShell:

```powershell
curl.exe -s "http://localhost:4000/shipments?reference=order-1001"
```

macOS or Linux:

```bash
curl -s "http://localhost:4000/shipments?reference=order-1001"
```

If shipment creation has completed, the courier returns:

```json
[{"shipmentId":"<UUID>","reference":"order-1001"}]
```

## Failure behaviour

The mock courier intentionally behaves unpredictably on shipment creation:

| Outcome | Probability | Worker behaviour |
|---|---:|---|
| `201 Created` | About 60% | Saves the shipment and completes the job |
| `500` | About 20% | Retries with exponential backoff |
| `429` | About 10% | Respects `Retry-After` |
| Creates shipment and delays response for 10 seconds | About 10% | Times out, then checks the courier before another POST |

Each courier request times out after 3 seconds. A job has at most 5 total attempts. Retry delays are capped at 30 seconds, including values received through `Retry-After`.

## How duplicate shipments are avoided

For a new order, the worker sends POST directly. Immediately before POST, it records the order as `unknown`, meaning a courier request may now be in progress.

If the request succeeds, the shipment ID is saved and the order becomes `confirmed`.

An explicit `500` or `429` means the request was rejected, so the order returns to `pending` and can be posted again later.

For a timeout, network failure, or worker crash, the order remains `unknown`. The next worker attempt calls:

```text
GET /shipments?reference=<orderId>
```

It sends another POST only when that GET succeeds and returns an empty list.

## Final reconciliation

After the fifth attempt:

- A definite failure becomes `order=failed` and `job=failed`. It is parked and ignored by automatic reconciliation.
- An uncertain failure becomes `order=unknown` and `job=failed`.

The reconciler runs immediately on startup and then every 60 seconds. It selects only `unknown + failed` records, in batches of at most 100. It never scans normal pending or definite failed orders.

For each selected record, it performs GET only:

- Shipment found: mark the order `confirmed` and job `completed`.
- Empty list: mark the order permanently `failed`.
- GET fails: retry reconciliation at most 3 times, then mark it permanently `failed`.

The reconciler never creates a shipment.

## Architecture

```text
Store webhook
      |
      v
Express API -- SQLite transaction --> order + webhook audit + queued job
      |
      | HTTP 202
      v
Store receives response

SQLite job --> worker --> mock courier
                           |
                           v
                 shipment result or failure
                           |
                           v
                        SQLite

Unknown final result --> reconciler --> courier GET --> SQLite
```

The order, webhook audit record, and queue job are inserted in one SQLite transaction. The API responds only after that transaction commits.

Workers claim one due job at a time using a database write transaction and a lease. Multiple workers cannot normally process the same job. A crashed worker's lease is recovered after 30 seconds.

## Why SQLite and a database-backed queue

SQLite keeps the assignment self-contained and makes the queue durable without requiring Redis.

Advantages:

- One dependency-free data store
- Atomic order and job creation
- Jobs survive process restarts
- Easy local setup and inspection

Trade-offs:

- SQLite serializes writes and is not intended for large distributed deployments
- Polling is less efficient than a dedicated queue such as BullMQ
- A production deployment would use PostgreSQL or a managed queue with stronger operational tooling

## Configuration

All settings are optional:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Integration API port |
| `WEBHOOK_SECRET` | `development-secret` | HMAC shared secret |
| `COURIER_BASE_URL` | `http://localhost:4000` | Courier address used by the worker |
| `MOCK_COURIER_PORT` | `4000` | Local mock courier port |
| `DB_PATH` | `./storage/app.db` | SQLite database location |

If `WEBHOOK_SECRET` changes, the precomputed sample signature will no longer be valid.

## Production build

```bash
npm run typecheck
npm run build
npm start
```

## Deliberately left out

- Authentication for operational/admin endpoints
- A user interface
- Docker and cloud deployment
- Distributed locking across several machines
- Persistent storage inside the mock courier
- Claims of guaranteed exactly-once delivery, because the courier does not support idempotency keys

## With another day

- Add structured metrics and tracing
- Add alerts for parked jobs and repeated rate limiting
- Move queue processing to PostgreSQL or a managed queue for horizontal scaling
- Add authentication and authorization around operational actions
- Add retention policies for old webhook audit records and completed jobs
