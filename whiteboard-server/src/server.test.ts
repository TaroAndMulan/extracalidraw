/**
 * End-to-end tests of the whiteboard server: a real HTTP server on a random
 * port, real socket.io clients, a temporary data directory.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { io as connectSocket } from "socket.io-client";

import { createApp } from "./app";
import { config as defaultConfig } from "./config";

import type {
  ClientToServerEvents,
  ElementPatch,
  JoinPaperResult,
  PageMeta,
  PaperSummary,
  PublicUser,
  ServerToClientEvents,
  SyncedElement,
} from "./protocol";
import type { Socket } from "socket.io-client";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const ADMIN_PASSWORD = "admin-pass-123";

let dataDir: string;
let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
const sockets: ClientSocket[] = [];

const startServer = async (overrides: Partial<typeof defaultConfig> = {}) => {
  app = await createApp({
    ...defaultConfig,
    host: "127.0.0.1",
    port: 0,
    dataDir,
    staticDir: path.join(dataDir, "no-app"),
    adminUsername: "admin",
    adminPassword: ADMIN_PASSWORD,
    resetAdminPassword: false,
    persistDebounceMs: 10,
    trustProxy: false,
    cookieSecure: "false",
    ...overrides,
  });
  base = `http://127.0.0.1:${await app.listen()}`;
};

const login = async (username: string, password: string) => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
};

const request = async <T = any>(
  cookie: string | null,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    data: (await response.json().catch(() => null)) as T,
  };
};

const connect = (cookie: string | null, guest = false) => {
  const socket: ClientSocket = connectSocket(base, {
    transports: ["websocket"],
    extraHeaders: cookie ? { cookie } : {},
    auth: guest ? { guest: true } : {},
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  return socket;
};

const join = (
  socket: ClientSocket,
  paperId: string,
  extra: { shareToken?: string; guest?: { id: string; name: string } } = {},
) =>
  new Promise<
    { ok: true; data: JoinPaperResult } | { ok: false; error: string }
  >((resolve) => socket.emit("paper:join", { paperId, ...extra }, resolve));

const joinOk = async (socket: ClientSocket, paperId: string) => {
  const result = await join(socket, paperId);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.data;
};

const next = <E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
  timeout = 2000,
) =>
  new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${event}`)),
      timeout,
    );
    socket.once(event, ((data: any) => {
      clearTimeout(timer);
      resolve(data);
    }) as any);
  });

/** the next event of a kind that matches `predicate` */
const nextMatching = <E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
  predicate: (data: Parameters<ServerToClientEvents[E]>[0]) => boolean,
  timeout = 2000,
) =>
  new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve, reject) => {
    const listener = (data: any) => {
      if (predicate(data)) {
        clearTimeout(timer);
        socket.off(event, listener as any);
        resolve(data);
      }
    };
    const timer = setTimeout(() => {
      socket.off(event, listener as any);
      reject(new Error(`timed out waiting for a matching ${event}`));
    }, timeout);
    socket.on(event, listener as any);
  });

