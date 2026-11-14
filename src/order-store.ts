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
    const existingWebhook = database
      .prepare("SELECT webhook_id FROM webhook_events WHERE webhook_id = ?")
      .get(webhookId);

    if (existingWebhook) {
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
        INSERT INTO webhook_events (webhook_id, order_id)
        VALUES (?, ?)
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
