# Decisions, limitations, next steps

## Decisions

**A separate app instead of changing `excalidraw-app`.** excalidraw.com's app is built around anonymous, end-to-end encrypted rooms, Firebase and Excalidraw+. Accounts, papers and server-side state don't fit that model, so `whiteboard-app` is a focused app on top of the same editor package. The original app stays untouched → upstream merges stay easy.

**Server holds the state (no end-to-end encryption).** With accounts and a private server, the server must know who may see what; holding the state lets it serve a paper instantly on join (no waiting for peers), enforce permissions (lock, view-only links), and persist reliably. Data is stored in plain JSON on the owner's VM.

**Same merge rules as Excalidraw.** The server reconciles with the version/versionNonce rule clients already use, so client code could reuse excalidraw-app's reconcile pipeline and everyone converges.

**Pages = separate element lists.** The editor holds one page; other pages live in memory in the session. Alternatives (one big canvas with offsets, or filtering by page inside the editor) would need deep changes to `packages/` (selection, select-all, export, hit testing…).

**JSON files, no database.** Zero native dependencies, trivial backups (`tar` the volume), plenty fast for a team/class (hundreds of users/papers). Writes are atomic and debounced. If it ever outgrows this, `store.ts` is the only place to change.

**One process, bundled.** `dist/server.mjs` contains socket.io; the Docker image is just Node + that file + the built app. Static assets are compressed once and kept in memory.

**Embeds via a secret link.** Third-party iframes don't get first-party cookies, so embeds use a per-paper token in the URL hash (never sent to servers or in `Referer`), presented when joining. Resetting the token revokes all links at once.

**Templates and PDF pages are locked images.** Everyone sees exactly the same background, it appears in thumbnails, exports and print, and it reuses the image pipeline. pdf.js runs only in the importing browser (lazy-loaded); others just download the rendered page images.

**Math as SVG images.** MathJax renders LaTeX to SVG with glyphs as paths (no fonts needed), so a formula is just an image: it syncs, prints and exports like any other, and the editor already inverts SVG images in dark mode. The LaTeX source lives in `customData.whiteboardMath` for editing. MathJax (~1.3 MB) only loads in the browser of whoever opens the math editor.

### Changes to `packages/`

Partial text colors needed the editor core (a textarea-based editor and single-color text rendering can't be extended from outside). The change is additive and inert for texts without colors:

- `packages/element/src/textColorRanges.ts` (new): apply/shift/normalize ranges, map them onto wrapped lines. Tests: `packages/element/tests/textColorRanges.test.ts`.
- `packages/element/src/types.ts`: optional `colorRanges` on text elements (`TextColorRange`).
- `packages/element/src/renderElement.ts`, `packages/excalidraw/renderer/staticSvgScene.ts`: draw lines segment by segment when a line has several colors (RTL text keeps one color).
- `packages/excalidraw/data/restore.ts`: keeps valid ranges, only adds the property when there are colors.
- `packages/excalidraw/components/App.text.ts`: shifts ranges while typing.
- `packages/excalidraw/actions/actionProperties.tsx`: the stroke color applies to the textarea's selection while editing.
- `packages/excalidraw/wysiwyg/textWysiwyg.tsx` + `css/styles.scss`: a colored copy of the text behind the (then transparent) textarea, only while the text has colors.
- Tests: `packages/excalidraw/tests/textColorRanges.test.tsx` (SVG export, restore).

When merging upstream, conflicts would show up in those files; the logic itself lives in `textColorRanges.ts`.

## Known limitations

- Undo/redo history resets when switching pages (Excalidraw has no API to save and restore history per page).
- Undo/redo only covers your own changes (as in Excalidraw collaboration).
- One server process (no horizontal scaling); live papers are in memory.
- PDF import: text that relies on non-embedded fonts/CMaps (some CJK PDFs) may render with fallback fonts, as pdf.js standard fonts/CMaps aren't bundled.
- The dashboard cover only updates from the first page and from people who can edit.
- Guests are identified by a random id in their browser; their name is whatever they typed (or `?name=`).
- No audio/video or chat (Bitpaper has both).
- Partial colors are colors only (no bold/italic per word); right-to-left text is drawn in one color.
- Formulas are images: they can be resized but not restyled word by word; editing re-renders them.

## Ideas for next steps

- Per-page undo history (would need an Excalidraw history snapshot API).
- Text chat in the pages panel; optional audio via WebRTC (big).
- Export/import a whole paper (all pages) as a file.
- "Students' own pages": a page per student that only they and the teacher can edit.
- Paper folders/tags and search on the dashboard.
- Bundle pdf.js CMaps/standard fonts for better PDF text fidelity.
- Admin audit: last sign-in per user, who changed what.
- Rate limits for guest connections on public links.
