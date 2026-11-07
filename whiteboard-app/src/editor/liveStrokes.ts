/**
 * Other people's strokes while they are drawing them.
 *
 * Excalidraw redraws the whole page whenever an element changes. For the
 * person drawing that's fine — their stroke has a small canvas of its own —
 * but on everyone else's screen each new point of the stroke meant redrawing
 * every stroke on the page. With a page of notes on a tablet that is more
 * than a frame's worth of work, 60 times a second: the stroke arrived late
 * and in jumps, and the browser fell behind reading the connection.
 *
 * Strokes still being drawn (the sender lists them in `drawing`) are drawn
 * here instead, on a canvas of their own above the page, exactly as
 * Excalidraw draws them; each goes into the page once, when it's finished
 * (see `PaperSession.receiveRemote`).
 */

import { applyDarkModeFilter } from "@excalidraw/common";
import { ShapeCache } from "@excalidraw/element";

import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

type API = Pick<ExcalidrawImperativeAPI, "getAppState">;

const NO_EMBEDS = new Map();

export class LiveStrokes {
  private strokes = new Map<
    string,
    { element: ExcalidrawFreeDrawElement; updatedAt: number }
  >();
  private canvas: HTMLCanvasElement | null = null;
  private frame: number | null = null;

  constructor(private getAPI: () => API | null) {}

  /** puts the layer in the editor's container, before the editor: with the
   * z-index of Excalidraw's interactive layer it lies above the page and
   * below that layer (cursors, selections) and the UI, see
   * `.wb-live-strokes` */
  mount(container: HTMLElement) {
    this.unmount();
    const canvas = container.ownerDocument.createElement("canvas");
    canvas.className = "wb-live-strokes";
    canvas.setAttribute("aria-hidden", "true");
    container.prepend(canvas);
    this.canvas = canvas;
    window.addEventListener("resize", this.scheduleRender);
    this.scheduleRender();
  }

  unmount() {
    window.removeEventListener("resize", this.scheduleRender);
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.canvas?.remove();
    this.canvas = null;
  }

  get(id: string) {
    return this.strokes.get(id)?.element;
  }

  has(id: string) {
    return this.strokes.has(id);
  }

  get size() {
    return this.strokes.size;
  }

  /** a newer version of a stroke being drawn */
  set(element: ExcalidrawFreeDrawElement) {
    const current = this.strokes.get(element.id)?.element;
    if (current && current.version >= element.version) {
      return;
    }
    this.strokes.set(element.id, { element, updatedAt: performance.now() });
    this.scheduleRender();
  }

  /**
   * Strokes that are now in the page. They stay here until the page has been
   * redrawn with them (a frame or two), so they never blink out.
   */
  release(ids: Iterable<string>) {
    const versions: [string, number][] = [];
    for (const id of ids) {
      const stroke = this.strokes.get(id);
      if (stroke) {
        versions.push([id, stroke.element.version]);
      }
    }
    if (!versions.length) {
      return;
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const [id, version] of versions) {
          // unless it started growing again meanwhile
          if (this.strokes.get(id)?.element.version === version) {
            this.strokes.delete(id);
          }
        }
        this.scheduleRender();
      }),
    );
  }

  /** all strokes, e.g. to put them in the page before leaving it */
  all() {
    return [...this.strokes.values()].map(({ element }) => element);
  }

  /** strokes not updated for `ms` (their author left, or lost the
   * connection) */
  stale(ms: number) {
    const now = performance.now();
    return [...this.strokes.values()]
      .filter(({ updatedAt }) => now - updatedAt > ms)
      .map(({ element }) => element);
  }

  clear() {
    this.strokes.clear();
    this.scheduleRender();
  }

  /** at most once per frame */
  scheduleRender = () => {
    if (this.frame === null && this.canvas) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.render();
      });
    }
  };

  /** draws the strokes as Excalidraw's static canvas would */
  render() {
    const canvas = this.canvas;
    const api = this.getAPI();
    const context = canvas?.getContext("2d");
    if (!canvas || !api || !context) {
      return;
    }
    const appState = api.getAppState();
    const scale = window.devicePixelRatio || 1;
    const width = Math.round(appState.width * scale);
    const height = Math.round(appState.height * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${appState.width}px`;
      canvas.style.height = `${appState.height}px`;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!this.strokes.size) {
      return;
    }
    const zoom = appState.zoom.value;
    const isDark = appState.theme === "dark";
    const renderConfig = {
      isExporting: false,
      canvasBackgroundColor: appState.viewBackgroundColor,
      embedsValidationStatus: NO_EMBEDS,
      theme: appState.theme,
    };
    context.setTransform(scale * zoom, 0, 0, scale * zoom, 0, 0);
    for (const { element } of this.strokes.values()) {
      if (element.isDeleted) {
        continue;
      }
      context.save();
      context.globalAlpha = element.opacity / 100;
      context.translate(
        element.x + appState.scrollX,
        element.y + appState.scrollY,
      );
      // a stroke being drawn isn't rotated
      for (const shape of ShapeCache.generateElementShape(
        element,
        renderConfig,
      )) {
        if (typeof shape === "string") {
          context.fillStyle = applyDarkModeFilter(element.strokeColor, isDark);
          context.fill(new Path2D(shape));
        }
      }
      context.restore();
    }
  }
}
