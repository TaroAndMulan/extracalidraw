/**
 * Pen, fingers and palms on tablets (iPad + Apple Pencil, Android + S Pen).
 *
 * Excalidraw switches to "pen mode" the first time a pen touches the canvas
 * (there's a toggle for it in the toolbar), and then ignores single fingers
 * for most tools. A hand resting on the screen while writing still gets
 * through, though: it ends the stroke being drawn, pans or zooms the page,
 * selects things, creates a text on a double tap or opens the context menu
 * after a long press.
 *
 * `TabletInput` stands in front of the editor — window listeners in the
 * capture phase see every event before Excalidraw does — and decides who a
 * touch belongs to:
 *
 * - **palm**: a touch while the pen is on the screen (anywhere in the
 *   editor, buttons included), or one landing on the canvas right after the
 *   pen left it. Swallowed for as long as it lasts.
 * - **finger on the canvas in pen mode**: moves the view only — one finger
 *   pans, two pinch-zoom. Done here, so the editor never sees the touch.
 * - everything else goes to the editor untouched: the pen, fingers on the
 *   toolbar and panels, and all touches when pen mode is off (drawing with a
 *   finger on a tablet without a pen).
 *
 * See docs/whiteboard/decisions.md → "Pen, fingers and palms".
 */

import { KEYS, MAX_ZOOM, MIN_ZOOM } from "@excalidraw/common";

import type {
  AppState,
  ExcalidrawImperativeAPI,
  NormalizedZoomValue,
} from "@excalidraw/excalidraw/types";

/** a touch starting on the canvas this soon after the pen left it is a palm */
export const PALM_AFTER_PEN_MS = 500;
/** the pen counts as down only while its events keep coming, so a lost
 * pointerup can't block touch input for good */
const PEN_DOWN_STALE_MS = 3000;
/** finger travel after which the user is deliberately moving the view */
const NAVIGATION_SLOP_PX = 4;
/** a touch event belongs to a pointer that went down this close to it */
const TOUCH_MATCH_PX = 3;
/** pointers whose touchstart never came are forgotten after this */
const TOUCH_MATCH_MAX_AGE_MS = 1000;
/** a press held still this long opens the context menu */
export const LONG_PRESS_MS = 500;
/** travel that turns a press into a drag (no menu, no tap) */
const PRESS_SLOP_PX = 10;
/** fingers lifted this soon, without moving, are a tap (undo / redo) */
export const TAP_MAX_MS = 300;
/** a finger's long press opens the menu only when the pen has rested this
 * long — right after writing, a still touch is more likely the palm */
const FINGER_MENU_AFTER_PEN_MS = 1000;

export type HistoryAction = "undo" | "redo";

export type EditorAPI = Pick<
  ExcalidrawImperativeAPI,
  "getAppState" | "updateScene"
>;

