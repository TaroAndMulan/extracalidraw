/**
 * "Where others are looking": for each person on this page, a frame around
 * what their screen shows, with their name, in the color of their cursor.
 * Someone looking elsewhere on the page gets a name tag at the edge of the
 * screen, pointing their way.
 *
 * Plain elements over the page (no React, no canvas drawing), moved with
 * the view in one animation frame. Nothing here can be tapped: it lies
 * where people write, under the editor's own layer (a pen landing on a name
 * would lose the stroke). Following someone is done from their avatar.
 */

import { getClientColor } from "@excalidraw/excalidraw/clients";

import type {
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";

import { toScreen, viewOf } from "./viewSync";

import type { SceneBounds } from "../../../whiteboard-server/src/protocol";

type API = Pick<ExcalidrawImperativeAPI, "getAppState" | "getViewportOffsets">;

export interface ViewBox {
  socketId: string;
  userId: string;
  name: string;
  /** what their screen shows of the page */
  bounds: SceneBounds;
}

/** a darker, solid version of the person's cursor color (which is pastel) */
const colorOf = (box: ViewBox) => {
  const pastel = getClientColor(
    box.socketId as SocketId,
    {
      id: box.userId,
    } as any,
  );
  const hue = /hsl\((\d+)/.exec(pastel)?.[1] ?? "210";
  return `hsl(${hue}, 70%, 45%)`;
};

const ARROWS = ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"];

/** the arrow pointing from the screen's center towards a point */
const arrowTowards = (dx: number, dy: number) =>
  ARROWS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 4 + 8) % 8];

const EDGE_MARGIN = 8;

export class ViewBoxes {
  private root: HTMLDivElement | null = null;
  private nodes = new Map<
    string,
    { frame: HTMLDivElement; tag: HTMLSpanElement }
  >();
  private boxes: ViewBox[] = [];
  private frame: number | null = null;

  constructor(private getAPI: () => API | null) {}

  /** above the page, below Excalidraw's interactive layer and UI (see
   * `.wb-viewboxes`) */
  mount(container: HTMLElement) {
    this.unmount();
    const root = container.ownerDocument.createElement("div");
    root.className = "wb-viewboxes";
    container.prepend(root);
    this.root = root;
    window.addEventListener("resize", this.scheduleRender);
    this.scheduleRender();
  }

  unmount() {
    window.removeEventListener("resize", this.scheduleRender);
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.root?.remove();
    this.root = null;
    this.nodes.clear();
  }

  set(boxes: ViewBox[]) {
    this.boxes = boxes;
    this.scheduleRender();
  }

  scheduleRender = () => {
    if (this.frame === null && this.root) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.render();
      });
    }
  };

  private node(box: ViewBox) {
    let node = this.nodes.get(box.socketId);
    if (!node) {
      const doc = this.root!.ownerDocument;
      const frame = doc.createElement("div");
      frame.className = "wb-viewbox";
      const tag = doc.createElement("span");
      tag.className = "wb-viewbox__tag";
      this.root!.append(frame, tag);
      node = { frame, tag };
      this.nodes.set(box.socketId, node);
    }
    return node;
  }

  private render() {
    const api = this.getAPI();
    const root = this.root;
    if (!root) {
      return;
    }
    const seen = new Set<string>();
    if (api) {
      const appState = api.getAppState();
      const view = viewOf(appState);
      const width = appState.width;
      const height = appState.height;
      // keep name tags at the edges clear of the toolbars (measured: read
      // before anything is moved, and only when there's something to show)
      const measured = this.boxes.length ? api.getViewportOffsets() : {};
      const offsets = {
        top: measured.top ?? 0,
        right: measured.right ?? 0,
        bottom: measured.bottom ?? 0,
        left: measured.left ?? 0,
      };
      for (const box of this.boxes) {
        seen.add(box.socketId);
        const { frame, tag } = this.node(box);
        const color = colorOf(box);
        const [left, top, right, bottom] = toScreen(box.bounds, view);
        const visible = right > 0 && bottom > 0 && left < width && top < height;
        // they see all we see (and more): nothing to point out
        const coversScreen =
          left <= 1 && top <= 1 && right >= width - 1 && bottom >= height - 1;

        frame.style.display = visible && !coversScreen ? "" : "none";
        frame.style.borderColor = color;
        frame.style.transform = `translate(${left}px, ${top}px)`;
        frame.style.width = `${right - left}px`;
        frame.style.height = `${bottom - top}px`;

        tag.style.display = coversScreen ? "none" : "";
        tag.style.background = color;
        let x: number;
        let y: number;
        let label = box.name;
        if (visible) {
          // inside their frame, at its top left (or where it's on screen)
          x = Math.max(left, EDGE_MARGIN);
          y = Math.max(top, offsets.top);
        } else {
          // at the edge of the screen, towards where they are
          const centerX = (left + right) / 2;
          const centerY = (top + bottom) / 2;
          const arrow = arrowTowards(centerX - width / 2, centerY - height / 2);
          label = `${arrow} ${box.name}`;
          x = Math.min(
            Math.max(centerX, offsets.left + EDGE_MARGIN),
            width - offsets.right - EDGE_MARGIN - 120,
          );
          y = Math.min(
            Math.max(centerY, offsets.top + EDGE_MARGIN),
            height - offsets.bottom - EDGE_MARGIN - 24,
          );
        }
        if (tag.textContent !== label) {
          tag.textContent = label;
        }
        tag.style.transform = `translate(${x}px, ${y}px)`;
      }
    }
    for (const [socketId, { frame, tag }] of this.nodes) {
      if (!seen.has(socketId)) {
        frame.remove();
        tag.remove();
        this.nodes.delete(socketId);
      }
    }
  }
}
