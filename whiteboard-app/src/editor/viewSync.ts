/**
 * Sharing the view (page, pan & zoom) between the people in a paper.
 *
 * - **Screens differ.** A view is sent as an area of the page (scene
 *   bounds); every screen fits that area in ("contain"), so everyone sees at
 *   least what the person who moved it sees.
 * - **No drift.** In "together" mode anyone moves the view. If each move
 *   sent the mover's whole screen, a tall tablet following a wide laptop
 *   (and back) would zoom out a little more on every hand-over. Instead the
 *   shared area keeps its place on each screen (`SharedArea`): panning or
 *   zooming moves the area with the page, and that is what's sent.
 * - **One order.** Two people moving at once would each end up where the
 *   other was. The server numbers every move (`seq`); while a move of ours
 *   is on its way, others' moves wait, and only moves newer than ours are
 *   shown (`SharedViewTracker`). Everyone ends where the server's last move
 *   is.
 * - **Smooth.** Others' moves glide over a few frames (`ViewAnimator`)
 *   instead of jumping ten times a second.
 */

import { MAX_ZOOM, MIN_ZOOM, easeOut } from "@excalidraw/common";

import type {
  AppState,
  ExcalidrawImperativeAPI,
  NormalizedZoomValue,
} from "@excalidraw/excalidraw/types";

import type {
  SceneBounds,
  SharedView,
} from "../../../whiteboard-server/src/protocol";

