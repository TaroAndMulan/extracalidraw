import crypto from "node:crypto";

import { getSessionToken } from "./auth";
import {
  applyPatch,
  compactElement,
  getLivePages,
  isNewer,
  mergeVersioned,
  pruneTombstones,
  sanitizeElement,
  sanitizePage,
  sanitizePatch,
  sortByIndex,
} from "./reconcile";
import { IMAGE_MIME_RE, isValidId, randomId } from "./store";

import type { Config } from "./config";
import type {
  ClientToServerEvents,
  ElementPatch,
  JoinPaperResult,
  Presenter,
  PageMeta,
  PaperSummary,
  PresenceUser,
  SceneBounds,
  ServerToClientEvents,
  SyncedElement,
} from "./protocol";
import type { Database, PaperRecord, PaperStorage, UserRecord } from "./store";
import type { Server, Socket } from "socket.io";

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
type BoardSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  {},
  SocketData
>;

/** who a socket is, inside the paper it joined */
export type Actor =
  | { kind: "user"; userId: string }
  | { kind: "guest"; guestId: string; name: string; shareToken: string };

interface SocketData {
  /** signed-in user (session cookie), if any */
  userId: string | null;
  actor: Actor | null;
  paperId: string | null;
  pageId: string | null;
  lastResyncAt: number;
}

// -----------------------------------------------------------------------------
// permissions
// -----------------------------------------------------------------------------

export const canAccessPaper = (user: UserRecord, paper: PaperRecord) =>
  user.role === "admin" ||
  paper.ownerId === user.id ||
  paper.memberIds.includes(user.id);

export const canManagePaper = (user: UserRecord, paper: PaperRecord) =>
  user.role === "admin" || paper.ownerId === user.id;

export const canEditPaper = (user: UserRecord, paper: PaperRecord) =>
  canManagePaper(user, paper) ||
  (paper.memberIds.includes(user.id) && !paper.locked);