/** collects events of a kind, to assert that something did NOT arrive */
const record = <E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
) => {
  const events: Parameters<ServerToClientEvents[E]>[0][] = [];
  socket.on(event, ((data: any) => events.push(data)) as any);
  return events;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const element = (
  id: string,
  version: number,
  extra: Partial<SyncedElement> = {},
): SyncedElement => ({
  id,
  type: "rectangle",
  version,
  versionNonce: version * 10,
  index: "a0",
  isDeleted: false,
  updated: Date.now(),
  ...extra,
});

const newPage = (id: string, index: string): PageMeta => ({
  id,
  name: "",
  index,
  version: 1,
  versionNonce: 1,
  updated: Date.now(),
  isDeleted: false,
});

let adminCookie: string;
let memberCookie: string;
let otherCookie: string;
let member: PublicUser;
let paper: PaperSummary;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "whiteboard-test-"));
  await startServer();
  adminCookie = await login("admin", ADMIN_PASSWORD);
  ({ user: member } = (
    await request(adminCookie, "POST", "/api/users", {
      username: "maya",
      displayName: "Maya",
      password: "maya-pass",
    })
  ).data);
  await request(adminCookie, "POST", "/api/users", {
    username: "omar",
    displayName: "Omar",
    password: "omar-pass",
  });
  memberCookie = await login("maya", "maya-pass");
  otherCookie = await login("omar", "omar-pass");
  ({ paper } = (
    await request(adminCookie, "POST", "/api/papers", {
      title: "Lesson",
      memberIds: [member.id],
    })
  ).data);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("whiteboard server: accounts & papers", () => {
  it("authenticates and hides admin features from members", async () => {
    expect((await request(null, "GET", "/api/auth/me")).data).toEqual({
      user: null,
    });
    expect(
      (
        await request(null, "POST", "/api/auth/login", {
          username: "admin",
          password: "wrong",
        })
      ).status,
    ).toBe(401);
    expect(
      (await request(memberCookie, "GET", "/api/auth/me")).data.user,
    ).toMatchObject({ username: "maya", role: "member" });
    expect((await request(memberCookie, "GET", "/api/users")).status).toBe(403);
    expect(
      (await request(memberCookie, "POST", "/api/papers", { title: "x" }))
        .status,
    ).toBe(403);
  });

  it("only lists papers shared with a member", async () => {
    const mine = (await request(memberCookie, "GET", "/api/papers")).data;
    const others = (await request(otherCookie, "GET", "/api/papers")).data;
    expect(mine.papers.map((p: PaperSummary) => p.id)).toEqual([paper.id]);
    expect(others.papers).toEqual([]);
    expect(
      (await request(otherCookie, "GET", `/api/papers/${paper.id}`)).status,
    ).toBe(404);
  });

  it("rejects cross-site writes", async () => {
    const response = await request(
      adminCookie,
      "POST",
      "/api/papers",
      { title: "x" },
      { Origin: "https://evil.example" },
    );
    expect(response.status).toBe(403);
  });
});

