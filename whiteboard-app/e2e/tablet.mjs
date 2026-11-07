#!/usr/bin/env node
/**
 * Pen, fingers and palms on a tablet-sized touch screen, in a real browser.
 *
 *   node whiteboard-app/e2e/tablet.mjs http://localhost:3002 admin admin-pass
 *
 * Chromium gets pen input (like an Apple Pencil or S Pen) and finger touches
 * through the DevTools protocol, so the whole path is exercised: the browser's
 * pointer and touch events, `tabletInput.ts` and Excalidraw. Checks that the
 * pen turns on pen mode and draws, that a palm resting on the screen doesn't
 * end the stroke or move the page, that fingers pan and pinch-zoom without
 * drawing or selecting, that fingers still draw with pen mode off, and that
 * pen mode is remembered after a reload.
 * Needs Playwright's Chromium (`npx playwright install chromium`), or point
 * CHROMIUM_PATH at an installed Chrome/Chromium. Exits with 1 if any check
 * fails.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const [BASE = "http://localhost:3002", ADMIN = "admin", ADMIN_PASSWORD] =
  process.argv.slice(2);
if (!ADMIN_PASSWORD) {
  console.error("usage: tablet.mjs <url> <admin-username> <admin-password>");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, details = "") => {
  failures += ok ? 0 : 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${details}`}`);
};
const near = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance;

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

/** what the editor holds (needs the debug flag) */
const editor = (page) =>
  page.evaluate(() => {
    const { excalidrawAPI } = window.__whiteboard;
    const appState = excalidrawAPI.getAppState();
    const elements = excalidrawAPI.getSceneElements();
    const strokes = elements.filter((e) => e.type === "freedraw");
    const last = strokes[strokes.length - 1];
    return {
      count: elements.length,
      strokes: strokes.length,
      lastStroke: last && {
        points: last.points.length,
        end: [
          last.x + last.points[last.points.length - 1][0],
          last.y + last.points[last.points.length - 1][1],
        ],
      },
      texts: elements.filter((e) => e.type === "text").length,
      penMode: appState.penMode,
      penDetected: appState.penDetected,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom.value,
      selected: Object.keys(appState.selectedElementIds).length,
      editingText: !!appState.editingTextElement,
      tool: appState.activeTool.type,
    };
  });

/** pen and fingers, as the browser gets them from a tablet */
const inputs = (cdp) => {
  const pen = (type, x, y, buttons) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
      pointerType: "pen",
      force: buttons ? 0.6 : 0,
    });
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 8 })),
    });
  return {
    penDown: (x, y) => pen("mousePressed", x, y, 1),
    penMove: (x, y) => pen("mouseMoved", x, y, 1),
    penUp: (x, y) => pen("mouseReleased", x, y, 0),
    penHover: (x, y) => pen("mouseMoved", x, y, 0),
    touchStart: (...points) => touch("touchStart", points),
    touchMove: (...points) => touch("touchMove", points),
    touchEnd: () => touch("touchEnd", []),
    /** one finger (or several, moving together) from `from` by dx, dy */
    async swipe(from, dx, dy, steps = 8) {
      await touch("touchStart", from);
      for (let i = 1; i <= steps; i++) {
        await touch(
          "touchMove",
          from.map(([x, y]) => [x + (dx * i) / steps, y + (dy * i) / steps]),
        );
        await sleep(16);
      }
      await touch("touchEnd", []);
    },
    async stroke(x, y, dx, dy, steps = 10) {
      await pen("mousePressed", x, y, 1);
      for (let i = 1; i <= steps; i++) {
        await pen("mouseMoved", x + (dx * i) / steps, y + (dy * i) / steps, 1);
        await sleep(16);
      }
      await pen("mouseReleased", x + dx, y + dy, 0);
    },
  };
};

