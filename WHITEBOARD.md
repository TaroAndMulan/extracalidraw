# Self-hosted whiteboard (papers, pages, accounts, embeds)

This fork adds a self-hosted, multi-user whiteboard built on the Excalidraw editor — for classes, tutoring, or your team.

- **Papers with pages** (like Bitpaper): create as many papers as you like, each with as many pages as you need. Add, rename, reorder (drag & drop), duplicate and delete pages; switch with the page bar, the pages panel (with live thumbnails) or <kbd>Alt</kbd>+<kbd>PageUp</kbd>/<kbd>PageDown</kbd> (<kbd>Alt</kbd>+<kbd>N</kbd> adds a page).
- **Worksheets & paper**: import a **PDF** (each page becomes a page) or images, or add **lined, grid or dotted** pages. The background is locked so everyone writes on top of it.
- **Real-time collaboration**: everyone sees drawings, cursors, laser pointer and selections live. The pages panel shows who is on which page.
- **Accounts**: you are the admin and create an account for each person. Papers are shared with the people you pick; they only see what's shared with them.
- **Run the session**: _Present_ makes everyone follow your view and page while you teach, _Bring everyone here_ moves everybody to your page once, _Lock_ makes the paper view-only for everyone but you, and clicking a person's avatar follows their view (across pages).
- **Embed on other websites**: turn on a paper's public link and paste the `<iframe>` code into any page — visitors join live without an account.
- **LaTeX math**: insert formulas (_∑ Math_ or <kbd>Alt</kbd>+<kbd>M</kbd>) with a live preview and buttons for common structures and symbols; double-click a formula to edit it.
- **Colored words**: while editing a text, select part of it and pick a color — only those words change color.
- **Images**, export of a page as PNG/SVG/`.excalidraw`, and **Print / PDF of all pages**.
- **Fast**: a single small Node.js process keeps open papers in memory and sends only what changed; the app is served compressed and cached.

Everything — accounts, papers, images — stays on your own server.

---

## Install on your VM (Docker)

