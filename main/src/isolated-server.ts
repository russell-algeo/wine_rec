import { buildApp } from "./app.js";
import { appConfig } from "./config.js";
import { createIsolatedHandlers } from "./isolated-handlers.js";
import { installIsolatedFetch } from "./isolated-network.js";

const restoreFetch = installIsolatedFetch();
const local = createIsolatedHandlers();
const app = await buildApp(local.handlers);
app.addHook("onClose", async () => { await local.drain(); restoreFetch(); });
console.info("ISOLATED: ephemeral local analyses, bundled OCR, rule-based estimates only. No Redis, QStash, Blob or Vivino. Results clear on restart.");
await app.listen({ port: appConfig.port, host: "127.0.0.1" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
