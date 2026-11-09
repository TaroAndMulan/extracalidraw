# Protocol

Types for everything below are in `whiteboard-server/src/protocol.ts`.

## Identities & permissions

A socket/request acts as either a **user** (session cookie `wb_session`) or a **guest** (holder of a paper's public link token; no account).

|  | admin | paper owner | member (shared) | member (locked paper) | guest, link "edit" | guest, link "view" |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| open the paper | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| draw, add/rename/reorder pages, upload images, move the shared view | ✓ | ✓ | ✓ | – | ✓ (unless locked) | – |
| delete pages | ✓ | ✓ | – | – | – | – |
| lock, present, choose how the view is shared, bring everyone here, link settings | ✓ | ✓ | – | – | – | – |
| create/delete papers, manage people | ✓ | – | – | – | – | – |

Code: `canAccessPaper`, `canEditPaper`, `canManagePaper`, `canGuestEdit`, `isValidShareToken` in `realtime.ts`; `PaperHub.getPermissions` is the single place that combines them for sockets.

## REST (`/api`)

All mutating requests need `Content-Type: application/json` (except binary uploads) and are rejected if an `Origin` header points to another host.

| Method & path | Who | Notes |
| --- | --- | --- |
| `GET /api/health`, `GET /api/config` | anyone | `{ appName }` |
| `POST /api/auth/login` | anyone | `{ username, password }` → sets cookie; rate-limited per IP+username |
| `POST /api/auth/logout` | anyone |  |
| `GET /api/auth/me` | anyone | `{ user \| null }` (200 either way) |
| `POST /api/auth/password` | user | `{ currentPassword, newPassword }`; logs out other devices |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/:id` | admin | can't remove own admin access or the last admin |
| `GET /api/papers` | user | papers the user can access; `shareToken` only for managers |
| `POST /api/papers` | admin | `{ title, memberIds }` |
| `GET/PATCH/DELETE /api/papers/:id` | access / manage | PATCH: `{ title?, memberIds?, locked?, viewSync? }` |
| `POST /api/papers/:id/duplicate` | admin | copies pages & images (and `viewSync`) |
| `POST /api/papers/:id/share` | manage | `{ enabled, access?: "view"\|"edit", regenerate? }` |
| `GET /api/papers/:id/public` | user or `X-Share-Token` | what the embed page needs before joining |
| `PUT/GET /api/papers/:id/files/:fileId` | edit / access, or `X-Share-Token` | images only; immutable (content-hash ids) |
| `PUT/GET /api/papers/:id/thumbnail` | edit / access | PNG cover for the dashboard |

## socket.io

Connection: the session cookie authenticates users; guests connect with `auth: { guest: true }` and present the token when joining. Without either, the connection fails with `"unauthorized"`.

Client → server:

| Event | Payload | Notes |
| --- | --- | --- |
| `paper:join` (ack) | `{ paperId, shareToken?, guest? }` | ack `{ ok, data: JoinPaperResult }`: pages, elements of all live pages, presence, permissions, presenter, `sharedView` |
| `paper:elements` | `{ pageId, elements, patches?, drawing? }` | changed elements only; strokes being drawn as `patches` and listed in `drawing` (see below); refused edits → `paper:resync` to the sender; patches that don't fit → `paper:resend` to the sender |
| `paper:fetch` | `{ pageId, ids }` | asks for the current full elements (a received patch didn't fit the local copy) → `paper:elements` |
| `paper:file` (ack) | `{ fileId, mimeType, preview? }`, bytes | an image over the live connection, passed on to the paper right away. Full files are stored too (ack `{ ok }` once stored); `preview: true` (≤ 512 KB) is only passed on |
| `paper:pages` | `{ pages }` | changed page metas; refused deletes → full page list back to the sender |
| `paper:presence` | `{ pageId }` | which page this socket is on (also routes cursors) |
| `paper:pointer` (volatile) | cursor, button, selection | forwarded only to sockets on the same page |
| `paper:idle` (volatile) | `{ state }` | active / idle / away |
| `paper:follow` | `{ socketId, action }` | joins `follow:<socketId>`; the followed socket gets `paper:followers` |
| `paper:viewport` | `{ pageId, bounds }` | sent by followed sockets to their followers |
| `paper:view` (ack) | `{ pageId, bounds \| null }` | moves the shared view (`viewSync` not `"free"`, sender can edit); ack `{ seq }` (`null`: refused), see below |
| `paper:viewbox` | `{ pageId, bounds }` | what this socket sees, relayed to sockets on the same page ("where others are looking") |
| `paper:summon` | `{ pageId, bounds }` | managers: move everyone |
| `paper:lock` | `{ locked }` | managers |
| `paper:viewSync` | `{ mode }` | managers: `"free"`, `"page"` or `"view"`, stored with the paper |
| `paper:present` | `{ on }` | managers: presenter mode |

Server → client: `paper:elements` (`{ pageId, elements, patches?, drawing? }`), `paper:resend` (`{ pageId, ids }`: send these in full), `paper:file` (`meta`, bytes), `paper:fileStored` (`{ fileId }`: an HTTP upload finished, download now), `paper:pages`, `paper:resync`, `paper:presence`, `paper:pointer`, `paper:idle`, `paper:followers`, `paper:viewport`, `paper:view` (`SharedView & { by }`), `paper:viewbox` (`{ socketId, pageId, bounds }`), `paper:summon`, `paper:settings` (`{ locked, title, viewSync }`), `paper:presenter`, `paper:removed` (paper deleted / access lost).

Rooms: `paper:<id>` (everyone in a paper), `page:<paperId>:<pageId>` (cursors), `follow:<socketId>` (followers of a socket).

### Sharing the view (`viewSync`)

A paper's `viewSync` (in `PaperSummary`, changed with `paper:viewSync` or PATCH) says how the view is shared: `"free"` (everyone on their own), `"page"` (page turns are shared) or `"view"` (one view for everyone: page, pan and zoom). Presenter mode works on top of any of them and suspends the shared view while it lasts. The app's side is in `editor/viewSync.ts` and the "sharing the view" section of `session.ts`.

- **A move** (`paper:view`) is the page and, in `"view"` mode, the **area of the page** to show (`bounds`; `null` for a page turn in `"page"` mode). Each screen fits the area in. The mover sends the area that stays put on their screen (`SharedArea`), not their whole screen, so screens of different shapes don't zoom out a little more on every hand-over.
- **Order**: the server stores the latest move (`LivePaper.sharedView`, given to newcomers in `JoinPaperResult.sharedView`), numbers it (`seq`, growing from the clock so it keeps growing across reloads of the paper), relays it to everyone else and acks the sender with the number. A socket's acks and the moves relayed to it leave the server in the order the server handled them, so a client ignores others' moves that arrive while one of its own is unacknowledged (they were numbered before it) and shows only moves numbered after its own (`SharedViewTracker`). Everyone ends where the server's last move is, even when two people move at once.
- Moves are refused (ack `{ seq: null }`) when `viewSync` is `"free"`, the sender can't edit, or the page is unknown or deleted. People who can't edit follow the shared view; moving it themselves "looks around on their own" (client-side).
- Switching to `"free"` forgets the shared view. `paper:viewbox` is independent of the mode: sent (throttled) while others are on the same page, and again when someone comes to it.

### Stroke patches

While someone draws, a freedraw element grows by one point per pointer move. Instead of the whole element every time, the session sends an `ElementPatch`: `{ id, baseVersion, baseVersionNonce, basePointCount, version, versionNonce, set, appendPoints, appendPressures }` — the points added since the last send plus changed simple properties (`set` may only hold `PATCHABLE_KEYS`: size, position, `updated`, …). A patch applies only on top of exactly its base (same version, nonce and point count, a freedraw element); the result is an ordinary element with the new version, so reconciliation is unchanged.

- Server: applies patches after the message's full elements; relays the accepted ones as `patches`; answers the others with `paper:resend` when it's missing what they build on (the sender forgets what it sent of them and sends them in full).
- Receivers: apply a patch on top of the copy queued from the same burst or the one in the scene; when it doesn't fit, they `paper:fetch` the element.
- Anything else (color changed, points rewritten, erase, undo) is sent as a full element.
- The server rounds stroke points to 1/100 px and pressures to 1/1000 (`compactElement` in `reconcile.ts`), in full elements and patches alike, before storing and relaying them. The point count never changes, so patches still line up; the sender keeps its unrounded copy (same version, so nothing is re-sent).

### Strokes still being drawn (`drawing`)

A message with stroke changes carries `drawing`: the ids of the sender's strokes that are still being drawn (Excalidraw's `appState.newElement`; at most one). The server relays it filtered to valid ids of strokes it accepted in that message (at most 10), and leaves it out when the sender did (older clients).

Receivers draw the listed strokes of the page they're on on an overlay instead of putting them into the page (which would redraw every element on it for each new point, see decisions.md → "Live strokes"). A stroke that is in a message but not in `drawing` is finished: it goes into the page, and the overlay drops its copy once the page has been redrawn. Strokes that stop growing for 2 s (author gone) go into the page anyway; switching pages and the server's full state (rejoin, resync) also put them there. Without `drawing`, everything goes into the page as before.

### Images

Image data goes over the live connection so others see it at once (`files.ts`):

- up to 64 KB: the whole file over `paper:file` (the server passes it on, stores it, acks); HTTP upload if that fails;
- bigger raster images: a ≤ 640 px WebP preview over `paper:file` (`preview: true`), then the full file over HTTP (a separate connection, so a big upload doesn't hold up pen strokes); when stored, the server sends `paper:fileStored` and others download it right away (they don't wait for the element to be marked `saved`). The preview is replaced without flashing (`addFiles(…, { replace: true })`).

## Reconciliation

Elements and page metas are merged with the same total order Excalidraw uses (`shouldDiscardRemoteElement`): **higher `version` wins; equal versions → lower `versionNonce` wins**. Because the server and every client apply the same rule, everybody converges whatever the message order.

- The server stores the winner and forwards only accepted updates.
- Deletions are tombstones (`isDeleted: true`) so they win like any edit; tombstones older than `TOMBSTONE_TTL_DAYS` are dropped when a paper loads. Clients stop syncing deleted elements after a day (as excalidraw-app does). Deleted pages stay as tombstones in `pages.json`, but their elements are dropped once the page has been deleted for `TOMBSTONE_TTL_DAYS`.
- Pages are ordered by fractional `index` (`generateKeyBetween`), ties broken by id. Concurrently created pages with the same index fall back to appending.
- Element order within a page is the fractional `index` of elements.
