import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

import type { IncomingMessage, ServerResponse } from "node:http";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const sendJSON = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
) => {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
};

export const readBody = (req: IncomingMessage, limit: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) {
      reject(new HttpError(413, "Payload too large"));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

export const readJSON = async <T = any>(
  req: IncomingMessage,
  limit = 1024 * 1024,
): Promise<T> => {
  const contentType = req.headers["content-type"] || "";
  // requiring a JSON content type means plain cross-site <form> posts can't
  // hit the API (they'd need a CORS preflight, which we never grant)
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "Expected application/json");
  }
  const body = await readBody(req, limit);
  try {
    return JSON.parse(body.toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
};

// -----------------------------------------------------------------------------
// router
// -----------------------------------------------------------------------------

type Params = Record<string, string>;

export type RouteHandler<Ctx> = (
  ctx: Ctx & { params: Params },
) => Promise<void> | void;

interface Route<Ctx> {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler<Ctx>;
}

export class Router<Ctx> {
  private routes: Route<Ctx>[] = [];

  add(method: string, pattern: string, handler: RouteHandler<Ctx>) {
    const keys: string[] = [];
    const regex = new RegExp(
      `^${pattern.replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return "([^/]+)";
      })}/?$`,
    );
    this.routes.push({ method, regex, keys, handler });
    return this;
  }

  get = (pattern: string, handler: RouteHandler<Ctx>) =>
    this.add("GET", pattern, handler);
  post = (pattern: string, handler: RouteHandler<Ctx>) =>
    this.add("POST", pattern, handler);
  put = (pattern: string, handler: RouteHandler<Ctx>) =>
    this.add("PUT", pattern, handler);
  patch = (pattern: string, handler: RouteHandler<Ctx>) =>
    this.add("PATCH", pattern, handler);
  delete = (pattern: string, handler: RouteHandler<Ctx>) =>
    this.add("DELETE", pattern, handler);

  match(method: string, pathname: string) {
    let pathMatched = false;
    for (const route of this.routes) {
      const match = route.regex.exec(pathname);
      if (!match) {
        continue;
      }
      pathMatched = true;
      if (
        route.method !== method &&
        !(method === "HEAD" && route.method === "GET")
      ) {
        continue;
      }
      const params: Params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1]);
      });
      return { handler: route.handler, params };
    }
    return pathMatched ? ("method-not-allowed" as const) : null;
  }
}

// -----------------------------------------------------------------------------
// static files
// -----------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
};

const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".webmanifest",
  ".wasm",
]);

type CachedEncoding = { br?: Buffer; gzip?: Buffer };

/**
 * Serves the built app. Hashed assets are cached forever by browsers, and
 * compressed responses are cached in memory, so after the first request the
 * app loads straight from RAM. The build compresses files ahead of time
 * (brotli at its best level, see whiteboard-app/vite.config.mts); other
 * files are compressed on their first request.
 */
export class StaticFiles {
  private compressed = new Map<string, Promise<CachedEncoding>>();

  constructor(private readonly root: string) {}

  private async resolve(pathname: string) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    const file = path.join(this.root, path.normalize(decoded));
    if (!file.startsWith(this.root + path.sep) && file !== this.root) {
      return null;
    }
    try {
      const stat = await fs.stat(file);
      return stat.isFile() ? { file, stat } : null;
    } catch {
      return null;
    }
  }

  /** `file.br`/`file.gz` written by the app's build (smaller, and ready) */
  private async readPrecompressed(file: string, mtimeMs: number) {
    const read = async (variant: string) => {
      try {
        const stat = await fs.stat(variant);
        // a leftover from an older build doesn't count
        return stat.mtimeMs >= mtimeMs ? await fs.readFile(variant) : null;
      } catch {
        return null;
      }
    };
    const [br, gz] = await Promise.all([
      read(`${file}.br`),
      read(`${file}.gz`),
    ]);
    return br && gz ? { br, gzip: gz } : null;
  }

  private getCompressed(file: string, mtimeMs: number) {
    const key = `${file}:${mtimeMs}`;
    let entry = this.compressed.get(key);
    if (!entry) {
      entry = this.readPrecompressed(file, mtimeMs).then(
        async (precompressed) => {
          if (precompressed) {
            return precompressed;
          }
          const data = await fs.readFile(file);
          const [br, gz] = await Promise.all([
            brotli(data, {
              params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
            }),
            gzip(data, { level: 9 }),
          ]);
          return { br, gzip: gz };
        },
      );
      this.compressed.set(key, entry);
    }
    return entry;
  }

  /** returns false when the file doesn't exist */
  async serve(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    opts: { fallbackToIndex: boolean; frameAncestors?: string | null },
  ): Promise<boolean> {
    let resolved = pathname === "/" ? null : await this.resolve(pathname);
    let isIndex = false;
    if (!resolved) {
      if (!opts.fallbackToIndex && pathname !== "/") {
        return false;
      }
      resolved = await this.resolve("/index.html");
      isIndex = true;
      if (!resolved) {
        return false;
      }
    }
    const { file, stat } = resolved;
    const ext = path.extname(file).toLowerCase();
    const etag = `"${stat.size.toString(16)}-${Math.floor(
      stat.mtimeMs,
    ).toString(16)}"`;
    const isHashedAsset = /\/assets\//.test(file) && !isIndex;

    const headers: Record<string, string> = {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      ETag: etag,
      "Cache-Control": isHashedAsset
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    if (isIndex || ext === ".html") {
      headers["Referrer-Policy"] = "same-origin";
      if (opts.frameAncestors) {
        headers[
          "Content-Security-Policy"
        ] = `frame-ancestors ${opts.frameAncestors}`;
      } else {
        headers["X-Frame-Options"] = "SAMEORIGIN";
        headers["Content-Security-Policy"] = "frame-ancestors 'self'";
      }
    }

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }

    const accept = String(req.headers["accept-encoding"] || "");
    if (COMPRESSIBLE.has(ext) && stat.size > 1024) {
      const encoding = /\bbr\b/.test(accept)
        ? "br"
        : /\bgzip\b/.test(accept)
        ? "gzip"
        : null;
      if (encoding) {
        const compressed = await this.getCompressed(file, stat.mtimeMs);
        const body = compressed[encoding]!;
        res.writeHead(200, {
          ...headers,
          "Content-Encoding": encoding,
          "Content-Length": String(body.length),
          Vary: "Accept-Encoding",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return true;
      }
    }

    res.writeHead(200, { ...headers, "Content-Length": String(stat.size) });
    if (req.method === "HEAD") {
      res.end();
    } else {
      createReadStream(file).pipe(res);
    }
    return true;
  }
}
