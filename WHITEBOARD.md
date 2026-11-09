# Self-hosted whiteboard (papers, pages, accounts, embeds)

This fork adds a self-hosted, multi-user whiteboard built on the Excalidraw editor — for classes, tutoring, or your team.

- **Papers with pages** (like Bitpaper): create as many papers as you like, each with as many pages as you need. Add, rename, reorder (drag & drop), duplicate and delete pages; switch with the page bar, the pages panel (with live thumbnails) or <kbd>Alt</kbd>+<kbd>PageUp</kbd>/<kbd>PageDown</kbd> (<kbd>Alt</kbd>+<kbd>N</kbd> adds a page).
- **Worksheets & paper**: import a **PDF** (each page becomes a page) or images, or add **lined, grid or dotted** pages. The background is locked so everyone writes on top of it.
- **Real-time collaboration**: everyone sees drawings, cursors, laser pointer and selections live. The pages panel shows who is on which page.
- **Accounts**: you are the admin and create an account for each person. Papers are shared with the people you pick; they only see what's shared with them.
- **Share the view** (like Bitpaper): with _View → Together_ everyone sees the same page and the same part of it — whoever scrolls, zooms or turns the page moves it for everyone, on any screen size. Or _Same page_ (page turns are shared, zoom is everyone's own), _Follow me_ (everyone follows you while you teach) or _On their own_. Anyone can _look around on their own_ and come back with one tap, and you can see where the others are looking.
- **Run the session**: _Bring everyone here_ moves everybody to your page once, _Lock_ makes the paper view-only for everyone but you, and clicking a person's avatar follows their view (across pages).
- **Embed on other websites**: turn on a paper's public link and paste the `<iframe>` code into any page — visitors join live without an account.
- **LaTeX math**: insert formulas (_∑ Math_ or <kbd>Alt</kbd>+<kbd>M</kbd>) with a live preview and buttons for common structures and symbols; double-click a formula to edit it.
- **Colored words**: while editing a text, select part of it and pick a color — only those words change color.
- **Tablets with a pen** (iPad + Apple Pencil, Samsung/Android + S Pen): the pen writes — smoothly, with every point the pen reports — fingers pan and pinch-zoom, a hand resting on the screen while writing is ignored (palm rejection), two-finger tap undoes. Tablets without a pen draw with a finger. The screen stays on during a lesson.
- **Pen bar**: one tap for a black, red, blue or green pen, a highlighter or the eraser.
- **Images**, export of a page as PNG/SVG/`.excalidraw`, and **Print / PDF of all pages**.
- **Fast, also on weak connections and full pages**: what you write reaches the others as you write it — in step with your voice — with only the network delay added (strokes send just their new points; a slow link never piles up stale updates; a stroke being drawn is shown on its own layer, so a page full of notes on a tablet keeps up; your cursor follows your pen). A pasted screenshot shows up for others right away as a quick preview and sharpens once fully loaded. A single small Node.js process keeps open papers in memory; the app is served compressed and cached.

Everything — accounts, papers, images — stays on your own server.

---

## Install on your VM (Docker)

You need a Linux VM with [Docker](https://docs.docker.com/engine/install/) (including the Compose plugin), about 4 GB of free RAM for building the image (less: see [Little RAM?](#little-ram-build-the-image-elsewhere)), and ports **80** and **443** open — or an nginx that already serves them (see [below](#already-running-nginx-or-another-proxy)).

```bash
git clone <your fork's URL> extracalidraw
cd extracalidraw/deploy
cp .env.example .env
nano .env        # set DOMAIN and ADMIN_PASSWORD
chmod 600 .env
docker compose up -d --build
```

Open `https://<DOMAIN>` and sign in as `admin` with your `ADMIN_PASSWORD`.

The first build takes a few minutes (it compiles the app); restarts are instant.

- A password with special characters (`$`, `!`, `@`, `#`, spaces) goes in **single quotes** in `.env`: `ADMIN_PASSWORD='p@ss$word!'`. Compose reads single-quoted values as they are.
- **On the server, only change untracked files**: `deploy/.env` and `deploy/docker-compose.override.yml` (both git-ignored). If a tracked file such as `docker-compose.yml` is edited there, the next `git pull` stops.

### Try it on your computer first

- **Without Docker** (just Node.js): follow [Without Docker](#without-docker) and open `http://localhost:3002`. Browsers treat `localhost` as secure, so no certificate is needed.
- **With Docker**: set `DOMAIN=localhost` in `.env` and open `https://localhost`. Caddy uses its own certificate, so the browser warns until you trust it.

### Domain or IP address?

The app needs HTTPS: browsers only allow clipboard access, image hashing and embedding into other HTTPS sites from secure pages. Caddy (included) handles certificates for you (with your own nginx, certbot does — [below](#already-running-nginx-or-another-proxy)):

| `DOMAIN` in `.env` | Result |
| --- | --- |
| `board.example.com` | Free, trusted Let's Encrypt certificate. Point the domain's DNS (A record) to the VM first. |
| `192.168.1.50` (the VM's IP) | Certificate from Caddy's own authority: works, but browsers show a warning until you trust it. Fine for a private network/LAN. |

> No domain? Free options include [DuckDNS](https://www.duckdns.org) or `<ip-with-dashes>.sslip.io` style names (e.g. `203-0-113-7.sslip.io`).

### Already running nginx (or another proxy)?

When nginx already serves other sites on ports 80/443, the app listens on the server only, nginx passes requests to it, and the bundled Caddy isn't started. Nothing that's already there is edited: the app gets an untracked override file, nginx a new site.

1. In `deploy/`, next to your `.env` (keep `DOMAIN` set — Compose still requires it):

   ```bash
   cp docker-compose.override.nginx.example.yml docker-compose.override.yml
   docker compose config --services     # lists only: whiteboard
   ```

   Compose reads `docker-compose.override.yml` by itself. It publishes the app on `127.0.0.1:3002`, and `profiles: ["caddy"]` keeps Caddy off without touching `docker-compose.yml` (so `git pull` keeps working).

2. Start the app and wait until it answers — before touching nginx:

   ```bash
   docker compose up -d --build
   curl -s http://127.0.0.1:3002/api/health     # {"ok":true} (give it a few seconds)
   ```

3. Add a **new** nginx site from [`deploy/nginx.conf.example`](deploy/nginx.conf.example) (it passes WebSockets and the original `Host` header on, which the app needs):

   ```bash
   sudo cp nginx.conf.example /etc/nginx/sites-available/whiteboard
   sudo nano /etc/nginx/sites-available/whiteboard       # server_name: your domain
   sudo ln -s /etc/nginx/sites-available/whiteboard /etc/nginx/sites-enabled/
   ```

   No `sites-available`? Put it in `/etc/nginx/conf.d/whiteboard.conf` instead.

4. Test the configuration, then **reload** (not restart — the other sites stay up):

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

5. HTTPS with certbot. `--redirect` adds the http → https redirect without asking:

   ```bash
   sudo certbot --nginx -d <your domain> --redirect
   ```

   certbot adds the HTTPS part to the new site and renews the certificate by itself (`certbot.timer`).

**Port 3002 taken?** Change only the left number in `docker-compose.override.yml` (`"127.0.0.1:3005:3002"`), and use the same port in nginx's `proxy_pass` (and as `DEPLOY_PORT` for the [deploy script](#updates)).

Another proxy (Apache, Traefik, …)? Forward to `127.0.0.1:3002` and pass WebSocket upgrades, the `Host` header and `X-Forwarded-For`/`-Proto` on.

### Check it works

```bash
docker compose ps                                # whiteboard: Up … (healthy)
curl -sI https://<domain> | head -1              # … 200 (curl refuses an invalid certificate)
curl -s https://<domain>/api/health              # {"ok":true}
curl -sI http://<domain> | grep -i -E '^(HTTP|location)'   # 301 (Caddy: 308) to https://…
curl -si --http1.1 --max-time 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  'https://<domain>/socket.io/?EIO=4&transport=websocket' | head -1   # expect 101
```

The last one is live collaboration: anything but `101 Switching Protocols` means the proxy doesn't pass WebSockets on. `deploy/deploy.sh --status` runs these checks from your computer ([Updates](#updates)).

### Little RAM? Build the image elsewhere

Building needs 3–4 GB of free RAM (the build gets killed otherwise). On a smaller server, build on your computer and send the image over — `deploy/deploy.sh --ship-image` does all of it, or by hand:

```bash
# on your computer, in the repository (Apple Silicon too: the build stage runs natively)
docker buildx build --platform linux/amd64 -f whiteboard-server/Dockerfile -t extracalidraw-whiteboard --load .
docker save extracalidraw-whiteboard | gzip | ssh <server> 'gunzip | docker load'
# on the server
cd ~/extracalidraw && git pull && cd deploy && docker compose up -d --no-build
```

---

## Using it

1. **Add people** — _People_ → _Add person_, or _Add many…_ to paste a list of names (one per line) and get usernames and passwords for everyone (copy or download as CSV). Admins can reset passwords, disable or delete accounts any time.
2. **Create a paper** — _Papers_ → _New paper_, pick who it's shared with. `⋯` on a paper lets you rename it, change who it's shared with, set up the public link/embed, duplicate it (great for reusable worksheets/templates) or delete it.
3. **Pages** — the page bar at the bottom (`‹ Page 2 / 5 › +`) and the _Pages_ panel (top right; pin it to keep it open). _New page ▾_ offers blank, lined, grid and dotted paper, and **Import PDF or images…** (or drop a PDF onto the canvas). Imported backgrounds are locked; right-click → _Unlock_ to move them. Everyone who can draw may add, rename and reorder pages; only the owner and admins delete them.
4. **Run a session** — top right, and always in the _Pages_ panel: _View_ (see below) and _Lock_ (view-only for everyone else); in the _Pages_ panel also _Bring everyone here_. Click someone's avatar to follow them. On smaller screens the top-right buttons shrink to icons, then make way (View/Lock stay in the _Pages_ panel, Math and Library in the menu ☰, the page bar opens the _Pages_ panel).
5. **View — how everyone's view is shared.** The owner and admins choose, in _View_ (top right or _Pages_ panel); it's kept with the paper (and its copies), so a tutoring paper can always open in _Together_:

   | Mode | What happens |
   | --- | --- |
   | _On their own_ (default) | everyone scrolls, zooms and turns pages on their own |
   | _Same page_ | when someone turns the page, everyone does; zoom and scrolling stay everyone's own — good for a class reading a worksheet on small tablets |
   | _Together_ | one view for everyone, as in Bitpaper: whoever scrolls, zooms (fingers, mouse, trackpad) or turns the page moves it for everyone. Screens of any shape show at least the same area; someone joining later starts there; if someone moves it while you're writing, your page waits until you lift the pen |
   | _Follow me_ | everyone follows your page and view; only you move it (presenting). Choosing another mode ends it — in _Together_ or _Same page_, everyone carries on from where you are |

   People who can't draw (a locked paper, a view-only link) follow the shared view but don't move it. For yourself, in _View_: **Look around on my own** (the others aren't moved, and nothing moves you) — **Back to the shared view** (or the badge at the bottom) brings you back; moving the view when you can't draw, or following someone, does the same. **Show where others are looking** outlines what each person on your page sees, in the color of their cursor; someone looking elsewhere gets a name at the edge of the screen, pointing their way. It's on for the owner and admins, off for everyone else, and remembered on each device. _Bring everyone here_ also brings back those looking around.

6. **Math** — _∑ Math_ (top right), <kbd>Alt</kbd>+<kbd>M</kbd> or menu → _Insert math (LaTeX)_. Type LaTeX (e.g. `\frac{a}{b}`, `x^2`, `\sqrt{x}`) or use the buttons, pick a color and size, then _Insert_ (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>). Double-click a formula (or select it and press <kbd>Enter</kbd>) to change it. Chemistry works too: `\ce{H2O}`.
7. **Color part of a text** — double-click a text to edit it, select the words, then click a color in the panel on the left. Picking the text's own color removes the coloring. New text you type continues the color of the character before it.
8. **Print / PDF** — menu (☰) → _Print / PDF (all pages)_; choose “Save as PDF” in the print dialog.
9. **Pen bar** — at the bottom, next to the page bar: black, red, blue and green pens, a **highlighter** (wide, see-through yellow) and the **eraser**, one tap each. On narrow screens it shows fewer colors (the full palette is in the panel on the left).
10. **Tablets & pens** — as soon as a pen touches (or hovers over) the screen, the whiteboard switches to _pen mode_:

- the **pen** draws, selects, erases — everything a mouse does (double-tap a text or formula with the pen to edit it); hold it still for half a second with the selection tool for the menu (copy, paste, _Unlock_…);
- **one finger** moves the page, **two fingers** pinch to zoom; fingers never draw or select on the canvas, but work as usual on buttons and panels. A finger held still with the selection tool also opens the menu;
- **tap with two fingers to undo, with three to redo**;
- your **palm** can rest on the screen while you write: touches while the pen is down (and just after it lifts) are ignored, so the stroke isn't cut and the page doesn't slide.

The hand button at the end of the pen bar (it appears once a pen was used) lets fingers draw too, and turns pen mode back on; the pen button in Excalidraw's toolbar does the same. The choice is remembered on that device, so the next lesson starts in the same mode. Tablets without a pen (e.g. a student's tablet) simply draw with a finger. While someone else is in the paper, the screen doesn't dim or lock (needs HTTPS). Menu (☰) → _Full screen_ hides the browser's bars. Made for Safari on iPad and Chrome or Samsung Internet on Android. Pages can be reordered on a tablet with `⋯` → _Move up / Move down_ in the _Pages_ panel.

Each person's own preferences (theme, language, shape library) stay in their browser.

Undo/redo works per page and only for your own changes; switching pages starts a fresh undo history.

---

## Embedding on another website

1. On the dashboard: `⋯` → _Rename, share & embed…_ (or in the editor: menu ☰ → _Share & embed…_).
2. Turn on **Public link & embed** and choose **Can draw** or **View only**.
3. Copy the **embed code** into your website:

```html
<iframe
  src="https://board.example.com/embed/<paper-id>#token=<secret>"
  width="100%"
  height="600"
  style="border:0;border-radius:8px"
  allow="clipboard-read; clipboard-write; fullscreen"
  allowfullscreen
>
</iframe>
```

Anyone who can open that page joins the paper live, without an account (they type their name the first time). Options, added before the `#`:

| Parameter | Example | Effect |
| --- | --- | --- |
| `name` | `?name=Alice` | Sets the visitor's name (e.g. from your site's login). |
| `theme` | `?theme=dark` | `light` or `dark`. |
| `page` | `?page=<page-id>` | Opens a specific page. |

Combine them with `&`: `/embed/<paper-id>?name=Alice&theme=dark#token=…`.

- **Reset link** creates a new secret: old links and embeds stop working immediately and guests on them are disconnected.
- Turning the public link off disconnects all guests.
- Guests can't delete pages, lock the paper or see the link settings.
- To only allow embedding on your own sites, set `EMBED_ALLOWED_ORIGINS=https://mysite.com https://www.mysite.com`. The rest of the app (dashboard, login) can never be embedded.

---

## Configuration

Set in `deploy/.env` (Docker) or as environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `DOMAIN` | – | Domain or IP address Caddy serves (Docker setup only; keep it set behind your own nginx too, Compose requires it). |
| `APP_NAME` | `Extracalidraw` | Name on the login page and the browser tab. |
| `ADMIN_USERNAME` | `admin` | First admin account (created on the very first start). |
| `ADMIN_PASSWORD` | random | Its password. When empty, a random password is printed in the logs. |
| `RESET_ADMIN_PASSWORD` | – | `true`: on start, reset the admin's password to `ADMIN_PASSWORD`. |
| `EMBED_ALLOWED_ORIGINS` | `*` | Websites allowed to embed papers (`*`, a space separated list, or `none`). |
| `PORT` | `3002` | Port of the Node server. |
| `DATA_DIR` | `./data` | Where everything is stored (`/data` in Docker). |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-*` headers from your reverse proxy. |
| `COOKIE_SECURE` | `auto` | `auto` marks the login cookie Secure on HTTPS. |
| `SESSION_TTL_DAYS` | `30` | How long people stay signed in. |
| `MAX_FILE_MB` | `10` | Max size of an uploaded image. |
| `PERSIST_DEBOUNCE_MS` | `1500` | How often changes are written to disk while people draw. |

**Forgot the admin password?** Set a new `ADMIN_PASSWORD`, set `RESET_ADMIN_PASSWORD=true`, run `docker compose up -d`, sign in, then clear `RESET_ADMIN_PASSWORD` again.

---

## Backups & updates

All data lives in the `whiteboard-data` Docker volume (or `DATA_DIR`): a small `db.json` (accounts, papers) plus one folder per paper (pages as gzipped JSON, images). Copies of a paper share its images (hard links, which `tar` keeps). The server tidies up after itself: images no longer used anywhere in a paper are deleted (30 days after they were erased), and so are the contents of pages deleted more than 30 days ago (`TOMBSTONE_TTL_DAYS`).

```bash
# backup
docker run --rm -v deploy_whiteboard-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/whiteboard-$(date +%F).tgz -C /data .

# restore
docker compose stop whiteboard
docker run --rm -v deploy_whiteboard-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/whiteboard-YYYY-MM-DD.tgz -C /data"
docker compose start whiteboard
```

**Daily backups** (optional): add a line with `crontab -e` on the server, as the user who runs Docker. Cron wants absolute paths and `%` written as `\%`; this one keeps 14 days:

```cron
30 3 * * * mkdir -p /home/you/whiteboard-backups && docker run --rm -v deploy_whiteboard-data:/data:ro -v /home/you/whiteboard-backups:/backup alpine tar czf /backup/whiteboard-$(date +\%F).tgz -C /data . && find /home/you/whiteboard-backups -name 'whiteboard-*.tgz' -mtime +14 -delete
```

Copy a backup off the server now and then (`scp`): one on the same disk doesn't survive losing the VM.

### Updates

On the server:

```bash
cd ~/extracalidraw && git pull && cd deploy && docker compose up -d --build && docker image prune -f
```

Data, accounts and settings stay; `docker image prune -f` removes the images the update replaced.

**Or from your computer, in one command:** [`deploy/deploy.sh`](deploy/deploy.sh) does the same over ssh, with checks before and after. Once: copy `deploy/.deploy.env.example` to `deploy/.deploy.env` (git-ignored) and set `DEPLOY_HOST` (your ssh target) and `DEPLOY_URL`. Then commit, push `main`, and:

```bash
deploy/deploy.sh               # deploy what's on GitHub's main
deploy/deploy.sh --status      # what runs there: commit, health, memory, disk (changes nothing)
deploy/deploy.sh --dry-run     # run the checks, print what it would do
deploy/deploy.sh --backup      # back up the data first (~/whiteboard-backups on the server)
deploy/deploy.sh --rollback    # the new version misbehaves: run the previous image again
deploy/deploy.sh --ship-image  # build here instead (servers with little RAM)
```

A deploy:

1. checks this computer: on `main`, nothing uncommitted, everything pushed — the server pulls from GitHub, so anything else wouldn't be deployed;
2. checks the server: ssh, Docker Compose, no tracked files changed there (`git pull` would stop), ~3.5 GB of free RAM for the build, free disk;
3. keeps the running image as `extracalidraw-whiteboard:previous`, then runs `git pull --ff-only`, `docker compose up -d --build` and `docker image prune -f` (which only removes untagged images, so `:previous` stays);
4. waits up to 2 minutes for `/api/health` — if the app doesn't come up, it prints its logs and suggests `--rollback`;
5. checks from your computer, like a browser: the page and its certificate, `/api/health`, the WebSocket upgrade, http → https.

It needs a key login (`ssh <host>` without a password prompt) and Docker without sudo for that user (the `docker` group). It never uses sudo, never removes volumes and never reads `.env`; setting up nginx and certbot stays a one-time step by hand ([above](#already-running-nginx-or-another-proxy)). `--rollback` only switches the image back: the server's checkout stays on the new commit, so push a fix (or a `git revert`) before deploying again, and data the new version wrote stays as it is.

---

## Without Docker

Requires Node.js 20+. Dependencies are pinned in `yarn.lock` and installed with Yarn 1, which Corepack (part of Node.js) provides — all other commands use npm. Don't run `npm install`: it ignores `yarn.lock`.

```bash
corepack enable           # once: provides the Yarn version the scripts use
corepack yarn install     # install dependencies (a few minutes the first time)
npm run whiteboard:build
DATA_DIR=/var/lib/whiteboard ADMIN_PASSWORD=change-me npm run whiteboard:start
```

The server listens on port 3002 (set `PORT=…` if that port is taken) and serves the app itself; put it behind a reverse proxy for HTTPS (see the nginx example above). `whiteboard-server/dist/server.mjs` has no dependencies — together with `whiteboard-app/build` it's all you need to copy to a server (`STATIC_DIR=<path to build> node server.mjs`).

### Development

```bash
npm run whiteboard:dev:server   # API + live server on :3002 (data in whiteboard-server/data)
npm run whiteboard:dev:app      # app with hot reload on http://localhost:3003
```

On another port: `PORT=3005 npm run whiteboard:dev:server` and `VITE_APP_WHITEBOARD_SERVER=http://localhost:3005 npm run whiteboard:dev:app`.

---

## How it works

```
browser ──HTTPS──▶ Caddy or your own nginx ──▶ whiteboard-server (Node.js, one process)
                                                ├─ REST API: login, people, papers, images
                                                ├─ Socket.IO: live pages, cursors, presence
                                                └─ serves whiteboard-app (the built React app)
```

- `whiteboard-app/` — the React app: login, dashboard, people, and the editor (the Excalidraw package from `packages/`) with the pages UI.
- `whiteboard-server/` — the server. Open papers are kept in memory; every change is merged with Excalidraw's rules (higher element version wins, ties broken deterministically), forwarded only to the others in the paper, and written to disk shortly after. Cursors go only to people on the same page. If a connection drops, edits are kept and sent when it's back.
- Sharing the view (_Together_) sends the area of the page being looked at, not a screen position, so screens of different shapes show the same area without zooming out a little more every time someone else moves it; the server numbers each move, so two people moving at once end up in the same place. Others' moves glide instead of jumping.
- Live updates go out at once (at most one message per screen frame): a stroke being drawn only sends its newest points, and when a connection is slow, changes are merged instead of queued. Images go over the live connection when small; big ones first send a small preview there and upload the full picture separately, so they never hold up drawing. `node whiteboard-app/e2e/latency.mjs` measures it (see the developer notes).
- Passwords are hashed with scrypt, logins are rate-limited, sessions are `HttpOnly` cookies, and the API rejects cross-site requests.

## Troubleshooting

- **“Reconnecting…” never goes away** — your proxy doesn't pass WebSockets (see the nginx example), or a firewall blocks them.
- **Logged in, but papers won't open (“live connection was refused”)** — the proxy drops cookies or changes the `Host` header on WebSocket requests.
- **Strokes arrive late for everyone** — it's the network: host the server close to you and your students (same country/region), as each stroke travels to the server and back out. The app itself adds only a few milliseconds.
- **Browser warns about the certificate** — expected when `DOMAIN` is an IP address; use a domain name for a trusted certificate.
- **`git pull` on the server stops ("local changes would be overwritten")** — a tracked file was edited there. Move the change into `deploy/.env` or `deploy/docker-compose.override.yml`, then `git checkout -- <file>`.
- **`Bind for 127.0.0.1:3002 failed: port is already allocated`** — something else uses the port: see "Port 3002 taken?" under [nginx](#already-running-nginx-or-another-proxy).
- **The build stops with `Killed` or exit code 137** — not enough RAM: see [Little RAM?](#little-ram-build-the-image-elsewhere).
- **The admin password from `.env` doesn't work** — a `$` in an unquoted value is read as a variable: put the password in single quotes and reset it (see "Forgot the admin password?").
- **An embed shows “refused to connect”** — the site isn't listed in `EMBED_ALLOWED_ORIGINS`, or the page isn't served over HTTPS.
- **On a tablet, my finger doesn't draw** — pen mode is on (a pen was used on this device). Tap the hand button at the end of the pen bar to let fingers draw.
- **On a tablet, the page doesn't move right after writing** — a finger touching within half a second after the pen lifts counts as the palm; lift and try again.
- Logs: `docker compose logs -f whiteboard`.

---

Developer notes (architecture, protocol, tests): [`docs/whiteboard/`](./docs/whiteboard/README.md).
