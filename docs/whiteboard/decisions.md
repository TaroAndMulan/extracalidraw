# Decisions, limitations, next steps

## Decisions

**A separate app instead of changing `excalidraw-app`.** excalidraw.com's app is built around anonymous, end-to-end encrypted rooms, Firebase and Excalidraw+. Accounts, papers and server-side state don't fit that model, so `whiteboard-app` is a focused app on top of the same editor package. The original app and `packages/` stay untouched → upstream merges stay easy.

**Server holds the state (no end-to-end encryption).** With accounts and a private server, the server must know who may see what; holding the state lets it serve a paper instantly on join (no waiting for peers), enforce permissions (lock, view-only links), and persist reliably. Data is stored in plain JSON on the owner's VM.

**Same merge rules as Excalidraw.** The server reconciles with the version/versionNonce rule clients already use, so client code could reuse excalidraw-app's reconcile pipeline and everyone converges.

**Pages = separate element lists.** The editor holds one page; other pages live in memory in the session. Alternatives (one big canvas with offsets, or filtering by page inside the editor) would need deep changes to `packages/` (selection, select-all, export, hit testing…).

**JSON files, no database.** Zero native dependencies, trivial backups (`tar` the volume), plenty fast for a team/class (hundreds of users/papers). Writes are atomic and debounced. If it ever outgrows this, `store.ts` is the only place to change.

**One process, bundled.** `dist/server.mjs` contains socket.io; the Docker image is just Node + that file + the built app. Static assets are compressed once and kept in memory.

**Embeds via a secret link.** Third-party iframes don't get first-party cookies, so embeds use a per-paper token in the URL hash (never sent to servers or in `Referer`), presented when joining. Resetting the token revokes all links at once.

**Templates and PDF pages are locked images.** Everyone sees exactly the same background, it appears in thumbnails, exports and print, and it reuses the image pipeline. pdf.js runs only in the importing browser (lazy-loaded); others just download the rendered page images.

## Known limitations

- Undo/redo history resets when switching pages (Excalidraw has no API to save and restore history per page).
- Undo/redo only covers your own changes (as in Excalidraw collaboration).
- One server process (no horizontal scaling); live papers are in memory.
- PDF import: text that relies on non-embedded fonts/CMaps (some CJK PDFs) may render with fallback fonts, as pdf.js standard fonts/CMaps aren't bundled.
- The dashboard cover only updates from the first page and from people who can edit.
- Guests are identified by a random id in their browser; their name is whatever they typed (or `?name=`).
- No audio/video or chat (Bitpaper has both).

## Ideas for next steps

- Per-page undo history (would need an Excalidraw history snapshot API).
- Text chat in the pages panel; optional audio via WebRTC (big).
- Export/import a whole paper (all pages) as a file.
- "Students' own pages": a page per student that only they and the teacher can edit.
- Paper folders/tags and search on the dashboard.
- Bundle pdf.js CMaps/standard fonts for better PDF text fidelity.
- Admin audit: last sign-in per user, who changed what.
- Rate limits for guest connections on public links.
