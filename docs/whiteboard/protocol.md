# Protocol

Types for everything below are in `whiteboard-server/src/protocol.ts`.

## Identities & permissions

A socket/request acts as either a **user** (session cookie `wb_session`) or a **guest** (holder of a paper's public link token; no account).

|  | admin | paper owner | member (shared) | member (locked paper) | guest, link "edit" | guest, link "view" |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| open the paper | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| draw, add/rename/reorder pages, upload images | ✓ | ✓ | ✓ | – | ✓ (unless locked) | – |
| delete pages | ✓ | ✓ | – | – | – | – |
| lock, present, bring everyone here, link settings | ✓ | ✓ | – | – | – | – |
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
| `GET/PATCH/DELETE /api/papers/:id` | access / manage | PATCH: `{ title?, memberIds?, locked? }` |
| `POST /api/papers/:id/duplicate` | admin | copies pages & images |
| `POST /api/papers/:id/share` | manage | `{ enabled, access?: "view"\|"edit", regenerate? }` |
| `GET /api/papers/:id/public` | user or `X-Share-Token` | what the embed page needs before joining |
| `PUT/GET /api/papers/:id/files/:fileId` | edit / access, or `X-Share-Token` | images only; immutable (content-hash ids) |
| `PUT/GET /api/papers/:id/thumbnail` | edit / access | PNG cover for the dashboard |

## socket.io

Connection: the session cookie authenticates users; guests connect with `auth: { guest: true }` and present the token when joining. Without either, the connection fails with `"unauthorized"`.

Client → server:

| Event | Payload | Notes |
| --- | --- | --- |
| `paper:join` (ack) | `{ paperId, shareToken?, guest? }` | ack `{ ok, data: JoinPaperResult }`: pages, elements of all live pages, presence, permissions, presenter |
| `paper:elements` | `{ pageId, elements }` | changed elements only; refused edits → `paper:resync` to the sender |
| `paper:pages` | `{ pages }` | changed page metas; refused deletes → full page list back to the sender |
| `paper:presence` | `{ pageId }` | which page this socket is on (also routes cursors) |
| `paper:pointer` (volatile) | cursor, button, selection | forwarded only to sockets on the same page |
| `paper:idle` (volatile) | `{ state }` | active / idle / away |
| `paper:follow` | `{ socketId, action }` | joins `follow:<socketId>`; the followed socket gets `paper:followers` |
| `paper:viewport` | `{ pageId, bounds }` | sent by followed sockets to their followers |
| `paper:summon` | `{ pageId, bounds }` | managers: move everyone |
| `paper:lock` | `{ locked }` | managers |
| `paper:present` | `{ on }` | managers: presenter mode |

Server → client: `paper:elements`, `paper:pages`, `paper:resync`, `paper:presence`, `paper:pointer`, `paper:idle`, `paper:followers`, `paper:viewport`, `paper:summon`, `paper:settings` (`{ locked, title }`), `paper:presenter`, `paper:removed` (paper deleted / access lost).

Rooms: `paper:<id>` (everyone in a paper), `page:<paperId>:<pageId>` (cursors), `follow:<socketId>` (followers of a socket).

## Reconciliation

Elements and page metas are merged with the same total order Excalidraw uses (`shouldDiscardRemoteElement`): **higher `version` wins; equal versions → lower `versionNonce` wins**. Because the server and every client apply the same rule, everybody converges whatever the message order.

- The server stores the winner and forwards only accepted updates.
- Deletions are tombstones (`isDeleted: true`) so they win like any edit; tombstones older than `TOMBSTONE_TTL_DAYS` are dropped when a paper loads. Clients stop syncing deleted elements after a day (as excalidraw-app does).
- Pages are ordered by fractional `index` (`generateKeyBetween`), ties broken by id. Concurrently created pages with the same index fall back to appending.
- Element order within a page is the fractional `index` of elements.
