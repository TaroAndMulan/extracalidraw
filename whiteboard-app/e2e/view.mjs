#!/usr/bin/env node
/**
 * Browser test of sharing the view (View menu: on their own, same page,
 * together, follow me; looking around on your own; where others look).
 *
 *   node whiteboard-app/e2e/view.mjs http://localhost:3002 admin admin-pass
 *
 * Two people with screens of different shapes — the admin on a laptop, a
 * member on a tablet in portrait — move the view with the mouse wheel (pan)
 * and Ctrl+wheel (zoom), like people do. Needs Playwright's Chromium, or
 * CHROMIUM_PATH. Exits with 1 if any check fails.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const [BASE = "http://localhost:3002", ADMIN = "admin", ADMIN_PASSWORD] =
  process.argv.slice(2);
if (!ADMIN_PASSWORD) {
  console.error("usage: view.mjs <url> <admin-username> <admin-password>");
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

/** what a person sees: page, center of the screen and zoom, view mode */
const view = (page) =>
  page.evaluate(() => {
    const { session, excalidrawAPI } = window.__whiteboard;
    const s = session.getState();
    const a = excalidrawAPI.getAppState();
    return {
      page: s.pages.findIndex((p) => p.id === s.currentPageId),
      mode: s.paper.viewSync,
      detached: s.viewDetached,
      onShared: session.isOnSharedView(),
      cx: a.width / 2 / a.zoom.value - a.scrollX,
      cy: a.height / 2 / a.zoom.value - a.scrollY,
      zoom: a.zoom.value,
      width: a.width,
    };
  });

const until = async (page, predicate, timeout = 6000) => {
  const start = Date.now();
  for (;;) {
    const current = await view(page);
    if (predicate(current) || Date.now() - start > timeout) {
      return current;
    }
    await sleep(100);
  }
};

/** the same spot of the page in the middle of both screens */
const sameCenter = (a, b, tolerance = 2) =>
  Math.abs(a.cx - b.cx) < tolerance && Math.abs(a.cy - b.cy) < tolerance;

/** waits until both screens are centered on the same spot */
const untilTogether = async (first, second, timeout = 6000) => {
  const start = Date.now();
  for (;;) {
    const [a, b] = [await view(first), await view(second)];
    if (
      (sameCenter(a, b) && a.page === b.page) ||
      Date.now() - start > timeout
    ) {
      return [a, b];
    }
    await sleep(100);
  }
};

const pan = async (page, dx, dy, steps = 6) => {
  const { width } = await view(page);
  await page.mouse.move(width / 2, 400);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(dx / steps, dy / steps);
    await sleep(30);
  }
};

const zoomIn = async (page, ticks = 3) => {
  const { width } = await view(page);
  await page.mouse.move(width / 2, 400);
  await page.keyboard.down("Control");
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, -100);
    await sleep(60);
  }
  await page.keyboard.up("Control");
};

const openViewMenu = async (page) => {
  await page.click(".wb-topright .wb-viewmenu > button");
  await page.waitForSelector(".wb-viewmenu__menu");
};

const chooseMode = async (page, label) => {
  await openViewMenu(page);
  await page.click(`.wb-viewmenu__option:has-text("${label}")`);
};