export interface TabletInputOptions {
  /** the editor's container: touches outside it are left alone */
  root: HTMLElement;
  getAPI: () => EditorAPI | null;
  /** called once per gesture when fingers move the view */
  onNavigate?: () => void;
  /** a two-finger tap (undo) or three-finger tap (redo) in pen mode */
  onHistory?: (action: HistoryAction) => void;
  // injectable for tests
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

type Role = "palm" | "navigate";

interface Claim {
  role: Role;
  downX: number;
  downY: number;
  downAt: number;
  /** whether its touchstart was matched (see `matchTouch`) */
  touchMatched: boolean;
}

interface Point {
  x: number;
  y: number;
}

/** fingers on the canvas from the first one down to the last one up */
interface FingerGesture {
  startedAt: number;
  down: Map<number, Point>;
  maxFingers: number;
  /** no finger moved further than PRESS_SLOP_PX */
  still: boolean;
  menuOpened: boolean;
}

/** a press that opens the context menu if held still */
interface LongPress {
  pointerId: number;
  x: number;
  y: number;
  target: EventTarget;
  timer: number;
}

const isCanvas = (target: EventTarget | null) =>
  target instanceof HTMLCanvasElement &&
  target.classList.contains("excalidraw__canvas");

/** whether the selection tool is active (the context menu needs it on
 * touch screens, as in Excalidraw) */
const isSelecting = (api: EditorAPI) => {
  const { activeTool, preferredSelectionTool } = api.getAppState();
  return activeTool.type === preferredSelectionTool.type;
};

const movedFrom = (start: Point, event: PointerEvent) =>
  Math.hypot(event.clientX - start.x, event.clientY - start.y) > PRESS_SLOP_PX;

/** keeps an event from the editor (and everything else) */
const swallow = (event: Event) => {
  event.stopImmediatePropagation();
};

const clampZoom = (zoom: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/**
 * One-finger pan and two-finger pinch, anchored: the scene point that was
 * under the fingers when they landed stays under them, so the view never
 * drifts however long the gesture.
 */
class FingerNavigation {
  private fingers = new Map<number, { start: Point; current: Point }>();
  private anchor: {
    sceneX: number;
    sceneY: number;
    zoom: number;
    distance: number;
    offsetLeft: number;
    offsetTop: number;
  } | null = null;
  /** the view as last computed (applied on the next frame) */
  private viewport: { scrollX: number; scrollY: number; zoom: number } | null =
    null;
  private frame: number | null = null;
  private moved = false;

  constructor(
    private getAPI: () => EditorAPI | null,
    private onNavigate: () => void,
    private requestFrame: (callback: () => void) => number,
    private cancelFrame: (handle: number) => void,
  ) {}

  isActive = () => this.fingers.size > 0;

  down(pointerId: number, x: number, y: number) {
    this.fingers.set(pointerId, { start: { x, y }, current: { x, y } });
    this.rebase();
  }

  move(pointerId: number, x: number, y: number) {
    const finger = this.fingers.get(pointerId);
    if (!finger || !this.anchor) {
      return;
    }
    finger.current = { x, y };
    if (
      !this.moved &&
      Math.hypot(x - finger.start.x, y - finger.start.y) > NAVIGATION_SLOP_PX
    ) {
      this.moved = true;
      this.onNavigate();
    }
    const { anchor } = this;
    const points = this.points();
    const center = this.center(points);
    const zoom =
      points.length >= 2 && anchor.distance > 0
        ? clampZoom(
            (anchor.zoom * Math.hypot(...this.delta(points))) / anchor.distance,
          )
        : anchor.zoom;
    this.viewport = {
      zoom,
      scrollX: (center.x - anchor.offsetLeft) / zoom - anchor.sceneX,
      scrollY: (center.y - anchor.offsetTop) / zoom - anchor.sceneY,
    };
    if (this.frame === null) {
      this.frame = this.requestFrame(this.flush);
    }
  }

  up(pointerId: number) {
    if (this.fingers.delete(pointerId)) {
      this.rebase();
    }
  }

  /** ends the gesture (keeps the view where it got to) */
  cancel() {
    this.fingers.clear();
    this.rebase();
  }

  private points() {
    return [...this.fingers.values()].slice(0, 2).map((f) => f.current);
  }

  private center(points: Point[]): Point {
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    };
  }

  private delta([a, b]: Point[]): [number, number] {
    return [b.x - a.x, b.y - a.y];
  }

  /** a finger landed or lifted: anchor the gesture again from here */
  private rebase() {
    if (!this.fingers.size) {
      this.flush();
      this.anchor = null;
      this.viewport = null;
      this.moved = false;
      return;
    }
    const api = this.getAPI();
    if (!api) {
      this.anchor = null;
      return;
    }
    const appState = api.getAppState();
    const viewport = this.viewport ?? {
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom.value,
    };
    const points = this.points();
    const center = this.center(points);
    this.anchor = {
      sceneX:
        (center.x - appState.offsetLeft) / viewport.zoom - viewport.scrollX,
      sceneY:
        (center.y - appState.offsetTop) / viewport.zoom - viewport.scrollY,
      zoom: viewport.zoom,
      distance: points.length >= 2 ? Math.hypot(...this.delta(points)) : 0,
      offsetLeft: appState.offsetLeft,
      offsetTop: appState.offsetTop,
    };
  }

  private flush = () => {
    if (this.frame !== null) {
      this.cancelFrame(this.frame);
      this.frame = null;
    }
    const api = this.getAPI();
    const { viewport } = this;
    if (!api || !viewport) {
      return;
    }
    const current = api.getAppState();
    if (
      current.scrollX === viewport.scrollX &&
      current.scrollY === viewport.scrollY &&
      current.zoom.value === viewport.zoom
    ) {
      return;
    }
    api.updateScene({
      appState: {
        scrollX: viewport.scrollX,
        scrollY: viewport.scrollY,
        zoom: { value: viewport.zoom as NormalizedZoomValue },
      },
    });
  };
}

export class TabletInput {
  /** pens on the screen → time of their last event */
  private pens = new Map<number, number>();
  private lastPenContactAt = -Infinity;
  /** touch pointers kept away from the editor */
  private claims = new Map<number, Claim>();
  /** Touch.identifier of claimed touches (touch events don't carry the
   * pointerId, so touchstarts are matched to claims by position) */
  private claimedTouches = new Set<number>();
  private swallowingGesture = false;
  /** set while we dispatch our own event (see `dismissPopups`) */
  private dispatching = false;
  private navigation: FingerNavigation;
  private fingerGesture: FingerGesture | null = null;
  private longPress: LongPress | null = null;
  private now: () => number;
  private setTimer: (callback: () => void, ms: number) => number;
  private clearTimer: (handle: number) => void;

