import { app } from "#/app";
import { config } from "#/config";
import { initializeDatabase } from "#/database";

initializeDatabase();

app.listen(config.port, () => {
  console.log(`Integration API listening on http://localhost:${config.port}`);
});
