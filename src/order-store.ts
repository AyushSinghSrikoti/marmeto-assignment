import { database } from "#/database";

export interface IncomingOrder {
  orderId: string;
  address: Record<string, unknown>;
  items: unknown[];
}

interface AcceptOrderResult {
  duplicate: boolean;
}

export function acceptOrder(
  webhookId: string,
  order: IncomingOrder,
): AcceptOrderResult {
  database.exec("BEGIN IMMEDIATE");

  try {
    const repeatedDelivery = database
      .prepare(`
        UPDATE webhook_events
        SET
          delivery_count = delivery_count + 1,
          last_received_at = CURRENT_TIMESTAMP
        WHERE webhook_id = ?
      `)
      .run(webhookId);

    if (Number(repeatedDelivery.changes) > 0) {
      database.exec("COMMIT");
      return { duplicate: true };
    }

    const orderResult = database
      .prepare(`
        INSERT INTO orders (order_id, address_json, items_json)
        VALUES (?, ?, ?)
        ON CONFLICT (order_id) DO NOTHING
      `)
      .run(
        order.orderId,
        JSON.stringify(order.address),
        JSON.stringify(order.items),
      );

    database
      .prepare(`
        INSERT INTO webhook_events (
          webhook_id,
          order_id,
          last_received_at
        )
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `)
      .run(webhookId, order.orderId);

    database
      .prepare(`
        INSERT INTO jobs (order_id)
        VALUES (?)
        ON CONFLICT (order_id) DO NOTHING
      `)
      .run(order.orderId);

    database.exec("COMMIT");

    return { duplicate: Number(orderResult.changes) === 0 };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