  constructor(private options: TabletInputOptions) {
    this.now = options.now ?? (() => performance.now());
    this.setTimer =
      options.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => window.clearTimeout(handle));
    this.navigation = new FingerNavigation(
      options.getAPI,
      () => options.onNavigate?.(),
      options.requestFrame ?? ((callback) => requestAnimationFrame(callback)),
      options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle)),
    );
  }

  /** starts listening; returns the function that stops it */
  install(target: Window = window) {
    const capture = { capture: true };
    const active = { capture: true, passive: false };
    const listeners: [string, (event: any) => void, AddEventListenerOptions][] =
      [
        ["pointerdown", this.onPointerDown, capture],
        ["pointermove", this.onPointerMove, capture],
        ["pointerup", this.onPointerUp, capture],
        ["pointercancel", this.onPointerUp, capture],
        ["touchstart", this.onTouch, active],
        ["touchmove", this.onTouch, active],
        ["touchend", this.onTouch, active],
        ["touchcancel", this.onTouch, active],
        // Safari's pinch events (Excalidraw zooms on them, too)
        ["gesturestart", this.onGesture, active],
        ["gesturechange", this.onGesture, active],
        ["gestureend", this.onGesture, active],
        ["contextmenu", this.onContextMenu, capture],
        ["blur", this.reset, {}],
      ];
    for (const [type, listener, options] of listeners) {
      target.addEventListener(type, listener, options);
    }
    return () => {
      for (const [type, listener, options] of listeners) {
        target.removeEventListener(type, listener, options);
      }
      this.reset();
    };
  }

  private isPenDown() {
    const now = this.now();
    for (const [pointerId, at] of this.pens) {
      if (now - at > PEN_DOWN_STALE_MS) {
        this.pens.delete(pointerId);
      }
    }
    return this.pens.size > 0;
  }

  private inEditor(target: EventTarget | null) {
    return target instanceof Node && this.options.root.contains(target);
  }

  private classify(event: PointerEvent, api: EditorAPI): Role | null {
    if (this.isPenDown()) {
      return "palm";
    }
    if (!isCanvas(event.target) || !api.getAppState().penMode) {
      return null;
    }
    return this.now() - this.lastPenContactAt < PALM_AFTER_PEN_MS
      ? "palm"
      : "navigate";
  }

  private onPointerDown = (event: PointerEvent) => {
    if (this.dispatching) {
      return;
    }
    if (event.pointerType === "pen") {
      this.onPenDown(event);
      return;
    }
    const api = this.options.getAPI();
    if (event.pointerType !== "touch" || !api || !this.inEditor(event.target)) {
      return;
    }
    const role = this.classify(event, api);
    if (!role) {
      return;
    }
    swallow(event);
    this.claims.set(event.pointerId, {
      role,
      downX: event.clientX,
      downY: event.clientY,
      downAt: this.now(),
      touchMatched: false,
    });
    if (role === "navigate") {
      this.onFingerDown(event, api);
    }
  };

  private onFingerDown(event: PointerEvent, api: EditorAPI) {
    const now = this.now();
    if (!this.navigation.isActive()) {
      this.dismissPopups(event, api);
      this.fingerGesture = {
        startedAt: now,
        down: new Map(),
        maxFingers: 0,
        still: true,
        menuOpened: false,
      };
    }
    this.navigation.down(event.pointerId, event.clientX, event.clientY);
    const gesture = this.fingerGesture;
    if (!gesture) {
      return;
    }
    gesture.down.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture.maxFingers = Math.max(gesture.maxFingers, gesture.down.size);
    if (
      gesture.down.size === 1 &&
      isSelecting(api) &&
      now - this.lastPenContactAt > FINGER_MENU_AFTER_PEN_MS
    ) {
      this.startLongPress(event);
    } else {
      this.cancelLongPress();
    }
  }

  private onFingerMove(event: PointerEvent) {
    this.navigation.move(event.pointerId, event.clientX, event.clientY);
    const gesture = this.fingerGesture;
    const start = gesture?.down.get(event.pointerId);
    if (gesture && start && movedFrom(start, event)) {
      gesture.still = false;
      this.cancelLongPress(event.pointerId);
    }
  }

  private onFingerUp(pointerId: number) {
    this.navigation.up(pointerId);
    this.cancelLongPress(pointerId);
    const gesture = this.fingerGesture;
    if (!gesture) {
      return;
    }
    gesture.down.delete(pointerId);
    if (gesture.down.size) {
      return;
    }
    this.fingerGesture = null;
    if (
      gesture.still &&
      !gesture.menuOpened &&
      this.now() - gesture.startedAt <= TAP_MAX_MS &&
      (gesture.maxFingers === 2 || gesture.maxFingers === 3)
    ) {
      this.options.onHistory?.(gesture.maxFingers === 2 ? "undo" : "redo");
    }
  }

  private onPenDown(event: PointerEvent) {
    const now = this.now();
    this.pens.set(event.pointerId, now);
    this.lastPenContactAt = now;
    // the fingers that were moving the view belong to the writing hand
    this.fingerGesture = null;
    this.cancelLongPress();
    if (this.navigation.isActive()) {
      this.navigation.cancel();
      for (const claim of this.claims.values()) {
        claim.role = "palm";
      }
    }
    // the Apple Pencil has no button for the context menu: a long press
    // opens it, as a finger's does in Excalidraw without pen mode
    const api = this.options.getAPI();
    if (api && isCanvas(event.target) && isSelecting(api)) {
      this.startLongPress(event);
    }
  }

  private startLongPress(event: PointerEvent) {
    this.cancelLongPress();
    const { pointerId, clientX: x, clientY: y, target } = event;
    if (!target) {
      return;
    }
    this.longPress = {
      pointerId,
      x,
      y,
      target,
      timer: this.setTimer(() => {
        this.longPress = null;
        this.openContextMenu(target, x, y);
        // the finger was asking for the menu, not moving the view
        const gesture = this.fingerGesture;
        if (gesture?.down.has(pointerId)) {
          gesture.menuOpened = true;
          this.navigation.cancel();
          const claim = this.claims.get(pointerId);
          if (claim) {
            claim.role = "palm";
          }
        }
      }, LONG_PRESS_MS),
    };
  }

  private cancelLongPress(pointerId?: number) {
    const { longPress } = this;
    if (
      longPress &&
      (pointerId === undefined || longPress.pointerId === pointerId)
    ) {
      this.clearTimer(longPress.timer);
      this.longPress = null;
    }
  }

  /** Excalidraw's context menu, as on a right click */
  private openContextMenu(target: EventTarget, x: number, y: number) {
    this.dispatching = true;
    try {
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 2,
        }),
      );
    } finally {
      this.dispatching = false;
    }
  }

  private onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "pen") {
      if (this.pens.has(event.pointerId)) {
        this.pens.set(event.pointerId, this.now());
        this.lastPenContactAt = this.now();
        if (
          this.longPress?.pointerId === event.pointerId &&
          movedFrom(this.longPress, event)
        ) {
          this.cancelLongPress();
        }
      } else {
        this.onPenHover();
      }
      return;
    }
    const claim = this.claims.get(event.pointerId);
    if (!claim) {
      return;
    }
    swallow(event);
    if (claim.role === "navigate") {
      this.onFingerMove(event);
    }
  };

  private onPointerUp = (event: PointerEvent) => {
    if (event.pointerType === "pen") {
      if (this.pens.delete(event.pointerId)) {
        this.lastPenContactAt = this.now();
      }
      this.cancelLongPress(event.pointerId);
      return;
    }
    const claim = this.claims.get(event.pointerId);
    if (!claim) {
      return;
    }
    swallow(event);
    this.claims.delete(event.pointerId);
    if (claim.role === "navigate") {
      this.onFingerUp(event.pointerId);
    } else {
      this.fingerGesture?.down.delete(event.pointerId);
    }
  };

  /** a pen near the screen: pen mode before it even touches (like
   * Excalidraw does on the first touch), so the palm can't draw */
  private onPenHover() {
    const api = this.options.getAPI();
    if (api && !api.getAppState().penDetected) {
      api.updateScene({
        appState: {
          penMode: true,
          penDetected: true,
          currentItemStrokeVariability: "variable",
        },
      });
    }
  }

  /** a touch event goes to the editor unless all its touches are claimed */
  private onTouch = (event: TouchEvent) => {
    const touches = Array.from(event.changedTouches ?? []);
    if (!touches.length) {
      return;
    }
    let claimed = 0;
    for (const touch of touches) {
      if (event.type === "touchstart") {
        if (this.matchTouch(touch)) {
          this.claimedTouches.add(touch.identifier);
          claimed++;
        }
      } else if (this.claimedTouches.has(touch.identifier)) {
        claimed++;
        if (event.type !== "touchmove") {
          this.claimedTouches.delete(touch.identifier);
        }
      }
    }
    if (claimed === touches.length) {
      // also stops the click (a palm on a button) and Safari's Scribble
      swallow(event);
      if (event.cancelable) {
        event.preventDefault();
      }
    }
  };

  /** the claim whose pointerdown matches this touchstart (pointer events
   * are dispatched before the touch events of the same contact) */
  private matchTouch(touch: Touch) {
    if ((touch as Touch & { touchType?: string }).touchType === "stylus") {
      return false;
    }
    const now = this.now();
    for (const claim of this.claims.values()) {
      if (
        !claim.touchMatched &&
        now - claim.downAt < TOUCH_MATCH_MAX_AGE_MS &&
        Math.abs(claim.downX - touch.clientX) <= TOUCH_MATCH_PX &&
        Math.abs(claim.downY - touch.clientY) <= TOUCH_MATCH_PX
      ) {
        claim.touchMatched = true;
        return true;
      }
    }
    return false;
  }

  private onGesture = (event: Event) => {
    if (event.type === "gesturestart") {
      this.swallowingGesture = this.claims.size > 0;
    }
    if (!this.swallowingGesture) {
      return;
    }
    swallow(event);
    event.preventDefault();
    if (event.type === "gestureend") {
      this.swallowingGesture = false;
    }
  };

  /** Android opens a context menu on a long press (a resting palm) */
  private onContextMenu = (event: MouseEvent) => {
    if (this.dispatching) {
      return;
    }
    const { pointerType } = event as PointerEvent;
    if (pointerType === "pen") {
      // Android's own long press of the pen opens the menu already
      this.cancelLongPress();
    }
    if (
      this.claims.size > 0 &&
      pointerType !== "pen" &&
      pointerType !== "mouse" &&
      this.inEditor(event.target)
    ) {
      swallow(event);
      event.preventDefault();
    }
  };

  /**
   * A finger on the canvas closes menus and popups, as it would if the
   * editor saw it: Excalidraw's own state, plus anything listening for
   * presses outside of it (main menu, pages panel menus), which gets a
   * pointerdown on the body.
   */
  private dismissPopups(event: PointerEvent, api: EditorAPI) {
    const { openMenu, openPopup, contextMenu } = api.getAppState();
    if (openMenu || openPopup || contextMenu) {
      api.updateScene({
        appState: { openMenu: null, openPopup: null, contextMenu: null },
      });
    }
    const { body } = this.options.root.ownerDocument;
    this.dispatching = true;
    try {
      body.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          isPrimary: event.isPrimary,
        }),
      );
    } finally {
      this.dispatching = false;
    }
  }

  private reset = () => {
    this.cancelLongPress();
    this.fingerGesture = null;
    this.pens.clear();
    this.claims.clear();
    this.claimedTouches.clear();
    this.swallowingGesture = false;
    this.navigation.cancel();
  };
}

