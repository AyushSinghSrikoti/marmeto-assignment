import { randomUUID } from "node:crypto";

import express from "express";

import { config } from "#/config";

interface Shipment {
  shipmentId: string;
  reference: string;
  address: Record<string, unknown>;
  items: unknown[];
}

type CourierOutcome = "success" | "server-error" | "rate-limit" | "timeout";

const outcomeSequence: CourierOutcome[] = [
  "success",
  "server-error",
  "success",
  "rate-limit",
  "success",
  "timeout",
  "success",
  "server-error",
  "success",
  "success",
];

export const mockCourierApp = express();
const shipments: Shipment[] = [];
let nextOutcomeIndex = 0;

function getNextOutcome(): CourierOutcome {
  const outcome = outcomeSequence[nextOutcomeIndex];
  nextOutcomeIndex = (nextOutcomeIndex + 1) % outcomeSequence.length;
  return outcome ?? "success";
}

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

  const outcome = getNextOutcome();

  if (outcome === "server-error") {
    console.log(JSON.stringify({ event: "courier_server_error", reference }));
    response.status(500).json({ error: "Courier service failed" });
    return;
  }

  if (outcome === "rate-limit") {
    console.log(JSON.stringify({ event: "courier_rate_limited", reference }));
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

  if (outcome === "timeout") {
    console.log(
      JSON.stringify({
        event: "courier_shipment_created_response_delayed",
        reference,
        shipmentId: shipment.shipmentId,
      }),
    );
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

  console.log(
    JSON.stringify({
      event: "courier_shipment_created",
      reference,
      shipmentId: shipment.shipmentId,
    }),
  );
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

  const matchingShipments = shipments
    .filter((shipment) => shipment.reference === reference)
    .map(({ shipmentId, reference: shipmentReference }) => ({
      shipmentId,
      reference: shipmentReference,
    }));

  console.log(
    JSON.stringify({
      event: "courier_shipments_looked_up",
      reference,
      count: matchingShipments.length,
    }),
  );
  response.status(200).json(matchingShipments);
});

mockCourierApp.listen(config.mockCourierPort, () => {
  console.log(
    `Mock courier listening on http://localhost:${config.mockCourierPort}`,
  );
});
