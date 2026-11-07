#!/usr/bin/env node
/**
 * Measures how fast work shows up on someone else's screen.
 *
 *   node whiteboard-app/e2e/latency.mjs <url> <admin> <password> [--slow] [--points=150]
 *     [--elements=800] [--cpu=4]
 *
 * Two browsers open the same paper. One draws a stroke (150 points at
 * ~60 Hz) and drops a screenshot-sized PNG; the other records when each
 * point / the image arrives. Reports delays (median / p95 / max), WebSocket
 * bytes, and the image delay. `--slow` puts a throttling proxy between the
 * browsers and the server (50 ms each way, 1.5 Mbit/s up, 6 Mbit/s down per
 * connection) — Chrome's own throttling doesn't apply to WebSockets.
 * `--elements=N` fills the page with N handwriting strokes first (a page of
 * notes: the work per message grows with what's on the page), `--cpu=N`
 * slows both browsers' CPU down N times (a tablet rather than a laptop).
 * `--no-live-strokes` makes the viewer put strokes into the page with every
 * update, as before `liveStrokes.ts` (to compare).
 *
 * Needs Playwright's Chromium (or CHROMIUM_PATH), like smoke.mjs.
 */
import { createRequire } from "node:module";
import net from "node:net";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const slow = args.includes("--slow");
const [BASE = "http://localhost:3002", ADMIN = "admin", PASSWORD] = args.filter(
  (arg) => !arg.startsWith("--"),
);
if (!PASSWORD) {
  console.error("usage: latency.mjs <url> <admin> <password> [--slow]");
  process.exit(2);
}

const option = (name, fallback) =>
  Number(
    args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback,
  );
const POINTS = option("points", 150);
const ELEMENTS = option("elements", 0);
const CPU = option("cpu", 1);
const NO_LIVE_STROKES = args.includes("--no-live-strokes");
const INTERVAL_MS = 16;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
};

/**
 * A TCP proxy that adds latency and limits bandwidth in each direction,
 * like a weak home/mobile connection.
 */