/** constant-time check of a public link token */
export const isValidShareToken = (
  paper: PaperRecord,
  token: unknown,
): token is string => {
  if (!paper.shareToken || typeof token !== "string") {
    return false;
  }
  const a = Buffer.from(token);
  const b = Buffer.from(paper.shareToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export const canGuestEdit = (paper: PaperRecord) =>
  paper.shareAccess === "edit" && !paper.locked;

const GUEST_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export const sanitizeGuestName = (name: unknown) =>
  typeof name === "string"
    ? name
        // strip control characters
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40)
    : "";

const paperRoom = (paperId: string) => `paper:${paperId}`;
const pageRoom = (paperId: string, pageId: string) =>
  `page:${paperId}:${pageId}`;
const followRoom = (socketId: string) => `follow:${socketId}`;

const randomNonce = () => Math.floor(Math.random() * 2 ** 31);

/** quick low-res versions of images shown while the full one uploads */
const MAX_PREVIEW_BYTES = 512 * 1024;
/** strokes one person can be drawing at once (fingers on a touch screen) */
const MAX_DRAWING = 10;
/** images no element uses are deleted once they're this old (an upload may
 * reach the server before the element that shows it) */
const UNUSED_FILE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export const createDefaultPage = (index = "a0"): PageMeta => ({
  id: randomId(9),
  name: "",
  index,
  version: 1,
  versionNonce: randomNonce(),
  updated: Date.now(),
  isDeleted: false,
});

// -----------------------------------------------------------------------------
// live paper
// -----------------------------------------------------------------------------

/** in-memory, authoritative state of a paper that is being worked on */
export class LivePaper {
  readonly pages = new Map<string, PageMeta>();
  readonly elements = new Map<string, Map<string, SyncedElement>>();
  /** socketId -> presence */
  readonly members = new Map<string, { actor: Actor; pageId: string | null }>();

  lastActiveAt = Date.now();
  lastChangedAt = 0;
  disposed = false;
  /** presenter mode: everyone follows this socket */
  presenter: Presenter | null = null;

  private dirtyPages = new Set<string>();
  private pagesDirty = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    private readonly storage: PaperStorage,
    private readonly persistDebounceMs: number,
    private readonly onPersisted: (paper: LivePaper) => void,
  ) {}

  static async load(
    id: string,
    storage: PaperStorage,
    config: Config,
    onPersisted: (paper: LivePaper) => void,
  ) {
    const live = new LivePaper(
      id,
      storage,
      config.persistDebounceMs,
      onPersisted,
    );
    const now = Date.now();
    const pages = await storage.loadPages(id);
    // nobody can bring back a deleted page: once it's been deleted for as
    // long as erased elements are kept, its contents go too
    const isExpired = (page: PageMeta) =>
      page.isDeleted && now - page.updated > config.tombstoneTtlMs;
    const stored = await Promise.all(
      pages.map((page) =>
        isExpired(page) ? null : storage.loadPageElements(id, page.id),
      ),
    );
    const expired: string[] = [];
    pages.forEach((page, i) => {
      live.pages.set(page.id, page);
      const map = new Map<string, SyncedElement>();
      live.elements.set(page.id, map);
      const contents = stored[i];
      if (!contents) {
        expired.push(page.id);
        return;
      }
      // pages saved in an older format are written again
      let dirty = contents.legacy;
      for (const element of contents.elements) {
        const compact = compactElement(element);
        dirty ||= compact !== element;
        map.set(compact.id, compact);
      }
      if (pruneTombstones(map, config.tombstoneTtlMs, now) > 0) {
        dirty = true;
      }
      if (dirty) {
        live.dirtyPages.add(page.id);
      }
    });
    await Promise.all(
      expired.map((pageId) => storage.deletePageElements(id, pageId)),
    );
    if (getLivePages(live.pages.values()).length === 0) {
      const page = createDefaultPage();
      live.pages.set(page.id, page);
      live.elements.set(page.id, new Map());
      live.pagesDirty = true;
      live.dirtyPages.add(page.id);
    }
    if (live.pagesDirty || live.dirtyPages.size) {
      live.schedulePersist();
    }
    return live;
  }

  get livePageCount() {
    return getLivePages(this.pages.values()).length;
  }

  hasPage(pageId: string) {
    return this.pages.has(pageId);
  }

  /** returns the accepted elements, or `null` if the page doesn't exist */
  applyElements(pageId: string, incoming: SyncedElement[]) {
    const page = this.pages.get(pageId);
    if (!page) {
      return null;
    }
    let map = this.elements.get(pageId);
    if (!map) {
      map = new Map();
      this.elements.set(pageId, map);
    }
    const accepted = mergeVersioned(map, incoming);
    if (accepted.length) {
      this.dirtyPages.add(pageId);
      this.lastChangedAt = Date.now();
      this.schedulePersist();
    }
    return accepted;
  }

  /**
   * applies stroke patches; returns the accepted ones (to forward) and the
   * ids whose patch didn't fit (the sender must send them in full)
   */
  applyPatches(pageId: string, patches: ElementPatch[]) {
    const map = this.elements.get(pageId);
    const accepted: ElementPatch[] = [];
    const rejected: string[] = [];
    if (!map || !this.pages.has(pageId)) {
      return { accepted, rejected: patches.map((patch) => patch.id) };
    }
    for (const patch of patches) {
      const base = map.get(patch.id);
      const next = applyPatch(base, patch);
      if (next && isNewer(next, base)) {
        map.set(patch.id, next);
        accepted.push(patch);
      } else if (!base || base.version < patch.version) {
        // we're missing what it builds on
        rejected.push(patch.id);
      }
    }
    if (accepted.length) {
      this.dirtyPages.add(pageId);
      this.lastChangedAt = Date.now();
      this.schedulePersist();
    }
    return { accepted, rejected };
  }

  applyPages(incoming: PageMeta[]) {
    const accepted = mergeVersioned(this.pages, incoming);
    if (accepted.length) {
      for (const page of accepted) {
        if (!this.elements.has(page.id)) {
          this.elements.set(page.id, new Map());
        }
      }
      this.pagesDirty = true;
      this.lastChangedAt = Date.now();
      this.schedulePersist();
    }
    return accepted;
  }

  getPageElements(pageId: string) {
    return sortByIndex(this.elements.get(pageId)?.values() ?? []);
  }

  /** images shown by any element, erased ones included */
  usedFileIds() {
    const fileIds = new Set<string>();
    for (const map of this.elements.values()) {
      for (const element of map.values()) {
        if (element.type === "image" && typeof element.fileId === "string") {
          fileIds.add(element.fileId);
        }
      }
    }
    return fileIds;
  }

  snapshot() {
    const pages = sortByIndex(this.pages.values());
    const elements: Record<string, SyncedElement[]> = {};
    for (const page of pages) {
      // no need to ship the contents of deleted pages
      if (!page.isDeleted) {
        elements[page.id] = this.getPageElements(page.id);
      }
    }
    return { pages, elements };
  }

  schedulePersist() {
    if (this.persistTimer || this.disposed) {
      return;
    }
    // not reset on further changes, so a busy paper is still saved regularly
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, this.persistDebounceMs);
  }

  persist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.disposed || (!this.pagesDirty && !this.dirtyPages.size)) {
      return this.writeChain;
    }
    const dirtyPages = [...this.dirtyPages];
    const pagesDirty = this.pagesDirty;
    this.dirtyPages.clear();
    this.pagesDirty = false;

    this.writeChain = this.writeChain
      .then(async () => {
        if (this.disposed) {
          return;
        }
        for (const pageId of dirtyPages) {
          await this.storage.savePageElements(
            this.id,
            pageId,
            this.getPageElements(pageId),
          );
        }
        if (pagesDirty) {
          await this.storage.savePages(
            this.id,
            sortByIndex(this.pages.values()),
          );
        }
        this.onPersisted(this);
      })
      .catch((error) => {
        console.error(`[paper ${this.id}] failed to persist`, error);
        // retry later
        for (const pageId of dirtyPages) {
          this.dirtyPages.add(pageId);
        }
        this.pagesDirty ||= pagesDirty;
        this.schedulePersist();
      });
    return this.writeChain;
  }

  async dispose() {
    await this.persist();
    this.disposed = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.writeChain;
  }
}

