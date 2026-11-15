import "dotenv/config";
import { resolve } from "node:path";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const mockCourierPort = Number.parseInt(
  process.env.MOCK_COURIER_PORT ?? "4000",
  10,
);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port");
}

if (
  !Number.isInteger(mockCourierPort) ||
  mockCourierPort < 1 ||
  mockCourierPort > 65_535
) {
  throw new Error("MOCK_COURIER_PORT must be a valid TCP port");
}

export const config = {
  port,
  mockCourierPort,
  webhookSecret: process.env.WEBHOOK_SECRET ?? "development-secret",
  courierBaseUrl: process.env.COURIER_BASE_URL ?? "http://localhost:4000",
  databasePath: resolve(process.env.DB_PATH ?? "./storage/app.db"),
};