const startThrottlingProxy = (target, { latencyMs, upBps, downBps }) =>
  new Promise((resolve) => {
    const shape = (from, to, bytesPerSecond) => {
      let lastDeparture = 0;
      from.on("data", (chunk) => {
        const now = Date.now();
        const departure =
          Math.max(now, lastDeparture) + (chunk.length / bytesPerSecond) * 1000;
        lastDeparture = departure;
        setTimeout(
          () => to.writable && to.write(chunk),
          departure - now + latencyMs,
        );
      });
      from.on("close", () => setTimeout(() => to.destroy(), latencyMs + 50));
      from.on("error", () => {});
    };
    const server = net.createServer((client) => {
      const upstream = net.connect(target.port, target.hostname);
      shape(client, upstream, upBps);
      shape(upstream, client, downBps);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const api = async (cookie, method, url, body) =>
  (
    await fetch(BASE + url, {
      method,
      headers: { cookie, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    })
  ).json();

const login = async (username, password) => {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new Error(`login failed for ${username}`);
  }
  return response.headers.get("set-cookie").split(";")[0];
};

const run = async () => {
  const stamp = Date.now().toString(36);
  const adminCookie = await login(ADMIN, PASSWORD);
  const memberName = `latency-${stamp}`;
  const { user } = await api(adminCookie, "POST", "/api/users", {
    username: memberName,
    displayName: "Latency Member",
    password: "latency-pass",
  });
  const { paper } = await api(adminCookie, "POST", "/api/papers", {
    title: `Latency ${stamp}`,
    memberIds: [user.id],
  });

  let appUrl = BASE;
  let proxy = null;
  if (slow) {
    const target = new URL(BASE);
    proxy = await startThrottlingProxy(
      { hostname: target.hostname, port: Number(target.port || 80) },
      { latencyMs: 50, upBps: (1.5 * 1e6) / 8, downBps: (6 * 1e6) / 8 },
    );
    appUrl = `http://127.0.0.1:${proxy.address().port}`;
  }

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  );
  const open = async (cookie) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript((noLiveStrokes) => {
      localStorage.setItem("whiteboard-debug", "1");
      if (noLiveStrokes) {
        localStorage.setItem("whiteboard-live-strokes", "off");
      }
      // when element messages leave / arrive (for the delay breakdown)
      const log = { sent: [], received: [], moves: [], cursors: [] };
      window.__wsLog = log;
      window.addEventListener(
        "pointermove",
        () => log.moves.push(Date.now()),
        true,
      );
      const isElements = (data) =>
        typeof data === "string" && data.includes('"paper:elements"');
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (isElements(data)) {
          log.sent.push(Date.now());
        } else if (
          typeof data === "string" &&
          data.includes('"paper:pointer"')
        ) {
          log.cursors.push(Date.now());
        }
        return send.call(this, data);
      };
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          // registered before socket.io's handler, so it runs first
          this.addEventListener("message", (event) => {
            if (isElements(event.data)) {
              log.received.push(Date.now());
            }
          });
        }
      };
    }, NO_LIVE_STROKES);
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, url: BASE }]);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    const bytes = { sent: 0, received: 0 };
    cdp.on("Network.webSocketFrameSent", (event) => {
      bytes.sent += event.response.payloadData.length;
    });
    cdp.on("Network.webSocketFrameReceived", (event) => {
      bytes.received += event.response.payloadData.length;
    });
    await context.addCookies([{ name, value, url: appUrl }]);
    await page.goto(`${appUrl}/p/${paper.id}`);
    await page.waitForFunction(() => window.__whiteboard?.excalidrawAPI, null, {
      timeout: 30000,
    });
    await sleep(800);
    return { page, bytes, cdp };
  };

  try {
    const sender = await open(adminCookie);
    const receiver = await open(await login(memberName, "latency-pass"));

    if (ELEMENTS) {
      // a page of handwriting: short wavy strokes in rows
      await sender.page.evaluate((count) => {
        const { excalidrawAPI } = window.__whiteboard;
        const now = Date.now();
        const strokes = [];
        for (let i = 0; i < count; i++) {
          const points = [];
          for (let j = 0; j < 40; j++) {
            points.push([j * 2, Math.sin((i + j) / 3) * 8]);
          }
          strokes.push({
            id: `note-${now}-${i}`,
            type: "freedraw",
            x: 40 + (i % 30) * 40,
            y: 40 + Math.floor(i / 30) * 22,
            width: 78,
            height: 16,
            angle: 0,
            strokeColor: "#1e1e1e",
            backgroundColor: "transparent",
            fillStyle: "solid",
            strokeWidth: 1,
            strokeStyle: "solid",
            roughness: 1,
            opacity: 100,
            groupIds: [],
            frameId: null,
            roundness: null,
            seed: i + 1,
            version: 2,
            versionNonce: i + 7,
            isDeleted: false,
            boundElements: null,
            updated: now,
            link: null,
            locked: false,
            index: null,
            points,
            pressures: [],
            simulatePressure: true,
            lastCommittedPoint: null,
          });
        }
        excalidrawAPI.updateScene({
          elements: [
            ...excalidrawAPI.getSceneElementsIncludingDeleted(),
            ...strokes,
          ],
        });
      }, ELEMENTS);
      await receiver.page.waitForFunction(
        (count) =>
          window.__whiteboard.excalidrawAPI.getSceneElements().length >= count,
        ELEMENTS,
        { timeout: 60000 },
      );
      await sleep(1000);
    }
    if (CPU > 1) {
      for (const { cdp } of [sender, receiver]) {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
      }
    }

    // the receiver records, frame by frame, when stroke points and images
    // are there to be painted (a receiver busy redrawing gets fewer, later
    // frames — that shows here)
    await receiver.page.evaluate(() => {
      const record = { strokes: [], images: {} };
      window.__latency = record;
      let lastLength = 0;
      // only the stroke drawn from now on (not what's on the page already)
      const known = new Set(
        window.__whiteboard.excalidrawAPI
          .getSceneElementsIncludingDeleted()
          .map((element) => element.id),
      );
      const isNew = (element) =>
        element.type === "freedraw" && !known.has(element.id);
      const onFrame = () => {
        requestAnimationFrame(onFrame);
        const { excalidrawAPI, session } = window.__whiteboard;
        const elements = excalidrawAPI.getSceneElements();
        // strokes still being drawn are on the live overlay
        const stroke =
          session.liveStrokes?.all().findLast(isNew) ??
          elements.findLast(isNew);
        if (stroke && stroke.points.length !== lastLength) {
          lastLength = stroke.points.length;
          record.strokes.push([Date.now(), lastLength]);
        }
        const files = excalidrawAPI.getFiles();
        for (const element of elements) {
          const file = element.type === "image" && files[element.fileId];
          if (!file) {
            continue;
          }
          // first: anything visible (maybe a preview); last: the final data
          const seen = record.images[element.fileId];
          if (!seen) {
            record.images[element.fileId] = {
              first: Date.now(),
              last: Date.now(),
              length: file.dataURL.length,
            };
          } else if (seen.length !== file.dataURL.length) {
            seen.last = Date.now();
            seen.length = file.dataURL.length;
          }
        }
      };
      requestAnimationFrame(onFrame);
    });

    // ---- ink ---------------------------------------------------------------
    const before = { ...sender.bytes };
    const beforeReceived = receiver.bytes.received;
    const framesBefore = {
      sent: await sender.page.evaluate(() => window.__wsLog.sent.length),
      received: await receiver.page.evaluate(
        () => window.__wsLog.received.length,
      ),
    };
    await sender.page.keyboard.press("p");
    await sender.page.mouse.move(300, 300);
    await sender.page.mouse.down();
    const sentAt = [];
    for (let i = 1; i <= POINTS; i++) {
      const angle = i / 12;
      sentAt.push(Date.now());
      await sender.page.mouse.move(300 + i * 4, 300 + Math.sin(angle) * 120);
      await sleep(INTERVAL_MS);
    }
    const upAt = Date.now();
    await sender.page.mouse.up();
    await sleep(slow ? 3000 : 1500);
    const strokes = await receiver.page.evaluate(
      () => window.__latency.strokes,
    );
    const delays = [];
    for (let i = 0; i < sentAt.length; i++) {
      // after i+1 moves the stroke has i+2 points (it starts with one)
      const arrival = strokes.find(([, length]) => length >= i + 2);
      if (arrival) {
        delays.push(arrival[0] - sentAt[i]);
      }
    }
    const finalArrival = strokes[strokes.length - 1]?.[0];
    const cursorUpdates = (
      await sender.page.evaluate(() => window.__wsLog.cursors)
    ).filter((t) => t >= sentAt[0] && t <= upAt).length;
    // where the time goes: input → sent, sent → received, received → shown
    const senderLog = await sender.page.evaluate(() => window.__wsLog.sent);
    const moves = await sender.page.evaluate(() => window.__wsLog.moves);
    const receiverLog = await receiver.page.evaluate(
      () => window.__wsLog.received,
    );
    const parts = { event: [], input: [], network: [], apply: [] };
    for (let i = 0; i < sentAt.length; i++) {
      const move = moves.find((t) => t >= sentAt[i]);
      const sentIndex = senderLog.findIndex(
        (t, index) => index >= framesBefore.sent && t >= (move ?? sentAt[i]),
      );
      const sent = senderLog[sentIndex];
      // the server relays every message as one message, in order
      const received =
        receiverLog[framesBefore.received + sentIndex - framesBefore.sent];
      const shown = strokes.find(([, length]) => length >= i + 2)?.[0];
      if (sent && received && shown && shown >= received) {
        parts.event.push((move ?? sentAt[i]) - sentAt[i]);
        parts.input.push(sent - (move ?? sentAt[i]));
        parts.network.push(received - sent);
        parts.apply.push(shown - received);
      }
    }
    const sentBytes = sender.bytes.sent - before.sent;
    const receivedBytes = receiver.bytes.received - beforeReceived;

    console.log(
      `\nInk (${POINTS} points at ${Math.round(
        (POINTS * 1000) / (upAt - sentAt[0]),
      )} Hz${slow ? ", slow network" : ""}${
        ELEMENTS ? `, ${ELEMENTS} strokes on the page` : ""
      }${CPU > 1 ? `, CPU ${CPU}× slower` : ""}${
        NO_LIVE_STROKES ? ", without live strokes" : ""
      })`,
    );
    console.log(
      `  delay per point: median ${percentile(delays, 50)} ms, p95 ${percentile(
        delays,
        95,
      )} ms, max ${Math.max(...delays)} ms (${
        delays.length
      }/${POINTS} points seen)`,
    );
    console.log(
      `  breakdown (medians): automation → pointer event ${percentile(
        parts.event,
        50,
      )} ms, event → sent ${percentile(
        parts.input,
        50,
      )} ms, sent → received ${percentile(
        parts.network,
        50,
      )} ms, received → on screen ${percentile(parts.apply, 50)} ms`,
    );
    console.log(`  last point after pen up: ${finalArrival - upAt} ms`);
    console.log(`  updates seen by the viewer: ${strokes.length}`);
    console.log(
      `  cursor updates sent while drawing: ${cursorUpdates} (${Math.round(
        (cursorUpdates * 1000) / (upAt - sentAt[0]),
      )}/s)`,
    );
    console.log(
      `  WebSocket bytes: sender ${Math.round(
        sentBytes / 1024,
      )} KB, viewer ${Math.round(receivedBytes / 1024)} KB`,
    );

    // ---- image ---------------------------------------------------------------
    await sender.page.keyboard.press("Escape");
    const image = await sender.page.evaluate(async () => {
      // a screenshot-like picture: blocks of color, text, a bit of noise
      const canvas = document.createElement("canvas");
      canvas.width = 1400;
      canvas.height = 900;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#f8f9fa";
      ctx.fillRect(0, 0, 1400, 900);
      for (let i = 0; i < 60; i++) {
        ctx.fillStyle = `hsl(${(i * 37) % 360} 60% ${40 + (i % 5) * 10}%)`;
        ctx.fillRect(
          (i * 97) % 1300,
          (i * 53) % 800,
          80 + (i % 7) * 20,
          40 + (i % 4) * 30,
        );
      }
      ctx.fillStyle = "#222";
      ctx.font = "18px sans-serif";
      for (let line = 0; line < 30; line++) {
        ctx.fillText(
          `Line ${line}: the quick brown fox jumps over the lazy dog`,
          40,
          40 + line * 28,
        );
      }
      const data = ctx.getImageData(0, 0, 1400, 900);
      for (let i = 0; i < data.data.length; i += 16) {
        data.data[i] = (data.data[i] + Math.random() * 12) | 0;
      }
      ctx.putImageData(data, 0, 0);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([blob], "screenshot.png", { type: "image/png" }),
      );
      const target = document.querySelector("canvas.interactive");
      const rect = target.getBoundingClientRect();
      const startedAt = Date.now();
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: transfer,
            clientX: rect.left + 700,
            clientY: rect.top + 500,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      // when the image is there for the sender itself
      const { excalidrawAPI } = window.__whiteboard;
      let localAt = null;
      for (let i = 0; i < 2000 && !localAt; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const files = excalidrawAPI.getFiles();
        if (
          excalidrawAPI
            .getSceneElements()
            .some(
              (element) => element.type === "image" && files[element.fileId],
            )
        ) {
          localAt = Date.now();
        }
      }
      return { startedAt, localAt, size: blob.size };
    });
    // wait until the image arrived and hasn't changed for a while
    let arrival = null;
    for (let waited = 0; waited < 30000; waited += 100) {
      await sleep(100);
      const images = await receiver.page.evaluate(
        () => window.__latency.images,
      );
      arrival = Object.values(images)[0] ?? null;
      if (arrival && Date.now() - arrival.last > (slow ? 8000 : 2000)) {
        break;
      }
    }
    console.log(`\nImage (${Math.round(image.size / 1024)} KB PNG dropped)`);
    if (!arrival) {
      console.log("  never arrived (30 s)");
    } else {
      if (image.localAt) {
        console.log(
          `  on the sender's screen after ${
            image.localAt - image.startedAt
          } ms`,
        );
      }
      console.log(
        `  visible for the viewer after ${arrival.first - image.startedAt} ms`,
      );
      if (arrival.last !== arrival.first) {
        console.log(
          `  full resolution after ${arrival.last - image.startedAt} ms`,
        );
      }
    }
  } finally {
    await browser.close();
    proxy?.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
