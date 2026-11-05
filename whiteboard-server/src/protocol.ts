/**
 * Types shared between the whiteboard server and the whiteboard app.
 *
 * The app imports this file too (types, and a few tiny constants), so it must
 * not import anything Node-specific.
 */

export type Role = "admin" | "member";

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  createdAt: number;
  disabled: boolean;
}

export interface PaperSummary {
  id: string;
  title: string;
  ownerId: string;
  memberIds: string[];
  createdAt: number;
  updatedAt: number;
  /** when locked, only the owner/admins can edit; everyone else views */
  locked: boolean;
  pageCount: number;
  /** cache-buster for the thumbnail, `null` when there is none */
  thumbnailVersion: number | null;
  /**
   * secret of the public link / embed (`/embed/<id>#token=<shareToken>`),
   * `null` when the paper isn't shared publicly. Only sent to managers.
   */
  shareToken: string | null;
  /** what people joining through the public link may do */
  shareAccess: "view" | "edit";
}

/**
 * A page of a paper. Pages are ordered by their fractional `index` and
 * reconciled the same way Excalidraw reconciles elements (higher `version`
 * wins, ties broken by the lower `versionNonce`).
 */
export interface PageMeta {
  id: string;
  name: string;
  index: string;
  version: number;
  versionNonce: number;
  updated: number;
  isDeleted: boolean;
}

/**
 * Elements are opaque to the server apart from the fields it needs to
 * reconcile them.
 */
export interface SyncedElement {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  updated?: number;
  [key: string]: unknown;
}

/**
 * A stroke being drawn, sent as the points added since `baseVersion` instead
 * of the whole element (which grows with every point). Applied only on top of
 * exactly `baseVersion`; otherwise the full element is requested.
 */
export interface ElementPatch {
  id: string;
  /** the element the patch builds on: version, nonce and number of points */
  baseVersion: number;
  baseVersionNonce: number;
  basePointCount: number;
  version: number;
  versionNonce: number;
  /** changed simple properties (size, timestamps) */
  set: Record<string, unknown>;
  appendPoints: [number, number][];
  appendPressures: number[];
}

/** keys an `ElementPatch` may change (besides points & pressures) */
export const PATCHABLE_KEYS = [
  "width",
  "height",
  "x",
  "y",
  "updated",
  "angle",
  "lastCommittedPoint",
  "simulatePressure",
] as const;

export interface PresenceUser {
  socketId: string;
  userId: string;
  username: string;
  role: Role | "guest";
  pageId: string | null;
  canEdit: boolean;
}

export type SceneBounds = readonly [
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
];

export interface JoinPaperResult {
  paper: PaperSummary;
  pages: PageMeta[];
  elements: Record<string, SyncedElement[]>;
  presence: PresenceUser[];
  socketId: string;
  /** whether the current user may lock the paper / summon everyone */
  canManage: boolean;
  canEdit: boolean;
  /** joined through a public link, without an account */
  isGuest: boolean;
  /** someone everyone follows (presenter mode) */
  presenter: Presenter | null;
}

export interface Presenter {
  socketId: string;
  name: string;
}

export interface GuestIdentity {
  /** random id kept in the guest's browser */
  id: string;
  name: string;
}

export type Ack<T> = (
  response: { ok: true; data: T } | { ok: false; error: string },
) => void;

// -----------------------------------------------------------------------------
// socket.io events
// -----------------------------------------------------------------------------

export interface PointerPayload {
  pageId: string;
  pointer: { x: number; y: number; tool: "pointer" | "laser" };
  button: "down" | "up";
  selectedElementIds: Record<string, true>;
}

export interface ClientToServerEvents {
  "paper:join": (
    data: {
      paperId: string;
      /** joins through the public link (embeds, guests) */
      shareToken?: string | null;
      guest?: GuestIdentity | null;
    },
    ack: Ack<JoinPaperResult>,
  ) => void;
  "paper:elements": (data: {
    pageId: string;
    elements: SyncedElement[];
    patches?: ElementPatch[];
  }) => void;
  /** asks for the current version of elements (after a patch didn't fit) */
  "paper:fetch": (data: { pageId: string; ids: string[] }) => void;
  /**
   * an image, pushed to everyone in the paper while it's stored. `preview`
   * is a small, quick version shown until the full one arrives.
   */
  "paper:file": (
    data: { fileId: string; mimeType: string; preview?: boolean },
    bytes: ArrayBuffer | Uint8Array,
    ack?: (response: { ok: boolean; error?: string }) => void,
  ) => void;
  "paper:pages": (data: { pages: PageMeta[] }) => void;
  "paper:presence": (data: { pageId: string }) => void;
  "paper:pointer": (data: PointerPayload) => void;
  "paper:idle": (data: { state: "active" | "idle" | "away" }) => void;
  "paper:follow": (data: {
    socketId: string;
    action: "FOLLOW" | "UNFOLLOW";
  }) => void;
  "paper:viewport": (data: { pageId: string; bounds: SceneBounds }) => void;
  "paper:summon": (data: {
    pageId: string;
    bounds: SceneBounds | null;
  }) => void;
  "paper:lock": (data: { locked: boolean }) => void;
  /** start/stop presenting: everyone follows the presenter's view & page */
  "paper:present": (data: { on: boolean }) => void;
}

export interface ServerToClientEvents {
  "paper:elements": (data: {
    pageId: string;
    elements: SyncedElement[];
    patches?: ElementPatch[];
  }) => void;
  /** patches that didn't fit the server's copy: send these in full */
  "paper:resend": (data: { pageId: string; ids: string[] }) => void;
  "paper:file": (
    data: { fileId: string; mimeType: string; preview?: boolean },
    bytes: ArrayBuffer | Uint8Array,
  ) => void;
  /** an image was uploaded (over HTTP): it can be downloaded now */
  "paper:fileStored": (data: { fileId: string }) => void;
  "paper:pages": (data: { pages: PageMeta[] }) => void;
  /** full authoritative state of a page — replaces the local copy */
  "paper:resync": (data: { pageId: string; elements: SyncedElement[] }) => void;
  "paper:presence": (data: { presence: PresenceUser[] }) => void;
  "paper:pointer": (data: PointerPayload & { socketId: string }) => void;
  "paper:idle": (data: {
    socketId: string;
    state: "active" | "idle" | "away";
  }) => void;
  "paper:followers": (data: { followers: string[] }) => void;
  "paper:viewport": (data: {
    socketId: string;
    pageId: string;
    bounds: SceneBounds;
  }) => void;
  "paper:summon": (data: {
    pageId: string;
    bounds: SceneBounds | null;
    by: string;
  }) => void;
  "paper:settings": (data: { locked: boolean; title: string }) => void;
  "paper:presenter": (data: { presenter: Presenter | null }) => void;
  /** the paper was deleted or the user lost access to it */
  "paper:removed": (data: { reason: string }) => void;
}
