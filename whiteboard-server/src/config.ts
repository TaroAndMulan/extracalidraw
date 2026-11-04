import path from "node:path";

const env = process.env;

const bool = (value: string | undefined, fallback: boolean) => {
  if (value == null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const int = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: int(env.PORT, 3002),
  host: env.HOST || "0.0.0.0",
  /** where users, papers, pages and images are stored */
  dataDir: path.resolve(env.DATA_DIR || "./data"),
  /**
   * directory with the built whiteboard-app. When empty or missing, the server
   * only serves the API (e.g. in development, where Vite serves the app).
   */
  staticDir: env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : null,
  appName: env.APP_NAME || "Extracalidraw",
  /** username of the admin account created on first start */
  adminUsername: env.ADMIN_USERNAME || "admin",
  /** password of the admin account created on first start */
  adminPassword: env.ADMIN_PASSWORD || "",
  /**
   * "auto" sets the Secure cookie flag when the request came over HTTPS
   * (directly or via a trusted reverse proxy)
   */
  cookieSecure: (env.COOKIE_SECURE || "auto") as "auto" | "true" | "false",
  /** trust X-Forwarded-* headers (set when running behind Caddy/nginx) */
  trustProxy: bool(env.TRUST_PROXY, true),
  sessionTtlDays: int(env.SESSION_TTL_DAYS, 30),
  /** max size of a single uploaded image */
  maxFileBytes: int(env.MAX_FILE_MB, 10) * 1024 * 1024,
  /** max size of a single socket message (element batches) */
  maxMessageBytes: int(env.MAX_MESSAGE_MB, 25) * 1024 * 1024,
  /** debounce for flushing live papers to disk */
  persistDebounceMs: int(env.PERSIST_DEBOUNCE_MS, 1500),
  /** how long an unused paper stays in memory */
  paperIdleUnloadMs: int(env.PAPER_IDLE_UNLOAD_MINUTES, 10) * 60 * 1000,
  /** deleted elements older than this are dropped when a paper is loaded */
  tombstoneTtlMs: int(env.TOMBSTONE_TTL_DAYS, 30) * 24 * 60 * 60 * 1000,
  /**
   * which websites may embed papers (CSP `frame-ancestors`): `*` for any,
   * `none` to disallow embedding, or a list such as
   * `https://example.com https://*.example.com`
   */
  embedOrigins: (env.EMBED_ALLOWED_ORIGINS || "*")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((origin) => (origin === "none" ? "'none'" : origin))
    .join(" "),
  /** comma separated list of extra origins allowed to connect (dev only) */
  allowedOrigins: (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};

export type Config = typeof config;
