/**
 * Real-time session for one paper.
 *
 * - The editor (Excalidraw) holds the elements of the *current* page; the
 *   other pages are kept here in memory, so switching pages is instant.
 * - Local changes are sent to the server as deltas (only elements whose
 *   version the server hasn't seen), throttled to ~30 messages/s.
 * - Remote changes are reconciled with the same rules Excalidraw uses for its
 *   own collaboration, so concurrent edits converge everywhere.
 * - After a reconnect the server sends its full state, we merge it and push
 *   whatever was drawn while offline.
 */

import {
  CaptureUpdateAction,
  getSceneVersion,
  getVisibleSceneBounds,
  isInvisiblySmallElement,
  newElementWith,
  reconcileElements,
  restoreElements,
  zoomToFitBounds,
} from "@excalidraw/excalidraw";
import { bumpElementVersions } from "@excalidraw/excalidraw/data/restore";
import { duplicateElements } from "@excalidraw/element";
import { generateKeyBetween } from "@excalidraw/fractional-indexing";
import throttle from "lodash.throttle";
import { io } from "socket.io-client";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  AppState,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  Gesture,
  NormalizedZoomValue,
  OnUserFollowedPayload,
  SocketId,
  UserToFollow,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";

import { FileSync } from "./files";

import type {
  JoinPaperResult,
  PageMeta,
  PaperSummary,
  GuestIdentity,
  PresenceUser,
  SceneBounds,
  ClientToServerEvents,
  ServerToClientEvents,
  SyncedElement,
} from "../../../whiteboard-server/src/protocol";

import type { Socket } from "socket.io-client";

type Elements = readonly OrderedExcalidrawElement[];

export type SessionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export interface SessionState {
  status: SessionStatus;
  error: string | null;
  /** set once the paper was opened at least once */
  paper: PaperSummary | null;
  /** live (not deleted) pages, in order */
  pages: PageMeta[];
  currentPageId: string | null;
  presence: PresenceUser[];
  socketId: string | null;
  canManage: boolean;
  canEdit: boolean;
  userToFollow: UserToFollow | null;
  followers: number;
  /** the paper was deleted or access was revoked */
  removedReason: string | null;
  /** joined through a public link, without an account */
  isGuest: boolean;
}

/** deleted elements are synced for a day so others learn about deletions */
const DELETED_ELEMENT_TIMEOUT = 24 * 60 * 60 * 1000;
const SEND_THROTTLE_MS = 33;
const POINTER_THROTTLE_MS = 33;
const IDLE_TIMEOUT_MS = 60_000;

const isSyncableElement = (element: OrderedExcalidrawElement) => {
  if (element.isDeleted) {
    return element.updated > Date.now() - DELETED_ELEMENT_TIMEOUT;
  }
  return !isInvisiblySmallElement(element);
};

const randomNonce = () => Math.floor(Math.random() * 2 ** 31);