export interface View {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface Size {
  width: number;
  height: number;
}

/** a rectangle on the canvas, in CSS pixels: [left, top, right, bottom] */
export type ScreenRect = readonly [number, number, number, number];

export const viewOf = (
  appState: Pick<AppState, "scrollX" | "scrollY" | "zoom">,
): View => ({
  scrollX: appState.scrollX,
  scrollY: appState.scrollY,
  zoom: appState.zoom.value,
});

export const toAppState = (view: View) => ({
  scrollX: view.scrollX,
  scrollY: view.scrollY,
  zoom: { value: view.zoom as NormalizedZoomValue },
});

/** what a view shows of the page */
export const visibleBounds = (view: View, size: Size): SceneBounds => [
  -view.scrollX,
  -view.scrollY,
  -view.scrollX + size.width / view.zoom,
  -view.scrollY + size.height / view.zoom,
];

/** where an area of the page is on the screen */
export const toScreen = (bounds: SceneBounds, view: View): ScreenRect => [
  (bounds[0] + view.scrollX) * view.zoom,
  (bounds[1] + view.scrollY) * view.zoom,
  (bounds[2] + view.scrollX) * view.zoom,
  (bounds[3] + view.scrollY) * view.zoom,
];

/** the area of the page under a rectangle of the screen */
export const toScene = (rect: ScreenRect, view: View): SceneBounds => [
  rect[0] / view.zoom - view.scrollX,
  rect[1] / view.zoom - view.scrollY,
  rect[2] / view.zoom - view.scrollX,
  rect[3] / view.zoom - view.scrollY,
];

const clampZoom = (zoom: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** the view that shows all of `bounds`, centered ("contain") */
export const fitView = (bounds: SceneBounds, size: Size): View => {
  const width = Math.max(bounds[2] - bounds[0], 1e-6);
  const height = Math.max(bounds[3] - bounds[1], 1e-6);
  const zoom = clampZoom(Math.min(size.width / width, size.height / height));
  return {
    zoom,
    scrollX: size.width / 2 / zoom - (bounds[0] + bounds[2]) / 2,
    scrollY: size.height / 2 / zoom - (bounds[1] + bounds[3]) / 2,
  };
};

const close = (a: number, b: number) =>
  Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

export const sameView = (a: View, b: View) =>
  close(a.scrollX, b.scrollX) &&
  close(a.scrollY, b.scrollY) &&
  close(a.zoom, b.zoom);

/**
 * a view between two others (`factor` 0 → `from`, 1 → `to`): zoom changes
 * geometrically and the pan follows it, so a zoom around a point looks like
 * one (as Excalidraw's own animations do)
 */
export const interpolateView = (from: View, to: View, factor: number): View => {
  if (factor >= 1) {
    return { ...to };
  }
  const zoom = from.zoom * Math.pow(to.zoom / from.zoom, factor);
  const m = close(from.zoom, to.zoom)
    ? factor
    : (zoom - from.zoom) / (to.zoom - from.zoom);
  return {
    zoom,
    scrollX:
      ((1 - m) * from.scrollX * from.zoom + m * to.scrollX * to.zoom) / zoom,
    scrollY:
      ((1 - m) * from.scrollY * from.zoom + m * to.scrollY * to.zoom) / zoom,
  };
};

/**
 * The shared area of the page and where it is on this screen. Showing
 * someone else's area fits it in; moving the view ourselves keeps the area
 * where it is on the screen, so it moves (and zooms) with the page.
 */
export class SharedArea {
  /** where the shared area is on this screen; `null`: the whole screen */
  private rect: ScreenRect | null = null;

  /** shows an area: the view to go to */
  show(bounds: SceneBounds, size: Size): View {
    const view = fitView(bounds, size);
    this.rect = toScreen(bounds, view);
    return view;
  }

  /** the area under the shared rectangle in a view (after we moved it) */
  boundsIn(view: View, size: Size): SceneBounds {
    return this.rect ? toScene(this.rect, view) : visibleBounds(view, size);
  }

  /** the screen changed size: shows the same area again */
  resize(view: View, oldSize: Size, newSize: Size): View {
    return this.show(this.boundsIn(view, oldSize), newSize);
  }

  /** from now on, what we see is what we share */
  reset() {
    this.rect = null;
  }
}

/**
 * Orders the moves of the shared view. The server numbers each move (`seq`)
 * and sends them out in that order; it acknowledges ours in the same order.
 * So anything that arrives while a move of ours is on its way was numbered
 * before it — showing it would undo ours here only — and anything after our
 * move's acknowledgement is newer.
 */
export class SharedViewTracker {
  /** the newest move the server numbered (ours or someone else's) */
  latest: SharedView | null = null;
  /** our moves on their way, oldest first */
  private sending: Omit<SharedView, "seq">[] = [];
  /** the newest of others' moves that arrived meanwhile */
  private waiting: SharedView | null = null;

  /** (re)joined the paper: the server's current view */
  reset(latest: SharedView | null) {
    this.latest = latest;
    this.sending = [];
    this.waiting = null;
  }

  get isSending() {
    return this.sending.length > 0;
  }

  sent(view: Omit<SharedView, "seq">) {
    this.sending.push(view);
  }

  /** the server numbered our oldest move (`null`: refused it); returns
   * someone else's move to show now, if there is a newer one */
  acked(seq: number | null): SharedView | null {
    const view = this.sending.shift();
    if (view && seq !== null) {
      this.remember({ ...view, seq });
    }
    if (this.sending.length || !this.waiting) {
      return null;
    }
    const waiting = this.waiting;
    this.waiting = null;
    return this.remember(waiting) ? waiting : null;
  }

  /** someone else moved the view: returns it when it should be shown now */
  received(view: SharedView): SharedView | null {
    if (this.sending.length) {
      if (!this.waiting || view.seq > this.waiting.seq) {
        this.waiting = view;
      }
      return null;
    }
    return this.remember(view) ? view : null;
  }

  private remember(view: SharedView) {
    if (this.latest && view.seq <= this.latest.seq) {
      return false;
    }
    this.latest = view;
    return true;
  }
}

type API = Pick<ExcalidrawImperativeAPI, "getAppState" | "updateScene">;

/** how many views we set are remembered, to recognize them when the editor
 * reports them back (frames of an animation may be reported late) */
const EXPECTED_VIEWS = 8;

/**
 * Moves the editor's view for others' moves: jumps, or glides over a few
 * frames. Remembers the views it set, so that the editor reporting them
 * back (`onScrollChange`) isn't taken for the user moving the view.
 */
export class ViewAnimator {
  private frame: number | null = null;
  private expected: View[] = [];
  private cacheIgnoresZoom = false;

  constructor(private getAPI: () => API | null) {}

  /** whether the editor is at a view set here (not moved by the user) */
  isExpected(view: View) {
    return this.expected.some((expected) => sameView(expected, view));
  }

  /** a view the editor is about to report that isn't the user's doing */
  expect(view: View) {
    this.expected.push(view);
    if (this.expected.length > EXPECTED_VIEWS) {
      this.expected.shift();
    }
  }

  get isAnimating() {
    return this.frame !== null;
  }

  /** goes to a view: at once (`duration` 0) or gliding */
  go(target: View, duration: number) {
    const api = this.getAPI();
    if (!api) {
      return;
    }
    // continue from the last view set here unless the user moved since (the
    // editor applies views a little later, so its own may lag behind)
    const current = viewOf(api.getAppState());
    const start =
      this.isExpected(current) && this.expected.length
        ? this.expected[this.expected.length - 1]
        : current;
    this.stop();
    if (duration <= 0 || sameView(start, target)) {
      this.set(api, target);
      return;
    }
    const startedAt = performance.now();
    const zooms = !close(start.zoom, target.zoom);
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const done = progress >= 1;
      this.frame = done ? null : requestAnimationFrame(step);
      // while zooming, frames scale cached bitmaps of elements instead of
      // drawing each again (as Excalidraw's own animations do)
      this.set(
        api,
        interpolateView(start, target, easeOut(progress)),
        zooms && !done,
      );
    };
    this.frame = requestAnimationFrame(step);
  }

  /** stops gliding (e.g. the user took over) */
  stop() {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    if (this.cacheIgnoresZoom) {
      this.cacheIgnoresZoom = false;
      this.getAPI()?.updateScene({
        appState: { shouldCacheIgnoreZoom: false },
      });
    }
  }

  private set(api: API, view: View, cacheIgnoresZoom = false) {
    this.expect(view);
    this.cacheIgnoresZoom = cacheIgnoresZoom;
    api.updateScene({
      appState: {
        ...toAppState(view),
        shouldCacheIgnoreZoom: cacheIgnoresZoom,
      },
    });
  }
}