const run = async () => {
  const stamp = Date.now().toString(36);
  const cookie = await login(ADMIN, ADMIN_PASSWORD);
  const response = await fetch(`${BASE}/api/papers`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ title: `Tablet test ${stamp}`, memberIds: [] }),
  });
  const { paper } = await response.json();

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  );
  const errors = [];
  try {
    // an iPad Air in landscape
    const context = await browser.newContext({
      viewport: { width: 1180, height: 820 },
      hasTouch: true,
    });
    await context.addInitScript(() => {
      try {
        localStorage.setItem("whiteboard-debug", "1");
      } catch {}
      // records screen wake lock requests (headless has no screen to keep on)
      window.__wakeLocks = 0;
      Object.defineProperty(navigator, "wakeLock", {
        configurable: true,
        value: {
          request: async () => {
            window.__wakeLocks++;
            const lock = new EventTarget();
            lock.release = async () => {};
            return lock;
          },
        },
      });
    });
    const [key, value] = cookie.split("=");
    await context.addCookies([{ name: key, value, url: BASE }]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const open = async () => {
      await page.goto(`${BASE}/p/${paper.id}`);
      await page.waitForFunction(
        () => window.__whiteboard?.excalidrawAPI,
        null,
        {
          timeout: 20000,
        },
      );
      await sleep(500);
    };
    await open();
    const cdp = await context.newCDPSession(page);
    const input = inputs(cdp);
    const setTool = (type) =>
      page.evaluate(
        (type) => window.__whiteboard.excalidrawAPI.setActiveTool({ type }),
        type,
      );

    let state = await editor(page);
    check("a new device starts without pen mode", !state.penMode, state);

    // --- the pen ---------------------------------------------------------
    await setTool("freedraw");
    await input.stroke(400, 300, 120, 40);
    await sleep(200);
    state = await editor(page);
    check(
      "the pen draws and turns pen mode on",
      state.strokes === 1 && state.penMode && state.penDetected,
      JSON.stringify(state),
    );

    // --- a palm while writing ---------------------------------------------
    const before = await editor(page);
    await input.penDown(400, 450);
    for (let i = 1; i <= 5; i++) {
      await input.penMove(400 + i * 10, 450);
      await sleep(16);
    }
    // the hand lands and slides while the pen keeps going
    await input.touchStart([700, 650]);
    for (let i = 1; i <= 5; i++) {
      await input.touchMove([700 + i * 20, 650 + i * 10]);
      await input.penMove(450 + i * 10, 450 + i * 4);
      await sleep(16);
    }
    await input.touchEnd();
    for (let i = 1; i <= 5; i++) {
      await input.penMove(500 + i * 10, 470);
      await sleep(16);
    }
    await input.penUp(550, 470);
    await sleep(200);
    state = await editor(page);
    check(
      "a palm doesn't end the stroke being drawn",
      state.strokes === before.strokes + 1 &&
        state.lastStroke.points >= 15 &&
        near(state.lastStroke.end[0], 550, 1) &&
        near(state.lastStroke.end[1], 470, 1),
      JSON.stringify(state.lastStroke),
    );
    check(
      "a palm doesn't move or zoom the page",
      state.scrollX === before.scrollX &&
        state.scrollY === before.scrollY &&
        state.zoom === before.zoom,
      JSON.stringify(state),
    );

    // a palm landing right after a stroke
    await input.stroke(400, 600, 80, 0);
    await input.swipe([[700, 650]], 60, 30, 4);
    await sleep(200);
    state = await editor(page);
    check(
      "a palm landing right after a stroke is ignored",
      state.scrollX === before.scrollX && state.scrollY === before.scrollY,
      JSON.stringify(state),
    );
    const strokes = state.strokes;
    await sleep(700);

    // --- fingers ---------------------------------------------------------
    await input.swipe([[600, 400]], 100, 50);
    await sleep(200);
    state = await editor(page);
    check(
      "one finger pans (and doesn't draw)",
      near(state.scrollX - before.scrollX, 100 / state.zoom) &&
        near(state.scrollY - before.scrollY, 50 / state.zoom) &&
        state.strokes === strokes,
      JSON.stringify(state),
    );

    const zoomBefore = state.zoom;
    await input.touchStart([500, 400], [700, 400]);
    for (let i = 1; i <= 8; i++) {
      await input.touchMove([500 - i * 12.5, 400], [700 + i * 12.5, 400]);
      await sleep(16);
    }
    await input.touchEnd();
    await sleep(200);
    state = await editor(page);
    check(
      "two fingers pinch-zoom",
      near(state.zoom / zoomBefore, 2, 0.05) && state.strokes === strokes,
      JSON.stringify({ zoomBefore, ...state }),
    );

    // a finger on a stroke with the selection tool: no select, no text
    // back to the view the strokes were drawn in
    await page.evaluate(
      ({ scrollX, scrollY, zoom }) =>
        window.__whiteboard.excalidrawAPI.updateScene({
          appState: { scrollX, scrollY, zoom: { value: zoom } },
        }),
      before,
    );
    await setTool("selection");
    await sleep(300);
    const box = await page.evaluate(() => {
      const { excalidrawAPI } = window.__whiteboard;
      const appState = excalidrawAPI.getAppState();
      const el = excalidrawAPI
        .getSceneElements()
        .find((e) => e.type === "freedraw");
      const [px, py] = el.points[Math.floor(el.points.length / 2)];
      const zoom = appState.zoom.value;
      return {
        x: (el.x + px + appState.scrollX) * zoom + appState.offsetLeft,
        y: (el.y + py + appState.scrollY) * zoom + appState.offsetTop,
      };
    });
    await input.touchStart([box.x, box.y]);
    await input.touchEnd();
    await sleep(80);
    await input.touchStart([box.x, box.y]);
    await input.touchEnd();
    await sleep(300);
    state = await editor(page);
    check(
      "a finger tap doesn't select, a double tap doesn't create a text",
      state.selected === 0 && !state.editingText && state.texts === 0,
      JSON.stringify(state),
    );
    // the pen does select
    await input.penDown(box.x, box.y);
    await input.penUp(box.x, box.y);
    await sleep(200);
    state = await editor(page);
    check("the pen selects", state.selected === 1, JSON.stringify(state));

    // --- pen mode off: fingers draw ---------------------------------------
    await page.evaluate(() =>
      window.__whiteboard.excalidrawAPI.updateScene({
        appState: { penMode: false, selectedElementIds: {} },
      }),
    );
    await setTool("freedraw");
    await sleep(700);
    const countBefore = (await editor(page)).strokes;
    await input.swipe([[300, 650]], 150, 0);
    await sleep(200);
    state = await editor(page);
    check(
      "with pen mode off, a finger draws",
      state.strokes === countBefore + 1,
      JSON.stringify(state),
    );

    // --- remembered per device --------------------------------------------
    await page.evaluate(() =>
      window.__whiteboard.excalidrawAPI.updateScene({
        appState: { penMode: true },
      }),
    );
    await sleep(300);
    await open();
    state = await editor(page);
    check(
      "pen mode is back after a reload, before the pen touches",
      state.penMode && state.penDetected,
      JSON.stringify(state),
    );

    // --- the pen bar ------------------------------------------------------
    const pen = () =>
      page.evaluate(() => {
        const s = window.__whiteboard.excalidrawAPI.getAppState();
        return {
          tool: s.activeTool.type,
          color: s.currentItemStrokeColor,
          opacity: s.currentItemOpacity,
          variability: s.currentItemStrokeVariability,
        };
      });
    const lastElement = () =>
      page.evaluate(() => {
        const elements = window.__whiteboard.excalidrawAPI.getSceneElements();
        const { type, strokeColor, strokeWidth, opacity } =
          elements[elements.length - 1];
        return { type, strokeColor, strokeWidth, opacity };
      });
    await setTool("selection");
    await page.click('[aria-label="Red pen"]');
    let tray = await pen();
    check(
      "the pen bar picks a colored pen in one tap",
      tray.tool === "freedraw" && tray.color === "#e03131",
      JSON.stringify(tray),
    );
    await page.click('[aria-label="Highlighter"]');
    await input.stroke(300, 520, 220, 0);
    await sleep(300);
    let element = await lastElement();
    check(
      "the highlighter draws wide, see-through yellow strokes",
      element.type === "freedraw" &&
        element.strokeColor === "#ffd43b" &&
        element.opacity === 50 &&
        element.strokeWidth === 12,
      JSON.stringify(element),
    );
    await page.click('[aria-label="Black pen"]');
    tray = await pen();
    check(
      "back to a pen after the highlighter: opaque, pressure-sensitive",
      tray.opacity === 100 &&
        tray.color === "#1e1e1e" &&
        tray.variability === "variable",
      JSON.stringify(tray),
    );
    await input.stroke(300, 600, 120, 10);
    await sleep(300);
    element = await lastElement();
    check(
      "pen strokes after the highlighter are normal again",
      element.strokeWidth !== 12 && element.opacity === 100,
      JSON.stringify(element),
    );

    // --- finger taps: undo / redo -----------------------------------------
    await sleep(700);
    const strokesBefore = (await editor(page)).strokes;
    await input.touchStart([500, 400], [620, 400]);
    await sleep(60);
    await input.touchEnd();
    await sleep(300);
    const afterUndo = (await editor(page)).strokes;
    const toast = await page
      .locator(".Toast__message")
      .textContent({ timeout: 2000 })
      .catch(() => null);
    await input.touchStart([500, 400], [620, 400], [740, 400]);
    await sleep(60);
    await input.touchEnd();
    await sleep(300);
    const afterRedo = (await editor(page)).strokes;
    check(
      "a two-finger tap undoes, a three-finger tap redoes",
      afterUndo === strokesBefore - 1 &&
        afterRedo === strokesBefore &&
        toast === "Undo",
      JSON.stringify({ strokesBefore, afterUndo, afterRedo, toast }),
    );

    // --- long press: the context menu --------------------------------------
    await setTool("selection");
    await sleep(300);
    await input.penDown(640, 300);
    await sleep(700);
    const penMenu = await page.locator(".context-menu").count();
    await input.penUp(640, 300);
    await sleep(200);
    const penMenuAfterLift = await page.locator(".context-menu").count();
    await page.keyboard.press("Escape");
    await sleep(1200);
    await input.touchStart([640, 300]);
    await sleep(700);
    const fingerMenu = await page.locator(".context-menu").count();
    await input.touchEnd();
    await sleep(200);
    await page.keyboard.press("Escape");
    check(
      "a long press with the pen or a finger opens the context menu",
      penMenu === 1 && penMenuAfterLift === 1 && fingerMenu === 1,
      JSON.stringify({ penMenu, penMenuAfterLift, fingerMenu }),
    );
    const wakeLocksAlone = await page.evaluate(() => window.__wakeLocks);

    // --- pen hover --------------------------------------------------------
    const fresh = await browser.newContext({
      viewport: { width: 1180, height: 820 },
      hasTouch: true,
    });
    await fresh.addInitScript(() => {
      try {
        localStorage.setItem("whiteboard-debug", "1");
      } catch {}
    });
    await fresh.addCookies([{ name: key, value, url: BASE }]);
    const other = await fresh.newPage();
    other.on("pageerror", (error) => errors.push(error.message));
    await other.goto(`${BASE}/p/${paper.id}`);
    await other.waitForFunction(
      () => window.__whiteboard?.excalidrawAPI,
      null,
      {
        timeout: 20000,
      },
    );
    await sleep(300);
    const otherInput = inputs(await fresh.newCDPSession(other));
    await otherInput.penHover(500, 400);
    await otherInput.penHover(510, 400);
    await sleep(200);
    state = await editor(other);
    check(
      "a pen hovering over the screen turns pen mode on",
      state.penMode && state.penDetected,
      JSON.stringify(state),
    );

    // --- screen wake lock -------------------------------------------------
    await sleep(500);
    const wakeLocks = await page.evaluate(() => window.__wakeLocks);
    check(
      "the screen is kept on once someone else is in the paper",
      wakeLocksAlone === 0 && wakeLocks >= 1,
      JSON.stringify({ wakeLocksAlone, wakeLocks }),
    );
    await fresh.close();

    // --- layout: nothing out of reach -------------------------------------
    const sizes = [
      ["Galaxy Tab S4, portrait", 712, 1138],
      ["iPad, portrait", 810, 1080],
      ["iPad Pro 11, portrait", 834, 1194],
      ["iPad, landscape", 1080, 810],
      ["iPad Air, landscape", 1180, 820],
      ["iPad Pro 11, landscape", 1194, 834],
      ["iPad Pro 12.9, landscape", 1366, 1024],
    ];
    for (const [name, width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await sleep(500);
      const layout = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const controls = [
          ...document.querySelectorAll(
            ".App-menu_top button, .App-menu_bottom button, .wb-pagenav__label",
          ),
        ].filter((el) => el.getBoundingClientRect().width > 0);
        const outside = controls
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.left < 0 || rect.right > width - 4;
          })
          .map((el) => el.getAttribute("aria-label") || el.textContent);
        return {
          outside,
          // the Pages button, or the page bar's label (opens the panel too)
          pages: !!document.querySelector(
            ".wb-pages-trigger, .wb-pagenav__label",
          ),
          pens: document.querySelectorAll(".wb-pentray__btn").length,
        };
      });
      check(
        `${name} (${width}×${height}): every button on screen, pens shown`,
        layout.outside.length === 0 && layout.pages && layout.pens >= 4,
        JSON.stringify(layout),
      );
    }

    check("no errors in the page", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
  }
};

run()
  .catch((error) => {
    console.error(error);
    failures++;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
  });