const randomId = () => {
  const bytes = new Uint8Array(9);
  window.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const isNewer = (
  incoming: { version: number; versionNonce: number },
  existing?: { version: number; versionNonce: number },
) =>
  !existing ||
  incoming.version > existing.version ||
  (incoming.version === existing.version &&
    incoming.versionNonce < existing.versionNonce);

/**
 * a fractional index between two pages. Pages created concurrently by two
 * people can end up with the same index, in which case we append instead.
 */
const indexBetween = (
  before: string | null,
  after: string | null,
  last: string | null,
) => {
  try {
    return generateKeyBetween(before, after);
  } catch {
    return generateKeyBetween(last, null);
  }
};

const comparePages = (a: PageMeta, b: PageMeta) =>
  a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : 1;

/** used to reconcile pages that aren't open in the editor */
const IDLE_APP_STATE = {
  editingTextElement: null,
  resizingElement: null,
  newElement: null,
} as unknown as AppState;

export const getPageLabel = (page: PageMeta, index: number) =>
  page.name.trim() || `Page ${index + 1}`;

export class PaperSession {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | null =
    null;
  private api: ExcalidrawImperativeAPI | null = null;
  private apiUnsubscribers: (() => void)[] = [];

  private pageMetas = new Map<string, PageMeta>();
  /** elements of the pages that aren't open in the editor */
  private pageElements = new Map<string, Elements>();
  private viewports = new Map<
    string,
    Pick<AppState, "scrollX" | "scrollY" | "zoom">
  >();
  /** last version of each element the server is known to have */
  private serverVersions = new Map<string, number>();
  private lastSceneVersion = -1;
  private remotePointers = new Map<
    string,
    {
      pageId: string;
      pointer: Collaborator["pointer"];
      button: Collaborator["button"];
      selectedElementIds: Collaborator["selectedElementIds"];
    }
  >();
  private idleStates = new Map<string, Collaborator["userState"]>();
  private followers: string[] = [];
  private hasJoined = false;
  private destroyed = false;
  private idleTimer: number | null = null;
  private isIdle = false;

  readonly files: FileSync;

  private state: SessionState = {
    status: "connecting",
    error: null,
    paper: null,
    pages: [],
    currentPageId: null,
    presence: [],
    socketId: null,
    canManage: false,
    canEdit: false,
    userToFollow: null,
    followers: 0,
    removedReason: null,
    isGuest: false,
  };
  private listeners = new Set<() => void>();
  /** bumped whenever page contents change, for thumbnails */
  private contentListeners = new Set<(pageId: string) => void>();

  constructor(
    readonly paperId: string,
    private readonly opts: {
      initialPageId?: string | null;
      onPageChange?: (pageId: string) => void;
      onUnauthorized?: () => void;
      /** joins through the public link (embeds) */
      shareToken?: string | null;
      guest?: GuestIdentity | null;
    } = {},
  ) {
    this.files = new FileSync(paperId, {
      shareToken: opts.shareToken ?? null,
      getApi: () => this.api,
      canUpload: () => this.state.canEdit,
      onImageStatusChange: (fileId, status) =>
        this.setImageStatus(fileId, status),
    });
  }

  // ---------------------------------------------------------------------------
  // UI store
  // ---------------------------------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  private setState(updates: Partial<SessionState>) {
    this.state = { ...this.state, ...updates };
    for (const listener of this.listeners) {
      listener();
    }
  }

  onPageContentChange = (listener: (pageId: string) => void) => {
    this.contentListeners.add(listener);
    return () => {
      this.contentListeners.delete(listener);
    };
  };

  private emitContentChange(pageId: string) {
    for (const listener of this.contentListeners) {
      listener(pageId);
    }
  }

  private refreshPages() {
    const pages = [...this.pageMetas.values()]
      .filter((page) => !page.isDeleted)
      .sort(comparePages);
    this.setState({ pages });
    return pages;
  }

  toast(message: string) {
    this.api?.setToast({ message, closable: true, duration: 4000 });
  }

  // ---------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------

  connect() {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
      withCredentials: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      // guests have no session cookie (third-party iframes don't get one)
      auth: this.opts.shareToken ? { guest: true } : {},
    });
    this.socket = socket;

    socket.on("connect", () => this.join());
    socket.on("disconnect", () => {
      if (!this.destroyed) {
        this.setState({
          status: this.hasJoined ? "reconnecting" : "connecting",
        });
      }
    });
    socket.on("connect_error", (error) => {
      if (error.message === "unauthorized") {
        socket.disconnect();
        this.setState({
          status: "failed",
          error:
            "The live connection was refused. Try signing in again — if this keeps happening, make sure your reverse proxy forwards cookies and WebSocket upgrades.",
        });
        this.opts.onUnauthorized?.();
        return;
      }
      this.setState({ status: this.hasJoined ? "reconnecting" : "connecting" });
    });

    socket.on("paper:elements", ({ pageId, elements }) =>
      this.applyRemoteElements(pageId, elements),
    );
    socket.on("paper:resync", ({ pageId, elements }) =>
      this.replacePage(pageId, elements),
    );
    socket.on("paper:pages", ({ pages }) => this.mergePages(pages));
    socket.on("paper:presence", ({ presence }) => this.setPresence(presence));
    socket.on("paper:pointer", (data) => {
      this.remotePointers.set(data.socketId, {
        pageId: data.pageId,
        pointer: data.pointer,
        button: data.button,
        selectedElementIds: data.selectedElementIds,
      });
      if (data.pageId === this.state.currentPageId) {
        this.updateCollaborators();
      }
    });
    socket.on("paper:idle", ({ socketId, state }) => {
      this.idleStates.set(socketId, state as Collaborator["userState"]);
      this.updateCollaborators();
    });
    socket.on("paper:followers", ({ followers }) => {
      this.followers = followers;
      this.setState({ followers: followers.length });
      this.relayViewport();
    });
    socket.on("paper:viewport", ({ socketId, pageId, bounds }) => {
      if (this.state.userToFollow?.socketId !== socketId) {
        return;
      }
      this.goToPage(pageId, bounds);
    });
    socket.on("paper:summon", ({ pageId, bounds, by }) => {
      const index = this.state.pages.findIndex((page) => page.id === pageId);
      this.goToPage(pageId, bounds);
      if (index >= 0) {
        this.toast(
          `${by} brought everyone to ${getPageLabel(
            this.state.pages[index],
            index,
          )}`,
        );
      }
    });
    // whether we may still draw arrives with the presence update after this
    socket.on("paper:settings", ({ locked, title }) => {
      if (this.state.paper) {
        this.setState({ paper: { ...this.state.paper, locked, title } });
      }
    });
    socket.on("paper:removed", ({ reason }) => {
      this.setState({ removedReason: reason });
      socket.disconnect();
    });

    document.addEventListener("visibilitychange", this.onVisibilityChange);
    document.addEventListener("pointermove", this.onActivity, {
      passive: true,
    });
  }

  destroy() {
    this.destroyed = true;
    this.sendPendingElements.flush();
    this.socket?.disconnect();
    this.socket = null;
    this.detach();
    this.files.destroy();
    this.listeners.clear();
    this.contentListeners.clear();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    document.removeEventListener("pointermove", this.onActivity);
    if (this.idleTimer) {
      window.clearTimeout(this.idleTimer);
    }
  }

  private join() {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    socket.emit(
      "paper:join",
      {
        paperId: this.paperId,
        shareToken: this.opts.shareToken,
        guest: this.opts.guest,
      },
      (response) => {
        if (this.destroyed) {
          return;
        }
        if (!response.ok) {
          this.setState({ status: "failed", error: response.error });
          socket.disconnect();
          return;
        }
        if (this.hasJoined) {
          this.onRejoin(response.data);
        } else {
          this.onFirstJoin(response.data);
        }
        this.hasJoined = true;
      },
    );
  }

  private onFirstJoin(data: JoinPaperResult) {
    for (const page of data.pages) {
      this.pageMetas.set(page.id, page);
    }
    for (const [pageId, elements] of Object.entries(data.elements)) {
      for (const element of elements) {
        this.serverVersions.set(element.id, element.version);
      }
      this.pageElements.set(
        pageId,
        restoreElements(elements as unknown as ExcalidrawElement[], null),
      );
    }
    const pages = this.refreshPages();
    const currentPageId =
      pages.find((page) => page.id === this.opts.initialPageId)?.id ??
      pages[0]?.id ??
      null;
    this.setState({
      status: "connected",
      error: null,
      paper: data.paper,
      currentPageId,
      socketId: data.socketId,
      canManage: data.canManage,
      canEdit: data.canEdit,
      isGuest: data.isGuest,
    });
    this.setPresence(data.presence);
    if (currentPageId) {
      this.socket?.emit("paper:presence", { pageId: currentPageId });
      this.opts.onPageChange?.(currentPageId);
    }
  }

  /** reconnected: merge the server's state and push what we drew offline */
  private onRejoin(data: JoinPaperResult) {
    const socket = this.socket!;
    this.serverVersions = new Map();
    for (const elements of Object.values(data.elements)) {
      for (const element of elements) {
        this.serverVersions.set(element.id, element.version);
      }
    }
    // pages we changed while offline
    const serverPages = new Map(data.pages.map((page) => [page.id, page]));
    const offlinePages = [...this.pageMetas.values()].filter((page) =>
      isNewer(page, serverPages.get(page.id)),
    );
    this.mergePages(data.pages);

    for (const [pageId, elements] of Object.entries(data.elements)) {
      this.applyRemoteElements(pageId, elements, { trackVersions: false });
    }
    this.setState({
      status: "connected",
      error: null,
      socketId: data.socketId,
      canManage: data.canManage,
      paper: data.paper,
      canEdit: data.canEdit,
    });
    this.setPresence(data.presence);

    if (offlinePages.length && this.state.canEdit) {
      socket.emit("paper:pages", { pages: offlinePages });
    }
    if (this.state.currentPageId) {
      socket.emit("paper:presence", { pageId: this.state.currentPageId });
    }
    if (this.state.canEdit) {
      for (const page of this.pageMetas.values()) {
        if (page.id !== this.state.currentPageId) {
          this.sendChangedElements(page.id, this.getElements(page.id));
        }
      }
      this.sendPendingElements();
    }
  }

  /** the editor is ready */
  attach = (api: ExcalidrawImperativeAPI) => {
    this.detach();
    this.api = api;
    const currentPageId = this.state.currentPageId;
    if (currentPageId) {
      // updates may have arrived since the editor got its initial data
      const stored = this.pageElements.get(currentPageId) ?? [];
      const reconciled = this.reconcile(
        api.getSceneElementsIncludingDeleted(),
        stored,
        api.getAppState(),
      );
      this.pageElements.delete(currentPageId);
      this.lastSceneVersion = getSceneVersion(reconciled);
      api.updateScene({
        elements: reconciled,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    this.updateCollaborators();
    this.files.sync(api.getSceneElementsIncludingDeleted());

    const relay = throttle(() => this.relayViewport(), 100);
    this.apiUnsubscribers.push(
      api.onScrollChange(() => {
        if (this.followers.length) {
          relay();
        }
      }),
      api.onUserFollow((payload) => this.onUserFollow(payload)),
      () => relay.cancel(),
    );
  };

  private detach() {
    for (const unsubscribe of this.apiUnsubscribers) {
      unsubscribe();
    }
    this.apiUnsubscribers = [];
    this.api = null;
  }

  /** what the editor starts with */
  getInitialData() {
    const pageId = this.state.currentPageId;
    const elements = pageId ? this.pageElements.get(pageId) ?? [] : [];
    return {
      elements,
      appState: { isLoading: false },
      scrollToContent: true,
    };
  }

  // ---------------------------------------------------------------------------
  // elements
  // ---------------------------------------------------------------------------

  /** all elements of a page (including deleted) */
  getElements(pageId: string): Elements {
    if (pageId === this.state.currentPageId && this.api) {
      return this.api.getSceneElementsIncludingDeleted();
    }
    return this.pageElements.get(pageId) ?? [];
  }

  private reconcile(
    local: Elements,
    remote: readonly ExcalidrawElement[],
    appState: AppState,
  ) {
    const restored = restoreElements(
      remote,
      local,
    ) as unknown as RemoteExcalidrawElement[];
    return bumpElementVersions(
      reconcileElements(local, restored, appState),
      local,
    );
  }

  private applyRemoteElements(
    pageId: string,
    elements: SyncedElement[],
    opts: { trackVersions?: boolean } = {},
  ) {
    if (!elements.length) {
      return;
    }
    if (opts.trackVersions !== false) {
      for (const element of elements) {
        const known = this.serverVersions.get(element.id) ?? -1;
        if (element.version > known) {
          this.serverVersions.set(element.id, element.version);
        }
      }
    }
    const remote = elements as unknown as ExcalidrawElement[];
    if (pageId === this.state.currentPageId && this.api) {
      const reconciled = this.reconcile(
        this.api.getSceneElementsIncludingDeleted(),
        remote,
        this.api.getAppState(),
      );
      // don't echo back what we just received
      this.lastSceneVersion = getSceneVersion(reconciled);
      this.api.updateScene({
        elements: reconciled,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      this.files.sync(reconciled);
    } else {
      this.pageElements.set(
        pageId,
        this.reconcile(
          this.pageElements.get(pageId) ?? [],
          remote,
          IDLE_APP_STATE,
        ),
      );
    }
    this.emitContentChange(pageId);
  }

  /** the server rejected our changes: take its state as is */
  private replacePage(pageId: string, elements: SyncedElement[]) {
    for (const element of elements) {
      this.serverVersions.set(element.id, element.version);
    }
    const restored = restoreElements(
      elements as unknown as ExcalidrawElement[],
      null,
    );
    if (pageId === this.state.currentPageId && this.api) {
      this.lastSceneVersion = getSceneVersion(restored);
      this.api.updateScene({
        elements: restored,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    } else {
      this.pageElements.set(pageId, restored);
    }
    this.emitContentChange(pageId);
  }

  /** called by the editor on every change */
  onEditorChange = (
    elements: Elements,
    _appState: AppState,
    _files: BinaryFiles,
  ) => {
    if (!this.api || !this.state.currentPageId) {
      return;
    }
    const version = getSceneVersion(elements);
    if (version === this.lastSceneVersion) {
      return;
    }
    this.lastSceneVersion = version;
    this.emitContentChange(this.state.currentPageId);
    if (this.state.canEdit) {
      this.sendPendingElements();
      this.files.sync(elements);
    }
  };

  private sendChangedElements(pageId: string, elements: Elements) {
    const socket = this.socket;
    if (!socket?.connected || !this.hasJoined || !this.state.canEdit) {
      return;
    }
    const changed: OrderedExcalidrawElement[] = [];
    for (const element of elements) {
      if (
        element.version > (this.serverVersions.get(element.id) ?? -1) &&
        isSyncableElement(element)
      ) {
        changed.push(element);
      }
    }
    if (!changed.length) {
      return;
    }
    for (const element of changed) {
      this.serverVersions.set(element.id, element.version);
    }
    socket.emit("paper:elements", {
      pageId,
      elements: changed as unknown as SyncedElement[],
    });
  }

  private sendPendingElements = throttle(
    () => {
      const pageId = this.state.currentPageId;
      if (this.api && pageId) {
        this.sendChangedElements(
          pageId,
          this.api.getSceneElementsIncludingDeleted(),
        );
      }
    },
    SEND_THROTTLE_MS,
    { leading: true, trailing: true },
  );

  /** whether some local changes haven't reached the server yet */
  hasUnsyncedChanges() {
    if (!this.state.canEdit) {
      return false;
    }
    for (const page of this.pageMetas.values()) {
      for (const element of this.getElements(page.id)) {
        if (
          element.version > (this.serverVersions.get(element.id) ?? -1) &&
          isSyncableElement(element)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private setImageStatus(fileId: string, status: "saved" | "error") {
    // the image may be on any page (the user may have switched meanwhile)
    for (const page of this.pageMetas.values()) {
      const elements = this.getElements(page.id);
      let changed = false;
      const next = elements.map((element) => {
        if (
          element.type === "image" &&
          element.fileId === fileId &&
          element.status !== status &&
          !element.isDeleted
        ) {
          changed = true;
          return newElementWith(element, { status });
        }
        return element;
      });
      if (!changed) {
        continue;
      }
      if (page.id === this.state.currentPageId && this.api) {
        this.api.updateScene({
          elements: next,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      } else {
        this.pageElements.set(page.id, next);
        this.sendChangedElements(page.id, next);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // pages
  // ---------------------------------------------------------------------------

  private mergePages(pages: PageMeta[]) {
    for (const page of pages) {
      if (isNewer(page, this.pageMetas.get(page.id))) {
        this.pageMetas.set(page.id, page);
      }
    }
    const live = this.refreshPages();
    const current = this.state.currentPageId;
    if (current && !live.some((page) => page.id === current) && live.length) {
      // our page was deleted by someone else
      const deleted = this.pageMetas.get(current);
      const next =
        live.find((page) => deleted && page.index > deleted.index) ??
        live[live.length - 1];
      this.switchPage(next.id);
      this.toast("The page you were on was deleted");
    }
  }

  private savePage(page: PageMeta) {
    this.pageMetas.set(page.id, page);
    this.refreshPages();
    if (this.socket?.connected) {
      this.socket.emit("paper:pages", { pages: [page] });
    }
  }

  private bump(page: PageMeta, updates: Partial<PageMeta>): PageMeta {
    return {
      ...page,
      ...updates,
      version: page.version + 1,
      versionNonce: randomNonce(),
      updated: Date.now(),
    };
  }

  /** creates a page after `afterPageId` (default: the current page) */
  addPage(afterPageId = this.state.currentPageId, elements?: Elements) {
    const pages = this.state.pages;
    const index = pages.findIndex((page) => page.id === afterPageId);
    const before = index >= 0 ? pages[index] : pages[pages.length - 1];
    const after = index >= 0 ? pages[index + 1] : undefined;
    const page: PageMeta = {
      id: randomId(),
      name: "",
      index: indexBetween(
        before?.index ?? null,
        after?.index ?? null,
        pages[pages.length - 1]?.index ?? null,
      ),
      version: 1,
      versionNonce: randomNonce(),
      updated: Date.now(),
      isDeleted: false,
    };
    this.savePage(page);
    if (elements?.length) {
      this.pageElements.set(page.id, elements);
      this.sendChangedElements(page.id, elements);
    }
    this.switchPage(page.id);
    return page;
  }

  duplicatePage(pageId: string) {
    const source = this.getElements(pageId).filter(
      (element) => !element.isDeleted,
    );
    const { duplicatedElements } = duplicateElements({
      type: "everything",
      elements: source,
    });
    const page = this.addPage(
      pageId,
      restoreElements(duplicatedElements, null),
    );
    const sourceMeta = this.pageMetas.get(pageId);
    if (sourceMeta?.name) {
      this.renamePage(page.id, `${sourceMeta.name} (copy)`);
    }
  }

  renamePage(pageId: string, name: string) {
    const page = this.pageMetas.get(pageId);
    if (page && page.name !== name) {
      this.savePage(this.bump(page, { name: name.slice(0, 120) }));
    }
  }

  deletePage(pageId: string) {
    const page = this.pageMetas.get(pageId);
    const pages = this.state.pages;
    if (!page || pages.length <= 1) {
      return;
    }
    if (pageId === this.state.currentPageId) {
      const index = pages.findIndex((p) => p.id === pageId);
      this.switchPage((pages[index + 1] ?? pages[index - 1]).id);
    }
    this.savePage(this.bump(page, { isDeleted: true }));
  }

  /** moves a page to position `toIndex` (in the list of live pages) */
  movePage(pageId: string, toIndex: number) {
    const page = this.pageMetas.get(pageId);
    if (!page) {
      return;
    }
    const others = this.state.pages.filter((p) => p.id !== pageId);
    const clamped = Math.max(0, Math.min(toIndex, others.length));
    const before = others[clamped - 1];
    const after = others[clamped];
    if (
      this.state.pages.indexOf(page) === clamped ||
      (before && after && before.index >= after.index)
    ) {
      return;
    }
    this.savePage(
      this.bump(page, {
        index: indexBetween(
          before?.index ?? null,
          after?.index ?? null,
          others[others.length - 1]?.index ?? null,
        ),
      }),
    );
  }

  /** switches page, optionally fitting `bounds` into view */
  goToPage(pageId: string, bounds?: SceneBounds | null) {
    if (!this.pageMetas.get(pageId) || this.pageMetas.get(pageId)!.isDeleted) {
      return;
    }
    this.switchPage(pageId);
    if (bounds && this.api) {
      this.api.updateScene({
        appState: zoomToFitBounds({
          appState: this.api.getAppState(),
          bounds: bounds as [number, number, number, number],
          fit: "contain",
        }).appState,
      });
    }
  }

  switchPage(pageId: string) {
    const api = this.api;
    const current = this.state.currentPageId;
    if (!api || pageId === current || !this.pageMetas.has(pageId)) {
      return;
    }
    // make sure the last strokes of the page we leave are sent
    this.sendPendingElements.flush();

    if (current) {
      const appState = api.getAppState();
      this.pageElements.set(current, api.getSceneElementsIncludingDeleted());
      this.viewports.set(current, {
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: appState.zoom,
      });
    }

    const elements = this.pageElements.get(pageId) ?? [];
    this.pageElements.delete(pageId);
    this.setState({ currentPageId: pageId });
    this.lastSceneVersion = getSceneVersion(elements);

    const viewport = this.viewports.get(pageId);
    api.updateScene({
      elements,
      appState: {
        selectedElementIds: {},
        selectedGroupIds: {},
        editingGroupId: null,
        ...(viewport ?? {
          scrollX: 0,
          scrollY: 0,
          zoom: { value: 1 as NormalizedZoomValue },
        }),
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    // undo/redo is per page
    api.history.clear();

    if (!viewport) {
      const visible = elements.filter((element) => !element.isDeleted);
      if (visible.length) {
        api.setViewport({
          target: visible,
          fit: "scale-down",
          animation: false,
        });
      }
    }

    this.updateCollaborators();
    this.files.sync(elements);
    this.socket?.emit("paper:presence", { pageId });
    this.relayViewport();
    this.opts.onPageChange?.(pageId);
  }

  goToRelativePage(delta: number) {
    const pages = this.state.pages;
    const index = pages.findIndex(
      (page) => page.id === this.state.currentPageId,
    );
    const next = pages[index + delta];
    if (next) {
      this.switchPage(next.id);
    }
  }

  // ---------------------------------------------------------------------------
  // presence, pointers, following
  // ---------------------------------------------------------------------------

  private setPresence(presence: PresenceUser[]) {
    this.setState({ presence });
    const socketIds = new Set(presence.map((user) => user.socketId));
    for (const socketId of this.remotePointers.keys()) {
      if (!socketIds.has(socketId)) {
        this.remotePointers.delete(socketId);
        this.idleStates.delete(socketId);
      }
    }
    // stop following someone who left
    const followed = this.state.userToFollow;
    if (followed && !socketIds.has(followed.socketId)) {
      this.setState({ userToFollow: null });
    }
    const me = presence.find((user) => user.socketId === this.state.socketId);
    if (me && me.canEdit !== this.state.canEdit) {
      this.setState({ canEdit: me.canEdit });
      if (!this.state.canManage) {
        this.toast(
          me.canEdit
            ? "You can draw again"
            : "This paper is now view only — you can watch but not draw",
        );
      }
    }
    this.updateCollaborators();
  }

  private updateCollaborators() {
    if (!this.api) {
      return;
    }
    const collaborators = new Map<SocketId, Collaborator>();
    for (const user of this.state.presence) {
      const pointer = this.remotePointers.get(user.socketId);
      const samePage =
        user.pageId === this.state.currentPageId &&
        pointer?.pageId === this.state.currentPageId;
      collaborators.set(user.socketId as SocketId, {
        id: user.userId,
        socketId: user.socketId as SocketId,
        username: user.username,
        isCurrentUser: user.socketId === this.state.socketId,
        userState: this.idleStates.get(user.socketId),
        ...(samePage
          ? {
              pointer: pointer!.pointer,
              button: pointer!.button,
              selectedElementIds: pointer!.selectedElementIds,
            }
          : {}),
      });
    }
    this.api.updateScene({ collaborators });
  }

  onPointerUpdate = throttle(
    (payload: {
      pointer: { x: number; y: number; tool: "pointer" | "laser" };
      button: "down" | "up";
      pointersMap: Gesture["pointers"];
    }) => {
      const pageId = this.state.currentPageId;
      if (!this.socket?.connected || !pageId || payload.pointersMap.size > 1) {
        return;
      }
      this.socket.volatile.emit("paper:pointer", {
        pageId,
        pointer: payload.pointer,
        button: payload.button,
        selectedElementIds: (this.api?.getAppState().selectedElementIds ??
          {}) as Record<string, true>,
      });
    },
    POINTER_THROTTLE_MS,
  );

  private onUserFollow(payload: OnUserFollowedPayload) {
    const prev = this.state.userToFollow;
    if (payload.action === "FOLLOW") {
      if (prev && prev.socketId !== payload.userToFollow.socketId) {
        this.socket?.emit("paper:follow", {
          socketId: prev.socketId,
          action: "UNFOLLOW",
        });
      }
      this.setState({ userToFollow: payload.userToFollow });
    } else {
      this.setState({ userToFollow: null });
    }
    this.socket?.emit("paper:follow", {
      socketId: payload.userToFollow.socketId,
      action: payload.action,
    });
  }

  /** start/stop following a user (e.g. from the pages panel) */
  follow(user: PresenceUser | null) {
    const prev = this.state.userToFollow;
    if (!user) {
      if (prev) {
        this.onUserFollow({ userToFollow: prev, action: "UNFOLLOW" });
      }
      return;
    }
    this.onUserFollow({
      userToFollow: {
        socketId: user.socketId as SocketId,
        username: user.username,
      },
      action: "FOLLOW",
    });
  }

  private relayViewport() {
    const pageId = this.state.currentPageId;
    if (!this.followers.length || !this.api || !pageId) {
      return;
    }
    this.socket?.emit("paper:viewport", {
      pageId,
      bounds: getVisibleSceneBounds(this.api.getAppState()) as SceneBounds,
    });
  }

  /** brings everyone in the paper to the current page & viewport */
  summonEveryone() {
    const pageId = this.state.currentPageId;
    if (!pageId || !this.api || !this.state.canManage) {
      return;
    }
    this.socket?.emit("paper:summon", {
      pageId,
      bounds: getVisibleSceneBounds(this.api.getAppState()) as SceneBounds,
    });
  }

  setLocked(locked: boolean) {
    if (this.state.canManage) {
      this.socket?.emit("paper:lock", { locked });
    }
  }

  // ---------------------------------------------------------------------------
  // idle status
  // ---------------------------------------------------------------------------

  private setIdleState(state: "active" | "idle" | "away") {
    if (this.socket?.connected) {
      this.socket.volatile.emit("paper:idle", { state });
    }
  }

  private onActivity = () => {
    if (this.idleTimer) {
      window.clearTimeout(this.idleTimer);
    }
    if (this.isIdle) {
      this.isIdle = false;
      this.setIdleState("active");
    }
    this.idleTimer = window.setTimeout(() => {
      this.isIdle = true;
      this.setIdleState("idle");
    }, IDLE_TIMEOUT_MS);
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      this.setIdleState("away");
    } else {
      this.isIdle = false;
      this.setIdleState("active");
    }
  };
}
