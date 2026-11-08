import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import zlib from "zlib";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import type { Plugin } from "vite";

const pkg = (name: string) => path.resolve(__dirname, "../packages", name);

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const COMPRESSIBLE_RE = /\.(html|m?js|css|json|map|svg|txt|webmanifest|wasm)$/;

const listFiles = async (dir: string): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(file) : [file];
    }),
  );
  return nested.flat();
};

/**
 * Writes `file.br` and `file.gz` next to every compressible file of the
 * build. The server sends them as they are (whiteboard-server/src/http.ts):
 * brotli's best level is ~10% smaller than what's quick enough to run on the
 * server, and nothing needs compressing after a deploy.
 */
const precompress = (outDir: string): Plugin => ({
  name: "whiteboard-precompress",
  apply: "build",
  async closeBundle() {
    const files = (await listFiles(outDir)).filter((file) =>
      COMPRESSIBLE_RE.test(file),
    );
    await Promise.all(
      files.map(async (file) => {
        const data = await fs.readFile(file);
        // (the server sends small files uncompressed)
        if (data.length <= 1024) {
          return;
        }
        const [br, gz] = await Promise.all([
          brotli(data, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
            },
          }),
          gzip(data, { level: 9 }),
        ]);
        await fs.writeFile(`${file}.br`, br);
        await fs.writeFile(`${file}.gz`, gz);
      }),
    );
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../");
  // the whiteboard server (see ../whiteboard-server), proxied in development
  const serverUrl = env.VITE_APP_WHITEBOARD_SERVER || "http://localhost:3002";

  return {
    envDir: "../",
    server: {
      port: Number(env.VITE_APP_WHITEBOARD_PORT || 3003),
      proxy: {
        "/api": { target: serverUrl, changeOrigin: false },
        "/socket.io": { target: serverUrl, ws: true, changeOrigin: false },
      },
    },
    resolve: {
      alias: [
        {
          find: /^@excalidraw\/common$/,
          replacement: pkg("common/src/index.ts"),
        },
        { find: /^@excalidraw\/common\/(.*?)/, replacement: pkg("common/src/$1") },
        {
          find: /^@excalidraw\/element$/,
          replacement: pkg("element/src/index.ts"),
        },
        {
          find: /^@excalidraw\/element\/(.*?)/,
          replacement: pkg("element/src/$1"),
        },
        {
          find: /^@excalidraw\/excalidraw$/,
          replacement: pkg("excalidraw/index.tsx"),
        },
        {
          find: /^@excalidraw\/excalidraw\/(.*?)/,
          replacement: pkg("excalidraw/$1"),
        },
        { find: /^@excalidraw\/math$/, replacement: pkg("math/src/index.ts") },
        { find: /^@excalidraw\/math\/(.*?)/, replacement: pkg("math/src/$1") },
        { find: /^@excalidraw\/utils$/, replacement: pkg("utils/src/index.ts") },
        { find: /^@excalidraw\/utils\/(.*?)/, replacement: pkg("utils/src/$1") },
        {
          find: /^@excalidraw\/fractional-indexing$/,
          replacement: pkg("fractional-indexing/src/index.ts"),
        },
        {
          find: /^@excalidraw\/laser-pointer$/,
          replacement: pkg("laser-pointer/src/index.ts"),
        },
      ],
    },
    build: {
      outDir: "build",
      sourcemap: false,
      // fonts must stay files (they're loaded by URL)
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            // every non-English locale in its own chunk, loaded on demand
            if (
              id.includes("packages/excalidraw/locales") &&
              id.match(/en.json|percentages.json/) === null
            ) {
              const index = id.indexOf("locales/");
              return `locales/${id.substring(index + 8)}`;
            }
            if (id.includes("@codemirror/") || id.includes("@lezer/")) {
              return "codemirror.chunk";
            }
          },
        },
      },
    },
    plugins: [react(), precompress(path.resolve(__dirname, "build"))],
  };
});
