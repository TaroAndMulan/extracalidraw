import {
  LONG_PRESS_MS,
  PALM_AFTER_PEN_MS,
  TAP_MAX_MS,
  TabletInput,
  getInitialPenState,
  loadPenMode,
  rememberPenMode,
  sendHistoryShortcut,
} from "./tabletInput";

import type { EditorAPI } from "./tabletInput";

// jsdom has neither PointerEvent nor Touch
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

interface PointerOptions {
  type?: "touch" | "pen" | "mouse";
  id?: number;
  x?: number;
  y?: number;
  buttons?: number;
}

const pointer = (
  eventType: string,
  target: EventTarget,
  { type = "touch", id = 1, x = 0, y = 0, buttons = 1 }: PointerOptions = {},
) => {
  const event = new FakePointerEvent(eventType, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    buttons,
    pointerId: id,
    pointerType: type,
  });
  target.dispatchEvent(event);
  return event;
};

const touch = (
  eventType: string,
  target: EventTarget,
  touches: { id: number; x: number; y: number; touchType?: string }[],
) => {
  const event = new TouchEvent(eventType, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "changedTouches", {
    value: touches.map((t) => ({
      identifier: t.id,
      clientX: t.x,
      clientY: t.y,
      touchType: t.touchType,
    })),
  });
  target.dispatchEvent(event);
  return event;
};

const setup = ({
  penMode = true,
  penDetected = true,
  tool = "freedraw",
} = {}) => {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  const canvas = document.createElement("canvas");
  canvas.className = "excalidraw__canvas interactive";
  const button = document.createElement("button");
  root.append(canvas, button);
  document.body.append(root);

  const appState: Record<string, any> = {
    penMode,
    penDetected,
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    offsetLeft: 0,
    offsetTop: 0,
    openMenu: null,
    openPopup: null,
    contextMenu: null,
    activeTool: { type: tool },
    preferredSelectionTool: { type: "selection" },
  };
  const updates: Record<string, any>[] = [];
  const api = {
    getAppState: () => appState,
    updateScene: ({ appState: next }: { appState?: Record<string, any> }) => {
      if (next) {
        updates.push(next);
        Object.assign(appState, next);
      }
    },
  } as unknown as EditorAPI;

  // what the editor (Excalidraw) gets to see
  const seen: string[] = [];
  const record = (event: Event) =>
    seen.push(`${event.type}:${(event as PointerEvent).pointerType ?? ""}`);
  for (const type of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "touchstart",
    "contextmenu",
  ]) {
    canvas.addEventListener(type, record);
    button.addEventListener(type, record);
  }

  let time = 10_000;
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 1;
  const onNavigate = vi.fn();
  const onHistory = vi.fn();
  const uninstall = new TabletInput({
    root,
    getAPI: () => api,
    onNavigate,
    onHistory,
    now: () => time,
    setTimer: (callback, ms) => {
      timers.set(nextTimer, { at: time + ms, callback });
      return nextTimer++;
    },
    clearTimer: (handle) => timers.delete(handle),
    requestFrame: (callback) => {
      frames.set(nextFrame, callback);
      return nextFrame++;
    },
    cancelFrame: (handle) => frames.delete(handle),
  }).install(window);

  return {
    canvas,
    button,
    appState,
    updates,
    seen,
    onNavigate,
    onHistory,
    uninstall,
    advance: (ms: number) => {
      time += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
    flushFrames: () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    },
    viewport: () => ({
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      zoom: appState.zoom.value,
    }),
  };
};

