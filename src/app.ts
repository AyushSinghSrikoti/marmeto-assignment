import express, { type ErrorRequestHandler } from "express";

import { orderWebhookRouter } from "#/routes/order-webhook";

export const app = express();

app.disable("x-powered-by");
app.use("/webhooks", orderWebhookRouter);
app.use(express.json());

app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  console.error(error);
  response.status(500).json({ error: "Internal server error" });
};

app.use(errorHandler);
