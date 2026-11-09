#!/usr/bin/env node
/**
 * End-to-end smoke test of a running whiteboard, with real browsers.
 *
 *   yarn whiteboard:build
 *   DATA_DIR=/tmp/wb ADMIN_PASSWORD=admin-pass yarn whiteboard:start
 *   node whiteboard-app/e2e/smoke.mjs http://localhost:3002 admin admin-pass
 *
 * Creates a member and a paper, then checks live sync, partial text colors,
 * LaTeX math, pages, templates, PDF import, presenter mode, lock, guests
 * (embed link) and offline edits.
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

/** dark ("ink") pixels on screen in a region (light theme) */
const inkPixels = async (page, clip) => {
  const shot = await page.screenshot({ clip });
  return page.evaluate(async (src) => {
    const image = new Image();
    await new Promise((resolve) => {
      image.onload = resolve;
      image.src = src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) {
        ink++;
      }
    }
    return ink;
  }, `data:image/png;base64,${shot.toString("base64")}`);
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

    // a stroke being drawn: on the others' live overlay while it grows (not
    // redrawing their whole page for each point), in the page once finished
    const liveState = () =>
      maya.evaluate(() => {
        const { session, excalidrawAPI } = window.__whiteboard;
        const live = session.liveStrokes.all();
        return {
          live: live.length,
          livePoints: live[0]?.points.length ?? 0,
          inPage: excalidrawAPI
            .getSceneElements()
            .filter((e) => e.type === "freedraw").length,
        };
      });
    await admin.keyboard.press("Escape");
    await admin.keyboard.press("p");
    await admin.mouse.move(400, 600);
    await admin.mouse.down();
    for (let i = 1; i <= 15; i++) {
      await admin.mouse.move(400 + i * 12, 600 + (i % 3) * 8);
      await sleep(16);
    }
    await sleep(300);
    const whileDrawing = await liveState();
    // and it's actually on the screen (not hidden under the page)
    whileDrawing.ink = await inkPixels(maya, {
      x: 410,
      y: 590,
      width: 170,
      height: 40,
    });
    await admin.mouse.up();
    await admin.keyboard.press("Escape");
    await sleep(800);
    const afterDrawing = await liveState();
    check(
      "a stroke being drawn shows live, then lands in the page",
      whileDrawing.live === 1 &&
        whileDrawing.livePoints >= 10 &&
        whileDrawing.ink > 100 &&
        whileDrawing.inPage === 0 &&
        afterDrawing.live === 0 &&
        afterDrawing.inPage === 1,
      JSON.stringify({ whileDrawing, afterDrawing }),
    );

    // partial text colors: color one word while editing, in the style panel
    // (tucked away at first: its button brings it out, still editing)
    await admin.keyboard.press("t");
    await admin.mouse.click(450, 520);
    await admin.keyboard.type("Solve for x");
    await admin.evaluate(() =>
      document
        .querySelector("textarea.excalidraw-wysiwyg")
        .setSelectionRange(10, 11),
    );
    const panelBefore = await admin.evaluate(
      () => !!document.querySelector(".App-menu__left")?.offsetParent,
    );
    await admin.click(".wb-style-toggle");
    const panelAfter = await admin.evaluate(() => ({
      shown: !!document.querySelector(".App-menu__left")?.offsetParent,
      editing:
        !!window.__whiteboard.excalidrawAPI.getAppState().editingTextElement,
    }));
    check(
      "the style panel starts tucked away; its button brings it out",
      !panelBefore && panelAfter.shown && panelAfter.editing,
      JSON.stringify({ panelBefore, ...panelAfter }),
    );
    await admin.click('[data-testid="color-top-pick-#e03131"]');
    await admin.keyboard.press("Escape");
    const colored = await maya
      .waitForFunction(
        () =>
          window.__whiteboard.excalidrawAPI
            .getSceneElements()
            .find((e) => e.type === "text" && e.colorRanges?.length)
            ?.colorRanges,
        null,
        { timeout: 8000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    check(
      "a word colored separately reaches the member",
      colored?.[0]?.start === 10 && colored?.[0]?.end === 11,
      JSON.stringify(colored),
    );

    // LaTeX math
    await admin.keyboard.press("Alt+m");
    await admin.click(".wb-math__example");
    await admin.waitForSelector(".wb-math__preview img", { timeout: 15000 });
    await admin.click("button:has-text('Insert')");
    const math = await maya
      .waitForFunction(
        () => {
          const { excalidrawAPI } = window.__whiteboard;
          const element = excalidrawAPI
            .getSceneElements()
            .find((e) => e.customData?.whiteboardMath);
          return element?.status === "saved" &&
            excalidrawAPI.getFiles()[element.fileId]
            ? element.customData.whiteboardMath.latex
            : null;
        },
        null,
        { timeout: 10000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    check("a LaTeX formula reaches the member", !!math, String(math));
    await admin.keyboard.press("Escape");

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
    check(
      "lined paper page with an uploaded background",
      a.images[0] === "saved",
    );

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

    // presenter mode ("Follow me" in the View menu)
    const followMe = async () => {
      await admin.click(".wb-topright .wb-viewmenu > button");
      await admin.click(".wb-viewmenu__option:has-text('Follow me')");
    };
    await followMe();
    m = await until(maya, (s) => s.following !== null && s.page === a.page);
    check(
      "presenter mode: member follows",
      m.following !== null && m.page === a.page,
      JSON.stringify(m),
    );
    await admin.keyboard.press("Alt+PageUp");
    const adminPage = (await state(admin)).page;
    m = await until(maya, (s) => s.page === adminPage);
    check(
      "presenter mode: member follows page changes",
      m.page === adminPage,
      JSON.stringify(m),
    );
    await followMe();
    m = await until(maya, (s) => s.following === null);
    check("presenter mode ends", m.following === null, JSON.stringify(m));

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
    a = await until(
      admin,
      (s) => s.types.filter((t) => t === "rectangle").length >= 2,
    );
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
    check(
      "offline drawing arrives after reconnecting",
      a.types.includes("diamond"),
    );
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
    console.log(
      failures ? `\n${failures} check(s) failed` : "\nall checks passed",
    );
    process.exit(failures ? 1 : 0);
  });
