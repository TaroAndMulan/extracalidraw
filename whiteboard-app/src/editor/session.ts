/**
 * Real-time session for one paper.
 *
 * - The editor (Excalidraw) holds the elements of the *current* page; the
 *   other pages are kept here in memory, so switching pages is instant.
 * - Local changes are sent to the server as deltas (only elements whose
 *   version the server hasn't seen; a stroke being drawn: its new points),
 *   the first right away, then at most one message per frame.
 * - Remote changes are reconciled with the same rules Excalidraw uses for its
 *   own collaboration, so concurrent edits converge everywhere. Others'
 *   strokes still being drawn are shown on a light overlay and go into the
 *   page once finished (see liveStrokes.ts).
 * - After a reconnect the server sends its full state, we merge it and push
 *   whatever was drawn while offline.
 */

import {
  CaptureUpdateAction,
  getCommonBounds,
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
  ExcalidrawFreeDrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";

import { applyPatch } from "../../../whiteboard-server/src/reconcile";

import { FileSync } from "./files";
import { LiveStrokes } from "./liveStrokes";
import { createPatch, snapshotElement } from "./strokePatches";
import { createBackgroundElements } from "./importPages";

import type { BackgroundPage } from "./importPages";

import type { SentSnapshot } from "./strokePatches";
import type {
  ElementPatch,
  JoinPaperResult,
  PageMeta,
  PaperSummary,
  GuestIdentity,
  Presenter,
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
  /** presenter mode: everyone follows this person */
  presenter: Presenter | null;
}

/** deleted elements are synced for a day so others learn about deletions */
const DELETED_ELEMENT_TIMEOUT = 24 * 60 * 60 * 1000;
/** at most one send per frame; the first change goes out right away */
const SEND_INTERVAL_MS = 16;
/** while more than this is waiting in the WebSocket, hold off (and merge) */
const CONGESTION_BYTES = 32 * 1024;
/** ask again for an element that didn't come after this long */
const FETCH_RETRY_MS = 3000;
/** cursor updates: hovering */
const POINTER_INTERVAL_MS = 33;
/** cursor updates while drawing: every frame, in step with the ink (the
 * cursor would trail behind the pen tip on the others' screens) */
const POINTER_DRAWING_INTERVAL_MS = 16;
/** a stroke still being drawn that hasn't grown for this long goes into
 * the page anyway (its author left or lost the connection) */
const LIVE_STROKE_TIMEOUT_MS = 2000;

/** debugging / benchmarks: `localStorage["whiteboard-live-strokes"] = "off"`
 * puts others' strokes into the page with every update (as before
 * liveStrokes.ts) */
const isLiveStrokesOn = () => {
  try {
    return localStorage.getItem("whiteboard-live-strokes") !== "off";
  } catch {
    return true;
  }
};
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

export type PaperSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type PointerPayload = {
  pointer: { x: number; y: number; tool: "pointer" | "laser" };
  button: "down" | "up";
  pointersMap: Gesture["pointers"];
};

export class PaperSession {
  private socket: PaperSocket | null = null;
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
  /** what was last sent of strokes, to send only their new points */
  private sentSnapshots = new Map<string, SentSnapshot>();
  private sendTimer: number | null = null;
  private lastSendAt = 0;
  /** remote changes waiting for the next frame (bursts are applied at once) */
  private pendingRemote = new Map<string, Map<string, SyncedElement>>();
  private isRemoteFlushScheduled = false;
  private isRemoteFrameBusy = false;
  /** elements asked for in full (a patch didn't fit) → when */
  private fetching = new Map<string, number>();
  /** others' strokes on this page while they draw them (see liveStrokes.ts) */
  readonly liveStrokes = new LiveStrokes(() => this.api);
  private readonly isLiveStrokesEnabled = isLiveStrokesOn();
  private liveStrokeTimer: number | null = null;
  private pendingPointer: PointerPayload | null = null;
  private pointerTimer: number | null = null;
  private lastPointerAt = 0;
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
    presenter: null,
  };
  /** the user stopped following the current presenter themselves */
  private presenterOptOut = false;
  private listeners = new Set<() => void>();
  /** bumped whenever page contents change, for thumbnails */
  private contentListeners = new Set<
    (pageId: string, origin: "local" | "remote") => void
  >();

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
      getSocket: () => (this.socket?.connected ? this.socket : null),
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

  /** a page's elements changed, here (`local`) or someone else's change */
  onPageContentChange = (
    listener: (pageId: string, origin: "local" | "remote") => void,
  ) => {
    this.contentListeners.add(listener);
    return () => {
      this.contentListeners.delete(listener);
    };
  };

  private emitContentChange(pageId: string, origin: "local" | "remote") {
    for (const listener of this.contentListeners) {
      listener(pageId, origin);
    }
  }

  /** someone is drawing a stroke on this page (here or remotely): heavy
   * work (thumbnails, the cover) should wait, see `runWhenQuiet` */
  isDrawing() {
    return !!this.api?.getAppState().newElement || this.liveStrokes.size > 0;
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
    const socket: PaperSocket = io({
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

    socket.on("paper:elements", ({ pageId, elements, patches, drawing }) =>
      this.receiveRemote(pageId, elements, patches ?? [], drawing),
    );
    socket.on("paper:file", (meta, bytes) => {
      this.files.receive(
        meta,
        bytes instanceof ArrayBuffer
          ? bytes
          : (bytes.slice().buffer as ArrayBuffer),
      );
    });
    socket.on("paper:fileStored", ({ fileId }) => this.files.onStored(fileId));
    socket.on("paper:resend", ({ pageId, ids }) => {
      // our patches didn't fit the server's copy: send these in full
      for (const id of ids) {
        this.serverVersions.delete(id);
        this.sentSnapshots.delete(id);
      }
      if (pageId === this.state.currentPageId) {
        this.sendNow();
      } else {
        this.sendChangedElements(pageId, this.getElements(pageId));
      }
    });
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
    socket.on("paper:presenter", ({ presenter }) =>
      this.applyPresenter(presenter),
    );
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
    this.sendNow();
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
    if (this.liveStrokeTimer !== null) {
      window.clearInterval(this.liveStrokeTimer);
    }
    if (this.pointerTimer !== null) {
      window.clearTimeout(this.pointerTimer);
    }
    this.liveStrokes.unmount();
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
    this.applyPresenter(data.presenter);
    if (currentPageId) {
      this.socket?.emit("paper:presence", { pageId: currentPageId });
      this.opts.onPageChange?.(currentPageId);
    }
  }

  /** reconnected: merge the server's state and push what we drew offline */
  private onRejoin(data: JoinPaperResult) {
    const socket = this.socket!;
    this.serverVersions = new Map();
    this.sentSnapshots.clear();
    this.fetching.clear();
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
    this.applyPresenter(data.presenter);

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
      this.sendNow();
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
        if (this.liveStrokes.size) {
          this.liveStrokes.scheduleRender();
        }
      }),
      api.onUserFollow((payload) => this.onUserFollow(payload)),
      () => relay.cancel(),
    );
    // ask whoever we follow (e.g. the presenter) for their current view, as
    // it may have been sent before the editor was ready
    const followed = this.state.userToFollow;
    if (followed) {
      this.socket?.emit("paper:follow", {
        socketId: followed.socketId,
        action: "FOLLOW",
      });
    }
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
      // strokes drawn on the overlay until now are in the page
      if (this.liveStrokes.size) {
        this.liveStrokes.release(
          elements
            .filter(
              (element) =>
                element.version >=
                (this.liveStrokes.get(element.id)?.version ?? Infinity),
            )
            .map((element) => element.id),
        );
      }
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
    this.emitContentChange(pageId, "remote");
  }

  /** the server rejected our changes: take its state as is */
  private replacePage(pageId: string, elements: SyncedElement[]) {
    // (includes whatever was still queued for this page)
    this.pendingRemote.delete(pageId);
    if (pageId === this.state.currentPageId) {
      this.liveStrokes.clear();
    }
    for (const element of elements) {
      this.serverVersions.set(element.id, element.version);
      this.sentSnapshots.delete(element.id);
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
    this.emitContentChange(pageId, "remote");
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
    this.emitContentChange(this.state.currentPageId, "local");
    if (this.state.canEdit) {
      this.scheduleSend();
      this.files.sync(elements);
    }
  };

  private sendChangedElements(pageId: string, elements: Elements) {
    const socket = this.socket;
    if (!socket?.connected || !this.hasJoined || !this.state.canEdit) {
      return;
    }
    const full: OrderedExcalidrawElement[] = [];
    const patches: ElementPatch[] = [];
    for (const element of elements) {
      const serverVersion = this.serverVersions.get(element.id) ?? -1;
      if (element.version <= serverVersion || !isSyncableElement(element)) {
        continue;
      }
      // a stroke being drawn: only its new points
      const snapshot = this.sentSnapshots.get(element.id);
      const patch =
        snapshot && snapshot.version === serverVersion
          ? createPatch(element, snapshot)
          : null;
      if (patch) {
        patches.push(patch);
      } else {
        full.push(element);
      }
      this.serverVersions.set(element.id, element.version);
      const nextSnapshot = snapshotElement(element);
      if (nextSnapshot) {
        this.sentSnapshots.set(element.id, nextSnapshot);
      } else {
        this.sentSnapshots.delete(element.id);
      }
    }
    if (!full.length && !patches.length) {
      return;
    }
    // the stroke we're still drawing, if it's in the message: the others
    // draw it on their overlay until it's finished (see liveStrokes.ts)
    const hasStroke =
      patches.length > 0 || full.some((element) => element.type === "freedraw");
    const drawing =
      pageId === this.state.currentPageId
        ? this.api?.getAppState().newElement
        : null;
    socket.emit("paper:elements", {
      pageId,
      elements: full as unknown as SyncedElement[],
      ...(patches.length ? { patches } : {}),
      ...(hasStroke
        ? {
            drawing:
              drawing?.type === "freedraw" && !drawing.isDeleted
                ? [drawing.id]
                : [],
          }
        : {}),
    });
  }

  /** sends soon: right away if nothing was sent this frame */
  private scheduleSend() {
    if (this.sendTimer !== null) {
      return;
    }
    const wait = Math.max(
      0,
      this.lastSendAt + SEND_INTERVAL_MS - performance.now(),
    );
    this.sendTimer = window.setTimeout(this.flushSend, wait);
  }

  private flushSend = () => {
    this.sendTimer = null;
    if (!this.socket?.connected) {
      // everything unsent goes out after reconnecting (onRejoin)
      return;
    }
    // on a slow connection, sending more would only queue up stale states:
    // wait, then send everything that changed meanwhile in one go
    if (this.isCongested()) {
      this.sendTimer = window.setTimeout(this.flushSend, SEND_INTERVAL_MS);
      return;
    }
    this.sendNow();
  };

  /** sends the current page's changes now (e.g. before switching pages) */
  private sendNow() {
    if (this.sendTimer !== null) {
      window.clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }
    this.lastSendAt = performance.now();
    const pageId = this.state.currentPageId;
    if (this.api && pageId) {
      this.sendChangedElements(
        pageId,
        this.api.getSceneElementsIncludingDeleted(),
      );
    }
  }

  private isCongested() {
    const engine = (this.socket?.io as any)?.engine;
    const webSocket = engine?.transport?.ws;
    if (webSocket && typeof webSocket.bufferedAmount === "number") {
      return webSocket.bufferedAmount > CONGESTION_BYTES;
    }
    return (engine?.writeBuffer?.length ?? 0) > 0;
  }

  /**
   * Remote changes: patches are turned into full elements (on top of the
   * newest copy we have, or fetched if we're missing what they build on).
   * A lone message is applied right away; several within one frame are
   * applied together.
   */
  private receiveRemote(
    pageId: string,
    elements: SyncedElement[],
    patches: ElementPatch[],
    drawing?: string[],
  ) {
    let pending = this.pendingRemote.get(pageId);
    if (!pending) {
      pending = new Map();
      this.pendingRemote.set(pageId, pending);
    }
    for (const element of elements) {
      this.fetching.delete(element.id);
      const queued = pending.get(element.id);
      if (!queued || isNewer(element, queued)) {
        pending.set(element.id, element);
      }
    }
    if (patches.length) {
      const local: ReadonlyMap<string, ExcalidrawElement> =
        pageId === this.state.currentPageId && this.api
          ? this.api.getSceneElementsMapIncludingDeleted()
          : new Map(
              this.getElements(pageId).map((element) => [element.id, element]),
            );
      const missing: string[] = [];
      for (const patch of patches) {
        const base =
          pending.get(patch.id) ??
          (this.liveStrokes.get(patch.id) as unknown as
            | SyncedElement
            | undefined) ??
          (local.get(patch.id) as unknown as SyncedElement | undefined);
        const next = applyPatch(base, patch);
        if (next) {
          pending.set(patch.id, next);
        } else if (
          performance.now() - (this.fetching.get(patch.id) ?? -Infinity) >
          FETCH_RETRY_MS
        ) {
          this.fetching.set(patch.id, performance.now());
          missing.push(patch.id);
        }
      }
      if (missing.length) {
        this.socket?.emit("paper:fetch", { pageId, ids: missing });
      }
    }
    // strokes still being drawn on this page: onto the overlay, not into the
    // page (that would redraw every element on it for each new point)
    if (
      this.liveStrokes.size &&
      pageId === this.state.currentPageId &&
      this.api
    ) {
      // finished strokes go into the page with the next frame; meanwhile
      // the overlay shows their last points right away
      for (const element of pending.values()) {
        if (
          element.type === "freedraw" &&
          this.liveStrokes.has(element.id) &&
          !drawing?.includes(element.id)
        ) {
          this.liveStrokes.set(element as unknown as ExcalidrawFreeDrawElement);
        }
      }
    }
    if (
      drawing?.length &&
      pageId === this.state.currentPageId &&
      this.api &&
      this.isLiveStrokesEnabled
    ) {
      for (const id of drawing) {
        const element = pending.get(id);
        if (element?.type === "freedraw" && !element.isDeleted) {
          pending.delete(id);
          if (element.version > (this.serverVersions.get(id) ?? -1)) {
            this.serverVersions.set(id, element.version);
          }
          this.liveStrokes.set(element as unknown as ExcalidrawFreeDrawElement);
        }
      }
      this.watchLiveStrokes();
    }
    if (!pending.size) {
      return;
    }
    if (this.isRemoteFrameBusy) {
      this.isRemoteFlushScheduled = true;
    } else {
      this.flushRemote();
    }
  }

  /** puts strokes that stopped growing into the page (see
   * LIVE_STROKE_TIMEOUT_MS) */
  private watchLiveStrokes() {
    if (this.liveStrokeTimer !== null) {
      return;
    }
    this.liveStrokeTimer = window.setInterval(() => {
      const pageId = this.state.currentPageId;
      const stale = this.liveStrokes.stale(LIVE_STROKE_TIMEOUT_MS);
      if (pageId && stale.length) {
        this.applyRemoteElements(pageId, stale as unknown as SyncedElement[]);
      }
      if (!this.liveStrokes.size && this.liveStrokeTimer !== null) {
        window.clearInterval(this.liveStrokeTimer);
        this.liveStrokeTimer = null;
      }
    }, LIVE_STROKE_TIMEOUT_MS / 2);
  }

  /** others' strokes being drawn go into the page now (we leave it) */
  private commitLiveStrokes() {
    const pageId = this.state.currentPageId;
    const strokes = this.liveStrokes.all();
    if (pageId && strokes.length) {
      this.applyRemoteElements(pageId, strokes as unknown as SyncedElement[]);
    }
    this.liveStrokes.clear();
  }

  /** applies remote changes waiting for the next frame */
  private applyPendingRemote() {
    const pending = this.pendingRemote;
    this.pendingRemote = new Map();
    for (const [pageId, elements] of pending) {
      if (elements.size) {
        this.applyRemoteElements(pageId, [...elements.values()]);
      }
    }
  }

  private flushRemote = () => {
    this.isRemoteFlushScheduled = false;
    this.applyPendingRemote();
    // anything else arriving before the next frame waits for it
    this.isRemoteFrameBusy = true;
    const onFrame = () => {
      this.isRemoteFrameBusy = false;
      if (this.isRemoteFlushScheduled && !this.destroyed) {
        this.flushRemote();
      }
    };
    if (document.hidden) {
      window.setTimeout(onFrame, 50);
    } else {
      window.requestAnimationFrame(onFrame);
    }
  };

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
  addPage(
    afterPageId = this.state.currentPageId,
    elements?: Elements,
    opts: { name?: string; switchTo?: boolean } = {},
  ) {
    const pages = this.state.pages;
    const index = pages.findIndex((page) => page.id === afterPageId);
    const before = index >= 0 ? pages[index] : pages[pages.length - 1];
    const after = index >= 0 ? pages[index + 1] : undefined;
    const page: PageMeta = {
      id: randomId(),
      name: (opts.name ?? "").slice(0, 120),
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
    if (opts.switchTo !== false) {
      this.switchPage(page.id);
    }
    return page;
  }

  /**
   * adds a page whose background is a locked image (PDF page, image,
   * template); the image is uploaded right away so others see it too
   */
  addBackgroundPage(
    background: BackgroundPage,
    opts: { afterPageId?: string | null; switchTo?: boolean } = {},
  ) {
    if (!this.api) {
      return null;
    }
    this.api.addFiles([background.file]);
    const elements = createBackgroundElements(background);
    const page = this.addPage(
      opts.afterPageId === undefined
        ? this.state.currentPageId
        : opts.afterPageId,
      elements,
      { name: background.name, switchTo: opts.switchTo },
    );
    this.files.sync(elements);
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
    const sourceMeta = this.pageMetas.get(pageId);
    this.addPage(pageId, restoreElements(duplicatedElements, null), {
      name: sourceMeta?.name ? `${sourceMeta.name} (copy)` : "",
    });
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
    // make sure the last strokes of the page we leave are sent, and what
    // others just did is in
    this.sendNow();
    this.applyPendingRemote();
    this.commitLiveStrokes();

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
        // not `api.setViewport()`: the editor treats that as taking over the
        // view and would stop following the presenter
        api.updateScene({
          appState: zoomToFitBounds({
            appState: api.getAppState(),
            bounds: getCommonBounds(visible),
            fit: "scale-down",
            // keep clear of the toolbars & sidebar
            canvasOffsets: api.getViewportOffsets(),
          }).appState,
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

  /** our cursor, for the others: always the newest position, at most every
   * POINTER_INTERVAL_MS (every frame while drawing) */
  onPointerUpdate = (payload: PointerPayload) => {
    this.pendingPointer = payload;
    if (this.pointerTimer !== null) {
      return;
    }
    const interval =
      payload.button === "down"
        ? POINTER_DRAWING_INTERVAL_MS
        : POINTER_INTERVAL_MS;
    const wait = this.lastPointerAt + interval - performance.now();
    if (wait <= 0) {
      this.sendPointer();
    } else {
      this.pointerTimer = window.setTimeout(this.sendPointer, wait);
    }
  };

  private sendPointer = () => {
    this.pointerTimer = null;
    const payload = this.pendingPointer;
    this.pendingPointer = null;
    const pageId = this.state.currentPageId;
    if (
      !payload ||
      !this.socket?.connected ||
      !pageId ||
      payload.pointersMap.size > 1
    ) {
      return;
    }
    this.lastPointerAt = performance.now();
    this.socket.volatile.emit("paper:pointer", {
      pageId,
      pointer: payload.pointer,
      button: payload.button,
      selectedElementIds: (this.api?.getAppState().selectedElementIds ??
        {}) as Record<string, true>,
    });
  };

  private onUserFollow(payload: OnUserFollowedPayload) {
    const prev = this.state.userToFollow;
    // following someone else, or stopping to follow the presenter, opts out
    // of presenter mode until the next presentation
    const presenter = this.state.presenter;
    if (presenter && presenter.socketId !== this.state.socketId) {
      const isPresenter = payload.userToFollow.socketId === presenter.socketId;
      if (
        (payload.action === "UNFOLLOW" && isPresenter) ||
        (payload.action === "FOLLOW" && !isPresenter)
      ) {
        this.presenterOptOut = true;
      }
    }
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

  private applyPresenter(presenter: Presenter | null) {
    const prev = this.state.presenter;
    if (prev?.socketId !== presenter?.socketId) {
      this.presenterOptOut = false;
    }
    this.setState({ presenter });
    const following = this.state.userToFollow;
    if (presenter && presenter.socketId !== this.state.socketId) {
      if (!this.presenterOptOut && following?.socketId !== presenter.socketId) {
        this.onUserFollow({
          userToFollow: {
            socketId: presenter.socketId as SocketId,
            username: presenter.name,
          },
          action: "FOLLOW",
        });
      }
    } else if (!presenter && prev && following?.socketId === prev.socketId) {
      this.onUserFollow({ userToFollow: following, action: "UNFOLLOW" });
      this.toast(`${prev.name} stopped presenting`);
    }
  }

  /** presenter mode: everyone follows your view and page */
  setPresenting(on: boolean) {
    if (this.state.canManage) {
      this.socket?.emit("paper:present", { on });
    }
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