// -----------------------------------------------------------------------------
// hub
// -----------------------------------------------------------------------------

const sanitizeBounds = (value: unknown): SceneBounds | null => {
  if (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    return value as unknown as SceneBounds;
  }
  return null;
};

export class PaperHub {
  private papers = new Map<string, Promise<LivePaper>>();
  /** papers that finished loading — lets socket handlers run synchronously so
   * messages are applied strictly in the order they arrived */
  private loaded = new Map<string, LivePaper>();
  private unloadInterval: NodeJS.Timeout;

  constructor(
    private readonly io: IO,
    private readonly db: Database,
    private readonly storage: PaperStorage,
    private readonly config: Config,
  ) {
    io.use((socket, next) => {
      const user = db.getSessionUser(getSessionToken(socket.request));
      // guests (public links / embeds) have no session; they're checked
      // against the paper's share token when joining
      const guestMode = socket.handshake.auth?.guest === true;
      if (!user && !guestMode) {
        next(new Error("unauthorized"));
        return;
      }
      socket.data.userId = user?.id ?? null;
      socket.data.actor = null;
      socket.data.paperId = null;
      socket.data.pageId = null;
      socket.data.lastResyncAt = 0;
      next();
    });
    io.on("connection", (socket) => this.onConnection(socket as BoardSocket));

    this.unloadInterval = setInterval(() => this.unloadIdlePapers(), 60_000);
    this.unloadInterval.unref();
  }

  /** loads a paper into memory (once) */
  get(paperId: string) {
    let promise = this.papers.get(paperId);
    if (!promise) {
      promise = LivePaper.load(paperId, this.storage, this.config, (live) =>
        this.onPersisted(live),
      );
      this.papers.set(paperId, promise);
      promise.then(
        (live) => {
          if (this.papers.get(paperId) === promise) {
            this.loaded.set(paperId, live);
          }
        },
        () => this.papers.delete(paperId),
      );
    }
    return promise;
  }

