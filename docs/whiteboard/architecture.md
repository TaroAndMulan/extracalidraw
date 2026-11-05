# Architecture

```
browser ──HTTPS──▶ Caddy ──▶ whiteboard-server (one Node.js process)
                              ├─ REST API (/api/*): auth, people, papers, images
                              ├─ socket.io (/socket.io): live papers
                              └─ static files: the built whiteboard-app
```

## Server (`whiteboard-server/src`)

| File | Responsibility |
| --- | --- |
| `index.ts` | Entry point: `createApp(config)`, listen, graceful shutdown (SIGTERM saves everything). |
| `app.ts` | Wires storage, API, socket.io and static files. Also used by the integration tests. Bootstraps/resets the admin account. |
| `config.ts` | All environment variables (see the table in `WHITEBOARD.md`). |
| `store.ts` | `Database` (users, sessions, papers index in `db.json`, debounced atomic writes) and `PaperStorage` (pages, images, thumbnails on disk). |
| `auth.ts` | scrypt password hashing, session cookie helpers, login rate limiter, validation. |
| `http.ts` | Tiny router, JSON/body helpers, `StaticFiles` (ETag, immutable caching of `/assets/*`, brotli/gzip cached in memory, framing headers). |
| `api.ts` | REST endpoints, permission checks for users and guests (`X-Share-Token`). |
| `realtime.ts` | `PaperHub` (socket.io handlers, presence, follow/presenter, lock, kicking) and `LivePaper` (in-memory state of an open paper, persistence). |
| `reconcile.ts` | Pure merge logic: version rules, validation of untrusted elements/pages, ordering, tombstone pruning. |
| `protocol.ts` | Types shared with the app (`import type` only): REST shapes and socket events. |

### Live papers

A paper is loaded into memory (`LivePaper`) the first time someone joins it and unloaded after `PAPER_IDLE_UNLOAD_MINUTES` without anyone in it. Incoming changes are merged with `mergeVersioned` (see protocol.md), only **accepted** changes are forwarded to the others, and dirty pages are written to disk at most every `PERSIST_DEBOUNCE_MS` (writes are chained per paper, never concurrent). Socket handlers are synchronous once the paper is loaded, so messages are applied strictly in arrival order (a "new page" message is always applied before elements drawn on it).

### Storage layout (`DATA_DIR`)

```
db.json                              users, sessions (token hashes), papers index
papers/<paperId>/pages.json          page list (PageMeta[], incl. deleted pages)
papers/<paperId>/pages/<pageId>.json elements of a page (incl. recent tombstones)
papers/<paperId>/files/<fileId>      image bytes (fileId = SHA-1 of the content)
papers/<paperId>/files/<fileId>.json { mimeType, created }
papers/<paperId>/thumbnail.png       cover shown on the dashboard
```

All ids are validated (`/^[A-Za-z0-9_-]{1,128}$/`) before touching the file system. Writes go to a temp file and are renamed (atomic).

## App (`whiteboard-app/src`)

| File | Responsibility |
| --- | --- |
| `App.tsx` | Session check, routes (`/`, `/admin/users`, `/p/:id`, `/embed/:id`), lazy-loads the editor. |
| `api.ts`, `router.tsx`, `auth.tsx`, `prefs.ts` | REST client, history router, auth context, theme/language prefs. |
| `pages/` | Login, dashboard (papers, share dialog), people (incl. bulk add), header. |
| `components/` | Small UI kit (`ui.tsx`) and `ShareSettings` (public link & embed code). |
| `editor/session.ts` | **The core**: `PaperSession` — socket, page store, sync, reconnect, presence, follow, presenter, pages API. |
| `editor/PaperEditor.tsx` | The editor screen: `<Excalidraw>`, page bar, status pills (lock, present), menu, share dialog, shortcuts, cover upload, PDF drop. Also used by embeds. |
| `editor/PagesSidebar.tsx`, `NewPageMenu.tsx` | Pages panel (thumbnails, drag & drop, menus) and the "New page" menu (templates, import). |
| `editor/files.ts` | Image upload/download (`FileSync`). |
| `editor/importPages.ts`, `templates.ts` | PDF (pdf.js, lazy) / image import and paper templates → pages with a locked background image. |
| `editor/math.ts`, `MathDialog.tsx` | LaTeX → SVG (MathJax, lazy) and placing/updating formulas; the math editor dialog. Double-click/Enter on a formula is intercepted in `PaperEditor` (`croppingElementId`). |
| `editor/thumbnails.ts`, `print.ts` | Page previews; print/PDF of all pages. |
| `editor/EmbedPage.tsx` | `/embed/<id>#token=…`: checks the link, asks guests for a name, opens the editor. |

### How the editor and the session share the work

- Excalidraw holds the **current page** only. Other pages live in `PaperSession.pageElements`; `getElements(pageId)` hides the difference.
- `switchPage` flushes pending sends, stores the current page and its viewport, loads the target page with `updateScene`, clears undo history and announces the new page (`paper:presence`).
- `onEditorChange` (Excalidraw `onChange`) → if the scene version changed, `sendPendingElements` (throttled, ~30/s) sends elements whose version is above what the server is known to have (`serverVersions`).
- Remote changes for the current page are reconciled into the editor (`restoreElements` → `reconcileElements` → `bumpElementVersions`, same as excalidraw-app's collab); for other pages into `pageElements`.
- After a reconnect the server sends its full state; the session merges it and sends whatever is newer locally (offline edits, pages).

### Images

Image elements reference a `fileId` (content hash). `FileSync` uploads files that exist locally but not on the server, then marks elements `saved` (on any page); other clients download `saved` files they don't have. Imported PDF pages and templates are just images with `locked: true` on new pages.
