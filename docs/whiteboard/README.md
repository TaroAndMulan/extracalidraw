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

Everything below is implemented, tested and pushed on branch `claude/tender-bell-6d9kvw`:

- **Accounts**: admin creates people (one by one or many at once), resets passwords, disables/deletes accounts. Roles: `admin`, `member`.
- **Papers**: created by admins, shared with chosen members; rename, duplicate (templates), delete; dashboard with cover thumbnails.
- **Pages**: add (blank / lined / grid / dotted / from PDF or images), rename, reorder by drag & drop, duplicate, delete (owner/admin only); pages panel with live thumbnails; page bar; keyboard shortcuts.
- **Real-time**: drawing, cursors, laser, selections; presence per page; follow a person; **presenter mode** (everyone follows); **bring everyone here**; **lock** (view-only for everyone but the owner/admins); offline edits are sent after reconnecting.
- **Embeds**: per-paper public link (`/embed/<id>#token=…`), view or edit, guests join without an account, reset/disable link, `EMBED_ALLOWED_ORIGINS`.
- **LaTeX math** (MathJax → SVG image, editable via double-click) and **partially colored text** (color selected words; a small, self-contained change to the editor core).
- **Images**, export of the current page, **Print/PDF of all pages**.
- **Deployment**: single Docker image (Node only) + Caddy for HTTPS (`deploy/`). Tested with Docker, Compose and Caddy.

## Where the code is

```
whiteboard-server/   Node.js server (TypeScript, bundled with esbuild)
whiteboard-app/      React app (Vite) using the Excalidraw package from packages/
deploy/              docker-compose.yml + Caddyfile + .env.example
WHITEBOARD.md        user documentation
docs/whiteboard/     these notes
```

The original `excalidraw-app/` (excalidraw.com) is **untouched**. `packages/` has one deliberate addition — partially colored text — kept small and documented in [decisions.md](./decisions.md#changes-to-packages) so upstream merges stay easy.

## Everyday commands

```bash
yarn whiteboard:dev:server     # server on :3002 (data in whiteboard-server/data)
yarn whiteboard:dev:app        # app on http://localhost:3003 (proxies to :3002)

yarn vitest run whiteboard-server   # server unit + integration tests (~6s)
yarn test:typecheck                 # tsc for packages + app, and for the server
yarn whiteboard:build               # production build (app + server bundle)
yarn whiteboard:e2e http://localhost:3002 admin <password>   # browser smoke test
```

Before committing, the repo's usual checks apply (see `/CLAUDE.md`): `yarn test:typecheck`, `yarn test:code` (eslint, 0 warnings), `yarn test:other` (prettier) and `yarn test:update` (the whole vitest suite).