describe("whiteboard server: real-time", () => {
  it("syncs elements between people and drops stale versions", async () => {
    const admin = connect(adminCookie);
    const maya = connect(memberCookie);
    const joined = await joinOk(admin, paper.id);
    await joinOk(maya, paper.id);
    const pageId = joined.pages[0].id;

    const received = record(maya, "paper:elements");
    admin.emit("paper:elements", { pageId, elements: [element("a", 2)] });
    admin.emit("paper:elements", { pageId, elements: [element("a", 1)] });
    await wait(150);
    expect(received).toHaveLength(1);
    expect(received[0].elements[0]).toMatchObject({ id: "a", version: 2 });

    // a third person joining gets the current state
    const late = connect(adminCookie);
    const state = await joinOk(late, paper.id);
    expect(state.elements[pageId].map((e) => e.version)).toEqual([2]);
    expect(state.presence).toHaveLength(3);
  });

  it("strokes grow through patches; others get the new points only", async () => {
    const admin = connect(adminCookie);
    const maya = connect(memberCookie);
    const joined = await joinOk(admin, paper.id);
    await joinOk(maya, paper.id);
    const pageId = joined.pages[0].id;

    const stroke = element("s", 1, {
      type: "freedraw",
      points: [[0, 0]],
      pressures: [],
      width: 0,
    });
    const patch = (
      baseVersion: number,
      basePointCount: number,
      points: [number, number][],
    ): ElementPatch => ({
      id: "s",
      baseVersion,
      baseVersionNonce: baseVersion * 10,
      basePointCount,
      version: baseVersion + 1,
      versionNonce: (baseVersion + 1) * 10,
      set: { width: basePointCount + points.length },
      appendPoints: points,
      appendPressures: [],
    });

    admin.emit("paper:elements", { pageId, elements: [stroke] });
    await next(maya, "paper:elements");
    const relayed = next(maya, "paper:elements");
    admin.emit("paper:elements", {
      pageId,
      elements: [],
      patches: [patch(1, 1, [[1, 1]])],
    });
    expect((await relayed).patches).toEqual([patch(1, 1, [[1, 1]])]);

    // a patch that doesn't fit what the server has: send it in full
    const resend = next(admin, "paper:resend");
    admin.emit("paper:elements", {
      pageId,
      elements: [],
      patches: [patch(5, 9, [[2, 2]])],
    });
    expect(await resend).toEqual({ pageId, ids: ["s"] });

    // whoever misses a base can fetch the element
    const fetched = next(maya, "paper:elements");
    maya.emit("paper:fetch", { pageId, ids: ["s"] });
    expect((await fetched).elements[0]).toMatchObject({
      id: "s",
      version: 2,
      width: 2,
      points: [
        [0, 0],
        [1, 1],
      ],
    });

    // invalid patches are ignored (no relay, no resend)
    const events = record(maya, "paper:elements");
    admin.emit("paper:elements", {
      pageId,
      elements: [],
      patches: [{ ...patch(2, 2, [[3, 3]]), set: { strokeColor: "red" } }],
    });
    await wait(100);
    expect(events).toHaveLength(0);
    const state = await joinOk(connect(adminCookie), paper.id);
    expect(state.elements[pageId][0]).toMatchObject({ version: 2 });
  });

  it("relays which strokes are still being drawn", async () => {
    const admin = connect(adminCookie);
    const maya = connect(memberCookie);
    const joined = await joinOk(admin, paper.id);
    await joinOk(maya, paper.id);
    const pageId = joined.pages[0].id;
    const stroke = (id: string, version: number) =>
      element(id, version, {
        type: "freedraw",
        points: [[0, 0]],
        pressures: [],
      });

    let relayed = next(maya, "paper:elements");
    admin.emit("paper:elements", {
      pageId,
      elements: [stroke("live", 1)],
      // ids not in the message, or invalid, are dropped
      drawing: ["live", "elsewhere", "../bad"],
    });
    expect((await relayed).drawing).toEqual(["live"]);

    // finished: in the message, not listed
    relayed = next(maya, "paper:elements");
    admin.emit("paper:elements", {
      pageId,
      elements: [stroke("live", 2)],
      drawing: [],
    });
    expect((await relayed).drawing).toEqual([]);

    // older clients don't send it: neither does the relay
    relayed = next(maya, "paper:elements");
    admin.emit("paper:elements", { pageId, elements: [stroke("live", 3)] });
    expect((await relayed).drawing).toBeUndefined();
  });

  it("people outside the paper can't join it", async () => {
    const omar = connect(otherCookie);
    const result = await join(omar, paper.id);
    expect(result.ok).toBe(false);
  });

  it("sends cursors only to people on the same page", async () => {
    const admin = connect(adminCookie);
    const maya = connect(memberCookie);
    const joined = await joinOk(admin, paper.id);
    await joinOk(maya, paper.id);
    const page1 = joined.pages[0].id;
    admin.emit("paper:pages", { pages: [newPage("page2", "a1")] });
    await wait(50);

    admin.emit("paper:presence", { pageId: page1 });
    maya.emit("paper:presence", { pageId: "page2" });
    await wait(50);
    const pointers = record(maya, "paper:pointer");
    const pointer = {
      pageId: page1,
      pointer: { x: 1, y: 2, tool: "pointer" as const },
      button: "up" as const,
      selectedElementIds: {},
    };
    admin.emit("paper:pointer", pointer);
    await wait(100);
    expect(pointers).toHaveLength(0);

    maya.emit("paper:presence", { pageId: page1 });
    await wait(50);
    admin.emit("paper:pointer", pointer);
    await wait(100);
    expect(pointers).toHaveLength(1);
  });

  it("lets members add pages but only managers delete them", async () => {
    const admin = connect(adminCookie);
    const maya = connect(memberCookie);
    await joinOk(admin, paper.id);
    await joinOk(maya, paper.id);

    const adminSees = next(admin, "paper:pages");
    maya.emit("paper:pages", { pages: [newPage("p2", "a1")] });
    expect((await adminSees).pages.map((p) => p.id)).toEqual(["p2"]);

    // a member's delete is refused and they get the real list back
    const correction = next(maya, "paper:pages");
    maya.emit("paper:pages", {
      pages: [{ ...newPage("p2", "a1"), version: 2, isDeleted: true }],
    });
    const pages = (await correction).pages;
    expect(pages.find((p) => p.id === "p2")?.isDeleted).toBe(false);

    const mayaSees = next(maya, "paper:pages");
    admin.emit("paper:pages", {
      pages: [{ ...newPage("p2", "a1"), version: 2, isDeleted: true }],
    });
    expect((await mayaSees).pages[0]).toMatchObject({
      id: "p2",
      isDeleted: true,
    });
  });

  it("locking makes the paper view-only for members", async () => {
    const admin = connect(adminCookie);
    const maya = connect(memberCookie);
    const joined = await joinOk(admin, paper.id);
    await joinOk(maya, paper.id);
    const pageId = joined.pages[0].id;

    const settings = next(maya, "paper:settings");
    // presence updates tell everyone who may draw now
    const presence = nextMatching(maya, "paper:presence", ({ presence }) =>
      presence.some((p) => p.userId === member.id && !p.canEdit),
    );
    admin.emit("paper:lock", { locked: true });
    expect((await settings).locked).toBe(true);
    await presence;

    const adminReceived = record(admin, "paper:elements");
    const resync = next(maya, "paper:resync");
    maya.emit("paper:elements", { pageId, elements: [element("x", 1)] });
    expect((await resync).elements).toEqual([]);
    await wait(100);
    expect(adminReceived).toHaveLength(0);
  });

  it("presenter mode: everyone learns who presents, until they leave", async () => {
    const admin = connect(adminCookie);
    const maya = connect(memberCookie);
    await joinOk(admin, paper.id);
    await joinOk(maya, paper.id);

    // members can't present
    const ignored = record(admin, "paper:presenter");
    maya.emit("paper:present", { on: true });
    await wait(100);
    expect(ignored).toHaveLength(0);

    const started = next(maya, "paper:presenter");
    admin.emit("paper:present", { on: true });
    expect((await started).presenter).toEqual({
      socketId: admin.id,
      name: "Admin",
    });

    const late = connect(memberCookie);
    expect((await joinOk(late, paper.id)).presenter?.socketId).toBe(admin.id);

    const stopped = next(maya, "paper:presenter");
    admin.close();
    expect((await stopped).presenter).toBe(null);
  });

  it("kicks people who lose access", async () => {
    const maya = connect(memberCookie);
    await joinOk(maya, paper.id);
    const removed = next(maya, "paper:removed");
    await request(adminCookie, "PATCH", `/api/papers/${paper.id}`, {
      memberIds: [],
    });
    expect((await removed).reason).toMatch(/no longer have access/);
  });

  it("keeps everything after a restart", async () => {
    const admin = connect(adminCookie);
    const joined = await joinOk(admin, paper.id);
    const pageId = joined.pages[0].id;
    admin.emit("paper:pages", { pages: [newPage("p2", "a1")] });
    admin.emit("paper:elements", { pageId, elements: [element("a", 3)] });
    admin.emit("paper:elements", {
      pageId: "p2",
      elements: [element("b", 1)],
    });
    await wait(100);
    admin.close();

    await app.close();
    await startServer();
    const cookie = await login("admin", ADMIN_PASSWORD);
    const state = await joinOk(connect(cookie), paper.id);
    expect(state.pages.map((p) => p.id)).toEqual([pageId, "p2"]);
    expect(state.elements[pageId].map((e) => e.id)).toEqual(["a"]);
    expect(state.elements.p2.map((e) => e.id)).toEqual(["b"]);
    const { data } = await request(cookie, "GET", `/api/papers/${paper.id}`);
    expect(data.paper.pageCount).toBe(2);
  });
});

