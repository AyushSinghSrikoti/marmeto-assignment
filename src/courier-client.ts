import { config } from "#/config";

interface Shipment {
  shipmentId: string;
  reference: string;
}

interface CreateShipmentInput {
  reference: string;
  address: Record<string, unknown>;
  items: unknown[];
}

export class CourierRequestError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
    readonly outcomeUncertain = true,
  ) {
    super(message);
    this.name = "CourierRequestError";
  }
}

const requestTimeoutMs = 3_000;

function isShipment(value: unknown): value is Shipment {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const shipment = value as Record<string, unknown>;
  return (
    typeof shipment.shipmentId === "string" &&
    typeof shipment.reference === "string"
  );
}

function getRetryAfterSeconds(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }

  const retryAt = Date.parse(retryAfter);

  if (Number.isNaN(retryAt)) {
    return undefined;
  }

  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
}

async function courierFetch(
  url: URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown network error";
    throw new CourierRequestError(`Courier request failed: ${message}`);
  }
}

function throwForCourierError(response: Response): void {
  if (response.ok) {
    return;
  }

  throw new CourierRequestError(
    `Courier returned HTTP ${response.status}`,
    response.status === 429 ? getRetryAfterSeconds(response) : undefined,
    false,
  );
}

export async function findShipments(reference: string): Promise<Shipment[]> {
  const url = new URL("/shipments", config.courierBaseUrl);
  url.searchParams.set("reference", reference);

  const response = await courierFetch(url);
  throwForCourierError(response);

  const body: unknown = await response.json();

  if (!Array.isArray(body) || !body.every(isShipment)) {
    throw new CourierRequestError("Courier returned an invalid shipment list");
  }

  return body;
}

export async function createShipment(
  input: CreateShipmentInput,
): Promise<Shipment> {
  const url = new URL("/shipments", config.courierBaseUrl);
  const response = await courierFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  throwForCourierError(response);

  const body: unknown = await response.json();

  if (!isShipment(body)) {
    throw new CourierRequestError("Courier returned an invalid shipment");
  }

  return body;
}