  getIfLoaded(paperId: string) {
    return this.loaded.get(paperId) ?? null;
  }

  private forget(paperId: string) {
    this.papers.delete(paperId);
    this.loaded.delete(paperId);
  }

  private onPersisted(live: LivePaper) {
    const paper = this.db.getPaper(live.id);
    if (!paper) {
      return;
    }
    const pageCount = live.livePageCount;
    const updatedAt = live.lastChangedAt || paper.updatedAt;
    if (paper.pageCount !== pageCount || paper.updatedAt !== updatedAt) {
      this.db.updatePaper(live.id, { pageCount, updatedAt });
    }
  }

  /** runs every minute (public for tests) */
  async unloadIdlePapers() {
    const now = Date.now();
    for (const [paperId, live] of this.loaded) {
      if (
        live.members.size === 0 &&
        now - live.lastActiveAt > this.config.paperIdleUnloadMs
      ) {
        this.forget(paperId);
        await live.dispose();
        // nobody is in the paper: a good moment to tidy up its images
        await this.storage
          .removeUnusedFiles(
            paperId,
            live.usedFileIds(),
            UNUSED_FILE_MIN_AGE_MS,
          )
          .catch((error) =>
            console.error(`[paper ${paperId}] failed to remove images`, error),
          );
      }
    }
  }

  async flushAll() {
    clearInterval(this.unloadInterval);
    await Promise.all(
      [...this.papers.values()].map(async (promise) => {
        const live = await promise.catch(() => null);
        await live?.persist();
      }),
    );
  }

  /** writes pending changes of a paper to disk (e.g. before duplicating it) */
  async persist(paperId: string) {
    await this.getIfLoaded(paperId)?.persist();
  }

  // ---------------------------------------------------------------------------
  // notifications from the REST API
  // ---------------------------------------------------------------------------

  /** an image was uploaded: whoever waits for it can download it now */
  onFileStored(paperId: string, fileId: string) {
    this.io.to(paperRoom(paperId)).emit("paper:fileStored", { fileId });
  }

  /** title/lock/membership changed */
  onPaperUpdated(paper: PaperRecord) {
    this.io
      .to(paperRoom(paper.id))
      .emit("paper:settings", { locked: paper.locked, title: paper.title });
    this.revalidateSockets(paper.id);
    this.broadcastPresence(paper.id);
  }

  async onPaperDeleted(paperId: string) {
    this.io
      .to(paperRoom(paperId))
      .emit("paper:removed", { reason: "This paper was deleted." });
    const sockets = await this.io.in(paperRoom(paperId)).fetchSockets();
    for (const socket of sockets) {
      this.leavePaper(socket as unknown as BoardSocket);
    }
    const promise = this.papers.get(paperId);
    this.forget(paperId);
    const live = await promise?.catch(() => null);
    await live?.dispose();
  }

  /** a user was deleted, disabled, or changed role */
  async onUserChanged(userId: string) {
    const sockets = await this.io.fetchSockets();
    const user = this.db.getUserById(userId);
    for (const socket of sockets) {
      if (socket.data.userId !== userId) {
        continue;
      }
      if (!user || user.disabled) {
        socket.disconnect(true);
      } else if (socket.data.paperId) {
        this.revalidateSockets(socket.data.paperId);
      }
    }
  }