describe("whiteboard server: storage", () => {
  const paperDir = () => path.join(dataDir, "papers", paper.id);
  const restart = async (overrides: Partial<typeof defaultConfig> = {}) => {
    await app.close();
    await startServer(overrides);
    return login("admin", ADMIN_PASSWORD);
  };
  const uploadImage = async (fileId: string) => {
    const response = await fetch(
      `${base}/api/papers/${paper.id}/files/${fileId}`,
      {
        method: "PUT",
        headers: { cookie: adminCookie, "Content-Type": "image/png" },
        body: new Uint8Array([137, 80, 78, 71, fileId.length]),
      },
    );
    expect(response.status).toBe(201);
  };
  const imageExists = (fileId: string, paperId = paper.id) =>
    fs
      .stat(path.join(dataDir, "papers", paperId, "files", fileId))
      .then(() => true)
      .catch(() => false);
  const makeOld = async (file: string) => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(file, twoDaysAgo, twoDaysAgo);
  };

  it("keeps strokes compact: rounded points, gzipped pages", async () => {
    const admin = connect(adminCookie);
    const maya = connect(memberCookie);
    const pageId = (await joinOk(admin, paper.id)).pages[0].id;
    await joinOk(maya, paper.id);
    admin.emit("paper:elements", {
      pageId,
      elements: [
        element("s", 2, {
          type: "freedraw",
          points: [
            [0, 0],
            [10.123456789, -4.987654321],
          ],
          pressures: [0.5, 0.37109375],
        }),
      ],
    });
    // others get the compact version
    const { elements } = await next(maya, "paper:elements");
    expect(elements[0].points).toEqual([
      [0, 0],
      [10.12, -4.99],
    ]);
    expect(elements[0].pressures).toEqual([0.5, 0.371]);
    await wait(100);

    const file = path.join(paperDir(), "pages", `${pageId}.json.gz`);
    const stored = JSON.parse(
      zlib.gunzipSync(await fs.readFile(file)).toString(),
    );
    expect(stored.map((e: SyncedElement) => e.points)).toEqual([
      [
        [0, 0],
        [10.12, -4.99],
      ],
    ]);
  });

  it("reads pages stored as plain JSON, and compacts them", async () => {
    const pageId = (await joinOk(connect(adminCookie), paper.id)).pages[0].id;
    await wait(100);
    const pages = path.join(paperDir(), "pages");
    await fs.rm(path.join(pages, `${pageId}.json.gz`));
    const old = element("s", 2, {
      type: "freedraw",
      points: [[1.23456, 2.34567]],
    });
    await fs.writeFile(
      path.join(pages, `${pageId}.json`),
      JSON.stringify([old]),
    );

    const cookie = await restart();
    const state = await joinOk(connect(cookie), paper.id);
    expect(state.elements[pageId].map((e) => e.points)).toEqual([
      [[1.23, 2.35]],
    ]);
    // written again in the new format
    await wait(100);
    expect((await fs.readdir(pages)).sort()).toEqual([`${pageId}.json.gz`]);
  });

  it("drops the contents of pages deleted long ago", async () => {
    const admin = connect(adminCookie);
    await joinOk(admin, paper.id);
    admin.emit("paper:pages", {
      pages: [newPage("p2", "a1"), newPage("p3", "a2")],
    });
    admin.emit("paper:elements", { pageId: "p2", elements: [element("a", 1)] });
    admin.emit("paper:elements", { pageId: "p3", elements: [element("b", 1)] });
    await wait(50);
    admin.emit("paper:pages", {
      pages: [
        { ...newPage("p2", "a1"), version: 2, isDeleted: true },
        {
          ...newPage("p3", "a2"),
          version: 2,
          isDeleted: true,
          // deleted a minute ago
          updated: Date.now() - 60_000,
        },
      ],
    });
    await wait(100);
    admin.close();
    const pages = path.join(paperDir(), "pages");
    expect(await fs.readdir(pages)).toContain("p3.json.gz");

    // pages deleted more than 30 s ago are expired
    const cookie = await restart({ tombstoneTtlMs: 30_000 });
    const state = await joinOk(connect(cookie), paper.id);
    expect(state.pages.find((p) => p.id === "p3")?.isDeleted).toBe(true);
    const files = await fs.readdir(pages);
    expect(files).toContain("p2.json.gz");
    expect(files).not.toContain("p3.json.gz");
  });

  it("removes images nothing uses once the paper is idle", async () => {
    const admin = connect(adminCookie);
    const pageId = (await joinOk(admin, paper.id)).pages[0].id;
    for (const fileId of ["shown", "erased", "unused", "recent"]) {
      await uploadImage(fileId);
    }
    admin.emit("paper:elements", {
      pageId,
      elements: [
        element("i1", 1, { type: "image", fileId: "shown" }),
        element("i2", 2, { type: "image", fileId: "erased", isDeleted: true }),
      ],
    });
    await wait(100);
    admin.close();
    const files = path.join(paperDir(), "files");
    for (const name of await fs.readdir(files)) {
      if (!name.startsWith("recent")) {
        await makeOld(path.join(files, name));
      }
    }

    // still open: nothing happens
    await app.hub.unloadIdlePapers();
    expect(await imageExists("unused")).toBe(true);

    await restart({ paperIdleUnloadMs: 0 });
    await joinOk(connect(await login("admin", ADMIN_PASSWORD)), paper.id);
    for (const socket of sockets.splice(0)) {
      socket.close();
    }
    await wait(50);
    await app.hub.unloadIdlePapers();
    expect(await imageExists("shown")).toBe(true);
    // erased images stay as long as their element is kept (undo)
    expect(await imageExists("erased")).toBe(true);
    // uploads may come before their element
    expect(await imageExists("recent")).toBe(true);
    expect(await imageExists("unused")).toBe(false);
    expect(await fs.readdir(files)).not.toContain("unused.json");
  });

  it("copies of a paper share its images", async () => {
    await uploadImage("picture");
    const { data, status } = await request(
      adminCookie,
      "POST",
      `/api/papers/${paper.id}/duplicate`,
      { title: "Copy" },
    );
    expect(status).toBe(201);
    const original = await fs.stat(path.join(paperDir(), "files", "picture"));
    const copy = await fs.stat(
      path.join(dataDir, "papers", data.paper.id, "files", "picture"),
    );
    expect(copy.ino).toBe(original.ino);

    const download = await fetch(
      `${base}/api/papers/${data.paper.id}/files/picture`,
      { headers: { cookie: adminCookie } },
    );
    expect(download.headers.get("content-type")).toBe("image/png");
    // deleting the original leaves the copy's images alone
    await request(adminCookie, "DELETE", `/api/papers/${paper.id}`);
    expect(await imageExists("picture", data.paper.id)).toBe(true);
  });

  it("serves the app's precompressed files", async () => {
    const appDir = path.join(dataDir, "no-app");
    await fs.mkdir(path.join(appDir, "assets"), { recursive: true });
    const script = `console.log(${JSON.stringify("x".repeat(2000))});`;
    const index = `<!doctype html><script src="/assets/app.js"></script>`;
    await fs.writeFile(path.join(appDir, "index.html"), index);
    await fs.writeFile(path.join(appDir, "assets", "app.js"), script);
    const br = zlib.brotliCompressSync(script);
    await fs.writeFile(path.join(appDir, "assets", "app.js.br"), br);
    await fs.writeFile(
      path.join(appDir, "assets", "app.js.gz"),
      zlib.gzipSync(script),
    );
    await restart();

    const response = await fetch(`${base}/assets/app.js`, {
      headers: { "Accept-Encoding": "br" },
    });
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("content-length")).toBe(String(br.length));
    expect(await response.text()).toBe(script);
  });
});

