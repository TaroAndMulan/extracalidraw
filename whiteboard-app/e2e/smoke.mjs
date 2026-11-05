#!/usr/bin/env node
/**
 * End-to-end smoke test of a running whiteboard, with real browsers.
 *
 *   yarn whiteboard:build
 *   DATA_DIR=/tmp/wb ADMIN_PASSWORD=admin-pass yarn whiteboard:start
 *   node whiteboard-app/e2e/smoke.mjs http://localhost:3002 admin admin-pass
 *
 * Creates a member and a paper, then checks live sync, pages, templates, PDF
 * import, presenter mode, lock, guests (embed link) and offline edits.
 * Needs Playwright's Chromium (`npx playwright install chromium`), or point
 * CHROMIUM_PATH at an installed Chrome/Chromium. Exits with 1 if any check
 * fails.
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const [BASE = "http://localhost:3002", ADMIN = "admin", ADMIN_PASSWORD] =
  process.argv.slice(2);
if (!ADMIN_PASSWORD) {
  console.error("usage: smoke.mjs <url> <admin-username> <admin-password>");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, details = "") => {
  failures += ok ? 0 : 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${details}`}`);
};

const api = async (cookie, method, url, body) => {
  const response = await fetch(BASE + url, {
    method,
    headers: { cookie, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  return response.json();
};

const login = async (username, password) => {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new Error(`login failed for ${username}: ${response.status}`);
  }
  return response.headers.get("set-cookie").split(";")[0];
};

/** state of the editor in a page (needs the debug flag, see newPage) */
const state = (page) =>
  page.evaluate(() => {
    const { session, excalidrawAPI } = window.__whiteboard;
    const s = session.getState();
    return {
      page: s.pages.findIndex((p) => p.id === s.currentPageId),
      pages: s.pages.length,
      types: excalidrawAPI.getSceneElements().map((e) => e.type),
      images: excalidrawAPI
        .getSceneElements()
        .filter((e) => e.type === "image")
        .map((e) => e.status),
      status: s.status,
      canEdit: s.canEdit,
      following: s.userToFollow?.username ?? null,
    };
  });

const until = async (page, predicate, timeout = 8000) => {
  const start = Date.now();
  for (;;) {
    const current = await state(page);
    if (predicate(current)) {
      return current;
    }
    if (Date.now() - start > timeout) {
      return current;
    }
    await sleep(150);
  }
};

const draw = async (page, tool, x, y) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press(tool);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 80, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
};

