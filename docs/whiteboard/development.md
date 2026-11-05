# Development

## Run it locally

```bash
yarn install
yarn whiteboard:dev:server   # API + socket.io on :3002, data in whiteboard-server/data
yarn whiteboard:dev:app      # Vite on http://localhost:3003 (proxies /api and /socket.io)
```

The first start creates the admin account; set `ADMIN_PASSWORD=…` (or read the generated password from the server output). Node.js 20+ is required (`pdfjs-dist` needs it).

Production-like run: `yarn whiteboard:build`, then `DATA_DIR=/tmp/wb ADMIN_PASSWORD=… yarn whiteboard:start` (serves the built app on :3002).

## Tests

| What | Command | Notes |
| --- | --- | --- |
| Server unit + integration | `yarn vitest run whiteboard-server` | `server.test.ts` starts a real server (random port, temp data dir) and real socket.io clients: sync, cursors per page, page permissions, lock/resync, presenter, kicking, persistence across restarts, images, guest links |
| Type checks | `yarn test:typecheck` | root `tsc` covers `packages/` and `whiteboard-app/`; `tsc -p whiteboard-server` covers the server (Node types) |
| Lint / format | `yarn test:code`, `yarn test:other` | eslint must report 0 warnings |
| Browser smoke test | `yarn whiteboard:e2e <url> <admin> <password>` | `whiteboard-app/e2e/smoke.mjs`: two browsers + a guest, checks sync, pages, templates, PDF import, presenter, lock, embed, offline edits. Needs Playwright's Chromium (`npx playwright install chromium`) or `CHROMIUM_PATH=/path/to/chrome` |
| Latency benchmark | `node whiteboard-app/e2e/latency.mjs <url> <admin> <password> [--slow] [--points=150]` | two browsers: one draws a stroke at ~60 Hz and drops a 735 KB screenshot, the other records arrivals. Prints delay per point (and where it goes), WebSocket bytes, image preview/full times. `--slow` adds a throttling proxy (50 ms each way, 1.5 / 6 Mbit/s) — Chrome's network throttling doesn't affect WebSockets |
| Whole repo | `yarn test:update` | ~2700 tests, takes several minutes |

### Debug handle

With `localStorage.setItem("whiteboard-debug", "1")` the editor exposes `window.__whiteboard = { session, excalidrawAPI }` — the smoke test uses it to read state (`session.getState()`, `excalidrawAPI.getSceneElements()`).

## Gotchas (learned the hard way)

- **`api.setViewport()` cancels following.** Excalidraw treats it as the user taking over the view and emits an UNFOLLOW intent. Inside the session, move the viewport with `updateScene({ appState: zoomToFitBounds(…).appState })`.
- **Undo history** must be cleared on page switch (`api.history.clear()`), otherwise undo would apply deltas to elements of another page.
- **Remote updates** must set `lastSceneVersion` before `updateScene`, or the change is echoed back.
- **Browser tests drawing near the left edge** hit the shape properties panel (it appears when a tool is selected) — draw at x ≥ 300.
- **`pkill -f vite` also kills `vitest`.** Use precise patterns.
- **Socket handlers must stay synchronous** (`getContext` uses the loaded paper map) to keep message order; don't add `await` before applying updates.
- **Dev mode is stricter**: Excalidraw validates fractional indices and throws in development; run the smoke test against the dev server too after touching element handling.
- **Docker builds in sandboxes with a TLS-intercepting proxy** fail at `yarn install` (self-signed certificate). That's the environment, not the Dockerfile; build with the proxy CA mounted as a secret only for testing.
- The server serves `index.html` with `X-Frame-Options: SAMEORIGIN` except under `/embed/`, which uses `frame-ancestors $EMBED_ALLOWED_ORIGINS`.
- **Double-click / Enter on an image starts cropping** in Excalidraw. Formulas are detected in `onChange` (`appState.croppingElementId`), cropping is cancelled and the math editor opens instead.
- **Partial text colors while editing** are drawn by `.excalidraw-wysiwyg-colors` behind the textarea; its layout must match the textarea exactly (styles are copied in `updateColorLayer`).
- **Browser tests on a reused paper** can read leftovers from earlier runs (same text, same place) — create a fresh paper per test.
- **Chrome's network throttling (CDP / DevTools) doesn't slow down WebSockets.** `latency.mjs --slow` uses its own TCP proxy instead.
- **`withBatchedUpdates` passes only the first argument** to the wrapped function — wrap an options object if you need more.
- **An image whose file arrives before its element** isn't drawn until Excalidraw's next image refresh; `FileSync` calls `addFiles([])` once the element is there to load it right away.
- **Stroke patches assume strokes only grow** (points appended, start unchanged). If Excalidraw ever rewrites points while drawing, `createPatch` notices (first/last point check) and the full element is sent — correct, just more bytes.

## Conventions

- Server code is plain TypeScript bundled by `whiteboard-server/build.mjs` (esbuild) into `dist/server.mjs` with no runtime dependencies.
- App code imports the Excalidraw packages from source via Vite aliases (same as `excalidraw-app`). Don't modify `packages/` unless unavoidable — and list every such change in `decisions.md` → "Changes to packages/".
- Shared types live in `whiteboard-server/src/protocol.ts` and are imported by the app with `import type` only.
- Keep user-facing docs (`WHITEBOARD.md`) and these notes up to date.
