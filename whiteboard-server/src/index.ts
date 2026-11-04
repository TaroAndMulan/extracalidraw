/* eslint-disable no-console -- the server reports to stdout */
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { Server } from "socket.io";

import { createApi } from "./api";
import { hashPassword } from "./auth";
import { config } from "./config";
import { StaticFiles, sendJSON } from "./http";
import { PaperHub } from "./realtime";
import { Database, PaperStorage } from "./store";

import type { ClientToServerEvents, ServerToClientEvents } from "./protocol";
import type { IncomingMessage } from "node:http";

const getClientIp = (req: IncomingMessage) => {
  if (config.trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(",")[0]
      ?.trim();
    if (first) {
      return first;
    }
  }
  return req.socket.remoteAddress || "unknown";
};

const isSecureRequest = (req: IncomingMessage) =>
  (req.socket as any).encrypted === true ||
  (config.trustProxy && req.headers["x-forwarded-proto"] === "https");

/** creates the first admin, or resets its password when asked to */
const bootstrapAdmin = async (db: Database) => {
  const username = config.adminUsername;
  const resetRequested = ["1", "true", "yes"].includes(
    (process.env.RESET_ADMIN_PASSWORD || "").toLowerCase(),
  );

  if (!db.hasUsers()) {
    const generated = !config.adminPassword;
    const password =
      config.adminPassword || crypto.randomBytes(9).toString("base64url");
    db.createUser({
      username,
      displayName: "Admin",
      role: "admin",
      passwordHash: await hashPassword(password),
    });
    console.log(
      [
        "",
        "  ┌──────────────────────────────────────────────────────────┐",
        "  │ Admin account created                                    │",
        `  │   username: ${username.padEnd(45)}│`,
        generated
          ? `  │   password: ${password.padEnd(45)}│`
          : "  │   password: (the ADMIN_PASSWORD you configured)          │",
        "  │ Change it after logging in (top right → Change password).│",
        "  └──────────────────────────────────────────────────────────┘",
        "",
      ].join("\n"),
    );
    return;
  }

  if (resetRequested) {
    if (!config.adminPassword) {
      console.warn(
        "[admin] RESET_ADMIN_PASSWORD is set but ADMIN_PASSWORD is empty — skipping",
      );
      return;
    }
    const passwordHash = await hashPassword(config.adminPassword);
    const existing = db.getUserByUsername(username);
    if (existing) {
      db.updateUser(existing.id, {
        passwordHash,
        role: "admin",
        disabled: false,
      });
      db.deleteUserSessions(existing.id);
    } else {
      db.createUser({
        username,
        displayName: "Admin",
        role: "admin",
        passwordHash,
      });
    }
    console.log(
      `[admin] password of "${username}" was reset — remove RESET_ADMIN_PASSWORD now`,
    );
  }
};

const main = async () => {
  const db = await Database.open(config.dataDir);
  const storage = new PaperStorage(config.dataDir);
  await bootstrapAdmin(db);

  const staticDir =
    config.staticDir ??
    [
      path.resolve(process.cwd(), "public"),
      path.resolve(process.cwd(), "../whiteboard-app/build"),
    ].find((dir) => existsSync(path.join(dir, "index.html"))) ??
    null;
  const staticFiles =
    staticDir && existsSync(path.join(staticDir, "index.html"))
      ? new StaticFiles(staticDir)
      : null;

  // created below, once socket.io (which must hook into the server before
  // our request handler runs) and the hub exist
  const app: { api?: ReturnType<typeof createApi> } = {};

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      await app.api!.handle(req, res, url, {
        ip: getClientIp(req),
        secure: isSecureRequest(req),
      });
      return;
    }
    if (staticFiles && (req.method === "GET" || req.method === "HEAD")) {
      try {
        if (
          await staticFiles.serve(req, res, url.pathname, {
            // only paths that look like app routes fall back to index.html
            fallbackToIndex: !path.extname(url.pathname),
            // embeds may be framed by other websites, the rest of the app not
            frameAncestors: url.pathname.startsWith("/embed/")
              ? config.embedOrigins
              : null,
          })
        ) {
          return;
        }
      } catch (error) {
        console.error("[static]", error);
      }
    }
    sendJSON(res, 404, { error: "Not found" });
  });

  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    path: "/socket.io",
    serveClient: false,
    transports: ["websocket", "polling"],
    maxHttpBufferSize: config.maxMessageBytes,
    // compress large messages (initial paper state); small realtime
    // messages are sent as-is to keep latency low
    perMessageDeflate: { threshold: 8 * 1024 },
    httpCompression: { threshold: 8 * 1024 },
    pingInterval: 20_000,
    pingTimeout: 25_000,
    connectionStateRecovery: undefined,
    allowRequest: (req, callback) => {
      callback(null, !!app.api?.isSameOrigin(req));
    },
  });

  const hub = new PaperHub(io, db, storage, config);
  app.api = createApi({ db, storage, hub, config });

  server.keepAliveTimeout = 65_000;
  server.listen(config.port, config.host, () => {
    console.log(
      `[whiteboard] listening on http://${config.host}:${config.port} (data: ${
        config.dataDir
      }, app: ${staticFiles ? staticDir : "not served"})`,
    );
  });

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
      io.close();
      await hub.flushAll();
      await db.flush();
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
