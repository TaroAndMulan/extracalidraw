# Whiteboard — developer notes (start here)

This fork of Excalidraw adds a **self-hosted, multi-user whiteboard** ("papers with pages", like Bitpaper) for tutoring, classes and teams. These notes are for whoever works on it next — read this page first, then the one you need.

User-facing documentation (features, install, configuration) lives in [`/WHITEBOARD.md`](../../WHITEBOARD.md).

| Doc | What's in it |
| --- | --- |
| [architecture.md](./architecture.md) | Components, file map, data flows, storage layout |
| [protocol.md](./protocol.md) | REST API, socket.io events, reconciliation, permissions |
| [development.md](./development.md) | Running locally, tests (unit, integration, browser smoke test), gotchas |
| [decisions.md](./decisions.md) | Why things are the way they are, known limitations, ideas for next steps |

## What exists (status)

Everything below is implemented, tested and on `main`:

- **Accounts**: admin creates people (one by one or many at once), resets passwords, disables/deletes accounts. Roles: `admin`, `member`.
- **Papers**: created by admins, shared with chosen members; rename, duplicate (templates), delete; dashboard with cover thumbnails.
- **Pages**: add (blank / lined / grid / dotted / from PDF or images), rename, reorder by drag & drop, duplicate, delete (owner/admin only); pages panel with live thumbnails; page bar; keyboard shortcuts.
- **Real-time**: drawing, cursors, laser, selections; presence per page; follow a person; **bring everyone here**; **lock** (view-only for everyone but the owner/admins); offline edits are sent after reconnecting.
- **Sharing the view** (_View_ menu, per paper): on their own, **same page** (page turns shared), **together** (one camera for everyone, like Bitpaper — anyone moves it, any screen shape, no drift, one order when two move at once), **follow me** (presenter mode); look around on your own and come back; **where others are looking** (frames of others' views). Others' moves glide. See protocol.md → "Sharing the view" and decisions.md. Others' strokes still being drawn are shown on their own layer (`editor/liveStrokes.ts`), so a page full of notes on a tablet keeps up (~28 ms instead of ~112 ms on a 4× slowed CPU, see decisions.md → "Live strokes").
- **Embeds**: per-paper public link (`/embed/<id>#token=…`), view or edit, guests join without an account, reset/disable link, `EMBED_ALLOWED_ORIGINS`.
- **LaTeX math** (MathJax → SVG image, editable via double-click) and **partially colored text** (color selected words; a small, self-contained change to the editor core).
- **Tablets**: the pen draws (every point it reports), fingers pan and pinch-zoom, a resting palm is ignored (palm rejection), long press opens the menu, two/three-finger tap undoes/redoes; pen mode is remembered per device; the screen stays on during lessons; full screen (`editor/tabletInput.ts`, `device.ts`).
- **Pen bar** (pens, highlighter, eraser) and **bars that fit** any tablet, portrait or landscape (`PenTray.tsx`, `TopRight.tsx`, `fit.ts`).
- **Images**, export of the current page, **Print/PDF of all pages**.
- **Deployment**: single Docker image (Node only) behind Caddy (bundled, automatic HTTPS) or your own nginx + certbot (an untracked override turns Caddy off). `deploy/deploy.sh` updates a server from your computer: checks, `:previous` image for `--rollback`, health and public checks, `--status`, `--backup`, `--ship-image`. In production behind nginx since 2026-11-08; see WHITEBOARD.md → "Already running nginx" and "Updates".

## Where the code is

```
whiteboard-server/   Node.js server (TypeScript, bundled with esbuild)
whiteboard-app/      React app (Vite) using the Excalidraw package from packages/
deploy/              docker-compose.yml + Caddyfile + .env.example (Caddy setup)
                     docker-compose.override.nginx.example.yml + nginx.conf.example (your own nginx)
                     deploy.sh + .deploy.env.example (deploy from your computer)
WHITEBOARD.md        user documentation
docs/whiteboard/     these notes
```

The original `excalidraw-app/` (excalidraw.com) is **untouched**. `packages/` has a few deliberate, small changes (partially colored text, replacing an image's data, every pen sample in freehand strokes), documented in [decisions.md](./decisions.md#changes-to-packages) so upstream merges stay easy.

## Everyday commands

```bash
corepack enable && corepack yarn install   # once: dependencies come from yarn.lock (see development.md)

npm run whiteboard:dev:server     # server on :3002 (data in whiteboard-server/data)
npm run whiteboard:dev:app        # app on http://localhost:3003 (proxies to :3002)

npx vitest run whiteboard-server  # server unit + integration tests (~7s)
npm run test:typecheck            # tsc for packages + app, and for the server
npm run whiteboard:build          # production build (app + server bundle)
npm run whiteboard:e2e -- http://localhost:3002 admin <password>   # browser smoke test
npm run whiteboard:e2e:tablet -- http://localhost:3002 admin <password>   # pen, fingers & palm in a real browser
npm run whiteboard:e2e:view -- http://localhost:3002 admin <password>     # sharing the view: laptop + portrait tablet

deploy/deploy.sh --status         # production: what runs, health, public checks (changes nothing)
deploy/deploy.sh                  # deploy GitHub's main (commit + push first; settings in deploy/.deploy.env)
```

`npm run <script>` and `yarn <script>` are interchangeable. Before committing, the repo's usual checks apply (see `/CLAUDE.md`): `npm run test:typecheck`, `npm run test:code` (eslint, 0 warnings), `npm run test:other` (prettier) and `npm run test:update` (the whole vitest suite).