export const installTabletInput = (options: TabletInputOptions) =>
  new TabletInput(options).install();

/** undo / redo through the editor's keyboard shortcut (Excalidraw has no
 * API for it) */
export const sendHistoryShortcut = (
  action: HistoryAction,
  target: Document = document,
) => {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: action === "redo" ? "Z" : "z",
      code: "KeyZ",
      shiftKey: action === "redo",
      [KEYS.CTRL_OR_CMD]: true,
      bubbles: true,
      cancelable: true,
    }),
  );
};

// -----------------------------------------------------------------------------
// pen mode, remembered per device
// -----------------------------------------------------------------------------

const PEN_MODE_KEY = "whiteboard-pen-mode";
let savedPenMode: boolean | null | undefined;

/** pen mode as last used on this device, `null` if no pen was seen yet */
export const loadPenMode = (): boolean | null => {
  try {
    const value = localStorage.getItem(PEN_MODE_KEY);
    return value === "on" ? true : value === "off" ? false : null;
  } catch {
    return null;
  }
};

/** call on editor changes: stores pen mode once a pen was seen */
export const rememberPenMode = (
  appState: Pick<AppState, "penMode" | "penDetected">,
) => {
  if (!appState.penDetected) {
    return;
  }
  if (savedPenMode === undefined) {
    savedPenMode = loadPenMode();
  }
  if (appState.penMode === savedPenMode) {
    return;
  }
  savedPenMode = appState.penMode;
  try {
    localStorage.setItem(PEN_MODE_KEY, appState.penMode ? "on" : "off");
  } catch {
    // private mode
  }
};

/** initial editor state: on a device with a pen, pen mode from the start
 * (otherwise a palm could draw until the pen first touches the screen) */
export const getInitialPenState = (): Partial<AppState> => {
  const penMode = loadPenMode();
  return penMode === null
    ? {}
    : { penMode, penDetected: true, currentItemStrokeVariability: "variable" };
};
