import express, { type RequestHandler } from "express";

import { config } from "#/config";
import { acceptOrder, type IncomingOrder } from "#/order-store";
import { verifyWebhookSignature } from "#/webhook-signature";

interface OrderPayload {
  id?: unknown;
  address?: unknown;
  items?: unknown;
}

function parseOrder(rawBody: Buffer): IncomingOrder | undefined {
  let parsedPayload: unknown;

  try {
    parsedPayload = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }

  if (
    typeof parsedPayload !== "object" ||
    parsedPayload === null ||
    Array.isArray(parsedPayload)
  ) {
    return undefined;
  }

  const payload = parsedPayload as OrderPayload;

  const validStringId =
    typeof payload.id === "string" && payload.id.trim().length > 0;
  const validNumberId =
    typeof payload.id === "number" && Number.isSafeInteger(payload.id);
  const validAddress =
    typeof payload.address === "object" &&
    payload.address !== null &&
    !Array.isArray(payload.address);

  if (
    (!validStringId && !validNumberId) ||
    !validAddress ||
    !Array.isArray(payload.items)
  ) {
    return undefined;
  }

  return {
    orderId: String(payload.id),
    address: payload.address as Record<string, unknown>,
    items: payload.items,
  };
}

const handleOrderWebhook: RequestHandler = (request, response, next) => {
  if (!Buffer.isBuffer(request.body)) {
    response.status(400).json({ error: "Request body must be JSON" });
    return;
  }

  const signature = request.get("X-Shop-Hmac-Sha256");

  if (
    !verifyWebhookSignature(request.body, signature, config.webhookSecret)
  ) {
    response.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  const webhookId = request.get("X-Shop-Webhook-Id")?.trim();

  if (!webhookId) {
    response.status(400).json({ error: "Missing X-Shop-Webhook-Id header" });
    return;
  }

  const order = parseOrder(request.body);

  if (!order) {
    response.status(400).json({ error: "Invalid order payload" });
    return;
  }

  try {
    const result = acceptOrder(webhookId, order);

    response.status(202).json({
      accepted: true,
      orderId: order.orderId,
      duplicate: result.duplicate,
    });
  } catch (error) {
    next(error);
  }
};

export const orderWebhookRouter = express.Router();

orderWebhookRouter.post(
  "/orders-create",
  express.raw({ type: "application/json", limit: "100kb" }),
  handleOrderWebhook,
);
