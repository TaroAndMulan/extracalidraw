// Bundles the server (and socket.io) into a single dependency-free file, so
// the production image only needs Node.js and `dist/server.mjs`.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: true,
  minify: false,
  legalComments: "none",
  // optional native speedups of `ws`, not needed
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    // some CommonJS deps of socket.io use `require`
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