const run = async () => {
  const stamp = Date.now().toString(36);
  const adminCookie = await login(ADMIN, ADMIN_PASSWORD);
  const memberName = `view-${stamp}`;
  const { user: member } = await api(adminCookie, "POST", "/api/users", {
    username: memberName,
    displayName: "View Member",
    password: "view-pass-1",
  });
  const { paper } = await api(adminCookie, "POST", "/api/papers", {
    title: `View test ${stamp}`,
    memberIds: [member.id],
  });

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  );
  const errors = [];
  const open = async (name, cookie, size, hasTouch = false) => {
    const context = await browser.newContext({ viewport: size, hasTouch });
    await context.addInitScript(() => {
      try {
        localStorage.setItem("whiteboard-debug", "1");
      } catch {}
    });
    const [key, value] = cookie.split("=");
    await context.addCookies([{ name: key, value, url: BASE }]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    await page.goto(`${BASE}/p/${paper.id}`);
    await page.waitForFunction(() => window.__whiteboard?.excalidrawAPI, null, {
      timeout: 20000,
    });
    return page;
  };

  try {
    const admin = await open("admin", adminCookie, {
      width: 1280,
      height: 800,
    });
    const memberCookie = await login(memberName, "view-pass-1");
    const maya = await open(
      "member",
      memberCookie,
      { width: 820, height: 1180 },
      true,
    );
    // fingers on the tablet's screen
    const cdp = await maya.context().newCDPSession(maya);
    const touch = (type, points) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 8 })),
      });
    /** fingers from `from` to `to` (one point per finger) */
    const fingers = async (from, to, steps = 8) => {
      await touch("touchStart", from);
      for (let i = 1; i <= steps; i++) {
        await touch(
          "touchMove",
          from.map(([x, y], f) => [
            x + ((to[f][0] - x) * i) / steps,
            y + ((to[f][1] - y) * i) / steps,
          ]),
        );
        await sleep(16);
      }
      await touch("touchEnd", []);
    };
    await sleep(800);
    // a second page
    await admin.evaluate(() => window.__whiteboard.session.addPage());
    await admin.keyboard.press("Alt+PageUp");
    await maya.evaluate(() => {
      const { session } = window.__whiteboard;
      session.switchPage(session.getState().pages[0].id);
    });
    await sleep(300);

    // ---- on their own (default)
    let [a, m] = [await view(admin), await view(maya)];
    check("starts with everyone on their own", a.mode === "free", a.mode);
    const mayaBefore = m;
    await pan(admin, 300, 200);
    await sleep(600);
    m = await view(maya);
    check(
      "on their own: the admin's moves don't move the member",
      sameCenter(m, mayaBefore),
      JSON.stringify({ m, mayaBefore }),
    );

    // ---- together
    await chooseMode(admin, "Together");
    m = await until(maya, (s) => s.mode === "view");
    check("together: the member is told", m.mode === "view", m.mode);
    [a, m] = await untilTogether(admin, maya);
    check(
      "together: the member goes to the admin's view",
      sameCenter(a, m),
      JSON.stringify({ a, m }),
    );
    const zoomRatio = m.zoom / a.zoom;

    await pan(admin, -400, 250);
    [a, m] = await untilTogether(admin, maya);
    check(
      "together: the admin pans, the member follows",
      sameCenter(a, m),
      JSON.stringify({ a, m }),
    );

    await pan(maya, 350, -300);
    [a, m] = await untilTogether(admin, maya);
    check(
      "together: the member pans, the admin follows",
      sameCenter(a, m),
      JSON.stringify({ a, m }),
    );

    const zoomBefore = a.zoom;
    await zoomIn(maya);
    a = await until(admin, (s) => s.zoom > zoomBefore * 1.1);
    [a, m] = await untilTogether(admin, maya);
    check(
      "together: the member zooms in, so does the admin",
      a.zoom > zoomBefore * 1.1 && sameCenter(a, m),
      JSON.stringify({ zoomBefore, a, m }),
    );

    // fingers on the tablet move everyone too: with a pen (pen mode, see
    // tabletInput.ts) one finger pans, two pinch…
    await maya.evaluate(() =>
      window.__whiteboard.excalidrawAPI.updateScene({
        appState: { penMode: true, penDetected: true },
      }),
    );
    let before = await view(admin);
    await fingers([[400, 600]], [[550, 500]]);
    [a, m] = await untilTogether(admin, maya);
    check(
      "together: a finger pans the tablet (pen mode), everyone follows",
      sameCenter(a, m) && !sameCenter(a, before),
      JSON.stringify({ before, a, m }),
    );
    before = a;
    await fingers(
      [
        [350, 600],
        [470, 600],
      ],
      [
        [250, 600],
        [570, 600],
      ],
    );
    a = await until(admin, (s) => s.zoom > before.zoom * 1.4);
    [a, m] = await untilTogether(admin, maya);
    check(
      "together: pinching the tablet (pen mode) zooms everyone",
      a.zoom > before.zoom * 1.4 && sameCenter(a, m),
      JSON.stringify({ before, a, m }),
    );
    // …and without a pen, the editor's own two-finger pinch
    await maya.evaluate(() =>
      window.__whiteboard.excalidrawAPI.updateScene({
        appState: { penMode: false },
      }),
    );
    before = a;
    await fingers(
      [
        [300, 700],
        [500, 700],
      ],
      [
        [350, 700],
        [450, 700],
      ],
    );
    a = await until(admin, (s) => s.zoom < before.zoom * 0.8);
    [a, m] = await untilTogether(admin, maya);
    check(
      "together: pinching the tablet (no pen) zooms everyone",
      a.zoom < before.zoom * 0.8 && sameCenter(a, m),
      JSON.stringify({ before, a, m }),
    );

    // screens of different shapes taking turns: nobody keeps zooming out
    const startZoom = a.zoom;
    for (let i = 0; i < 4; i++) {
      await pan(i % 2 ? admin : maya, 120, 80, 3);
      await untilTogether(admin, maya);
      await sleep(300);
    }
    [a, m] = await untilTogether(admin, maya);
    check(
      "together: taking turns doesn't drift the zoom",
      Math.abs(a.zoom / startZoom - 1) < 0.01 &&
        Math.abs(m.zoom / a.zoom - zoomRatio) < 0.01,
      JSON.stringify({ startZoom, a, m, zoomRatio }),
    );

    // both at once: they end up in the same place
    await Promise.all([pan(admin, 500, 0, 8), pan(maya, 0, 500, 8)]);
    await sleep(1000);
    [a, m] = await untilTogether(admin, maya);
    check(
      "together: moving at the same time ends in the same place",
      sameCenter(a, m),
      JSON.stringify({ a, m }),
    );

    // the page doesn't slide away under someone's pen: a move made while
    // they draw waits until the stroke is done
    await admin.keyboard.press("p");
    const drawing = await view(admin);
    await admin.mouse.move(500, 400);
    await admin.mouse.down();
    await admin.mouse.move(540, 420, { steps: 4 });
    await pan(maya, 0, 400);
    await sleep(700);
    await admin.mouse.move(580, 440, { steps: 4 });
    a = await view(admin);
    const stillWhileDrawing = sameCenter(a, drawing);
    await admin.mouse.up();
    await admin.keyboard.press("Escape");
    await admin.keyboard.press("v");
    [a, m] = await untilTogether(admin, maya);
    check(
      "together: someone else's move waits until my stroke is done",
      stillWhileDrawing && sameCenter(a, m) && !sameCenter(a, drawing),
      JSON.stringify({ stillWhileDrawing, drawing, a, m }),
    );

    await maya.keyboard.press("Alt+PageDown");
    a = await until(admin, (s) => s.page === 1);
    check("together: the member turns the page, the admin too", a.page === 1);
    await maya.keyboard.press("Alt+PageUp");
    a = await until(admin, (s) => s.page === 0);

    // looking around on your own
    await openViewMenu(maya);
    await maya.click('.wb-viewmenu__action:has-text("Look around")');
    const adminStill = await view(admin);
    await pan(maya, -600, 0);
    await sleep(700);
    a = await view(admin);
    m = await view(maya);
    check(
      "looking around on my own doesn't move the others",
      m.detached && sameCenter(a, adminStill) && !sameCenter(a, m),
      JSON.stringify({ a, adminStill, m }),
    );
    // where others are looking: on for the admin (who runs the lesson), off
    // for the member. (While both see the same, there's nothing to show.)
    const tags = {
      admin: await admin.locator(".wb-viewbox__tag:visible").count(),
      maya: await maya.locator(".wb-viewbox__tag:visible").count(),
    };
    check(
      "where others look: the admin sees where the member is, the member (off by default) doesn't",
      tags.admin === 1 && tags.maya === 0,
      JSON.stringify(tags),
    );
    await pan(admin, 0, 200);
    await sleep(600);
    m = await view(maya);
    check(
      "…nor do they move me",
      !sameCenter(m, await view(admin)),
      JSON.stringify(m),
    );
    await maya.click(".viewport-status-frame__badge-action");
    [a, m] = await untilTogether(admin, maya);
    check(
      '"Back to the shared view" brings me back',
      sameCenter(a, m) && !m.detached,
      JSON.stringify({ a, m }),
    );

    // coming back later: start where everyone is
    await pan(admin, 200, 100);
    await untilTogether(admin, maya);
    await maya.reload();
    await maya.waitForFunction(() => window.__whiteboard?.excalidrawAPI);
    [a, m] = await untilTogether(admin, maya);
    check(
      "together: (re)opening the paper starts on the shared view",
      sameCenter(a, m),
      JSON.stringify({ a, m }),
    );

    // people who can't draw follow the shared view, and look around on
    // their own when they move it
    await admin.evaluate(() => window.__whiteboard.session.setLocked(true));
    await maya.waitForFunction(
      () => !window.__whiteboard.session.getState().canEdit,
    );
    const adminLocked = await view(admin);
    await pan(maya, 300, 0);
    await sleep(700);
    [a, m] = [await view(admin), await view(maya)];
    check(
      "view only: moving the view means looking around on my own",
      m.detached && sameCenter(a, adminLocked),
      JSON.stringify({ a, adminLocked, m }),
    );
    await pan(admin, 0, -250);
    await maya.click(".viewport-status-frame__badge-action");
    [a, m] = await untilTogether(admin, maya);
    check(
      "view only: …and come back to the shared view",
      sameCenter(a, m) && !m.detached,
      JSON.stringify({ a, m }),
    );
    await admin.evaluate(() => window.__whiteboard.session.setLocked(false));
    await maya.waitForFunction(
      () => window.__whiteboard.session.getState().canEdit,
    );

    // ---- same page
    await chooseMode(admin, "Same page");
    m = await until(maya, (s) => s.mode === "page");
    const mayaHere = m;
    await pan(admin, 300, 300);
    await sleep(700);
    m = await view(maya);
    check(
      "same page: panning is everyone's own",
      sameCenter(m, mayaHere),
      JSON.stringify({ m, mayaHere }),
    );
    await admin.keyboard.press("Alt+PageDown");
    m = await until(maya, (s) => s.page === 1);
    check("same page: page turns are shared", m.page === 1, m.page);
    await maya.keyboard.press("Alt+PageUp");
    a = await until(admin, (s) => s.page === 0);
    check("same page: …by anyone who can draw", a.page === 0, a.page);

    // ---- follow me (presenting) and back
    await chooseMode(admin, "Follow me");
    await maya
      .waitForFunction(
        () => !!window.__whiteboard.session.getState().userToFollow,
        null,
        { timeout: 6000 },
      )
      .catch(() => {});
    const following = await maya.evaluate(
      () => window.__whiteboard.session.getState().userToFollow?.username,
    );
    check("follow me: the member follows the admin", !!following, following);
    await pan(admin, 250, -150);
    [a, m] = await untilTogether(admin, maya);
    check(
      "follow me: the member follows the admin's moves",
      sameCenter(a, m),
      JSON.stringify({ a, m }),
    );
    await chooseMode(admin, "Together");
    m = await until(maya, (s) => s.mode === "view" && s.onShared);
    [a, m] = await untilTogether(admin, maya);
    check(
      "stopping to present for together: everyone carries on from there",
      m.onShared && sameCenter(a, m),
      JSON.stringify({ a, m }),
    );

    // ---- on their own again
    await chooseMode(admin, "On their own");
    m = await until(maya, (s) => s.mode === "free");
    const mayaFree = m;
    await pan(admin, -300, 0);
    await sleep(600);
    m = await view(maya);
    check(
      "on their own again: independent",
      m.mode === "free" && sameCenter(m, mayaFree),
      JSON.stringify(m),
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