  /** kicks sockets that lost access to a paper */
  private async revalidateSockets(paperId: string) {
    const paper = this.db.getPaper(paperId);
    const sockets = await this.io.in(paperRoom(paperId)).fetchSockets();
    for (const remote of sockets) {
      if (!paper || !this.getPermissions(remote.data.actor, paper)) {
        remote.emit("paper:removed", {
          reason:
            remote.data.actor?.kind === "guest"
              ? "This link was reset or sharing was turned off. Ask for a new link."
              : "You no longer have access to this paper.",
        });
        const socket = this.io.sockets.sockets.get(remote.id);
        if (socket) {
          this.leavePaper(socket as BoardSocket);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // presence
  // ---------------------------------------------------------------------------

  private getPresence(paperId: string, live: LivePaper): PresenceUser[] {
    const paper = this.db.getPaper(paperId);
    const presence: PresenceUser[] = [];
    for (const [socketId, member] of live.members) {
      const permissions = paper && this.getPermissions(member.actor, paper);
      if (!permissions) {
        continue;
      }
      presence.push({
        socketId,
        userId: permissions.id,
        username: permissions.name,
        role: permissions.role,
        pageId: member.pageId,
        canEdit: permissions.canEdit,
      });
    }
    return presence;
  }

  /** what an actor may do on a paper, or `null` without access */
  private getPermissions(actor: Actor | null | undefined, paper: PaperRecord) {
    if (!actor) {
      return null;
    }
    if (actor.kind === "user") {
      const user = this.db.getUserById(actor.userId);
      if (!user || user.disabled || !canAccessPaper(user, paper)) {
        return null;
      }
      return {
        id: user.id,
        name: user.displayName || user.username,
        role: user.role,
        user,
        canEdit: canEditPaper(user, paper),
        canManage: canManagePaper(user, paper),
      };
    }
    if (!isValidShareToken(paper, actor.shareToken)) {
      return null;
    }
    return {
      id: `guest:${actor.guestId}`,
      name: actor.name,
      role: "guest" as const,
      user: null,
      canEdit: canGuestEdit(paper),
      canManage: false,
    };
  }

  private broadcastPresence(paperId: string) {
    const live = this.getIfLoaded(paperId);
    if (live) {
      this.io
        .to(paperRoom(paperId))
        .emit("paper:presence", { presence: this.getPresence(paperId, live) });
    }
  }

  // ---------------------------------------------------------------------------
  // sockets
  // ---------------------------------------------------------------------------

  private leavePaper(socket: BoardSocket) {
    const { paperId, pageId } = socket.data;
    if (!paperId) {
      return;
    }
    socket.leave(paperRoom(paperId));
    if (pageId) {
      socket.leave(pageRoom(paperId, pageId));
    }
    this.leaveFollowRooms(socket);
    socket.data.paperId = null;
    socket.data.pageId = null;
    socket.data.actor = null;

    const live = this.getIfLoaded(paperId);
    if (live) {
      live.members.delete(socket.id);
      live.lastActiveAt = Date.now();
      if (live.presenter?.socketId === socket.id) {
        live.presenter = null;
        this.io
          .to(paperRoom(paperId))
          .emit("paper:presenter", { presenter: null });
      }
      this.broadcastPresence(paperId);
    }
  }

  private emitFollowers(socketId: string) {
    const followers = [
      ...(this.io.sockets.adapter.rooms.get(followRoom(socketId)) ?? []),
    ];
    this.io.to(socketId).emit("paper:followers", { followers });
  }

  private leaveFollowRooms(socket: BoardSocket, except?: string) {
    for (const room of socket.rooms) {
      if (room.startsWith("follow:") && room !== except) {
        socket.leave(room);
        this.emitFollowers(room.slice("follow:".length));
      }
    }
  }

  /** resolves the socket's user, paper & live paper, if it's in one */
  private getContext(socket: BoardSocket) {
    const { paperId } = socket.data;
    if (!paperId) {
      return null;
    }
    const paper = this.db.getPaper(paperId);
    const permissions = paper && this.getPermissions(socket.data.actor, paper);
    if (!paper || !permissions) {
      return null;
    }
    const live = this.getIfLoaded(paperId);
    if (!live || live.disposed) {
      return null;
    }
    live.lastActiveAt = Date.now();
    return {
      paper,
      live,
      name: permissions.name,
      canEdit: permissions.canEdit,
      canManage: permissions.canManage,
    };
  }

  private resync(socket: BoardSocket, live: LivePaper, pageId: string) {
    // don't flood a client that keeps sending rejected updates
    const now = Date.now();
    if (now - socket.data.lastResyncAt < 1000) {
      return;
    }
    socket.data.lastResyncAt = now;
    socket.emit("paper:resync", {
      pageId,
      elements: live.getPageElements(pageId),
    });
  }

  private onConnection(socket: BoardSocket) {
    socket.on("paper:join", async (data, ack) => {
      if (typeof ack !== "function") {
        return;
      }
      try {
        const paperId = data?.paperId;
        const paper = isValidId(paperId) ? this.db.getPaper(paperId) : null;
        let actor: Actor | null = null;
        if (paper && socket.data.userId) {
          const user = this.db.getUserById(socket.data.userId);
          if (user && !user.disabled && canAccessPaper(user, paper)) {
            actor = { kind: "user", userId: user.id };
          }
        }
        if (paper && !actor && isValidShareToken(paper, data?.shareToken)) {
          const guestId = data.guest?.id;
          actor = {
            kind: "guest",
            guestId:
              typeof guestId === "string" && GUEST_ID_RE.test(guestId)
                ? guestId
                : randomId(),
            name: sanitizeGuestName(data.guest?.name) || "Guest",
            shareToken: data.shareToken as string,
          };
        }
        const permissions = paper && this.getPermissions(actor, paper);
        if (!paper || !actor || !permissions) {
          ack({
            ok: false,
            error: data?.shareToken
              ? "This link is invalid or sharing was turned off"
              : "Paper not found",
          });
          return;
        }
        if (socket.data.paperId) {
          this.leavePaper(socket);
        }
        const live = await this.get(paper.id);
        if (!socket.connected) {
          return;
        }
        socket.join(paperRoom(paper.id));
        socket.data.paperId = paper.id;
        socket.data.pageId = null;
        socket.data.actor = actor;
        live.members.set(socket.id, { actor, pageId: null });
        live.lastActiveAt = Date.now();

        const { pages, elements } = live.snapshot();
        const summary: PaperSummary = {
          ...paper,
          pageCount: live.livePageCount,
          // the link secret is only for those who manage the paper
          shareToken: permissions.canManage ? paper.shareToken : null,
        };
        const result: JoinPaperResult = {
          paper: summary,
          pages,
          elements,
          presence: this.getPresence(paper.id, live),
          socketId: socket.id,
          canManage: permissions.canManage,
          canEdit: permissions.canEdit,
          isGuest: actor.kind === "guest",
          presenter: live.presenter,
        };
        ack({ ok: true, data: result });
        this.broadcastPresence(paper.id);
      } catch (error: any) {
        console.error("[paper:join]", error);
        ack({ ok: false, error: "Failed to open paper" });
      }
    });

    socket.on("paper:elements", (data) => {
      const ctx = this.getContext(socket);
      const pageId = data?.pageId;
      if (!ctx || !isValidId(pageId) || !Array.isArray(data?.elements)) {
        return;
      }
      if (!ctx.canEdit) {
        this.resync(socket, ctx.live, pageId);
        return;
      }
      const elements: SyncedElement[] = [];
      for (const value of data.elements) {
        const element = sanitizeElement(value);
        if (element) {
          elements.push(element);
        }
      }
      const patches: ElementPatch[] = [];
      for (const value of Array.isArray(data.patches) ? data.patches : []) {
        const patch = sanitizePatch(value);
        if (patch) {
          patches.push(patch);
        }
      }
      // full elements first: patches may build on them
      const accepted = ctx.live.applyElements(pageId, elements);
      if (accepted === null) {
        return;
      }
      const patched = patches.length
        ? ctx.live.applyPatches(pageId, patches)
        : { accepted: [], rejected: [] };
      if (accepted.length || patched.accepted.length) {
        // strokes still being drawn, among those relayed
        const relayed = new Set([
          ...accepted.map((element) => element.id),
          ...patched.accepted.map((patch) => patch.id),
        ]);
        const drawing = Array.isArray(data.drawing)
          ? data.drawing
              .filter((id): id is string => isValidId(id) && relayed.has(id))
              .slice(0, MAX_DRAWING)
          : null;
        socket.to(paperRoom(ctx.paper.id)).emit("paper:elements", {
          pageId,
          elements: accepted,
          ...(patched.accepted.length ? { patches: patched.accepted } : {}),
          ...(drawing ? { drawing } : {}),
        });
      }
      if (patched.rejected.length) {
        socket.emit("paper:resend", { pageId, ids: patched.rejected });
      }
    });

    socket.on("paper:file", async (data, bytes, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const ctx = this.getContext(socket);
      if (!ctx || !ctx.canEdit) {
        reply({ ok: false, error: "Not allowed" });
        return;
      }
      const fileId = data?.fileId;
      const mimeType = String(data?.mimeType || "").toLowerCase();
      const isPreview = data?.preview === true;
      const buffer = Buffer.isBuffer(bytes)
        ? bytes
        : bytes instanceof ArrayBuffer
        ? Buffer.from(bytes)
        : null;
      const maxBytes = isPreview ? MAX_PREVIEW_BYTES : this.config.maxFileBytes;
      if (
        !isValidId(fileId) ||
        !IMAGE_MIME_RE.test(mimeType) ||
        !buffer?.length ||
        buffer.length > maxBytes
      ) {
        reply({ ok: false, error: "Invalid image" });
        return;
      }
      // everyone gets it right away (images are already compressed: don't
      // deflate them again); storing happens meanwhile
      socket
        .to(paperRoom(ctx.paper.id))
        .compress(false)
        .emit("paper:file", { fileId, mimeType, preview: isPreview }, buffer);
      if (isPreview) {
        reply({ ok: true });
        return;
      }
      try {
        if (!(await this.storage.hasFile(ctx.paper.id, fileId))) {
          await this.storage.saveFile(ctx.paper.id, fileId, mimeType, buffer);
        }
        reply({ ok: true });
      } catch (error) {
        console.error("[paper:file]", error);
        reply({ ok: false, error: "Couldn't store the image" });
      }
    });

    socket.on("paper:fetch", (data) => {
      const ctx = this.getContext(socket);
      const pageId = data?.pageId;
      if (!ctx || !isValidId(pageId) || !Array.isArray(data?.ids)) {
        return;
      }
      const map = ctx.live.elements.get(pageId);
      const elements = data.ids
        .slice(0, 1000)
        .map((id: unknown) => (typeof id === "string" ? map?.get(id) : null))
        .filter((element): element is SyncedElement => !!element);
      if (elements.length) {
        socket.emit("paper:elements", { pageId, elements });
      }
    });

    socket.on("paper:pages", (data) => {
      const ctx = this.getContext(socket);
      if (!ctx || !Array.isArray(data?.pages)) {
        return;
      }
      if (!ctx.canEdit) {
        socket.emit("paper:pages", {
          pages: sortByIndex(ctx.live.pages.values()),
        });
        return;
      }
      const pages: PageMeta[] = [];
      let rejected = false;
      for (const value of data.pages) {
        const page = sanitizePage(value);
        if (!page) {
          continue;
        }
        const existing = ctx.live.pages.get(page.id);
        // only managers may delete pages
        if (
          page.isDeleted &&
          existing &&
          !existing.isDeleted &&
          !ctx.canManage
        ) {
          rejected = true;
          continue;
        }
        pages.push(page);
      }
      // never let the last page go away
      const accepted = ctx.live.applyPages(pages);
      if (ctx.live.livePageCount === 0) {
        const page = createDefaultPage();
        accepted.push(...ctx.live.applyPages([page]));
        rejected = true;
      }
      if (accepted.length) {
        socket
          .to(paperRoom(ctx.paper.id))
          .emit("paper:pages", { pages: accepted });
      }
      if (rejected) {
        socket.emit("paper:pages", {
          pages: sortByIndex(ctx.live.pages.values()),
        });
      }
    });

    socket.on("paper:presence", (data) => {
      const ctx = this.getContext(socket);
      const pageId = data?.pageId;
      if (!ctx || !isValidId(pageId) || !ctx.live.hasPage(pageId)) {
        return;
      }
      const prevPageId = socket.data.pageId;
      if (prevPageId === pageId) {
        return;
      }
      if (prevPageId) {
        socket.leave(pageRoom(ctx.paper.id, prevPageId));
      }
      socket.join(pageRoom(ctx.paper.id, pageId));
      socket.data.pageId = pageId;
      const member = ctx.live.members.get(socket.id);
      if (member) {
        member.pageId = pageId;
      }
      this.broadcastPresence(ctx.paper.id);
    });

    socket.on("paper:pointer", (data) => {
      const { paperId, pageId } = socket.data;
      const pointer = data?.pointer;
      if (
        !paperId ||
        !pageId ||
        data?.pageId !== pageId ||
        !pointer ||
        !Number.isFinite(pointer.x) ||
        !Number.isFinite(pointer.y)
      ) {
        return;
      }
      socket.volatile.to(pageRoom(paperId, pageId)).emit("paper:pointer", {
        socketId: socket.id,
        pageId,
        pointer: {
          x: pointer.x,
          y: pointer.y,
          tool: pointer.tool === "laser" ? "laser" : "pointer",
        },
        button: data.button === "down" ? "down" : "up",
        selectedElementIds:
          data.selectedElementIds && typeof data.selectedElementIds === "object"
            ? data.selectedElementIds
            : {},
      });
    });

    socket.on("paper:idle", (data) => {
      const { paperId } = socket.data;
      const state = data?.state;
      if (!paperId || !["active", "idle", "away"].includes(state)) {
        return;
      }
      socket.volatile
        .to(paperRoom(paperId))
        .emit("paper:idle", { socketId: socket.id, state });
    });

    socket.on("paper:follow", (data) => {
      const { paperId } = socket.data;
      const target = data?.socketId;
      if (!paperId || typeof target !== "string" || target === socket.id) {
        return;
      }
      if (data.action === "FOLLOW") {
        const targetSocket = this.io.sockets.sockets.get(target);
        if (targetSocket?.data.paperId !== paperId) {
          return;
        }
        // you can only follow one user at a time
        this.leaveFollowRooms(socket, followRoom(target));
        socket.join(followRoom(target));
      } else {
        socket.leave(followRoom(target));
      }
      this.emitFollowers(target);
    });

    socket.on("paper:viewport", (data) => {
      const { paperId } = socket.data;
      const bounds = sanitizeBounds(data?.bounds);
      if (!paperId || !bounds || !isValidId(data?.pageId)) {
        return;
      }
      socket.to(followRoom(socket.id)).emit("paper:viewport", {
        socketId: socket.id,
        pageId: data.pageId,
        bounds,
      });
    });

    socket.on("paper:summon", (data) => {
      const ctx = this.getContext(socket);
      if (
        !ctx ||
        !ctx.canManage ||
        !isValidId(data?.pageId) ||
        !ctx.live.hasPage(data.pageId)
      ) {
        return;
      }
      socket.to(paperRoom(ctx.paper.id)).emit("paper:summon", {
        pageId: data.pageId,
        bounds: sanitizeBounds(data.bounds),
        by: ctx.name,
      });
    });

    socket.on("paper:lock", (data) => {
      const ctx = this.getContext(socket);
      if (!ctx || !ctx.canManage || typeof data?.locked !== "boolean") {
        return;
      }
      const paper = this.db.updatePaper(ctx.paper.id, { locked: data.locked });
      if (paper) {
        this.onPaperUpdated(paper);
      }
    });

    socket.on("paper:present", (data) => {
      const ctx = this.getContext(socket);
      if (!ctx || !ctx.canManage || typeof data?.on !== "boolean") {
        return;
      }
      const presenter = data.on
        ? { socketId: socket.id, name: ctx.name }
        : null;
      // only the current presenter can stop presenting
      if (!data.on && ctx.live.presenter?.socketId !== socket.id) {
        return;
      }
      ctx.live.presenter = presenter;
      this.io
        .to(paperRoom(ctx.paper.id))
        .emit("paper:presenter", { presenter });
    });

    socket.on("disconnecting", () => {
      this.leavePaper(socket);
    });
  }
}
