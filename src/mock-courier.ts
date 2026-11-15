import { randomUUID } from "node:crypto";

import express from "express";

import { config } from "#/config";

interface Shipment {
  shipmentId: string;
  reference: string;
  address: Record<string, unknown>;
  items: unknown[];
}

export const mockCourierApp = express();
const shipments: Shipment[] = [];

mockCourierApp.disable("x-powered-by");
mockCourierApp.use(express.json());

mockCourierApp.post("/shipments", (request, response) => {
  const { reference, address, items } = request.body ?? {};

  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    typeof address !== "object" ||
    address === null ||
    Array.isArray(address) ||
    !Array.isArray(items)
  ) {
    response.status(400).json({ error: "Invalid shipment payload" });
    return;
  }

  const outcome = Math.random();

  if (outcome < 0.2) {
    response.status(500).json({ error: "Courier service failed" });
    return;
  }

  if (outcome < 0.3) {
    response.set("Retry-After", "2");
    response.status(429).json({ error: "Too many requests" });
    return;
  }

  const shipment: Shipment = {
    shipmentId: randomUUID(),
    reference,
    address: address as Record<string, unknown>,
    items,
  };

  shipments.push(shipment);

  if (outcome < 0.4) {
    setTimeout(() => {
      if (!response.headersSent) {
        response.status(201).json({
          shipmentId: shipment.shipmentId,
          reference: shipment.reference,
        });
      }
    }, 10_000);
    return;
  }

  response.status(201).json({
    shipmentId: shipment.shipmentId,
    reference: shipment.reference,
  });
});

mockCourierApp.get("/shipments", (request, response) => {
  const reference = request.query.reference;

  if (typeof reference !== "string" || reference.length === 0) {
    response.status(400).json({ error: "reference is required" });
    return;
  }

  response.status(200).json(
    shipments
      .filter((shipment) => shipment.reference === reference)
      .map(({ shipmentId, reference: shipmentReference }) => ({
        shipmentId,
        reference: shipmentReference,
      })),
  );
});

mockCourierApp.listen(config.mockCourierPort, () => {
  console.log(
    `Mock courier listening on http://localhost:${config.mockCourierPort}`,
  );
});