describe("whiteboard server: images", () => {
  it("stores and serves images for people in the paper", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const upload = await fetch(`${base}/api/papers/${paper.id}/files/abc123`, {
      method: "PUT",
      headers: { cookie: memberCookie, "Content-Type": "image/png" },
      body: png,
    });
    expect(upload.status).toBe(201);

    const download = await fetch(
      `${base}/api/papers/${paper.id}/files/abc123`,
      { headers: { cookie: adminCookie } },
    );
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(png);

    const outsider = await fetch(
      `${base}/api/papers/${paper.id}/files/abc123`,
      { headers: { cookie: otherCookie } },
    );
    expect(outsider.status).toBe(404);

    const notAnImage = await fetch(
      `${base}/api/papers/${paper.id}/files/script`,
      {
        method: "PUT",
        headers: { cookie: memberCookie, "Content-Type": "text/html" },
        body: "<script>",
      },
    );
    expect(notAnImage.status).toBe(415);
  });

  it("pushes images over the live connection and stores them", async () => {
    const admin = connect(adminCookie);
    const maya = connect(memberCookie);
    await joinOk(admin, paper.id);
    await joinOk(maya, paper.id);
    const png = new Uint8Array([137, 80, 78, 71, 9, 9, 9]);

    // a preview is only passed on
    const preview = new Promise<{ meta: any; bytes: Uint8Array }>((resolve) =>
      maya.once("paper:file", (meta, bytes) =>
        resolve({ meta, bytes: new Uint8Array(bytes as ArrayBuffer) }),
      ),
    );
    admin.emit(
      "paper:file",
      { fileId: "img1", mimeType: "image/webp", preview: true },
      new Uint8Array([1, 2]),
    );
    expect(await preview).toEqual({
      meta: { fileId: "img1", mimeType: "image/webp", preview: true },
      bytes: new Uint8Array([1, 2]),
    });
    expect(
      (
        await fetch(`${base}/api/papers/${paper.id}/files/img1`, {
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(404);

    // the full image is passed on and stored (then acknowledged)
    const full = new Promise<Uint8Array>((resolve) =>
      maya.once("paper:file", (_meta, bytes) =>
        resolve(new Uint8Array(bytes as ArrayBuffer)),
      ),
    );
    const ack = await new Promise((resolve) =>
      admin.emit(
        "paper:file",
        { fileId: "img1", mimeType: "image/png" },
        png,
        resolve,
      ),
    );
    expect(ack).toEqual({ ok: true });
    expect(await full).toEqual(png);
    const stored = await fetch(`${base}/api/papers/${paper.id}/files/img1`, {
      headers: { cookie: memberCookie },
    });
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(png);

    // not images, or from people who can't edit: refused
    const refused = await new Promise((resolve) =>
      admin.emit(
        "paper:file",
        { fileId: "x", mimeType: "text/html" },
        new Uint8Array([1]),
        resolve,
      ),
    );
    expect(refused).toMatchObject({ ok: false });
  });

  it("tells everyone when an uploaded image can be downloaded", async () => {
    const admin = connect(adminCookie);
    await joinOk(admin, paper.id);
    const stored = next(admin, "paper:fileStored");
    await fetch(`${base}/api/papers/${paper.id}/files/up1`, {
      method: "PUT",
      headers: { cookie: memberCookie, "Content-Type": "image/png" },
      body: new Uint8Array([137, 80, 78, 71]),
    });
    expect(await stored).toEqual({ fileId: "up1" });
  });
});

describe("whiteboard server: public links (embeds)", () => {
  const enableLink = async (access: "view" | "edit", regenerate = false) =>
    (
      await request(adminCookie, "POST", `/api/papers/${paper.id}/share`, {
        enabled: true,
        access,
        regenerate,
      })
    ).data.paper as PaperSummary;

  it("lets guests join with the link, and only managers see it", async () => {
    const { shareToken } = await enableLink("edit");
    expect(shareToken).toBeTruthy();

    const asMember = await request(
      memberCookie,
      "GET",
      `/api/papers/${paper.id}`,
    );
    expect(asMember.data.paper.shareToken).toBe(null);

    const admin = connect(adminCookie);
    const joined = await joinOk(admin, paper.id);
    const guest = connect(null, true);
    const result = await join(guest, paper.id, {
      shareToken: shareToken!,
      guest: { id: "guest-abc123", name: "Visitor" },
    });
    expect(result.ok && result.data).toMatchObject({
      isGuest: true,
      canEdit: true,
      canManage: false,
    });
    expect(result.ok && result.data.paper.shareToken).toBe(null);

    const received = next(admin, "paper:elements");
    guest.emit("paper:elements", {
      pageId: joined.pages[0].id,
      elements: [element("g", 1)],
    });
    expect((await received).elements[0].id).toBe("g");

    // guests can upload images with the link
    const upload = await fetch(`${base}/api/papers/${paper.id}/files/img1`, {
      method: "PUT",
      headers: { "X-Share-Token": shareToken!, "Content-Type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(upload.status).toBe(201);
  });

  it("refuses wrong links and anonymous sockets", async () => {
    await enableLink("edit");
    const guest = connect(null, true);
    expect((await join(guest, paper.id, { shareToken: "nope" })).ok).toBe(
      false,
    );
    const anonymous = connect(null, false);
    const error = await new Promise<Error>((resolve) =>
      anonymous.once("connect_error", resolve),
    );
    expect(error.message).toBe("unauthorized");
  });

  it("view-only links can't draw, and resetting the link kicks guests", async () => {
    const { shareToken } = await enableLink("view");
    const guest = connect(null, true);
    const result = await join(guest, paper.id, {
      shareToken: shareToken!,
      guest: { id: "guest-abc123", name: "Visitor" },
    });
    expect(result.ok && result.data.canEdit).toBe(false);
    const pageId = result.ok ? result.data.pages[0].id : "";

    const resync = next(guest, "paper:resync");
    guest.emit("paper:elements", { pageId, elements: [element("g", 1)] });
    await resync;

    const removed = next(guest, "paper:removed");
    await enableLink("edit", true);
    expect((await removed).reason).toMatch(/link was reset/);
  });
});
