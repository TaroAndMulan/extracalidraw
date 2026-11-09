# Architecture

```
browser ──HTTPS──▶ Caddy or your own nginx ──▶ whiteboard-server (one Node.js process)
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
| `http.ts` | Tiny router, JSON/body helpers, `StaticFiles` (ETag, immutable caching of `/assets/*`, brotli/gzip files from the build — compressed on first request otherwise — cached in memory, framing headers). |
| `api.ts` | REST endpoints, permission checks for users and guests (`X-Share-Token`). |
| `realtime.ts` | `PaperHub` (socket.io handlers, presence, follow/presenter, shared view, lock, kicking) and `LivePaper` (in-memory state of an open paper, persistence). |
| `reconcile.ts` | Pure merge logic: version rules, validation of untrusted elements/pages, ordering, tombstone pruning. |
| `protocol.ts` | Types shared with the app (`import type` only): REST shapes and socket events. |

### Live papers

A paper is loaded into memory (`LivePaper`) the first time someone joins it and unloaded after `PAPER_IDLE_UNLOAD_MINUTES` without anyone in it. Incoming changes are merged with `mergeVersioned` (see protocol.md), only **accepted** changes are forwarded to the others, and dirty pages are written to disk at most every `PERSIST_DEBOUNCE_MS` (writes are chained per paper, never concurrent). Socket handlers are synchronous once the paper is loaded, so messages are applied strictly in arrival order (a "new page" message is always applied before elements drawn on it).

### Storage layout (`DATA_DIR`)

```
db.json                              users, sessions (token hashes), papers index
papers/<paperId>/pages.json             page list (PageMeta[], incl. deleted pages)
papers/<paperId>/pages/<pageId>.json.gz elements of a page, gzipped (incl. recent tombstones)
papers/<paperId>/files/<fileId>         image bytes (fileId = SHA-1 of the content)
papers/<paperId>/files/<fileId>.json    { mimeType, created }
papers/<paperId>/thumbnail.png          cover shown on the dashboard
```

All ids are validated (`/^[A-Za-z0-9_-]{1,128}$/`) before touching the file system. Writes go to a temp file and are renamed (atomic).

Keeping it small (decisions.md → "Storage and loading"):

- **Pages** are gzipped JSON (`zcat` reads one). Pages stored before that as plain `<pageId>.json` are still read, and written again as `.json.gz` (with compact strokes) once their paper is opened.
- **Deleted pages**: their elements are dropped once the page has been deleted for `TOMBSTONE_TTL_DAYS`; the tombstone stays in `pages.json`.
- **Images** never change once written (replaced by rename, never edited in place), so a duplicated paper hard-links them instead of copying. When a paper is unloaded after being idle, images that no element uses (erased images included, until their tombstone is pruned) and that are more than 24 h old are deleted (`PaperStorage.removeUnusedFiles`).

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
| `editor/liveStrokes.ts` | Others' strokes while they're drawn, on an overlay canvas; they go into the page once finished (protocol.md → "Strokes still being drawn"). |
| `editor/tabletInput.ts` | Tablets: palm rejection, finger navigation, long press → context menu, two/three-finger tap → undo/redo, in front of the editor (window capture listeners); pen mode remembered per device. See decisions.md → "Pen, fingers and palms". |
| `editor/PenTray.tsx` | The pen bar (pens, highlighter, eraser, "fingers draw" toggle) and `widenHighlighterStroke`. |
| `editor/TopRight.tsx`, `fit.ts` | Math / Lock / View / Pages at the top right, and `useFitLevel`, which makes the top bar and the footer (page bar + pens) more compact until they fit. |
| `editor/viewSync.ts` | Sharing the view (protocol.md → "Sharing the view"): view ↔ page-area math, `SharedArea` (what's sent when you move the shared view), `SharedViewTracker` (orders moves of several people), `ViewAnimator` (others' moves glide; recognizes views it set, so they aren't taken for the user's). Used by `session.ts`. |
| `editor/viewBoxes.ts`, `ViewMenu.tsx` | "Where others are looking" (frames over the page, name tags at the screen's edge), and the _View_ menu (modes, look around / come back, the frames toggle). |
| `editor/device.ts` | Screen wake lock during lessons, full screen (incl. Safari's prefixed API). |
| `editor/EmbedPage.tsx` | `/embed/<id>#token=…`: checks the link, asks guests for a name, opens the editor. |

### How the editor and the session share the work

- Excalidraw holds the **current page** only. Other pages live in `PaperSession.pageElements`; `getElements(pageId)` hides the difference.
- `switchPage` flushes pending sends, stores the current page and its viewport, loads the target page with `updateScene`, clears undo history and announces the new page (`paper:presence`).
- `onEditorChange` (Excalidraw `onChange`) → if the scene version changed, `scheduleSend`: the first change goes out right away, then at most one message per frame (16 ms). It sends elements whose version is above what the server is known to have (`serverVersions`); strokes being drawn go as patches with just their new points (`strokePatches.ts`, protocol → "Stroke patches"). While more than 32 KB wait in the WebSocket (slow connection), sending pauses and the changes merge into the next message, so the newest state is never stuck behind stale ones.
- Remote changes (`receiveRemote`): patches are turned into full elements, then reconciled into the editor (`restoreElements` → `reconcileElements` → `bumpElementVersions`, same as excalidraw-app's collab), or into `pageElements` for other pages. A single message is applied immediately; several within one frame are applied together.
- After a reconnect the server sends its full state; the session merges it and sends whatever is newer locally (offline edits, pages).

### Images

Image elements reference a `fileId` (content hash). `FileSync` uploads files that exist locally but not on the server, then marks elements `saved` (on any page); other clients download `saved` files they don't have. To make pasted images appear for others at once, they're also pushed over the live connection — small ones whole, bigger ones as a quick preview first (protocol → "Images"); `FileSync` tracks which files are only previews (never uploaded, replaced by the full file). Imported PDF pages and templates are just images with `locked: true` on new pages.
