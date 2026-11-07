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

**Latency first.** People talk while they draw, so strokes must reach others in step with their voice. Sends are per frame with the first change immediate (no 30 ms throttle), strokes send only their new points (≈ 5× fewer bytes), and on a congested link changes merge instead of queueing. Images go over HTTP (a separate connection) when big, so they never hold up strokes; a small preview over the live connection makes them visible at once. While drawing, the cursor goes out every frame too (in step with the ink; every 33 ms when just hovering, to spare classes full of mice). Measured with `e2e/latency.mjs` (development.md).

**Live strokes: others' strokes on an overlay while they're drawn.** On an empty page the app adds ~5 ms to the network delay, but profiling a page of notes (800 strokes) on a 4× slowed CPU (a tablet) showed the viewer busy 60 % of the time: Excalidraw redraws every element whenever one changes, and someone else's growing stroke is a change per point — ~20 ms a frame, more than a frame's budget, so the browser fell behind reading the connection (57 ms queued), merged updates and showed strokes in jumps (112 ms median, 134 ms p95). The person drawing doesn't have this problem: Excalidraw draws their stroke on a small canvas of its own. `liveStrokes.ts` does the same for everyone else's strokes: the sender lists its stroke in `drawing` (protocol.md); receivers draw it on an overlay canvas (`ShapeCache` outline + `applyDarkModeFilter`, so it looks exactly like the page's copy) and put it into the page once, when it's finished. Result on the same setup: 28 ms median, 33 ms p95, every update shown; handwriting (many short strokes) 57 → 29 ms median, 104 → 46 ms p95. Patches build on the overlay's copy; page switches, a 2 s timeout and full server state commit live strokes. The overlay is inserted before the editor with z-index 2: above the page canvas, below Excalidraw's interactive layer (cursors) and UI — "z-index 1 after the editor" failed because React inserted the editor's root after it, and the overlay ended up hidden under the page (the smoke test now checks pixels, not just state). `localStorage["whiteboard-live-strokes"] = "off"` (or `latency.mjs --no-live-strokes`) restores the old path for comparisons.

**Heavy renders wait for a quiet moment.** The dashboard cover (a PNG of the first page) was rendered by every participant who can edit, 6 s after any change — a few hundred milliseconds on a tablet, landing in the middle of someone's stroke. Now only whoever made the change renders it, and like the pages panel's thumbnails it waits (`runWhenQuiet`) until nobody is drawing and the browser is idle.

**Math as SVG images.** MathJax renders LaTeX to SVG with glyphs as paths (no fonts needed), so a formula is just an image: it syncs, prints and exports like any other, and the editor already inverts SVG images in dark mode. The LaTeX source lives in `customData.whiteboardMath` for editing. MathJax (~1.3 MB) only loads in the browser of whoever opens the math editor.

**Pen, fingers and palms (tablets).** Teachers write with an Apple Pencil or S Pen while resting their hand on the screen; students may use a tablet with or without a pen. Excalidraw's pen mode (on at the first pen touch) ignores single fingers for drawing tools, but a palm still gets through: a touch during a stroke ends it (or deletes it when short), moves/zooms the page, and with the selection tool selects, makes a text on a double tap or opens the context menu after a long press; pinch-zoom is off while the pen tool is active. Rather than changing those paths in `App.tsx` (pointer, touch, Safari gesture and context-menu handlers, plus window listeners added during a stroke), `editor/tabletInput.ts` filters input **in front of** the editor: window listeners in the capture phase run before anything else, so swallowed events never reach Excalidraw. The rules:

- a touch while a pen is down is a **palm** — anywhere in the editor, buttons included (its touchstart is canceled, so no click). Also with pen mode off: nobody draws with pen and finger at once.
- in pen mode, a touch on the canvas within 500 ms after the pen lifted is a palm (the hand repositioning between strokes); any other touch on the canvas **navigates** — one finger pans, two pinch, anchored so the scene point under the fingers stays there. The pen landing turns navigating fingers into a palm. Fingers on the UI go to the editor as usual.
- touch events carry no pointerId, so a touchstart is matched to the claimed pointerdown at the same position (browsers dispatch pointer events first); Safari's Apple Pencil touches (`touchType: "stylus"`) are never claimed, so double-tapping a text with the pen still edits it.
- a navigating finger closes menus like a tap on the canvas would: Excalidraw's `openMenu`/`openPopup`/`contextMenu` are reset and a synthetic `pointerdown` on `<body>` reaches outside-click handlers (main menu, pages panel).
- moving the view with fingers stops following someone, as Excalidraw does.
- pen mode is stored in `localStorage` once a pen was seen and restored at load (with `penDetected`), so a palm can't draw before the first pen stroke of a lesson; a hovering pen also turns it on.
- **long press → context menu.** Swallowing fingers took away Excalidraw's long-press menu, and an Apple Pencil has no button — yet the menu is where _Unlock_ (imported backgrounds), paste, layers… live. With the selection tool, a pen or finger held still for 500 ms gets a synthetic `contextmenu` on the canvas (Excalidraw opens its menu for that point). A finger only when the pen hasn't touched for a second — right after writing, a still touch is the palm. Android's own pen long-press menu cancels ours.
- **two-finger tap = undo, three = redo** (fingers lifted within 300 ms, none moved > 10 px), as in GoodNotes or Procreate. Excalidraw has no undo API, so `sendHistoryShortcut` dispatches its keyboard shortcut (Ctrl/Cmd+Z, +Shift for redo) on the document; a toast confirms.

**Pen bar.** Switching between pen colors, a highlighter and the eraser is constant in tutoring; in Excalidraw it's tool + color + opacity in the properties panel (a popover on tablets). `PenTray.tsx` sets the tool and `currentItem*` through the API. A highlighter needs a wide uniform stroke, but stroke widths are keys (`thin`/`medium`/`bold`) and the widest uniform freehand stroke is under 3 px, so `widenHighlighterStroke` (called from `onChange`) sets `strokeWidth: 12` on the stroke as it starts — before it is first rendered or sent. The pens' stroke style (pressure or not) is kept while the highlighter is in use.

**Bars that fit (`fit.ts`).** Excalidraw's top bar and footer are grids/flex rows that grow with their content: on a tablet in portrait our buttons pushed Lock, Present and Pages off the screen (out of reach). `useFitLevel` renders the roomiest version, and if anything in the bar ends past its edge, steps to a more compact one before the browser paints (no flicker); it starts over on resize (of the editor, never of the bar — no feedback loop) or when what's shown changes (people joining, presenting, a docked panel). Top right: labels → icons → only what's on (locked, presenting) → not even Pages; at that last level Excalidraw's Library and collaboration laser buttons are hidden by CSS (Library is in our main menu, the laser in the toolbar's ⋮ menu) and the page bar's label (with a pages icon) opens the panel. Present and Lock are always in the pages panel. Footer: page bar → `2/5` → two pens → no pens. Measured instead of media queries because the room depends on the toolbar, the number of avatars, the language and the sidebar.

**Screen on during lessons.** A student following the presenter doesn't touch the tablet, which dims and locks after a minute or two. While someone else is in the paper, the editor holds a Screen Wake Lock (taken again when the tab comes back; nothing happens where it isn't supported or without HTTPS). Not while alone, so a forgotten tab doesn't keep a screen on all night.

Not a contact-size heuristic (`PointerEvent.width/height`): values differ a lot between devices, and a false positive would make fingers useless. iPadOS and Samsung tablets reject most palms themselves; this catches the rest. Tested in Chromium with pen and touch input from the DevTools protocol (`e2e/tablet.mjs`), and against the editor without the filter (the palm checks fail there).

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

Smooth handwriting needed the freedraw pointer handler: moves are handled once per frame (`withBatchedUpdatesThrottled`), and an Apple Pencil reports 240 positions a second — the browser coalesces them into one event, so 3–4 of every 4 were dropped and fast handwriting turned angular. Window-level filtering can't add points to a stroke, so:

- `packages/excalidraw/components/App.tsx`: `getPointerSamples(event)` returns `event.getCoalescedEvents()` for pens and touch (just the event for a mouse, or where unsupported), and the freedraw branch of `onPointerMoveFromPointerDownHandler` adds a point (and its pressure) per sample instead of one per frame. Nothing else changes; a mouse gives exactly the points it did.
- Tests: `packages/excalidraw/tests/freedrawPenSamples.test.tsx`.

Replacing an image's data (a preview by the full picture) needed an option on `addFiles`, which skips ids it already has:

- `packages/excalidraw/types.ts`: `addFiles(files, { replace?: boolean })` on `ExcalidrawImperativeAPI`.
- `packages/excalidraw/components/App.tsx`: with `replace`, files whose data differs are replaced; the new picture is decoded first and only then swapped into the image cache (`swapReplacedImages`), so there's no placeholder flash. Without the option nothing changes.
- Tests: `packages/excalidraw/tests/addFiles.test.tsx`.

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
- Tablets: a highlighter looks dark amber in dark mode (Excalidraw inverts colors per viewer; there's no color that is a light highlight in both themes).
- Tablets: without a pen, a palm can't be told from a finger (it draws). A palm that lands before the pen moves the page until the pen touches down (the movement isn't undone). If a browser dispatched a touch's `touchstart` before its `pointerdown`, that finger's touch events would reach the editor (a finger double tap could still make a text with the selection tool). Dragging pages in the pages panel uses HTML drag & drop, which not every tablet browser supports — `⋯` → Move up/down always works.

## Ideas for next steps

- Per-page undo history (would need an Excalidraw history snapshot API).
- Text chat in the pages panel; optional audio via WebRTC (big).
- Export/import a whole paper (all pages) as a file.
- "Students' own pages": a page per student that only they and the teacher can edit.
- Paper folders/tags and search on the dashboard.
- Bundle pdf.js CMaps/standard fonts for better PDF text fidelity.
- Admin audit: last sign-in per user, who changed what.
- Rate limits for guest connections on public links.