describe("TabletInput", () => {
  let t: ReturnType<typeof setup>;
  const OriginalPointerEvent = globalThis.PointerEvent;

  beforeAll(() => {
    (globalThis as any).PointerEvent = FakePointerEvent;
  });
  afterAll(() => {
    (globalThis as any).PointerEvent = OriginalPointerEvent;
  });
  afterEach(() => t?.uninstall());

  describe("pen mode: fingers move the view", () => {
    it("pans with one finger, and the editor never sees the finger", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { x: 100, y: 100 });
      pointer("pointermove", t.canvas, { x: 130, y: 110 });
      pointer("pointermove", t.canvas, { x: 150, y: 130 });
      t.flushFrames();
      pointer("pointerup", t.canvas, { x: 150, y: 130 });

      expect(t.viewport()).toEqual({ scrollX: 50, scrollY: 30, zoom: 1 });
      expect(t.seen).toEqual([]);
      expect(t.onNavigate).toHaveBeenCalledTimes(1);
    });

    it("moves once per frame, and the last move is never lost", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { x: 100, y: 100 });
      for (let x = 101; x <= 140; x++) {
        pointer("pointermove", t.canvas, { x, y: 100 });
      }
      t.flushFrames();
      expect(t.updates).toHaveLength(1);
      pointer("pointermove", t.canvas, { x: 160, y: 100 });
      // lifted before the next frame
      pointer("pointerup", t.canvas, { x: 160, y: 100 });
      expect(t.viewport().scrollX).toBe(60);
    });

    it("pinch-zooms around the fingers' center", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { id: 1, x: 100, y: 100 });
      pointer("pointerdown", t.canvas, { id: 2, x: 200, y: 100 });
      pointer("pointermove", t.canvas, { id: 2, x: 300, y: 100 });
      t.flushFrames();

      const { scrollX, scrollY, zoom } = t.viewport();
      expect(zoom).toBe(2);
      // the scene point that was between the fingers (150, 100) still is
      expect((200 - 0) / zoom - scrollX).toBe(150);
      expect((100 - 0) / zoom - scrollY).toBe(100);
      expect(t.seen).toEqual([]);
    });

    it("keeps panning with the finger left after a pinch", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { id: 1, x: 100, y: 100 });
      pointer("pointerdown", t.canvas, { id: 2, x: 200, y: 100 });
      pointer("pointermove", t.canvas, { id: 2, x: 300, y: 100 });
      t.flushFrames();
      pointer("pointerup", t.canvas, { id: 2, x: 300, y: 100 });
      const before = t.viewport();
      pointer("pointermove", t.canvas, { id: 1, x: 120, y: 100 });
      t.flushFrames();
      expect(t.viewport()).toEqual({
        ...before,
        scrollX: before.scrollX + 20 / before.zoom,
      });
    });

    it("doesn't stop following anyone on a tap", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { x: 100, y: 100 });
      pointer("pointermove", t.canvas, { x: 102, y: 101 });
      pointer("pointerup", t.canvas, { x: 102, y: 101 });
      expect(t.onNavigate).not.toHaveBeenCalled();
    });

    it("swallows the finger's touch events (no text on a double tap)", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { x: 100, y: 100 });
      const start = touch("touchstart", t.canvas, [{ id: 7, x: 100, y: 100 }]);
      const move = touch("touchmove", t.canvas, [{ id: 7, x: 120, y: 100 }]);
      const end = touch("touchend", t.canvas, [{ id: 7, x: 120, y: 100 }]);
      expect(t.seen).toEqual([]);
      expect(start.defaultPrevented).toBe(true);
      expect(move.defaultPrevented).toBe(true);
      expect(end.defaultPrevented).toBe(true);
    });

    it("closes menus and popups, as a tap on the canvas does", () => {
      t = setup();
      t.appState.openMenu = "canvas";
      const outside = vi.fn();
      document.addEventListener("pointerdown", outside);
      pointer("pointerdown", t.canvas, { x: 100, y: 100 });
      document.removeEventListener("pointerdown", outside);

      expect(t.appState.openMenu).toBe(null);
      // outside-click handlers (main menu, pages panel) get a pointerdown
      expect(outside).toHaveBeenCalledTimes(1);
      expect(outside.mock.calls[0][0].target).toBe(document.body);
      expect(t.seen).toEqual([]);
    });

    it("leaves fingers on the toolbar and panels to the editor", () => {
      t = setup();
      pointer("pointerdown", t.button, { x: 5, y: 5 });
      const start = touch("touchstart", t.button, [{ id: 3, x: 5, y: 5 }]);
      expect(t.seen).toEqual(["pointerdown:touch", "touchstart:"]);
      expect(start.defaultPrevented).toBe(false);
    });

    it("leaves the pen to the editor", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { type: "pen", x: 10, y: 10 });
      pointer("pointermove", t.canvas, { type: "pen", x: 20, y: 10 });
      pointer("pointerup", t.canvas, { type: "pen", x: 20, y: 10 });
      // Apple Pencil touches
      touch("touchstart", t.canvas, [
        { id: 1, x: 10, y: 10, touchType: "stylus" },
      ]);
      expect(t.seen).toEqual([
        "pointerdown:pen",
        "pointermove:pen",
        "pointerup:pen",
        "touchstart:",
      ]);
    });
  });

  describe("palm rejection", () => {
    it("ignores a palm while the pen draws, and the stroke goes on", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { type: "pen", id: 9, x: 300, y: 300 });
      pointer("pointerdown", t.canvas, { id: 1, x: 400, y: 500 });
      pointer("pointermove", t.canvas, { type: "pen", id: 9, x: 310, y: 300 });
      pointer("pointermove", t.canvas, { id: 1, x: 450, y: 520 });
      pointer("pointerup", t.canvas, { id: 1, x: 450, y: 520 });
      pointer("pointermove", t.canvas, { type: "pen", id: 9, x: 320, y: 300 });
      pointer("pointerup", t.canvas, { type: "pen", id: 9, x: 320, y: 300 });
      t.flushFrames();

      expect(t.seen).toEqual([
        "pointerdown:pen",
        "pointermove:pen",
        "pointermove:pen",
        "pointerup:pen",
      ]);
      expect(t.updates).toEqual([]);
    });

    it("ignores a palm on buttons while the pen is down (no click)", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { type: "pen", x: 300, y: 300 });
      pointer("pointerdown", t.button, { id: 2, x: 5, y: 5 });
      const start = touch("touchstart", t.button, [{ id: 4, x: 5, y: 5 }]);
      expect(t.seen).toEqual(["pointerdown:pen"]);
      // a canceled touchstart produces no click
      expect(start.defaultPrevented).toBe(true);
    });

    it("rejects palms even with pen mode off", () => {
      t = setup({ penMode: false });
      pointer("pointerdown", t.canvas, { type: "pen", x: 300, y: 300 });
      pointer("pointerdown", t.canvas, { id: 2, x: 400, y: 400 });
      expect(t.seen).toEqual(["pointerdown:pen"]);
    });

    it("treats a touch right after the pen lifted as a palm", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { type: "pen", x: 300, y: 300 });
      pointer("pointerup", t.canvas, { type: "pen", x: 300, y: 300 });
      t.advance(PALM_AFTER_PEN_MS - 100);
      pointer("pointerdown", t.canvas, { id: 1, x: 100, y: 100 });
      pointer("pointermove", t.canvas, { id: 1, x: 200, y: 100 });
      pointer("pointerup", t.canvas, { id: 1, x: 200, y: 100 });
      t.flushFrames();
      expect(t.updates).toEqual([]);

      t.advance(200);
      pointer("pointerdown", t.canvas, { id: 2, x: 100, y: 100 });
      pointer("pointermove", t.canvas, { id: 2, x: 200, y: 100 });
      t.flushFrames();
      expect(t.viewport().scrollX).toBe(100);
      expect(t.seen).toEqual(["pointerdown:pen", "pointerup:pen"]);
    });

    it("stops a pan when the pen lands: the hand was a palm", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { id: 1, x: 100, y: 100 });
      pointer("pointermove", t.canvas, { id: 1, x: 110, y: 100 });
      pointer("pointerdown", t.canvas, { type: "pen", id: 9, x: 300, y: 300 });
      const at = t.viewport();
      pointer("pointermove", t.canvas, { id: 1, x: 200, y: 100 });
      t.flushFrames();
      pointer("pointerup", t.canvas, { id: 1, x: 200, y: 100 });

      expect(t.viewport()).toEqual(at);
      expect(t.seen).toEqual(["pointerdown:pen"]);
    });

    it("doesn't block touch for good when a pen's pointerup got lost", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { type: "pen", x: 300, y: 300 });
      t.advance(5000);
      pointer("pointerdown", t.canvas, { id: 1, x: 100, y: 100 });
      pointer("pointermove", t.canvas, { id: 1, x: 150, y: 100 });
      t.flushFrames();
      expect(t.viewport().scrollX).toBe(50);
    });

    it("blocks the long-press context menu of a resting palm", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { type: "pen", x: 300, y: 300 });
      pointer("pointerdown", t.canvas, { id: 1, x: 100, y: 100 });
      const menu = pointer("contextmenu", t.canvas, { id: 1, x: 100, y: 100 });
      expect(menu.defaultPrevented).toBe(true);
      expect(t.seen).toEqual(["pointerdown:pen"]);
    });

    it("swallows Safari's pinch events while a palm is down", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { type: "pen", x: 300, y: 300 });
      pointer("pointerdown", t.canvas, { id: 1, x: 100, y: 100 });
      const editor = vi.fn();
      document.addEventListener("gesturechange", editor);
      const start = new Event("gesturestart", { cancelable: true });
      const change = new Event("gesturechange", { cancelable: true });
      document.dispatchEvent(start);
      document.dispatchEvent(change);
      document.removeEventListener("gesturechange", editor);
      expect(editor).not.toHaveBeenCalled();
      expect(change.defaultPrevented).toBe(true);
    });
  });

  describe("finger taps: undo and redo", () => {
    const tap = (fingers: number, { holdMs = 80, move = 0 } = {}) => {
      for (let id = 1; id <= fingers; id++) {
        pointer("pointerdown", t.canvas, { id, x: 100 * id, y: 300 });
      }
      for (let id = 1; id <= fingers; id++) {
        pointer("pointermove", t.canvas, { id, x: 100 * id + move, y: 300 });
      }
      t.advance(holdMs);
      for (let id = 1; id <= fingers; id++) {
        pointer("pointerup", t.canvas, { id, x: 100 * id + move, y: 300 });
      }
    };

    it("undoes on a two-finger tap and redoes on a three-finger tap", () => {
      t = setup();
      tap(2);
      tap(3);
      expect(t.onHistory.mock.calls).toEqual([["undo"], ["redo"]]);
      expect(t.seen).toEqual([]);
    });

    it("doesn't take a pinch, a long hold or one finger for a tap", () => {
      t = setup();
      tap(2, { move: 40 });
      tap(2, { holdMs: TAP_MAX_MS + 50 });
      tap(1);
      expect(t.onHistory).not.toHaveBeenCalled();
    });

    it("doesn't undo when the pen lands during the tap", () => {
      t = setup();
      pointer("pointerdown", t.canvas, { id: 1, x: 100, y: 300 });
      pointer("pointerdown", t.canvas, { id: 2, x: 200, y: 300 });
      pointer("pointerdown", t.canvas, { type: "pen", id: 9, x: 500, y: 300 });
      pointer("pointerup", t.canvas, { id: 1, x: 100, y: 300 });
      pointer("pointerup", t.canvas, { id: 2, x: 200, y: 300 });
      expect(t.onHistory).not.toHaveBeenCalled();
    });

    it("sends the editor's undo / redo shortcut", () => {
      const keys: KeyboardEvent[] = [];
      const listener = (event: KeyboardEvent) => keys.push(event);
      document.addEventListener("keydown", listener);
      sendHistoryShortcut("undo");
      sendHistoryShortcut("redo");
      document.removeEventListener("keydown", listener);
      expect(
        keys.map((k) => [k.key, k.shiftKey, k.ctrlKey || k.metaKey]),
      ).toEqual([
        ["z", false, true],
        ["Z", true, true],
      ]);
    });
  });

  describe("long press: the context menu", () => {
    it("opens with a finger held still (selection tool)", () => {
      t = setup({ tool: "selection" });
      pointer("pointerdown", t.canvas, { x: 300, y: 300 });
      pointer("pointermove", t.canvas, { x: 303, y: 302 });
      t.advance(LONG_PRESS_MS);
      expect(t.seen).toEqual(["contextmenu:"]);

      // lifting (or sliding) the finger afterwards doesn't move the page
      pointer("pointermove", t.canvas, { x: 400, y: 380 });
      pointer("pointerup", t.canvas, { x: 400, y: 380 });
      t.flushFrames();
      expect(t.viewport()).toEqual({ scrollX: 3, scrollY: 2, zoom: 1 });
    });

    it("opens with the pen held still (an Apple Pencil has no button)", () => {
      t = setup({ tool: "selection" });
      pointer("pointerdown", t.canvas, { type: "pen", x: 300, y: 300 });
      t.advance(LONG_PRESS_MS);
      expect(t.seen).toEqual(["pointerdown:pen", "contextmenu:"]);
    });

    it("doesn't open when the press moves, or ends early", () => {
      t = setup({ tool: "selection" });
      pointer("pointerdown", t.canvas, { type: "pen", x: 300, y: 300 });
      pointer("pointermove", t.canvas, { type: "pen", x: 330, y: 300 });
      t.advance(LONG_PRESS_MS);
      pointer("pointerup", t.canvas, { type: "pen", x: 330, y: 300 });
      t.advance(PALM_AFTER_PEN_MS + 1000);

      pointer("pointerdown", t.canvas, { id: 1, x: 300, y: 300 });
      t.advance(LONG_PRESS_MS - 100);
      pointer("pointerup", t.canvas, { id: 1, x: 300, y: 300 });
      t.advance(1000);
      expect(t.seen).not.toContain("contextmenu:");
    });

    it("doesn't open while drawing (only with the selection tool)", () => {
      t = setup({ tool: "freedraw" });
      pointer("pointerdown", t.canvas, { type: "pen", x: 300, y: 300 });
      t.advance(LONG_PRESS_MS);
      pointer("pointerup", t.canvas, { type: "pen", x: 300, y: 300 });
      t.advance(2000);
      pointer("pointerdown", t.canvas, { id: 1, x: 300, y: 300 });
      t.advance(LONG_PRESS_MS);
      expect(t.seen).not.toContain("contextmenu:");
    });

    it("doesn't open for a hand resting just after writing", () => {
      t = setup({ tool: "selection" });
      pointer("pointerdown", t.canvas, { type: "pen", x: 300, y: 300 });
      pointer("pointerup", t.canvas, { type: "pen", x: 300, y: 300 });
      t.advance(PALM_AFTER_PEN_MS + 100);
      pointer("pointerdown", t.canvas, { id: 1, x: 500, y: 600 });
      t.advance(LONG_PRESS_MS);
      expect(t.seen).not.toContain("contextmenu:");
    });
  });

  describe("pen mode off (drawing with a finger)", () => {
    it("leaves fingers on the canvas to the editor", () => {
      t = setup({ penMode: false });
      pointer("pointerdown", t.canvas, { x: 100, y: 100 });
      pointer("pointermove", t.canvas, { x: 150, y: 100 });
      const start = touch("touchstart", t.canvas, [{ id: 1, x: 100, y: 100 }]);
      expect(t.seen).toEqual([
        "pointerdown:touch",
        "pointermove:touch",
        "touchstart:",
      ]);
      expect(start.defaultPrevented).toBe(false);
      expect(t.updates).toEqual([]);
    });
  });

  it("turns pen mode on when a pen hovers over the screen", () => {
    t = setup({ penMode: false, penDetected: false });
    pointer("pointermove", t.canvas, { type: "pen", x: 10, y: 10, buttons: 0 });
    expect(t.appState).toMatchObject({
      penMode: true,
      penDetected: true,
      currentItemStrokeVariability: "variable",
    });
    // a pen turned off on purpose stays off
    t.appState.penMode = false;
    pointer("pointermove", t.canvas, { type: "pen", x: 20, y: 10, buttons: 0 });
    expect(t.appState.penMode).toBe(false);
  });
});

describe("pen mode per device", () => {
  beforeEach(() => localStorage.clear());

  it("is only remembered once a pen was seen", () => {
    rememberPenMode({ penMode: false, penDetected: false });
    expect(loadPenMode()).toBe(null);
    expect(getInitialPenState()).toEqual({});
  });

  it("starts the editor in the mode last used", () => {
    rememberPenMode({ penMode: true, penDetected: true });
    expect(getInitialPenState()).toEqual({
      penMode: true,
      penDetected: true,
      currentItemStrokeVariability: "variable",
    });
    rememberPenMode({ penMode: false, penDetected: true });
    expect(loadPenMode()).toBe(false);
    expect(getInitialPenState()).toMatchObject({ penMode: false });
  });
});