You need a Linux VM with [Docker](https://docs.docker.com/engine/install/) (including the Compose plugin), and ports **80** and **443** open.

```bash
git clone <your fork's URL> extracalidraw
cd extracalidraw/deploy
cp .env.example .env
nano .env        # set DOMAIN and ADMIN_PASSWORD
docker compose up -d --build
```

Open `https://<DOMAIN>` and sign in as `admin` with your `ADMIN_PASSWORD`.

The first build takes a few minutes (it compiles the app); restarts are instant.

### Domain or IP address?

The app needs HTTPS: browsers only allow clipboard access, image hashing and embedding into other HTTPS sites from secure pages. Caddy (included) handles certificates for you:

| `DOMAIN` in `.env` | Result |
| --- | --- |
| `board.example.com` | Free, trusted Let's Encrypt certificate. Point the domain's DNS (A record) to the VM first. |
| `192.168.1.50` (the VM's IP) | Certificate from Caddy's own authority: works, but browsers show a warning until you trust it. Fine for a private network/LAN. |

> No domain? Free options include [DuckDNS](https://www.duckdns.org) or `<ip-with-dashes>.sslip.io` style names (e.g. `203-0-113-7.sslip.io`).

### Already running nginx (or another proxy)?

Skip Caddy: remove the `caddy` service from `deploy/docker-compose.yml`, publish the app port (`ports: ["127.0.0.1:3002:3002"]`) and proxy to it. WebSockets and the original `Host` header must be passed through:

```nginx
location / {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1h;
    client_max_body_size 25m;
}
```

---

## Using it

1. **Add people** — _People_ → _Add person_, or _Add many…_ to paste a list of names (one per line) and get usernames and passwords for everyone (copy or download as CSV). Admins can reset passwords, disable or delete accounts any time.
2. **Create a paper** — _Papers_ → _New paper_, pick who it's shared with. `⋯` on a paper lets you rename it, change who it's shared with, set up the public link/embed, duplicate it (great for reusable worksheets/templates) or delete it.
3. **Pages** — the page bar at the bottom (`‹ Page 2 / 5 › +`) and the _Pages_ panel (top right; pin it to keep it open). _New page ▾_ offers blank, lined, grid and dotted paper, and **Import PDF or images…** (or drop a PDF onto the canvas). Imported backgrounds are locked; right-click → _Unlock_ to move them. Everyone who can draw may add, rename and reorder pages; only the owner and admins delete them.
4. **Run a session** — top right: _Present_ (everyone follows your view and page until you stop; anyone can step out with ✕ on the “… is presenting” badge), _Lock_ (view-only for everyone else), and in the _Pages_ panel _Bring everyone here_. Click someone's avatar to follow them.
5. **Math** — _∑ Math_ (top right), <kbd>Alt</kbd>+<kbd>M</kbd> or menu → _Insert math (LaTeX)_. Type LaTeX (e.g. `\frac{a}{b}`, `x^2`, `\sqrt{x}`) or use the buttons, pick a color and size, then _Insert_ (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>). Double-click a formula (or select it and press <kbd>Enter</kbd>) to change it. Chemistry works too: `\ce{H2O}`.
6. **Color part of a text** — double-click a text to edit it, select the words, then click a color in the panel on the left. Picking the text's own color removes the coloring. New text you type continues the color of the character before it.
7. **Print / PDF** — menu (☰) → _Print / PDF (all pages)_; choose “Save as PDF” in the print dialog.

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
| `DOMAIN` | – | Domain or IP address Caddy serves (Docker setup only). |
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

All data lives in the `whiteboard-data` Docker volume (or `DATA_DIR`): a small `db.json` (accounts, papers) plus one folder per paper (pages as JSON, images).

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

Update to a newer version of your fork:

```bash
git pull
cd deploy && docker compose up -d --build
```

---

## Without Docker

Requires Node.js 20+ and Yarn 1.

```bash
yarn install
yarn whiteboard:build
DATA_DIR=/var/lib/whiteboard ADMIN_PASSWORD=change-me yarn whiteboard:start
```

The server listens on port 3002 and serves the app itself; put it behind a reverse proxy for HTTPS (see the nginx example above). `whiteboard-server/dist/server.mjs` has no dependencies — together with `whiteboard-app/build` it's all you need to copy to a server (`STATIC_DIR=<path to build> node server.mjs`).

### Development

```bash
yarn whiteboard:dev:server   # API + live server on :3002 (data in whiteboard-server/data)
yarn whiteboard:dev:app      # app with hot reload on http://localhost:3003
```

---

## How it works

```
browser ──HTTPS──▶ Caddy ──▶ whiteboard-server (Node.js, one process)
                              ├─ REST API: login, people, papers, images
                              ├─ Socket.IO: live pages, cursors, presence
                              └─ serves whiteboard-app (the built React app)
```

- `whiteboard-app/` — the React app: login, dashboard, people, and the editor (the Excalidraw package from `packages/`) with the pages UI.
- `whiteboard-server/` — the server. Open papers are kept in memory; every change is merged with Excalidraw's rules (higher element version wins, ties broken deterministically), forwarded only to the others in the paper, and written to disk shortly after. Cursors go only to people on the same page. If a connection drops, edits are kept and sent when it's back.
- Passwords are hashed with scrypt, logins are rate-limited, sessions are `HttpOnly` cookies, and the API rejects cross-site requests.

## Troubleshooting

- **“Reconnecting…” never goes away** — your proxy doesn't pass WebSockets (see the nginx example), or a firewall blocks them.
- **Logged in, but papers won't open (“live connection was refused”)** — the proxy drops cookies or changes the `Host` header on WebSocket requests.
- **Browser warns about the certificate** — expected when `DOMAIN` is an IP address; use a domain name for a trusted certificate.
- **An embed shows “refused to connect”** — the site isn't listed in `EMBED_ALLOWED_ORIGINS`, or the page isn't served over HTTPS.
- Logs: `docker compose logs -f whiteboard`.

---

Developer notes (architecture, protocol, tests): [`docs/whiteboard/`](./docs/whiteboard/README.md).