const run = async () => {
  const stamp = Date.now().toString(36);
  const adminCookie = await login(ADMIN, ADMIN_PASSWORD);
  const memberName = `smoke-${stamp}`;
  const { user: member } = await api(adminCookie, "POST", "/api/users", {
    username: memberName,
    displayName: "Smoke Member",
    password: "smoke-pass-1",
  });
  const { paper } = await api(adminCookie, "POST", "/api/papers", {
    title: `Smoke test ${stamp}`,
    memberIds: [member.id],
  });
  const {
    paper: { shareToken },
  } = await api(adminCookie, "POST", `/api/papers/${paper.id}/share`, {
    enabled: true,
    access: "edit",
  });

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  );
  const errors = [];
  const newPage = async (name, cookie, url) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(() => {
      try {
        localStorage.setItem("whiteboard-debug", "1");
      } catch {}
    });
    if (cookie) {
      const [key, value] = cookie.split("=");
      await context.addCookies([{ name: key, value, url: BASE }]);
    }
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    await page.goto(url);
    return page;
  };
  const waitForEditor = (page) =>
    page.waitForFunction(() => window.__whiteboard?.excalidrawAPI, null, {
      timeout: 20000,
    });

  try {
    const admin = await newPage("admin", adminCookie, `${BASE}/p/${paper.id}`);
    const memberCookie = await login(memberName, "smoke-pass-1");
    const maya = await newPage("member", memberCookie, `${BASE}/p/${paper.id}`);
    await waitForEditor(admin);
    await waitForEditor(maya);
    await sleep(500);

    // live sync
    await draw(admin, "r", 500, 300);
    let m = await until(maya, (s) => s.types.includes("rectangle"));
    check("member sees the admin's drawing", m.types.includes("rectangle"));
    await draw(maya, "o", 700, 350);
    let a = await until(admin, (s) => s.types.includes("ellipse"));
    check("admin sees the member's drawing", a.types.includes("ellipse"));

    // pages are separate
    await admin.keyboard.press("Alt+n");
    await sleep(300);
    await draw(admin, "d", 500, 300);
    m = await until(maya, (s) => s.pages === 2);
    check(
      "new page shows up, member stays on their page",
      m.pages === 2 && m.page === 0 && !m.types.includes("diamond"),
      JSON.stringify(m),
    );

    // templates
    await admin.click(".wb-pagenav__label");
    await admin.click(".wb-newpage .wb-pages__action");
    await admin.click(".wb-newpage__menu >> text=Lined paper");
    a = await until(admin, (s) => s.images[0] === "saved");
    check("lined paper page with an uploaded background", a.images[0] === "saved");

    // PDF import
    const maker = await browser.newPage();
    await maker.setContent(
      [1, 2]
        .map(
          (n) =>
            `<section style="page-break-after:always;font:30px sans-serif">Worksheet ${n}</section>`,
        )
        .join(""),
    );
    const pdfPath = path.join(os.tmpdir(), `smoke-${stamp}.pdf`);
    await maker.pdf({ path: pdfPath, format: "A4" });
    await maker.close();
    const pagesBefore = (await state(admin)).pages;
    await admin.click(".wb-newpage .wb-pages__action");
    const [chooser] = await Promise.all([
      admin.waitForEvent("filechooser"),
      admin.click(".wb-newpage__menu >> text=Import PDF or images…"),
    ]);
    await chooser.setFiles(pdfPath);
    a = await until(
      admin,
      (s) => s.pages === pagesBefore + 2 && s.images[0] === "saved",
      30000,
    );
    check(
      "PDF imported as pages",
      a.pages === pagesBefore + 2 && a.images[0] === "saved",
      JSON.stringify(a),
    );
    await admin.click(".wb-pages-sidebar .sidebar__close");

    // presenter mode
    await admin.click("button.wb-pill--button:has-text('Present')");
    m = await until(maya, (s) => s.following !== null && s.page === a.page);
    check("presenter mode: member follows", m.following !== null && m.page === a.page, JSON.stringify(m));
    await admin.keyboard.press("Alt+PageUp");
    const adminPage = (await state(admin)).page;
    m = await until(maya, (s) => s.page === adminPage);
    check("presenter mode: member follows page changes", m.page === adminPage, JSON.stringify(m));
    await admin.click("button.wb-pill--button:has-text('Presenting')");

    // lock
    await admin.click("button.wb-pill--button:has-text('Lock')");
    m = await until(maya, (s) => !s.canEdit);
    check("lock makes the paper view-only", !m.canEdit);
    await admin.click("button.wb-pill--button:has-text('Locked')");
    m = await until(maya, (s) => s.canEdit);
    check("unlock lets the member draw again", m.canEdit);

    // guest through the embed link
    const guest = await newPage(
      "guest",
      null,
      `${BASE}/embed/${paper.id}?name=Guest%20Smoke#token=${shareToken}`,
    );
    await waitForEditor(guest);
    await sleep(500);
    const guestPage = (await state(guest)).page;
    await admin.evaluate((index) => {
      const { session } = window.__whiteboard;
      session.switchPage(session.getState().pages[index].id);
    }, guestPage);
    await draw(guest, "r", 300, 500);
    a = await until(admin, (s) => s.types.filter((t) => t === "rectangle").length >= 2);
    check(
      "guest joins through the embed link and draws",
      a.types.filter((t) => t === "rectangle").length >= 2,
      JSON.stringify(a),
    );

    // offline edits are sent after reconnecting
    await maya.evaluate((index) => {
      const { session } = window.__whiteboard;
      session.switchPage(session.getState().pages[index].id);
    }, guestPage);
    await maya.evaluate(() => window.__whiteboard.session.socket.disconnect());
    await draw(maya, "d", 600, 520);
    await maya.evaluate(() => window.__whiteboard.session.socket.connect());
    a = await until(admin, (s) => s.types.includes("diamond"));
    check("offline drawing arrives after reconnecting", a.types.includes("diamond"));
  } finally {
    await browser.close();
  }
  check("no page errors", errors.length === 0, JSON.stringify(errors));
};

run()
  .catch((error) => {
    console.error(error);
    failures++;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
  });
