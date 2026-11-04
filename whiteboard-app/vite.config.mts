import path from "path";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const pkg = (name: string) => path.resolve(__dirname, "../packages", name);

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
    plugins: [react()],
  };
});
