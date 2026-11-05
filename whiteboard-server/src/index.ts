/* eslint-disable no-console -- the server reports to stdout */
import { createApp } from "./app";
import { config } from "./config";

const main = async () => {
  const app = await createApp(config, { log: console.log });
  const port = await app.listen();
  console.log(
    `[whiteboard] listening on http://${config.host}:${port} (data: ${
      config.dataDir
    }, app: ${app.staticDir ?? "not served"})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[whiteboard] ${signal} received, saving data…`);
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    try {
      await app.close();
    } catch (error) {
      console.error(error);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
